import * as vscode from 'vscode';
import { ProjectIndex } from '../services/projectIndex';
import { Move, pathLiterals, referenceEdits } from '../services/templateMoves';
import { renderPathVariants, toPosix } from '../utils/paths';

/**
 * When Twig templates or folders holding them are moved or renamed in VS
 * Code, rewrite the include / extends / embed paths in Twig and the template
 * paths in PHP render calls that point at them. The edits are part of the
 * move, so one undo reverts both.
 */
export class TemplateMoveParticipant {
  constructor(private readonly index: ProjectIndex) {}

  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.workspace.onWillRenameFiles((e) => {
        if (!this.index.config.updateReferencesOnMove) {
          return;
        }
        const moves = this.templateMoves(e.files);
        if (moves.length > 0) {
          e.waitUntil(this.editFor(moves));
        }
      })
    );
  }

  /** The renames that move indexed templates, as absolute posix paths. */
  private templateMoves(files: readonly { oldUri: vscode.Uri; newUri: vscode.Uri }[]): Move[] {
    const templates = this.index.twigTemplates.map((t) => toPosix(t.fsPath));
    return files
      .map((f) => ({ from: toPosix(f.oldUri.fsPath), to: toPosix(f.newUri.fsPath) }))
      .filter(
        (m) =>
          (m.from.endsWith('.twig') && m.to.endsWith('.twig') && templates.includes(m.from)) ||
          templates.some((t) => t.startsWith(m.from + '/'))
      );
  }

  private async editFor(moves: Move[]): Promise<vscode.WorkspaceEdit> {
    const edit = new vscode.WorkspaceEdit();
    const roots = this.index.config.twigRoots;
    const templates = this.index.twigTemplates.map((t) => t.fsPath);
    const resolveTwig = (p: string) => this.index.resolveInclude(p)?.fsPath;
    // PHP render paths may keep the root folder: 'views/page-home.twig'.
    const resolvePhp = (p: string) =>
      renderPathVariants(p, roots)
        .map((v) => this.index.resolveInclude(v)?.fsPath)
        .find((f) => f !== undefined);

    let count = 0;
    let files = 0;
    const stranded = new Set<string>();
    const sources: { uri: vscode.Uri; lang: 'twig' | 'php' }[] = [
      ...templates.map((t) => ({ uri: vscode.Uri.file(t), lang: 'twig' as const })),
      ...(await this.phpFiles()).map((uri) => ({ uri, lang: 'php' as const })),
    ];
    for (const { uri, lang } of sources) {
      const text = await readText(uri);
      if (!text.includes('.twig') && !/\/['"]/.test(text)) {
        continue;
      }
      const result = referenceEdits(
        pathLiterals(text, lang),
        moves,
        lang === 'twig' ? resolveTwig : resolvePhp,
        roots,
        templates
      );
      result.stranded.forEach((s) => stranded.add(s));
      if (result.edits.length === 0) {
        continue;
      }
      // Edits land on files at their current paths, before the move happens.
      const lines = lineStarts(text);
      for (const e of result.edits) {
        edit.replace(uri, new vscode.Range(positionAt(lines, e.start), positionAt(lines, e.end)), e.newText);
      }
      count += result.edits.length;
      files++;
    }

    if (count > 0) {
      void vscode.window.showInformationMessage(
        `Timber Lens: updated ${count} template path${count === 1 ? '' : 's'} in ${files} file${files === 1 ? '' : 's'}.`
      );
    }
    if (stranded.size > 0) {
      void vscode.window.showWarningMessage(
        `Timber Lens: ${[...stranded].join(', ')} not updated: the template is no longer under a Twig root ` +
          '(timberLens.twigRoots).'
      );
    }
    return edit;
  }

  private async phpFiles(): Promise<vscode.Uri[]> {
    const seen = new Map<string, vscode.Uri>();
    for (const glob of this.index.config.phpScanGlobs) {
      for (const uri of await vscode.workspace.findFiles(glob, '{**/node_modules/**,**/vendor/**}')) {
        seen.set(uri.fsPath, uri);
      }
    }
    return [...seen.values()];
  }
}

/** The open editor's text, else the file on disk. */
async function readText(uri: vscode.Uri): Promise<string> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
  if (open) {
    return open.getText();
  }
  try {
    return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
  } catch {
    return '';
  }
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      starts.push(i + 1);
    }
  }
  return starts;
}

function positionAt(starts: number[], offset: number): vscode.Position {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return new vscode.Position(lo, offset - starts[lo]);
}
