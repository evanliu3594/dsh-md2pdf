# v2 verification record

Branch: `v2-dsh-printing`
Commit under test: `4343056` (2026-11-15)
Design: `docs/DESIGN.md`

This file records the automatic matrix and the manual gates. A row marked
`pending` is not a pass. Record command output, not a summary, in every manual
result line.

## Automatic matrix

`npm test` runs thirteen suites. Counts on 2026-11-15 at `4343056`:

| Suite | Node 26.13.1 | Node 24.21.0 |
|---|---|---|
| render | 203/203 | 203/203 |
| document config | 80/80 | 80/80 |
| print options | 131/131 | 131/131 |
| presets | 116/116 | 116/116 |
| previews | 25/25 | 25/25 |
| dsh preview | 70/70 | 70/70 |
| printer | 5/5 | 5/5 |
| print server | 42/42 | 42/42 |
| print jobs | 80/80 | 80/80 |
| export | 139/139 | 139/139 |
| after export | 95/95 | 95/95 |
| broker | 294/294 | 294/294 |
| client UI | 107/107 | 107/107 |

`node scripts/list-audit.mjs` on both runtimes:
`failures: builtin=0 markdown(old)=0 gfm+math=0`.

`node --check` passes on every changed JavaScript file; `git diff --check` is clean.

## Manual S2: DSH print output

Preconditions:

- The Desktop profile links this worktree at `4343056`; `printEngine: dsh`.
- DSH Desktop was restarted at 2026-11-15 15:40, so `src/` changes are loaded.
- Poppler (`pdfinfo`, `pdffonts`, `pdftotext`) is available for measurement.

| Case | Source | Expected | Result |
|---|---|---|---|
| S2-1 gongwen baseline | `samples/sample.md` + gongwen | 4 pages, A4, margins 37/26/35/28 mm within 0.5 mm, STFangsong/STKaiti, right-sidebar PDF, outline bookmarks | PASS for the PDF, 2026-11-15 15:40. 4 pages, A4 594.96x841.92 pt; left 28.05, right 25.74 mm; top 34.24/33.20/38.54/32.67 mm (accepted S1 exception); STFangsong/STKaiti/STSongti/PingFang/Times embedded; outline 9 entries under /Outlines; footer 第 N 页 / 共 4 页 centered at 106.0 mm on all pages. The agent path writes without a preview. Viewer PASS: a sidebar export of README.md opened the PDF in the right-sidebar preview (user report, 2026-11-15 15:38). |
| S2-2 page numbers only | front matter `pdf.pageNumbers: true` | footer page numbers centered on page 1 and the last page; header blank, with no date or title | PASS. 1 page; footer 第 1 页 / 共 1 页 at 105.0 mm; header empty. |
| S2-3 header only | front matter `pdf.header: 内部资料` | header shows the text; footer blank, with no URL, asset token, or page number | PASS after 4343056. Header starts at 18.00 mm from the left edge; footer empty. The first run at 9bd167f put it at 1.06 mm. |
| S2-4 footer only | front matter `pdf.footer: 页脚文字` | footer shows the text; header blank | PASS. Footer 页脚文字 at 105.0 mm; header empty. |
| S2-5 contents | front matter `pdf.toc: true` | contents on its own page, links jump in the viewer, no page numbers inside the contents, body starts on the next page | PASS. 2 pages; page 1 目录 with h1-h3; page 2 body; 4 /Link annotations with /Dest; no page numbers. |
| S2-6 paper fields | paper preset + `pdf.paper.title/authors/abstract/keywords` | title block on the first body page, no separate cover, English labels when `lang: en-US` | PASS. 1 page; title, authors, affiliation, date, Abstract, Keywords; English labels; no cover. |
| S2-7 explicit page break | a line `<!-- pagebreak -->` | the following content starts on a new page; the same text inside a fenced block stays code | PASS. 2 pages; page 1 分页测试 + 第一页内容; page 2 第二页内容; the comment text is absent. |
| S2-8 test print | Settings → Test print | one-page PDF under `MD2PDF_HOME/test-print`, engine reported, path shown | PASS 2026-11-15 15:36. test-print.pdf is 1 page, A4, 224,171 bytes, Tagged yes; the user reports the engine and path were shown. |

