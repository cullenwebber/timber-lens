import * as vscode from 'vscode';
import { ProjectIndex } from './services/projectIndex';
import { TwigCompletionProvider } from './providers/twigCompletionProvider';
import { TwigHoverProvider } from './providers/twigHoverProvider';
import { TwigDiagnosticsProvider } from './providers/twigDiagnosticsProvider';
import { TwigDefinitionProvider } from './providers/twigDefinitionProvider';

const TWIG_SELECTOR: vscode.DocumentSelector = [
  { language: 'twig' },
  { scheme: 'file', pattern: '**/*.twig' },
];

let projectIndex: ProjectIndex | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const index = new ProjectIndex();
  projectIndex = index;
  context.subscriptions.push({ dispose: () => index.dispose() });

  // Completion. Trigger on '.', quotes and '/' so member / meta / path
  // completions fire as the developer types.
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      TWIG_SELECTOR,
      new TwigCompletionProvider(index),
      '.',
      "'",
      '"',
      '/'
    )
  );

  // Hover.
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(TWIG_SELECTOR, new TwigHoverProvider(index))
  );

  // Go-to-definition for include paths.
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(
      TWIG_SELECTOR,
      new TwigDefinitionProvider(index)
    )
  );

  // Diagnostics.
  const diagnostics = new TwigDiagnosticsProvider(index);
  diagnostics.register(context);

  // Manual reindex command.
  context.subscriptions.push(
    vscode.commands.registerCommand('timberLens.reindex', async () => {
      await index.rebuild();
      const s = index.stats;
      vscode.window.showInformationMessage(
        `Timber Lens reindexed: ${s.acfFields} ACF fields, ${s.templates} Twig templates, ${s.contexts} render contexts.`
      );
    })
  );

  await index.initialize();
}

export function deactivate(): void {
  projectIndex?.dispose();
  projectIndex = undefined;
}
