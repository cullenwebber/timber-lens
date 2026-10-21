import * as vscode from 'vscode';
import { ProjectIndex } from '../services/projectIndex';
import { rangeFromOffsets } from '../utils/ranges';
import { findEnclosingLoops } from '../parsers/twigContextParser';
import {
  IncludeTag,
  entryRemovalRange,
  parseIncludes,
  passThroughInsert,
  templateVariables,
} from '../parsers/twigTemplateParser';
import { checkMemberAccess, closest } from '../services/twigChecks';
import { newTemplatePath } from '../services/templateResolver';
import { TypeShape } from '../models/context';

// Matches a whole include/extends/embed/import/from tag.
const TAG_RE = /\{%-?\s*(include|extends|embed|import|from)\s+([\s\S]*?)-?%\}/g;
// First static string literal inside a tag body.
const FIRST_STRING_RE = /(['"])([^'"]+)\1/;
// Static include('path') function form whose first arg is a complete string.
const FUNC_RE = /\binclude\(\s*(['"])([^'"]+)\1\s*(?:,|\))/g;
// post.meta('field') usage.
const META_RE = /\bpost\s*\.\s*meta\(\s*(['"])([^'"]+)\1\s*\)/g;

/** A quick fix for one diagnostic, served by TwigCodeActionProvider. */
export interface TwigFix {
  title: string;
  edit: vscode.WorkspaceEdit;
  command?: vscode.Command;
  preferred?: boolean;
}

export class TwigDiagnosticsProvider {
  private readonly collection: vscode.DiagnosticCollection;
  private readonly disposables: vscode.Disposable[] = [];
  /** Quick fixes per document, by diagnostic (see fixKey). */
  private readonly fixes = new Map<string, Map<string, TwigFix[]>>();

  constructor(private readonly index: ProjectIndex) {
    this.collection = vscode.languages.createDiagnosticCollection('timberLens');
  }

  register(context: vscode.ExtensionContext): void {
    this.disposables.push(
      this.collection,
      vscode.workspace.onDidOpenTextDocument((d) => this.refresh(d)),
      vscode.workspace.onDidChangeTextDocument((e) => this.refresh(e.document)),
      vscode.workspace.onDidSaveTextDocument((d) => this.refresh(d)),
      vscode.workspace.onDidCloseTextDocument((d) => {
        this.collection.delete(d.uri);
        this.fixes.delete(d.uri.toString());
      }),
      this.index.onDidChange(() => this.refreshAll())
    );
    context.subscriptions.push(...this.disposables);
    this.refreshAll();
  }

  private refreshAll(): void {
    for (const doc of vscode.workspace.textDocuments) {
      this.refresh(doc);
    }
  }

  /** The quick fixes computed for a diagnostic this provider reported. */
  fixesFor(uri: vscode.Uri, diag: vscode.Diagnostic): TwigFix[] {
    return this.fixes.get(uri.toString())?.get(fixKey(diag)) ?? [];
  }

  refresh(document: vscode.TextDocument): void {
    if (!isTwig(document)) {
      return;
    }
    const text = document.getText();
    const diagnostics: vscode.Diagnostic[] = [];
    this.fixes.set(document.uri.toString(), new Map());

    this.checkIncludes(document, text, diagnostics);
    this.checkMeta(document, text, diagnostics);
    this.checkMembers(document, text, diagnostics);
    this.checkIncludeVariables(document, text, diagnostics);

    this.collection.set(document.uri, diagnostics);
  }

  // ---- A. Missing static include paths ----------------------------------

  private checkIncludes(
    document: vscode.TextDocument,
    text: string,
    diagnostics: vscode.Diagnostic[]
  ): void {
    const flagged = new Set<number>();

    // Tag form: {% include 'partials/x.twig' %}
    TAG_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TAG_RE.exec(text)) !== null) {
      const body = m[2];
      // Dynamic concatenation -> never warn.
      if (body.includes('~')) {
        continue;
      }
      const strMatch = body.match(FIRST_STRING_RE);
      if (!strMatch) {
        continue;
      }
      const path = strMatch[2];
      const start = m.index + m[0].indexOf(strMatch[0]) + 1;
      this.warnIfMissing(document, path, start, flagged, diagnostics);
    }

    // Function form: include('partials/x.twig')
    FUNC_RE.lastIndex = 0;
    while ((m = FUNC_RE.exec(text)) !== null) {
      const path = m[2];
      const start = m.index + m[0].indexOf(path);
      this.warnIfMissing(document, path, start, flagged, diagnostics);
    }
  }

  private warnIfMissing(
    document: vscode.TextDocument,
    path: string,
    stringStart: number,
    flagged: Set<number>,
    diagnostics: vscode.Diagnostic[]
  ): void {
    if (flagged.has(stringStart) || !path.endsWith('.twig')) {
      return;
    }
    flagged.add(stringStart);
    if (this.index.resolveInclude(path)) {
      return;
    }
    const range = rangeFromOffsets(document, stringStart, stringStart + path.length);
    const near = closest(path, this.index.twigTemplates.flatMap((t) => t.relPaths));
    const diag = new vscode.Diagnostic(
      range,
      `Timber Lens: Twig template '${path}' was not found in the configured Twig roots.` +
        (near ? ` Did you mean '${near}'?` : ''),
      vscode.DiagnosticSeverity.Warning
    );
    diag.source = 'Timber Lens';
    diagnostics.push(diag);

    const fixes: TwigFix[] = [];
    if (near) {
      fixes.push(replaceFix(document, range, near));
    }
    const target = newTemplatePath(path, this.index.twigTemplates);
    if (target) {
      const uri = vscode.Uri.file(target);
      const edit = new vscode.WorkspaceEdit();
      edit.createFile(uri, { ignoreIfExists: true });
      fixes.push({
        title: `Create ${vscode.workspace.asRelativePath(uri)}`,
        edit,
        command: { title: 'Open', command: 'vscode.open', arguments: [uri] },
      });
    }
    this.addFixes(document, diag, fixes);
  }

  // ---- C. Fields ACF data does not have -------------------------------------

  private checkMembers(document: vscode.TextDocument, text: string, diagnostics: vscode.Diagnostic[]): void {
    const resolver = this.index.resolverForTwig(document.uri.fsPath, text);
    const loopCache = new Map<string, Map<string, TypeShape>>();
    const problems = checkMemberAccess(text, (chain, offset) => {
      const loops = findEnclosingLoops(text, offset);
      const key = loops.map((l) => l.bodyStart).join(',');
      let loopVars = loopCache.get(key);
      if (!loopVars) {
        loopVars = resolver.buildLoopVars(loops);
        loopCache.set(key, loopVars);
      }
      return resolver.resolveExpr(chain, loopVars);
    });
    for (const p of problems) {
      const diag = new vscode.Diagnostic(
        rangeFromOffsets(document, p.offset, p.offset + p.length),
        `Timber Lens: ${p.message}`,
        vscode.DiagnosticSeverity.Warning
      );
      diag.source = 'Timber Lens';
      diagnostics.push(diag);
      if (p.suggestion) {
        this.addFixes(document, diag, [replaceFix(document, diag.range, p.suggestion)]);
      }
    }
  }

  // ---- D. Variables passed to includes ---------------------------------------

  private checkIncludeVariables(document: vscode.TextDocument, text: string, diagnostics: vscode.Diagnostic[]): void {
    for (const tag of parseIncludes(text)) {
      const target = this.index.resolveInclude(tag.path);
      const targetText = target && this.index.templateText(target.fsPath);
      if (!target || !targetText) {
        continue;
      }
      const used = this.usedVariables(target.fsPath);
      for (const entry of tag.entries) {
        if (used.has(entry.key) || used.has('_context')) {
          continue;
        }
        const diag = new vscode.Diagnostic(
          rangeFromOffsets(document, entry.keyStart, entry.keyStart + entry.key.length),
          `Timber Lens: ${tag.path} does not use '${entry.key}'.`,
          vscode.DiagnosticSeverity.Hint
        );
        diag.tags = [vscode.DiagnosticTag.Unnecessary];
        diag.source = 'Timber Lens';
        diagnostics.push(diag);
        this.addFixes(document, diag, [removeEntryFix(document, text, tag, tag.entries.indexOf(entry))]);
      }
      // With `only`, anything not in the hash is undefined in the template.
      if (tag.only) {
        const passed = new Set(tag.entries.map((e) => e.key));
        const missing = templateVariables(targetText).filter((v) => !v.optional && !passed.has(v.name));
        if (missing.length > 0) {
          const diag = new vscode.Diagnostic(
            rangeFromOffsets(document, tag.pathStart, tag.pathEnd),
            `Timber Lens: ${tag.path} uses ${missing.map((v) => `'${v.name}'`).join(', ')}, which 'only' leaves undefined.`,
            vscode.DiagnosticSeverity.Warning
          );
          diag.source = 'Timber Lens';
          diagnostics.push(diag);
          this.addFixes(document, diag, [passThroughFix(document, text, tag, missing.map((v) => v.name))]);
        }
      }
    }
  }

  /** Variables a template reads, including those it hands on to includes without `only`. */
  private usedVariables(fsPath: string, depth = 0, seen = new Set<string>()): Set<string> {
    const text = this.index.templateText(fsPath);
    const used = new Set<string>();
    if (!text || seen.has(fsPath)) {
      return used;
    }
    seen.add(fsPath);
    templateVariables(text).forEach((v) => used.add(v.name));
    // _context reads variables by name at runtime, so anything may be used.
    if (/\b_context\b/.test(text)) {
      used.add('_context');
    }
    if (depth < 3) {
      for (const tag of parseIncludes(text)) {
        const target = !tag.only && this.index.resolveInclude(tag.path);
        if (target) {
          this.usedVariables(target.fsPath, depth + 1, seen).forEach((n) => used.add(n));
        }
      }
    }
    return used;
  }

  // ---- B. Unknown ACF field in post.meta('...') -------------------------

  private checkMeta(
    document: vscode.TextDocument,
    text: string,
    diagnostics: vscode.Diagnostic[]
  ): void {
    // If no ACF JSON is indexed at all, do not produce noisy warnings.
    if (this.index.acfIndex.allNames.size === 0) {
      return;
    }
    META_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = META_RE.exec(text)) !== null) {
      const field = m[2];
      if (this.index.acfIndex.hasField(field)) {
        continue;
      }
      const fieldStart = m.index + m[0].indexOf(field, m[0].indexOf('meta'));
      const range = rangeFromOffsets(document, fieldStart, fieldStart + field.length);
      const near = closest(field, [...this.index.acfIndex.allNames]);
      const diag = new vscode.Diagnostic(
        range,
        `Timber Lens: ACF field '${field}' was not found in any parsed ACF JSON.` +
          (near ? ` Did you mean '${near}'?` : ''),
        vscode.DiagnosticSeverity.Warning
      );
      diag.source = 'Timber Lens';
      diagnostics.push(diag);
      if (near) {
        this.addFixes(document, diag, [replaceFix(document, range, near)]);
      }
    }
  }

  private addFixes(document: vscode.TextDocument, diag: vscode.Diagnostic, fixes: TwigFix[]): void {
    if (fixes.length > 0) {
      this.fixes.get(document.uri.toString())?.set(fixKey(diag), fixes);
    }
  }
}

/** Code actions get copies of diagnostics, so fixes are found by range and message. */
function fixKey(diag: vscode.Diagnostic): string {
  const { start, end } = diag.range;
  return `${start.line}:${start.character}:${end.line}:${end.character}:${diag.message}`;
}

function replaceFix(document: vscode.TextDocument, range: vscode.Range, newText: string): TwigFix {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, range, newText);
  return { title: `Change to '${newText}'`, edit, preferred: true };
}

function removeEntryFix(document: vscode.TextDocument, text: string, tag: IncludeTag, i: number): TwigFix {
  const [start, end] = entryRemovalRange(text, tag, i);
  const edit = new vscode.WorkspaceEdit();
  edit.delete(document.uri, rangeFromOffsets(document, start, end));
  return { title: `Remove '${tag.entries[i].key}'`, edit, preferred: true };
}

function passThroughFix(document: vscode.TextDocument, text: string, tag: IncludeTag, names: string[]): TwigFix {
  const insert = passThroughInsert(text, tag, names);
  const edit = new vscode.WorkspaceEdit();
  edit.insert(document.uri, document.positionAt(insert.at), insert.text);
  return { title: `Pass ${names.map((n) => `'${n}'`).join(', ')} to ${tag.path}`, edit };
}

function isTwig(document: vscode.TextDocument): boolean {
  return document.languageId === 'twig' || document.fileName.endsWith('.twig');
}
