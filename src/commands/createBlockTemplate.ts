import * as vscode from 'vscode';
import { ProjectIndex } from '../services/projectIndex';
import { scaffoldBlockTemplate } from '../services/blockScaffold';
import { toPosix } from '../utils/paths';

/**
 * Pick a flexible_content layout and create `blocks/<layout>.twig` for it,
 * pre-filled with markup for each sub field. Opens the template instead when
 * the layout already has one.
 */
export async function createBlockTemplate(index: ProjectIndex): Promise<void> {
  const layouts = index.acfIndex.flexibleLayouts;
  if (layouts.length === 0) {
    vscode.window.showInformationMessage(
      'Timber Lens: no flexible content layouts were found in your ACF JSON.'
    );
    return;
  }

  const picked = await vscode.window.showQuickPick(
    layouts.map(({ field, layout }) => {
      const existing = index.blockTemplateFor(layout.name);
      return {
        label: layout.name,
        description: [layout.label, `in ${field.name}`].filter(Boolean).join(' · '),
        detail: existing
          ? `Already has ${vscode.workspace.asRelativePath(existing.fsPath)}, which will open`
          : undefined,
        field,
        layout,
        existing,
      };
    }),
    {
      title: 'Create Block Template',
      placeHolder: 'Pick a flexible content layout',
      matchOnDescription: true,
    }
  );
  if (!picked) {
    return;
  }
  if (picked.existing) {
    await vscode.window.showTextDocument(vscode.Uri.file(picked.existing.fsPath));
    return;
  }

  const dir = await pickBlocksDir(index);
  if (!dir) {
    return;
  }
  const uri = vscode.Uri.joinPath(dir, `${picked.layout.name}.twig`);
  if (!(await exists(uri))) {
    const content = scaffoldBlockTemplate(picked.layout, picked.field.name, index.blockVar);
    await vscode.workspace.fs.createDirectory(dir);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
  }
  await vscode.window.showTextDocument(uri);
}

/**
 * Choose the folder for the new template: a `blocks/` folder that already holds
 * templates (the most used first), else `blocks/` inside a views or templates
 * folder, else one the user browses to.
 */
async function pickBlocksDir(index: ProjectIndex): Promise<vscode.Uri | undefined> {
  const existing = new Map<string, number>();
  const suggested = new Set<string>();
  for (const t of index.twigTemplates) {
    const posix = toPosix(t.fsPath);
    const blocksAt = posix.lastIndexOf('/blocks/');
    if (blocksAt !== -1) {
      const dir = t.fsPath.slice(0, blocksAt + '/blocks'.length);
      existing.set(dir, (existing.get(dir) ?? 0) + 1);
      continue;
    }
    const root = posix.match(/^(.*\/(?:views|templates))\//);
    if (root) {
      suggested.add(t.fsPath.slice(0, root[1].length) + '/blocks');
    }
  }

  const dirs = existing.size > 0
    ? [...existing].sort((a, b) => b[1] - a[1]).map(([dir]) => dir)
    : [...suggested].sort();
  if (dirs.length === 1) {
    return vscode.Uri.file(dirs[0]);
  }
  if (dirs.length > 1) {
    const choice = await vscode.window.showQuickPick(
      dirs.map((dir) => ({ label: vscode.workspace.asRelativePath(dir), dir })),
      { title: 'Create Block Template', placeHolder: 'Folder for the new template' }
    );
    return choice ? vscode.Uri.file(choice.dir) : undefined;
  }

  // Block templates are only recognized inside a `blocks/` folder.
  const folders = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
    title: 'Choose your Twig folder (blocks/ is created inside it if needed)',
    openLabel: 'Use this folder',
  });
  const folder = folders?.[0];
  if (!folder) {
    return undefined;
  }
  return folder.path.endsWith('/blocks') ? folder : vscode.Uri.joinPath(folder, 'blocks');
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}
