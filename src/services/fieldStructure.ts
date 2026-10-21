// The editable "field structure" comment at the top of a block template:
//
//   {# acf-fields: page_builder / hero "Hero"
//     heading: text "Heading"
//     items: repeater "Items"
//       title: text "Title"
//   end-acf-fields #}
//
// It is generated from a flexible_content layout in ACF JSON, and edits to it
// can be applied back to that JSON. Matching is by field name: a renamed field
// is a removed field plus an added one.

import { randomBytes } from 'crypto';
import { AcfField } from '../models/acf';

/** One line of the structure: a field and, for groups/repeaters, its children. */
export interface StructField {
  name: string;
  type: string;
  label?: string;
  children: StructField[];
  /** 0-based line within the document, for diagnostics. */
  line: number;
}

export interface StructureBlock {
  /** Name of the flexible_content field that owns the layout. */
  owner: string;
  layoutName: string;
  layoutLabel?: string;
  fields: StructField[];
  /** Offsets of the whole comment, `{#` to `#}` inclusive. */
  start: number;
  end: number;
  /** 0-based line of the header. */
  headerLine: number;
}

export interface StructureError {
  line: number;
  message: string;
}

export interface ApplyReport {
  added: string[];
  removed: string[];
  retyped: string[];
}

/** ACF field types the structure accepts. */
export const ACF_TYPES = new Set([
  'text', 'textarea', 'number', 'range', 'email', 'url', 'password',
  'image', 'file', 'wysiwyg', 'oembed', 'gallery',
  'select', 'checkbox', 'radio', 'button_group', 'true_false',
  'link', 'post_object', 'page_link', 'relationship', 'taxonomy', 'user',
  'google_map', 'date_picker', 'date_time_picker', 'time_picker', 'color_picker', 'icon_picker',
  'message', 'accordion', 'tab', 'group', 'repeater', 'flexible_content', 'clone',
]);
/** Types whose sub fields are written as indented children. */
export const CONTAINER_TYPES = new Set(['group', 'repeater']);

export const HEADER_RE = /\{#-?[ \t]*acf-fields:[ \t]*(.*)$/m;
const HEADER_BODY_RE = /^([\w-]+)\s*\/\s*([\w-]+)(?:\s+"([^"]*)")?\s*$/;
export const END_RE = /^[ \t]*end-acf-fields[ \t]*-?#\}/m;
const FIELD_RE = /^(\s*)([A-Za-z0-9_-]+)\s*:\s*([a-z_]+)(?:\s+"([^"]*)")?\s*$/;
export const INDENT = '  ';

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** The structure comment for a layout, as generated from ACF. */
export function formatStructure(
  owner: string,
  layoutName: string,
  layoutLabel: string | undefined,
  fields: AcfField[]
): string {
  const label = layoutLabel ?? humanize(layoutName);
  return [
    `{# acf-fields: ${owner} / ${layoutName} "${label}"`,
    ...formatFieldLines(fields, 1),
    'end-acf-fields #}',
  ].join('\n');
}

/** Structure lines for fields and their sub fields, starting at `depth`. */
export function formatFieldLines(fields: AcfField[], depth: number): string[] {
  const lines: string[] = [];
  for (const f of fields) {
    lines.push(`${INDENT.repeat(depth)}${f.name}: ${f.type} "${f.label ?? humanize(f.name)}"`);
    if (CONTAINER_TYPES.has(f.type)) {
      lines.push(...formatFieldLines(f.subFields ?? [], depth + 1));
    }
  }
  return lines;
}

/** Turn a parsed structure back into ACF-like fields (default labels filled). */
export function structToAcfFields(fields: StructField[]): AcfField[] {
  return fields.map((f) => ({
    name: f.name,
    type: f.type,
    label: f.label ?? humanize(f.name),
    subFields: structToAcfFields(f.children),
  }));
}

/**
 * Structure fields as ACF fields, carrying the settings (return format, ...)
 * of same-named, same-typed fields in `acfFields`. Fields new to ACF keep
 * ACF's defaults, which is what applying the structure writes.
 */
export function structToAcfFieldsWithSettings(fields: StructField[], acfFields: AcfField[]): AcfField[] {
  return fields.map((f) => {
    const acf = acfFields.find((a) => a.name === f.name && a.type === f.type);
    return {
      ...(acf ?? {}),
      name: f.name,
      type: f.type,
      label: f.label ?? humanize(f.name),
      subFields: structToAcfFieldsWithSettings(f.children, acf?.subFields ?? []),
    };
  });
}

/** True when the parsed structure says the same as the ACF layout. */
export function matchesLayout(
  block: StructureBlock,
  layoutLabel: string | undefined,
  fields: AcfField[]
): boolean {
  const parsed = formatStructure(
    block.owner,
    block.layoutName,
    block.layoutLabel ?? humanize(block.layoutName),
    structToAcfFields(block.fields)
  );
  return parsed === formatStructure(block.owner, block.layoutName, layoutLabel, fields);
}

