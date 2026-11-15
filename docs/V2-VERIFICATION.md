# v2 verification record

Branch: `v2-dsh-printing`
Commit under test: `779da8a` (2026-11-15)
Design: `docs/DESIGN.md`

This file records the automatic matrix and the manual gates. A row marked
`pending` is not a pass. Record command output, not a summary, in every manual
result line.

## Automatic matrix

`npm test` runs thirteen suites. Counts on 2026-11-15 at `779da8a`:

| Suite | Node 26.13.1 | Node 24.21.0 |
|---|---|---|
| render | 175/175 | 175/175 |
| document config | 75/75 | 75/75 |
| print options | 123/123 | 123/123 |
| presets | 107/107 | 107/107 |
| previews | 23/23 | 23/23 |
| dsh preview | 70/70 | 70/70 |
| printer | 5/5 | 5/5 |
| print server | 42/42 | 42/42 |
| print jobs | 80/80 | 80/80 |
| export | 138/138 | 138/138 |
| after export | 95/95 | 95/95 |
| broker | 273/273 | 273/273 |
| client UI | 105/105 | 105/105 |

`node scripts/list-audit.mjs` on both runtimes:
`failures: builtin=0 markdown(old)=0 gfm+math=0`.

`node --check` passes on every changed JavaScript file; `git diff --check` is clean.

## Manual S2: DSH print output

Preconditions:

- The Desktop profile links this worktree at `779da8a`; `printEngine: dsh`.
- DSH Desktop was restarted after the link, so `src/` changes are loaded.
- Poppler (`pdfinfo`, `pdffonts`, `pdftotext`) is available for measurement.

| Case | Source | Expected | Result |
|---|---|---|---|
| S2-1 gongwen baseline | `samples/sample.md` + gongwen | 4 pages, A4, margins 37/26/35/28 mm within 0.5 mm, STFangsong/STKaiti, right-sidebar PDF, outline bookmarks | pending |
| S2-2 page numbers only | front matter `pdf.pageNumbers: true` | footer page numbers centered on page 1 and the last page; header blank, with no date or title | pending |
| S2-3 header only | front matter `pdf.header: 内部资料` | header shows the text; footer blank, with no URL, asset token, or page number | pending |
| S2-4 footer only | front matter `pdf.footer: 页脚文字` | footer shows the text; header blank | pending |
| S2-5 contents | front matter `pdf.toc: true` | contents on its own page, links jump in the viewer, no page numbers inside the contents, body starts on the next page | pending |
| S2-6 paper fields | paper preset + `pdf.paper.title/authors/abstract/keywords` | title block on the first body page, no separate cover, English labels when `lang: en-US` | pending |
| S2-7 explicit page break | a line `<!-- pagebreak -->` | the following content starts on a new page; the same text inside a fenced block stays code | pending |
| S2-8 test print | Settings → Test print | one-page PDF under `MD2PDF_HOME/test-print`, engine reported, path shown | pending |

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
| S3-1 | Call `md2pdf_export` on a sample path | client prints, Host writes, tool returns `engine: dsh`; no preview, no toast | pending |
| S3-2 | Close or refresh the client during a job | `job-timeout`, loopback server closed, old PDF unchanged, no `.md2pdf-*.pdf.tmp` beside the source | pending |
| S3-3 | Set `printEngine: browser`, call the tool | browser result `engine: browser`; the client does not poll | pending |
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
  outline. It also does not return warnings. Only the DSH client path has them.
- A paper block renders only in the built-in paper preset. Shipped preset CSS
  is seeded once; existing preset files are not rewritten on upgrade, so the
  paper block styling reaches new or restored presets first.
- Page numbers are centered on every page. There is no cover page, red-head
  template, watermark, contents page numbers, or figure cross-reference.
- The contents title and the paper labels follow front matter `lang`
  (default `zh-CN`).
- The Mac STFangsong Type3 exception above is accepted for this version.
