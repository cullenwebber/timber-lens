import { AcfField, AcfFieldGroup } from '../models/acf';
import {
  TypeShape,
  arrayShape,
  objectShape,
  stringShape,
  unknownShape,
} from '../models/context';

/**
 * Indexed, queryable view over all parsed ACF field groups.
 */
export class AcfIndex {
  /** Top-level fields (direct children of a field group). */
  readonly topLevelFields: AcfField[] = [];
  /** Every field, by name (first definition wins). */
  private readonly byName = new Map<string, AcfField>();
  /** flexible_content layout name -> its sub fields (first definition wins). */
  private readonly layoutSubFields = new Map<string, AcfField[]>();
  /** Every field name, including nested sub fields. */
  readonly allNames = new Set<string>();

  constructor(groups: AcfFieldGroup[]) {
    for (const group of groups) {
      for (const field of group.fields) {
        this.topLevelFields.push(field);
        this.register(field);
      }
    }
  }

  private register(field: AcfField): void {
    if (!this.byName.has(field.name)) {
      this.byName.set(field.name, field);
    }
    this.allNames.add(field.name);
    field.subFields?.forEach((sf) => this.register(sf));
    field.layouts?.forEach((l) => {
      if (!this.layoutSubFields.has(l.name)) {
        this.layoutSubFields.set(l.name, l.subFields);
      }
      l.subFields.forEach((sf) => this.register(sf));
    });
  }

  /** Names of every flexible_content layout, across all fields. */
  get layoutNames(): Set<string> {
    return new Set(this.layoutSubFields.keys());
  }

  /**
   * The row shape for a flexible_content layout, by layout name. Exposes
   * `acf_fc_layout` plus the layout's sub fields. Used for block templates
   * that are dynamically included per layout (see ProjectIndex).
   */
  layoutRow(name: string): TypeShape | undefined {
    const subs = this.layoutSubFields.get(name);
    if (!subs) {
      return undefined;
    }
    const keys = new Map<string, TypeShape>();
    keys.set('acf_fc_layout', stringShape({ label: 'Layout name' }));
    for (const sf of subs) {
      keys.set(sf.name, acfFieldToShape(sf));
    }
    return objectShape(keys, { acfType: 'flexible_content_row', label: name });
  }

  getField(name: string): AcfField | undefined {
    return this.byName.get(name);
  }

  hasField(name: string): boolean {
    return this.allNames.has(name);
  }

  /** Resolve the shape of a field referenced by name (e.g. via post.meta). */
  shapeByName(name: string): TypeShape | undefined {
    const field = this.byName.get(name);
    return field ? acfFieldToShape(field) : undefined;
  }
}

/** A simple object shape with the given string keys, all typed as strings. */
function stringObject(
  keys: string[],
  extra: Partial<TypeShape> = {}
): TypeShape {
  const map = new Map<string, TypeShape>();
  for (const k of keys) {
    map.set(k, stringShape());
  }
  return objectShape(map, extra);
}

/**
 * Convert a normalized ACF field into an inferred TypeShape, per the spec
 * "Shape rules".
 */
export function acfFieldToShape(field: AcfField): TypeShape {
  const meta: Partial<TypeShape> = {
    acfType: field.type,
    fieldGroup: field.group,
    fieldName: field.name,
    label: field.label,
  };

  switch (field.type) {
    case 'text':
    case 'textarea':
    case 'wysiwyg':
    case 'email':
    case 'url':
    case 'password':
    case 'number':
    case 'range':
    case 'select':
    case 'radio':
    case 'button_group':
    case 'color_picker':
    case 'date_picker':
    case 'date_time_picker':
    case 'time_picker':
    case 'oembed':
      return stringShape(meta);

    case 'true_false':
      return { kind: 'boolean', ...meta };

    case 'link':
      return stringObject(['url', 'title', 'target'], meta);

    case 'image':
    case 'file':
      return stringObject(
        ['ID', 'id', 'url', 'alt', 'title', 'caption', 'description', 'width', 'height', 'filename', 'sizes'],
        meta
      );

    case 'group':
      return objectShape(subFieldKeys(field), meta);

    case 'repeater':
      return arrayShape(objectShape(subFieldKeys(field)), meta);

    case 'flexible_content':
      return arrayShape(flexibleRowShape(field), meta);

    default:
      return unknownShape(meta);
  }
}

/** Build a property map from a field's sub fields. */
function subFieldKeys(field: AcfField): Map<string, TypeShape> {
  const keys = new Map<string, TypeShape>();
  for (const sf of field.subFields ?? []) {
    keys.set(sf.name, acfFieldToShape(sf));
  }
  return keys;
}

/**
 * A flexible_content row: always exposes `acf_fc_layout`, plus the union of all
 * layout sub fields (so completion works even before the layout is known).
 */
function flexibleRowShape(field: AcfField): TypeShape {
  const keys = new Map<string, TypeShape>();
  keys.set('acf_fc_layout', stringShape({ label: 'Layout name' }));
  for (const layout of field.layouts ?? []) {
    for (const sf of layout.subFields) {
      if (!keys.has(sf.name)) {
        keys.set(sf.name, acfFieldToShape(sf));
      }
    }
  }
  return objectShape(keys, { acfType: 'flexible_content_row' });
}
