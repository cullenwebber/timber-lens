import * as vscode from 'vscode';
import { ProjectIndex } from '../services/projectIndex';
import { rangeFromOffsets } from '../utils/ranges';

// Matches a whole include/extends/embed/import/from tag.
const TAG_RE = /\{%-?\s*(include|extends|embed|import|from)\s+([\s\S]*?)-?%\}/g;
// First static string literal inside a tag body.
const FIRST_STRING_RE = /(['"])([^'"]+)\1/;
// Static include('path') function form whose first arg is a complete string.
const FUNC_RE = /\binclude\(\s*(['"])([^'"]+)\1\s*(?:,|\))/g;
// post.meta('field') usage.
const META_RE = /\bpost\s*\.\s*meta\(\s*(['"])([^'"]+)\1\s*\)/g;

export class TwigDiagnosticsProvider {
  private readonly collection: vscode.DiagnosticCollection;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly index: ProjectIndex) {
    this.collection = vscode.languages.createDiagnosticCollection('timberLens');
  }

  register(context: vscode.ExtensionContext): void {
    this.disposables.push(
      this.collection,
      vscode.workspace.onDidOpenTextDocument((d) => this.refresh(d)),
      vscode.workspace.onDidChangeTextDocument((e) => this.refresh(e.document)),
      vscode.workspace.onDidSaveTextDocument((d) => this.refresh(d)),
      vscode.workspace.onDidCloseTextDocument((d) => this.collection.delete(d.uri)),
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

  refresh(document: vscode.TextDocument): void {
    if (!isTwig(document)) {
      return;
    }
    const text = document.getText();
    const diagnostics: vscode.Diagnostic[] = [];

    this.checkIncludes(document, text, diagnostics);
    this.checkMeta(document, text, diagnostics);

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
    const diag = new vscode.Diagnostic(
      range,
      `Timber Lens: Twig template '${path}' was not found in the configured Twig roots.`,
      vscode.DiagnosticSeverity.Warning
    );
    diag.source = 'Timber Lens';
    diagnostics.push(diag);
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
      const diag = new vscode.Diagnostic(
        range,
        `Timber Lens: ACF field '${field}' was not found in any parsed ACF JSON.`,
        vscode.DiagnosticSeverity.Warning
      );
      diag.source = 'Timber Lens';
      diagnostics.push(diag);
    }
  }
}

function isTwig(document: vscode.TextDocument): boolean {
  return document.languageId === 'twig' || document.fileName.endsWith('.twig');
}
