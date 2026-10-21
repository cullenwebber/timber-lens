// Theme PHP that extends Twig: custom functions and filters registered through
// Timber's `timber/twig/functions` / `timber/twig/filters` hooks or Twig's
// TwigFunction / TwigFilter classes, and variables added to every template
// through `timber/context`.

import { PhpValue, parseValue, readUntilStatementEnd, stripComments } from './phpTimberParser';

export interface TwigCallable {
  name: string;
  kind: 'function' | 'filter';
  /** PHP parameter list, e.g. "$content, $count = 2". */
  params?: string;
  /** Docblock summary of the implementing function, if any. */
  doc?: string;
  /** 0-based line of the implementation (or the registration when not found). */
  line: number;
}

/** Custom Twig functions and filters a PHP file registers. */
export function parseTwigExtensions(src: string): TwigCallable[] {
  if (!/timber\/twig|TwigFunction|TwigFilter/.test(src)) {
    return [];
  }
  const code = stripComments(src);
  const found: TwigCallable[] = [];
  const add = (name: string, kind: TwigCallable['kind'], callable: string, at: number) => {
    if (found.some((c) => c.name === name && c.kind === kind)) {
      return;
    }
    found.push({ name, kind, ...implementation(src, callable, name, at) });
  };

  // new TwigFunction('name', callable) / new TwigFilter('name', callable)
  for (const m of code.matchAll(/new\s+\\?(?:Twig\\)?Twig(Function|Filter)\s*\(\s*['"]([\w]+)['"]\s*(?:,\s*)?/g)) {
    const rest = readUntilStatementEnd(code, m.index! + m[0].length) ?? '';
    add(m[2], m[1] === 'Filter' ? 'filter' : 'function', rest, m.index!);
  }

  // $functions['name'] = ['callable' => ...] / $filters['name'] = [...]
  for (const m of code.matchAll(/\$(\w+)\s*\[\s*['"](\w+)['"]\s*\]\s*=\s*\[\s*['"]callable['"]\s*=>/g)) {
    const rest = readArrayValue(code, m.index! + m[0].length);
    add(m[2], hookKind(code, m.index!, m[1]), rest, m.index!);
  }

  // $names = ['a', 'b']; foreach ($names as $n) { $functions[$n] = ['callable' => [$this, $n]]; }
  for (const m of code.matchAll(/foreach\s*\(\s*\$(\w+)\s+as\s+\$(\w+)\s*\)\s*\{\s*\$(\w+)\s*\[\s*\$\2\s*\]\s*=\s*\[\s*['"]callable['"]\s*=>/g)) {
    const list = new RegExp(`\\$${m[1]}\\s*=\\s*\\[([^\\]]*)\\]`).exec(code);
    const kind = hookKind(code, m.index!, m[3]);
    for (const name of list?.[1].matchAll(/['"](\w+)['"]/g) ?? []) {
      add(name[1], kind, `[$this, '${name[1]}']`, m.index!);
    }
  }
  return found;
}

/** An array element's value from `start`, up to the `,` or `]` that ends it. */
function readArrayValue(code: string, start: number): string {
  let depth = 0;
  let inString: string | null = null;
  for (let i = start; i < code.length; i++) {
    const ch = code[i];
    if (inString) {
      if (ch === '\\') {
        i++;
      } else if (ch === inString) {
        inString = null;
      }
    } else if (ch === "'" || ch === '"') {
      inString = ch;
    } else if (ch === '[' || ch === '(' || ch === '{') {
      depth++;
    } else if (ch === ']' || ch === ')' || ch === '}') {
      if (--depth < 0) {
        return code.slice(start, i);
      }
    } else if (ch === ',' && depth === 0) {
      return code.slice(start, i);
    }
  }
  return code.slice(start);
}

/** Function or filter, from the array's name or the nearest hook before it. */
function hookKind(code: string, at: number, varName: string): TwigCallable['kind'] {
  if (/filter/i.test(varName)) {
    return 'filter';
  }
  if (/function/i.test(varName)) {
    return 'function';
  }
  const before = code.slice(0, at);
  return before.lastIndexOf('timber/twig/filters') > before.lastIndexOf('timber/twig/functions') ? 'filter' : 'function';
}

/** Parameters, docblock and line of the PHP function behind a callable. */
function implementation(
  src: string,
  callable: string,
  name: string,
  registeredAt: number
): Omit<TwigCallable, 'name' | 'kind'> {
  const closure = /^\s*(?:static\s+)?(?:function|fn)\s*\(([^)]*)\)/.exec(callable);
  if (closure) {
    return { params: tidyParams(closure[1]), line: lineOf(src, registeredAt) };
  }
  const method = /\[\s*\$this\s*,\s*['"](\w+)['"]\s*\]/.exec(callable)?.[1] ?? /^\s*['"](\w+)['"]/.exec(callable)?.[1] ?? name;
  const def = new RegExp(`function\\s+&?${method}\\s*\\(([^)]*)\\)`).exec(src);
  if (!def) {
    return { line: lineOf(src, registeredAt) };
  }
  return { params: tidyParams(def[1]), doc: docblockBefore(src, def.index), line: lineOf(src, def.index) };
}

/** Drop type hints: "?string $a = null, int $b" -> "$a = null, $b". */
function tidyParams(params: string): string {
  return params
    .split(',')
    .map((p) => p.trim().replace(/^[\w\\?|]+\s+(?=[&.]*\$)/, ''))
    .filter(Boolean)
    .join(', ');
}

/** First paragraph of the docblock directly above `at`, if there is one. */
function docblockBefore(src: string, at: number): string | undefined {
  const before = src.slice(0, at).replace(/(?:public|private|protected|static|final|\s)*$/, '');
  if (!before.endsWith('*/')) {
    return undefined;
  }
  const start = before.lastIndexOf('/**');
  if (start === -1) {
    return undefined;
  }
  const text = before
    .slice(start + 3, -2)
    .split('\n')
    .map((l) => l.replace(/^\s*\*\s?/, ''))
    .join('\n')
    .split(/\n\s*\n|\n@/)[0]
    .trim();
  return text || undefined;
}

function lineOf(src: string, offset: number): number {
  return src.slice(0, offset).split('\n').length - 1;
}

// ---------------------------------------------------------------------------
// timber/context
// ---------------------------------------------------------------------------

export interface GlobalContextVar {
  value: PhpValue;
  /** 0-based line of the assignment. */
  line: number;
}

/**
 * Variables a `timber/context` filter adds to every template:
 * `$context['key'] = value;` inside the hooked function.
 */
export function parseGlobalContext(src: string): Map<string, GlobalContextVar> {
  const vars = new Map<string, GlobalContextVar>();
  if (!src.includes('timber/context')) {
    return vars;
  }
  const code = stripComments(src);
  // The hooked callable's first parameter is the context array.
  const hook = /add_filter\s*\(\s*['"]timber\/context['"]\s*,\s*(.+?)\)\s*;/.exec(code);
  const method = hook && (/['"](\w+)['"]\s*\]?\s*$/.exec(hook[1])?.[1]);
  const fn = method
    ? new RegExp(`function\\s+${method}\\s*\\(\\s*(?:[\\w\\\\?]+\\s+)?\\$(\\w+)`).exec(code)
    : /function\s*\(\s*(?:[\w\\?]+\s+)?\$(\w+)/.exec(code.slice(hook?.index ?? 0));
  const param = fn?.[1] ?? 'context';

  const re = new RegExp(`\\$${param}\\s*\\[\\s*['"]([\\w-]+)['"]\\s*\\]\\s*=\\s*`, 'g');
  for (const m of code.matchAll(re)) {
    const raw = readUntilStatementEnd(code, m.index! + m[0].length);
    if (raw !== undefined && !vars.has(m[1])) {
      vars.set(m[1], { value: parseValue(raw), line: lineOf(code, m.index!) });
    }
  }
  return vars;
}
