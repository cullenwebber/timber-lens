import * as vscode from 'vscode';
import { getSettings, TimberLensSettings } from '../config/settings';
import { AcfIndex } from './acfResolver';
import { buildAcfIndex } from '../indexers/acfIndexer';
import { buildTwigIndex } from '../indexers/twigTemplateIndexer';
import { buildPhpContexts, PhpFileInput } from '../indexers/phpContextIndexer';
import { TemplateContext, TwigTemplate } from '../models/template';
import { TypeShape } from '../models/context';
import { ContextResolver } from './contextResolver';
import { findContextForTwig, resolveIncludePath } from './templateResolver';
import { baseName, toPosix } from '../utils/paths';

/**
 * Shared in-memory project store. Scans the workspace, builds the ACF / Twig /
 * PHP indexes, watches for changes, and serves resolved queries to providers.
 */
export class ProjectIndex {
  private acf: AcfIndex = new AcfIndex([]);
  private templates: TwigTemplate[] = [];
  private contexts: TemplateContext[] = [];
  private settings: TimberLensSettings = getSettings();
  /** Loop variable names used to iterate flexible_content (e.g. "block"). */
  private blockVars = new Set<string>(['block']);

  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  private rebuildTimer: NodeJS.Timeout | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly output = vscode.window.createOutputChannel('Timber Lens');

