import * as vscode from 'vscode';
import { ProjectIndex } from '../services/projectIndex';
import { findEnclosingLoops } from '../parsers/twigContextParser';
import { TypeShape, describeShape } from '../models/context';
import { BUILTIN_GLOBALS } from '../services/contextResolver';
import { baseName } from '../utils/paths';

export const CONTEXT_VIEW_ID = 'timberLens.templateContext';
const REVEAL_COMMAND = 'timberLens.revealInFile';

type ContextNode = SectionNode | InfoNode | VarNode;

interface SectionNode {
  type: 'section';
  id: string;
  label: string;
  children: ContextNode[];
}

interface InfoNode {
  type: 'info';
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  icon: string;
  command?: vscode.Command;
}

interface VarNode {
  type: 'var';
  id: string;
  name: string;
  shape: TypeShape;
  description: string;
  command?: vscode.Command;
}

/**
 * Explorer view listing everything Timber Lens knows about the active Twig
 * template: which PHP files render it, its context variables and where each
 * comes from, loop variables at the cursor, and Timber globals. Exists so a
 * missing or surprising completion can be explained at a glance.
 */
export class TemplateContextView implements vscode.TreeDataProvider<ContextNode> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  private view: vscode.TreeView<ContextNode> | undefined;
  private document: vscode.TextDocument | undefined;
  private cursorOffset = 0;
  /** Identity of the loops enclosing the cursor, to refresh only on change. */
  private loopKey = '';

  constructor(private readonly index: ProjectIndex) {}

  register(context: vscode.ExtensionContext): void {
    const view = vscode.window.createTreeView(CONTEXT_VIEW_ID, {
      treeDataProvider: this,
      showCollapseAll: true,
    });
    this.view = view;
    context.subscriptions.push(
      view,
      this.changeEmitter,
      view.onDidChangeVisibility(() => this.refresh()),
      vscode.window.onDidChangeActiveTextEditor((editor) => this.track(editor)),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor.document === this.document) {
          this.cursorOffset = this.document.offsetAt(e.selections[0].active);
          this.refreshIfLoopsChanged();
        }
      }),
      vscode.workspace.onDidCloseTextDocument((doc) => {
        if (doc === this.document) {
          this.document = undefined;
          this.refresh();
        }
      }),
      this.index.onDidChange(() => this.refresh()),
      vscode.commands.registerCommand(REVEAL_COMMAND, revealInFile),
      vscode.commands.registerCommand('timberLens.showTemplateContext', () =>
        vscode.commands.executeCommand(`${CONTEXT_VIEW_ID}.focus`)
      )
    );
    this.track(vscode.window.activeTextEditor);
  }

  /** Follow the active editor when it is a Twig template. Other editors (e.g.
   * a PHP file opened from this view) leave the last template showing. */
  private track(editor: vscode.TextEditor | undefined): void {
    if (!editor || !isTwig(editor.document)) {
      return;
    }
    this.document = editor.document;
    this.cursorOffset = editor.document.offsetAt(editor.selection.active);
    this.refresh();
  }

  private refresh(): void {
    if (!this.view?.visible) {
      return;
    }
    this.view.description = this.document ? baseName(this.document.fileName) : undefined;
    this.view.message = this.document
      ? undefined
      : 'Open a Twig template to see the variables it can use.';
    this.loopKey = this.currentLoopKey();
    this.changeEmitter.fire();
  }

  private refreshIfLoopsChanged(): void {
    if (this.view?.visible && this.currentLoopKey() !== this.loopKey) {
      this.refresh();
    }
  }

  private currentLoopKey(): string {
    if (!this.document) {
      return '';
    }
    return findEnclosingLoops(this.document.getText(), this.cursorOffset)
      .map((l) => `${l.varName}@${l.bodyStart}`)
      .join(',');
  }

  // ---- TreeDataProvider ---------------------------------------------------

  getTreeItem(node: ContextNode): vscode.TreeItem {
    if (node.type === 'section') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.id = node.id;
      return item;
    }
    if (node.type === 'info') {
      const item = new vscode.TreeItem(node.label);
      item.id = node.id;
      item.description = node.description;
      item.tooltip = node.tooltip;
      item.iconPath = new vscode.ThemeIcon(node.icon);
      item.command = node.command;
      return item;
    }
    const item = new vscode.TreeItem(
      node.name,
      childShape(node.shape)
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );
    item.id = node.id;
    item.description = node.description;
    item.tooltip = shapeTooltip(node.name, node.shape);
    item.iconPath = new vscode.ThemeIcon(shapeIcon(node.shape));
    item.command = node.command;
    return item;
  }

  getChildren(node?: ContextNode): ContextNode[] {
    if (!node) {
      return this.document ? this.buildRoot(this.document) : [];
    }
    if (node.type === 'section') {
      return node.children;
    }
    if (node.type === 'var') {
      const parent = childShape(node.shape);
      return [...(parent?.keys ?? new Map<string, TypeShape>())].map(([name, shape]) => ({
        type: 'var',
        id: `${node.id}/${name}`,
        name,
        shape,
        description: shapeLabel(shape),
      }));
    }
    return [];
  }

  // ---- tree contents ------------------------------------------------------

  private buildRoot(doc: vscode.TextDocument): ContextNode[] {
    const fsPath = doc.uri.fsPath;
    const renders = this.index.renderContextsFor(fsPath);
    const layout = this.index.blockLayoutFor(fsPath);
    const ctx = this.index.contextForTwig(fsPath);
    const resolver = this.index.resolverForTwig(fsPath);
    const assumePosts = this.index.config.assumePostVariables;
    const sections: ContextNode[] = [];

    // Where the variables come from.
    const origin: ContextNode[] = renders.map((render, i) => ({
      type: 'info',
      id: `origin:${render.sourcePath ?? render.sourceFile}:${render.templatePath}`,
      label: render.sourceFile,
      description:
        i === 0 ? render.templatePath : `${render.templatePath} · not used for completion`,
      tooltip: render.sourcePath,
      icon: 'file-code',
      command: render.sourcePath
        ? revealCommand(render.sourcePath, [render.templatePath])
        : undefined,
    }));
    if (layout) {
      origin.push({
        type: 'info',
        id: `origin:layout:${layout}`,
        label: `Layout "${layout}"`,
        description: 'flexible content row',
        tooltip:
          `This file is in blocks/ and named after the "${layout}" layout, so ` +
          `\`${this.index.blockVar}\` holds one of its rows.`,
        icon: 'layers',
      });
    }
    if (origin.length === 0) {
      origin.push({
        type: 'info',
        id: 'origin:none',
        label: 'No Timber::render() found',
        description: 'only loops and globals are known',
        tooltip:
          'No scanned PHP file passes this template to Timber::render() or ' +
          'Timber::compile(), and it is not a block template.' +
          (assumePosts ? ' Other variables are treated as Timber posts.' : ''),
        icon: 'warning',
      });
    }
    sections.push({ type: 'section', id: 'origin', label: 'Context from', children: origin });

    // Variables passed in by PHP or the block layout.
    const sourcePath = renders[0]?.sourcePath;
    const vars: ContextNode[] = [...(ctx?.vars ?? [])].map(([name, shape]) => ({
      type: 'var',
      id: `var:${name}`,
      name,
      shape,
      description: `${shapeLabel(shape)} · ${shape.source ?? `layout "${layout}"`}`,
      command:
        shape.source && sourcePath
          ? revealCommand(sourcePath, [`['${name}']`, `'${name}'`, `"${name}"`])
          : undefined,
    }));
    if (vars.length > 0) {
      sections.push({ type: 'section', id: 'vars', label: 'Variables', children: vars });
    }

    // Loop variables in scope at the cursor.
    const loops = findEnclosingLoops(doc.getText(), this.cursorOffset);
    const loopVars = resolver.buildLoopVars(loops);
    const loopNodes: ContextNode[] = [];
    for (const loop of loops) {
      const shape = loopVars.get(loop.varName);
      if (!shape) {
        continue;
      }
      loopNodes.push({
        type: 'var',
        id: `loop:${loop.varName}@${loop.bodyStart}`,
        name: loop.varName,
        shape,
        description: `${shapeLabel(shape)} · in ${loop.iterableExpr}`,
        command: revealCommand(fsPath, [], loop.bodyStart),
      });
    }
    if (loopNodes.length > 0) {
      sections.push({ type: 'section', id: 'loops', label: 'Loop variables', children: loopNodes });
    }

    // Timber globals not shadowed by the context.
    const globalNames = this.index.config.enableBuiltinGlobals ? BUILTIN_GLOBALS : ['post'];
    const globals: ContextNode[] = [];
    for (const name of globalNames) {
      const shape = ctx?.vars.has(name) ? undefined : resolver.resolveRoot(name, new Map());
      if (shape) {
        globals.push({ type: 'var', id: `global:${name}`, name, shape, description: shapeLabel(shape) });
      }
    }
    if (assumePosts) {
      globals.push({
        type: 'info',
        id: 'global:fallback',
        label: 'Any other variable',
        description: 'treated as a Timber post',
        tooltip: 'Turn off with the timberLens.assumePostVariables setting.',
        icon: 'info',
      });
    }
    sections.push({ type: 'section', id: 'globals', label: 'Timber globals', children: globals });

    return sections;
  }
}

