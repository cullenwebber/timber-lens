// Whole-template Twig scanning: the variables a template reads from its
// context, its include/embed tags with their `with { ... }` hashes, and its
// extends / block structure. Like twigContextParser this is heuristic, not a
// full Twig parser.

/** A variable a template reads from the context it is rendered or included with. */
export interface TemplateVar {
  name: string;
  /** Offset of the first use. */
  offset: number;
  /** Some use tests or defaults it (`|default`, `is empty`, `if x`, ...), so it may be left out. */
  optional: boolean;
  /** Properties read from it, e.g. `url` for `link.url`. */
  members: string[];
}

export interface IncludeEntry {
  key: string;
  keyStart: number;
  /** The value expression, trimmed. */
  value: string;
  /** Offsets of the whole entry, between the separating commas. */
  start: number;
  end: number;
}

export interface IncludeTag {
  path: string;
  /** Offsets of the path text, without quotes. */
  pathStart: number;
  pathEnd: number;
  /** Entries of the `with { ... }` hash, when it is a literal. */
  entries: IncludeEntry[];
  /** `only`: the template sees nothing but the hash. */
  only: boolean;
  /** `include('x.twig')` rather than `{% include 'x.twig' %}`. */
  isFunc: boolean;
  /** Offset of the hash's closing `}`, when there is a literal hash. */
  hashClose?: number;
}

export interface BlockTag {
  name: string;
  /** Offset of the name. */
  offset: number;
}

const KEYWORDS = new Set([
  'and', 'or', 'not', 'in', 'is', 'matches', 'starts', 'ends', 'with', 'b', 'if', 'else', 'elseif',
  'endif', 'for', 'endfor', 'set', 'endset', 'block', 'endblock', 'extends', 'include', 'embed',
  'endembed', 'import', 'from', 'as', 'macro', 'endmacro', 'only', 'ignore', 'missing', 'true',
  'false', 'null', 'none', 'apply', 'endapply', 'verbatim', 'endverbatim', 'autoescape',
  'endautoescape', 'spaceless', 'endspaceless', 'deprecated', 'do', 'flush', 'sandbox',
  'endsandbox', 'use', 'defined', 'empty', 'even', 'odd', 'iterable', 'same', 'divisible', 'by',
  'constant', 'loop', '_self', '_context', '_charset', 'parent', 'TRUE', 'FALSE', 'NULL',
]);

/** Twig code regions (`{{ }}` and `{% %}`) with their inner offsets. */
function codeRegions(text: string): { code: string; start: number; tag: boolean }[] {
  const regions: { code: string; start: number; tag: boolean }[] = [];
  const re = /\{#[\s\S]*?#\}|\{\{-?([\s\S]*?)-?\}\}|\{%-?([\s\S]*?)-?%\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0].startsWith('{#')) {
      continue;
    }
    const inner = m[1] ?? m[2];
    const start = m.index + m[0].indexOf(inner, 2);
    regions.push({ code: blankStrings(inner), start, tag: m[2] !== undefined });
  }
  return regions;
}

/**
 * The text with everything but Twig code (`{{ }}` / `{% %}` contents) blanked
 * out, and string literals inside the code blanked too. Offsets are kept.
 */
export function twigCodeOnly(text: string): string {
  const out = ' '.repeat(text.length).split('');
  for (const { code, start } of codeRegions(text)) {
    for (let i = 0; i < code.length; i++) {
      out[start + i] = code[i];
    }
  }
  return out.join('');
}

