// Choices and settings written on a field structure line:
//
//   style: select "Style" (light, dark: "Dark mode") [required, default: light]
//
// `( … )` lists choices as `value` or `value: Label`; `[ … ]` lists settings
// as `name` (a flag that is on) or `name: value`. Values with spaces, commas
// or brackets are quoted. Settings left out keep what ACF JSON has.

type Json = Record<string, any>;

export interface SettingSpec {
  /** Name written in the structure, e.g. "return". */
  name: string;
  /** Field types it applies to; every type when undefined. */
  types?: string[];
  /** On/off: written bare when on. */
  flag?: boolean;
  /** Values it accepts, per field type. */
  values?: (type: string) => string[] | undefined;
  /** The value as written in the structure, read from raw ACF JSON. */
  read: (raw: Json) => string;
  /** True when the value is ACF's default, so the structure leaves it out. */
  isDefault: (value: string, type: string) => boolean;
  /** Write the value into raw ACF JSON. */
  write: (raw: Json, value: string, type: string) => void;
}

const RETURN_FORMATS: Record<string, string[]> = {
  image: ['array', 'url', 'id'],
  file: ['array', 'url', 'id'],
  gallery: ['array', 'url', 'id'],
  link: ['array', 'url'],
  select: ['value', 'label', 'array'],
  checkbox: ['value', 'label', 'array'],
  radio: ['value', 'label', 'array'],
  button_group: ['value', 'label', 'array'],
  post_object: ['object', 'id'],
  relationship: ['object', 'id'],
  taxonomy: ['object', 'id'],
  user: ['array', 'object', 'id'],
  color_picker: ['string', 'array'],
  icon_picker: ['string', 'array'],
};
/** What ACF returns when return_format is unset. */
const DEFAULT_RETURN: Record<string, string> = {
  image: 'array', file: 'array', gallery: 'array', link: 'array',
  select: 'value', checkbox: 'value', radio: 'value', button_group: 'value',
  post_object: 'object', relationship: 'object', taxonomy: 'id', user: 'array',
  color_picker: 'string', icon_picker: 'string',
};
const LAYOUT_DEFAULT: Record<string, string> = { repeater: 'table', group: 'block' };

const on = (v: unknown) => v === 1 || v === '1' || v === true;
const str = (v: unknown) => (v === undefined || v === null ? '' : String(v));
const flag = (name: string, acf: string, types?: string[]): SettingSpec => ({
  name,
  types,
  flag: true,
  read: (raw) => (on(raw[acf]) ? 'true' : 'false'),
  isDefault: (v) => v === 'false',
  write: (raw, v) => {
    raw[acf] = v === 'true' ? 1 : 0;
  },
});
const limit = (name: 'min' | 'max'): SettingSpec => ({
  name,
  types: ['repeater', 'gallery', 'relationship', 'number', 'range'],
  read: (raw) => str(raw[name]),
  isDefault: (v, type) => v === '' || (v === '0' && !['number', 'range'].includes(type)),
  write: (raw, v) => {
    raw[name] = v === '' ? '' : Number(v);
  },
});

/** The settings the structure understands, in the order they are written. */
export const SETTINGS: SettingSpec[] = [
  flag('required', 'required'),
  {
    name: 'return',
    types: Object.keys(RETURN_FORMATS),
    values: (type) => RETURN_FORMATS[type],
    read: (raw) => str(raw.return_format),
    isDefault: (v, type) => v === '' || v === DEFAULT_RETURN[type],
    write: (raw, v) => {
      raw.return_format = v;
    },
  },
  flag('multiple', 'multiple', ['select', 'post_object', 'user', 'page_link']),
  limit('min'),
  limit('max'),
  {
    name: 'default',
    types: ['text', 'textarea', 'number', 'range', 'email', 'url', 'select', 'radio', 'button_group', 'true_false', 'color_picker'],
    read: (raw) => (Array.isArray(raw.default_value) ? str(raw.default_value[0]) : str(raw.default_value)),
    isDefault: (v, type) => v === '' || (type === 'true_false' && v === '0'),
    write: (raw, v, type) => {
      raw.default_value = ['number', 'range', 'true_false'].includes(type) && v !== '' ? Number(v) : v;
    },
  },
  {
    name: 'layout',
    types: ['repeater', 'group'],
    values: () => ['table', 'block', 'row'],
    read: (raw) => str(raw.layout),
    isDefault: (v, type) => v === '' || v === LAYOUT_DEFAULT[type],
    write: (raw, v) => {
      raw.layout = v;
    },
  },
  flag('ui', 'ui', ['select', 'true_false']),
  {
    name: 'instructions',
    read: (raw) => str(raw.instructions),
    // Instructions over several lines are not shown, so they are kept as they are.
    isDefault: (v) => v === '' || v.includes('\n'),
    write: (raw, v) => {
      raw.instructions = v;
    },
  },
];

/** Field types that take a `( … )` list of choices. */
export const CHOICE_TYPES = new Set(['select', 'checkbox', 'radio', 'button_group']);

export type Choice = [value: string, label: string];

/** The settings of a raw ACF field that apply to its type, as written in the structure. */
export function readSettings(raw: Json, type: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const spec of SETTINGS) {
    if (!spec.types || spec.types.includes(type)) {
      out[spec.name] = spec.read(raw);
    }
  }
  return out;
}

/** A raw ACF field's choices, when its type has them. */
export function readChoices(raw: Json, type: string): Choice[] | undefined {
  if (!CHOICE_TYPES.has(type) || !raw.choices || typeof raw.choices !== 'object') {
    return undefined;
  }
  return Object.entries(raw.choices as Record<string, unknown>).map(([v, l]) => [v, str(l)]);
}

