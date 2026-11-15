# v2 handoff

Branch: v2-dsh-printing
Base: 15dfbd9 (main at the branch point)
Code head: 4343056 (32 commits); this record is one docs commit later
Date: 2026-11-15
Design: docs/DESIGN.md
Verification: docs/V2-VERIFICATION.md
S1 evidence: docs/S1-CHECKLIST.md

## What shipped

- DSH client printing: an ephemeral loopback asset server, a print job per
  export, a leased webview in the DSH client, printToPDF with Host-built
  options, and an atomic finish. The browser fallback remains for the Web GUI
  and installs without a Desktop client.
- Page model: pdf.page.size/marginMm/fontSize/landscape, preset page metadata,
  and the precedence row defaults < front matter < request. Margins come from
  the final @page box; the gongwen 37/26/35/28 mm box survives.
- Print options: centered page numbers on every page, header and footer
  templates with {page}/{total}/{title}/{author}/{date}, an inert template on
  the unconfigured side so Chromium cannot add its own header/footer, PDF
  outline on by default, and pdf.outline as a recognized key.
- Renderer: heading ids md2pdf-h-<slug> with collision-free suffixes, a
  clickable h1-h3 contents page, an explicit page-break comment, and the paper
  title block for the paper preset. Front matter lang selects the language.
- DSH preview and font diagnostics, centered page numbers, and the agent print
  broker: md2pdf_export waits 10 s for a client, routes the job through the
  same client printer, and falls back only for failures that cannot have
  written the target.
- Finish write lease: a commit takes a finishing lease before the first await;
  external fail is refused and the deadline sweep skips a live write. A stuck
  write expires after 30 s.
- Settings: engine status with Refresh and Test print, page settings saved to
  the preset, one-off document overrides for this window (page, header, footer,
  page numbers, contents), font table, diagnostics with Copy JSON, and preset
  export/import/history.
- Preset bundles: version 2 JSON with every preset's stylesheet, page metadata,
  description, and the selection; import validates all entries before writing,
  reports conflicts, and replaces only after confirmation. History keeps the
  last 20 stylesheets per preset under MD2PDF_HOME/history/<id>/.
- Test print: a fixed page under MD2PDF_HOME/test-print, printed through the
  configured engine; no workspace write.

## Automatic verification

Thirteen suites, green on Node 26.13.1 and Node 24.21.0 at 4343056:

    203 render / 80 document config / 131 print options / 116 presets
     25 previews / 70 dsh preview / 5 printer / 42 print server
     80 print jobs / 139 export / 95 after export / 294 broker / 107 client UI

list-audit: failures: builtin=0 markdown(old)=0 gfm+math=0.
node --check passes on every changed JS file; git diff --check is clean.

## S1 result (2026-11-14)

- Windows: PASS. DSH export (gongwen) 4 pages, A4, 332,192 bytes, fonts
  FangSong/KaiTi/STZhongsong/SimHei; file-busy verified; no new Edge/Chrome
  child process.
- macOS: PASS with one accepted exception. DSH export 4 pages, A4, fonts
  STFangsong/STKaiti/Songti; pages 1, 2 and 4 start at 32.68-34.24 mm instead of
  37 mm because of the Mac STFangsong Type3 glyph box. The user accepted the
  3.8 mm deviation on 2026-11-14.
- Details and exact output: docs/S1-CHECKLIST.md.

## S2 result (2026-11-15, macOS)

Seven print cases ran through `md2pdf_export` after a DSH restart:

- gongwen: 4 pages, A4, left/right 28.05/25.74 mm, STFangsong/STKaiti
  embedded, page numbers centered, 9 outline entries. PASS.
- page numbers only, footer only, contents, paper fields, explicit page break:
  PASS.
- header only: PASS after the fix; the header now starts at 18 mm.
- test print: PASS; one A4 page at MD2PDF_HOME/test-print/test-print.pdf,
  224,171 bytes, Tagged yes, engine and path shown.
- viewer: PASS; a sidebar export of README.md opened in the right-sidebar
  preview (user report).

- browser engine: PASS; md2pdf_export returned engine browser in 1.38 s and
  wrote a 2-page PDF through Edge without a client lease.
