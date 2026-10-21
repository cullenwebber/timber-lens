import * as vscode from 'vscode';
import { ProjectIndex } from '../services/projectIndex';
import { findEnclosingLoops, isInsideTwig } from '../parsers/twigContextParser';
import { blockTags, extendsPath } from '../parsers/twigTemplateParser';
import { StructField, parseStructure } from '../services/fieldStructure';
import { callableAt, stringLiteralAt } from './twigSymbols';

const PATH_CONTEXT_RE = /(?:\b(?:include|extends|embed|import|from|source)\b|\binclude\s*\()/;
const CHAIN_TAIL = /([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)$/;

/**
 * Go to definition for include paths, custom functions / filters, overridden
 * blocks, ACF fields (structure line or ACF JSON) and context variables (the
 * PHP that sets them, or the include that passes them).
 */
export class TwigDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private readonly index: ProjectIndex) {}

  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.Definition | undefined> {
    const line = document.lineAt(position.line).text;

    const literal = stringLiteralAt(line, position.character);
    if (literal && PATH_CONTEXT_RE.test(line.slice(0, literal.start))) {
      const template = this.index.resolveInclude(literal.value);
      return template ? new vscode.Location(vscode.Uri.file(template.fsPath), new vscode.Position(0, 0)) : undefined;
    }

    const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_]\w*/);
    if (!wordRange || !isInsideTwig(document.getText(new vscode.Range(new vscode.Position(0, 0), wordRange.start)))) {
      return undefined;
    }
    const word = document.getText(wordRange);
    const before = line.slice(0, wordRange.start.character);

    const callable = callableAt(this.index, document, position);
    if (callable?.custom) {
      return new vscode.Location(vscode.Uri.file(callable.custom.fsPath), new vscode.Position(callable.custom.line, 0));
    }

    if (/\{%-?\s*block\s+$/.test(before)) {
      return this.parentBlock(document.getText(), word);
    }

    const chain = CHAIN_TAIL.exec(line.slice(0, wordRange.end.character))?.[1].replace(/\s+/g, '');
    if (!chain) {
      return undefined;
    }
    return chain.includes('.') ? this.fieldDefinition(document, position, chain) : this.variableDefinition(document, word);
  }

  /** The block of the same name in the nearest parent template. */
  private parentBlock(text: string, name: string): vscode.Location | undefined {
    let parentPath = extendsPath(text);
    for (let depth = 0; parentPath && depth < 5; depth++) {
      const parent = this.index.resolveInclude(parentPath);
      const parentText = parent && this.index.templateText(parent.fsPath);
      if (!parent || !parentText) {
        return undefined;
      }
      const block = blockTags(parentText).find((b) => b.name === name);
      if (block) {
        return new vscode.Location(vscode.Uri.file(parent.fsPath), positionAt(parentText, block.offset));
      }
      parentPath = extendsPath(parentText);
    }
    return undefined;
  }

  /** An ACF field: its line in this file's structure, else its ACF JSON. */
  private async fieldDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    chain: string
  ): Promise<vscode.Location | undefined> {
    const names = chain.split('.');
    const fieldName = names[names.length - 1];
    const text = document.getText();

    const { block } = parseStructure(text);
    if (block) {
      const inStructure = names[0] === this.index.blockVar ? findPath(block.fields, names.slice(1)) : findName(block.fields, fieldName);
      if (inStructure) {
        return new vscode.Location(document.uri, new vscode.Position(inStructure.line, 0));
      }
    }

    const resolver = this.index.resolverForTwig(document.uri.fsPath, text);
    const loopVars = resolver.buildLoopVars(findEnclosingLoops(text, document.offsetAt(position)));
    const shape = resolver.resolveExpr(chain, loopVars);
    if (!shape?.acfFile || !shape.acfKey) {
      return undefined;
    }
    const json = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(shape.acfFile))).toString('utf8');
    const at = json.search(new RegExp(`"key"\\s*:\\s*"${shape.acfKey}"`));
    return at === -1 ? undefined : new vscode.Location(vscode.Uri.file(shape.acfFile), positionAt(json, at));
  }

  /** Where a context variable comes from: PHP, timber/context, or an include. */
  private async variableDefinition(document: vscode.TextDocument, name: string): Promise<vscode.Location | undefined> {
    const fsPath = document.uri.fsPath;

    const render = this.index.renderContextsFor(fsPath).find((c) => c.vars.has(name) && c.sourcePath);
    if (render?.sourcePath) {
      const php = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(render.sourcePath))).toString('utf8');
      const at = php.search(new RegExp(`\\[\\s*['"]${name}['"]\\s*\\]\\s*=|['"]${name}['"]\\s*=>`));
      return new vscode.Location(vscode.Uri.file(render.sourcePath), at === -1 ? new vscode.Position(0, 0) : positionAt(php, at));
    }

    const passer = this.index.includersOf(fsPath).find((i) => i.tag.entries.some((e) => e.key === name));
    if (passer) {
      const entry = passer.tag.entries.find((e) => e.key === name)!;
      const callerText = this.index.templateText(passer.callerPath) ?? '';
      return new vscode.Location(vscode.Uri.file(passer.callerPath), positionAt(callerText, entry.keyStart));
    }

    const global = this.index.globalContext.get(name);
    if (global) {
      return new vscode.Location(vscode.Uri.file(global.fsPath), new vscode.Position(global.line, 0));
    }
    return undefined;
  }
}

/** The structure field at a name path, e.g. ["cards", "title"]. */
function findPath(fields: StructField[], path: string[]): StructField | undefined {
  let list = fields;
  let found: StructField | undefined;
  for (const name of path) {
    found = list.find((f) => f.name === name);
    if (!found) {
      return undefined;
    }
    list = found.children;
  }
  return found;
}

/** The first structure field with a name, at any depth. */
function findName(fields: StructField[], name: string): StructField | undefined {
  for (const f of fields) {
    const found = f.name === name ? f : findName(f.children, name);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function positionAt(text: string, offset: number): vscode.Position {
  const before = text.slice(0, offset);
  const line = before.split('\n').length - 1;
  return new vscode.Position(line, offset - (before.lastIndexOf('\n') + 1));
}
