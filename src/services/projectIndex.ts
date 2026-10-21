import * as vscode from 'vscode';
import { getSettings, TimberLensSettings } from '../config/settings';
import { AcfIndex, layoutRowShape } from './acfResolver';
import { StructureBlock, parseStructure, structToAcfFieldsWithSettings } from './fieldStructure';
import { buildAcfIndex } from '../indexers/acfIndexer';
import { buildTwigIndex } from '../indexers/twigTemplateIndexer';
import { buildPhpContexts, PhpFileInput, phpValueToShape } from '../indexers/phpContextIndexer';
import { TemplateContext, TwigTemplate } from '../models/template';
import { AcfField } from '../models/acf';
import { TypeShape } from '../models/context';
import { ContextResolver } from './contextResolver';
import { TwigCallable, parseGlobalContext, parseTwigExtensions } from '../parsers/phpTwigExtensions';
import { IncludeTag, parseIncludes } from '../parsers/twigTemplateParser';
import { findEnclosingLoops } from '../parsers/twigContextParser';
import { shapeOfExpr } from './twigChecks';
import { findContextForTwig, findContextsForTwig, resolveIncludePath } from './templateResolver';
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
  /** The block loop variable the project's templates actually use. */
  private mainBlockVar = 'block';
  /** Saved text of every Twig template, by path. */
  private texts = new Map<string, string>();
  /** Custom Twig functions and filters registered in theme PHP. */
  private callables: (TwigCallable & { fsPath: string })[] = [];
  /** Variables `timber/context` adds to every template. */
  private globals = new Map<string, { shape: TypeShape; fsPath: string; line: number }>();
  /** Include tags by the template they include; built on demand. */
  private includeIndex: Map<string, { callerPath: string; tag: IncludeTag }[]> | undefined;
  /** Variables passed to a template by its includers, per rebuild. */
  private includedVarsCache = new Map<string, Map<string, TypeShape>>();

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

  /** The loop variable block templates receive their row as, e.g. "block". */
  get blockVar(): string {
    return this.mainBlockVar;
  }

  /** Every PHP render context targeting a Twig document; the first is used. */
  renderContextsFor(fsPath: string): TemplateContext[] {
    return findContextsForTwig(
      fsPath,
      this.templateFor(fsPath),
      this.contexts,
      this.settings.twigRoots
    );
  }

  /** The flexible_content layout a block template renders, if it is one. */
  blockLayoutFor(fsPath: string): string | undefined {
    if (!toPosix(fsPath).includes('/blocks/')) {
      return undefined;
    }
    const layoutName = baseName(fsPath).replace(/\.twig$/, '');
    return this.acf.layoutNames.has(layoutName) ? layoutName : undefined;
  }

  /** The block template for a flexible_content layout, if one exists. */
  blockTemplateFor(layoutName: string): TwigTemplate | undefined {
    return this.templates.find((t) => this.blockLayoutFor(t.fsPath) === layoutName);
  }

  /** Resolve an include path string to a template. */
  resolveInclude(relPath: string): TwigTemplate | undefined {
    return resolveIncludePath(relPath, this.templates);
  }

  /** Custom Twig functions and filters registered in theme PHP. */
  get twigCallables(): (TwigCallable & { fsPath: string })[] {
    return this.callables;
  }

  /** Variables `timber/context` adds to every template. */
  get globalContext(): Map<string, { shape: TypeShape; fsPath: string; line: number }> {
    return this.globals;
  }

  /** A template's text: the open editor's, else the indexed copy. */
  templateText(fsPath: string): string | undefined {
    return vscode.workspace.textDocuments.find((d) => d.uri.fsPath === fsPath)?.getText() ?? this.texts.get(fsPath);
  }

  /** Every include / embed of the template at `fsPath`, with the including file. */
  includersOf(fsPath: string): { callerPath: string; tag: IncludeTag }[] {
    if (!this.includeIndex) {
      this.includeIndex = new Map();
      for (const [callerPath, text] of this.texts) {
        for (const tag of parseIncludes(text)) {
          const target = this.resolveInclude(tag.path);
          if (target) {
            const list = this.includeIndex.get(target.fsPath) ?? [];
            list.push({ callerPath, tag });
            this.includeIndex.set(target.fsPath, list);
          }
        }
      }
    }
    return this.includeIndex.get(fsPath) ?? [];
  }

  /**
   * Get the context for a Twig document, highest priority first: the PHP render
   * context, the flexible_content row of a block template, variables passed by
   * the templates that include it, and the global `timber/context` variables.
   * Pass the document's text so its acf-fields structure is used before it is
   * applied. `depth` limits how far up the include chain values are followed.
   */
  contextForTwig(fsPath: string, text?: string, depth = 0): TemplateContext | undefined {
    const phpCtx = findContextForTwig(
      fsPath,
      this.templateFor(fsPath),
      this.contexts,
      this.settings.twigRoots
    );
    const vars = new Map<string, TypeShape>(phpCtx?.vars ?? new Map());
    const addMissing = (more: Map<string, TypeShape> | undefined) =>
      more?.forEach((shape, name) => vars.has(name) || vars.set(name, shape));

    const blockVars = this.blockContextFor(fsPath, text);
    addMissing(blockVars);
    if (depth < 2) {
      addMissing(this.includedVars(fsPath, depth));
    }
    addMissing(new Map([...this.globals].map(([name, g]) => [name, g.shape])));

    if (vars.size === 0) {
      return phpCtx;
    }
    return {
      templatePath: phpCtx?.templatePath ?? '',
      sourceFile: phpCtx?.sourceFile ?? (blockVars ? '(acf layout)' : '(included)'),
      vars,
    };
  }

  /**
   * What the templates including `fsPath` give it: their `with` values first,
   * then (unless `only`) the loop variables and context visible at the include.
   */
  private includedVars(fsPath: string, depth: number): Map<string, TypeShape> {
    const cacheKey = `${depth}:${fsPath}`;
    const cached = this.includedVarsCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const passed = new Map<string, TypeShape>();
    const passers = new Map<string, string[]>();
    const inherited = new Map<string, TypeShape>();

    for (const { callerPath, tag } of this.includersOf(fsPath).slice(0, 25)) {
      if (callerPath === fsPath) {
        continue;
      }
      const callerText = this.texts.get(callerPath) ?? '';
      const callerCtx = this.contextForTwig(callerPath, undefined, depth + 1);
      const resolver = this.resolverFor(callerCtx);
      const loopVars = resolver.buildLoopVars(findEnclosingLoops(callerText, tag.pathStart));
      const rel = this.templateFor(callerPath)?.includePath ?? baseName(callerPath);

      for (const entry of tag.entries) {
        const shape = shapeOfExpr(entry.value, (chain) => resolver.resolveExpr(chain, loopVars));
        const current = passed.get(entry.key);
        if (!current || (current.kind === 'unknown' && shape.kind !== 'unknown')) {
          passed.set(entry.key, shape);
        }
        passers.set(entry.key, [...(passers.get(entry.key) ?? []), rel]);
      }
      if (!tag.only) {
        loopVars.forEach((shape, name) => inherited.has(name) || inherited.set(name, shape));
        callerCtx?.vars.forEach((shape, name) => inherited.has(name) || inherited.set(name, shape));
      }
    }

    const result = new Map<string, TypeShape>();
    passed.forEach((shape, name) => {
      const from = [...new Set(passers.get(name))];
      const more = from.length > 1 ? ` (+${from.length - 1} more)` : '';
      result.set(name, { ...shape, source: `passed by ${from[0]}${more}` });
    });
    inherited.forEach((shape, name) => result.has(name) || result.set(name, shape));
    this.includedVarsCache.set(cacheKey, result);
    return result;
  }

  /**
   * The row a block template receives, under each known block loop variable
   * (e.g. `block`). Taken from the document's acf-fields structure when it has
   * one, so unapplied fields resolve; otherwise from the flexible_content
   * layout the file is named after, when it lives under a `blocks/` directory.
   */
  private blockContextFor(fsPath: string, text?: string): Map<string, TypeShape> | undefined {
    const structure = text !== undefined ? parseStructure(text).block : undefined;
    const layoutName = this.blockLayoutFor(fsPath);
    const row = structure
      ? layoutRowShape(structure.layoutName, this.structureFields(structure))
      : layoutName
        ? this.acf.layoutRow(layoutName)
        : undefined;
    if (!row) {
      return undefined;
    }
    const vars = new Map<string, TypeShape>();
    for (const varName of this.blockVars) {
      vars.set(varName, row);
    }
    return vars;
  }

  /** A structure's fields with the settings ACF JSON already has for them. */
  structureFields(structure: StructureBlock): AcfField[] {
    const acfLayout = this.acf.flexibleLayouts.find(
      (e) => e.field.name === structure.owner && e.layout.name === structure.layoutName
    )?.layout;
    return structToAcfFieldsWithSettings(structure.fields, acfLayout?.subFields ?? []);
  }

  /** Build a resolver scoped to a specific Twig document. */
  resolverForTwig(fsPath: string, text?: string, depth = 0): ContextResolver {
    return this.resolverFor(this.contextForTwig(fsPath, text, depth));
  }

  private resolverFor(ctx: TemplateContext | undefined): ContextResolver {
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
    this.includeIndex = undefined;
    this.includedVarsCache.clear();
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
    const contents: { text: string; file: string }[] = [];
    for (const file of await this.acfJsonFiles()) {
      contents.push({ text: await readFile(file), file: file.fsPath });
    }
    this.acf = buildAcfIndex(contents);
    return contents.length;
  }

  /** Every ACF Local JSON file under the configured acfJsonPaths. */
  async acfJsonFiles(): Promise<vscode.Uri[]> {
    const files: vscode.Uri[] = [];
    for (const dir of this.settings.acfJsonPaths) {
      const pattern = `**/${trimSlashes(dir)}/**/*.json`;
      files.push(...(await vscode.workspace.findFiles(pattern, '**/node_modules/**')));
    }
    return files;
  }

  private async rebuildTwig(): Promise<void> {
    const files = await vscode.workspace.findFiles('**/*.twig', '**/node_modules/**');
    this.templates = buildTwigIndex(
      files.map((f) => f.fsPath),
      this.settings.twigRoots
    );
    const texts = new Map<string, string>();
    for (const file of files) {
      texts.set(file.fsPath, await readFile(file));
    }
    this.texts = texts;
    this.detectBlockVars();
  }

  /**
   * Detect the loop variable name used to iterate flexible_content fields, e.g.
   * `block` in `{% for block in post.meta('page_builder') %}` whose body uses
   * `block.acf_fc_layout`. This is the variable name a dynamically-included
   * block template expects.
   */
  private detectBlockVars(): void {
    const vars = new Set<string>(['block']);
    const detected: string[] = [];
    for (const content of this.texts.values()) {
      if (!content.includes('acf_fc_layout')) {
        continue;
      }
      for (const m of content.matchAll(/\{%-?\s*for\s+(\w+)\s+in\b/g)) {
        const name = m[1];
        if (content.includes(`${name}.acf_fc_layout`)) {
          vars.add(name);
          detected.push(name);
        }
      }
    }
    this.blockVars = vars;
    this.mainBlockVar = detected[0] ?? 'block';
  }

  private async rebuildPhp(): Promise<void> {
    const seen = new Set<string>();
    const inputs: PhpFileInput[] = [];
    const callables: (TwigCallable & { fsPath: string })[] = [];
    const globals = new Map<string, { shape: TypeShape; fsPath: string; line: number }>();
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
        // Twig and Timber register their own built-ins the same way.
        if (/[\\/]vendor[\\/]/.test(file.fsPath) || !/timber\/|Twig(?:Function|Filter)/.test(content)) {
          continue;
        }
        for (const c of parseTwigExtensions(content)) {
          callables.push({ ...c, fsPath: file.fsPath });
        }
        for (const [name, g] of parseGlobalContext(content)) {
          if (!globals.has(name)) {
            globals.set(name, { shape: { ...phpValueToShape(g.value, this.acf), source: baseName(file.fsPath) }, fsPath: file.fsPath, line: g.line });
          }
        }
      }
    }
    this.contexts = buildPhpContexts(inputs, this.acf);
    this.callables = callables;
    this.globals = globals;
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
