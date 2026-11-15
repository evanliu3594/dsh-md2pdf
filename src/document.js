/**
 * The printed document shell: one self-contained HTML page whose stylesheet
 * targets paper rather than a screen pane.
 *
 * The same shell carries both markdown bodies — the pandoc fragment and the
 * built-in renderer's markup — so a document looks the same whichever produced
 * it. Relative image paths resolve against `<base href>`, which points at the
 * source file's directory, so the shell never has to sit beside the document.
 */

/** Font families tried in order for body text; the first two carry CJK glyphs. */
const BODY_FONTS = [
  '"Segoe UI"', '"Microsoft YaHei"', '"PingFang SC"', '"Hiragino Sans GB"',
  '"Noto Sans CJK SC"', '"Source Han Sans SC"', '"WenQuanYi Micro Hei"',
  'system-ui', 'sans-serif',
].join(', ')

/** Font families tried in order for code and preformatted text. */
const MONO_FONTS = [
  '"Cascadia Mono"', '"Cascadia Code"', 'Consolas', '"SF Mono"', 'Menlo',
  '"DejaVu Sans Mono"', '"Noto Sans Mono CJK SC"', 'monospace',
].join(', ')

/**
 * @typedef {object} PageOptions
 * @property {string} size - CSS page size keyword, such as `A4`.
 * @property {number} marginMm - uniform page margin in millimetres.
 * @property {number} fontSize - root font size in CSS pixels.
 * @property {boolean} landscape - whether the page is wider than tall.
 */

/** Default page geometry, matching an ordinary A4 report. */
export const DEFAULT_PAGE = Object.freeze({
  size: 'A4',
  marginMm: 18,
  fontSize: 15,
  landscape: false,
})

/**
 * The page policy carried inside the printable document itself.
 *
 * The DSH path is guarded by the resource server's response header. This meta
 * tag is what guards the browser fallback, where the page is loaded from a
 * `file:` URL and no response header exists. `file:` is allowed for images,
 * fonts, and the base URL only, which is what a local document with relative
 * assets needs; scripts, frames, objects, forms, and network access stay off.
 */
export const PRINT_CSP = [
  "default-src 'none'",
  "img-src 'self' data: file:",
  "style-src 'unsafe-inline'",
  "font-src 'self' data: file:",
  "script-src 'none'",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'self' file:",
].join('; ')

