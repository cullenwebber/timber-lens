import { AcfField, AcfFieldGroup, AcfLayout } from '../models/acf';

/**
 * Parse the contents of a single ACF Local JSON file into a normalized field
 * group. ACF export files are objects with a `title` and a `fields` array.
 * Some exports wrap multiple groups in a top-level array.
 */
export function parseAcfJson(raw: string): AcfFieldGroup[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }

  const groups: AcfFieldGroup[] = [];
  const candidates = Array.isArray(data) ? data : [data];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') {
      continue;
    }
    const obj = candidate as Record<string, unknown>;
    if (!Array.isArray(obj.fields)) {
      continue;
    }
    const title = typeof obj.title === 'string' ? obj.title : 'ACF';
    const fields = obj.fields
      .map((f) => normalizeField(f, title, undefined))
      .filter((f): f is AcfField => f !== undefined);
    groups.push({ title, fields });
  }

  return groups;
}

function normalizeField(
  raw: unknown,
  group: string,
  parent: string | undefined
): AcfField | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const name = typeof obj.name === 'string' ? obj.name : undefined;
  const type = typeof obj.type === 'string' ? obj.type : 'unknown';
  if (!name) {
    return undefined;
  }

  const field: AcfField = {
    name,
    type,
    group,
    parent,
    label: typeof obj.label === 'string' ? obj.label : undefined,
    key: typeof obj.key === 'string' ? obj.key : undefined,
  };

  // group / repeater sub fields
  if (Array.isArray(obj.sub_fields)) {
    field.subFields = obj.sub_fields
      .map((sf) => normalizeField(sf, group, name))
      .filter((f): f is AcfField => f !== undefined);
  }

  // flexible_content layouts. ACF stores `layouts` as either an object keyed
  // by layout key or (older) an array.
  if (obj.layouts && typeof obj.layouts === 'object') {
    const layoutValues = Array.isArray(obj.layouts)
      ? obj.layouts
      : Object.values(obj.layouts as Record<string, unknown>);
    field.layouts = layoutValues
      .map((l) => normalizeLayout(l, group))
      .filter((l): l is AcfLayout => l !== undefined);
  }

  return field;
}

function normalizeLayout(raw: unknown, group: string): AcfLayout | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const name = typeof obj.name === 'string' ? obj.name : undefined;
  if (!name) {
    return undefined;
  }
  const subFields = Array.isArray(obj.sub_fields)
    ? obj.sub_fields
        .map((sf) => normalizeField(sf, group, name))
        .filter((f): f is AcfField => f !== undefined)
    : [];
  return {
    name,
    label: typeof obj.label === 'string' ? obj.label : undefined,
    subFields,
  };
}
