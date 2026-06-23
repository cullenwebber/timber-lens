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
