<p align="center">
  <img src="https://raw.githubusercontent.com/evanliu3594/dsh-md2pdf/main/icon.svg" width="96" height="96" alt="dsh-md2pdf">
</p>

<h1 align="center">dsh-md2pdf</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-md2pdf"><img src="https://img.shields.io/npm/v/dsh-md2pdf.svg" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/dsh-md2pdf"><img src="https://img.shields.io/npm/dm/dsh-md2pdf.svg" alt="npm downloads"></a>
  <a href="https://github.com/evanliu3594/dsh-md2pdf/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/dsh-md2pdf.svg" alt="license"></a>
  <a href="https://github.com/evanliu3594/dsh-md2pdf/blob/main/package.json"><img src="https://img.shields.io/node/v/dsh-md2pdf.svg" alt="node version"></a>
  <a href="https://www.dsh.so/artifact/dsh-md2pdf-3/?ref=badge"><img src="https://cdn.dsh.so/badge/dsh-md2pdf-3.svg" alt="dsh.so risk"></a>
</p>

<p align="center">English | <a href="https://github.com/evanliu3594/dsh-md2pdf/blob/main/README.md">中文</a></p>

Export the Markdown open in a DeepSeek Harness sidebar file tab to a PDF beside the source file. The printed page style comes from editable presets.

## What it is

A DSH sidebar plugin. Open a `.md` file in the right-hand file tab, right-click or press one button, and a PDF with the same name appears in the same directory.

- Three entry points: a file-tree row, the file tab toolbar, and the file tab path label.
- No external tools: no pandoc, no LaTeX, no command-line program. Rendering happens inside the plugin.
- Editable presets: each preset is one CSS file. Apply, edit, create, reorder and delete them, and open a preset's stylesheet in your own editor.
- Chinese national-standard layouts: an official document preset built on GB/T 9704-2012 and an academic paper preset built on GB/T 7713.2-2022, both with three-line tables.
- Prints with DSH: the Desktop app prints through its own Chromium, with no extra browser process; the Web GUI falls back to Edge, Chrome or another Chromium browser.
- Page features: centered page numbers, configurable headers and footers, PDF outline bookmarks, a clickable table of contents, paper title fields, and an explicit page break.
- One-off document overrides: page, header, footer, page numbers and contents apply to the exports of this window only. The source file never changes.
- Agent-callable: the `md2pdf_export` tool exports any Markdown path.

## Result

The first page of one sample document, laid out by each built-in preset:

