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
  findLayout,
  formatStructure,
  matchesLayout,
  parseStructure,
  stringifyAcfJson,
} from '../services/fieldStructure';
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
  assert.ok(typeof data.modified === 'number');
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

console.log(`\n${passed} checks passed.`);
