/**
 * Preview documents for the settings page.
 *
 * The page shows one miniature page per preset and one larger preview of the
 * selected preset. Both are the real renderer's output, not a hand-drawn mock:
 * each preview is a complete HTML document built from the same stylesheet the
 * exporter uses, so a preset cannot look different here from what it prints.
 *
 * A preview is displayed in a fixed-size frame on a screen, where `@page` has
 * no effect. The effective page margin is therefore read back out of the
 * generated document and applied as body padding, which is what makes the
 * printed margins visible in the miniature.
 */
import { DEFAULT_PAGE } from './document.js'
import { renderDocument } from './html-build.js'
import { listPresets, readPreset } from './presets.js'

/**
 * Sample the previews render. Short enough to fit a miniature, varied enough to
 * show the headline, body, list, table and inline treatments of a preset.
 */
export const PREVIEW_MARKDOWN = `# 文档标题

正文示例，展示中文与 Latin text 的混排效果。

| 参数 | 取值 |
|---|---|
| 页边距 | 18mm |

- 列表项目一
- 列表项目二

\`行内代码\` 与 [链接示例](https://example.com)。
`

/**
 * Read the page margin the document will actually print with.
 *
 * The base stylesheet declares a uniform margin and a preset may replace it, so
 * the last declaration in document order wins — the same cascade the print
 * engine applies.
 * @param html - a complete printable document.
 * @returns the margin shorthand, falling back to the default geometry.
 */
export function pageMarginOf(html) {
  const matches = [...html.matchAll(/@page\s*\{[^}]*?margin\s*:\s*([^;}]+)/g)]
  const last = matches[matches.length - 1]
  return last === undefined ? `${DEFAULT_PAGE.marginMm}mm` : last[1].trim()
}

/**
 * Show the printed margins inside a screen frame.
 * @param html - a complete printable document.
 * @returns the document with the page margin applied as body padding.
 */
export function withPageFrame(html) {
  const style = `<style>html{background:#fff}body{padding:${pageMarginOf(html)};box-sizing:border-box}</style>`
  return html.includes('</head>') ? html.replace('</head>', `${style}</head>`) : `${style}${html}`
}

/**
 * Build one preview document from a stylesheet.
 * @param css - the preset's override layer.
 * @returns a complete HTML document.
 */
export async function previewHtml(css = '') {
  const rendered = await renderDocument({
    markdown: PREVIEW_MARKDOWN,
    title: 'preview',
    themeCss: typeof css === 'string' ? css : '',
    // A preview must never wait on an external tool, so it always uses the
    // built-in renderer even when the exporter is configured for pandoc.
    renderer: 'builtin',
  })
  return withPageFrame(rendered.html)
}

/**
 * Build every preview the settings page shows.
 * @returns one document per stored preset, plus the selected identifier.
 */
export async function buildPreviews() {
  const { selected, presets } = await listPresets()
  const built = {}
  for (const preset of presets) {
    built[preset.id] = await previewHtml((await readPreset(preset.id)).css)
  }
  return { presets: built, selected }
}
