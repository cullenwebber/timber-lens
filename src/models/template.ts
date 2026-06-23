import { TypeShape } from './context';

/** An indexed Twig template file. */
export interface TwigTemplate {
  /** Absolute filesystem path. */
  fsPath: string;
  /**
   * Include-style relative paths by which this template can be referenced,
   * e.g. "partials/buttons/button.twig". Derived from configured Twig roots.
   */
  relPaths: string[];
}

/** The variables available inside a particular Twig template, from PHP. */
export interface TemplateContext {
  /** Template path as written in the PHP render call, e.g. "views/page-home.twig". */
  templatePath: string;
  /** Source PHP file basename. */
  sourceFile: string;
  /** Variable name -> inferred shape. */
  vars: Map<string, TypeShape>;
}
