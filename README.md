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
files from the configured Twig roots.

### 5. Hover
Hovering a variable or ACF field shows its inferred type, source PHP file, ACF
field type and field group where known.

### 6. Diagnostics
- Warns on **static** include paths that cannot be resolved.
- Warns on `post.meta('...')` fields not present in any ACF JSON.
- Dynamic includes using `~` concatenation are never flagged.

### 7. Template Context panel
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

### 8. Create block templates from ACF layouts
**Timber Lens: Create Block Template from ACF Layout** (also the ＋ button on
the Timber Context view) lists your flexible content layouts and creates
`blocks/<layout>.twig`, pre-filled with markup for every sub field: headings,
text, links, images, repeater loops and so on, read from the loop variable
your templates already use (`block` by default). Layouts that already have a
template open it instead.

### 9. Editable ACF field structure
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
under a `group` or `repeater`. Edit it, then use the CodeLens above it:

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

### Nice-to-haves
- Cmd/Ctrl-click a Twig include path to open the file.
- Fallback built-in Timber globals: `post`, `site`, `user`, `menu`.

## Settings

| Setting | Default |
| --- | --- |
| `timberLens.twigRoots` | `["views", "templates", "components", "blocks", "partials"]` |
| `timberLens.acfJsonPaths` | `["acf-json"]` |
| `timberLens.phpScanGlobs` | `["**/*.php"]` |
| `timberLens.enableBuiltinGlobals` | `true` |
| `timberLens.assumePostVariables` | `true` |

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
