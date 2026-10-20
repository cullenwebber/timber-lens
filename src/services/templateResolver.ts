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
 * One include path per template for completion. Normally the template's
 * preferred includePath; when the typed prefix names a directory the preferred
 * path does not start with (e.g. "views/"), the alias matching it instead.
 * Fuzzy filtering against the prefix is left to the editor.
 */
export function includeCandidates(
  prefix: string,
  templates: TwigTemplate[]
): string[] {
  const norm = toPosix(prefix);
  const out = new Set<string>();
  for (const t of templates) {
    let path = t.includePath;
    if (norm.includes('/') && !path.startsWith(norm)) {
      path = t.relPaths.find((rel) => rel.startsWith(norm)) ?? path;
    }
    out.add(path);
  }
  return [...out].sort();
}

/**
 * Find the PHP-provided context for a Twig document. A render path matches a
 * template when one of its path variants equals one of the template's relPaths,
 * or when the document's absolute path ends with the render path.
 */
export function findContextForTwig(
  fsPath: string,
  template: TwigTemplate | undefined,
  contexts: TemplateContext[],
  twigRoots: string[]
): TemplateContext | undefined {
  const docPosix = toPosix(fsPath);

  for (const ctx of contexts) {
    const variants = renderPathVariants(ctx.templatePath, twigRoots);

    // Match against the absolute path suffix.
    if (variants.some((v) => docPosix.endsWith('/' + v) || docPosix.endsWith(v))) {
      return ctx;
    }
    // Match against the template's known relPaths.
    if (template && template.relPaths.some((rel) => variants.includes(rel))) {
      return ctx;
    }
  }
  return undefined;
}
