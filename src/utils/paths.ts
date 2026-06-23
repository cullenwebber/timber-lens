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
      // Keep the root segment itself: ".../partials/x.twig" -> "partials/x.twig".
      result.add(posix.slice(idx + 1));
    }
    // Also handle a path that *starts* with the root (no leading slash form).
    if (posix.startsWith(`${root}/`)) {
      result.add(posix);
    }
  }

  return [...result];
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
