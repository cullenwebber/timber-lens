import * as vscode from 'vscode';
import { ProjectIndex } from '../services/projectIndex';

const PATH_CONTEXT_RE = /(?:\b(?:include|extends|embed|import|from)\b|\binclude\s*\()/;

export class TwigDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private readonly index: ProjectIndex) {}

  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.Definition | undefined {
    const line = document.lineAt(position.line).text;
    const literal = stringLiteralAt(line, position.character);
    if (!literal) {
      return undefined;
    }

    // Only resolve when this string is the argument of an include-like tag/func.
    const before = line.slice(0, literal.start);
    if (!PATH_CONTEXT_RE.test(before)) {
      return undefined;
    }

    const template = this.index.resolveInclude(literal.value);
    if (!template) {
      return undefined;
    }
    return new vscode.Location(
      vscode.Uri.file(template.fsPath),
      new vscode.Position(0, 0)
    );
  }
}

interface LiteralHit {
  value: string;
  start: number; // index of opening quote
  end: number; // index after closing quote
}

/** Find the string literal containing the given character index on a line. */
function stringLiteralAt(line: string, character: number): LiteralHit | undefined {
  const re = /(['"])([^'"]*)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const start = m.index;
    const end = m.index + m[0].length;
    if (character >= start && character <= end) {
      return { value: m[2], start, end };
    }
  }
  return undefined;
}
