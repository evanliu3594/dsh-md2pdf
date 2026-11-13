# dsh-md2pdf

English | [中文](README.md)

A DeepSeek Harness sidebar plugin that exports the Markdown open in a file tab to a PDF beside the source file, with a manageable library of printed-page presets.

## Contents

- [Features](#features)
- [Install](#install)
- [Usage](#usage)
- [Presets](#presets)
- [Preset files](#preset-files)
- [Configuration](#configuration)
- [Rendering and printing](#rendering-and-printing)
- [Security](#security)
- [Repository layout](#repository-layout)
- [Development](#development)
- [Known limitations](#known-limitations)
- [License and credits](#license-and-credits)

## Features

- One export action: open a Markdown file in a tab, then right-click or click the toolbar button.
- No external tools: no pandoc, no LaTeX, no command-line program. Rendering is built in.
- Editable presets: each preset is one CSS file. Apply, edit, create, reorder and delete them, and open a preset's stylesheet in your own editor.
- Chinese national-standard layouts: an official document preset built on GB/T 9704-2012 and an academic paper preset built on GB/T 7713.2-2022, both using three-line tables.
- Agent-callable: the `md2pdf_export` model tool exports any Markdown path.

## Install

The plugin installs into a DSH profile as a bundle. Add a dependency in the profile directory.

For a source checkout, depend on it by link so edits take effect immediately:

```json
{ "dependencies": { "dsh-md2pdf": "link:D:/path/to/dsh-md2pdf" } }
```

```powershell
pnpm install
```

Once the package is published to npm, a version range works instead:

```json
{ "dependencies": { "dsh-md2pdf": "^0.1.0" } }
```

Either way, add `dsh-md2pdf` to `dsh.profile.bundles` in the same file and restart DSH.

Requirements: Node.js 20.11 or newer, and one Chromium-based browser (Microsoft Edge, Google Chrome, Chromium or Brave). When the Host process can load Electron, the application's own process does the printing instead.

## Usage

The plugin works on file tabs opened in the right sidebar. Markdown rendered in a chat message is out of scope; open the `.md` file as a tab first.

| Where | How | Scope |
|---|---|---|
| Sidebar file tree row | Right-click → Export to PDF | `.md` and the other Markdown extensions |
| File tab toolbar | Click the PDF icon | The Markdown open in that tab |
| File tab path label | Right-click → Export to PDF | The Markdown open in that tab |
| Settings → dsh-md2pdf | Choose a preset, edit styles | Global |
| `md2pdf_export` tool | Called by an agent | Any Markdown path |

The output path is fixed: `<source dir>/<source stem>.pdf`. An existing PDF is overwritten.

## Presets

Settings treats presets as manageable templates. The default preset is Lark.

### Card

```
┌─────────────────────┐
│ [thumbnail]     ╭─╮ │ ← grey rounded bar, height 20%, with a trash icon
│                 ╰─╯ │
├─────────────────────┤ ← bottom 15%, blue bar with a pencil
│ ✎ Edit              │
└─────────────────────┘
   click the upper part = use this preset
```

The three hot zones appear on hover or keyboard focus. The upper part applies the preset, the blue bar loads its CSS into the editor below, and the trash icon asks for confirmation before deleting. The selected card carries a blue ring.

A thumbnail is that preset's real rendering, scaled down, so colours, type scale, page margins and table rules match the exported PDF.

### Edit and save

The editor title names the preset being edited and adds an "unsaved" badge once you change something. The buttons are Save, New, Reload, Move up, Move down.

Save opens a name dialog prefilled with the current preset's name:

- Same name: save in place.
- Name of another preset: ask before replacing that preset's stylesheet.
- New name: create a preset at the end of the list.

New clears the editor for a preset written from scratch. A name is required.

### Order and delete

Move up and Move down act on the preset being edited. They change the card order only; the export reads the preset in use.

Deleting asks for confirmation. Deleting the preset in use selects the first remaining one; deleting the last preset rebuilds the default Lark.

Removing a built-in preset makes a "Restore built-in presets" button appear in the toolbar. It adds back only the missing ones and leaves the others untouched.

### Open the stylesheet

An Open button beside the stylesheet path hands the current preset's CSS to the platform's default application. The client sends no path; the Host accepts only preset ids known to the index, builds the path from the id, and checks it stays inside `presets/`.

### Built-in presets

| Preset | Basis | Main features |
|---|---|---|
| Lark | Design parameters of the MWEB theme collection | Accent #3370ff, body #1f2329 at 16px / 1.68, headings without rules, light grey tables |
| Official document (红头公文) | GB/T 9704-2012 | Margins 37/35/28/26 mm, type area 156×225 mm, 16 pt FangSong on a 29 pt pitch, red Xiaobiaosong title with a red rule, three-line tables |
| Academic paper (学术论文) | GB/T 7713.2-2022 | 10.5 pt Song body, 16 pt Heiti title centred, graded Heiti headings, three-line tables |

An unmodified national-standard preset shows a "GB" badge on its thumbnail; the badge disappears once the CSS is edited.

Both national-standard presets separate Chinese from Latin text: letters, digits and Western punctuation use Times New Roman, and Chinese characters fall through to their own faces (FangSong, Heiti, KaiTi, Xiaobiaosong for the official document; Song and Heiti for the paper). Code blocks stay monospace, because Times New Roman is not monospaced and would break indentation.

### Three-line tables

Both national-standard presets draw three-line tables: 1.5 pt top and bottom rules, a 0.75 pt rule under the header, no vertical rules, no header fill.

The renderer recognises table captions and notes. A paragraph directly above a table starting with "表 1" or "Table 1" becomes a centred caption; a paragraph directly below starting with "注：", "注:" or "Note:" becomes a note.

```markdown
表1 版式预设

| 预设 | 版心 | 正文字体 |
|:-----|:-----|:---------|
| Lark | A4 | 无衬线 |

注：参数可在配置中覆盖。
```

Auxiliary rules go into the preset's CSS, for example `tbody tr + tr td { border-top: 0.5pt solid #999; }`.

## Preset files

```
$DSH_HOME/md2pdf/
  presets.json          { version, selected, presets: [{ id, name }] }
  presets/<id>.css      that preset's stylesheet
```

`presets.json` is the authority: its array order is the card order, and `selected` names the preset in use. A write puts the CSS file down first and the index second, so an interrupted write leaves an unreferenced stylesheet at worst.

Preset ids allow lowercase letters, digits and hyphens only. Both reads and writes reject an id that could escape the preset directory.

One stylesheet may be up to 512 KiB. The `MD2PDF_HOME` environment variable moves the whole directory.

### Migration from earlier versions

Versions before 0.1.0 kept the choice in `settings.json` and one shared override in `custom.css`. The first read migrates them:

1. The three built-in presets are written from their shipped stylesheets.
2. The old `custom.css` is appended to the preset the old choice pointed at.
3. The selection is carried over; it falls back to Lark when the old choice names a preset that no longer exists.
4. The old files are renamed to `settings.migrated.json` and `custom.migrated.css`, not deleted.

The exported layout after migration matches the one before.

### How a stylesheet takes effect

A preset's CSS is inserted verbatim as `<style id="md2pdf-theme">`, after the structural stylesheet. Any `</style` inside it is escaped, so the sheet cannot leave its style block. A saved change applies to the next export with no restart.

## Configuration

The row configuration is optional; every field has a default.

```yaml
- insert:
    - id: md2pdf
      name: dsh-md2pdf
      config:
        engine: auto          # auto | electron | browser
        renderer: builtin     # builtin | pandoc | auto
        browserPath: ''       # explicit Chromium-based browser
        pandocPath: ''        # explicit pandoc for renderer: pandoc
        timeoutMs: 120000
```

Environment variables:

| Variable | Effect |
|---|---|
| `MD2PDF_HOME` | Moves the preset library root; defaults to `$DSH_HOME/md2pdf` |
| `MD2PDF_BROWSER` | Path to the browser executable |

## Rendering and printing

Markdown to HTML:

- The built-in renderer `src/markdown.js` handles the CommonMark core plus GFM tables, task lists, strikethrough and autolinks, plus footnotes and TeX math.
- `temml` turns math into MathML, which the browser lays out natively with no embedded fonts. Without temml, formulas stay as monospaced source and the rest of the document is unaffected.
- The row configuration `renderer: pandoc` switches to pandoc with the reader fixed at `gfm-emoji+tex_math_dollars`, matching how DSH renders Markdown in the app.

HTML to PDF:

- When the Host process can load Electron, `BrowserWindow.printToPDF` prints without starting a second browser.
- Otherwise a Chromium-based browser runs headless with `--print-to-pdf`.
- The print process exits before the file is fully flushed, so the export polls the target until its content is complete instead of reading a half-written PDF.
- Page geometry defaults to A4, 18 mm margins and 15 px body text; configuration can override it.

## Security

Five routes are registered at `/md2pdf/capability`, `/md2pdf/export`, `/md2pdf/settings`, `/md2pdf/presets` and `/md2pdf/previews`. Each asks `ctx.connection.requestRejection()` first; that check validates the Host, the Origin and the browser login token, so only a local page can print, edit presets or open a file.

Request bodies must be `application/json` and are size limited. The export target can only be the same-directory sibling PDF of an existing Markdown file. The Open action accepts only preset ids known to the index; the client never supplies a path.

## Repository layout

```
index.js              Host half: five HTTP routes plus the md2pdf_export tool
client.js             Client half: menu item, toolbar button, settings page, toasts
src/markdown.js       Built-in Markdown renderer
src/math.js           Lazy temml loading and fallback
src/themes.js         Styles and names of the three built-in presets
src/presets.js        Preset library: index, reads, writes, ordering, actions
src/opener.js         Opening a file with the platform's default application
src/previews.js       Thumbnails for the settings page
src/settings.js       User file directory and the stylesheet size limit
src/document.js       Printable HTML template and structural stylesheet
src/html-build.js     Body generation and HTML assembly
src/export.js         Export orchestration
src/pdf.js            Printer discovery, headless printing, flush waiting
src/proc.js           PATH lookup and subprocess execution
locale/*.json         Titles, descriptions and detail pointers for the plugin page
docs/                 Detail document and feature image
scripts/              Development and diagnostic scripts
samples/              Sample Markdown and verified output
```

## Development

```powershell
npm install                      # temml, for local debugging only

npm test                         # all four suites
node scripts/export-cli.mjs samples/sample.md --html out.html
node scripts/pdf-info.mjs samples/sample.pdf
node scripts/list-audit.mjs      # 46 cases across 3 readers
node scripts/diagnose-lists.mjs <file.md>
```

The suites:

| Script | Checks | Covers |
|---|---|---|
| `render-check.mjs` | 82 | Rendering, presets, three-line tables, footnotes, math |
| `presets-check.mjs` | 37 | Store reads and writes, migration, ordering, deletion, corruption recovery |
| `preview-check.mjs` | 23 | Thumbnails and page margins |
| `printer-check.mjs` | 5 | Waiting for the printed file |

`scripts/export-cli.mjs` runs the same `exportMarkdownToPdf` the plugin uses, so rendering and printing can be verified without a running Harness.

## Known limitations

- No header, footer or page numbers. Chromium's command-line printing takes no custom footer template, so the page-number position required by GB/T 9704 and the header required by GB/T 7713.2 are not implemented.
- The official document preset renders a level-one heading as a red Xiaobiaosong title with a red rule to stand in for the red header. The issuing organ mark, document number, signatory and seal belong in the body or in custom CSS.
- The academic paper preset covers what can be typeset: paper size, type hierarchy, indentation, three-line tables and caption placement. Abstract, keywords and reference style follow GB/T 7714 and are written by the author.
- The "GB" badge shows only while a national-standard preset's CSS matches the shipped text.
- Ordering changes card order only; the export reads the preset in use.
- Open relies on the platform's file association. Without one it fails with a message and leaves the export untouched.
- Relative images rely on `<base href>` pointing at the source directory. Absolute `file:` references across drives may be refused by browser security policy.
- The built-in renderer emits no heading anchor ids and supports neither definition lists nor fenced divs.
- A PDF overwrites the file of the same name; no version history is kept.

### List recognition

The renderer follows the CommonMark list rules:

| Form | Recognised |
|---|---|
| `- item`, `* item`, `+ item` | Yes |
| `1. item`, `1) item` | Yes |
| A list on the line right after a paragraph | Yes |
| A list right after a heading | Yes |
| `1、item` | No — a Chinese numbering habit, not Markdown |
| `（1）item`, `①item` | No |
| `· item`, `• item` | No |
| `-item` (no space after the marker) | No |
| A whole line of `*text*` | Emphasis, not a list |

`scripts/diagnose-lists.mjs` reports the unrecognised forms line by line.

## License and credits

MIT, see [LICENSE](LICENSE).

The Lark preset takes its palette, type scale, line height and spacing from the published design parameters of [imageslr/mweb-themes](https://github.com/imageslr/mweb-themes). That repository declares no licence, so this project copied none of its SCSS; the print CSS was written from those parameters and extended with pagination rules.

The official document and academic paper presets follow GB/T 9704-2012 and GB/T 7713.2-2022.