/** The paper stylesheet; `page` values are interpolated once per document. */
function stylesheet(page) {
  const margin = page.marginMm
  return `
@page {
  size: ${page.size}${page.landscape ? ' landscape' : ''};
  margin: ${margin}mm;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  padding: 0;
  background: #ffffff;
  color: #1c1f23;
  font-family: ${BODY_FONTS};
  font-size: ${page.fontSize}px;
  line-height: 1.72;
  font-variant-numeric: tabular-nums;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
  overflow-wrap: break-word;
  word-break: normal;
}
main { display: block; }
h1, h2, h3, h4, h5, h6 {
  margin: 1.6em 0 0.6em;
  line-height: 1.32;
  font-weight: 650;
  color: #101318;
  break-after: avoid-page;
  page-break-after: avoid;
}
h1 { font-size: 1.85em; margin-top: 0; padding-bottom: 0.24em; border-bottom: 1px solid #e2e5ea; }
h2 { font-size: 1.45em; padding-bottom: 0.18em; border-bottom: 1px solid #eceef2; }
h3 { font-size: 1.22em; }
h4 { font-size: 1.08em; }
h5, h6 { font-size: 1em; color: #4a5158; }
h2 + p, h3 + p, h4 + p, h1 + p { margin-top: 0.2em; }
p { margin: 0.7em 0; }
a { color: #1b62c4; text-decoration: none; border-bottom: 1px solid rgba(27, 98, 196, 0.28); }
strong { font-weight: 650; }
em { font-style: italic; }
del { color: #6b7280; }
mark { background: #fff3b0; }
small { font-size: 0.86em; color: #5b6470; }
hr { height: 1px; border: 0; margin: 1.8em 0; background: #e2e5ea; }
img, svg, video, canvas {
  max-width: 100%;
  height: auto;
  break-inside: avoid;
  page-break-inside: avoid;
}
figure { margin: 1.2em 0; text-align: center; break-inside: avoid; }
figcaption { margin-top: 0.5em; font-size: 0.86em; color: #5b6470; }
ul, ol { margin: 0.7em 0; padding-left: 1.6em; }
li { margin: 0.25em 0; }
li > ul, li > ol { margin: 0.25em 0; }
li.task-item { list-style: none; margin-left: -1.35em; }
li.task-item input[type="checkbox"] { margin-right: 0.45em; vertical-align: 0.06em; }
dl { margin: 0.9em 0; }
dt { font-weight: 650; }
dd { margin: 0 0 0.5em 1.4em; }
blockquote {
  margin: 1em 0;
  padding: 0.15em 0 0.15em 1em;
  border-left: 3px solid #c8d2de;
  color: #414a54;
  background: #f7f9fb;
  break-inside: avoid;
}
blockquote > :first-child { margin-top: 0.5em; }
blockquote > :last-child { margin-bottom: 0.5em; }
code, kbd, samp {
  font-family: ${MONO_FONTS};
  font-size: 0.88em;
  background: #f1f3f6;
  border-radius: 3px;
  padding: 0.12em 0.32em;
}
pre {
  margin: 1em 0;
  padding: 0.85em 1em;
  background: #f6f8fa;
  border: 1px solid #e4e8ee;
  border-radius: 6px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  break-inside: avoid;
  page-break-inside: avoid;
}
pre code { background: none; padding: 0; font-size: 0.86em; border-radius: 0; }
pre code span { background: none; }
table {
  width: 100%;
  margin: 1.1em 0;
  border-collapse: collapse;
  font-size: 0.94em;
  break-inside: auto;
}
thead { display: table-header-group; }
tr { break-inside: avoid; page-break-inside: avoid; }
th, td {
  border: 1px solid #dfe4ea;
  padding: 0.42em 0.62em;
  text-align: left;
  vertical-align: top;
}
th { background: #f2f5f8; font-weight: 650; }
tbody tr:nth-child(even) td { background: #fbfcfd; }
table.frontmatter {
  margin: 0 0 1.6em;
  font-size: 0.9em;
  border: 1px solid #e4e8ee;
  border-radius: 6px;
}
table.frontmatter th {
  width: 22%;
  white-space: nowrap;
  color: #4a5158;
  font-weight: 600;
  background: #f7f9fb;
  border-color: #eceef2;
}
table.frontmatter td { border-color: #eceef2; }
.table-caption {
  margin: 1.1em 0 0.4em;
  text-align: center;
  font-weight: 600;
  break-after: avoid-page;
  page-break-after: avoid;
}
.table-note { margin: 0.4em 0 1.1em; font-size: 0.9em; }
.frontmatter-caption {
  margin: 0 0 0.4em;
  font-size: 0.76em;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #8a929c;
}
.math {
  font-family: ${MONO_FONTS};
  font-size: 0.9em;
  color: #2b3a4a;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
math { font-size: 1.05em; }
details { margin: 0.9em 0; padding: 0.5em 0.8em; border: 1px solid #e4e8ee; border-radius: 6px; }
summary { cursor: default; font-weight: 600; }
.katex-display, .math-display { break-inside: avoid; text-align: center; margin: 1em 0; }
.footnotes { margin-top: 2.4em; padding-top: 0.8em; border-top: 1px solid #e2e5ea; font-size: 0.9em; }
sup, sub { line-height: 0; }
.md2pdf-toc { break-before: page; page-break-before: always; margin: 0 0 1.2em; }
.md2pdf-toc-title { margin: 0 0 0.9em; font-size: 1.2em; font-weight: 650; text-align: center; text-indent: 0; }
.md2pdf-toc ol { margin: 0; padding-left: 0; list-style: none; }
.md2pdf-toc li { margin: 0.28em 0; text-indent: 0; }
.md2pdf-toc-level-2 { padding-left: 1.4em; }
.md2pdf-toc-level-3 { padding-left: 2.8em; }
.md2pdf-toc a { color: inherit; border-bottom: none; text-decoration: none; }
.md2pdf-body { break-before: page; page-break-before: always; }
.md2pdf-pagebreak { break-after: page; page-break-after: always; height: 0; margin: 0; }
.md2pdf-paper { margin: 0 0 1.6em; text-align: center; }
.md2pdf-paper-title { margin: 0 0 0.5em; font-size: 1.8em; font-weight: 700; line-height: 1.35; text-indent: 0; }
.md2pdf-paper-authors { margin: 0 0 0.3em; text-indent: 0; }
.md2pdf-paper-affiliations { margin: 0 0 0.6em; font-size: 0.86em; color: #4a5158; text-indent: 0; }
.md2pdf-paper-date { margin: 0 0 1em; font-size: 0.86em; color: #4a5158; text-indent: 0; }
.md2pdf-paper-abstract, .md2pdf-paper-keywords { text-align: left; font-size: 0.9em; margin: 0.6em 0; text-indent: 0; }
.md2pdf-paper-label { font-weight: 650; }
`.trim()
}