/** The object whose keys a node expands to: itself, or an array's item. */
function childShape(shape: TypeShape): TypeShape | undefined {
  const target = shape.kind === 'array' ? shape.item : shape;
  return target?.kind === 'object' && target.keys && target.keys.size > 0 ? target : undefined;
}

function shapeLabel(shape: TypeShape): string {
  return shape.builtin && shape.label ? shape.label : describeShape(shape);
}

function shapeIcon(shape: TypeShape): string {
  switch (shape.kind) {
    case 'object':
      return 'symbol-object';
    case 'array':
      return 'symbol-array';
    case 'string':
      return 'symbol-string';
    case 'number':
      return 'symbol-number';
    case 'boolean':
      return 'symbol-boolean';
    default:
      return 'symbol-variable';
  }
}

function shapeTooltip(name: string, shape: TypeShape): vscode.MarkdownString {
  const md = new vscode.MarkdownString(`**${name}**: ${shapeLabel(shape)}\n\n`);
  if (shape.label && !shape.builtin) {
    md.appendMarkdown(`Label: ${shape.label}\n\n`);
  }
  if (shape.fieldGroup) {
    md.appendMarkdown(`Field group: ${shape.fieldGroup}\n\n`);
  }
  if (shape.source) {
    md.appendMarkdown(`Source: ${shape.source}\n\n`);
  }
  return md;
}

function revealCommand(fsPath: string, needles: string[], offset?: number): vscode.Command {
  return { command: REVEAL_COMMAND, title: 'Reveal', arguments: [fsPath, needles, offset] };
}

/** Open a file at `offset`, or at the first of `needles` found in it. */
async function revealInFile(fsPath: string, needles: string[], offset?: number): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fsPath));
  let at = offset;
  if (at === undefined) {
    const text = doc.getText();
    at = needles.map((n) => text.indexOf(n)).find((i) => i !== -1);
  }
  const editor = await vscode.window.showTextDocument(doc, { preview: true });
  if (at !== undefined) {
    const pos = doc.positionAt(at);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }
}

function isTwig(document: vscode.TextDocument): boolean {
  return document.languageId === 'twig' || document.fileName.endsWith('.twig');
}
