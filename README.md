# Timber Lens

A VS Code extension that brings **Timber + Twig + ACF** awareness to WordPress
projects — entirely from your workspace files. No running WordPress site or
database required.

## Features

### 1. Timber-aware Twig autocomplete
Variables passed into a template via `Timber::render()` / `Timber::compile()`
are suggested inside the matching `.twig` file. Supports:

- `$context['key'] = [...]` assignments
- inline render arrays
- `array_merge(Timber::context(), [...])`
- `get_field('...')` values (resolved against your ACF JSON for nested shapes)

Completions work inside `{{ ... }}`, `{% if ... %}`, `{% for ... %}` and
`{% set ... %}`.

### 2. ACF-aware autocomplete
Parses ACF Local JSON and supports both access styles:

- `post.meta('field_name')` — suggests all known ACF field names
- direct property access — `post.services.heading`, `post.services.link.url`

**Clone fields** resolve to the fields they clone, from field groups or single
fields anywhere in your ACF JSON. Seamless clones put the cloned fields beside
the clone (prefixed with its name when *Prefix field names* is on); group
clones are an object of them under the clone's name. Clones inside flexible
content layouts reach block templates too.

Field shapes are inferred per type: `text/textarea/wysiwyg` → string,
`link` → `{ url, title, target }`, `image` → object, `group` → object,
`repeater` → array of rows, `flexible_content` → array of layout rows that
always expose `acf_fc_layout`.

### 3. Loop variable inference
`{% for service in post.services.service %}` infers the repeater row shape, and
`{% for block in post.meta('page_builder') %}` infers a flexible-content row.

**Block templates.** Templates under a `blocks/` directory that are pulled in
dynamically (`include('blocks/' ~ block.acf_fc_layout ~ '.twig')`) get the
matching flexible-content layout's row inferred automatically: in
`blocks/banner.twig`, `block.` completes to `acf_fc_layout` plus that layout's
sub fields. The loop variable name (`block`, etc.) is detected from your
templates.

**Template candidates.** Render calls whose first argument is an array or a
variable holding one — `Timber::render(['single-x.twig', 'single.twig'], $ctx)`
or `Timber::render($templates, $ctx)` — attribute the context to every
candidate template.

### 4. Twig template path autocomplete
Inside `include` / `extends` / `embed` / `import` / `from`, suggests `.twig`
files from the configured Twig roots. Each suggestion lists the variables the
template uses, and SVG templates (icons) show a preview.

### 5. Variables passed to includes
- Inside `{% include 'x.twig' with { … } %}`, suggests the variables `x.twig`
  reads, required ones first, marking those it tests or defaults as optional.
- In the included template, those variables resolve to what the including
  templates pass (`link` in `button.twig` is the string 21 templates pass),
  along with loop variables and context inherited at the include.
- Hovering an include path shows the variables it expects and how many
  templates include it.

### 6. Custom functions, filters and global context
- Functions and filters the theme registers (`timber/twig/functions`,
  `timber/twig/filters`, `TwigFunction` / `TwigFilter`) complete after `|` and
  as functions, with their PHP parameters and docblock; built-in Twig and
  Timber filters and functions are listed too.
- Variables added to every template by a `timber/context` filter are known,
  including `get_fields('options')` (fields of ACF options page groups),
  `Timber::get_menu()`, `new Timber\Site()` and `wp_get_current_user()`.

