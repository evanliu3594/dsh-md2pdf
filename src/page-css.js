/**
 * The page CSS layer and the margin read back from a built document.
 *
 * A page override is the last stylesheet layer the exporter adds. It carries
 * only the fields a user explicitly set, so setting the root font size does not
 * rewrite the paper size, and setting the margin does not rewrite it either: a
 * preset such as the official-document one keeps its 37/26/35/28 mm box unless
 * the user overrides the margin itself.
 *
 * The margin readers serve two different consumers and must not be conflated:
 * {@link pageMarginShorthand} feeds the settings previews as CSS body padding,
 * while {@link pageMarginsInches} feeds `printToPDF` margins in inches.
 */
import { DEFAULT_PAGE } from './document.js'
import { PdfError } from './pdf.js'

/** The last `@page` block with a margin declaration; later blocks win. */
const PAGE_MARGIN = /@page\s*\{[^}]*?\bmargin\s*:\s*([^;}]+)/gi

/** One CSS length, with the unit captured separately. */
const CSS_LENGTH = /^((?:\d+(?:\.\d+)?|\.\d+)(mm|cm|in|pt))$/i

/** How many inches one supported unit is worth. */
const UNIT_INCHES = { mm: 1 / 25.4, cm: 1 / 2.54, in: 1, pt: 1 / 72 }

/** Inches per margin side, rounded to four decimals. */
const INCH_PRECISION = 10_000

/**
 * Read the paper size and orientation to put in `@page`.
 * @param page - a partial page override.
 * @returns the `size` value, or an empty string when the paper size is unset.
 */
function pageSizeOf(page) {
  const size = typeof page.size === 'string' ? page.size : ''
  if (size === '') {
    if (page.landscape === true) return 'landscape'
    if (page.landscape === false) return 'portrait'
    return ''
  }
  if (page.landscape === true) return `${size} landscape`
  // An explicit portrait is CSS's default, so the size keyword alone resets it.
  return size
}

/**
 * Build the page override layer from a partial page override.
 *
 * Only fields present in `page` are emitted. Values are expected to be already
 * validated by the configuration parser; this function only formats CSS.
 * @param page - a partial page override.
 * @returns the CSS text, empty when the override sets nothing.
 */
export function pageOverrideCss(page) {
  const source = page ?? {}
  const blocks = []
  const declarations = []
  const size = pageSizeOf(source)
  if (size !== '') declarations.push(`size:${size}`)
  if (source.marginMm !== undefined) declarations.push(`margin:${source.marginMm}mm`)
  if (declarations.length > 0) blocks.push(`@page{${declarations.join(';')}}`)
  if (source.fontSize !== undefined) blocks.push(`body{font-size:${source.fontSize}px}`)
  return blocks.join('\n')
}

/**
 * Read the page margin shorthand the document prints with.
 *
 * The base stylesheet always declares a margin and a preset may replace it, so
 * the last declaration in document order wins, exactly as the print engine
 * resolves the cascade. A document without an `@page` margin falls back to the
 * plugin's default geometry, which is what the settings preview then shows.
 * @param html - a complete printable document.
 * @returns the margin shorthand, such as `37mm 26mm 35mm 28mm`.
 * @throws {PdfError} when the last margin is `auto`, `calc()`, or empty.
 */
export function pageMarginShorthand(html) {
  const text = typeof html === 'string' ? html : ''
  let margin = null
  for (const match of text.matchAll(PAGE_MARGIN)) margin = match[1]
  if (margin === null) return `${DEFAULT_PAGE.marginMm}mm`
  // `!important` changes the cascade, not the length; the value itself is
  // printable and must not turn into an unsupported token.
  const shorthand = margin.replace(/\s*!important\s*/gi, ' ').trim().replace(/\s+/g, ' ')
  if (shorthand === '') {
    throw new PdfError('bad-request', 'the @page margin is empty')
  }
  if (/(?:^|\s)auto(?:\s|$)/i.test(shorthand)) {
    throw new PdfError('bad-request', `the @page margin cannot be auto: ${shorthand}`)
  }
  if (/\bcalc\(/i.test(shorthand)) {
    throw new PdfError('bad-request', `the @page margin cannot use calc(): ${shorthand}`)
  }
  return shorthand
}

/**
 * Convert one margin length to inches.
 * @param text - one whitespace-separated value.
 * @param shorthand - the whole shorthand, for the failure message.
 * @returns the length in inches.
 * @throws {PdfError} for a unit the print options cannot express.
 */
function lengthInInches(text, shorthand) {
  if (/^[+-]?0+(?:\.0+)?$/.test(text) || /^[+-]?\.0+$/.test(text)) return 0
  const match = CSS_LENGTH.exec(text)
  if (match === null) {
    throw new PdfError('bad-request', `unsupported @page margin length "${text}" in: ${shorthand}`)
  }
  return Number.parseFloat(match[1]) * UNIT_INCHES[match[2].toLowerCase()]
}

/**
 * Read the print margins, falling back when the preset's form is unsupported.
 *
 * A preset is a user file: an unsupported @page form must not fail the export.
 * The fallback is the plugin's uniform default box, and the caller reports the
 * warning it returns. The strict readers stay for checks and for callers that
 * genuinely need to refuse a bad form.
 * @param html - a complete printable document.
 * @returns the four margins in inches and a warning, empty on success.
 */
export function pageMarginInfo(html) {
  try {
    return { margins: pageMarginsInches(html), warning: '' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const fallback = Math.round((DEFAULT_PAGE.marginMm / 25.4) * INCH_PRECISION) / INCH_PRECISION
    return {
      margins: { top: fallback, bottom: fallback, left: fallback, right: fallback },
      warning: 'unsupported @page margin; using a uniform ' + DEFAULT_PAGE.marginMm + 'mm box: ' + message,
    }
  }
}

/**
 * Convert the document's page margin to the inches `printToPDF` expects.
 *
 * The shorthand follows CSS: one value is uniform, two are vertical and
 * horizontal, three add a separate bottom, and four are top, right, bottom,
 * left.
 * @param html - a complete printable document.
 * @returns the four margins in inches.
 * @throws {PdfError} when the margin is not a supported 1-4 value length.
 */
export function pageMarginsInches(html) {
  const shorthand = pageMarginShorthand(html)
  const values = shorthand.split(' ').map(text => lengthInInches(text, shorthand))
  if (values.length < 1 || values.length > 4) {
    throw new PdfError('bad-request', `the @page margin must have 1 to 4 values: ${shorthand}`)
  }
  const sides = values.length === 1
    ? [values[0], values[0], values[0], values[0]]
    : values.length === 2
      ? [values[0], values[1], values[0], values[1]]
      : values.length === 3
        ? [values[0], values[1], values[2], values[1]]
        : [values[0], values[1], values[2], values[3]]
  const round = value => Math.round(value * INCH_PRECISION) / INCH_PRECISION
  return {
    top: round(sides[0]),
    bottom: round(sides[2]),
    left: round(sides[3]),
    right: round(sides[1]),
  }
}