/** Escape a value for an HTML attribute or text node. */
function escape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Assemble the printable page.
 *
 * Order inside the body is deliberate: the paper block opens the first body
 * page, the front matter table follows it, the TOC sits on its own page, and
 * the body starts a new page after the TOC. Without a TOC the body is emitted
 * unwrapped, so an ordinary document keeps its exact previous markup.
 * @param input - document title, base URL, paper block, front matter, TOC, body
 *   markup, theme layer, user CSS, and the page override layer.
 * @param page - page geometry and typography.
 * @returns a complete HTML document.
 */
export function buildHtml(input, page = DEFAULT_PAGE) {
  const base = input.baseHref === undefined ? '' : `<base href="${escape(input.baseHref)}">`
  const frontmatter = input.frontmatter === '' || input.frontmatter === undefined
    ? ''
    : `<p class="frontmatter-caption">Front matter</p>${input.frontmatter}`
  const paper = typeof input.paper === 'string' ? input.paper : ''
  const toc = typeof input.toc === 'string' ? input.toc : ''
  const body = input.bodyAfterToc === true
    ? `<div class="md2pdf-body">\n${input.body}\n</div>`
    : input.body
  // The optional blocks carry their own trailing newline, so a document with
  // neither a paper block nor a TOC keeps exactly the previous body markup.
  const paperPrefix = paper === '' ? '' : paper + '\n'
  const tocPrefix = toc === '' ? '' : toc + '\n'
  // Four layers, later winning: the structural sheet, the selected preset, the
  // user's own rules, and finally the explicit page override for this export.
  const theme = typeof input.themeCss === 'string' && input.themeCss.trim() !== ''
    ? `<style id="md2pdf-theme">\n${safeCss(input.themeCss)}\n</style>`
    : ''
  const custom = typeof input.customCss === 'string' && input.customCss.trim() !== ''
    ? `<style id="md2pdf-custom">\n${safeCss(input.customCss)}\n</style>`
    : ''
  const pageCss = typeof input.pageCss === 'string' && input.pageCss.trim() !== ''
    ? `<style id="md2pdf-page">\n${safeCss(input.pageCss)}\n</style>`
    : ''
  return `<!doctype html>
<html lang="${escape(input.lang ?? 'zh-CN')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="dsh-md2pdf">
<meta http-equiv="Content-Security-Policy" content="${escape(PRINT_CSP)}">
<title>${escape(input.title)}</title>
${base}
<style>
${stylesheet(page)}
</style>
${theme}
${custom}
${pageCss}
</head>
<body>
<main>
${paperPrefix}${frontmatter}
${tocPrefix}${body}
</main>
</body>
</html>
`
}

/**
 * Neutralize the one sequence that could end a style element early.
 * @param css - stylesheet text.
 * @returns the text with any closing tag escaped.
 */
function safeCss(css) {
  return css.replace(/<\/style/gi, '<\\/style')
}
