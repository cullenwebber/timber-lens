import { TemplateContext } from '../models/template';
import { TypeShape, arrayShape, objectShape, stringShape, unknownShape } from '../models/context';
import { parsePhpFile, PhpValue } from '../parsers/phpTimberParser';
import { AcfIndex } from '../services/acfResolver';
import { buildPostShape, builtinGlobalShape, termShape } from '../services/contextResolver';
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
      contexts.push({
        templatePath: ctx.templatePath,
        sourceFile: source,
        sourcePath: file.fsPath,
        vars,
      });
    }
  }
  return contexts;
}

const WP_USER_KEYS = ['ID', 'display_name', 'user_login', 'user_email', 'user_nicename', 'user_url', 'roles'];

/** Shapes of common Timber / WordPress calls whose result reaches Twig. */
function callShape(name: string, acf: AcfIndex): TypeShape | undefined {
  switch (name.replace(/^\\?Timber\\Timber::/, 'Timber::')) {
    case 'Timber::get_post':
      return buildPostShape(acf);
    case 'Timber::get_posts':
      return arrayShape(buildPostShape(acf));
    case 'Timber::get_term':
      return termShape();
    case 'Timber::get_terms':
      return arrayShape(termShape());
    case 'Timber::get_menu':
      return builtinGlobalShape('menu');
    case 'Timber::get_user':
      return builtinGlobalShape('user');
    case 'wp_get_current_user':
      return objectShape(new Map(WP_USER_KEYS.map((k) => [k, stringShape()])), { label: 'WP_User' });
    default:
      return undefined;
  }
}

export function phpValueToShape(value: PhpValue, acf: AcfIndex): TypeShape {
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
    case 'options':
      // Without an options page field group the keys are not known.
      return acf.optionsFields.length > 0 ? acf.optionsShape() : unknownShape();
    case 'call':
      return callShape(value.name, acf) ?? unknownShape();
    case 'new':
      return /(^|\\)Timber\\Site$/.test(value.className) ? builtinGlobalShape('site') : unknownShape();
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
