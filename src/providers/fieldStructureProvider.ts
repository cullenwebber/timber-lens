import * as vscode from 'vscode';
import { ProjectIndex } from '../services/projectIndex';
import {
  ApplyReport,
  StructureBlock,
  applyStructure,
  findLayout,
  formatStructure,
  matchesLayout,
  parseStructure,
  stringifyAcfJson,
} from '../services/fieldStructure';
import { AcfField, AcfLayout } from '../models/acf';
import { baseName, toPosix } from '../utils/paths';
import { unusedStructureFields } from '../services/twigChecks';
import { parseIncludes, twigCodeOnly } from '../parsers/twigTemplateParser';

/**
 * The editable `acf-fields` structure comment in block templates: CodeLenses
 * to insert it, apply edits to ACF JSON, or regenerate it from ACF JSON, plus
 * diagnostics for lines that cannot be applied.
 */
export class FieldStructureProvider implements vscode.CodeLensProvider {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changeEmitter.event;
  private readonly diagnostics =
    vscode.languages.createDiagnosticCollection('timberLens.fieldStructure');

  constructor(private readonly index: ProjectIndex) {}

  register(context: vscode.ExtensionContext, selector: vscode.DocumentSelector): void {
    context.subscriptions.push(
      vscode.languages.registerCodeLensProvider(selector, this),
      this.diagnostics,
      this.changeEmitter,
      vscode.workspace.onDidOpenTextDocument((d) => this.validate(d)),
      vscode.workspace.onDidChangeTextDocument((e) => this.validate(e.document)),
      vscode.workspace.onDidCloseTextDocument((d) => this.diagnostics.delete(d.uri)),
      this.index.onDidChange(() => {
        this.changeEmitter.fire();
        vscode.workspace.textDocuments.forEach((d) => this.validate(d));
      }),
      vscode.commands.registerCommand('timberLens.insertFieldStructure', (uri?: vscode.Uri) =>
        this.insert(uri)
      ),
      vscode.commands.registerCommand('timberLens.applyFieldStructure', (uri?: vscode.Uri) =>
        this.apply(uri)
      ),
      vscode.commands.registerCommand('timberLens.regenerateFieldStructure', (uri?: vscode.Uri) =>
        this.regenerate(uri)
      )
    );
    vscode.workspace.textDocuments.forEach((d) => this.validate(d));
  }

  // ---- CodeLens -----------------------------------------------------------

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const { block, errors } = parseStructure(document.getText());
    const args = [document.uri];

    if (!block) {
      const layout = errors.length === 0 ? this.layoutForFile(document.uri.fsPath) : undefined;
      return layout
        ? [lens(0, '$(symbol-structure) Insert ACF field structure', 'timberLens.insertFieldStructure', args)]
        : [];
    }

