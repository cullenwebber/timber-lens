// Inferred type shapes used across the extension.
//
// A TypeShape is the unified, recursive description of "what does this Twig
// expression resolve to". It is produced from PHP context inference and from
// ACF JSON, then consumed by the completion / hover providers.

export type ShapeKind =
  | 'string'
  | 'number'
  | 'boolean'
  | 'object'
  | 'array'
  | 'unknown';

export interface TypeShape {
  kind: ShapeKind;
  /** For object shapes: property name -> shape. */
  keys?: Map<string, TypeShape>;
  /** For array shapes: the shape of a single item. */
  item?: TypeShape;

  // ---- metadata used for hover / detail text ----
  /** Original ACF field type when this shape was derived from ACF. */
  acfType?: string;
  /** ACF field group title, when known. */
  fieldGroup?: string;
  /** ACF / context field machine name, when known. */
  fieldName?: string;
  /** Source PHP file basename when derived from Timber context. */
  source?: string;
  /** Human label, when known. */
  label?: string;
  /** True for built-in Timber globals (post, site, ...). */
  builtin?: boolean;
}

export function objectShape(
  keys: Map<string, TypeShape> = new Map(),
  extra: Partial<TypeShape> = {}
): TypeShape {
  return { kind: 'object', keys, ...extra };
}

export function arrayShape(item: TypeShape, extra: Partial<TypeShape> = {}): TypeShape {
  return { kind: 'array', item, ...extra };
}

export function stringShape(extra: Partial<TypeShape> = {}): TypeShape {
  return { kind: 'string', ...extra };
}

export function unknownShape(extra: Partial<TypeShape> = {}): TypeShape {
  return { kind: 'unknown', ...extra };
}
