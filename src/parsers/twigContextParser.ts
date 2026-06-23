// Lightweight Twig "cursor context" detection. We do not parse Twig fully; we
// only look at the text immediately before the cursor (plus the whole document
// for loop scoping) to decide what kind of completion / hover is appropriate.

export type CursorKind = 'path' | 'meta' | 'member' | 'root' | 'none';

/**
 * Returns true when the cursor is inside a Twig expression `{{ ... }}` or a
 * Twig statement `{% ... %}`. We look backwards for the nearest opening
 * delimiter without an intervening closing delimiter.
 */
export function isInsideTwig(textBeforeCursor: string): boolean {
  const lastOpen = Math.max(
    textBeforeCursor.lastIndexOf('{{'),
    textBeforeCursor.lastIndexOf('{%')
  );
  if (lastOpen === -1) {
    return false;
  }
  const afterOpen = textBeforeCursor.slice(lastOpen + 2);
  return !afterOpen.includes('}}') && !afterOpen.includes('%}');
}

export interface CursorContext {
  kind: CursorKind;
  /** include/extends/embed/import path prefix being typed. */
  pathPrefix?: string;
  /** Tag that introduced the path (include, extends, ...). */
  pathTag?: string;
  /** Partial field name being typed inside post.meta('...'). */
  metaPrefix?: string;
  /** Resolved base expression text for member access (e.g. "post.services"). */
  baseExpr?: string;
  /** Partial member identifier after the trailing dot. */
  memberPrefix?: string;
  /** Partial root identifier being typed. */
  rootPrefix?: string;
}

