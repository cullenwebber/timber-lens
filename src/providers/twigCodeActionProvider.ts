import * as vscode from 'vscode';
import { TwigDiagnosticsProvider } from './twigDiagnosticsProvider';

/** Quick fixes for Timber Lens diagnostics: did-you-mean, create template, include hash entries. */
export class TwigCodeActionProvider implements vscode.CodeActionProvider {
  static readonly metadata: vscode.CodeActionProviderMetadata = {
    providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
  };

  constructor(private readonly diagnostics: TwigDiagnosticsProvider) {}

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    for (const diag of context.diagnostics) {
      if (diag.source !== 'Timber Lens') {
        continue;
      }
      for (const fix of this.diagnostics.fixesFor(document.uri, diag)) {
        const action = new vscode.CodeAction(fix.title, vscode.CodeActionKind.QuickFix);
        action.diagnostics = [diag];
        action.edit = fix.edit;
        action.command = fix.command;
        action.isPreferred = fix.preferred;
        actions.push(action);
      }
    }
    return actions;
  }
}
