// Standalone acceptance tests for the VS Code-free core (parsers + resolvers).
// Run with: npm run compile && node ./out/test/run.js
import * as assert from 'assert';
import { buildAcfIndex } from '../indexers/acfIndexer';
import { buildPhpContexts } from '../indexers/phpContextIndexer';
import { buildTwigIndex } from '../indexers/twigTemplateIndexer';
import { ContextResolver } from '../services/contextResolver';
import {
  detectCursorContext,
  findEnclosingLoops,
} from '../parsers/twigContextParser';
import {
  findContextsForTwig,
  includeCandidates,
  resolveIncludePath,
} from '../services/templateResolver';
import { scaffoldBlockTemplate } from '../services/blockScaffold';
import {
  applyStructure,
  fieldPathAtLine,
  findLayout,
  formatStructure,
  matchesLayout,
  parseStructure,
  stringifyAcfJson,
  structToAcfFields,
  structToAcfFieldsWithSettings,
} from '../services/fieldStructure';
import { acfFieldToShape, layoutRowShape } from '../services/acfResolver';
import {
  rankTypes,
  structureCursorAt,
  suggestFields,
  suggestLabels,
} from '../services/fieldStructureCompletion';
import {
  blockNameAt,
  blockTags,
  extendsPath,
  includeHashAt,
  parseIncludes,
  templateVariables,
} from '../parsers/twigTemplateParser';
import { parseGlobalContext, parseTwigExtensions } from '../parsers/phpTwigExtensions';
import { phpValueToShape } from '../indexers/phpContextIndexer';
import { checkMemberAccess, shapeOfExpr, unusedStructureFields } from '../services/twigChecks';
import { entryRemovalRange, passThroughInsert } from '../parsers/twigTemplateParser';
import { parseExtras } from '../services/fieldSettings';
import { newTemplatePath } from '../services/templateResolver';
import { pathLiterals, referenceEdits, TextEdit } from '../services/templateMoves';
import { AcfLayout } from '../models/acf';
import { TypeShape } from '../models/context';

let passed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error('    ', (err as Error).message);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ACF_JSON = JSON.stringify({
  title: 'Home Page',
  fields: [
    { name: 'hero_heading', type: 'text', key: 'field_1' },
    { name: 'hero_text', type: 'text', key: 'field_2' },
    {
      name: 'services',
      type: 'group',
      key: 'field_3',
      sub_fields: [
        { name: 'heading', type: 'text', key: 'field_4' },
        { name: 'content', type: 'textarea', key: 'field_5' },
        { name: 'link', type: 'link', key: 'field_6' },
        {
          name: 'service',
          type: 'repeater',
          key: 'field_7',
          sub_fields: [
            { name: 'title', type: 'text', key: 'field_8' },
            { name: 'desc', type: 'textarea', key: 'field_9' },
          ],
        },
      ],
    },
    {
      name: 'page_builder',
      type: 'flexible_content',
      key: 'field_10',
      layouts: {
        layout_a: {
          name: 'hero_block',
          label: 'Hero',
          sub_fields: [{ name: 'tagline', type: 'text', key: 'field_11' }],
        },
      },
    },
  ],
});

const PHP_A = `<?php
$context = Timber::context();
$context['hero'] = [
  'heading' => get_field('hero_heading'),
  'text' => get_field('hero_text'),
];
$context['cards'] = $cards;
Timber::render('views/page-home.twig', $context);
`;

const PHP_B = `<?php
Timber::render('views/page-inline.twig', [
  'hero' => [
    'heading' => get_field('hero_heading'),
    'text' => get_field('hero_text'),
  ],
  'cards' => $cards,
]);
`;

const PHP_C = `<?php
$context = array_merge(Timber::context(), [
  'hero' => [
    'heading' => get_field('hero_heading'),
  ],
]);
Timber::render('views/page-merge.twig', $context);
`;

// Gap B: array-of-candidates and variable-array first arguments.
const PHP_D = `<?php
$context = Timber::context();
$context['hero'] = [ 'heading' => get_field('hero_heading') ];
$templates = ['page-custom.twig', 'page.twig'];
Timber::render($templates, $context);
`;

const PHP_E = `<?php
Timber::render(['author.twig', 'archive.twig'], [
  'name' => get_field('hero_heading'),
]);
`;

const TWIG_FILES = [
  '/proj/views/page-home.twig',
  '/proj/partials/buttons/button.twig',
  '/proj/templates/blocks/hero_block.twig',
];
const TWIG_ROOTS = ['views', 'templates', 'components', 'blocks', 'partials'];

// ---------------------------------------------------------------------------
// Build indexes
// ---------------------------------------------------------------------------

const acf = buildAcfIndex([ACF_JSON]);
const contexts = buildPhpContexts(
  [
    { fsPath: '/proj/page-home.php', content: PHP_A },
    { fsPath: '/proj/page-inline.php', content: PHP_B },
    { fsPath: '/proj/page-merge.php', content: PHP_C },
    { fsPath: '/proj/page.php', content: PHP_D },
    { fsPath: '/proj/author.php', content: PHP_E },
  ],
  acf
);
const templates = buildTwigIndex(TWIG_FILES, TWIG_ROOTS);

function resolverFor(templatePath: string): ContextResolver {
  const ctx = contexts.find((c) => c.templatePath === templatePath);
  return new ContextResolver({
    contextVars: ctx?.vars ?? new Map(),
    acf,
    enableGlobals: true,
    assumePostVariables: true,
  });
}

