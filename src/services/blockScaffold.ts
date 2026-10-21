import { AcfField, AcfLayout } from '../models/acf';

const STRING_TYPES = new Set([
  'text',
  'number',
  'range',
  'password',
  'select',
  'radio',
  'button_group',
  'color_picker',
  'date_picker',
  'date_time_picker',
  'time_picker',
]);
const HEADING_NAME = /(^|_)(heading|headline|title)$/;
const IDENT = /^[A-Za-z_]\w*$/;

/**
 * Generate a starter Twig template for a flexible_content layout: markup for
 * each sub field chosen by its ACF type, read from `varName` (the loop variable
 * the parent template passes rows in as, e.g. `block`).
 */
export function scaffoldBlockTemplate(
  layout: AcfLayout,
  ownerField: string,
  varName: string
): string {
  const w = new Writer();
  const label = layout.label ? ` (${commentSafe(layout.label)})` : '';
  w.line(
    `{# Flexible content layout "${layout.name}"${label} from "${ownerField}". ` +
      `\`${varName}\` is the current row. #}`
  );
  w.line(`<div class="block block--${cssName(layout.name)}">`);
  w.indent(() => {
    if (layout.subFields.length === 0) {
      w.line('{# This layout has no sub fields yet. #}');
    }
    for (const field of layout.subFields) {
      renderField(w, field, member(varName, field.name), new Set([varName]));
    }
  });
  w.line('</div>');
  return w.toString();
}

function renderField(
  w: Writer,
  field: AcfField,
  expr: string,
  scope: Set<string>,
  heading = 'h2'
): void {
  const cls = `block__${cssName(field.name)}`;

  switch (field.type) {
    case 'group':
      w.line(`<div class="${cls}">`);
      w.indent(() => {
        for (const sub of field.subFields ?? []) {
          renderField(w, sub, member(expr, sub.name), scope, heading);
        }
      });
      w.line('</div>');
      return;

    case 'repeater': {
      const item = loopName(field.name, scope);
      const inner = new Set(scope).add(item);
      ifSet(w, expr, () => {
        w.line(`<div class="${cls}">`);
        w.indent(() => {
          w.line(`{% for ${item} in ${expr} %}`);
          w.indent(() => {
            w.line(`<div class="${cls}-item">`);
            w.indent(() => {
              for (const sub of field.subFields ?? []) {
                renderField(w, sub, member(item, sub.name), inner, 'h3');
              }
            });
            w.line('</div>');
          });
          w.line('{% endfor %}');
        });
        w.line('</div>');
      });
      return;
    }

    case 'flexible_content': {
      const row = loopName('rows', scope);
      const names = (field.layouts ?? []).map((l) => l.name).join(', ') || 'none yet';
      w.line(`{% for ${row} in ${expr} %}`);
      w.indent(() => w.line(`{# ${row}.acf_fc_layout is one of: ${names} #}`));
      w.line('{% endfor %}');
      return;
    }

    case 'true_false':
      w.line(`{% if ${expr} %}`);
      w.indent(() => w.line(`{# ${commentSafe(field.label ?? field.name)} is on #}`));
      w.line('{% endif %}');
      return;

    case 'gallery': {
      const image = loopName('images', scope);
      ifSet(w, expr, () => {
        w.line(`<div class="${cls}">`);
        w.indent(() => {
          w.line(`{% for ${image} in ${expr} %}`);
          w.indent(() => w.line(`<img src="{{ ${image}.url }}" alt="{{ ${image}.alt }}">`));
          w.line('{% endfor %}');
        });
        w.line('</div>');
      });
      return;
    }
  }

  const markup = singleLineMarkup(field, expr, cls, heading);
  if (markup) {
    ifSet(w, expr, () => w.line(markup));
  } else {
    w.line(`{# ${expr}: ACF ${field.type} #}`);
  }
}

/** Markup for a field that renders as a single element, if its type has one. */
function singleLineMarkup(
  field: AcfField,
  expr: string,
  cls: string,
  heading: string
): string | undefined {
  switch (field.type) {
    case 'textarea':
      return `<p class="${cls}">{{ ${expr}|nl2br }}</p>`;
    case 'wysiwyg':
    case 'oembed':
      return `<div class="${cls}">{{ ${expr} }}</div>`;
    case 'url':
      return `<a class="${cls}" href="{{ ${expr} }}">{{ ${expr} }}</a>`;
    case 'email':
      return `<a class="${cls}" href="mailto:{{ ${expr} }}">{{ ${expr} }}</a>`;
    case 'link':
      return (
        `<a class="${cls}" href="{{ ${expr}.url }}" target="{{ ${expr}.target }}">` +
        `{{ ${expr}.title }}</a>`
      );
    case 'image':
      return `<img class="${cls}" src="{{ ${expr}.url }}" alt="{{ ${expr}.alt }}">`;
    case 'file':
      return `<a class="${cls}" href="{{ ${expr}.url }}" download>{{ ${expr}.title }}</a>`;
  }
  if (STRING_TYPES.has(field.type)) {
    const tag = HEADING_NAME.test(field.name) ? heading : 'p';
    return `<${tag} class="${cls}">{{ ${expr} }}</${tag}>`;
  }
  return undefined;
}

function ifSet(w: Writer, expr: string, body: () => void): void {
  w.line(`{% if ${expr} %}`);
  w.indent(body);
  w.line('{% endif %}');
}

/** Twig access to a field: dot syntax when the name allows it. */
function member(expr: string, name: string): string {
  return IDENT.test(name) ? `${expr}.${name}` : `${expr}['${name}']`;
}

/** A loop variable for iterating `collection`, not already used in scope. */
function loopName(collection: string, scope: Set<string>): string {
  const singular = collection.length > 3 && /[^s]s$/.test(collection)
    ? collection.slice(0, -1)
    : 'item';
  const base = IDENT.test(singular) ? singular : 'item';
  let name = base;
  for (let n = 2; scope.has(name); n++) {
    name = `${base}${n}`;
  }
  return name;
}

function cssName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function commentSafe(text: string): string {
  return text.replace(/#}/g, '#');
}

class Writer {
  private readonly lines: string[] = [];
  private depth = 0;

  line(text: string): void {
    this.lines.push('  '.repeat(this.depth) + text);
  }

  indent(body: () => void): void {
    this.depth++;
    body();
    this.depth--;
  }

  toString(): string {
    return this.lines.join('\n') + '\n';
  }
}
