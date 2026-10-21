// Completion inside the `acf-fields` structure comment (see fieldStructure.ts):
// where the cursor is on a structure line, and which fields, types and labels
// to suggest there, ranked from the project's existing ACF JSON.

import { AcfField } from '../models/acf';
import { AcfIndex } from './acfResolver';
import { ACF_TYPES, CONTAINER_TYPES, END_RE, HEADER_RE, INDENT, humanize } from './fieldStructure';

/** What is being typed at the cursor, and where on the structure line. */
export type StructureCursor =
  | { kind: 'owner'; prefix: string }
  | { kind: 'layout'; owner: string; prefix: string }
  | {
      kind: 'name';
      prefix: string;
      /** True when the rest of the line is empty, so a whole field can go in. */
      wholeLine: boolean;
      level: FieldLevel;
    }
  | {
      kind: 'type';
      prefix: string;
      fieldName: string;
      /** No space after the colon yet, so the inserted type needs one. */
      needsSpace: boolean;
      /** The line already has a label after the cursor. */
      hasLabel: boolean;
    }
  | {
      kind: 'label';
      /** The typed label so far, including any opening quote. */
      prefix: string;
      fieldName: string;
      /** A closing quote straight after the cursor (auto-closed). */
      closingQuote: boolean;
    };

/** The list a structure line belongs to: the layout itself or a container field. */
export interface FieldLevel {
  /** The group / repeater the line is nested in; undefined at the top level. */
  parent?: { name: string; type: string };
  /** Layout named in the header, when it parses. */
  layoutName?: string;
  /** Names already used at this level, excluding the cursor's line. */
  siblings: string[];
}

const LINE_RE = /^(\s*)([A-Za-z0-9_-]+)\s*:\s*([a-z_]+)/;

/**
 * Classify the cursor at `offset` when it is inside a structure comment, or
 * undefined anywhere else. An unclosed structure runs to the end of the text,
 * so it completes while it is being written.
 */
export function structureCursorAt(text: string, offset: number): StructureCursor | undefined {
  const header = HEADER_RE.exec(text);
  if (!header || header.index > offset) {
    return undefined;
  }
  const headerEnd = header.index + header[0].length;
  const headerBody = header[1];

  if (offset <= headerEnd) {
    const bodyStart = headerEnd - headerBody.length;
    if (offset < bodyStart) {
      return undefined;
    }
    const typed = text.slice(bodyStart, offset);
    const owner = /^\s*([\w-]*)$/.exec(typed);
    if (owner) {
      return { kind: 'owner', prefix: owner[1] };
    }
    const layout = /^\s*([\w-]+)\s*\/\s*([\w-]*)$/.exec(typed);
    return layout ? { kind: 'layout', owner: layout[1], prefix: layout[2] } : undefined;
  }

  const end = END_RE.exec(text.slice(headerEnd));
  const bodyEnd = end ? headerEnd + end.index : text.length;
  if (offset > bodyEnd) {
    return undefined;
  }

  const lines = text.slice(headerEnd + 1, bodyEnd).split('\n');
  let lineStart = headerEnd + 1;
  let current = 0;
  while (current < lines.length - 1 && lineStart + lines[current].length < offset) {
    lineStart += lines[current].length + 1;
    current++;
  }
  const lineText = lines[current] ?? '';
  const before = lineText.slice(0, offset - lineStart).replace(/\t/g, INDENT);
  const after = lineText.slice(offset - lineStart);

  const name = /^(\s*)([A-Za-z0-9_-]*)$/.exec(before);
  if (name) {
    const layoutName = /^\s*[\w-]+\s*\/\s*([\w-]+)/.exec(headerBody)?.[1];
    return {
      kind: 'name',
      prefix: name[2],
      wholeLine: after.trim() === '',
      level: { ...levelOf(lines, current, name[1].length), layoutName },
    };
  }
  const type = /^\s*([A-Za-z0-9_-]+)\s*:(\s*)([a-z_]*)$/.exec(before);
  if (type) {
    return {
      kind: 'type',
      prefix: type[3],
      fieldName: type[1],
      needsSpace: type[2] === '',
      hasLabel: after.includes('"'),
    };
  }
  const label = /^\s*([A-Za-z0-9_-]+)\s*:\s*[a-z_]+\s+("?[^"]*)$/.exec(before);
  if (label) {
    return {
      kind: 'label',
      prefix: label[2],
      fieldName: label[1],
      closingQuote: /^"\s*$/.test(after),
    };
  }
  return undefined;
}

/** The parent field and sibling names for a line at `indent`. */
function levelOf(lines: string[], current: number, indent: number): Omit<FieldLevel, 'layoutName'> {
  const parsed = lines.map((l) => LINE_RE.exec(l.replace(/\t/g, INDENT)));

  let parentLine = -1;
  for (let i = current - 1; i >= 0; i--) {
    const m = parsed[i];
    if (m && m[1].length < indent) {
      parentLine = i;
      break;
    }
  }
  const parentMatch = parentLine === -1 ? null : parsed[parentLine];
  const parent = parentMatch ? { name: parentMatch[2], type: parentMatch[3] } : undefined;

  const siblings: string[] = [];
  for (let i = parentLine + 1; i < lines.length; i++) {
    const m = parsed[i];
    if (!m || i === current) {
      continue;
    }
    if (m[1].length < indent) {
      break;
    }
    if (m[1].length === indent) {
      siblings.push(m[2]);
    }
  }
  return { parent, siblings };
}

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

