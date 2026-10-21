import * as path from 'path';

/** Normalize a path to forward slashes for consistent comparison. */
export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Basename of a file path. */
export function baseName(p: string): string {
  return path.basename(toPosix(p));
}

/**
 * Given an absolute Twig file path and a list of configured Twig root names
 * (e.g. ["views", "partials"]), produce the include-style relative paths a
 * developer would type, e.g. "partials/buttons/button.twig".
 *
 * We match a root name as a path *segment* anywhere in the path so that deeply
 * nested theme layouts (web/app/themes/x/views/...) still resolve.
 */
export function computeRelPaths(absPath: string, twigRoots: string[]): string[] {
  const posix = toPosix(absPath);
  const result = new Set<string>();

  for (const root of twigRoots) {
    const needle = `/${root}/`;
    const idx = posix.lastIndexOf(needle);
    if (idx !== -1) {
      // Keep the root segment itself: ".../templates/icons/x.twig" -> "templates/icons/x.twig".
      result.add(posix.slice(idx + 1));
      // Timber's $dirname entries are loader roots, so includes are written
      // *relative to* the root: ".../templates/icons/x.twig" -> "icons/x.twig".
      result.add(posix.slice(idx + needle.length));
    }
    // Also handle a path that *starts* with the root (no leading slash form).
    if (posix.startsWith(`${root}/`)) {
      result.add(posix);
      result.add(posix.slice(root.length + 1));
    }
  }

  return [...result];
}

/**
 * Directory names Timber registers as loader roots by default (Timber 1 uses
 * `views`, Timber 2 `templates` and `views`). Includes are written relative to
 * these, so the folder itself is never part of the path. Other configured roots
 * (blocks, partials, ...) are ordinary folders whose name stays in the path.
 */
const TIMBER_LOADER_DIRS = ['views', 'templates'];

/**
 * The one include path to suggest for a template. Relative to the innermost
 * Timber loader root when there is one (".../views/partials/x.twig" ->
 * "partials/x.twig"), otherwise starting at the outermost configured root
 * (".../partials/buttons/x.twig" -> "partials/buttons/x.twig"). Always one of
 * computeRelPaths(), so it resolves.
 */
export function canonicalIncludePath(
  absPath: string,
  twigRoots: string[]
): string | undefined {
  const posix = '/' + toPosix(absPath).replace(/^\/+/, '');

  let loaderEnd = -1;
  for (const root of twigRoots) {
    if (!TIMBER_LOADER_DIRS.includes(root)) {
      continue;
    }
    const idx = posix.lastIndexOf(`/${root}/`);
    if (idx !== -1) {
      loaderEnd = Math.max(loaderEnd, idx + root.length + 2);
    }
  }
  if (loaderEnd !== -1) {
    return posix.slice(loaderEnd);
  }

  let outermost = -1;
  for (const root of twigRoots) {
    const idx = posix.lastIndexOf(`/${root}/`);
    if (idx !== -1 && (outermost === -1 || idx < outermost)) {
      outermost = idx;
    }
  }
  return outermost === -1 ? undefined : posix.slice(outermost + 1);
}

/**
 * Normalize a template path as written in a PHP render call or a Twig include
 * into the relative form used in the template index. Strips a leading Twig
 * root segment if present, e.g. "views/page-home.twig" -> "page-home.twig"
 * (and also keeps the original).
 */
export function renderPathVariants(renderPath: string, twigRoots: string[]): string[] {
  const clean = toPosix(renderPath).replace(/^\.?\//, '');
  const variants = new Set<string>([clean]);
  for (const root of twigRoots) {
    if (clean.startsWith(`${root}/`)) {
      variants.add(clean.slice(root.length + 1));
    }
  }
  return [...variants];
}
