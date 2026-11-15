/**
 * The printToPDF options one DSH print job receives.
 *
 * The Host builds this object and the client forwards it unchanged, so the
 * printed header, footer, page numbers, and PDF outline are decided in one
 * place. Header and footer templates are plain text from front matter: the
 * literal parts and every substituted value are HTML-escaped, so a document
 * title cannot inject markup into the print surface. Page numbers are Chromium
 * template spans, centered on every page; there is no cover-page branch.
 *
 * The outline defaults on. It is a plugin setting (outline), which front
 * matter may override with pdf.outline, and the request may override again.
 */

/** Default footer when page numbers are on and no footer text is set. */
export const DEFAULT_PAGE_FOOTER = '第 {page} 页 / 共 {total} 页'

/**
 * An inert template for the unconfigured side of a printed page.
 *
 * Chromium replaces a falsy header or footer template with its own default:
 * the header shows the date and the document title, the footer shows the URL
 * and the page number. An empty string is falsy, so a page with only a header
 * would also gain Chromium's URL (the loopback print URL carries the asset
 * token) and an unrequested page number. A non-empty invisible template keeps
 * the unconfigured side blank.
 */
export const INERT_HEADER_FOOTER_TEMPLATE = '<span></span>'

/** Placeholders a header or footer may carry. */
const PLACEHOLDER = /\{(page|total|title|author|date)\}/g

/** Inline template font; no external resource is loaded in the print margin. */
const TEMPLATE_FONT = "font-family:'Songti SC',SimSun,'Times New Roman',serif;font-size:9px;color:#333;"

/** Millimetres in one inch, for the template padding. */
const MM_PER_INCH = 25.4

/**
 * Read one margin side as template padding in millimetres.
 * @param value - a margin in inches.
 * @returns the millimetres, rounded to two decimals, or null when unusable.
 */
function paddingMm(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return Math.round(value * MM_PER_INCH * 100) / 100
}

/**
 * Build the shared header/footer wrapper.
 *
 * Chromium prints the template across the whole page width, so without
 * horizontal padding a left-aligned header touches the paper edge. The padding
 * takes the page's left and right margins, and the border-box keeps a centered
 * footer centered on the text area rather than shifted by the padding.
 * @param text - template text.
 * @param context - title, author, and date values.
 * @param alignment - left or center.
 * @param margins - four print margins in inches, optional.
 * @returns the template HTML.
 */
function templateOf(text, context, alignment, margins) {
  const left = paddingMm(margins?.left)
  const right = paddingMm(margins?.right)
  const padding = left === null || right === null
    ? ''
    : 'box-sizing:border-box;padding:0 ' + right + 'mm 0 ' + left + 'mm;'
  return '<div style="width:100%;' + padding + TEMPLATE_FONT + 'text-align:' + alignment + ';">'
    + fillTemplate(text, context) + '</div>'
}

/**
 * Escape text for one HTML text node.
 * @param text - raw text.
 * @returns the escaped text.
 */
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Read one context value as template text.
 * @param context - title, author, and date values.
 * @param name - placeholder name.
 * @returns the escaped value; empty when the context has none.
 */
function contextText(context, name) {
  const value = context[name]
  if (typeof value === 'string') return escapeHtml(value)
  if (typeof value === 'number' && Number.isFinite(value)) return escapeHtml(String(value))
  return ''
}

/**
 * Render one placeholder as print-template HTML.
 * @param name - placeholder name.
 * @param context - title, author, and date values.
 * @returns the Chromium span for page numbers, or escaped text.
 */
function placeholderHtml(name, context) {
  if (name === 'page') return '<span class="pageNumber"></span>'
  if (name === 'total') return '<span class="totalPages"></span>'
  return contextText(context, name)
}

/**
 * Fill a header or footer template with Chromium placeholders.
 *
 * Every literal segment and every substituted value is escaped. An unknown
 * placeholder such as {foo} stays literal: refusing it would fail an export
 * over a typo, and a warning already covers unknown pdf.* keys.
 * @param text - template text from configuration.
 * @param context - title, author, and date values.
 * @returns the template HTML, without the wrapper.
 */
