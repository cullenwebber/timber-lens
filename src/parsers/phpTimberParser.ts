// Pragmatic, heuristic PHP parser for Timber render context.
//
// We do NOT implement a real PHP parser. We use a small bracket/string-aware
// scanner to extract just enough structure: array literals, get_field() calls,
// $context['key'] = ... assignments, array_merge(Timber::context(), [...]) and
// Timber::render()/compile() calls.

export type PhpValue =
  | { kind: 'array'; entries: PhpEntry[] }
  | { kind: 'getField'; field: string }
  | { kind: 'string' }
  | { kind: 'number' }
  | { kind: 'bool' }
  | { kind: 'var'; name: string }
  | { kind: 'call'; name: string }
  | { kind: 'unknown' };

export interface PhpEntry {
  key: string;
  value: PhpValue;
}

export interface PhpTemplateContext {
  templatePath: string;
  vars: Map<string, PhpValue>;
}

/**
 * Parse one PHP file and return the Timber render contexts it defines.
 */
export function parsePhpFile(src: string): PhpTemplateContext[] {
  const stripped = stripComments(src);

  // 1. Collect variable assignments that build context-like arrays, plus
  //    arrays of template candidates ($templates = ['a.twig', 'b.twig']).
  const varEntries = collectVarEntries(stripped);
  const varArrays = collectVarArrays(stripped);

  // 2. Find Timber::render / Timber::compile calls and resolve their context arg.
  const results: PhpTemplateContext[] = [];
  const callRe = /Timber::\s*(?:render|compile)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(stripped)) !== null) {
    const openParen = m.index + m[0].length - 1;
    const args = splitArgs(stripped, openParen);
    if (args.length === 0) {
      continue;
    }
    // The first arg may be a string, an array of candidate templates, or a
    // variable holding such an array. Each resolved path shares the context.
    const templatePaths = templatePathsFromArg(args[0].trim(), varArrays);
    if (templatePaths.length === 0) {
      continue;
    }
    const vars = new Map<string, PhpValue>();
    if (args.length >= 2) {
      mergeContextArg(args[1].trim(), varEntries, vars);
    }
    for (const templatePath of templatePaths) {
      results.push({ templatePath, vars });
    }
  }

  return results;
}

/**
 * Resolve the first argument of a render call into one or more template paths.
 * Handles a string literal, an inline array / array() of literals, and a
 * `$var` that was assigned such an array. Interpolated strings (containing `$`)
 * are skipped because they are not statically resolvable.
 */
