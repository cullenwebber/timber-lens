import { TemplateContext, TwigTemplate } from '../models/template';
import { renderPathVariants, toPosix } from '../utils/paths';

/**
 * Resolve an include-style path (e.g. "partials/buttons/button.twig") to an
 * indexed template, using the relPaths computed at index time.
 */
export function resolveIncludePath(
  relPath: string,
  templates: TwigTemplate[]
): TwigTemplate | undefined {
  const target = toPosix(relPath).replace(/^\.?\//, '');
  return templates.find((t) => t.relPaths.includes(target));
}

/**
 * One include path per template for completion: its preferred includePath.
 * Filtering against the typed prefix is left to the editor.
 */
export function includeCandidates(templates: TwigTemplate[]): string[] {
  return [...new Set(templates.map((t) => t.includePath))].sort();
}

/**
 * Find the PHP-provided context for a Twig document. A render path matches a
 * template when one of its path variants equals one of the template's relPaths,
 * or when the document's absolute path ends with the render path. When several
 * PHP files render the template, the first match is the one used.
 */
export function findContextForTwig(
  fsPath: string,
  template: TwigTemplate | undefined,
  contexts: TemplateContext[],
  twigRoots: string[]
): TemplateContext | undefined {
  return findContextsForTwig(fsPath, template, contexts, twigRoots)[0];
}

/** Every PHP render context that targets the Twig document, in index order. */
export function findContextsForTwig(
  fsPath: string,
  template: TwigTemplate | undefined,
  contexts: TemplateContext[],
  twigRoots: string[]
): TemplateContext[] {
  const docPosix = toPosix(fsPath);

  return contexts.filter((ctx) => {
    const variants = renderPathVariants(ctx.templatePath, twigRoots);
    // Match against the absolute path suffix, or the template's known relPaths.
    return (
      variants.some((v) => docPosix.endsWith('/' + v) || docPosix.endsWith(v)) ||
      (template !== undefined && template.relPaths.some((rel) => variants.includes(rel)))
    );
  });
}

/**
 * Where a new template for the include path `relPath` belongs: under the Twig
 * root the project's includes are written against, preferring a root that
 * already has the path's first folder (`partials/` for 'partials/x.twig').
 * Undefined when no template shows where the roots are.
 */
export function newTemplatePath(relPath: string, templates: TwigTemplate[]): string | undefined {
  const rel = toPosix(relPath).replace(/^\.?\//, '');
  const firstDir = rel.includes('/') ? rel.split('/')[0] : undefined;
  const scores = new Map<string, number>();
  for (const t of templates) {
    const posix = toPosix(t.fsPath);
    for (const r of t.relPaths) {
      if (!posix.endsWith('/' + r)) {
        continue;
      }
      const base = posix.slice(0, -r.length);
      const score = (firstDir && r.startsWith(firstDir + '/') ? 10 : 0) + (r === t.includePath ? 1 : 0);
      scores.set(base, (scores.get(base) ?? 0) + score);
    }
  }
  let best: string | undefined;
  let bestScore = -1;
  for (const [base, score] of scores) {
    if (score > bestScore) {
      best = base;
      bestScore = score;
    }
  }
  return best === undefined ? undefined : best + rel;
}
