/**
 * Document configuration read from flat `pdf.*` front matter keys.
 *
 * A page override is deliberately partial: only the fields a user wrote appear,
 * so an untouched field never overwrites the page box a preset's stylesheet
 * declared. Document settings do have defaults, because they feed the print
 * options rather than the stylesheet.
 *
 * Precedence for the page box is `DEFAULT_PAGE` (in the structural sheet) <
 * preset metadata < front matter < one-off request. For the rest of the
 * document it is default < front matter < one-off request.
 */
import { PdfError } from './pdf.js'

/** Page fields a caller may override, in emission order. */
export const PAGE_FIELDS = ['size', 'marginMm', 'fontSize', 'landscape']

/** CSS paper keywords the plugin accepts. */
const PAGE_SIZES = ['A3', 'A4', 'A5', 'Letter', 'Legal']

/** Uniform page margin bounds in millimetres. */
const MARGIN_MM = { min: 0, max: 60 }

/** Root font size bounds in CSS pixels. */
const FONT_SIZE = { min: 8, max: 24 }

const PAGE_PREFIX = 'pdf.page.'
const PAPER_PREFIX = 'pdf.paper.'

/** Paper-template fields the built-in paper preset renders. */
export const PAPER_FIELDS = Object.freeze([
  'title', 'authors', 'affiliations', 'abstract', 'keywords', 'date',
])

/** A page override with no fields set. */
function emptyPage() {
  return {}
}

/**
 * Document settings before any front matter or request override.
 *
 * The plugin's row configuration is the base layer: page numbers default off,
 * the PDF outline defaults on. Front matter and the one-off request may change
 * either one later.
 * @param defaults - row configuration for the document layer.
 * @returns a document config with the row defaults applied.
 */
function emptyDocument(defaults = {}) {
  const source = defaults !== null && typeof defaults === 'object' ? defaults : {}
  return {
    header: typeof source.header === 'string' ? source.header : '',
    footer: typeof source.footer === 'string' ? source.footer : '',
    pageNumbers: source.pageNumbers === true,
    outline: source.outline !== false,
    toc: source.toc === true,
    paper: {},
  }
}

/**
 * Read a configuration value as trimmed text.
 * @param key - full key, for the failure message.
 * @param value - raw value.
 * @returns the trimmed text.
 * @throws {PdfError} when the value is not text.
 */
function textOf(key, value) {
  if (typeof value !== 'string') {
    throw new PdfError('bad-request', `${key} must be text: ${String(value)}`)
  }
  return value.trim()
}

/**
 * Read a configuration value as a boolean.
 *
 * Only the two literal words are accepted; `yes`, `1` and `TRUE` are typos
 * that would otherwise change the printed page silently.
 * @param key - full key, for the failure message.
 * @param value - raw value.
 * @returns the boolean.
 * @throws {PdfError} for any other value.
 */
function booleanOf(key, value) {
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  throw new PdfError('bad-request', `${key} must be true or false: ${String(value)}`)
}

/**
 * Read a configuration value as a number inside an inclusive range.
 * @param key - full key, for the failure message.
 * @param value - raw value, a JSON number or decimal text.
 * @param min - smallest accepted value.
 * @param max - largest accepted value.
 * @returns the number.
 * @throws {PdfError} when the value is not a number or falls outside the range.
 */
function numberInRange(key, value, min, max) {
  let number = null
  if (typeof value === 'number') {
    number = value
  } else if (typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value.trim())) {
    number = Number(value.trim())
  }
  if (number === null || !Number.isFinite(number)) {
    throw new PdfError('bad-request', `${key} must be a number: ${String(value)}`)
  }
  if (number < min || number > max) {
    throw new PdfError('bad-request', `${key} must be between ${min} and ${max}: ${String(value)}`)
  }
  return number
}

/**
 * Validate one page field.
 * @param key - full key, for the failure message.
 * @param field - one of `PAGE_FIELDS`.
 * @param value - raw value.
 * @returns the normalized value.
 * @throws {PdfError} when the value is not acceptable for the field.
 */