/** Simulate completion: keys offered for the member chain in `line` at end. */
function memberKeys(
  resolver: ContextResolver,
  fullDoc: string,
  caretAfter: string
): string[] {
  const offset = fullDoc.indexOf(caretAfter) + caretAfter.length;
  const before = fullDoc.slice(0, offset);
  const ctx = detectCursorContext(before);
  assert.strictEqual(ctx.kind, 'member', `expected member ctx for "${caretAfter}"`);
  const loopVars = resolver.buildLoopVars(findEnclosingLoops(fullDoc, offset));
  const shape = resolver.resolveExpr(ctx.baseExpr!, loopVars);
  assert.ok(shape, `no shape for ${ctx.baseExpr}`);
  assert.strictEqual(shape!.kind, 'object', `${ctx.baseExpr} not object`);
  return [...(shape!.keys?.keys() ?? [])];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log('PHP Timber context');
test('pattern A: standard $context assignment', () => {
  const r = resolverFor('views/page-home.twig');
  const doc = '{{ hero. }}';
  assert.deepStrictEqual(memberKeys(r, doc, 'hero.'), ['heading', 'text']);
});
test('pattern B: inline render array', () => {
  const r = resolverFor('views/page-inline.twig');
  assert.deepStrictEqual(memberKeys(r, '{{ hero. }}', 'hero.'), ['heading', 'text']);
});
test('pattern C: array_merge(Timber::context(), [...])', () => {
  const r = resolverFor('views/page-merge.twig');
  assert.deepStrictEqual(memberKeys(r, '{{ hero. }}', 'hero.'), ['heading']);
});
test('autocomplete works inside {% if %}', () => {
  const r = resolverFor('views/page-home.twig');
  assert.deepStrictEqual(memberKeys(r, '{% if hero. %}', 'hero.'), ['heading', 'text']);
});

console.log('ACF post.meta()');
test("post.meta(' suggests all field names", () => {
  const before = "{{ post.meta('";
  const ctx = detectCursorContext(before);
  assert.strictEqual(ctx.kind, 'meta');
  assert.ok(acf.allNames.has('hero_heading'));
  assert.ok(acf.allNames.has('page_builder'));
});

console.log('Direct post.<acfField>');
test('post.services. suggests group subfields', () => {
  const r = resolverFor('views/page-home.twig');
  assert.deepStrictEqual(memberKeys(r, '{{ post.services. }}', 'post.services.'), [
    'heading',
    'content',
    'link',
    'service',
  ]);
});
test('post.services.link. suggests url/title/target', () => {
  const r = resolverFor('views/page-home.twig');
  assert.deepStrictEqual(
    memberKeys(r, '{{ post.services.link. }}', 'post.services.link.'),
    ['url', 'title', 'target']
  );
});

console.log('Loop inference');
test('repeater loop: service. uses row subfields', () => {
  const r = resolverFor('views/page-home.twig');
  const doc = '{% for service in post.services.service %}\n  {{ service. }}\n{% endfor %}';
  assert.deepStrictEqual(memberKeys(r, doc, 'service.'), ['title', 'desc']);
});
test('flexible content loop: block. exposes acf_fc_layout', () => {
  const r = resolverFor('views/page-home.twig');
  const doc = "{% for block in post.meta('page_builder') %}\n  {{ block. }}\n{% endfor %}";
  const keys = memberKeys(r, doc, 'block.');
  assert.ok(keys.includes('acf_fc_layout'), 'missing acf_fc_layout');
  assert.ok(keys.includes('tagline'), 'missing layout subfield tagline');
});

console.log('Twig path autocomplete & resolution');
test("include 'part suggests partials/buttons/button.twig", () => {
  const before = "{% include 'part";
  const ctx = detectCursorContext(before);
  assert.strictEqual(ctx.kind, 'path');
  const cands = includeCandidates(templates);
  assert.ok(cands.includes('partials/buttons/button.twig'), cands.join(','));
});
test('each template is suggested once, relative to views/templates', () => {
  assert.deepStrictEqual(includeCandidates(templates), [
    'blocks/hero_block.twig',
    'page-home.twig',
    'partials/buttons/button.twig',
  ]);
});
test('nested roots are relative to the Timber loader root', () => {
  const nested = buildTwigIndex(
    ['/theme/views/partials/buttons/button.twig', '/theme/templates/components/card.twig'],
    TWIG_ROOTS
  );
  assert.deepStrictEqual(includeCandidates(nested), [
    'components/card.twig',
    'partials/buttons/button.twig',
  ]);
});
test('resolveIncludePath finds existing template', () => {
  assert.ok(resolveIncludePath('partials/buttons/button.twig', templates));
});
test('resolveIncludePath returns undefined for missing template', () => {
  assert.strictEqual(resolveIncludePath('partials/nope.twig', templates), undefined);
});

console.log('Dynamic include not treated as path string in member detection');
test('dynamic include via ~ is not a static path', () => {
  // The function-form dynamic include should not be detected as a path prefix
  // mid-expression (it has a closing quote already).
  const before = "{{ include('blocks/' ~ block.acf_fc_layout ~ '.twig'";
  const ctx = detectCursorContext(before);
  assert.notStrictEqual(ctx.kind, 'path');
});

console.log('Render call: array & variable first argument (Gap B)');
test('variable array of candidates: every template gets the context', () => {
  const custom = contexts.find((c) => c.templatePath === 'page-custom.twig');
  const page = contexts.find((c) => c.templatePath === 'page.twig');
  assert.ok(custom, 'page-custom.twig context missing');
  assert.ok(page, 'page.twig context missing');
  assert.ok((custom!.vars.get('hero') as TypeShape).keys?.has('heading'));
});
test('inline array of candidate templates', () => {
  const author = contexts.find((c) => c.templatePath === 'author.twig');
  const archive = contexts.find((c) => c.templatePath === 'archive.twig');
  assert.ok(author && archive, 'candidate templates not both resolved');
  assert.ok(author!.vars.has('name'));
});

console.log('Block template -> ACF layout inference (Gap A)');
test('layoutRow exposes acf_fc_layout + layout subfields', () => {
  const row = acf.layoutRow('hero_block');
  assert.ok(row, 'no layout row for hero_block');
  const keys = [...(row!.keys?.keys() ?? [])];
  assert.ok(keys.includes('acf_fc_layout'), 'missing acf_fc_layout');
  assert.ok(keys.includes('tagline'), 'missing layout subfield tagline');
});
test('unknown layout name yields no row', () => {
  assert.strictEqual(acf.layoutRow('not_a_layout'), undefined);
});

console.log('Post-variable fallback (unresolved loop / included vars)');
test('loop over fn() yields a post-like item with ACF + builtins', () => {
  const r = resolverFor('views/page-home.twig');
  const doc = "{% for project in fn('get_featured_projects') %}\n  {{ project. }}\n{% endfor %}";
  const keys = memberKeys(r, doc, 'project.');
  assert.ok(keys.includes('title'), 'missing post builtin title');
  assert.ok(keys.includes('thumbnail'), 'missing post builtin thumbnail');
  // top-level ACF fields are exposed on the post-like shape
  assert.ok(keys.includes('services'), 'missing ACF field services');
});
test('unresolved variable resolves to post (e.g. included project)', () => {
  const r = resolverFor('views/page-home.twig');
  const keys = memberKeys(r, '{{ project. }}', 'project.');
  assert.ok(keys.includes('title') && keys.includes('categories'));
});
test('post.categories item is a term with title', () => {
  const r = resolverFor('views/page-home.twig');
  const doc = '{% for category in post.categories %}{{ category. }}{% endfor %}';
  assert.deepStrictEqual(
    memberKeys(r, doc, 'category.').sort(),
    ['id', 'link', 'name', 'slug', 'taxonomy', 'title']
  );
});

console.log('\nHover/source metadata');
test('context var carries source PHP file', () => {
  const ctx = contexts.find((c) => c.templatePath === 'views/page-home.twig')!;
  const hero = ctx.vars.get('hero') as TypeShape;
  assert.strictEqual(hero.source, 'page-home.php');
});
test('acf field shape carries acfType and group', () => {
  const shape = acf.shapeByName('hero_heading')!;
  assert.strictEqual(shape.acfType, 'text');
  assert.strictEqual(shape.fieldGroup, 'Home Page');
});

console.log('\nTemplate context view data');
test('every PHP file rendering a template is found, with its path', () => {
  const shared = buildPhpContexts(
    [
      { fsPath: '/proj/single.php', content: "<?php Timber::render('single.twig', ['a' => 1]);" },
      { fsPath: '/proj/archive.php', content: "<?php Timber::render(['single.twig'], ['b' => 2]);" },
    ],
    acf
  );
  const found = findContextsForTwig('/proj/views/single.twig', undefined, shared, TWIG_ROOTS);
  assert.deepStrictEqual(found.map((c) => c.sourcePath), ['/proj/single.php', '/proj/archive.php']);
});
test('flexible layouts are listed with their owning field', () => {
  assert.deepStrictEqual(
    acf.flexibleLayouts.map((l) => `${l.field.name}/${l.layout.name}`),
    ['page_builder/hero_block']
  );
});

console.log('\nBlock template scaffold');
const FEATURES_LAYOUT: AcfLayout = {
  name: 'feature_list',
  label: 'Feature list',
  subFields: [
    { name: 'heading', type: 'text' },
    { name: 'intro', type: 'textarea' },
    { name: 'button', type: 'link' },
    { name: 'show_border', type: 'true_false', label: 'Show border' },
    {
      name: 'features',
      type: 'repeater',
      subFields: [
        { name: 'title', type: 'text' },
        { name: 'icon', type: 'image' },
      ],
    },
    { name: 'map', type: 'google_map' },
  ],
};
test('scaffold renders markup per ACF type under the block variable', () => {
  assert.strictEqual(
    scaffoldBlockTemplate(FEATURES_LAYOUT, 'page_builder', 'block'),
    [
      '{# acf-fields: page_builder / feature_list "Feature list"',
      '  heading: text "Heading"',
      '  intro: textarea "Intro"',
      '  button: link "Button"',
      '  show_border: true_false "Show border"',
      '  features: repeater "Features"',
      '    title: text "Title"',
      '    icon: image "Icon"',
      '  map: google_map "Map"',
      'end-acf-fields #}',
      '<div class="block block--feature-list">',
      '  {% if block.heading %}',
      '    <h2 class="block__heading">{{ block.heading }}</h2>',
      '  {% endif %}',
      '  {% if block.intro %}',
      '    <p class="block__intro">{{ block.intro|nl2br }}</p>',
      '  {% endif %}',
      '  {% if block.button %}',
      '    <a class="block__button" href="{{ block.button.url }}" target="{{ block.button.target }}">{{ block.button.title }}</a>',
      '  {% endif %}',
      '  {% if block.show_border %}',
      '    {# Show border is on #}',
      '  {% endif %}',
      '  {% if block.features %}',
      '    <div class="block__features">',
      '      {% for feature in block.features %}',
      '        <div class="block__features-item">',
      '          {% if feature.title %}',
      '            <h3 class="block__title">{{ feature.title }}</h3>',
      '          {% endif %}',
      '          {% if feature.icon %}',
      '            <img class="block__icon" src="{{ feature.icon.url }}" alt="{{ feature.icon.alt }}">',
      '          {% endif %}',
      '        </div>',
      '      {% endfor %}',
      '    </div>',
      '  {% endif %}',
      '  {# block.map: ACF google_map #}',
      '</div>',
      '',
    ].join('\n')
  );
});
test('scaffold uses the detected loop variable and avoids shadowing it', () => {
  const layout: AcfLayout = {
    name: 'rows',
    subFields: [{ name: 'sections', type: 'repeater', subFields: [{ name: 'body', type: 'wysiwyg' }] }],
  };
  const out = scaffoldBlockTemplate(layout, 'builder', 'section');
  assert.ok(out.includes('{% for section2 in section.sections %}'), out);
  assert.ok(out.includes('{{ section2.body }}'), out);
});

console.log('\nEditable field structure');
const STRUCT_DOC = [
  '{# acf-fields: page_builder / hero_block "Hero"',
  '  tagline: text "Tagline"',
  '  image: image',
  '  items: repeater "Items"',
  '    title: text',
  'end-acf-fields #}',
  '<div>{{ block.tagline }}</div>',
].join('\n');
test('structure parses header, fields, labels and nesting', () => {
  const { block, errors } = parseStructure(STRUCT_DOC);
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(block!.owner, 'page_builder');
  assert.strictEqual(block!.layoutName, 'hero_block');
  assert.strictEqual(block!.layoutLabel, 'Hero');
  assert.deepStrictEqual(
    block!.fields.map((f) => [f.name, f.type, f.label, f.children.map((c) => c.name)]),
    [['tagline', 'text', 'Tagline', []], ['image', 'image', undefined, []], ['items', 'repeater', 'Items', ['title']]]
  );
  assert.strictEqual(STRUCT_DOC.slice(block!.end), '\n<div>{{ block.tagline }}</div>');
});
test('the field on a structure line is found with its parents', () => {
  const block = parseStructure(STRUCT_DOC).block!;
  assert.deepStrictEqual(fieldPathAtLine(block, 4)!.map((f) => f.name), ['items', 'title']);
  assert.deepStrictEqual(fieldPathAtLine(block, 1)!.map((f) => f.name), ['tagline']);
  assert.strictEqual(fieldPathAtLine(block, 0), undefined);
});
test('unapplied structure fields resolve as the block row', () => {
  const block = parseStructure(STRUCT_DOC + '\n').block!;
  const resolver = new ContextResolver({
    contextVars: new Map([['block', layoutRowShape(block.layoutName, structToAcfFields(block.fields))]]),
    acf,
    enableGlobals: true,
    assumePostVariables: true,
  });
  // image is only in the structure, not in the fixture's ACF layout.
  const image = resolver.resolveExpr('block.image', new Map());
  assert.strictEqual(image?.acfType, 'image');
  assert.ok(image?.keys?.has('url'));
  const item = resolver.resolveExpr('block.items', new Map());
  assert.ok(item?.item?.keys?.has('title'));
});
test('a tab-indented sub field nests under a space-indented repeater', () => {
  const doc = '{# acf-fields: pb / x\n  content: wysiwyg\n  items: repeater\n\tcontent: text\n\ttitle: text\nend-acf-fields #}';
  const { block, errors } = parseStructure(doc);
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(block!.fields.map((f) => [f.name, f.children.map((c) => c.name)]), [
    ['content', []],
    ['items', ['content', 'title']],
  ]);
});
test('structure reports unknown types, bad nesting and duplicates by line', () => {
  const { errors } = parseStructure(
    ['{# acf-fields: pb / x', '  a: txt', '  b: text', '    c: text', '  b: image', 'end-acf-fields #}'].join('\n')
  );
  assert.deepStrictEqual(errors.map((e) => e.line), [1, 3, 4]);
});
test('generated structure matches its layout; an edit does not', () => {
  const layout = acf.flexibleLayouts[0].layout;
  const text = formatStructure('page_builder', layout.name, layout.label, layout.subFields);
  assert.strictEqual(text, '{# acf-fields: page_builder / hero_block "Hero"\n  tagline: text "Tagline"\nend-acf-fields #}');
  assert.ok(matchesLayout(parseStructure(text).block!, layout.label, layout.subFields));
  const edited = text.replace('tagline: text', 'tagline: textarea');
  assert.ok(!matchesLayout(parseStructure(edited).block!, layout.label, layout.subFields));
});
test('applying keeps existing field settings and adds new fields with keys', () => {
  const data = JSON.parse(ACF_JSON);
  data.fields[3].layouts.layout_a.sub_fields[0].instructions = 'keep me';
  const loc = findLayout(data, 'page_builder', 'hero_block');
  assert.strictEqual(loc.length, 1);
  let n = 0;
  const report = applyStructure(loc[0], parseStructure(STRUCT_DOC).block!, (p) => `${p}k${++n}`);
  assert.deepStrictEqual(report, { added: ['image', 'items', 'items.title'], removed: [], retyped: [] });
  const subs = data.fields[3].layouts.layout_a.sub_fields;
  assert.strictEqual(subs[0].key, 'field_11');
  assert.strictEqual(subs[0].instructions, 'keep me');
  assert.strictEqual(subs[1].label, 'Image');
  assert.strictEqual(subs[1].return_format, 'array');
  assert.strictEqual(subs[2].sub_fields[0].parent_repeater, subs[2].key);
  assert.ok(data.modified > 1_700_000_000);
});
test('applying an unchanged structure leaves modified alone', () => {
  const data = JSON.parse(ACF_JSON);
  data.modified = 1;
  data.fields[3].layouts.layout_a.sub_fields[0].label = 'Tagline';
  const doc = '{# acf-fields: page_builder / hero_block "Hero"\n  tagline: text "Tagline"\nend-acf-fields #}';
  applyStructure(findLayout(data, 'page_builder', 'hero_block')[0], parseStructure(doc).block!);
  assert.strictEqual(data.modified, 1);
  const changed = '{# acf-fields: page_builder / hero_block "Hero"\n  tagline: text "Tag line"\nend-acf-fields #}';
  applyStructure(findLayout(data, 'page_builder', 'hero_block')[0], parseStructure(changed).block!);
  assert.ok(data.modified > 1);
});
test('applying reports removed and retyped fields', () => {
  const data = JSON.parse(ACF_JSON);
  const doc = '{# acf-fields: page_builder / hero_block\n  subtitle: text\nend-acf-fields #}';
  const report = applyStructure(findLayout(data, 'page_builder', 'hero_block')[0], parseStructure(doc).block!);
  assert.deepStrictEqual(report.removed, ['tagline']);
  assert.deepStrictEqual(report.added, ['subtitle']);
});
test('applying a new layout name creates the layout', () => {
  const data = JSON.parse(ACF_JSON);
  const doc = '{# acf-fields: page_builder / quote "Quote"\n  text: textarea\nend-acf-fields #}';
  const loc = findLayout(data, 'page_builder', 'quote')[0];
  assert.strictEqual(loc.layout, undefined);
  applyStructure(loc, parseStructure(doc).block!);
  const layouts = Object.values(data.fields[3].layouts) as { name: string; sub_fields: unknown[] }[];
  assert.deepStrictEqual(layouts.map((l) => l.name), ['hero_block', 'quote']);
  assert.strictEqual(layouts[1].sub_fields.length, 1);
});
test('ACF JSON round-trips with the original indentation', () => {
  const original = JSON.stringify(JSON.parse(ACF_JSON), null, 4) + '\n';
  assert.strictEqual(stringifyAcfJson(JSON.parse(original), original), original);
});

console.log('\nField structure completion');
const BUILDER_ACF = buildAcfIndex([
  JSON.stringify({
    title: 'Page Builder',
    fields: [
      {
        name: 'page_builder',
        type: 'flexible_content',
        layouts: {
          a: {
            name: 'cards',
            label: 'Cards',
            sub_fields: [
              { name: 'heading', type: 'text', label: 'Heading' },
              { name: 'content', type: 'wysiwyg', label: 'Content' },
              {
                name: 'cards',
                type: 'repeater',
                sub_fields: [
                  { name: 'title', type: 'text' },
                  { name: 'image', type: 'image' },
                ],
              },
            ],
          },
          b: {
            name: 'banner',
            sub_fields: [
              { name: 'heading', type: 'text', label: 'Banner heading' },
              { name: 'button', type: 'link' },
              { name: 'image', type: 'image' },
            ],
          },
          c: {
            name: 'faqs',
            sub_fields: [
              { name: 'heading', type: 'text', label: 'Heading' },
              { name: 'content', type: 'wysiwyg' },
              { name: 'background', type: 'select' },
            ],
          },
        },
      },
    ],
  }),
]);
/** Cursor at the `|` in the document. */
function cursorIn(doc: string) {
  return structureCursorAt(doc.replace('|', ''), doc.indexOf('|'));
}
test('structure cursor: header owner and layout', () => {
  assert.deepStrictEqual(cursorIn('{# acf-fields: page_b|'), { kind: 'owner', prefix: 'page_b' });
  assert.deepStrictEqual(cursorIn('{# acf-fields: page_builder / ca|'), {
    kind: 'layout',
    owner: 'page_builder',
    prefix: 'ca',
  });
});
test('structure cursor: field name with parent and siblings', () => {
  const doc = [
    '{# acf-fields: page_builder / cards "Cards"',
    '  heading: text',
    '  cards: repeater',
    '    title: text',
    '    im|',
    '  content: wysiwyg',
    'end-acf-fields #}',
  ].join('\n');
  assert.deepStrictEqual(cursorIn(doc), {
    kind: 'name',
    prefix: 'im',
    wholeLine: true,
    level: { parent: { name: 'cards', type: 'repeater' }, siblings: ['title'], layoutName: 'cards' },
  });
  const top = doc.replace('    im|', '    image: image').replace('  content: wysiwyg', '  |');
  assert.deepStrictEqual(cursorIn(top), {
    kind: 'name',
    prefix: '',
    wholeLine: true,
    level: { parent: undefined, siblings: ['heading', 'cards'], layoutName: 'cards' },
  });
});
test('structure cursor: type and label positions', () => {
  const head = '{# acf-fields: pb / x\n';
  assert.deepStrictEqual(cursorIn(`${head}  heading:|\nend-acf-fields #}`), {
    kind: 'type', prefix: '', fieldName: 'heading', needsSpace: true, hasLabel: false,
  });
  assert.deepStrictEqual(cursorIn(`${head}  heading: te| "Heading"`), {
    kind: 'type', prefix: 'te', fieldName: 'heading', needsSpace: false, hasLabel: true,
  });
  assert.deepStrictEqual(cursorIn(`${head}  heading: text "He|"`), {
    kind: 'label', prefix: '"He', fieldName: 'heading', closingQuote: true,
  });
});
test('structure cursor: nothing outside the structure', () => {
  assert.strictEqual(cursorIn('<div>|</div>'), undefined);
  assert.strictEqual(cursorIn('{# acf-fields: pb / x\n  a: text\nend-acf-fields #}\n<div>|'), undefined);
});
test('field suggestions rank the same layout, then co-occurring, then common fields', () => {
  const names = suggestFields(BUILDER_ACF, { layoutName: 'cards', siblings: ['heading'] }).map(
    (s) => `${s.field.name}:${s.field.type}`
  );
  assert.deepStrictEqual(names.slice(0, 2), ['content:wysiwyg', 'cards:repeater']);
  assert.ok(!names.includes('heading:text'), 'siblings are not suggested again');
  // content sits next to heading in two layouts; button and image only once.
  const fresh = suggestFields(BUILDER_ACF, { layoutName: 'new_thing', siblings: ['heading'] });
  assert.strictEqual(fresh[0].field.name, 'content');
});
test('field suggestions inside a repeater use that repeater\'s fields with children', () => {
  const inCards = suggestFields(BUILDER_ACF, { parent: { name: 'cards', type: 'repeater' }, siblings: [] });
  assert.deepStrictEqual(inCards.slice(0, 2).map((s) => s.field.name), ['title', 'image']);
  const repeater = suggestFields(BUILDER_ACF, { layoutName: 'x', siblings: [] }).find((s) => s.field.name === 'cards');
  assert.deepStrictEqual(repeater!.field.subFields!.map((f) => f.name), ['title', 'image']);
});
test('types rank what the name is used as; labels start from the name', () => {
  assert.strictEqual(rankTypes(BUILDER_ACF, 'image')[0].type, 'image');
  assert.strictEqual(rankTypes(BUILDER_ACF, 'image').length, 36);
  assert.deepStrictEqual(suggestLabels(BUILDER_ACF, 'heading'), ['Heading', 'Banner heading']);
});

console.log('\nACF value shapes');
/** A compact description of a shape, e.g. "array<object:url,alt>". */
function brief(shape: TypeShape | undefined): string {
  if (!shape) return 'none';
  if (shape.kind === 'array') return `array<${brief(shape.item)}>`;
  if (shape.kind === 'object') return `object:${[...(shape.keys?.keys() ?? [])].slice(0, 3).join(',')}`;
  return shape.kind;
}
const shapeOf = (field: object) => {
  const [group] = buildAcfIndex([JSON.stringify({ title: 'G', fields: [{ name: 'f', ...field }] })]).topLevelFields;
  return brief(acfFieldToShape(group));
};
test('image, file and gallery follow their return format', () => {
  assert.strictEqual(shapeOf({ type: 'image' }), 'object:ID,id,title');
  assert.strictEqual(shapeOf({ type: 'image', return_format: 'url' }), 'string');
  assert.strictEqual(shapeOf({ type: 'image', return_format: 'id' }), 'number');
  assert.strictEqual(shapeOf({ type: 'gallery' }), 'array<object:ID,id,title>');
  assert.strictEqual(shapeOf({ type: 'gallery', return_format: 'url' }), 'array<string>');
});
test('choice fields: single, multiple and value + label', () => {
  assert.strictEqual(shapeOf({ type: 'select' }), 'string');
  assert.strictEqual(shapeOf({ type: 'select', multiple: 1 }), 'array<string>');
  assert.strictEqual(shapeOf({ type: 'radio', return_format: 'array' }), 'object:value,label');
  assert.strictEqual(shapeOf({ type: 'checkbox' }), 'array<string>');
  assert.strictEqual(shapeOf({ type: 'link', return_format: 'url' }), 'string');
});
test('relational fields return WP objects or IDs', () => {
  assert.strictEqual(shapeOf({ type: 'post_object' }), 'object:ID,post_title,post_name');
  assert.strictEqual(shapeOf({ type: 'post_object', multiple: 1, return_format: 'id' }), 'array<number>');
  assert.strictEqual(shapeOf({ type: 'relationship' }), 'array<object:ID,post_title,post_name>');
  assert.strictEqual(shapeOf({ type: 'taxonomy' }), 'array<number>');
  assert.strictEqual(shapeOf({ type: 'taxonomy', field_type: 'select', return_format: 'object' }), 'object:term_id,name,slug');
  assert.strictEqual(shapeOf({ type: 'user' }), 'object:ID,user_firstname,user_lastname');
  assert.strictEqual(shapeOf({ type: 'google_map' }), 'object:address,lat,lng');
  assert.strictEqual(shapeOf({ type: 'number' }), 'number');
});
test('message, tab and accordion fields hold no value', () => {
  const shape = shapeOf({
    type: 'group',
    sub_fields: [{ name: 'tab', type: 'tab' }, { name: 'note', type: 'message' }, { name: 'title', type: 'text' }],
  });
  assert.strictEqual(shape, 'object:title');
});
test('structure fields keep ACF settings of the same name and type', () => {
  const [group] = buildAcfIndex([
    JSON.stringify({ title: 'G', fields: [{ name: 'photo', type: 'image', return_format: 'url' }] }),
  ]).topLevelFields.map((f) => [f]);
  const struct = parseStructure('{# acf-fields: pb / x\n  photo: image\n  logo: image\nend-acf-fields #}').block!;
  const fields = structToAcfFieldsWithSettings(struct.fields, group);
  assert.deepStrictEqual(fields.map((f) => brief(acfFieldToShape(f))), ['string', 'object:ID,id,title']);
});

console.log('\nTemplate variables and includes');
const BUTTON = [
  '<a href="{{ link }}" target="{{ target }}"',
  '  {% if arialabel %}aria-label="{{ arialabel }}"{% endif %} class="{{ class|default("") }}">',
  '  {% for item in items %}{{ item.title }}{{ loop.index }}{% endfor %}',
  '  {% set label = title|upper %}{{ label }} {{ format_price(price) }} {{ image.url }}',
  '  {% include "icons/arrow.twig" with { class: "x" } %}',
  '</a>',
  '{% set course = course ?: post %}{{ course.title }}',
].join('\n');
test('template variables skip locals, keys, functions and filters', () => {
  const vars = templateVariables(BUTTON);
  assert.deepStrictEqual(
    vars.map((v) => v.name + (v.optional ? '?' : '')),
    ['link', 'target', 'arialabel?', 'class?', 'items', 'title', 'price', 'image', 'course', 'post']
  );
  assert.deepStrictEqual(vars.find((v) => v.name === 'image')!.members, ['url']);
});
test('includes parse paths, with-hash entries and only', () => {
  const doc = `{% include 'partials/button.twig' with { link: block.link.url|default(''), 'title': t } only %}
{{ include('icons/arrow.twig', { class: 'a, b' }) }}
{% include "plain.twig" %}
{% include 'blocks/' ~ block.acf_fc_layout ~ '.twig' %}`;
  const tags = parseIncludes(doc);
  assert.deepStrictEqual(tags.map((t) => [t.path, t.entries.map((e) => `${e.key}=${e.value}`), t.only]), [
    ['partials/button.twig', ["link=block.link.url|default('')", 'title=t'], true],
    ['icons/arrow.twig', ["class='a, b'"], false],
    ['plain.twig', [], false],
  ]);
  assert.strictEqual(doc.slice(tags[0].entries[0].keyStart, tags[0].entries[0].keyStart + 4), 'link');
});
test('cursor in an include hash: key positions only', () => {
  const at = (doc: string) => includeHashAt(doc.replace('|', ''), doc.indexOf('|'));
  assert.deepStrictEqual(at(`{% include 'b.twig' with { link: x, ti| } %}`), { path: 'b.twig', prefix: 'ti', keys: ['link'] });
  assert.deepStrictEqual(at(`{% include 'b.twig' with {\n  |`), { path: 'b.twig', prefix: '', keys: [] });
  assert.strictEqual(at(`{% include 'b.twig' with { link: bl| } %}`), undefined);
  assert.strictEqual(at(`{% include 'b.twig' with { link: f({ a| }) } %}`), undefined);
});
test('extends and blocks', () => {
  const doc = `{% extends "base.twig" %}\n{% block content %}{% endblock %}\n{% block fo`;
  assert.strictEqual(extendsPath(doc), 'base.twig');
  assert.deepStrictEqual(blockTags(doc).map((b) => b.name), ['content', 'fo']);
  assert.strictEqual(blockNameAt(doc, doc.length), 'fo');
});

console.log('\nTheme PHP: Twig extensions and global context');
const CONTEXT_PHP = `<?php
class Context {
  public function __construct() {
    add_filter('timber/context', [$this, 'add_to_context']);
    add_filter('timber/twig/functions', [$this, 'add_functions']);
    add_filter('timber/twig', [$this, 'add_filters']);
  }
  public function add_to_context($ctx) {
    $ctx['options'] = get_fields('options');
    $ctx['top_menu'] = Timber::get_menu('Top');
    $ctx['site'] = new \\Timber\\Site();
    return $ctx;
  }
  public function add_functions($functions) {
    $names = ['get_price', 'is_member'];
    foreach ($names as $name) {
      $functions[$name] = ['callable' => [$this, $name]];
    }
    return $functions;
  }
  public function add_filters($twig) {
    $twig->addFilter(new TwigFilter('keep_paragraphs', [$this, 'keep_paragraphs_filter']));
    return $twig;
  }
  /**
   * The price of a product, formatted.
   *
   * @param int $id
   */
  public function get_price(int $id, ?string $currency = null) {}
  public function is_member() {}
  public function keep_paragraphs_filter($content, $count = 2) {}
}
add_filter('timber/twig/filters', function ($filters) {
  $filters['focus'] = ['callable' => function ($image) { return 1; }];
  return $filters;
});`;
test('custom functions and filters with parameters, docs and lines', () => {
  const found = parseTwigExtensions(CONTEXT_PHP);
  assert.deepStrictEqual(
    found.map((c) => `${c.kind}:${c.name}(${c.params ?? ''})`),
    ['filter:keep_paragraphs($content, $count = 2)', 'filter:focus($image)', 'function:get_price($id, $currency = null)', 'function:is_member()']
  );
  const price = found.find((c) => c.name === 'get_price')!;
  assert.strictEqual(price.doc, 'The price of a product, formatted.');
  assert.strictEqual(CONTEXT_PHP.split('\n')[price.line].includes('function get_price'), true);
});
test('timber/context variables get shapes: options page, menu, site', () => {
  const vars = parseGlobalContext(CONTEXT_PHP);
  assert.deepStrictEqual([...vars.keys()], ['options', 'top_menu', 'site']);
  const optionsAcf = buildAcfIndex([
    JSON.stringify({
      title: 'Site Settings',
      location: [[{ param: 'options_page', operator: '==', value: 'site-settings' }]],
      fields: [{ name: 'phone', type: 'text' }, { name: 'logo', type: 'image' }],
    }),
  ]);
  const options = phpValueToShape(vars.get('options')!.value, optionsAcf);
  assert.deepStrictEqual([...options.keys!.keys()], ['phone', 'logo']);
  assert.strictEqual(options.acfType, 'options');
  assert.strictEqual(phpValueToShape(vars.get('options')!.value, acf).kind, 'unknown', 'no options group, no keys');
  assert.ok(phpValueToShape(vars.get('top_menu')!.value, acf).keys!.has('items'));
  assert.ok(phpValueToShape(vars.get('site')!.value, acf).keys!.has('url'));
});

console.log('\nChecks');
const ROW = layoutRowShape('cards', [
  { name: 'heading', type: 'text' },
  { name: 'link', type: 'link' },
  { name: 'cards', type: 'repeater', subFields: [{ name: 'title', type: 'text' }] },
]);
const rowResolver = new ContextResolver({ contextVars: new Map([['block', ROW]]), acf, enableGlobals: true, assumePostVariables: true });
test('shape of passed values: chains, filters, literals, hashes, ternaries', () => {
  const shape = (e: string) => shapeOfExpr(e, (c) => rowResolver.resolveExpr(c, new Map())).kind;
  assert.strictEqual(shape("block.link|default('')"), 'object');
  assert.strictEqual(shape('block.link.title|e'), 'string');
  assert.strictEqual(shape('block.cards|length'), 'number');
  assert.strictEqual(shape("'light' ~ x"), 'string');
  assert.strictEqual(shape("x == 1 ? block.link : ''"), 'object');
  assert.deepStrictEqual([...shapeOfExpr('{ a: 1, b: block.heading }', () => undefined).keys!.keys()], ['a', 'b']);
});
test('member access: typos, lists, and unknown data are left alone', () => {
  const doc = [
    '<a href="{{ block.link.urll }}">{{ block.headng }}</a>',
    '{{ block.cards.title }} {{ block.link.url }} {{ thing.whatever }} {{ block.heading|upper }}',
    '{% for card in block.cards %}{{ card.titel }}{{ loop.index }}{% endfor %}',
  ].join('\n');
  const problems = checkMemberAccess(doc, (chain, offset) =>
    rowResolver.resolveExpr(chain, rowResolver.buildLoopVars(findEnclosingLoops(doc, offset)))
  );
  assert.deepStrictEqual(
    problems.map((p) => doc.slice(p.offset, p.offset + p.length)),
    ['urll', 'headng', 'title', 'titel']
  );
  assert.ok(problems[0].message.includes("Did you mean 'url'?"), problems[0].message);
  assert.ok(problems[2].message.includes('is a list'), problems[2].message);
});
test('unused structure fields, read from markup attributes too', () => {
  const struct = parseStructure(
    '{# acf-fields: pb / x\n  heading: text\n  link: link\n  items: repeater\n    title: text\n    icon: image\nend-acf-fields #}'
  ).block!;
  const body = '<a href="{{ block.link.url }}">{% for i in block.items %}{{ i.title }}{% endfor %}</a>';
  assert.deepStrictEqual(unusedStructureFields(struct.fields, body, 'block').map((f) => f.name), ['heading', 'icon']);
});


// ---- Quick fixes -----------------------------------------------------------

function applyEdits(text: string, edits: TextEdit[]): string {
  return [...edits].sort((a, b) => b.start - a.start).reduce((t, e) => t.slice(0, e.start) + e.newText + t.slice(e.end), text);
}

test('member problems carry the suggested field', () => {
  const resolver = new ContextResolver({
    contextVars: new Map([['block', layoutRowShape('x', [{ name: 'title', type: 'text' }])]]),
    acf: buildAcfIndex([]),
    enableGlobals: false,
    assumePostVariables: false,
  });
  const [p] = checkMemberAccess('{{ block.titel }}', (chain) => resolver.resolveExpr(chain, new Map()));
  assert.strictEqual(p.suggestion, 'title');
});
test('removing include hash entries keeps the hash tidy', () => {
  const doc = "{% include 'x.twig' with { a: 1, b: 2, c: 3 } %}";
  const [tag] = parseIncludes(doc);
  const drop = (i: number) => {
    const [start, end] = entryRemovalRange(doc, tag, i);
    return doc.slice(0, start) + doc.slice(end);
  };
  assert.strictEqual(drop(0), "{% include 'x.twig' with { b: 2, c: 3 } %}");
  assert.strictEqual(drop(1), "{% include 'x.twig' with { a: 1, c: 3 } %}");
  assert.strictEqual(drop(2), "{% include 'x.twig' with { a: 1, b: 2 } %}");
  const one = "{% include 'x.twig' with { a: 1 } %}";
  const [range0] = [entryRemovalRange(one, parseIncludes(one)[0], 0)];
  assert.strictEqual(one.slice(0, range0[0]) + one.slice(range0[1]), "{% include 'x.twig' with { } %}");
});
test('passing missing variables to an only include', () => {
  const ins = (doc: string) => {
    const r = passThroughInsert(doc, parseIncludes(doc)[0], ['link', 'title']);
    return doc.slice(0, r.at) + r.text + doc.slice(r.at);
  };
  assert.strictEqual(
    ins("{% include 'b.twig' with { a: 1 } only %}"),
    "{% include 'b.twig' with { a: 1, link: link, title: title } only %}"
  );
  assert.strictEqual(ins("{% include 'b.twig' only %}"), "{% include 'b.twig' with { link: link, title: title } only %}");
  assert.strictEqual(ins("{% include 'b.twig' with {} only %}"), "{% include 'b.twig' with { link: link, title: title } only %}");
  assert.strictEqual(ins("{{ include('b.twig') }}"), "{{ include('b.twig', { link: link, title: title }) }}");
});
test('a missing include is created under the root its folder lives in', () => {
  const templates = buildTwigIndex(
    ['/t/views/page.twig', '/t/views/partials/a.twig', '/t/views/blocks/hero.twig'],
    ['views', 'blocks', 'partials']
  );
  assert.strictEqual(newTemplatePath('partials/new.twig', templates), '/t/views/partials/new.twig');
  assert.strictEqual(newTemplatePath('cards/new.twig', templates), '/t/views/cards/new.twig');
});

// ---- Clone fields ----------------------------------------------------------

const CLONE_SOURCE = JSON.stringify({
  key: 'group_cta',
  title: 'CTA',
  fields: [
    { key: 'field_c1', name: 'cta_heading', type: 'text' },
    { key: 'field_c2', name: 'cta_link', type: 'link' },
  ],
});
const CLONE_USER = JSON.stringify({
  key: 'group_page',
  title: 'Page',
  fields: [
    { key: 'field_p1', name: 'intro', type: 'text' },
    { key: 'field_p2', name: 'cta', type: 'clone', clone: ['group_cta'], display: 'seamless', prefix_name: 0 },
    { key: 'field_p3', name: 'promo', type: 'clone', clone: ['group_cta'], display: 'group', prefix_name: 0 },
    { key: 'field_p4', name: 'alt', type: 'clone', clone: ['field_c1'], display: 'seamless', prefix_name: 1 },
    { key: 'field_p5', name: 'missing', type: 'clone', clone: ['group_nowhere'], display: 'seamless' },
    {
      key: 'field_p6',
      name: 'page_builder',
      type: 'flexible_content',
      layouts: {
        l1: {
          name: 'banner',
          sub_fields: [
            { key: 'field_b1', name: 'title', type: 'text' },
            { key: 'field_b2', name: 'banner_cta', type: 'clone', clone: ['group_cta'], display: 'seamless' },
          ],
        },
      },
    },
  ],
});

test('seamless clones put the cloned fields beside the clone', () => {
  const acf = buildAcfIndex([CLONE_USER, CLONE_SOURCE]);
  const post = new ContextResolver({ contextVars: new Map(), acf, enableGlobals: true, assumePostVariables: true });
  const keys = post.resolveExpr('post', new Map())?.keys;
  assert.ok(keys?.has('cta_heading') && keys.has('cta_link'));
  assert.strictEqual(post.resolveExpr('post.cta_link.url', new Map())?.kind, 'string');
  // prefix_name: 1 stores them under the clone's name.
  assert.ok(keys?.has('alt_cta_heading') && !keys.has('alt'));
  assert.ok(acf.hasField('alt_cta_heading'));
  // Clones of keys not in the workspace stay unknown.
  assert.strictEqual(acf.shapeByName('missing')?.kind, 'unknown');
});
test('group clones are an object of the cloned fields', () => {
  const acf = buildAcfIndex([CLONE_USER, CLONE_SOURCE]);
  const promo = acf.shapeByName('promo');
  assert.strictEqual(promo?.kind, 'object');
  assert.deepStrictEqual([...promo!.keys!.keys()], ['cta_heading', 'cta_link']);
  const resolver = new ContextResolver({
    contextVars: new Map([['promo', promo!]]),
    acf,
    enableGlobals: false,
    assumePostVariables: false,
  });
  const problems = checkMemberAccess('{{ promo.cta_headng }}', (chain) => resolver.resolveExpr(chain, new Map()));
  assert.strictEqual(problems[0]?.suggestion, 'cta_heading');
});
test('clones inside flexible content layouts reach the block row', () => {
  const acf = buildAcfIndex([CLONE_USER, CLONE_SOURCE]);
  const row = acf.layoutRow('banner');
  assert.deepStrictEqual([...row!.keys!.keys()], ['acf_fc_layout', 'title', 'cta_heading', 'cta_link']);
  // The structure comment still shows the clone itself, so applying it keeps the clone.
  const layout = acf.flexibleLayouts.find((l) => l.layout.name === 'banner')!.layout;
  assert.ok(formatStructure('page_builder', 'banner', 'Banner', layout.subFields).includes('banner_cta: clone'));
  assert.strictEqual(acf.flexibleLayouts.filter((l) => l.layout.name === 'banner').length, 1);
});
test('a clone of a group containing itself does not loop', () => {
  const loop = JSON.stringify({
    key: 'group_loop',
    title: 'Loop',
    fields: [
      { key: 'field_l1', name: 'name', type: 'text' },
      { key: 'field_l2', name: 'again', type: 'clone', clone: ['group_loop'], display: 'group' },
    ],
  });
  const acf = buildAcfIndex([loop]);
  assert.strictEqual(acf.shapeByName('again')?.kind, 'object');
});

// ---- Moving templates ------------------------------------------------------

const MOVE_ROOTS = ['views', 'templates', 'components', 'blocks', 'partials'];
const MOVE_FILES = ['/t/views/page.twig', '/t/views/partials/button.twig', '/t/views/blocks/hero.twig'];
const moveIndex = buildTwigIndex(MOVE_FILES, MOVE_ROOTS);
const resolveMove = (p: string) => resolveIncludePath(p, moveIndex)?.fsPath;

test('finds template path literals in Twig code and PHP', () => {
  const twig = "{# 'nope.twig' #}<p>'text.twig'</p>{% include 'partials/button.twig' %}{{ include('blocks/' ~ name ~ '.twig') }}";
  assert.deepStrictEqual(pathLiterals(twig, 'twig').map((l) => l.value), ['partials/button.twig', 'blocks/', '.twig']);
  const php = "<?php Timber::render(['single-' . $t . '.twig', 'single.twig'], $c); $x = \"$dir/a.twig\";";
  assert.deepStrictEqual(pathLiterals(php, 'php').map((l) => l.value), ['.twig', 'single.twig']);
});
test('moving a template updates includes, keeping each path style', () => {
  const doc = "{% include 'partials/button.twig' with { a: 1 } %}{% include \"button.twig\" %}{% include 'page.twig' %}";
  const { edits } = referenceEdits(
    pathLiterals(doc, 'twig'),
    [{ from: '/t/views/partials/button.twig', to: '/t/views/components/ui/button.twig' }],
    resolveMove,
    MOVE_ROOTS
  );
  assert.strictEqual(
    applyEdits(doc, edits),
    "{% include 'components/ui/button.twig' with { a: 1 } %}{% include \"components/ui/button.twig\" %}{% include 'page.twig' %}"
  );
});
test('a path relative to a nested root stays relative to it when the target stays inside', () => {
  const doc = "{% include 'button.twig' %}";
  const { edits } = referenceEdits(
    pathLiterals(doc, 'twig'),
    [{ from: '/t/views/partials/button.twig', to: '/t/views/partials/ui/btn.twig' }],
    resolveMove,
    MOVE_ROOTS
  );
  assert.strictEqual(applyEdits(doc, edits), "{% include 'ui/btn.twig' %}");
});
test('moving a template updates PHP render paths', () => {
  const php = "<?php Timber::render('views/page.twig', $context); Timber::render('page.twig');";
  const { edits } = referenceEdits(
    pathLiterals(php, 'php'),
    [{ from: '/t/views/page.twig', to: '/t/views/pages/home.twig' }],
    (p) => resolveIncludePath(p.replace(/^views\//, ''), moveIndex)?.fsPath,
    MOVE_ROOTS
  );
  assert.strictEqual(applyEdits(php, edits), "<?php Timber::render('views/pages/home.twig', $context); Timber::render('pages/home.twig');");
});
test('renaming a folder updates static and dynamic paths into it', () => {
  const doc = "{% include 'blocks/hero.twig' %}{% include 'blocks/' ~ block.acf_fc_layout ~ '.twig' %}";
  const { edits } = referenceEdits(
    pathLiterals(doc, 'twig'),
    [{ from: '/t/views/blocks', to: '/t/views/sections' }],
    resolveMove,
    MOVE_ROOTS,
    MOVE_FILES
  );
  assert.strictEqual(applyEdits(doc, edits), "{% include 'sections/hero.twig' %}{% include 'sections/' ~ block.acf_fc_layout ~ '.twig' %}");
});
test('moving a template out of every Twig root reports it', () => {
  const doc = "{% include 'partials/button.twig' %}";
  const result = referenceEdits(
    pathLiterals(doc, 'twig'),
    [{ from: '/t/views/partials/button.twig', to: '/t/old/button.twig' }],
    resolveMove,
    MOVE_ROOTS
  );
  assert.deepStrictEqual(result, { edits: [], stranded: ['partials/button.twig'] });
});

// ---- Choices and settings in the field structure ---------------------------

const SETTINGS_JSON = JSON.stringify({
  key: 'group_pb',
  title: 'Page builder',
  fields: [
    {
      key: 'field_pb',
      name: 'page_builder',
      type: 'flexible_content',
      layouts: {
        l1: {
          name: 'banner',
          label: 'Banner',
          sub_fields: [
            { key: 'field_s1', name: 'style', label: 'Style', type: 'select', choices: { light: 'light', dark: 'Dark mode' }, return_format: 'value', required: 1, instructions: 'Pick one' },
            { key: 'field_s2', name: 'image', label: 'Image', type: 'image', return_format: 'array', required: 0 },
            { key: 'field_s3', name: 'cards', label: 'Cards', type: 'repeater', layout: 'table', min: 0, max: 4, sub_fields: [] },
          ],
        },
      },
    },
  ],
});

test('structure lines parse choices and settings', () => {
  const doc = [
    '{# acf-fields: page_builder / banner "Banner"',
    '  style: select "Style" (light, dark: "Dark mode") [required, default: light]',
    '  image: image [return: url, required: no]',
    '  cards: repeater "Cards" [max: 4, layout: block]',
    '    title: text',
    'end-acf-fields #}',
  ].join('\n');
  const { block, errors } = parseStructure(doc);
  assert.deepStrictEqual(errors, []);
  const [style, image, cards] = block!.fields;
  assert.deepStrictEqual(style.choices, [['light', 'light'], ['dark', 'Dark mode']]);
  assert.deepStrictEqual(style.settings, { required: 'true', default: 'light' });
  assert.deepStrictEqual(image.settings, { return: 'url', required: 'false' });
  assert.deepStrictEqual(cards.settings, { max: '4', layout: 'block' });
  assert.deepStrictEqual(cards.children.map((c) => c.name), ['title']);
});
test('bad choices and settings are reported on their line', () => {
  const errs = (rest: string, type: string) => parseExtras(rest, type).error;
  assert.ok(errs('(a, b)', 'text')?.includes('no choices'));
  assert.ok(errs('[colour: red]', 'text')?.includes('Unknown setting'));
  assert.ok(errs('[return: url]', 'text')?.includes('not a setting of a text'));
  assert.ok(errs('[return: thumb]', 'image')?.includes('one of array, url, id'));
  assert.ok(errs('[min: lots]', 'repeater')?.includes('number'));
  assert.ok(errs('[required: maybe]', 'text')?.includes('on or off'));
  assert.ok(errs('[required] (a)', 'select')?.includes('Expected'));
  assert.ok(errs('(a, a)', 'select')?.includes('Duplicate choice'));
  const doc = '{# acf-fields: pb / x\n  style: text "Style" [return: url]\nend-acf-fields #}';
  assert.deepStrictEqual(parseStructure(doc).errors.map((e) => e.line), [1]);
});
test('generated structure shows choices and non-default settings', () => {
  const acf = buildAcfIndex([SETTINGS_JSON]);
  const layout = acf.flexibleLayouts[0].layout;
  assert.strictEqual(
    formatStructure('page_builder', 'banner', 'Banner', layout.subFields),
    [
      '{# acf-fields: page_builder / banner "Banner"',
      '  style: select "Style" (light, dark: "Dark mode") [required, instructions: "Pick one"]',
      '  image: image "Image"',
      '  cards: repeater "Cards" [max: 4]',
      'end-acf-fields #}',
    ].join('\n')
  );
  // And it reads back as the same thing.
  const round = parseStructure(formatStructure('page_builder', 'banner', 'Banner', layout.subFields));
  assert.deepStrictEqual(round.errors, []);
  assert.ok(matchesLayout(round.block!, 'Banner', layout.subFields));
});
test('settings left out of the structure keep ACF and still match', () => {
  const acf = buildAcfIndex([SETTINGS_JSON]);
  const layout = acf.flexibleLayouts[0].layout;
  const doc = '{# acf-fields: page_builder / banner "Banner"\n  style: select "Style"\n  image: image "Image"\n  cards: repeater "Cards"\nend-acf-fields #}';
  assert.ok(matchesLayout(parseStructure(doc).block!, 'Banner', layout.subFields));
  const changed = doc.replace('image: image "Image"', 'image: image "Image" [required]');
  assert.ok(!matchesLayout(parseStructure(changed).block!, 'Banner', layout.subFields));
});
test('applying writes choices and settings and keeps the rest', () => {
  const data = JSON.parse(SETTINGS_JSON);
  const doc = [
    '{# acf-fields: page_builder / banner "Banner"',
    '  style: select "Style" (light, dark: Dark, brand: "Brand colour") [required: no]',
    '  image: image "Image" [return: url]',
    '  cards: repeater "Cards" [min: 1]',
    '  theme: radio "Theme" (a, b) [default: a]',
    'end-acf-fields #}',
  ].join('\n');
  applyStructure(findLayout(data, 'page_builder', 'banner')[0], parseStructure(doc).block!);
  const [style, image, cards, theme] = data.fields[0].layouts.l1.sub_fields;
  assert.deepStrictEqual(style.choices, { light: 'light', dark: 'Dark', brand: 'Brand colour' });
  assert.strictEqual(style.required, 0);
  assert.strictEqual(style.instructions, 'Pick one');
  assert.strictEqual(image.return_format, 'url');
  assert.strictEqual(cards.min, 1);
  assert.strictEqual(cards.max, 4);
  assert.deepStrictEqual(theme.choices, { a: 'a', b: 'b' });
  assert.strictEqual(theme.default_value, 'a');
});
test('a written return format shapes the field before it is applied', () => {
  const acf = buildAcfIndex([SETTINGS_JSON]);
  const layout = acf.flexibleLayouts[0].layout;
  const doc = '{# acf-fields: page_builder / banner\n  image: image [return: url]\nend-acf-fields #}';
  const [image] = structToAcfFieldsWithSettings(parseStructure(doc).block!.fields, layout.subFields);
  assert.strictEqual(acfFieldToShape(image).kind, 'string');
});
test('setting completion inside the brackets', () => {
  const doc = '{# acf-fields: pb / x\n  image: image "Image" [required, re\nend-acf-fields #}';
  const at = doc.indexOf('re\n') + 2;
  assert.deepStrictEqual(structureCursorAt(doc, at), { kind: 'setting', prefix: 're', fieldType: 'image', written: ['required'] });
  const doc2 = '{# acf-fields: pb / x\n  image: image "Image" [return: u\nend-acf-fields #}';
  assert.deepStrictEqual(structureCursorAt(doc2, doc2.indexOf(': u') + 3), {
    kind: 'settingValue',
    prefix: 'u',
    fieldType: 'image',
    setting: 'return',
  });
});

console.log(`\n${passed} checks passed.`);