/** One list of sibling fields in ACF: a field group, a layout, or a container's sub fields. */
interface FieldList {
  /** Layout name or container field name; undefined for a field group's top level. */
  parentName?: string;
  /** Whether parentName is a flexible content layout or a group / repeater. */
  parentKind?: 'layout' | 'field';
  /** Where the list lives, for display: layout / field / group name. */
  where: string;
  fields: AcfField[];
}

export interface FieldSuggestion {
  /** A definition to insert, with its sub fields. */
  field: AcfField;
  /** How many times this name + type is defined across the ACF JSON. */
  uses: number;
  /** Where it is used, most relevant first. */
  where: string[];
  /** Higher is more relevant. */
  score: number;
}

const listCache = new WeakMap<AcfIndex, FieldList[]>();

/** Every list of sibling fields in the index (cached per index build). */
function fieldLists(acf: AcfIndex): FieldList[] {
  let lists = listCache.get(acf);
  if (!lists) {
    lists = collectFieldLists(acf);
    listCache.set(acf, lists);
  }
  return lists;
}

function collectFieldLists(acf: AcfIndex): FieldList[] {
  const lists: FieldList[] = [];
  const visit = (fields: AcfField[]) => {
    for (const f of fields) {
      if (f.subFields?.length) {
        lists.push({ parentName: f.name, parentKind: 'field', where: f.name, fields: f.subFields });
        visit(f.subFields);
      }
      for (const l of f.layouts ?? []) {
        lists.push({ parentName: l.name, parentKind: 'layout', where: l.name, fields: l.subFields });
        visit(l.subFields);
      }
    }
  };
  const byGroup = new Map<string, AcfField[]>();
  for (const f of acf.topLevelFields) {
    const group = f.group ?? '';
    byGroup.set(group, [...(byGroup.get(group) ?? []), f]);
  }
  for (const [group, fields] of byGroup) {
    lists.push({ where: group || 'field group', fields });
  }
  visit(acf.topLevelFields);
  return lists;
}

/**
 * Fields to offer at a structure level, best first. Fields the same layout /
 * container already has in ACF come first, then fields that usually sit next
 * to the siblings already written, then the most used fields overall.
 */
export function suggestFields(acf: AcfIndex, level: FieldLevel): FieldSuggestion[] {
  // A layout and a repeater may share a name, so match the kind too.
  const parentName = level.parent?.name ?? level.layoutName;
  const parentKind = level.parent ? 'field' : 'layout';
  const taken = new Set(level.siblings);
  // Fields of the same parent come first, in their ACF order.
  const byKey = new Map<string, FieldSuggestion & { parentOrder?: number }>();

  for (const list of fieldLists(acf)) {
    const sameParent =
      parentName !== undefined && list.parentName === parentName && list.parentKind === parentKind;
    const overlap = list.fields.filter((f) => taken.has(f.name)).length;

    list.fields.forEach((f, position) => {
      if (taken.has(f.name)) {
        return;
      }
      const key = `${f.name}:${f.type}`;
      let s = byKey.get(key);
      if (!s) {
        s = { field: f, uses: 0, where: [], score: 0 };
        byKey.set(key, s);
      }
      s.uses++;
      s.score += 1 + overlap * 2;
      if (!s.where.includes(list.where)) {
        sameParent ? s.where.unshift(list.where) : s.where.push(list.where);
      }
      // Prefer the definition from the same parent, else the fullest one.
      if (sameParent && s.parentOrder === undefined) {
        s.field = f;
        s.parentOrder = position;
      } else if (s.parentOrder === undefined && (f.subFields?.length ?? 0) > (s.field.subFields?.length ?? 0)) {
        s.field = f;
      }
    });
  }

  const order = (s: { parentOrder?: number }) => s.parentOrder ?? Infinity;
  return [...byKey.values()]
    .sort((a, b) => order(a) - order(b) || b.score - a.score || a.field.name.localeCompare(b.field.name))
    .map(({ parentOrder: _, ...s }) => s);
}

/**
 * Every ACF type, ordered by how likely it is for `fieldName`: types that
 * name already has in ACF first, then the project's most used types.
 */
export function rankTypes(acf: AcfIndex, fieldName: string): { type: string; usesForName: number }[] {
  const forName = new Map<string, number>();
  const overall = new Map<string, number>();
  for (const list of fieldLists(acf)) {
    for (const f of list.fields) {
      overall.set(f.type, (overall.get(f.type) ?? 0) + 1);
      if (f.name === fieldName) {
        forName.set(f.type, (forName.get(f.type) ?? 0) + 1);
      }
    }
  }
  return [...ACF_TYPES]
    .map((type) => ({ type, usesForName: forName.get(type) ?? 0, overall: overall.get(type) ?? 0 }))
    .sort((a, b) => b.usesForName - a.usesForName || b.overall - a.overall || a.type.localeCompare(b.type))
    .map(({ type, usesForName }) => ({ type, usesForName }));
}

/** Labels for a field name: the humanized default, then labels used in ACF. */
export function suggestLabels(acf: AcfIndex, fieldName: string): string[] {
  const counts = new Map<string, number>();
  for (const list of fieldLists(acf)) {
    for (const f of list.fields) {
      if (f.name === fieldName && f.label) {
        counts.set(f.label, (counts.get(f.label) ?? 0) + 1);
      }
    }
  }
  const used = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([label]) => label);
  return [...new Set([humanize(fieldName), ...used])];
}

export function isContainerType(type: string): boolean {
  return CONTAINER_TYPES.has(type);
}
