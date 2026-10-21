import * as vscode from 'vscode';
import { ProjectIndex } from '../services/projectIndex';
import { BUILTIN_FILTERS, BUILTIN_FUNCTIONS, BuiltinCallable } from '../services/twigBuiltins';
import { TwigCallable } from '../parsers/phpTwigExtensions';
import { TwigTemplate } from '../models/template';
import { extendsPath, templateVariables } from '../parsers/twigTemplateParser';

/** A Twig function or filter name under the cursor. */
export interface CallableHit {
  kind: 'function' | 'filter';
  name: string;
  range: vscode.Range;
  custom?: TwigCallable & { fsPath: string };
  builtin?: BuiltinCallable;
}

/** The function (`name(`) or filter (`|name`) at a position, if known. */
export function callableAt(
  index: ProjectIndex,
  document: vscode.TextDocument,
  position: vscode.Position
): CallableHit | undefined {
  const range = document.getWordRangeAtPosition(position, /[A-Za-z_]\w*/);
  if (!range) {
    return undefined;
  }
  const line = document.lineAt(position.line).text;
  const before = line.slice(0, range.start.character);
  const after = line.slice(range.end.character);
  const name = document.getText(range);

  let kind: CallableHit['kind'] | undefined;
  if (/\|\s*$/.test(before) && !/\|\|\s*$/.test(before)) {
    kind = 'filter';
  } else if (/^\s*\(/.test(after) && !/\.\s*$/.test(before)) {
    kind = 'function';
  }
  if (!kind) {
    return undefined;
  }
  const custom = index.twigCallables.find((c) => c.kind === kind && c.name === name);
  const builtin = (kind === 'filter' ? BUILTIN_FILTERS : BUILTIN_FUNCTIONS).find((b) => b.name === name);
  return custom || builtin ? { kind, name, range, custom, builtin } : undefined;
}

/** Hover / documentation text for a custom or built-in callable. */
export function callableMarkdown(hit: Pick<CallableHit, 'kind' | 'name' | 'custom' | 'builtin'>): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  if (hit.custom) {
    const params = hit.custom.params ?? '';
    // A filter's first parameter is the value before the pipe.
    const call =
      hit.kind === 'filter'
        ? `${params.split(',')[0] || 'value'}|${hit.name}(${params.split(',').slice(1).join(',').trim()})`
        : `${hit.name}(${params})`;
    md.appendCodeblock(call.replace(/\(\)$/, ''), 'twig');
    if (hit.custom.doc) {
      md.appendMarkdown(`${hit.custom.doc}\n\n`);
    }
    md.appendMarkdown(`Custom ${hit.kind} · ${vscode.workspace.asRelativePath(hit.custom.fsPath)}:${hit.custom.line + 1}`);
  } else if (hit.builtin) {
    md.appendCodeblock(hit.kind === 'filter' ? `|${hit.builtin.signature}` : hit.builtin.signature, 'twig');
    md.appendMarkdown(`${hit.builtin.doc}\n\n${hit.builtin.source} ${hit.kind}`);
  }
  return md;
}

/** The string literal containing a character index on a line. */
export function stringLiteralAt(line: string, character: number): { value: string; start: number; end: number } | undefined {
  for (const m of line.matchAll(/(['"])([^'"]*)\1/g)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (character >= start && character <= end) {
      return { value: m[2], start, end };
    }
  }
  return undefined;
}

/** A markdown image of an SVG template, with its Twig stripped, if it is one. */
export function svgPreview(text: string | undefined, size = 48): string | undefined {
  const svg = text?.trim();
  if (!svg?.startsWith('<svg')) {
    return undefined;
  }
  const clean = svg
    .replace(/\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}|\{#[\s\S]*?#\}/g, '')
    .replace(/currentColor/g, '#888888')
    .replace(/<svg\b/, `<svg width="${size}" height="${size}"`);
  return `![preview](data:image/svg+xml;base64,${Buffer.from(clean).toString('base64')})`;
}

/** What an include target expects: its variables, and an SVG preview. */
export function templateMarkdown(index: ProjectIndex, template: TwigTemplate): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  const text = index.templateText(template.fsPath);
  md.appendMarkdown(`**${template.includePath}**\n\n`);
  const preview = svgPreview(text);
  if (preview) {
    md.appendMarkdown(`${preview}\n\n`);
  }
  const vars = text ? templateVariables(text) : [];
  if (vars.length > 0) {
    md.appendMarkdown('Variables:\n');
    for (const v of vars) {
      const members = v.members.length ? ` · uses ${v.members.map((m) => `\`.${m}\``).join(', ')}` : '';
      md.appendMarkdown(`- \`${v.name}\`${v.optional ? ' (optional)' : ''}${members}\n`);
    }
    md.appendMarkdown('\n');
  }
  const parent = text && extendsPath(text);
  if (parent) {
    md.appendMarkdown(`Extends \`${parent}\`\n\n`);
  }
  const includers = new Set(index.includersOf(template.fsPath).map((i) => i.callerPath)).size;
  if (includers > 0) {
    md.appendMarkdown(`Included from ${includers} template${includers === 1 ? '' : 's'}`);
  }
  return md;
}