    const line = block.headerLine;
    if (errors.length > 0) {
      const n = errors.length;
      return [lens(line, `$(error) Fix ${n} problem${n === 1 ? '' : 's'} in the field structure to apply it`)];
    }
    const acf = this.acfLayout(block.owner, block.layoutName);
    if (!acf) {
      return this.ownerExists(block.owner)
        ? [lens(line, `$(add) Create layout "${block.layoutName}" in ACF JSON`, 'timberLens.applyFieldStructure', args)]
        : [lens(line, `$(warning) No flexible content field "${block.owner}" in ACF JSON`)];
    }
    if (matchesLayout(block, acf.layout.label, acf.layout.subFields)) {
      return [lens(line, '$(check) Matches ACF JSON')];
    }
    return [
      lens(line, '$(cloud-upload) Apply to ACF JSON', 'timberLens.applyFieldStructure', args),
      lens(line, '$(discard) Regenerate from ACF JSON', 'timberLens.regenerateFieldStructure', args),
    ];
  }

  // ---- diagnostics --------------------------------------------------------

  private validate(document: vscode.TextDocument): void {
    if (!isTwig(document)) {
      return;
    }
    const { block, errors } = parseStructure(document.getText());
    const diags = errors.map((e) => {
      const d = new vscode.Diagnostic(
        document.lineAt(Math.min(e.line, document.lineCount - 1)).range,
        `Timber Lens: ${e.message}`,
        vscode.DiagnosticSeverity.Error
      );
      d.source = 'Timber Lens';
      return d;
    });

    // A block template only receives rows of the layout it is named after.
    const fileLayout = baseName(document.fileName).replace(/\.twig$/, '');
    if (block && toPosix(document.fileName).includes('/blocks/') && fileLayout !== block.layoutName) {
      const d = new vscode.Diagnostic(
        document.lineAt(block.headerLine).range,
        `Timber Lens: this file receives "${fileLayout}" rows, but the structure describes ` +
          `the "${block.layoutName}" layout.`,
        vscode.DiagnosticSeverity.Warning
      );
      d.source = 'Timber Lens';
      diags.push(d);
    }
    const body = block ? document.getText().slice(block.end) : '';
    if (block && !this.forwardsBlock(body)) {
      for (const f of unusedStructureFields(block.fields, body, this.index.blockVar)) {
        const line = document.lineAt(f.line);
        const d = new vscode.Diagnostic(
          line.range.with(line.range.start.with({ character: line.firstNonWhitespaceCharacterIndex })),
          `Timber Lens: "${f.name}" is not used in this template.`,
          vscode.DiagnosticSeverity.Hint
        );
        d.tags = [vscode.DiagnosticTag.Unnecessary];
        d.source = 'Timber Lens';
        diags.push(d);
      }
    }
    this.diagnostics.set(document.uri, diags);
  }

  /** The row is handed on whole, or to an include that reads it, so its use is not visible here. */
  private forwardsBlock(body: string): boolean {
    const blockVar = this.index.blockVar;
    if (new RegExp(`\\b${blockVar}\\b(?!\\s*[.\\[])`).test(twigCodeOnly(body.replace(/\{%-?\s*(?:for\s+\w+\s+in[^%]*|(?:end)?block\b[^%]*)%\}/g, '')))) {
      return true;
    }
    return parseIncludes(body).some((tag) => {
      const target = !tag.only && this.index.resolveInclude(tag.path);
      return target && (this.index.templateText(target.fsPath) ?? '').includes(`${blockVar}.`);
    });
  }

  // ---- commands -----------------------------------------------------------

  private async insert(uri?: vscode.Uri): Promise<void> {
    const document = await documentFor(uri);
    if (!document) {
      return;
    }
    if (parseStructure(document.getText()).block) {
      return this.regenerate(document.uri);
    }
    const found = this.layoutForFile(document.uri.fsPath);
    if (!found) {
      vscode.window.showErrorMessage(
        'Timber Lens: this is not a block template named after a flexible content layout.'
      );
      return;
    }
    const text = formatStructure(found.field.name, found.layout.name, found.layout.label, found.layout.subFields);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(document.uri, new vscode.Position(0, 0), `${text}\n`);
    await vscode.workspace.applyEdit(edit);
  }

  private async regenerate(uri?: vscode.Uri): Promise<void> {
    const document = await documentFor(uri);
    const block = document && this.parsedBlock(document);
    if (!document || !block) {
      return;
    }
    const acf = this.acfLayout(block.owner, block.layoutName);
    if (!acf) {
      vscode.window.showErrorMessage(
        `Timber Lens: layout "${block.layoutName}" of "${block.owner}" is not in your ACF JSON.`
      );
      return;
    }
    const text = formatStructure(block.owner, block.layoutName, acf.layout.label, acf.layout.subFields);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      document.uri,
      new vscode.Range(document.positionAt(block.start), document.positionAt(block.end)),
      text
    );
    await vscode.workspace.applyEdit(edit);
  }

  private async apply(uri?: vscode.Uri): Promise<void> {
    const document = await documentFor(uri);
    const block = document && this.parsedBlock(document);
    if (!document || !block) {
      return;
    }

    // Read the JSON fresh from disk so nothing newer is overwritten.
    const hits: { uri: vscode.Uri; text: string; data: unknown; loc: ReturnType<typeof findLayout>[number] }[] = [];
    for (const file of await this.index.acfJsonFiles()) {
      const text = Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8');
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        continue;
      }
      for (const loc of findLayout(data, block.owner, block.layoutName)) {
        hits.push({ uri: file, text, data, loc });
      }
    }
    const withLayout = hits.filter((h) => h.loc.layout);
    const candidates = withLayout.length > 0 ? withLayout : hits;
    if (candidates.length === 0) {
      vscode.window.showErrorMessage(
        `Timber Lens: no flexible content field "${block.owner}" was found in your ACF JSON.`
      );
      return;
    }
    if (candidates.length > 1) {
      const where = [...new Set(candidates.map((c) => vscode.workspace.asRelativePath(c.uri)))].join(', ');
      vscode.window.showErrorMessage(
        `Timber Lens: "${block.owner}" / "${block.layoutName}" is defined more than once (${where}). ` +
          'Edit the ACF JSON directly.'
      );
      return;
    }

    const hit = candidates[0];
    const rel = vscode.workspace.asRelativePath(hit.uri);
    if (vscode.workspace.textDocuments.some((d) => d.uri.fsPath === hit.uri.fsPath && d.isDirty)) {
      vscode.window.showErrorMessage(`Timber Lens: ${rel} has unsaved changes. Save it first.`);
      return;
    }

    const creating = !hit.loc.layout;
    const report = applyStructure(hit.loc, block);
    if (report.removed.length > 0 || report.retyped.length > 0) {
      const choice = await vscode.window.showWarningMessage(
        `Apply the field structure to ${rel}?`,
        { modal: true, detail: confirmDetail(report) },
        'Apply'
      );
      if (choice !== 'Apply') {
        return;
      }
    }

    await vscode.workspace.fs.writeFile(hit.uri, Buffer.from(stringifyAcfJson(hit.data, hit.text), 'utf8'));
    await this.index.rebuild();

    const summary = creating
      ? `created layout "${block.layoutName}"`
      : summarize(report) || 'updated labels';
    void vscode.window
      .showInformationMessage(
        `Timber Lens: ${rel}: ${summary}. In WordPress, sync the field group under ACF → Field Groups.`,
        'Open JSON'
      )
      .then((open) => open && vscode.window.showTextDocument(hit.uri));
  }

  // ---- helpers ------------------------------------------------------------

  /** The parsed structure, or undefined after telling the user why not. */
  private parsedBlock(document: vscode.TextDocument): StructureBlock | undefined {
    const { block, errors } = parseStructure(document.getText());
    if (!block) {
      vscode.window.showErrorMessage(
        errors[0] ? `Timber Lens: ${errors[0].message}` : 'Timber Lens: this file has no acf-fields structure.'
      );
      return undefined;
    }
    if (errors.length > 0) {
      vscode.window.showErrorMessage(
        `Timber Lens: fix the problems in the field structure first (line ${errors[0].line + 1}: ${errors[0].message})`
      );
      return undefined;
    }
    return block;
  }

  private acfLayout(owner: string, layoutName: string): { field: AcfField; layout: AcfLayout } | undefined {
    return this.index.acfIndex.flexibleLayouts.find(
      (e) => e.field.name === owner && e.layout.name === layoutName
    );
  }

  private ownerExists(owner: string): boolean {
    return this.index.acfIndex.getField(owner)?.type === 'flexible_content';
  }

  /** The layout a block template is named after, with its owning field. */
  private layoutForFile(fsPath: string): { field: AcfField; layout: AcfLayout } | undefined {
    const name = this.index.blockLayoutFor(fsPath);
    return name ? this.index.acfIndex.flexibleLayouts.find((e) => e.layout.name === name) : undefined;
  }
}