The first local run at 9bd167f found two defects: the PDF had no /Outlines,
and a header started 1 mm from the paper edge. Both are fixed at 4343056
(tagged PDF plus template padding), and the cases above were re-run.

The accepted S1 macOS exception still applies: pages 1, 2 and 4 of the gongwen
sample start at 32.68, 33.19 and 34.24 mm instead of 37 mm because of the Mac
STFangsong Type3 glyph box. The user accepted the 3.8 mm deviation on
2026-11-14. See `docs/S1-CHECKLIST.md`.

## Manual S4: preset bundle and history

| Case | Action | Expected | Result |
|---|---|---|---|
| S4-1 | Settings → Export presets | one JSON file downloads with every preset, its stylesheet, page metadata, and the selection | pending |
| S4-2 | Import the file on another machine | presets appear; a conflicting preset asks before its stylesheet and page settings are replaced | pending |
| S4-3 | Change a preset twice, open History | the last snapshots are listed newest first, at most 20 | pending |
| S4-4 | Restore an older snapshot | the editor and the next export use that stylesheet; the replaced stylesheet is itself in the history | pending |

## Manual S3: agent print broker

Preconditions: DSH Desktop running with this branch, `printEngine: dsh`, and a
fresh client window.

| Case | Action | Expected | Result |
|---|---|---|---|
| S3-1 | Call `md2pdf_export` on a sample path | client prints, Host writes, tool returns `engine: dsh`; no preview, no toast | PASS 2026-11-15. Seven fixtures returned `engine: dsh`, `generator: builtin`, and wrote the PDF beside the source. The tool result has no preview or toast field. |
| S3-2 | Close or refresh the client during a job | `job-timeout`, loopback server closed, old PDF unchanged, no `.md2pdf-*.pdf.tmp` beside the source | pending |
| S3-3 | Set `printEngine: browser`, call the tool | browser result `engine: browser`; the client does not poll | PASS 2026-11-15 15:47. The tool returned `engine: browser`, `generator: builtin`, 25,261 bytes in 1,376 ms. The PDF is 2 pages, A4, Skia/PDF m157, with no header, footer, or page numbers. The client path is not used. |
| S3-4 | Call the tool twice with two Desktop windows | tool jobs print one at a time; the second waits, then prints | pending |
| S3-5 | Cancel a running tool call | job ends failed or the in-flight commit settles; no orphan server or staging file | pending |

## Windows matrix

| Case | Expected | Result |
|---|---|---|
| Link the plugin into the Windows Desktop profile and restart | plugin row loads, engine reports DSH built-in | pending |
| S2-1 equivalent with a path containing Chinese and spaces | 4 pages, A4, margins within 0.5 mm, FangSong/KaiTi/SimSun, outline visible | pending |
| S2-2 to S2-8 equivalents | same as macOS | pending |
| Locked target PDF | second export reports `file-busy`, old PDF and hash unchanged, no staging file | pending |
| Browser fallback | `/md2pdf/export` prints through Edge or Chrome; no default headers or footers | pending |

## Known limitations

- The browser fallback cannot print headers, footers, page numbers, or a PDF
  outline. It also does not return warnings or run the afterExport action. Only
  the DSH client path has them.
- jobTimeoutMs and allowRemoteImages are documented but not wired in v2: the
  job deadline stays 120 s and remote images stay blocked by the CSP.
- A preset bundle is bounded at 16 MiB by the route; a library above that
  cannot be re-imported.
- A paper block renders only in the built-in paper preset. Shipped preset CSS
  is seeded once; existing preset files are not rewritten on upgrade, so the
  paper block styling reaches new or restored presets first.
- Page numbers are centered on every page. There is no cover page, red-head
  template, watermark, contents page numbers, or figure cross-reference.
- The contents title and the paper labels follow front matter `lang`
  (default `zh-CN`).
- The Mac STFangsong Type3 exception above is accepted for this version.
