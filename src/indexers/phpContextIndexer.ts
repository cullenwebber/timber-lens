import { TemplateContext } from '../models/template';
import { TypeShape, objectShape, stringShape, unknownShape } from '../models/context';
import { parsePhpFile, PhpValue } from '../parsers/phpTimberParser';
import { AcfIndex } from '../services/acfResolver';
import { baseName } from '../utils/paths';

export interface PhpFileInput {
  fsPath: string;
  content: string;
}

/**
 * Build template contexts from PHP files. `get_field()` values are resolved
 * against the ACF index so nested ACF shapes flow into Twig completion.
 */
export function buildPhpContexts(
  files: PhpFileInput[],
  acf: AcfIndex
): TemplateContext[] {
  const contexts: TemplateContext[] = [];
  for (const file of files) {
    const source = baseName(file.fsPath);
    let parsed;
    try {
      parsed = parsePhpFile(file.content);
    } catch {
      continue;
    }
    for (const ctx of parsed) {
      const vars = new Map<string, TypeShape>();
      ctx.vars.forEach((value, key) => {
        const shape = phpValueToShape(value, acf);
        shape.source = source;
        vars.set(key, shape);
      });
      contexts.push({ templatePath: ctx.templatePath, sourceFile: source, vars });
    }
  }
  return contexts;
}

function phpValueToShape(value: PhpValue, acf: AcfIndex): TypeShape {
  switch (value.kind) {
    case 'array': {
      const keys = new Map<string, TypeShape>();
      for (const entry of value.entries) {
        keys.set(entry.key, phpValueToShape(entry.value, acf));
      }
      return objectShape(keys);
    }
    case 'getField': {
      const shape = acf.shapeByName(value.field);
      if (shape) {
        return shape;
      }
      return stringShape({ fieldName: value.field, acfType: 'unknown' });
    }
    case 'string':
      return stringShape();
    case 'number':
      return { kind: 'number' };
    case 'bool':
      return { kind: 'boolean' };
    default:
      return unknownShape();
  }
}
