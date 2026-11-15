# v2 handoff

Branch: v2-dsh-printing
Base: 15dfbd9 (main at the branch point)
Head at handoff: 6baa058 (27 commits)
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

Thirteen suites, green on Node 26.13.1 and Node 24.21.0 at 6baa058:

    195 render / 75 document config / 123 print options / 107 presets
     23 previews / 70 dsh preview / 5 printer / 42 print server
     80 print jobs / 137 export / 95 after export / 283 broker / 105 client UI

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

## Manual gates still open

These need a DSH restart with this branch linked and, for the last one, a
Windows machine. Each case is listed with its expected result in
docs/V2-VERIFICATION.md.

- S2 print output: gongwen baseline, page-numbers-only, header-only,
  footer-only, contents, paper fields, explicit page break, test print. The
  single-side cases are required by the Task 8 review.
- S3 agent broker: tool export through the client, client closed mid-job,
  browser engine, two windows, cancellation.
- S4 preset bundle and history: export, import with conflicts, history list,
  restore.
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
task-7-review.md, task-8-review.md, task-9-review.md, task-9-review.md, and the
task reports. A whole-branch final review was dispatched over 15dfbd9..3e7bed7;
record its verdict here before merging.

## Merge and release

1. Run the manual gates above; record each result in docs/V2-VERIFICATION.md.
2. Merge v2-dsh-printing into main after the final review verdict is recorded.
3. Keep the version at 0.1.0 until release. No runtime dependency was added.
4. If the samples or docs images should reflect the new renderer output,
   regenerate them with a one-off MD2PDF_HOME before publishing.
5. Push only after the user confirms; the branch is local so far.
