import { TwigTemplate } from '../models/template';
import { canonicalIncludePath, computeRelPaths, toPosix } from '../utils/paths';

/** Build the Twig template index from a list of absolute .twig paths. */
export function buildTwigIndex(
  absPaths: string[],
  twigRoots: string[]
): TwigTemplate[] {
  return absPaths.map((fsPath) => {
    const relPaths = computeRelPaths(fsPath, twigRoots);
    // Fallback: index by basename so bare references still resolve.
    if (relPaths.length === 0) {
      const posix = toPosix(fsPath);
      relPaths.push(posix.slice(posix.lastIndexOf('/') + 1));
    }
    const includePath = canonicalIncludePath(fsPath, twigRoots) ?? relPaths[0];
    return { fsPath, relPaths, includePath };
  });
}