function pageValue(key, field, value) {
  switch (field) {
    case 'size': {
      const size = textOf(key, value)
      if (!PAGE_SIZES.includes(size)) {
        throw new PdfError('bad-request', `${key} must be one of ${PAGE_SIZES.join(', ')}: ${size}`)
      }
      return size
    }
    case 'marginMm':
      return numberInRange(key, value, MARGIN_MM.min, MARGIN_MM.max)
    case 'fontSize':
      return numberInRange(key, value, FONT_SIZE.min, FONT_SIZE.max)
    case 'landscape':
      return booleanOf(key, value)
    default:
      throw new PdfError('bad-request', `unknown page field: ${key}`)
  }
}

/**
 * Collect page fields in canonical order, keeping only those present.
 * @param page - a partial page object.
 * @returns a new partial page object.
 */
function orderPage(page) {
  const ordered = emptyPage()
  for (const field of PAGE_FIELDS) {
    if (Object.hasOwn(page, field)) ordered[field] = page[field]
  }
  return ordered
}

/**
 * Copy a page override without validating or defaulting it.
 *
 * Preset metadata is written by the Host after its own validation, so it is a
 * `PageOverride` already; adding defaults here would replace a preset's page
 * box with the plugin default.
 * @param source - stored preset page metadata.
 * @returns a new partial page object.
 */
function copyPageOverride(source) {
  const page = emptyPage()
  if (source === null || typeof source !== 'object') return page
  for (const field of PAGE_FIELDS) {
    if (!Object.hasOwn(source, field)) continue
    if (source[field] === undefined || source[field] === null) continue
    page[field] = source[field]
  }
  return page
}

/**
 * Validate a page override arriving from a request or stored preset metadata.
 *
 * Only fields a caller explicitly set appear in the result. Unknown fields are
 * refused rather than ignored: a typo in a page key would otherwise print the
 * previous geometry without telling anyone.
 * @param source - request page object.
 * @param label - dotted prefix for failure messages.
 * @returns a new validated partial page object.
 * @throws {PdfError} when the object or a field is invalid.
 */
export function validatePageOverride(source, label) {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    throw new PdfError('bad-request', `${label} must be an object`)
  }
  for (const field of Object.keys(source)) {
    if (!PAGE_FIELDS.includes(field)) {
      throw new PdfError('bad-request', `${label}.${field} is not a page field`)
    }
  }
  const page = emptyPage()
  for (const field of PAGE_FIELDS) {
    if (!Object.hasOwn(source, field)) continue
    const value = source[field]
    if (value === undefined || value === null) continue
    page[field] = pageValue(`${label}.${field}`, field, value)
  }
  return page
}

/**
 * Apply a requested document override to a document config in place.
 * @param document - the document config to update.
 * @param source - request document config.
 * @param label - dotted prefix for failure messages.
 * @throws {PdfError} when the object or a field is invalid.
 */
function applyDocumentOverride(document, source, label) {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    throw new PdfError('bad-request', `${label} must be an object`)
  }
  for (const field of ['header', 'footer']) {
    if (!Object.hasOwn(source, field) || source[field] === undefined || source[field] === null) continue
    document[field] = textOf(`${label}.${field}`, source[field])
  }
  for (const field of ['pageNumbers', 'toc', 'outline']) {
    if (!Object.hasOwn(source, field) || source[field] === undefined || source[field] === null) continue
    document[field] = booleanOf(`${label}.${field}`, source[field])
  }
  if (!Object.hasOwn(source, 'paper') || source.paper === undefined || source.paper === null) return
  if (typeof source.paper !== 'object' || Array.isArray(source.paper)) {
    throw new PdfError('bad-request', `${label}.paper must be an object`)
  }
  for (const [field, value] of Object.entries(source.paper)) {
    if (value === undefined || value === null) continue
    document.paper[field] = textOf(`${label}.paper.${field}`, value)
  }
}

/**
 * Read the row configuration that seeds the document config.
 *
 * Only the two literal booleans are accepted. A quoted YAML value such as
 * "false" is not a boolean; it is reported instead of silently becoming true.
 * @param config - row configuration.
 * @returns the document defaults and one warning per invalid field.
 */
