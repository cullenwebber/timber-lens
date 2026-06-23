import * as vscode from 'vscode';

/** Build a Range from absolute character offsets within a document. */
export function rangeFromOffsets(
  doc: vscode.TextDocument,
  start: number,
  end: number
): vscode.Range {
  return new vscode.Range(doc.positionAt(start), doc.positionAt(end));
}
