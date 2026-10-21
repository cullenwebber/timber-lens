import { AcfField, AcfFieldGroup, AcfLayout } from '../models/acf';
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
  /** Every flexible_content layout, with the field that owns it. */
  readonly flexibleLayouts: { field: AcfField; layout: AcfLayout }[] = [];
  /** Top-level fields of groups shown on options pages. */
  readonly optionsFields: AcfField[] = [];

  constructor(groups: AcfFieldGroup[]) {
    for (const group of groups) {
      for (const field of group.fields) {
        this.topLevelFields.push(field);
        if (group.isOptions) {
          this.optionsFields.push(field);
        }
        this.register(field);
      }
    }
  }

  /** What get_fields('options') returns: every options page field by name. */
  optionsShape(): TypeShape {
    const keys = new Map<string, TypeShape>();
    for (const f of this.optionsFields) {
      if (!NO_VALUE_TYPES.has(f.type)) {
        keys.set(f.name, acfFieldToShape(f));
      }
    }
    return objectShape(keys, { acfType: 'options', label: 'ACF options' });
  }

  private register(field: AcfField): void {
    if (!this.byName.has(field.name)) {
      this.byName.set(field.name, field);
    }
    this.allNames.add(field.name);
    field.subFields?.forEach((sf) => this.register(sf));
    field.layouts?.forEach((l) => {
      this.flexibleLayouts.push({ field, layout: l });
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
    return subs ? layoutRowShape(name, subs) : undefined;
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

/** A flexible_content row of a layout: `acf_fc_layout` plus its sub fields. */
export function layoutRowShape(name: string, subFields: AcfField[]): TypeShape {
  const keys = new Map<string, TypeShape>();
  keys.set('acf_fc_layout', stringShape({ label: 'Layout name' }));
  for (const sf of subFields) {
    if (!NO_VALUE_TYPES.has(sf.type)) {
      keys.set(sf.name, acfFieldToShape(sf));
    }
  }
  return objectShape(keys, { acfType: 'flexible_content_row', label: name });
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

// Keys of the values ACF returns, per return format.
const IMAGE_SIZES = [
  'thumbnail', 'thumbnail-width', 'thumbnail-height',
  'medium', 'medium-width', 'medium-height',
  'medium_large', 'medium_large-width', 'medium_large-height',
  'large', 'large-width', 'large-height',
];
const FILE_KEYS = [
  'ID', 'id', 'title', 'filename', 'filesize', 'url', 'link', 'alt', 'author', 'description',
  'caption', 'name', 'status', 'uploaded_to', 'date', 'modified', 'menu_order', 'mime_type',
  'type', 'subtype', 'icon',
];
const WP_POST_KEYS = [
  'ID', 'post_title', 'post_name', 'post_content', 'post_excerpt', 'post_type', 'post_status',
  'post_date', 'post_modified', 'post_parent', 'post_author', 'menu_order', 'guid',
];
const WP_TERM_KEYS = ['term_id', 'name', 'slug', 'taxonomy', 'description', 'parent', 'count', 'term_taxonomy_id'];
const USER_ARRAY_KEYS = [
  'ID', 'user_firstname', 'user_lastname', 'nickname', 'user_nicename', 'display_name',
  'user_email', 'user_url', 'user_registered', 'user_description', 'user_avatar',
];
const WP_USER_KEYS = ['ID', 'display_name', 'user_login', 'user_email', 'user_nicename', 'user_url', 'user_registered', 'roles'];
const MAP_KEYS = [
  'address', 'lat', 'lng', 'zoom', 'place_id', 'name', 'street_number', 'street_name',
  'street_name_short', 'city', 'state', 'state_short', 'post_code', 'country', 'country_short',
];

/** Types that only shape the edit screen and store no value. */
const NO_VALUE_TYPES = new Set(['message', 'tab', 'accordion']);

/**
 * Convert a normalized ACF field into the shape of the value ACF returns for
 * it, following its return format (ACF's default when unset).
 */
export function acfFieldToShape(field: AcfField): TypeShape {
  const meta: Partial<TypeShape> = {
    acfType: field.type,
    fieldGroup: field.group,
    fieldName: field.name,
    label: field.label,
    acfKey: field.key,
    acfFile: field.file,
  };
  const format = field.returnFormat;
  const number: TypeShape = { kind: 'number' };
  const many = (item: TypeShape, isMany = field.multiple) => (isMany ? arrayShape(item, meta) : { ...item, ...meta });

  switch (field.type) {
    case 'text':
    case 'textarea':
    case 'wysiwyg':
    case 'email':
    case 'url':
    case 'password':
    case 'oembed':
    case 'date_picker':
    case 'date_time_picker':
    case 'time_picker':
      return stringShape(meta);

    case 'number':
    case 'range':
      return { kind: 'number', ...meta };

    case 'true_false':
      return { kind: 'boolean', ...meta };

    case 'color_picker':
      return format === 'array' ? stringObject(['red', 'green', 'blue', 'alpha'], meta) : stringShape(meta);

    case 'select':
    case 'radio':
    case 'button_group':
    case 'checkbox': {
      const choice = format === 'array' ? stringObject(['value', 'label']) : stringShape();
      return many(choice, field.type === 'checkbox' || (field.type === 'select' && field.multiple));
    }

    case 'link':
      return format === 'url' ? stringShape(meta) : stringObject(['url', 'title', 'target'], meta);

    case 'image':
    case 'file':
    case 'gallery': {
      const keys = new Map<string, TypeShape>(FILE_KEYS.map((k) => [k, stringShape()]));
      if (field.type !== 'file') {
        keys.set('width', number);
        keys.set('height', number);
        keys.set('sizes', stringObject(IMAGE_SIZES));
      }
      const item = format === 'url' ? stringShape() : format === 'id' ? number : objectShape(keys);
      return many(item, field.type === 'gallery');
    }

    case 'post_object':
    case 'relationship':
      return many(format === 'id' ? number : stringObject(WP_POST_KEYS), field.type === 'relationship' || field.multiple);

    case 'page_link':
      return many(stringShape());

    case 'taxonomy': {
      const single = field.fieldType === 'radio' || field.fieldType === 'select';
      return many(format === 'object' ? stringObject(WP_TERM_KEYS) : number, !single);
    }

    case 'user': {
      const user = format === 'id' ? number : stringObject(format === 'object' ? WP_USER_KEYS : USER_ARRAY_KEYS);
      return many(user);
    }

    case 'google_map':
      return stringObject(MAP_KEYS, meta);

    case 'icon_picker':
      return format === 'array' ? stringObject(['type', 'value'], meta) : stringShape(meta);

    case 'group':
      return objectShape(subFieldKeys(field), meta);

    case 'repeater':
      return arrayShape(objectShape(subFieldKeys(field), { acfType: 'repeater_row', fieldName: field.name }), meta);

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
    if (!NO_VALUE_TYPES.has(sf.type)) {
      keys.set(sf.name, acfFieldToShape(sf));
    }
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
      if (!keys.has(sf.name) && !NO_VALUE_TYPES.has(sf.type)) {
        keys.set(sf.name, acfFieldToShape(sf));
      }
    }
  }
  return objectShape(keys, { acfType: 'flexible_content_row' });
}