| Official document | Academic paper | Lark |
|---|---|---|
| [![Official document](https://raw.githubusercontent.com/evanliu3594/dsh-md2pdf/main/docs/images/preset-gongwen.png)](https://github.com/evanliu3594/dsh-md2pdf/blob/main/samples/sample-gongwen.pdf) | [![Academic paper](https://raw.githubusercontent.com/evanliu3594/dsh-md2pdf/main/docs/images/preset-paper.png)](https://github.com/evanliu3594/dsh-md2pdf/blob/main/samples/sample-paper.pdf) | [![Lark](https://raw.githubusercontent.com/evanliu3594/dsh-md2pdf/main/docs/images/preset-lark.png)](https://github.com/evanliu3594/dsh-md2pdf/blob/main/samples/sample-lark.pdf) |

Click an image to open the full PDF. All three live in `samples/`.

The official document preset uses a 156×225 mm type area, 16 pt FangSong body text on a 29 pt pitch, 22 lines of 28 characters per page. The paper preset uses 25/22 mm margins and 10.5 pt Song body text with a 16 pt Heiti title. Both separate Latin from Chinese: letters and digits take Times New Roman, Chinese characters fall back to FangSong, Heiti or Song.

## Install

The plugin is published on npm: [dsh-md2pdf](https://www.npmjs.com/package/dsh-md2pdf), currently 0.1.1.

Add a version range to the DSH profile's `package.json`:

```json
{ "dependencies": { "dsh-md2pdf": "^0.1.1" } }
```

```powershell
pnpm install
```

For a source checkout, use a link so edits take effect immediately, then run `pnpm install`:

```json
{ "dependencies": { "dsh-md2pdf": "link:/path/to/dsh-md2pdf" } }
```

On Windows, write the path as `link:C:/path/to/dsh-md2pdf`.

Either way, add `dsh-md2pdf` to `dsh.profile.bundles` in the same file and restart DSH.

Requirement: Node.js 20.11 or newer.

Two environments:

- DSH Desktop: prints through the app's own Chromium and opens the PDF in the right sidebar; works on Windows and macOS.
- Web GUI: there is no client printer, so the plugin falls back to a local Chromium-based browser (Edge, Chrome, Chromium or Brave). That fallback prints the body and pagination only; headers, footers, page numbers and the PDF outline are unavailable.

## Usage

The plugin works on file tabs opened in the right sidebar. Markdown rendered in a chat message is out of scope; open the `.md` file as a tab first.

| Where | Action | Scope |
|---|---|---|
| Sidebar file tree | Right-click → Export to PDF | `.md` and the other Markdown extensions |
| File tab toolbar | Click the PDF icon | The Markdown open in that tab |
| File tab path label | Right-click → Export to PDF | The Markdown open in that tab |
| Settings → dsh-md2pdf | Choose and edit presets, page settings | Global |
| Settings → dsh-md2pdf | Refresh the print engine, test print | Global |
| Settings → dsh-md2pdf | Document overrides: page, header, footer, page numbers, contents | This window's exports |
| Settings → dsh-md2pdf | Diagnostics: engine, fonts, last error, plugin folder | Global |
| `md2pdf_export` tool | Called by an agent | Any Markdown path |

The output path is fixed: `<source dir>/<source stem>.pdf`. An existing PDF is overwritten. A test print writes under the plugin folder (`MD2PDF_HOME/test-print`) and never enters a workspace.

## Printing and page style

Configure one export with flat `pdf.*` front matter keys:

```
---
title: Example document
pdf.preset: gongwen
pdf.page.size: A4
pdf.page.marginMm: 20
pdf.header: Internal
pdf.footer: Page {page} of {total}
pdf.pageNumbers: true
pdf.toc: true
---
```

- Page numbers: the default footer is "第 {page} 页 / 共 {total} 页", centered, on every page.
- Header and footer variables: `{page}`, `{total}`, `{title}`, `{author}`, `{date}`; every segment is escaped.
- Contents: a clickable h1–h3 list on its own page; the body starts on the next page; no page numbers in the contents.
- Outline: PDF viewer bookmarks, on by default, turned off with `pdf.outline: false`.
- Paper fields: `pdf.paper.title`, `authors`, `affiliations`, `abstract`, `keywords` and `date` render in the academic paper preset only, with no separate cover.
- Explicit page break: a line holding `<!-- pagebreak -->`.
- Margins come from the final `@page`; the official document's 37/26/35/28 mm box is not replaced by a default.

Out of scope in v2: cover pages, a full red-head template, watermarks, contents page numbers, figure and table cross references, batch export, and book assembly.

## Interface

The settings page reads top to bottom: print engine, page settings and document overrides, the preset library, the CSS editor with the selected preset's preview, the font table, and diagnostics.

A card carries three hot zones, shown on hover:

- Upper part: use this preset.
- Blue bar underneath: load that preset's CSS into the editor.
- Trash icon in the top-right corner: delete, after confirmation.

A thumbnail is that preset's real rendering, scaled down, so colours, type scale, page margins and table rules match the exported PDF. The official document and academic paper presets carry a GB badge.

The editor title names the preset being edited and adds an "unsaved" badge once you change something. Saving opens a name dialog prefilled with the current name; a name already used by another preset asks before replacing it, and a new name creates a preset. The toolbar also offers New, Reload, Move up and Move down, plus Restore built-in presets once one has been deleted. The selected preset's first-page preview sits directly under the editor.

Three buttons sit under the preset cards:

- Export presets downloads one JSON file with every preset's stylesheet, page settings and the current selection.
- Import presets reads that file. New presets are added; an existing preset asks before its stylesheet and page settings are replaced.
- History lists the last 20 stylesheets saved before a change for the current preset, and restores any snapshot. A snapshot is recorded before each save, and a restore records the stylesheet it replaces.

The bundle holds stylesheet text and metadata only. It carries no path, so it moves between machines.

The Open button beside the stylesheet path hands the current preset's CSS to your own editor. Save, then the next export uses it; no restart.

The top of the page shows the active print engine, with Refresh and Test print beside it. A test print renders one sample page with a page-number footer and two headings, which checks both the printer and the page features. The Page section stores paper size, orientation, margins and body size on the current preset.

A checkbox under the Page section, "Apply the current preset stylesheet to the sidebar Markdown preview", is off by default. When checked, the preset's type, colours, heading levels, tables and code styles apply to Markdown file previews; `@page` margins are ignored and the DSH container keeps its padding. It only changes styling: no contents page, paper block or page breaks appear in the preview.

Document overrides apply to this window's later exports only: page, header, footer, page numbers and contents. Apply to this window turns them on; Clear overrides returns to the file's values. Neither the source file nor the preset changes.

Diagnostics shows the engine, font counts, the last error and the plugin folder, and copies a JSON report. It contains no document content.

## More

Preset file format, migration rules, style layering, the printing pipeline, routes and the security boundary, and the full list of limitations: [docs/DESIGN.md](https://github.com/evanliu3594/dsh-md2pdf/blob/main/docs/DESIGN.md) (Chinese).

## License and credits

MIT, see [LICENSE](https://github.com/evanliu3594/dsh-md2pdf/blob/main/LICENSE).

The Lark preset takes its palette, type scale, line height and spacing from the published design parameters of [imageslr/mweb-themes](https://github.com/imageslr/mweb-themes). That repository declares no licence, so this project copied none of its SCSS; the print CSS was written from those parameters.

The official document and academic paper presets follow GB/T 9704-2012 and GB/T 7713.2-2022.
