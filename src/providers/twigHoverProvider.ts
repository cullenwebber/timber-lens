import * as vscode from 'vscode';
import { ProjectIndex } from '../services/projectIndex';
import { findEnclosingLoops, isInsideTwig } from '../parsers/twigContextParser';
import { TypeShape } from '../models/context';
import { AcfField } from '../models/acf';
import { StructField, fieldPathAtLine, humanize, parseStructure } from '../services/fieldStructure';
import { acfFieldToShape } from '../services/acfResolver';
import { blockTags, extendsPath } from '../parsers/twigTemplateParser';
import { callableAt, callableMarkdown, stringLiteralAt, templateMarkdown } from './twigSymbols';

const PATH_CONTEXT_RE = /(?:\b(?:include|extends|embed|import|from|source)\b|\binclude\s*\()\s*\(?\s*$/;

const CHAIN_TAIL =
  /([A-Za-z_]\w*(?:\.[A-Za-z_]\w*|\.meta\(\s*['"][^'"]*['"]\s*\)|\[[^\]]*\])*)$/;

export class TwigHoverProvider implements vscode.HoverProvider {
  constructor(private readonly index: ProjectIndex) {}

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.Hover | undefined {
    const structure = this.structureHover(document, position);
    if (structure) {
      return structure;
    }

    const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_]\w*/);
    if (!wordRange) {
      return undefined;
    }
    const word = document.getText(wordRange);
    const line = document.lineAt(position.line).text;
    const beforeWord = line.slice(0, wordRange.start.character);

    // Plain markup and comments are not variables.
    const textBefore = document.getText(new vscode.Range(new vscode.Position(0, 0), wordRange.start));
    if (!isInsideTwig(textBefore)) {
      return undefined;
    }

    // An include / extends path: what the template expects, and its preview.
    const literal = stringLiteralAt(line, position.character);
    if (literal && PATH_CONTEXT_RE.test(line.slice(0, literal.start))) {
      const template = this.index.resolveInclude(literal.value);
      return template
        ? new vscode.Hover(
            templateMarkdown(this.index, template),
            new vscode.Range(position.line, literal.start + 1, position.line, literal.end - 1)
          )
        : undefined;
    }

    const callable = callableAt(this.index, document, position);
    if (callable) {
      return new vscode.Hover(callableMarkdown(callable), callable.range);
    }

    if (/\{%-?\s*block\s+$/.test(beforeWord)) {
      return this.blockHover(document.getText(), word, wordRange);
    }

    // Case 1: the word is the field name argument inside post.meta('...').
    if (/\.meta\(\s*['"]\s*$/.test(beforeWord)) {
      const field = this.index.acfIndex.getField(word);
      if (field) {
        return new vscode.Hover(acfMarkdown(word, this.index.acfIndex.shapeByName(word)), wordRange);
      }
      return undefined;
    }

    // Case 2: resolve the access chain ending at the hovered word.
    const uptoWord = line.slice(0, wordRange.end.character);
    const m = uptoWord.match(CHAIN_TAIL);
    if (!m) {
      return undefined;
    }
    const chainExpr = m[1];

    const resolver = this.index.resolverForTwig(document.uri.fsPath, document.getText());
    const loopVars = resolver.buildLoopVars(
      findEnclosingLoops(document.getText(), document.offsetAt(position))
    );
    const shape = resolver.resolveExpr(chainExpr, loopVars);
    if (!shape) {
      return undefined;
    }

    const md = shape.acfType ? acfMarkdown(word, shape) : variableMarkdown(word, shape);
    return new vscode.Hover(md, wordRange);
  }

  /** `{% block name %}`: the parent template whose block it overrides. */
  private blockHover(text: string, name: string, range: vscode.Range): vscode.Hover | undefined {
    let parentPath = extendsPath(text);
    for (let depth = 0; parentPath && depth < 5; depth++) {
      const parent = this.index.resolveInclude(parentPath);
      const parentText = parent && this.index.templateText(parent.fsPath);
      if (!parentText) {
        return undefined;
      }
      if (blockTags(parentText).some((b) => b.name === name)) {
        return new vscode.Hover(new vscode.MarkdownString(`Overrides block \`${name}\` of \`${parentPath}\``), range);
      }
      parentPath = extendsPath(parentText);
    }
    return extendsPath(text)
      ? new vscode.Hover(new vscode.MarkdownString(`No parent template defines block \`${name}\`, so it is a new block.`), range)
      : undefined;
  }

  /** A field line of the acf-fields structure: its Twig access and ACF status. */
  private structureHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    const { block } = parseStructure(document.getText());
    const offset = document.offsetAt(position);
    if (!block || offset < block.start || offset > block.end) {
      return undefined;
    }
    const path = fieldPathAtLine(block, position.line);
    if (!path) {
      return undefined;
    }
    const field = path[path.length - 1];
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${field.name}** · \`${field.type}\` "${field.label ?? humanize(field.name)}"\n\n`);
    md.appendCodeblock(`{{ ${twigAccess(this.index.blockVar, path)} }}`, 'twig');
    const withSettings = acfFieldAt(this.index.structureFields(block), path);
    if (withSettings) {
      appendValue(md, acfFieldToShape(withSettings));
    }

    const layout = this.index.acfIndex.flexibleLayouts.find(
      (e) => e.field.name === block.owner && e.layout.name === block.layoutName
    )?.layout;
    const acf = layout && acfFieldAt(layout.subFields, path);
    if (!layout) {
      md.appendMarkdown(`Layout "${block.layoutName}" is not in ACF JSON yet.`);
    } else if (!acf) {
      md.appendMarkdown('Not in ACF JSON yet: apply the structure to add it.');
    } else if (acf.type !== field.type) {
      md.appendMarkdown(`ACF JSON has this as \`${acf.type}\`: apply the structure to change it.`);
    } else {
      md.appendMarkdown('In ACF JSON.');
    }
    const line = document.lineAt(position.line);
    return new vscode.Hover(md, line.range.with(line.range.start.with({ character: line.firstNonWhitespaceCharacterIndex })));
  }
}