function templatePathsFromArg(
  arg: string,
  varArrays: Map<string, string[]>
): string[] {
  const single = readStringLiteral(arg);
  if (single !== undefined) {
    return single.includes('$') ? [] : [single];
  }
  if (arg.startsWith('[') || /^array\s*\(/.test(arg)) {
    return collectStringLiterals(arg);
  }
  const varMatch = arg.match(/^\$(\w+)$/);
  if (varMatch) {
    return varArrays.get(varMatch[1]) ?? [];
  }
  return [];
}

/** Collect `$var = [...]` / `array(...)` assignments holding .twig literals. */
function collectVarArrays(src: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const re = /\$(\w+)\s*=\s*(?=\[|array\s*\()/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const valueStart = m.index + m[0].length;
    const raw = readUntilStatementEnd(src, valueStart);
    if (raw === undefined) {
      continue;
    }
    const paths = collectStringLiterals(raw);
    if (paths.length > 0) {
      map.set(m[1], paths);
    }
  }
  return map;
}

/** All static .twig string literals within a snippet (skips interpolated). */
function collectStringLiterals(text: string): string[] {
  const out: string[] = [];
  const re = /(['"])((?:\\.|(?!\1).)*)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const value = m[2];
    if (!value.includes('$') && value.endsWith('.twig')) {
      out.push(value);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Variable assignment collection
// ---------------------------------------------------------------------------

function collectVarEntries(src: string): Map<string, Map<string, PhpValue>> {
  const vars = new Map<string, Map<string, PhpValue>>();
  const getBucket = (name: string) => {
    let bucket = vars.get(name);
    if (!bucket) {
      bucket = new Map();
      vars.set(name, bucket);
    }
    return bucket;
  };

  // $var['key'] = <value>;
  const keyAssignRe = /\$(\w+)\s*\[\s*['"]([^'"]+)['"]\s*\]\s*=\s*/g;
  let m: RegExpExecArray | null;
  while ((m = keyAssignRe.exec(src)) !== null) {
    const varName = m[1];
    const key = m[2];
    const valueStart = m.index + m[0].length;
    const valueRaw = readUntilStatementEnd(src, valueStart);
    if (valueRaw !== undefined) {
      getBucket(varName).set(key, parseValue(valueRaw.trim()));
    }
  }

  // $var = <expr>;  (whole-array or array_merge assignments)
  const wholeAssignRe = /\$(\w+)\s*=\s*(?!=)/g;
  while ((m = wholeAssignRe.exec(src)) !== null) {
    // Skip if this is actually a $var['key'] = (already handled, has '[' next).
    const after = src.slice(m.index + m[1].length + 1).match(/^\s*\[/);
    if (after) {
      continue;
    }
    const valueStart = m.index + m[0].length;
    const valueRaw = readUntilStatementEnd(src, valueStart);
    if (valueRaw === undefined) {
      continue;
    }
    const entries = entriesFromContextExpr(valueRaw.trim());
    if (entries) {
      const bucket = getBucket(m[1]);
      for (const e of entries) {
        bucket.set(e.key, e.value);
      }
    }
  }

  return vars;
}

/**
 * Resolve the second argument of a render call into concrete variables.
 * Handles inline arrays, array_merge(Timber::context(), [...]), and plain $vars.
 */
function mergeContextArg(
  arg: string,
  varEntries: Map<string, Map<string, PhpValue>>,
  out: Map<string, PhpValue>
): void {
  const varMatch = arg.match(/^\$(\w+)$/);
  if (varMatch) {
    const bucket = varEntries.get(varMatch[1]);
    bucket?.forEach((v, k) => out.set(k, v));
    return;
  }
  const entries = entriesFromContextExpr(arg);
  if (entries) {
    for (const e of entries) {
      out.set(e.key, e.value);
    }
  }
}

/**
 * Given an expression that is expected to produce a context array, return its
 * top-level string-keyed entries. Supports `[ ... ]`, `array( ... )` and
 * `array_merge(Timber::context(), [ ... ])`.
 */
function entriesFromContextExpr(expr: string): PhpEntry[] | undefined {
  const trimmed = expr.trim();

  if (/^array_merge\s*\(/.test(trimmed)) {
    const open = trimmed.indexOf('(');
    const args = splitArgs(trimmed, open);
    // Use the entries from any array-literal argument(s).
    const entries: PhpEntry[] = [];
    for (const a of args) {
      const v = parseValue(a.trim());
      if (v.kind === 'array') {
        entries.push(...v.entries);
      }
    }
    return entries;
  }

  const value = parseValue(trimmed);
  return value.kind === 'array' ? value.entries : undefined;
}

// ---------------------------------------------------------------------------
// Value parsing
// ---------------------------------------------------------------------------

export function parseValue(raw: string): PhpValue {
  const expr = raw.trim();

  if (expr.startsWith('[')) {
    return parseArrayLiteral(expr, 0, '[', ']');
  }
  if (/^array\s*\(/.test(expr)) {
    const open = expr.indexOf('(');
    return parseArrayLiteral(expr, open, '(', ')');
  }
  const getField = expr.match(/^get_field\s*\(\s*['"]([^'"]+)['"]/);
  if (getField) {
    return { kind: 'getField', field: getField[1] };
  }
  if (/^['"]/.test(expr)) {
    return { kind: 'string' };
  }
  if (/^-?\d/.test(expr)) {
    return { kind: 'number' };
  }
  if (/^(true|false)\b/i.test(expr)) {
    return { kind: 'bool' };
  }
  const varMatch = expr.match(/^\$(\w+)$/);
  if (varMatch) {
    return { kind: 'var', name: varMatch[1] };
  }
  const callMatch = expr.match(/^([\w:]+)\s*\(/);
  if (callMatch) {
    return { kind: 'call', name: callMatch[1] };
  }
  return { kind: 'unknown' };
}

function parseArrayLiteral(
  src: string,
  openIndex: number,
  open: string,
  close: string
): PhpValue {
  const content = extractBracketContent(src, openIndex, open, close);
  if (content === undefined) {
    return { kind: 'array', entries: [] };
  }
  const entries: PhpEntry[] = [];
  for (const element of splitTopLevel(content, ',')) {
    const trimmed = element.trim();
    if (!trimmed) {
      continue;
    }
    const arrow = findTopLevel(trimmed, '=>');
    if (arrow === -1) {
      continue; // list-style entries have no key we can name
    }
    const keyRaw = trimmed.slice(0, arrow).trim();
    const valueRaw = trimmed.slice(arrow + 2).trim();
    const key = readStringLiteral(keyRaw);
    if (key === undefined) {
      continue; // non-string keys are ignored
    }
    entries.push({ key, value: parseValue(valueRaw) });
  }
  return { kind: 'array', entries };
}

// ---------------------------------------------------------------------------
// Low-level scanning helpers
// ---------------------------------------------------------------------------

/** Read a single/double quoted string literal value, or undefined. */
function readStringLiteral(raw: string): string | undefined {
  const m = raw.match(/^\s*(['"])((?:\\.|(?!\1).)*)\1\s*$/);
  return m ? m[2] : undefined;
}

/**
 * Starting at `openIndex` (the position of the open bracket), return the text
 * between the matching brackets, respecting nesting and string literals.
 */
function extractBracketContent(
  src: string,
  openIndex: number,
  open: string,
  close: string
): string | undefined {
  let depth = 0;
  let inString: string | null = null;
  for (let i = openIndex; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      if (ch === '\\') {
        i++;
      } else if (ch === inString) {
        inString = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      inString = ch;
    } else if (ch === open || ch === '[' || ch === '(') {
      depth++;
    } else if (ch === close || ch === ']' || ch === ')') {
      depth--;
      if (depth === 0) {
        return src.slice(openIndex + 1, i);
      }
    }
  }
  return undefined;
}

/** Split arguments of a call. `openParen` points at the '(' of the call. */
function splitArgs(src: string, openParen: number): string[] {
  const content = extractBracketContent(src, openParen, '(', ')');
  if (content === undefined) {
    return [];
  }
  return splitTopLevel(content, ',').map((s) => s.trim());
}

/** Split `text` on a single-character or two-character delimiter at depth 0. */
function splitTopLevel(text: string, delim: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') {
        i++;
      } else if (ch === inString) {
        inString = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      inString = ch;
    } else if (ch === '[' || ch === '(' || ch === '{') {
      depth++;
    } else if (ch === ']' || ch === ')' || ch === '}') {
      depth--;
    } else if (depth === 0 && text.startsWith(delim, i)) {
      parts.push(text.slice(start, i));
      start = i + delim.length;
      i += delim.length - 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** Find a two-character token at depth 0, or -1. */
function findTopLevel(text: string, token: string): number {
  let depth = 0;
  let inString: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') {
        i++;
      } else if (ch === inString) {
        inString = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      inString = ch;
    } else if (ch === '[' || ch === '(' || ch === '{') {
      depth++;
    } else if (ch === ']' || ch === ')' || ch === '}') {
      depth--;
    } else if (depth === 0 && text.startsWith(token, i)) {
      return i;
    }
  }
  return -1;
}

/** Read an expression from `start` up to the terminating ';' at depth 0. */
function readUntilStatementEnd(src: string, start: number): string | undefined {
  let depth = 0;
  let inString: string | null = null;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      if (ch === '\\') {
        i++;
      } else if (ch === inString) {
        inString = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      inString = ch;
    } else if (ch === '[' || ch === '(' || ch === '{') {
      depth++;
    } else if (ch === ']' || ch === ')' || ch === '}') {
      depth--;
    } else if (ch === ';' && depth === 0) {
      return src.slice(start, i);
    }
  }
  return undefined;
}

/** Remove // line comments, # line comments and block comments. */
function stripComments(src: string): string {
  let out = '';
  let inString: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i++;
      } else if (ch === inString) {
        inString = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      inString = ch;
      out += ch;
    } else if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') {
        i++;
      }
      out += '\n';
    } else if (ch === '#') {
      while (i < src.length && src[i] !== '\n') {
        i++;
      }
      out += '\n';
    } else if (ch === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        i++;
      }
      i++; // skip the '/'
      out += ' ';
    } else {
      out += ch;
    }
  }
  return out;
}