/** Write settings and choices from the structure into a raw ACF field. */
export function writeSettings(
  raw: Json,
  type: string,
  settings: Record<string, string> | undefined,
  choices: Choice[] | undefined
): void {
  for (const spec of SETTINGS) {
    const value = settings?.[spec.name];
    if (value !== undefined) {
      spec.write(raw, value, type);
    }
  }
  if (choices) {
    raw.choices = Object.fromEntries(choices);
  }
}

/** The ` (choices) [settings]` suffix of a structure line; empty when all are defaults. */
export function formatExtras(type: string, settings: Record<string, string> | undefined, choices: Choice[] | undefined): string {
  let out = '';
  if (choices && choices.length > 0) {
    out += ` (${choices.map(([v, l]) => (v === l ? quote(v) : `${quote(v)}: ${quote(l)}`)).join(', ')})`;
  }
  const shown = SETTINGS.filter((spec) => {
    const v = settings?.[spec.name];
    return v !== undefined && !spec.isDefault(v, type);
  }).map((spec) => {
    const v = settings![spec.name];
    return spec.flag ? spec.name : `${spec.name}: ${quote(v)}`;
  });
  if (shown.length > 0) {
    out += ` [${shown.join(', ')}]`;
  }
  return out;
}

/** Quote a value that would not read back as one bare word. */
function quote(v: string): string {
  return /^[^\s,:()[\]"]+$/.test(v) ? v : `"${v.replace(/"/g, "'")}"`;
}

/**
 * Parse the text after `name: type "Label"`: optional `( … )` choices then
 * optional `[ … ]` settings. Returns an error message for anything else.
 */
export function parseExtras(
  rest: string,
  type: string
): { choices?: Choice[]; settings?: Record<string, string>; error?: string } {
  let text = rest.trim();
  const result: { choices?: Choice[]; settings?: Record<string, string> } = {};

  if (text.startsWith('(')) {
    const close = closing(text, ')');
    if (close === -1) {
      return { error: 'Missing ")" after the choices.' };
    }
    if (!CHOICE_TYPES.has(type)) {
      return { error: `A ${type} field has no choices; only ${[...CHOICE_TYPES].join(', ')} do.` };
    }
    const choices: Choice[] = [];
    for (const item of splitItems(text.slice(1, close))) {
      const [value, label] = item;
      if (value === '') {
        return { error: 'A choice needs a value.' };
      }
      if (choices.some(([v]) => v === value)) {
        return { error: `Duplicate choice "${value}".` };
      }
      choices.push([value, label ?? value]);
    }
    result.choices = choices;
    text = text.slice(close + 1).trim();
  }

  if (text.startsWith('[')) {
    const close = closing(text, ']');
    if (close === -1) {
      return { error: 'Missing "]" after the settings.' };
    }
    const settings: Record<string, string> = {};
    for (const [name, value] of splitItems(text.slice(1, close))) {
      const spec = SETTINGS.find((s) => s.name === name);
      if (!spec) {
        return { error: `Unknown setting "${name}". Settings are ${SETTINGS.map((s) => s.name).join(', ')}.` };
      }
      if (spec.types && !spec.types.includes(type)) {
        return { error: `"${name}" is not a setting of a ${type} field.` };
      }
      let v = value;
      if (spec.flag) {
        const lower = (value ?? 'true').toLowerCase();
        if (['true', 'yes', '1', 'on'].includes(lower)) {
          v = 'true';
        } else if (['false', 'no', '0', 'off'].includes(lower)) {
          v = 'false';
        } else {
          return { error: `"${name}" is on or off: write "${name}" or "${name}: no".` };
        }
      } else if (v === undefined) {
        return { error: `"${name}" needs a value: "${name}: …".` };
      }
      if ((name === 'min' || name === 'max') && v !== '' && !/^-?\d+(\.\d+)?$/.test(v!)) {
        return { error: `"${name}" must be a number.` };
      }
      const allowed = spec.values?.(type);
      if (allowed && !allowed.includes(v!)) {
        return { error: `"${name}" of a ${type} field is one of ${allowed.join(', ')}.` };
      }
      settings[name] = v!;
    }
    result.settings = settings;
    text = text.slice(close + 1).trim();
  }

  if (text !== '') {
    return { error: 'Expected "(choices)" and then "[settings]" after the label.' };
  }
  return result;
}

/** Index of the bracket closing the one at 0, skipping quoted text. */
function closing(text: string, close: string): number {
  let quoted = false;
  for (let i = 1; i < text.length; i++) {
    if (text[i] === '"') {
      quoted = !quoted;
    } else if (!quoted && text[i] === close) {
      return i;
    }
  }
  return -1;
}

/** Split `a, b: "B c", d` into [key, value?] pairs, unquoting. */
function splitItems(body: string): [string, string | undefined][] {
  const items: [string, string | undefined][] = [];
  const parts: string[] = [];
  let quoted = false;
  let current = '';
  for (const ch of body) {
    if (ch === '"') {
      quoted = !quoted;
    }
    if (ch === ',' && !quoted) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  for (const part of parts) {
    if (part.trim() === '') {
      continue;
    }
    const m = /^\s*("[^"]*"|[^:"]*?)\s*(?::\s*("[^"]*"|.*?))?\s*$/.exec(part);
    const unquote = (s: string | undefined) => (s === undefined ? undefined : s.replace(/^"(.*)"$/s, '$1'));
    items.push(m ? [unquote(m[1])!, unquote(m[2])] : [part.trim(), undefined]);
  }
  return items;
}