const PATH_TAG_RE = /\{%-?\s*(include|extends|embed|import|from)\s+(['"])([^'"]*)$/;
const PATH_FUNC_RE = /\binclude\s*\(\s*(['"])([^'"]*)$/;
const META_OPEN_RE = /\.meta\(\s*(['"])([^'"]*)$/;
// base chain ending in a dot, optionally followed by a partial member.
const MEMBER_RE =
  /([A-Za-z_]\w*(?:\s*\.\s*(?:[A-Za-z_]\w*|meta\(\s*['"][^'"]*['"]\s*\))|\s*\[\s*['"][^'"]*['"]\s*\]|\s*\[\s*\d+\s*\])*)\s*\.\s*([A-Za-z_]\w*)?$/;
const ROOT_RE = /(^|[^\w.])([A-Za-z_]\w*)?$/;

/**
 * Inspect the text before the cursor and classify what should be completed.
 */
export function detectCursorContext(textBeforeCursor: string): CursorContext {
  const lineStart = textBeforeCursor.lastIndexOf('\n') + 1;
  const linePrefix = textBeforeCursor.slice(lineStart);

  // 1. Template path strings (works regardless of {{ }} since tags use {% %}).
  const tagPath = linePrefix.match(PATH_TAG_RE);
  if (tagPath) {
    return { kind: 'path', pathPrefix: tagPath[3], pathTag: tagPath[1] };
  }
  const funcPath = linePrefix.match(PATH_FUNC_RE);
  if (funcPath) {
    return { kind: 'path', pathPrefix: funcPath[2], pathTag: 'include' };
  }

  // Everything below requires being inside a Twig expression / statement.
  if (!isInsideTwig(textBeforeCursor)) {
    return { kind: 'none' };
  }

  // 2. post.meta(' open string -> ACF field name completion.
  const metaOpen = linePrefix.match(META_OPEN_RE);
  if (metaOpen) {
    return { kind: 'meta', metaPrefix: metaOpen[2] };
  }

  // 3. Member access chain ending in a dot.
  const member = linePrefix.match(MEMBER_RE);
  if (member) {
    return {
      kind: 'member',
      baseExpr: member[1].replace(/\s+/g, ''),
      memberPrefix: member[2] ?? '',
    };
  }

  // 4. Bare root identifier.
  const root = linePrefix.match(ROOT_RE);
  if (root) {
    return { kind: 'root', rootPrefix: root[2] ?? '' };
  }

  return { kind: 'none' };
}

// ---------------------------------------------------------------------------
// Access-chain tokenization
// ---------------------------------------------------------------------------

export type ChainSegment =
  | { type: 'root'; name: string }
  | { type: 'prop'; name: string }
  | { type: 'meta'; name: string }
  | { type: 'index' };

/**
 * Tokenize an expression like `post.meta('page_builder')[0].title` into chain
 * segments. Returns null if the expression does not start with an identifier.
 */
export function tokenizeChain(expr: string): ChainSegment[] | null {
  const text = expr.trim();
  let i = 0;
  const segs: ChainSegment[] = [];

  const ident = /^[A-Za-z_]\w*/;
  const rootMatch = text.slice(i).match(ident);
  if (!rootMatch) {
    return null;
  }
  segs.push({ type: 'root', name: rootMatch[0] });
  i += rootMatch[0].length;

  while (i < text.length) {
    // skip whitespace
    while (i < text.length && /\s/.test(text[i])) {
      i++;
    }
    if (text[i] === '.') {
      i++;
      while (i < text.length && /\s/.test(text[i])) {
        i++;
      }
      const metaMatch = text.slice(i).match(/^meta\(\s*['"]([^'"]*)['"]\s*\)/);
      if (metaMatch) {
        segs.push({ type: 'meta', name: metaMatch[1] });
        i += metaMatch[0].length;
        continue;
      }
      const propMatch = text.slice(i).match(ident);
      if (propMatch) {
        segs.push({ type: 'prop', name: propMatch[0] });
        i += propMatch[0].length;
        continue;
      }
      break;
    } else if (text[i] === '[') {
      const strKey = text.slice(i).match(/^\[\s*['"]([^'"]*)['"]\s*\]/);
      if (strKey) {
        segs.push({ type: 'prop', name: strKey[1] });
        i += strKey[0].length;
        continue;
      }
      const idxKey = text.slice(i).match(/^\[\s*\d+\s*\]/);
      if (idxKey) {
        segs.push({ type: 'index' });
        i += idxKey[0].length;
        continue;
      }
      break;
    } else {
      break;
    }
  }

  return segs;
}

// ---------------------------------------------------------------------------
// Loop scope discovery
// ---------------------------------------------------------------------------

export interface LoopScope {
  /** Loop variable name (the `x` in `{% for x in expr %}`). */
  varName: string;
  /** The iterable expression (`post.services.service`). */
  iterableExpr: string;
  /** Character offset where the loop body begins. */
  bodyStart: number;
  /** Character offset where the loop body ends (matching endfor), or doc end. */
  bodyEnd: number;
}

const FOR_RE = /\{%-?\s*for\s+([A-Za-z_]\w*)(?:\s*,\s*[A-Za-z_]\w*)?\s+in\s+(.+?)\s*-?%\}/g;
const ENDFOR_RE = /\{%-?\s*endfor\s*-?%\}/g;

/**
 * Find every `{% for %}` block in the document and return the loops whose body
 * contains the given offset, innermost last.
 */
export function findEnclosingLoops(text: string, offset: number): LoopScope[] {
  const fors: { start: number; bodyStart: number; varName: string; iterableExpr: string }[] = [];
  let m: RegExpExecArray | null;
  FOR_RE.lastIndex = 0;
  while ((m = FOR_RE.exec(text)) !== null) {
    fors.push({
      start: m.index,
      bodyStart: m.index + m[0].length,
      varName: m[1],
      iterableExpr: m[2].trim(),
    });
  }

  const endfors: number[] = [];
  ENDFOR_RE.lastIndex = 0;
  while ((m = ENDFOR_RE.exec(text)) !== null) {
    endfors.push(m.index);
  }

  // Match fors to endfors with a stack, in document order.
  const tokens = [
    ...fors.map((f) => ({ kind: 'for' as const, pos: f.start, data: f })),
    ...endfors.map((e) => ({ kind: 'end' as const, pos: e })),
  ].sort((a, b) => a.pos - b.pos);

  const stack: typeof fors = [];
  const scopes: LoopScope[] = [];
  for (const tok of tokens) {
    if (tok.kind === 'for') {
      stack.push(tok.data);
    } else {
      const open = stack.pop();
      if (open) {
        scopes.push({
          varName: open.varName,
          iterableExpr: open.iterableExpr,
          bodyStart: open.bodyStart,
          bodyEnd: tok.pos,
        });
      }
    }
  }
  // Any unclosed loops extend to end of document.
  for (const open of stack) {
    scopes.push({
      varName: open.varName,
      iterableExpr: open.iterableExpr,
      bodyStart: open.bodyStart,
      bodyEnd: text.length,
    });
  }

  return scopes
    .filter((s) => offset >= s.bodyStart && offset <= s.bodyEnd)
    .sort((a, b) => a.bodyStart - b.bodyStart);
}