### 7. Hover and go to definition
Hovering a variable or ACF field shows the full shape of its value (every key
and its type, following the field's return format), its source and ACF field
group. Hovering a function or filter shows its signature and docs.

Cmd/Ctrl-click jumps to: an include path's template; a custom function or
filter's PHP; the parent block a `{% block %}` overrides; an ACF field's line
in the structure comment or its definition in ACF JSON; or where a variable
comes from (the PHP that sets it, the include that passes it, or the
`timber/context` filter).

### 8. Diagnostics
- Warns on **static** include paths that cannot be resolved.
- Warns on `post.meta('...')` fields not present in any ACF JSON.
- Warns on fields ACF data does not have (`block.titel` — "did you mean
  `title`?"), including a repeater read as if it were one row.
- Fades `with { … }` keys the included template never uses, and warns when an
  `only` include leaves a required variable out.
- Fades fields in the `acf-fields` structure the template never outputs.
- Dynamic includes using `~` concatenation are never flagged.

**Quick fixes** (Cmd/Ctrl-.) on these diagnostics:

- *Change to 'title'* for a mistyped field (`block.titel`), `post.meta('...')`
  name or include path.
- *Create views/partials/x.twig* for an include that does not exist yet, under
  the Twig root the project's includes are written against.
- *Remove 'key'* for a `with { … }` entry the included template never uses.
- *Pass 'link', 'title' to x.twig* for variables an `only` include leaves out.

### 9. Template Context panel
The **Timber Context** view in the Explorer follows the active Twig template
and shows everything Timber Lens knows about it — so a missing or surprising
completion can be explained at a glance:

- **Context from** — the PHP files that pass this template to
  `Timber::render()` / `Timber::compile()` (click to jump to the call), the
  flexible content layout for block templates, or a warning when nothing
  renders the template.
- **Variables** — each context variable with its type and source; click to
  jump to where the PHP sets it, expand to see its fields.
- **Loop variables** — the `{% for %}` variables in scope at the cursor.
- **Timber globals** — `post`, `site`, `user`, `menu`.

Run **Timber Lens: Show Template Context** to open it.

### 10. Create block templates from ACF layouts
**Timber Lens: Create Block Template from ACF Layout** (also the ＋ button on
the Timber Context view) lists your flexible content layouts and creates
`blocks/<layout>.twig`, pre-filled with markup for every sub field: headings,
text, links, images, repeater loops and so on, read from the loop variable
your templates already use (`block` by default). Layouts that already have a
template open it instead.

### 11. Editable ACF field structure
Block templates start with a Twig comment describing their layout's fields,
generated from ACF JSON (new block templates get it automatically; use the
**Insert ACF field structure** CodeLens on older ones):

```twig
{# acf-fields: page_builder / hero "Hero"
  heading: text "Heading"
  image: image "Image"
  items: repeater "Items"
    title: text "Title"
end-acf-fields #}
```

Each line is `name: type "Label"` (the label is optional); indent sub fields
under a `group` or `repeater`, with spaces or tabs.

After the label, a line can list **choices** in `( … )` and **settings** in
`[ … ]`:

```twig
  style: select "Style" (light, dark: "Dark mode") [required, default: light]
  image: image "Image" [return: url]
  cards: repeater "Cards" [min: 1, max: 4, layout: block]
```

- Choices are `value` or `value: Label`, for select, checkbox, radio and
  button_group fields. Written choices replace the field's choices in ACF.
- Settings are `required`, `return`, `multiple`, `min`, `max`, `default`,
  `layout`, `ui` and `instructions`, where they apply to the field's type.
  On/off settings are written bare to turn them on, or as `required: no`.
  Completion inside `[` lists the settings and their values.
- Choices and settings left out keep what ACF JSON has, so they are optional.
  Generated structures show the choices and every setting that is not ACF's
  default.
- Quote values with spaces, commas or brackets: `instructions: "Max 60 characters"`.
- A written `return` format shapes the field in the template straight away. Edit it, then use the CodeLens above it:

- **Apply to ACF JSON** writes the changes into the layout in your ACF JSON.
  Existing fields keep their keys and settings (instructions, return format,
  choices, ...); new fields get fresh keys. Fields are matched by name, so a
  rename is a remove + add, and anything removed or re-typed asks first. The
  field group's `modified` time is bumped so WordPress offers to sync it under
  ACF → Field Groups.
- **Regenerate from ACF JSON** discards your edits and rewrites the comment.
- Writing a structure for a layout that does not exist yet (e.g. in a new
  `blocks/quote.twig`) shows **Create layout "quote" in ACF JSON**.

Lines that cannot be applied (unknown types, bad indentation, duplicates) are
underlined as errors.

While typing the structure, completion offers whole fields from your ACF JSON
(those the layout already has first, then fields that usually sit beside the
ones written), field types ranked by how the name is used elsewhere, and
labels. Fields in the structure resolve in the template straight away, before
they are applied.

`{% block %}` names complete from the parent template of `{% extends %}`.

### 12. Moving and renaming templates
Move or rename a `.twig` file, or a folder of them, in the VS Code explorer and
every path pointing at it is updated as part of the move:

- `include` / `extends` / `embed` / `import` / `from` / `source()` paths in Twig;
- template paths in PHP, e.g. `Timber::render('views/page-home.twig', $context)`;
- the folder part of dynamic paths when a folder is renamed:
  `include('blocks/' ~ block.acf_fc_layout ~ '.twig')`.

Each path keeps its style: it stays relative to the same Twig root when the
template is still under it, otherwise it becomes the template's usual include
path. Undo reverts the move and the edits together. If a template is moved out
of every Twig root, the paths that pointed at it are listed in a warning
instead. Turn this off with `timberLens.updateReferencesOnMove`.

### Nice-to-haves
- Fallback built-in Timber globals: `post`, `site`, `user`, `menu`.

## Settings

| Setting | Default |
| --- | --- |
| `timberLens.twigRoots` | `["views", "templates", "components", "blocks", "partials"]` |
| `timberLens.acfJsonPaths` | `["acf-json"]` |
| `timberLens.phpScanGlobs` | `["**/*.php"]` |
| `timberLens.enableBuiltinGlobals` | `true` |
| `timberLens.assumePostVariables` | `true` |
| `timberLens.updateReferencesOnMove` | `true` |

## Development

```bash
npm install
npm run compile      # build to ./out
npm run watch        # rebuild on change
node ./out/test/run.js   # run the core acceptance tests
```

Press **F5** to launch an Extension Development Host with the bundled
`example/` workspace, which demonstrates every feature (see the comments in
`example/views/page-home.twig`).

### Installing a release

Download `timber-lens-<version>.vsix` from the
[releases page](https://github.com/cullenwebber/timber-lens/releases), then:

```bash
code --install-extension timber-lens-<version>.vsix
```

### Releasing

Pushing a `v*` tag runs the tests, packages the extension and publishes a
GitHub release with the `.vsix` attached and notes generated from the commits
since the last release (`.github/workflows/release.yml`):

```bash
npm version minor        # bumps package.json, commits, tags v0.2.0
git push --follow-tags
```

The tag must match the `package.json` version, so always bump with
`npm version`. `npm run package` builds the `.vsix` locally.

## Architecture

```
src/
  extension.ts            activation & provider wiring
  config/settings.ts      reads timberLens.* settings
  parsers/                pure parsers (php, acf json, twig cursor context)
  indexers/               file-content -> index builders
  services/               project store, resolvers (acf / context / template)
  providers/              completion, hover, diagnostics, definition
  models/                 shared types (acf, context shapes, templates)
  utils/                  path & range helpers
```

The PHP and Twig "parsers" are intentionally pragmatic heuristics, not full
language servers — per the project's non-goals. Indexing is incremental:
file-system watchers trigger a debounced rebuild.
