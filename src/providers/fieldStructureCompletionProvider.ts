import * as vscode from 'vscode';
import { ProjectIndex } from '../services/projectIndex';
import { INDENT, formatFieldLines, humanize } from '../services/fieldStructure';
import {
  StructureCursor,
  isContainerType,
  rankTypes,
  structureCursorAt,
  suggestFields,
  suggestLabels,
} from '../services/fieldStructureCompletion';
import { baseName } from '../utils/paths';

/**
 * Completion while typing the `acf-fields` structure comment: whole fields
 * from the project's ACF JSON, field types, labels, and the header's
 * flexible content field / layout.
 */
export class FieldStructureCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private readonly index: ProjectIndex) {}

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
    context: vscode.CompletionContext
  ): vscode.CompletionItem[] | undefined {
    const cursor = structureCursorAt(document.getText(), document.offsetAt(position));
    if (!cursor) {
      return undefined;
    }
    const range = (length: number, extra = 0) =>
      new vscode.Range(position.translate(0, -length), position.translate(0, extra));

    switch (cursor.kind) {
      case 'owner':
        return this.owners(range(cursor.prefix.length));
      case 'layout':
        return this.layouts(cursor.owner, document, range(cursor.prefix.length));
      case 'name':
        // Typing indentation is not a request for a field.
        if (context.triggerCharacter === ' ' && cursor.prefix === '') {
          return undefined;
        }
        return this.fields(cursor, range(cursor.prefix.length));
      case 'type':
        return this.types(cursor, range(cursor.prefix.length));
      case 'label':
        return this.labels(cursor, range(cursor.prefix.length, cursor.closingQuote ? 1 : 0));
    }
  }

  // ---- header -------------------------------------------------------------

  private owners(range: vscode.Range): vscode.CompletionItem[] {
    const owners = new Set(this.index.acfIndex.flexibleLayouts.map((e) => e.field.name));
    return [...owners].map((name) => {
      const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Field);
      item.range = range;
      item.detail = 'flexible content field';
      item.insertText = `${name} / `;
      item.command = { title: 'Suggest layouts', command: 'editor.action.triggerSuggest' };
      return item;
    });
  }

  private layouts(owner: string, document: vscode.TextDocument, range: vscode.Range): vscode.CompletionItem[] {
    const fileLayout = baseName(document.fileName).replace(/\.twig$/, '');
    const existing = this.index.acfIndex.flexibleLayouts
      .filter((e) => e.field.name === owner)
      .map((e) => e.layout);

    const items = existing.map((layout) => {
      const label = layout.label ?? humanize(layout.name);
      const item = new vscode.CompletionItem(layout.name, vscode.CompletionItemKind.Struct);
      item.range = range;
      item.detail = `"${label}" · ${layout.subFields.length} fields`;
      item.insertText = `${layout.name} "${label}"`;
      item.sortText = layout.name === fileLayout ? '0' : `1${layout.name}`;
      return item;
    });
    if (!existing.some((l) => l.name === fileLayout)) {
      const item = new vscode.CompletionItem(fileLayout, vscode.CompletionItemKind.Struct);
      item.range = range;
      item.detail = 'new layout, named after this file';
      item.insertText = `${fileLayout} "${humanize(fileLayout)}"`;
      item.sortText = '0';
      items.push(item);
    }
    return items;
  }

  // ---- field lines --------------------------------------------------------

  private fields(cursor: Extract<StructureCursor, { kind: 'name' }>, range: vscode.Range): vscode.CompletionItem[] {
    const suggestions = suggestFields(this.index.acfIndex, cursor.level);
    const items = suggestions.map((s, i) => {
      const f = s.field;
      const item = new vscode.CompletionItem(
        { label: f.name, description: f.type },
        isContainerType(f.type) ? vscode.CompletionItemKind.Struct : vscode.CompletionItemKind.Field
      );
      item.range = range;
      item.filterText = f.name;
      item.sortText = String(i).padStart(5, '0');
      const where = s.where.slice(0, 3).join(', ') + (s.where.length > 3 ? ', …' : '');
      item.detail = `${f.type} "${f.label ?? humanize(f.name)}" · in ${where}`;

      if (cursor.wholeLine) {
        const lines = formatFieldLines([f], 0);
        item.insertText = new vscode.SnippetString(lines.map(escapeSnippet).join('\n'));
        item.documentation = new vscode.MarkdownString().appendCodeblock(lines.join('\n'), 'yaml');
      } else {
        item.insertText = f.name;
      }
      return item;
    });

    // A field the project has not used yet: pick its type from a list.
    if (cursor.wholeLine && /^[A-Za-z0-9_-]+$/.test(cursor.prefix) && !items.some((i) => i.filterText === cursor.prefix)) {
      const types = rankTypes(this.index.acfIndex, cursor.prefix).map((t) => t.type);
      const item = new vscode.CompletionItem(
        { label: cursor.prefix, description: 'new field' },
        vscode.CompletionItemKind.Snippet
      );
      item.range = range;
      item.filterText = cursor.prefix;
      item.sortText = '99999';
      item.insertText = new vscode.SnippetString(
        `${escapeSnippet(cursor.prefix)}: \${1|${types.join(',')}|} "\${2:${escapeSnippet(humanize(cursor.prefix))}}"`
      );
      item.detail = 'Choose a type for a new field';
      items.push(item);
    }
    return items;
  }

  private types(cursor: Extract<StructureCursor, { kind: 'type' }>, range: vscode.Range): vscode.CompletionItem[] {
    const label = escapeSnippet(humanize(cursor.fieldName));
    return rankTypes(this.index.acfIndex, cursor.fieldName).map(({ type, usesForName }, i) => {
      const item = new vscode.CompletionItem(type, vscode.CompletionItemKind.TypeParameter);
      item.range = range;
      item.filterText = type;
      item.sortText = String(i).padStart(3, '0');
      if (usesForName > 0) {
        item.detail = `${cursor.fieldName} is a ${type} ${usesForName === 1 ? 'once' : `${usesForName} times`} in ACF`;
      }

      let snippet = (cursor.needsSpace ? ' ' : '') + type;
      if (!cursor.hasLabel) {
        snippet += ` "\${1:${label}}"`;
        // Start the first sub field on an indented line.
        if (isContainerType(type)) {
          snippet += `\n${INDENT}$0`;
        }
      }
      item.insertText = new vscode.SnippetString(snippet);
      return item;
    });
  }

  private labels(cursor: Extract<StructureCursor, { kind: 'label' }>, range: vscode.Range): vscode.CompletionItem[] {
    return suggestLabels(this.index.acfIndex, cursor.fieldName).map((label, i) => {
      const quoted = `"${label}"`;
      const item = new vscode.CompletionItem(quoted, vscode.CompletionItemKind.Text);
      item.range = range;
      item.filterText = quoted;
      item.sortText = String(i).padStart(3, '0');
      item.detail = i === 0 ? 'from the field name' : 'used in ACF';
      return item;
    });
  }
}

function escapeSnippet(text: string): string {
  return text.replace(/[\\$}]/g, '\\$&');
}