function fillTemplate(text, context) {
  let result = ''
  let cursor = 0
  for (const match of text.matchAll(PLACEHOLDER)) {
    result += escapeHtml(text.slice(cursor, match.index))
    result += placeholderHtml(match[1], context)
    cursor = match.index + match[0].length
  }
  return result + escapeHtml(text.slice(cursor))
}

/**
 * Build the header template for one print.
 * @param text - header text from configuration.
 * @param context - title, author, and date values, all optional.
 * @param margins - four print margins in inches, optional; the header is
 *   indented to the text area when supplied.
 * @returns the Chromium header template.
 */
export function renderHeaderTemplate(text, context = {}, margins) {
  return templateOf(String(text ?? ''), context, 'left', margins)
}

/**
 * Build the footer template for one print.
 *
 * The footer is centered on every page; page numbers never switch sides and no
 * cover page is exempt.
 * @param text - footer text from configuration.
 * @param context - title, author, and date values, all optional.
 * @param margins - four print margins in inches, optional; the footer centers
 *   on the text area when supplied.
 * @returns the Chromium footer template.
 */
export function renderFooterTemplate(text, context = {}, margins) {
  return templateOf(String(text ?? ''), context, 'center', margins)
}

/**
 * Read one margin side as a finite, non-negative number.
 * @param value - a margin value in inches.
 * @returns the value, or 0 when it cannot be printed.
 */
function marginOf(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/**
 * Normalize the four print margins.
 * @param margins - top, bottom, left, and right in inches.
 * @returns the same four keys with unsafe values replaced by 0.
 */
function normalizeMargins(margins) {
  const source = margins !== null && typeof margins === 'object' ? margins : {}
  return {
    top: marginOf(source.top),
    bottom: marginOf(source.bottom),
    left: marginOf(source.left),
    right: marginOf(source.right),
  }
}

/**
 * Format the local calendar date.
 * @returns YYYY-MM-DD in the Host's time zone.
 */
function today() {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return String(now.getFullYear()) + '-' + month + '-' + day
}

/**
 * Read one text field from a document config.
 * @param value - configured value.
 * @returns the trimmed text, or an empty string.
 */
function textOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Build the complete printToPDF options for one document.
 *
 * The config is either the document config itself or an object carrying the
 * document and the outline flag. Page numbers and the outline arrive already
 * merged: plugin default, then front matter, then the one-off request. A
 * header, a footer, or page numbers enable the header/footer area; a page
 * numbers request with no footer text prints the centered default footer.
 * @param config - document config, or an object carrying document and outline.
 * @param margins - four page margins in inches.
 * @param context - title, author, and date for template placeholders.
 * @returns the options object handed to printToPDF.
 */
export function buildPrintOptions(config = {}, margins = {}, context = {}) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const document = source.document !== null && typeof source.document === 'object'
    ? source.document
    : source
  const headerText = textOf(document.header)
  const footerText = textOf(document.footer)
  const pageNumbers = document.pageNumbers === true
  const footer = footerText !== '' ? footerText : pageNumbers ? DEFAULT_PAGE_FOOTER : ''
  const templateContext = {
    title: typeof context.title === 'string' ? context.title : '',
    author: typeof context.author === 'string' ? context.author : '',
    date: typeof context.date === 'string' && context.date !== '' ? context.date : today(),
  }
  const outline = source.outline ?? document.outline
  const displayHeaderFooter = pageNumbers || headerText !== '' || footer !== ''
  const normalizedMargins = normalizeMargins(margins)
  const sideTemplate = (text, render) => {
    if (!displayHeaderFooter) return ''
    return text === '' ? INERT_HEADER_FOOTER_TEMPLATE : render(text, templateContext, normalizedMargins)
  }
  return {
    printBackground: true,
    preferCSSPageSize: true,
    margins: normalizedMargins,
    displayHeaderFooter,
    headerTemplate: sideTemplate(headerText, renderHeaderTemplate),
    footerTemplate: sideTemplate(footer, renderFooterTemplate),
    // Chromium builds the outline from the tagged-PDF structure tree; the
    // outline flag alone is a no-op.
    generateDocumentOutline: outline !== false,
    generateTaggedPDF: outline !== false,
    pageRanges: '',
  }
}