  async initialize(): Promise<void> {
    this.settings = getSettings();
    this.disposables.push(this.output);
    await this.rebuild();
    this.registerWatchers();
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('timberLens')) {
          this.scheduleRebuild();
        }
      })
    );
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.onDidChangeEmitter.dispose();
    if (this.rebuildTimer) {
      clearTimeout(this.rebuildTimer);
    }
  }

  // ---- public queries -----------------------------------------------------

  get acfIndex(): AcfIndex {
    return this.acf;
  }

  get twigTemplates(): TwigTemplate[] {
    return this.templates;
  }

  get config(): TimberLensSettings {
    return this.settings;
  }

  /** Current index sizes, for the reindex confirmation / logs. */
  get stats(): { acfFields: number; templates: number; contexts: number } {
    return {
      acfFields: this.acf.allNames.size,
      templates: this.templates.length,
      contexts: this.contexts.length,
    };
  }

  /** Find the template index entry for an absolute Twig file path. */
  templateFor(fsPath: string): TwigTemplate | undefined {
    return this.templates.find((t) => t.fsPath === fsPath);
  }

  /** Resolve an include path string to a template. */
  resolveInclude(relPath: string): TwigTemplate | undefined {
    return resolveIncludePath(relPath, this.templates);
  }

  /** Get the context for a Twig document: PHP render context, plus a synthetic
   * flexible_content row for dynamically-included block templates. */
  contextForTwig(fsPath: string): TemplateContext | undefined {
    const phpCtx = findContextForTwig(
      fsPath,
      this.templateFor(fsPath),
      this.contexts,
      this.settings.twigRoots
    );
    const blockVars = this.blockContextFor(fsPath);
    if (!blockVars) {
      return phpCtx;
    }
    // Merge: explicit PHP context wins over the inferred block row.
    const vars = new Map<string, TypeShape>(phpCtx?.vars ?? new Map());
    for (const [name, shape] of blockVars) {
      if (!vars.has(name)) {
        vars.set(name, shape);
      }
    }
    return {
      templatePath: phpCtx?.templatePath ?? '',
      sourceFile: phpCtx?.sourceFile ?? '(acf layout)',
      vars,
    };
  }

  /**
   * If `fsPath` is a block template (lives under a `blocks/` directory and its
   * basename matches a flexible_content layout name), expose that layout's row
   * shape under each known block loop variable (e.g. `block`).
   */
  private blockContextFor(fsPath: string): Map<string, TypeShape> | undefined {
    if (!toPosix(fsPath).includes('/blocks/')) {
      return undefined;
    }
    const layoutName = baseName(fsPath).replace(/\.twig$/, '');
    const row = this.acf.layoutRow(layoutName);
    if (!row) {
      return undefined;
    }
    const vars = new Map<string, TypeShape>();
    for (const varName of this.blockVars) {
      vars.set(varName, row);
    }
    return vars;
  }

  /** Build a resolver scoped to a specific Twig document. */
  resolverForTwig(fsPath: string): ContextResolver {
    const ctx = this.contextForTwig(fsPath);
    return new ContextResolver({
      contextVars: ctx?.vars ?? new Map(),
      acf: this.acf,
      enableGlobals: this.settings.enableBuiltinGlobals,
      assumePostVariables: this.settings.assumePostVariables,
    });
  }

  // ---- indexing -----------------------------------------------------------

  private scheduleRebuild(): void {
    if (this.rebuildTimer) {
      clearTimeout(this.rebuildTimer);
    }
    this.rebuildTimer = setTimeout(() => {
      void this.rebuild();
    }, 300);
  }

  async rebuild(): Promise<void> {
    this.settings = getSettings();
    let acfFiles = 0;
    try {
      const [acfCount] = await Promise.all([this.rebuildAcf(), this.rebuildTwig()]);
      acfFiles = acfCount;
      // PHP contexts depend on the ACF index, so run after ACF.
      await this.rebuildPhp();
    } catch (err) {
      this.output.appendLine(`[${stamp()}] index rebuild failed: ${err}`);
    }
    const s = this.stats;
    this.output.appendLine(
      `[${stamp()}] reindexed: ${acfFiles} ACF JSON files -> ${s.acfFields} fields, ` +
        `${s.templates} twig templates, ${s.contexts} render contexts ` +
        `(acfJsonPaths=${JSON.stringify(this.settings.acfJsonPaths)})`
    );
    this.onDidChangeEmitter.fire();
  }

  private async rebuildAcf(): Promise<number> {
    const contents: string[] = [];
    for (const dir of this.settings.acfJsonPaths) {
      const pattern = `**/${trimSlashes(dir)}/**/*.json`;
      const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**');
      for (const file of files) {
        contents.push(await readFile(file));
      }
    }
    this.acf = buildAcfIndex(contents);
    return contents.length;
  }

  private async rebuildTwig(): Promise<void> {
    const files = await vscode.workspace.findFiles('**/*.twig', '**/node_modules/**');
    this.templates = buildTwigIndex(
      files.map((f) => f.fsPath),
      this.settings.twigRoots
    );
    await this.detectBlockVars(files);
  }

  /**
   * Detect the loop variable name used to iterate flexible_content fields, e.g.
   * `block` in `{% for block in post.meta('page_builder') %}` whose body uses
   * `block.acf_fc_layout`. This is the variable name a dynamically-included
   * block template expects.
   */
  private async detectBlockVars(files: vscode.Uri[]): Promise<void> {
    const vars = new Set<string>(['block']);
    for (const file of files) {
      const content = await readFile(file);
      if (!content.includes('acf_fc_layout')) {
        continue;
      }
      for (const m of content.matchAll(/\{%-?\s*for\s+(\w+)\s+in\b/g)) {
        const name = m[1];
        if (content.includes(`${name}.acf_fc_layout`)) {
          vars.add(name);
        }
      }
    }
    this.blockVars = vars;
  }

  private async rebuildPhp(): Promise<void> {
    const seen = new Set<string>();
    const inputs: PhpFileInput[] = [];
    for (const glob of this.settings.phpScanGlobs) {
      const files = await vscode.workspace.findFiles(glob, '**/node_modules/**');
      for (const file of files) {
        if (seen.has(file.fsPath)) {
          continue;
        }
        seen.add(file.fsPath);
        const content = await readFile(file);
        // Cheap pre-filter: only parse files that mention Timber.
        if (content.includes('Timber')) {
          inputs.push({ fsPath: file.fsPath, content });
        }
      }
    }
    this.contexts = buildPhpContexts(inputs, this.acf);
  }

  private registerWatchers(): void {
    const onChange = () => this.scheduleRebuild();

    // Separate watchers per extension are more reliable across platforms than a
    // single brace glob, especially for externally-written ACF JSON.
    for (const pattern of ['**/*.php', '**/*.twig', '**/*.json']) {
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      watcher.onDidCreate(onChange);
      watcher.onDidChange(onChange);
      watcher.onDidDelete(onChange);
      this.disposables.push(watcher);
    }

    // Belt-and-braces: if a relevant file is saved in the editor (e.g. an ACF
    // JSON edited by hand), reindex even if the FS watcher missed the write.
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (/\.(php|twig|json)$/i.test(doc.fileName)) {
          this.scheduleRebuild();
        }
      })
    );
  }
}

function trimSlashes(s: string): string {
  return s.replace(/^\/+|\/+$/g, '');
}

function stamp(): string {
  return new Date().toLocaleTimeString();
}

async function readFile(uri: vscode.Uri): Promise<string> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString('utf8');
  } catch {
    return '';
  }
}