/** How a structure field is reached in Twig, e.g. "block.cards[].title". */
function twigAccess(blockVar: string, path: StructField[]): string {
  let expr = blockVar;
  path.forEach((f, i) => {
    expr += `.${f.name}`;
    if (f.type === 'repeater' && i < path.length - 1) {
      expr += '[]';
    }
  });
  return expr;
}

/** The ACF field at a structure path, matched by name. */
function acfFieldAt(fields: AcfField[], path: StructField[]): AcfField | undefined {
  let list = fields;
  let found: AcfField | undefined;
  for (const step of path) {
    found = list.find((f) => f.name === step.name);
    if (!found) {
      return undefined;
    }
    list = found.subFields ?? [];
  }
  return found;
}

function acfMarkdown(name: string, shape: TypeShape | undefined): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${shape?.fieldName ?? name}**\n\n`);
  if (shape?.acfType) {
    md.appendMarkdown(`ACF type: \`${shape.acfType}\`\n\n`);
  }
  if (shape?.fieldGroup) {
    md.appendMarkdown(`Field group: ${shape.fieldGroup}\n\n`);
  }
  if (shape?.source) {
    md.appendMarkdown(`Source: ${shape.source}\n\n`);
  }
  if (shape) {
    appendValue(md, shape);
  }
  return md;
}

function variableMarkdown(name: string, shape: TypeShape): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${name}**\n\n`);
  md.appendMarkdown(`Type: ${shape.kind}\n\n`);
  if (shape.source) {
    md.appendMarkdown(`Source: ${shape.source}\n\n`);
  }
  appendValue(md, shape);
  return md;
}

/** The value's shape as a code block, e.g. `{ url: string, width: number }`. */
function appendValue(md: vscode.MarkdownString, shape: TypeShape): void {
  md.appendCodeblock(formatShape(shape, ''), 'ts');
}

/** Objects nested deeper than this are summarised by their key names. */
const MAX_DEPTH = 2;

function formatShape(shape: TypeShape, indent: string, depth = 0): string {
  switch (shape.kind) {
    case 'array':
      return shape.item ? `Array<${formatShape(shape.item, indent, depth)}>` : 'array';
    case 'object': {
      if (!shape.keys || shape.keys.size === 0) {
        return 'object';
      }
      if (depth >= MAX_DEPTH) {
        const names = [...shape.keys.keys()];
        return `{ ${names.slice(0, 5).join(', ')}${names.length > 5 ? ', …' : ''} }`;
      }
      const inner = indent + '  ';
      const lines = [...shape.keys].map(
        ([key, child]) => `${inner}${key}: ${formatShape(child, inner, depth + 1)}`
      );
      return `{\n${lines.join('\n')}\n${indent}}`;
    }
    case 'unknown':
      return 'mixed';
    default:
      return shape.kind;
  }
}
