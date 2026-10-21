import * as vscode from 'vscode';
import { ProjectIndex } from '../services/projectIndex';
import { detectCursorContext, findEnclosingLoops } from '../parsers/twigContextParser';
import { TypeShape, describeShape } from '../models/context';
import { BUILTIN_GLOBALS } from '../services/contextResolver';
import { includeCandidates } from '../services/templateResolver';
import { BUILTIN_FILTERS, BUILTIN_FUNCTIONS } from '../services/twigBuiltins';
import { blockNameAt, blockTags, extendsPath, includeHashAt, templateVariables } from '../parsers/twigTemplateParser';
import { callableMarkdown, templateMarkdown } from './twigSymbols';

export class TwigCompletionProvider implements vscode.CompletionItemProvider {
  /** Include path items whose documentation is filled in on resolve. */
  private readonly pathItems = new WeakMap<vscode.CompletionItem, string>();

  constructor(private readonly index: ProjectIndex) {}

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.CompletionList {
    const text = document.getText();
    const offset = document.offsetAt(position);
    const textBefore = text.slice(0, offset);

    const hash = includeHashAt(text, offset);
    if (hash) {
      return new vscode.CompletionList(this.completeIncludeKeys(hash.path, hash.keys, hash.prefix, position));
    }
    const blockName = blockNameAt(text, offset);
    if (blockName !== undefined) {
      return new vscode.CompletionList(this.completeBlockNames(text, blockName, position));
    }

    const ctx = detectCursorContext(textBefore);
    let items: vscode.CompletionItem[];
    switch (ctx.kind) {
      case 'path':
        items = this.completePath(ctx.pathPrefix ?? '', position);
        break;
      case 'meta':
        items = this.completeMeta(ctx.metaPrefix ?? '', position);
        break;
      case 'filter':
        items = this.completeFilters(ctx.filterPrefix ?? '', position);
        break;
      case 'member':
        items = this.completeMember(document, position, ctx.baseExpr ?? '', ctx.memberPrefix ?? '');
        break;
      case 'root':
        items = [
          ...this.completeRoot(document, position, ctx.rootPrefix ?? ''),
          ...this.completeFunctions(ctx.rootPrefix ?? '', position),
        ];
        break;
      default:
        items = [];
    }

    // isIncomplete = true: VS Code re-queries this provider on every keystroke
    // instead of caching and filtering client-side. This ensures freshly
    // re-indexed ACF / context results appear without re-triggering completion.
    return new vscode.CompletionList(items, true);
  }

  resolveCompletionItem(item: vscode.CompletionItem): vscode.CompletionItem {
    const fsPath = this.pathItems.get(item);
    const template = fsPath ? this.index.templateFor(fsPath) : undefined;
    if (template) {
      item.documentation = templateMarkdown(this.index, template);
    }
    return item;
  }

  // ---- path -------------------------------------------------------------

  private completePath(prefix: string, position: vscode.Position): vscode.CompletionItem[] {
    const range = backRange(position, prefix.length);
    const byPath = new Map(this.index.twigTemplates.map((t) => [t.includePath, t]));
    return includeCandidates(this.index.twigTemplates).map((rel) => {
      const item = new vscode.CompletionItem(rel, vscode.CompletionItemKind.File);
      item.range = range;
      item.insertText = rel;
      item.filterText = rel;
      item.detail = 'Twig template';
      const template = byPath.get(rel);
      if (template) {
        this.pathItems.set(item, template.fsPath);
      }
      return item;
    });
  }

  // ---- include ... with { key: ... } ---------------------------------------

