import * as vscode from 'vscode';
import { ProjectIndex } from './services/projectIndex';
import { TwigCompletionProvider } from './providers/twigCompletionProvider';
import { TwigHoverProvider } from './providers/twigHoverProvider';
import { TwigDiagnosticsProvider } from './providers/twigDiagnosticsProvider';
import { TwigDefinitionProvider } from './providers/twigDefinitionProvider';
import { TwigCodeActionProvider } from './providers/twigCodeActionProvider';
import { TemplateMoveParticipant } from './providers/templateMoveParticipant';
import { TemplateContextView } from './views/templateContextView';
import { createBlockTemplate } from './commands/createBlockTemplate';
import { FieldStructureProvider } from './providers/fieldStructureProvider';
import { FieldStructureCompletionProvider } from './providers/fieldStructureCompletionProvider';

const TWIG_SELECTOR: vscode.DocumentSelector = [
  { language: 'twig' },
  { scheme: 'file', pattern: '**/*.twig' },
];

let projectIndex: ProjectIndex | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const index = new ProjectIndex();
  projectIndex = index;
  context.subscriptions.push({ dispose: () => index.dispose() });

  // Completion. Trigger on '.', quotes, '/' and '|' so member / meta / path /
  // filter completions fire as the developer types.
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      TWIG_SELECTOR,
      new TwigCompletionProvider(index),
      '.',
      "'",
      '"',
      '/',
      '|'
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

  // Quick fixes for those diagnostics.
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      TWIG_SELECTOR,
      new TwigCodeActionProvider(diagnostics),
      TwigCodeActionProvider.metadata
    )
  );

  // Explorer view showing the active template's context.
  new TemplateContextView(index).register(context);

  // Editable ACF field structure comment in block templates.
  new FieldStructureProvider(index).register(context, TWIG_SELECTOR);

  // Fields, types and labels while typing that structure. It is a Twig
  // comment, so package.json turns quick suggestions on in Twig comments.
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      TWIG_SELECTOR,
      new FieldStructureCompletionProvider(index),
      ':',
      ' ',
      '/',
      '"',
      '[',
      ','
    )
  );

  // Rewrite include and render paths when templates are moved or renamed.
  new TemplateMoveParticipant(index).register(context);

  // Scaffold a block template from a flexible content layout.
  context.subscriptions.push(
    vscode.commands.registerCommand('timberLens.createBlockTemplate', () =>
      createBlockTemplate(index)
    )
  );

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

  await vscode.commands.executeCommand('setContext', 'timberLens.active', true);
  await index.initialize();
}

export function deactivate(): void {
  projectIndex?.dispose();
  projectIndex = undefined;
}