- cancellation: PASS; the run deadline cancelled a 670-page export. The old
  27,322-byte PDF stayed unchanged, no staging file appeared, and a 15 s
  follow-up found no late write.

The first run at 9bd167f found two defects. Chromium only builds the PDF
outline when generateTaggedPDF is on, and the header template started at the
paper edge. Both are fixed at 4343056 and re-verified. Test print, the S3
close/cancel cases, S4, and the Windows matrix remain open.

## Manual gates still open

These need a DSH restart with this branch linked and, for the last one, a
Windows machine. Each case is listed with its expected result in
docs/V2-VERIFICATION.md.

- S2 is complete on macOS: all eight cases passed on 2026-11-15.
- S3 agent broker: client closed mid-job. The plain tool export, the browser
  engine, and cancellation passed on 2026-11-15. Cancellation used the run
  deadline (4 s) because two Stop-button attempts finished first (5.3 s and
  16.4 s); the old PDF and staging files were unchanged. The two-window case
  cannot run on this install, which cannot open a second DSH window; the
  busy-claim rule is covered by the print-jobs suite.
- S4 preset bundle and history: export, history list, and restore passed on
  2026-11-15. The conflict prompt appeared; whether Replace was clicked is not
  confirmed. The overwrite rule keeps the local name, which is why Lark stayed
  `Lark 测试`.
- Windows matrix: link and restart, S2/S3/S4 equivalents, Chinese/space paths,
  locked target, browser fallback.

## Deferred and out of scope

- Cover page, full red-head template, watermark.
- Contents page numbers, figure and table cross references.
- Batch export, watch mode, session/book/workspace level styles.
- Complex @page forms (:first, :left, named pages, margin-top and friends).
- A per-tab document override form. The shipped form applies to this window's
  later exports; the source file and the preset never change.
- Existing preset CSS files are not upgraded. Shipped preset CSS reaches new or
  restored presets; structural resets still apply to old ones.
- The browser fallback cannot print headers, footers, page numbers, or an
  outline, and returns no warnings. It also does not run the afterExport action.
- jobTimeoutMs and allowRemoteImages are listed in the design config table but
  are not wired in v2: the job deadline stays 120 s and remote images stay
  blocked by the CSP.
- A bundle is bounded at 16 MiB, which covers every preset at the 512 KiB
  stylesheet cap up to 32 presets; a larger library exceeds the route cap.

## Review trail

Per-task reviews and fix rounds are in .superpowers/sdd/PLAN/ (local-only):
task-7-review.md, task-8-review.md, task-9-review.md, and the task reports.

The whole-branch final review over 15dfbd9..3e7bed7 found 0 Critical and 4
Important findings; all four are fixed at the head:

- Windows system open: explorer.exe replaces cmd.exe start, so a file name
  containing & is never parsed as a shell command.
- Unsupported @page margins: !important is taken as the value; auto, calc, px
  and similar forms fall back to the uniform 18 mm box with a warning; one bad
  preset no longer blanks the preview route.
- Bundle import conflicts by id or by name; duplicate names inside a bundle are
  refused.
- A failed UI DSH print reports the job failure, so the Host closes the job and
  its loopback server before the browser fallback runs.
- Tests now cover the fence and method table of every route, the name
  conflict, the margin fallback, and the preview isolation.

The final-review commit also records two limitations honestly: the browser
fallback does not run afterExport, and jobTimeoutMs/allowRemoteImages are not
wired in v2. Manual S2/S3/S4 and the Windows matrix remain the only gates.

S2 also found two print-option defects; both are fixed at 4343056:

- generateDocumentOutline alone produces no outline; generateTaggedPDF is
  required. Both follow the pdf.outline switch.
- The header and footer templates now take the page's left and right margins as
  padding, so a left-aligned header starts at the text edge rather than the
  paper edge.

## Merge and release

1. Run the manual gates above; record each result in docs/V2-VERIFICATION.md.
2. Merge v2-dsh-printing into main after the final review verdict is recorded.
3. Keep the version at 0.1.0 until release. No runtime dependency was added.
4. If the samples or docs images should reflect the new renderer output,
   regenerate them with a one-off MD2PDF_HOME before publishing.
5. Push only after the user confirms; the branch is local so far.
