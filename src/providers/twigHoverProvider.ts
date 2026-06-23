import * as vscode from 'vscode';
import { ProjectIndex } from '../services/projectIndex';
import { findEnclosingLoops } from '../parsers/twigContextParser';
import { TypeShape } from '../models/context';

const CHAIN_TAIL =
  /([A-Za-z_]\w*(?:\.[A-Za-z_]\w*|\.meta\(\s*['"][^'"]*['"]\s*\)|\[[^\]]*\])*)$/;

export class TwigHoverProvider implements vscode.HoverProvider {
  constructor(private readonly index: ProjectIndex) {}

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.Hover | undefined {
    const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_]\w*/);
    if (!wordRange) {
      return undefined;
    }
    const word = document.getText(wordRange);
    const line = document.lineAt(position.line).text;
    const beforeWord = line.slice(0, wordRange.start.character);

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

    const resolver = this.index.resolverForTwig(document.uri.fsPath);
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
  appendKeys(md, shape);
  return md;
}

function variableMarkdown(name: string, shape: TypeShape): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${name}**\n\n`);
  md.appendMarkdown(`Type: ${shape.kind}\n\n`);
  if (shape.source) {
    md.appendMarkdown(`Source: ${shape.source}\n\n`);
  }
  appendKeys(md, shape);
  return md;
}

function appendKeys(md: vscode.MarkdownString, shape: TypeShape | undefined): void {
  if (shape?.kind === 'object' && shape.keys && shape.keys.size > 0) {
    md.appendMarkdown('Keys:\n');
    for (const key of shape.keys.keys()) {
      md.appendMarkdown(`- ${key}\n`);
    }
  } else if (shape?.kind === 'array' && shape.item?.kind === 'object' && shape.item.keys) {
    md.appendMarkdown('Item keys:\n');
    for (const key of shape.item.keys.keys()) {
      md.appendMarkdown(`- ${key}\n`);
    }
  }
}
