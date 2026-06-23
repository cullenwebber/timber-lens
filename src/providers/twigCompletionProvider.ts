import * as vscode from 'vscode';
import { ProjectIndex } from '../services/projectIndex';
import { detectCursorContext, findEnclosingLoops } from '../parsers/twigContextParser';
import { TypeShape } from '../models/context';
import { BUILTIN_GLOBALS } from '../services/contextResolver';

export class TwigCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private readonly index: ProjectIndex) {}

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.CompletionList {
    const textBefore = document.getText(
      new vscode.Range(new vscode.Position(0, 0), position)
    );
    const ctx = detectCursorContext(textBefore);

    let items: vscode.CompletionItem[];
    switch (ctx.kind) {
      case 'path':
        items = this.completePath(ctx.pathPrefix ?? '', position);
        break;
      case 'meta':
        items = this.completeMeta(ctx.metaPrefix ?? '', position);
        break;
      case 'member':
        items = this.completeMember(document, position, ctx.baseExpr ?? '', ctx.memberPrefix ?? '');
        break;
      case 'root':
        items = this.completeRoot(document, position, ctx.rootPrefix ?? '');
        break;
      default:
        items = [];
    }

    // isIncomplete = true: VS Code re-queries this provider on every keystroke
    // instead of caching and filtering client-side. This ensures freshly
    // re-indexed ACF / context results appear without re-triggering completion.
    return new vscode.CompletionList(items, true);
  }

  // ---- path -------------------------------------------------------------

  private completePath(prefix: string, position: vscode.Position): vscode.CompletionItem[] {
    const range = backRange(position, prefix.length);
    const seen = new Set<string>();
    const items: vscode.CompletionItem[] = [];
    for (const t of this.index.twigTemplates) {
      for (const rel of t.relPaths) {
        if (seen.has(rel)) {
          continue;
        }
        seen.add(rel);
        const item = new vscode.CompletionItem(rel, vscode.CompletionItemKind.File);
        item.range = range;
        item.insertText = rel;
        item.filterText = rel;
        item.detail = 'Twig template';
        items.push(item);
      }
    }
    return items;
  }

  // ---- post.meta('...') -------------------------------------------------

  private completeMeta(prefix: string, position: vscode.Position): vscode.CompletionItem[] {
    const range = backRange(position, prefix.length);
    const items: vscode.CompletionItem[] = [];
    for (const name of this.index.acfIndex.allNames) {
      const field = this.index.acfIndex.getField(name);
      const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Field);
      item.range = range;
      item.detail = field ? `ACF ${field.type}` : 'ACF field';
      if (field?.group) {
        item.documentation = new vscode.MarkdownString(`Field group: **${field.group}**`);
      }
      items.push(item);
    }
    return items;
  }

  // ---- member access ----------------------------------------------------

  private completeMember(
    document: vscode.TextDocument,
    position: vscode.Position,
    baseExpr: string,
    memberPrefix: string
  ): vscode.CompletionItem[] {
    const resolver = this.index.resolverForTwig(document.uri.fsPath);
    const loopVars = resolver.buildLoopVars(
      findEnclosingLoops(document.getText(), document.offsetAt(position))
    );
    const shape = resolver.resolveExpr(baseExpr, loopVars);
    if (!shape || shape.kind !== 'object' || !shape.keys) {
      return [];
    }
    const range = backRange(position, memberPrefix.length);
    return [...shape.keys.entries()].map(([name, child]) =>
      keyCompletion(name, child, range)
    );
  }

  // ---- root variable ----------------------------------------------------

  private completeRoot(
    document: vscode.TextDocument,
    position: vscode.Position,
    prefix: string
  ): vscode.CompletionItem[] {
    const resolver = this.index.resolverForTwig(document.uri.fsPath);
    const loopVars = resolver.buildLoopVars(
      findEnclosingLoops(document.getText(), document.offsetAt(position))
    );
    const range = backRange(position, prefix.length);
    const items: vscode.CompletionItem[] = [];
    const seen = new Set<string>();

    const add = (name: string, shape: TypeShape | undefined, kind: vscode.CompletionItemKind) => {
      if (seen.has(name)) {
        return;
      }
      seen.add(name);
      const item = new vscode.CompletionItem(name, kind);
      item.range = range;
      if (shape) {
        item.detail = describeShape(shape);
      }
      items.push(item);
    };

    // Loop variables (innermost scope).
    for (const [name, shape] of loopVars) {
      add(name, shape, vscode.CompletionItemKind.Variable);
    }
    // Template context variables from PHP.
    const ctx = this.index.contextForTwig(document.uri.fsPath);
    if (ctx) {
      for (const [name, shape] of ctx.vars) {
        add(name, shape, vscode.CompletionItemKind.Variable);
      }
    }
    // Built-in Timber globals (fallback).
    if (this.index.config.enableBuiltinGlobals) {
      for (const name of BUILTIN_GLOBALS) {
        add(name, resolver.resolveRoot(name, loopVars), vscode.CompletionItemKind.Variable);
      }
    } else {
      // `post` is still needed for ACF access even with globals disabled.
      add('post', resolver.post, vscode.CompletionItemKind.Variable);
    }

    return items;
  }
}

function keyCompletion(
  name: string,
  shape: TypeShape,
  range: vscode.Range
): vscode.CompletionItem {
  const kind =
    shape.kind === 'object'
      ? vscode.CompletionItemKind.Field
      : shape.kind === 'array'
        ? vscode.CompletionItemKind.Field
        : vscode.CompletionItemKind.Property;
  const item = new vscode.CompletionItem(name, kind);
  item.range = range;
  item.detail = describeShape(shape);
  if (shape.fieldGroup) {
    item.documentation = new vscode.MarkdownString(`Field group: **${shape.fieldGroup}**`);
  }
  return item;
}

function describeShape(shape: TypeShape): string {
  if (shape.acfType) {
    return `ACF ${shape.acfType}`;
  }
  switch (shape.kind) {
    case 'array':
      return 'array';
    case 'object':
      return 'object';
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    default:
      return 'mixed';
  }
}

/** A range covering the already-typed prefix ending at `position`. */
function backRange(position: vscode.Position, length: number): vscode.Range {
  const start = position.translate(0, -Math.min(length, position.character));
  return new vscode.Range(start, position);
}
