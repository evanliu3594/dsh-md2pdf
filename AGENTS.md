# AGENTS.md

Guidance for AI coding agents and human contributors working in this repository. It records the invariants that are expensive to rediscover and the commands that prove a change is safe.

## What this repository is

A DeepSeek Harness (DSH) bundle plugin. The Host half registers HTTP routes and one model tool; the Client half registers sidebar actions and a settings page. The plugin turns a Markdown file into a PDF beside it, using a preset stylesheet from a per-user preset library.

There is no build step. The published package is the source.

## Invariants

Break one of these and something is lost: a user's presets, the security boundary, or an export.

1. Write order in the preset store: the CSS file first, `presets.json` second. The index is the authority, so an interrupted write may leave an unreferenced stylesheet and must never leave an entry without one.
2. A preset id matches `^[a-z0-9-]{1,64}$`. Never interpolate an unchecked id into a filesystem path. `presetCssPath()` is the only place that joins an id into a path.
3. Every route calls `ctx.connection.requestRejection()` before doing any work. Never add a route that skips the fence.
4. An export writes exactly `<source dir>/<source stem>.pdf`. No other target is acceptable.
5. The Open action accepts only a preset id from the index. The client must never send a filesystem path for it.
6. User files live under `MD2PDF_HOME`. Nothing outside that directory is read or written as state.
7. The version stays at `0.1.0` until a release is made. Do not bump it as part of a feature.
8. Runtime dependencies stay at one: `temml`. The plugin must work on a machine with no pandoc, no LaTeX and no other command-line tool.
9. A preset's CSS is user data. It is inserted as text with `</style` escaped; it is never evaluated as code.

## Layout

```
index.js          Host entry: five routes, the md2pdf_export tool, failure mapping
client.js         Client entry: menus, toolbar control, settings page, dialogs, copy
src/markdown.js   Built-in CommonMark + GFM renderer with footnotes and TeX hooks
src/math.js       Lazy temml import, falls back to styled source
src/themes.js     Shipped presets as CSS text plus their display names
src/presets.js    Preset store: seeding, migration, CRUD, ordering, action dispatcher
src/opener.js     Platform launcher for "open with the default application"
src/previews.js   One preview document per preset, margin read back from the sheet
src/settings.js   User directory resolution and the stylesheet size limit
src/document.js   Printable HTML shell and the structural stylesheet
src/html-build.js Markdown-to-body step and document assembly
src/export.js     Export orchestration and capability reporting
src/pdf.js        Printer discovery, headless printing, flush waiting
src/proc.js       PATH lookup and subprocess execution with file-redirected output
```

Host code is ESM under `type: module`. The client half is a classic script loaded through `window.__ModuleLoader__`; its module id must equal the package name.

## Commands

```powershell
npm test                  # four suites, expected 82 / 37 / 23 / 5
node scripts/list-audit.mjs
node scripts/export-cli.mjs samples/sample.md --html out.html
node scripts/pdf-info.mjs samples/sample.pdf
```

`npm test` is the gate. It must print `82/82`, `37/37`, `23/23` and `5/5` checks passed. `list-audit` must print `failures: builtin=0 markdown(old)=0 gfm+math=0`.

Two facts about this environment: the Host module generation is cached per process, so a change under `src/` or to `index.js` needs a DSH restart; a client-only change needs a page refresh. Printing needs a Chromium-based browser, and a real print check starts that browser.

## Conventions

- Exported functions carry JSDoc with `@param` and `@returns`. Helpers that need none stay plain.
- Comments and identifiers are English. User-facing copy is bilingual: add a key to both dictionaries in `client.js`, and to both `locale/*.json` files for the plugin page.
- Error codes come from `PdfError` and map to HTTP statuses in `FAILURE_STATUS`. Add a code and a status together.
- Prefer a new small module over growing `client.js`. The settings section is the one place that is deliberately large.
- Preset CSS lives in `src/themes.js` as a template literal and is also written to disk on first use. The two must agree: the "GB" badge and the restore action compare against `themeCss()`.

## Change recipes

Add a built-in preset:

1. Write the CSS constant in `src/themes.js`, Latin faces first in every family stack.
2. Add an entry to `THEMES` with `id`, `label`, `labelEn` and `note`.
3. Run `npm test`; `presets-check` asserts the seeded preset count and ids.
4. Regenerate the samples in `samples/` with `MD2PDF_HOME` pointed at a throwaway directory.

Change the stored shape:

1. Extend `migrateLegacy()` in `src/presets.js` so an existing directory still opens.
2. Add a check to `scripts/presets-check.mjs` that starts from the old layout.
3. Verify that an export after migration equals the one before, byte for byte, by printing the same sample twice.

Add a route:

1. Declare the path as an exported constant in `index.js`.
2. Register it inside `ctx.effect(() => ctx.webServer.register(...))` and keep the fence first.
3. Document it in the security section of both README files.

## What not to do

- Do not add a dependency without a stated reason and a note in the README.
- Do not read or write user state outside `MD2PDF_HOME`.
- Do not trust an id, a name or a path from the client.
- Do not print from a sandboxed helper that cannot reach the browser; the flush-wait in `src/pdf.js` depends on watching the target file.
- Do not commit the design notes in `specs/`; that directory is local.

## Licence

MIT. Contributions are accepted under the same terms.