/** Replace string literal contents with spaces, keeping offsets and quotes. */
export function blankStrings(code: string): string {
  return code.replace(/(['"])((?:\\.|(?!\1)[^\\])*)\1/g, (_, q: string, body: string) => q + ' '.repeat(body.length) + q);
}

/**
 * Names a template binds itself (loop variables, set, macro arguments,
 * imports), with the offset from which each is bound. A `set` binds after its
 * expression, so `{% set x = x|default(1) %}` still reads `x` from the context.
 */
function localNames(regions: { code: string; start: number; tag: boolean }[]): Map<string, number> {
  const locals = new Map<string, number>();
  const bind = (name: string, at: number) => {
    if (name && !(locals.get(name)! <= at)) {
      locals.set(name, at);
    }
  };
  for (const { code, start, tag } of regions) {
    if (!tag) {
      continue;
    }
    const body = code.trim();
    let m = /^for\s+(\w+)(?:\s*,\s*(\w+))?\s+in\b/.exec(body);
    if (m) {
      bind(m[1], start);
      bind(m[2], start);
      continue;
    }
    m = /^set\s+([\w\s,]+?)(?:=|$)/.exec(body);
    if (m) {
      m[1].split(',').forEach((n) => bind(n.trim(), start + code.length));
      continue;
    }
    m = /^macro\s+(\w+)\s*\(([^)]*)\)/.exec(body);
    if (m) {
      bind(m[1], start);
      m[2].split(',').forEach((a) => bind(a.split('=')[0].trim(), start));
      continue;
    }
    for (const as of body.matchAll(/\bas\s+(\w+)/g)) {
      bind(as[1], start);
    }
    m = /^from\s+\S+\s+import\s+(.+)$/.exec(body);
    if (m) {
      m[1].split(',').forEach((n) => bind(n.trim().split(/\s+/).pop()!, start));
    }
  }
  return locals;
}

/**
 * The variables a template reads from its context, in order of first use.
 * Excludes loop variables, set / macro / import names, functions, filters,
 * tests, hash keys and properties.
 */
export function templateVariables(text: string): TemplateVar[] {
  const regions = codeRegions(text);
  const locals = localNames(regions);
  const vars = new Map<string, TemplateVar>();

  for (const { code, start, tag } of regions) {
    const firstWord = tag ? /^\s*(\w+)/.exec(code)?.[1] : undefined;
    const identRe = /[A-Za-z_]\w*/g;
    let m: RegExpExecArray | null;
    while ((m = identRe.exec(code)) !== null) {
      const name = m[0];
      const before = code.slice(0, m.index);
      const after = code.slice(m.index + name.length);
      const prev = before.trimEnd().slice(-1);
      const next = after.trimStart()[0];

      if (
        KEYWORDS.has(name) ||
        locals.get(name)! <= start + m.index ||
        /\d$/.test(before) ||
        prev === '.' ||
        prev === '|' ||
        next === '(' ||
        (next === ':' && (prev === '{' || prev === ',')) ||
        /\bis\s+(?:not\s+)?$/.test(before) ||
        (tag && name === firstWord && m.index === code.indexOf(name)) ||
        // The names being assigned in `{% set a, b = ... %}`.
        (tag && firstWord === 'set' && (code.indexOf('=') === -1 || m.index < code.indexOf('=')))
      ) {
        continue;
      }

      // Tested or defaulted rather than assumed to exist.
      const optional =
        /^\s*(?:\|\s*default\b|is\s+(?:not\s+)?(?:defined|empty|null|none)\b|\?\?)/.test(after) ||
        (tag && /\b(?:if|elseif|not|and|or)\s*\(?\s*$/.test(before));
      const member = /^\s*\.\s*([A-Za-z_]\w*)/.exec(after)?.[1];

      let v = vars.get(name);
      if (!v) {
        v = { name, offset: start + m.index, optional: false, members: [] };
        vars.set(name, v);
      }
      v.optional ||= optional;
      if (member && !v.members.includes(member)) {
        v.members.push(member);
      }
    }
  }
  return [...vars.values()];
}

// ---------------------------------------------------------------------------
// include / embed tags
// ---------------------------------------------------------------------------

const INCLUDE_RE = /\{%-?\s*(?:include|embed)\s+(['"])([^'"]+)\1|\binclude\s*\(\s*(['"])([^'"]+)\3/g;

/** Every include / embed (tag or function form) with a static path. */
export function parseIncludes(text: string): IncludeTag[] {
  const tags: IncludeTag[] = [];
  const blanked = blankStrings(text);
  INCLUDE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INCLUDE_RE.exec(text)) !== null) {
    const isFunc = m[2] === undefined;
    const path = isFunc ? m[4] : m[2];
    const pathStart = m.index + m[0].lastIndexOf(path);
    const pathEnd = pathStart + path.length;
    let i = pathEnd + 1;
    // 'blocks/' ~ name ~ '.twig' is dynamic, not a path.
    if (/^\s*~/.test(text.slice(i))) {
      continue;
    }

    // The hash follows `with` in the tag form, or `,` in the function form.
    const rest = blanked.slice(i);
    const lead = isFunc ? /^\s*,\s*\{/.exec(rest) : /^\s*with\s*\{/.exec(rest);
    let entries: IncludeEntry[] = [];
    let hashClose: number | undefined;
    if (lead) {
      const open = i + lead[0].length - 1;
      const close = matchBrace(blanked, open);
      entries = hashEntries(text, blanked, open + 1, close === -1 ? text.length : close);
      hashClose = close === -1 ? undefined : close;
      i = close === -1 ? text.length : close + 1;
    }
    const end = isFunc ? blanked.indexOf(')', i) : blanked.indexOf('%}', i);
    const tail = blanked.slice(i, end === -1 ? undefined : end);
    tags.push({ path, pathStart, pathEnd, entries, only: /\bonly\b/.test(tail), isFunc, hashClose });
  }
  return tags;
}

/** Index of the `}` matching the `{` at `open` in string-blanked text, or -1. */
/** Offsets to delete to drop entry `i` of an include hash, with one comma beside it. */
export function entryRemovalRange(text: string, tag: IncludeTag, i: number): [number, number] {
  const entry = tag.entries[i];
  const trimmedEnd = entry.start + text.slice(entry.start, entry.end).trimEnd().length;
  if (i < tag.entries.length - 1) {
    return [entry.start, entry.end + 1];
  }
  return i > 0 ? [tag.entries[i - 1].end, trimmedEnd] : [entry.start, trimmedEnd];
}

/** The insertion that passes `names` to an include under their own names. */
export function passThroughInsert(text: string, tag: IncludeTag, names: string[]): { at: number; text: string } {
  const pairs = names.map((n) => `${n}: ${n}`).join(', ');
  const last = tag.entries[tag.entries.length - 1];
  if (last) {
    return { at: last.start + text.slice(last.start, last.end).trimEnd().length, text: `, ${pairs}` };
  }
  if (tag.hashClose !== undefined) {
    return { at: tag.hashClose, text: ` ${pairs} ` };
  }
  // Right after the path's closing quote.
  return { at: tag.pathEnd + 1, text: tag.isFunc ? `, { ${pairs} }` : ` with { ${pairs} }` };
}

function matchBrace(blanked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < blanked.length; i++) {
    const ch = blanked[i];
    if (ch === '{' || ch === '[' || ch === '(') {
      depth++;
    } else if (ch === '}' || ch === ']' || ch === ')') {
      depth--;
      if (depth === 0) {
        return ch === '}' ? i : -1;
      }
    } else if (ch === '%' && blanked[i + 1] === '}') {
      return -1;
    }
  }
  return -1;
}

/** Top-level `key: value` entries between `start` and `end`. */
function hashEntries(text: string, blanked: string, start: number, end: number): IncludeEntry[] {
  const entries: IncludeEntry[] = [];
  let depth = 0;
  let partStart = start;
  const flush = (partEnd: number) => {
    const part = text.slice(partStart, partEnd);
    const key = /^\s*(['"]?)([\w-]+)\1\s*:/.exec(part);
    if (key) {
      const keyStart = partStart + part.indexOf(key[2]);
      entries.push({
        key: key[2],
        keyStart,
        value: text.slice(partStart + key[0].length, partEnd).trim(),
        start: partStart,
        end: partEnd,
      });
    }
    partStart = partEnd + 1;
  };
  for (let i = start; i < end; i++) {
    const ch = blanked[i];
    if (ch === '{' || ch === '[' || ch === '(') {
      depth++;
    } else if (ch === '}' || ch === ']' || ch === ')') {
      depth--;
    } else if (ch === ',' && depth === 0) {
      flush(i);
    }
  }
  flush(end);
  return entries;
}

/** Cursor at a key position inside an include's `with { ... }` hash. */
export interface IncludeHashCursor {
  path: string;
  /** Partial key typed at the cursor. */
  prefix: string;
  /** Keys already in the hash. */
  keys: string[];
}

/** Classify `offset` as a key position inside an include hash, if it is one. */
export function includeHashAt(text: string, offset: number): IncludeHashCursor | undefined {
  const tagStart = text.lastIndexOf('{%', offset);
  const funcStart = text.lastIndexOf('include(', offset);
  const start = Math.max(tagStart, funcStart);
  if (start === -1 || text.slice(start, offset).includes('%}')) {
    return undefined;
  }
  const blanked = blankStrings(text.slice(start, offset));
  const head = /^(?:\{%-?\s*(?:include|embed)\s+(['"])([^'"]+)\1\s*with\s*\{|include\(\s*(['"])([^'"]+)\3\s*,\s*\{)/.exec(
    text.slice(start, offset)
  );
  if (!head) {
    return undefined;
  }
  // Depth 0 inside the hash, and only a partial key since the last comma.
  let depth = 0;
  let partStart = head[0].length;
  for (let i = head[0].length; i < blanked.length; i++) {
    const ch = blanked[i];
    if (ch === '{' || ch === '[' || ch === '(') {
      depth++;
    } else if (ch === '}' || ch === ']' || ch === ')') {
      if (--depth < 0) {
        return undefined;
      }
    } else if (ch === ',' && depth === 0) {
      partStart = i + 1;
    }
  }
  const part = /^\s*([\w-]*)$/.exec(blanked.slice(partStart));
  if (depth !== 0 || !part) {
    return undefined;
  }
  const path = head[2] ?? head[4];
  const tag = parseIncludes(text).find((t) => t.pathStart > start && t.pathStart < offset && t.path === path);
  const keys = (tag?.entries ?? []).map((e) => e.key).filter((k) => k !== part[1]);
  return { path, prefix: part[1], keys };
}

// ---------------------------------------------------------------------------
// extends / block
// ---------------------------------------------------------------------------

/** The static parent template path of `{% extends '...' %}`, if any. */
export function extendsPath(text: string): string | undefined {
  return /\{%-?\s*extends\s+(['"])([^'"]+)\1/.exec(text)?.[2];
}

/** Every `{% block name %}` in the template. */
export function blockTags(text: string): BlockTag[] {
  const tags: BlockTag[] = [];
  for (const m of text.matchAll(/\{%-?\s*block\s+(\w+)/g)) {
    tags.push({ name: m[1], offset: m.index! + m[0].length - m[1].length });
  }
  return tags;
}

/** Partial block name typed at `offset` in `{% block |`. */
export function blockNameAt(text: string, offset: number): string | undefined {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  return /\{%-?\s*block\s+(\w*)$/.exec(text.slice(lineStart, offset))?.[1];
}