function lens(line: number, title: string, command = '', args: unknown[] = []): vscode.CodeLens {
  return new vscode.CodeLens(new vscode.Range(line, 0, line, 0), { title, command, arguments: args });
}

function summarize(report: ApplyReport): string {
  return [
    report.added.length ? `added ${report.added.join(', ')}` : '',
    report.removed.length ? `removed ${report.removed.join(', ')}` : '',
    report.retyped.length ? `changed ${report.retyped.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('; ');
}

function confirmDetail(report: ApplyReport): string {
  const lines: string[] = [];
  if (report.removed.length > 0) {
    lines.push(`Removes: ${report.removed.join(', ')}`);
  }
  if (report.retyped.length > 0) {
    lines.push(`Changes type: ${report.retyped.join(', ')}`);
  }
  if (report.added.length > 0) {
    lines.push(`Adds: ${report.added.join(', ')}`);
  }
  lines.push(
    '',
    'Fields are matched by name, so a renamed field is removed and re-added. ' +
      'Content already saved in removed fields stays in the database but is no longer shown.'
  );
  return lines.join('\n');
}

async function documentFor(uri?: vscode.Uri): Promise<vscode.TextDocument | undefined> {
  return uri ? vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
}

function isTwig(document: vscode.TextDocument): boolean {
  return document.languageId === 'twig' || document.fileName.endsWith('.twig');
}
