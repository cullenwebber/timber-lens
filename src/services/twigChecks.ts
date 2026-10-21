// VS Code-free analysis over Twig text: the shape of a passed value, member
// accesses ACF data does not have, and structure fields a template never uses.

import { TypeShape, objectShape, stringShape, unknownShape } from '../models/context';
import { blankStrings, twigCodeOnly } from '../parsers/twigTemplateParser';
import { StructField } from './fieldStructure';

/** Filters whose result is a string / number regardless of the input. */
const STRING_FILTERS = new Set([
  'e', 'escape', 'raw', 'upper', 'lower', 'title', 'capitalize', 'trim', 'striptags', 'join', 'format',
  'replace', 'date', 'nl2br', 'url_encode', 'json_encode', 'number_format', 'excerpt', 'excerpt_chars',
  'wpautop', 'sanitize', 'truncate', 'resize', 'retina', 'tojpg', 'towebp', 'letterbox', 'relative',
]);
const NUMBER_FILTERS = new Set(['length', 'abs', 'round']);

/** Split at a top-level character (not inside strings or brackets). */
function splitTopLevel(expr: string, ch: string): string[] {
  const blanked = blankStrings(expr);
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < blanked.length; i++) {
    const c = blanked[i];
    if (c === '(' || c === '[' || c === '{') {
      depth++;
    } else if (c === ')' || c === ']' || c === '}') {
      depth--;
    } else if (c === ch && depth === 0 && !(ch === '|' && blanked[i + 1] === '|')) {
      parts.push(expr.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(expr.slice(start));
  return parts;
}

/**
 * The shape of a Twig expression such as `block.link.url|default('')`, a
 * literal, or a hash. `resolveChain` resolves plain access chains.
 */
export function shapeOfExpr(expr: string, resolveChain: (chain: string) => TypeShape | undefined): TypeShape {
  const [base, ...filters] = splitTopLevel(expr.trim(), '|').map((p) => p.trim());
  const lastFilter = filters.length ? /^\w+/.exec(filters[filters.length - 1])?.[0] : undefined;
  if (lastFilter && STRING_FILTERS.has(lastFilter)) {
    return stringShape();
  }
  if (lastFilter && NUMBER_FILTERS.has(lastFilter)) {
    return { kind: 'number' };
  }
  if (/^(['"])/.test(base) || splitTopLevel(base, '~').length > 1) {
    return stringShape();
  }
  if (/^-?\d/.test(base)) {
    return { kind: 'number' };
  }
  if (/^(true|false)$/i.test(base)) {
    return { kind: 'boolean' };
  }
  if (base.startsWith('{')) {
    const keys = new Map<string, TypeShape>();
    for (const part of splitTopLevel(base.slice(1, -1), ',')) {
      const m = /^\s*(['"]?)([\w-]+)\1\s*:(.*)$/s.exec(part);
      if (m) {
        keys.set(m[2], shapeOfExpr(m[3], resolveChain));
      }
    }
    return objectShape(keys);
  }
  // `cond ? a : b`: the shape of the first branch.
  const ternary = /^[^?]+\?(?!\?)\s*(.+?)\s*:(?!:)/.exec(blankStrings(base));
  if (ternary) {
    const start = base.indexOf(ternary[1], base.indexOf('?'));
    return shapeOfExpr(base.slice(start, start + ternary[1].length), resolveChain);
  }
  if (/^[A-Za-z_]\w*(\s*\.\s*[A-Za-z_]\w*|\[[^\]]*\])*$/.test(base)) {
    return resolveChain(base) ?? unknownShape();
  }
  return unknownShape();
}

// ---------------------------------------------------------------------------
// Member access on ACF data
// ---------------------------------------------------------------------------

export interface MemberProblem {
  offset: number;
  length: number;
  message: string;
}

/** ACF values whose keys listed here are only a sample of what WordPress returns. */
const SAMPLED_TYPES = new Set(['post_object', 'relationship', 'user', 'taxonomy', 'page_link', 'clone', 'unknown']);

/** Shapes from ACF whose keys are fully known, so a missing key is a mistake. */
function hasExactKeys(shape: TypeShape): boolean {
  return shape.acfType !== undefined && !SAMPLED_TYPES.has(shape.acfType);
}

/**
 * Property accesses on ACF-derived values that ACF does not define, e.g.
 * `block.titel` or `block.cards.title` (a repeater is a list).
 * `resolve(chain, offset)` resolves a chain as seen at an offset.
 */
export function checkMemberAccess(
  text: string,
  resolve: (chain: string, offset: number) => TypeShape | undefined
): MemberProblem[] {
  const problems: MemberProblem[] = [];
  // One pass over all Twig code; markup between regions is blank.
  const code = twigCodeOnly(text);
  for (const m of code.matchAll(/(?<![\w.|])[A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)+/g)) {
    const parts = [...m[0].matchAll(/[A-Za-z_]\w*/g)].map((p) => ({
      name: p[0],
      offset: m.index! + p.index!,
    }));
    // A method call at the end is not a property.
    if (/^\s*\(/.test(code.slice(m.index! + m[0].length))) {
      parts.pop();
    }
    let chain = parts[0].name;
    for (const { name, offset } of parts.slice(1)) {
      const shape = resolve(chain, offset);
      if (!shape || !hasExactKeys(shape)) {
        break;
      }
      if (shape.kind === 'array') {
        problems.push({
          offset,
          length: name.length,
          message: `'${chain}' is a list (ACF ${shape.acfType}), so it has no '${name}'. Loop over it with {% for %}.`,
        });
        break;
      }
      if (shape.kind !== 'object' || !shape.keys) {
        break;
      }
      if (!shape.keys.has(name)) {
        const near = closest(name, [...shape.keys.keys()]);
        problems.push({
          offset,
          length: name.length,
          message: `'${chain}' has no field '${name}'.${near ? ` Did you mean '${near}'?` : ''}`,
        });
        break;
      }
      chain += `.${name}`;
    }
  }
  return problems;
}

/** The candidate within edit distance 2 of `name`, if any. */
function closest(name: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let bestDist = 3;
  for (const c of candidates) {
    const d = editDistance(name.toLowerCase(), c.toLowerCase());
    if (d < bestDist) {
      best = c;
      bestDist = d;
    }
  }
  return best;
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

// ---------------------------------------------------------------------------
// Unused structure fields
// ---------------------------------------------------------------------------

/**
 * Structure fields the template body never reads. Top-level fields must be
 * read off the block variable; sub fields anywhere as `.name`.
 */
export function unusedStructureFields(fields: StructField[], body: string, blockVar: string): StructField[] {
  const code = twigCodeOnly(body);
  const unused: StructField[] = [];
  const visit = (list: StructField[], topLevel: boolean) => {
    for (const f of list) {
      const name = escapeRe(f.name);
      const read = topLevel
        ? new RegExp(`\\b${escapeRe(blockVar)}\\s*(?:\\.\\s*${name}\\b|\\[\\s*['"]${name}['"])`).test(code) ||
          new RegExp(`\\[\\s*['"]${name}['"]`).test(body)
        : new RegExp(`\\.\\s*${name}\\b`).test(code) || new RegExp(`\\[\\s*['"]${name}['"]`).test(body);
      if (!read) {
        unused.push(f);
      }
      visit(f.children, false);
    }
  };
  visit(fields, true);
  return unused;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
}