/** "hero_heading" -> "Hero Heading". */
export function humanize(name: string): string {
  return name
    .split(/[_-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Find and parse the structure comment in a Twig document. Returns no block
 * when the document has none; errors describe lines that cannot be applied.
 */
export function parseStructure(text: string): { block?: StructureBlock; errors: StructureError[] } {
  const header = HEADER_RE.exec(text);
  if (!header) {
    return { errors: [] };
  }
  const start = header.index;
  const headerLine = lineAt(text, start);
  const afterHeader = start + header[0].length;
  const endMatch = END_RE.exec(text.slice(afterHeader));
  if (!endMatch) {
    return { errors: [{ line: headerLine, message: 'Missing "end-acf-fields #}" to close the field structure.' }] };
  }
  const end = afterHeader + endMatch.index + endMatch[0].length;

  const errors: StructureError[] = [];
  const headerBody = HEADER_BODY_RE.exec(header[1].trim());
  if (!headerBody) {
    errors.push({
      line: headerLine,
      message: 'Expected "acf-fields: <flexible content field> / <layout name> "Label"".',
    });
  }

  const bodyLines = text.slice(afterHeader + 1, afterHeader + endMatch.index).split('\n');
  const fields: StructField[] = [];
  const stack: { indent: number; field: StructField }[] = [];
  let baseIndent: number | undefined;

  bodyLines.forEach((raw, i) => {
    const line = headerLine + 1 + i;
    if (raw.trim() === '') {
      return;
    }
    const m = FIELD_RE.exec(raw.replace(/\t/g, INDENT));
    if (!m) {
      errors.push({ line, message: 'Expected "name: type" or "name: type "Label"".' });
      return;
    }
    const indent = m[1].length;
    const field: StructField = { name: m[2], type: m[3], label: m[4], children: [], line };
    if (!ACF_TYPES.has(field.type)) {
      errors.push({ line, message: `Unknown ACF field type "${field.type}".` });
    }
    baseIndent ??= indent;

    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    if (!parent && indent !== baseIndent) {
      errors.push({ line, message: 'Indentation does not line up with the fields above.' });
      return;
    }
    if (parent && !CONTAINER_TYPES.has(parent.field.type)) {
      errors.push({
        line,
        message: `"${parent.field.name}" is a ${parent.field.type} field, so it cannot have sub fields.`,
      });
      return;
    }
    const siblings = parent ? parent.field.children : fields;
    if (siblings.some((s) => s.name === field.name)) {
      errors.push({ line, message: `Duplicate field name "${field.name}".` });
      return;
    }
    siblings.push(field);
    stack.push({ indent, field });
  });

  if (!headerBody) {
    return { errors };
  }
  return {
    block: {
      owner: headerBody[1],
      layoutName: headerBody[2],
      layoutLabel: headerBody[3],
      fields,
      start,
      end,
      headerLine,
    },
    errors,
  };
}

/** The field on a document line and its parents, outermost first. */
export function fieldPathAtLine(block: StructureBlock, line: number): StructField[] | undefined {
  const search = (fields: StructField[], path: StructField[]): StructField[] | undefined => {
    for (const f of fields) {
      if (f.line === line) {
        return [...path, f];
      }
      const found = search(f.children, [...path, f]);
      if (found) {
        return found;
      }
    }
    return undefined;
  };
  return search(block.fields, []);
}

function lineAt(text: string, offset: number): number {
  let line = 0;
  for (let i = 0; i < offset; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
    }
  }
  return line;
}

// ---------------------------------------------------------------------------
// Applying to ACF JSON
// ---------------------------------------------------------------------------

type Json = Record<string, any>;

export interface LayoutLocation {
  /** The field group object (top level of the JSON file, or an array item). */
  group: Json;
  /** The owning flexible_content field. */
  owner: Json;
  /** The layout, or undefined when it does not exist yet. */
  layout?: Json;
}

/**
 * Find the flexible_content field `owner` (searched through every nested
 * field) and its layout `layoutName` in parsed ACF JSON file data.
 */
export function findLayout(data: unknown, owner: string, layoutName: string): LayoutLocation[] {
  const found: LayoutLocation[] = [];
  const groups = Array.isArray(data) ? data : [data];
  for (const group of groups) {
    if (!group || typeof group !== 'object' || !Array.isArray(group.fields)) {
      continue;
    }
    const visit = (fields: Json[]) => {
      for (const f of fields) {
        if (f?.type === 'flexible_content' && f.name === owner) {
          found.push({ group, owner: f, layout: layoutList(f).find((l) => l?.name === layoutName) });
        }
        if (Array.isArray(f?.sub_fields)) {
          visit(f.sub_fields);
        }
        for (const l of layoutList(f)) {
          if (Array.isArray(l?.sub_fields)) {
            visit(l.sub_fields);
          }
        }
      }
    };
    visit(group.fields);
  }
  return found;
}

function layoutList(field: Json): Json[] {
  const layouts = field?.layouts;
  if (!layouts || typeof layouts !== 'object') {
    return [];
  }
  return Array.isArray(layouts) ? layouts : Object.values(layouts);
}

/**
 * Write the structure into the located layout, creating the layout if needed.
 * Existing fields are matched by name and keep their key and every other
 * setting; new fields get fresh keys and ACF defaults. Mutates `loc`.
 */
export function applyStructure(
  loc: LayoutLocation,
  block: StructureBlock,
  newKey: (prefix: string) => string = uniqueKey
): ApplyReport {
  const report: ApplyReport = { added: [], removed: [], retyped: [] };
  const before = JSON.stringify(loc.group);
  let layout = loc.layout;
  if (!layout) {
    layout = {
      key: newKey('layout_'),
      name: block.layoutName,
      label: block.layoutLabel ?? humanize(block.layoutName),
      display: 'block',
      sub_fields: [],
      min: '',
      max: '',
    };
    if (Array.isArray(loc.owner.layouts)) {
      loc.owner.layouts.push(layout);
    } else {
      loc.owner.layouts = { ...(loc.owner.layouts ?? {}), [layout.key]: layout };
    }
    loc.layout = layout;
  } else if (block.layoutLabel !== undefined) {
    layout.label = block.layoutLabel;
  }

  layout.sub_fields = applyFields(
    Array.isArray(layout.sub_fields) ? layout.sub_fields : [],
    block.fields,
    { parentProp: 'parent_layout', parentKey: layout.key, path: '' },
    report,
    newKey
  );
  // A newer `modified` than the database copy is what makes ACF offer to sync.
  if (JSON.stringify(loc.group) !== before) {
    loc.group.modified = Math.floor(Date.now() / 1000);
  }
  return report;
}

interface Parent {
  /** ACF 6 records the owning layout / repeater key on sub fields. */
  parentProp?: 'parent_layout' | 'parent_repeater';
  parentKey?: string;
  path: string;
}

function applyFields(
  existing: Json[],
  fields: StructField[],
  parent: Parent,
  report: ApplyReport,
  newKey: (prefix: string) => string
): Json[] {
  const names = new Set(fields.map((f) => f.name));
  for (const old of existing) {
    if (!names.has(old?.name)) {
      report.removed.push(parent.path + old?.name);
    }
  }

  return fields.map((f) => {
    const path = parent.path + f.name;
    let raw = existing.find((e) => e?.name === f.name);
    if (raw) {
      if (raw.type !== f.type) {
        report.retyped.push(`${path} (${raw.type} → ${f.type})`);
        raw.type = f.type;
      }
    } else {
      raw = newField(f, newKey('field_'), parent);
      report.added.push(path);
    }
    // An omitted label means the default, as when comparing with ACF.
    raw.label = f.label ?? humanize(f.name);

    if (CONTAINER_TYPES.has(f.type)) {
      raw.sub_fields = applyFields(
        Array.isArray(raw.sub_fields) ? raw.sub_fields : [],
        f.children,
        {
          parentProp: f.type === 'repeater' ? 'parent_repeater' : undefined,
          parentKey: raw.key,
          path: `${path}.`,
        },
        report,
        newKey
      );
    }
    return raw;
  });
}

/** A new field with the settings ACF writes for a freshly added field. */
function newField(f: StructField, key: string, parent: Parent): Json {
  const field: Json = {
    key,
    label: f.label ?? humanize(f.name),
    name: f.name,
    'aria-label': '',
    type: f.type,
    instructions: '',
    required: 0,
    conditional_logic: 0,
    wrapper: { width: '', class: '', id: '' },
  };
  if (parent.parentProp && parent.parentKey) {
    field[parent.parentProp] = parent.parentKey;
  }
  return { ...field, ...TYPE_DEFAULTS[f.type] };
}

const TYPE_DEFAULTS: Record<string, Json> = {
  image: { return_format: 'array', library: 'all', preview_size: 'medium' },
  gallery: { return_format: 'array', library: 'all', preview_size: 'medium' },
  file: { return_format: 'array', library: 'all' },
  link: { return_format: 'array' },
  select: { choices: {}, return_format: 'value', multiple: 0, ui: 0 },
  checkbox: { choices: {}, return_format: 'value' },
  radio: { choices: {}, return_format: 'value' },
  button_group: { choices: {}, return_format: 'value' },
  true_false: { default_value: 0, ui: 0 },
  group: { layout: 'block', sub_fields: [] },
  repeater: { layout: 'table', min: 0, max: 0, button_label: '', sub_fields: [] },
  flexible_content: { layouts: {}, min: '', max: '', button_label: 'Add Row' },
};

const usedKeys = new Set<string>();

/** ACF-style key: prefix + 13 hex characters, like PHP's uniqid(). */
function uniqueKey(prefix: string): string {
  let key: string;
  do {
    key = prefix + randomBytes(7).toString('hex').slice(0, 13);
  } while (usedKeys.has(key));
  usedKeys.add(key);
  return key;
}

/** Serialize ACF JSON the way ACF writes it, keeping the file's indentation. */
export function stringifyAcfJson(data: unknown, original: string): string {
  const indent = /\n([ \t]+)"/.exec(original)?.[1] ?? '    ';
  const trailing = original.endsWith('\n') ? '\n' : '';
  return JSON.stringify(data, null, indent) + trailing;
}
