// Rewriting template paths in Twig and PHP when templates or folders move.
// VS Code-free: the participant in providers/ supplies texts and applies edits.

import { canonicalIncludePath, computeRelPaths, toPosix } from '../utils/paths';

/** A string literal that names a template, or a folder of them. */
export interface PathLiteral {
  value: string;
  /** Offsets of the value, without quotes. */
  start: number;
  end: number;
}

/** A moved file or folder, as absolute paths. */
export interface Move {
  from: string;
  to: string;
}

export interface TextEdit {
  start: number;
  end: number;
  newText: string;
}

const STRING_RE = /(['"])([^'"\n\\$]*)\1/g;

/**
 * String literals in Twig code (`{{ }}` / `{% %}`) or PHP that end in `.twig`,
 * or end in `/` and are concatenated (`'blocks/' ~ name`), the folder part of
 * a dynamic path.
 */
export function pathLiterals(text: string, lang: 'twig' | 'php'): PathLiteral[] {
  const regions: [number, number][] =
    lang === 'php'
      ? [[0, text.length]]
      : [...text.matchAll(/\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}/g)].map((m) => [m.index!, m.index! + m[0].length]);
  const concat = lang === 'php' ? /^\s*\./ : /^\s*~/;
  const found: PathLiteral[] = [];
  for (const [from, to] of regions) {
    for (const m of text.slice(from, to).matchAll(STRING_RE)) {
      const value = m[2];
      const start = from + m.index! + 1;
      const end = start + value.length;
      if (value.endsWith('.twig') || (value.endsWith('/') && concat.test(text.slice(end + 1, to)))) {
        found.push({ value, start, end });
      }
    }
  }
  return found;
}

/**
 * Edits that point the literals in `text` at templates' new locations.
 * `resolve` maps a template path as written to the absolute path of the
 * template it means today (before the moves). A literal keeps its style: it
 * stays relative to the same Twig root when the target is still under it,
 * else it becomes the target's canonical include path. `templates` (every
 * template's absolute path) shows which folders exist, for folder literals.
 * `stranded` lists literals whose target moved out of every Twig root.
 */
export function referenceEdits(
  literals: PathLiteral[],
  moves: Move[],
  resolve: (path: string) => string | undefined,
  twigRoots: string[],
  templates: string[] = []
): { edits: TextEdit[]; stranded: string[] } {
  const edits: TextEdit[] = [];
  const stranded: string[] = [];
  const normalized = moves.map((m) => ({ from: toPosix(m.from), to: toPosix(m.to) }));

  for (const lit of literals) {
    const lead = /^\.?\//.exec(lit.value)?.[0] ?? '';
    const rel = lit.value.slice(lead.length);
    const isFolder = rel.endsWith('/');
    // A folder literal is checked through a template that would live in it.
    const probe = '__timber_lens_probe__.twig';
    const target = isFolder ? folderTarget(rel, normalized, twigRoots, templates, probe) : resolve(lit.value);
    if (!target) {
      continue;
    }
    const posix = toPosix(target);
    const move = normalized.find((m) => posix === m.from || posix.startsWith(m.from + '/'));
    if (!move) {
      continue;
    }
    const moved = move.to + posix.slice(move.from.length);
    const full = isFolder ? rel + probe : rel;
    let next: string | undefined;
    if (posix.endsWith('/' + full)) {
      const base = posix.slice(0, posix.length - full.length);
      const candidate = moved.slice(base.length);
      const relPaths = computeRelPaths(moved, twigRoots);
      // Outside every root, templates resolve by bare file name.
      const resolves = relPaths.includes(candidate) || (relPaths.length === 0 && !candidate.includes('/'));
      if (moved.startsWith(base) && resolves) {
        next = candidate;
      }
    }
    if (next === undefined) {
      next = canonicalIncludePath(moved, twigRoots);
    }
    if (isFolder) {
      next = next?.slice(0, -probe.length);
    }
    if (next === undefined || next === '') {
      stranded.push(lit.value);
    } else if (next !== rel) {
      edits.push({ start: lit.start + lead.length, end: lit.end, newText: next });
    }
  }
  return { edits, stranded };
}

/**
 * For a folder literal such as 'blocks/', a template path inside the moved
 * folder it points into (the moved folder or one under it), or undefined.
 */
function folderTarget(
  rel: string,
  moves: Move[],
  twigRoots: string[],
  templates: string[],
  probe: string
): string | undefined {
  for (const m of moves) {
    const dirs = new Set([m.from + '/']);
    for (const t of templates) {
      const posix = toPosix(t);
      if (posix.startsWith(m.from + '/')) {
        dirs.add(posix.slice(0, posix.lastIndexOf('/') + 1));
      }
    }
    for (const dir of dirs) {
      if (dir.endsWith('/' + rel) && computeRelPaths(dir + probe, twigRoots).includes(rel + probe)) {
        return dir + probe;
      }
    }
  }
  return undefined;
}