  private completeIncludeKeys(
    path: string,
    taken: string[],
    prefix: string,
    position: vscode.Position
  ): vscode.CompletionItem[] {
    const template = this.index.resolveInclude(path);
    const text = template && this.index.templateText(template.fsPath);
    if (!text) {
      return [];
    }
    const range = backRange(position, prefix.length);
    return templateVariables(text)
      .filter((v) => !taken.includes(v.name))
      .map((v, i) => {
        const item = new vscode.CompletionItem(
          { label: v.name, description: v.optional ? 'optional' : undefined },
          vscode.CompletionItemKind.Property
        );
        item.range = range;
        item.insertText = new vscode.SnippetString(`${v.name}: $0`);
        // Required variables first, in the order the template uses them.
        item.sortText = `${v.optional ? 1 : 0}${String(i).padStart(3, '0')}`;
        item.detail = `${v.optional ? 'Optional' : 'Used'} by ${path}`;
        if (v.members.length) {
          item.documentation = new vscode.MarkdownString(
            `Reads ${v.members.map((m) => `\`${v.name}.${m}\``).join(', ')}`
          );
        }
        return item;
      });
  }

  // ---- {% block name %} --------------------------------------------------

  private completeBlockNames(text: string, prefix: string, position: vscode.Position): vscode.CompletionItem[] {
    const own = new Set(blockTags(text).map((b) => b.name));
    const range = backRange(position, prefix.length);
    const items: vscode.CompletionItem[] = [];
    const seen = new Set<string>();
    let parentPath = extendsPath(text);
    for (let depth = 0; parentPath && depth < 5; depth++) {
      const parent = this.index.resolveInclude(parentPath);
      const parentText = parent && this.index.templateText(parent.fsPath);
      if (!parentText) {
        break;
      }
      for (const b of blockTags(parentText)) {
        if (own.has(b.name) || seen.has(b.name)) {
          continue;
        }
        seen.add(b.name);
        const item = new vscode.CompletionItem(b.name, vscode.CompletionItemKind.Module);
        item.range = range;
        item.detail = `block in ${parentPath}`;
        items.push(item);
      }
      parentPath = extendsPath(parentText);
    }
    return items;
  }

  // ---- filters and functions ---------------------------------------------

  private completeFilters(prefix: string, position: vscode.Position): vscode.CompletionItem[] {
    const range = backRange(position, prefix.length);
    const custom = this.index.twigCallables.filter((c) => c.kind === 'filter');
    const items = custom.map((c) => {
      const item = new vscode.CompletionItem({ label: c.name, description: 'custom' }, vscode.CompletionItemKind.Function);
      item.range = range;
      item.sortText = `0${c.name}`;
      item.documentation = callableMarkdown({ kind: 'filter', name: c.name, custom: c });
      return item;
    });
    for (const b of BUILTIN_FILTERS) {
      if (custom.some((c) => c.name === b.name)) {
        continue;
      }
      const item = new vscode.CompletionItem({ label: b.name, description: b.source }, vscode.CompletionItemKind.Function);
      item.range = range;
      item.sortText = `1${b.name}`;
      item.detail = b.signature;
      item.documentation = callableMarkdown({ kind: 'filter', name: b.name, builtin: b });
      items.push(item);
    }
    return items;
  }

  private completeFunctions(prefix: string, position: vscode.Position): vscode.CompletionItem[] {
    const range = backRange(position, prefix.length);
    const custom = this.index.twigCallables.filter((c) => c.kind === 'function');
    const make = (name: string, description: string, sort: string, doc: vscode.MarkdownString) => {
      const item = new vscode.CompletionItem({ label: name, description }, vscode.CompletionItemKind.Function);
      item.range = range;
      item.insertText = new vscode.SnippetString(`${name}($0)`);
      item.sortText = sort;
      item.documentation = doc;
      return item;
    };
    return [
      ...custom.map((c) =>
        make(c.name, 'custom function', `5${c.name}`, callableMarkdown({ kind: 'function', name: c.name, custom: c }))
      ),
      ...BUILTIN_FUNCTIONS.filter((b) => !custom.some((c) => c.name === b.name)).map((b) =>
        make(b.name, `${b.source} function`, `6${b.name}`, callableMarkdown({ kind: 'function', name: b.name, builtin: b }))
      ),
    ];
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
    const resolver = this.index.resolverForTwig(document.uri.fsPath, document.getText());
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
    const resolver = this.index.resolverForTwig(document.uri.fsPath, document.getText());
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
        item.detail = describeShape(shape) + (shape.source ? ` · ${shape.source}` : '');
      }
      items.push(item);
    };

    // Loop variables (innermost scope).
    for (const [name, shape] of loopVars) {
      add(name, shape, vscode.CompletionItemKind.Variable);
    }
    // Template context: PHP, block row, include values, timber/context.
    const ctx = this.index.contextForTwig(document.uri.fsPath, document.getText());
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

/** A range covering the already-typed prefix ending at `position`. */
function backRange(position: vscode.Position, length: number): vscode.Range {
  const start = position.translate(0, -Math.min(length, position.character));
  return new vscode.Range(start, position);
}