export function documentDefaults(config = {}) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const defaults = {}
  const warnings = []
  for (const field of ['pageNumbers', 'outline']) {
    if (!Object.hasOwn(source, field) || source[field] === undefined) continue
    if (typeof source[field] === 'boolean') {
      defaults[field] = source[field]
      continue
    }
    warnings.push(`${field} must be true or false`)
  }
  return { defaults, warnings }
}

/**
 * Parse flat `pdf.*` front matter keys into page and document configuration.
 *
 * Recognised page keys are `pdf.page.size`, `pdf.page.marginMm`,
 * `pdf.page.fontSize` and `pdf.page.landscape`. Recognised document keys are
 * `pdf.header`, `pdf.footer`, `pdf.pageNumbers`, `pdf.toc` and
 * `pdf.outline`; `pdf.paper.*` fields travel with the document config for the
 * paper template, and `pdf.preset` selects a preset elsewhere. Every other
 * `pdf.*` key is recorded as a warning and left out, so a typo cannot break
 * the export.
 * @param frontmatter - flat front matter fields, values as text.
 * @param defaults - row configuration used as the document base layer.
 * @returns the explicit page override, the document config, and warnings.
 * @throws {PdfError} for an invalid value.
 */
export function parseDocumentConfig(frontmatter, defaults = {}) {
  const source = frontmatter ?? {}
  if (typeof source !== 'object' || Array.isArray(source)) {
    throw new PdfError('bad-request', 'frontmatter must be an object of flat fields')
  }
  const page = emptyPage()
  const document = emptyDocument(defaults)
  const warnings = []
  for (const [key, value] of Object.entries(source)) {
    if (!key.startsWith('pdf.')) continue
    if (key === 'pdf.preset') continue
    if (key.startsWith(PAGE_PREFIX)) {
      const field = key.slice(PAGE_PREFIX.length)
      if (!PAGE_FIELDS.includes(field)) {
        warnings.push(key)
        continue
      }
      page[field] = pageValue(key, field, value)
      continue
    }
    if (key.startsWith(PAPER_PREFIX)) {
      const field = key.slice(PAPER_PREFIX.length)
      if (!PAPER_FIELDS.includes(field)) {
        warnings.push(key)
        continue
      }
      document.paper[field] = textOf(key, value)
      continue
    }
    switch (key) {
      case 'pdf.header':
        document.header = textOf(key, value)
        break
      case 'pdf.footer':
        document.footer = textOf(key, value)
        break
      case 'pdf.pageNumbers':
        document.pageNumbers = booleanOf(key, value)
        break
      case 'pdf.toc':
        document.toc = booleanOf(key, value)
        break
      case 'pdf.outline':
        document.outline = booleanOf(key, value)
        break
      default:
        warnings.push(key)
    }
  }
  return {
    page: orderPage(page),
    document: { ...document, paper: { ...document.paper } },
    warnings,
  }
}

/**
 * Merge preset page metadata, front matter, and a one-off request.
 *
 * Only fields supplied by a source appear in the result. The preset metadata is
 * the lowest page layer and is never padded with defaults; the request is the
 * highest layer for both page and document settings.
 * @param input - preset page metadata, flat front matter, and the request body.
 * @param input.presetPage - the selected preset's page override, if any.
 * @param input.frontmatter - flat front matter fields, values as text.
 * @param input.request - request body; `page` and `documentConfig` are read.
 * @param input.defaults - row configuration for the document layer.
 * @returns the effective page override, document config, and warnings.
 * @throws {PdfError} for an invalid value in the front matter or request.
 */
export function mergeDocumentConfig({ presetPage, frontmatter, request, defaults } = {}) {
  const parsed = parseDocumentConfig(frontmatter, defaults)
  const incoming = request ?? {}

  const page = copyPageOverride(presetPage)
  Object.assign(page, parsed.page)
  if (incoming.page !== undefined && incoming.page !== null) {
    Object.assign(page, validatePageOverride(incoming.page, 'request.page'))
  }

  const document = { ...parsed.document, paper: { ...parsed.document.paper } }
  if (incoming.documentConfig !== undefined && incoming.documentConfig !== null) {
    applyDocumentOverride(document, incoming.documentConfig, 'request.documentConfig')
  }

  return {
    page: orderPage(page),
    document: { ...document, paper: { ...document.paper } },
    warnings: parsed.warnings,
  }
}
