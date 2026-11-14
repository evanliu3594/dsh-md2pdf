/**
 * Assertions for the document configuration model.
 * Run: node scripts/document-config-check.mjs
 */
import { mergeDocumentConfig, PAGE_FIELDS, parseDocumentConfig } from '../src/document-config.js'
import { pageMarginsInches, pageMarginShorthand, pageOverrideCss } from '../src/page-css.js'

let failures = 0
let checks = 0

/**
 * Assert two values are equal.
 * @param label - what the check proves.
 * @param actual - produced value.
 * @param expected - required value.
 */
function expectEqual(label, actual, expected) {
  checks += 1
  if (actual === expected) return
  failures += 1
  process.stdout.write(`FAIL ${label}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}\n`)
}

/**
 * Assert a condition holds.
 * @param label - what the check proves.
 * @param condition - required truth.
 */
function expectTrue(label, condition) {
  expectEqual(label, condition === true, true)
}

/**
 * Assert two numbers match within a tolerance.
 * @param label - what the check proves.
 * @param actual - produced number.
 * @param expected - required number.
 * @param tolerance - largest accepted difference.
 */
function expectClose(label, actual, expected, tolerance = 0.0001) {
  checks += 1
  if (typeof actual === 'number' && Math.abs(actual - expected) <= tolerance) return
  failures += 1
  process.stdout.write(`FAIL ${label}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}\n`)
}

/**
 * Assert that one call throws a named failure.
 * @param label - what the check proves.
 * @param run - the call expected to refuse its input.
 * @param code - required `error.code`.
 */
function expectRejected(label, run, code) {
  checks += 1
  try {
    run()
  } catch (error) {
    if (error?.code === code) return
    failures += 1
    process.stdout.write(`FAIL ${label}\n  expected code: ${code}\n  actual code:   ${String(error?.code)}\n`)
    return
  }
  failures += 1
  process.stdout.write(`FAIL ${label}\n  expected code: ${code}\n  actual:        no error\n`)
}

expectEqual('page fields', PAGE_FIELDS.join(','), 'size,marginMm,fontSize,landscape')

// Flat `pdf.*` keys configure the export; ordinary fields stay document text.
const parsed = parseDocumentConfig({
  'pdf.preset': 'paper',
  'pdf.page.size': 'A3',
  'pdf.page.landscape': 'true',
  'pdf.page.marginMm': '20',
  'pdf.page.fontSize': '12',
  'pdf.header': 'Internal',
  'pdf.footer': 'Page {page} / {total}',
  'pdf.pageNumbers': 'true',
  'pdf.toc': 'true',
  'pdf.unknown': 'x',
})
expectEqual('page size', parsed.page.size, 'A3')
expectEqual('page landscape', parsed.page.landscape, true)
expectEqual('page margin', parsed.page.marginMm, 20)
expectEqual('page font size', parsed.page.fontSize, 12)
expectEqual('page carries only explicit fields', Object.keys(parsed.page).join(','), 'size,marginMm,fontSize,landscape')
expectEqual('header', parsed.document.header, 'Internal')
expectEqual('footer', parsed.document.footer, 'Page {page} / {total}')
expectEqual('page numbers', parsed.document.pageNumbers, true)
expectEqual('table of contents', parsed.document.toc, true)
expectEqual('paper fields start empty', Object.keys(parsed.document.paper).join(','), '')
expectEqual('unknown key warns', parsed.warnings.join(','), 'pdf.unknown')

// A preset key is recognised configuration, not page or document content.
const presetOnly = parseDocumentConfig({ 'pdf.preset': 'gongwen' })
expectEqual('preset key does not warn', presetOnly.warnings.join(','), '')
expectEqual('preset adds no page field', Object.keys(presetOnly.page).join(','), '')

// Non-configuration front matter belongs to the visible field table.
expectEqual('ordinary keys are ignored', parseDocumentConfig({ title: '示例', author: 'DSH' }).warnings.join(','), '')

// Partial paper metadata travels with the document config.
const paper = parseDocumentConfig({ 'pdf.paper.title': '题名', 'pdf.paper.authors': '张三' })
expectEqual('paper title', paper.document.paper.title, '题名')
expectEqual('paper authors', paper.document.paper.authors, '张三')
expectEqual('paper keys do not warn', paper.warnings.join(','), '')

// Invalid values refuse the export instead of silently falling back.
expectRejected('unknown page size', () => parseDocumentConfig({ 'pdf.page.size': 'B5' }), 'bad-request')
expectRejected('margin above range', () => parseDocumentConfig({ 'pdf.page.marginMm': '61' }), 'bad-request')
expectRejected('negative margin', () => parseDocumentConfig({ 'pdf.page.marginMm': '-1' }), 'bad-request')
expectRejected('font size below range', () => parseDocumentConfig({ 'pdf.page.fontSize': '7' }), 'bad-request')
expectRejected('non-numeric margin', () => parseDocumentConfig({ 'pdf.page.marginMm': '20mm' }), 'bad-request')
expectRejected('boolean value must be true or false', () => parseDocumentConfig({ 'pdf.page.landscape': 'yes' }), 'bad-request')
expectRejected('boolean value is case sensitive', () => parseDocumentConfig({ 'pdf.toc': 'TRUE' }), 'bad-request')

// Preset metadata is already partial and gains only the explicit overrides.
const merged = mergeDocumentConfig({
  presetPage: { marginMm: 37 },
  frontmatter: { 'pdf.page.fontSize': '12' },
  request: {},
})
expectEqual('preset margin survives', merged.page.marginMm, 37)
expectEqual('front matter font size applies', merged.page.fontSize, 12)
expectEqual('merge keeps only explicit fields', Object.keys(merged.page).join(','), 'marginMm,fontSize')
expectEqual('merge reports no warnings', merged.warnings.join(','), '')

// Front matter beats preset metadata; a per-export request beats both.
const precedence = mergeDocumentConfig({
  presetPage: { size: 'A4', marginMm: 37, landscape: false },
  frontmatter: { 'pdf.page.size': 'A5', 'pdf.page.marginMm': '20' },
  request: { page: { marginMm: 12, fontSize: '10' } },
})
expectEqual('front matter beats preset size', precedence.page.size, 'A5')
expectEqual('request beats front matter margin', precedence.page.marginMm, 12)
expectEqual('request page accepts numeric text', precedence.page.fontSize, 10)
expectEqual('preset landscape kept until overridden', precedence.page.landscape, false)
expectRejected('invalid request page refused', () => mergeDocumentConfig({
  presetPage: {},
  frontmatter: {},
  request: { page: { size: 'B5' } },
}), 'bad-request')

// Document defaults lose to front matter, which loses to the request.
const documentPrecedence = mergeDocumentConfig({
  presetPage: {},
  frontmatter: { 'pdf.header': 'Internal', 'pdf.pageNumbers': 'true' },
  request: { documentConfig: { header: 'Draft', toc: true } },
})
expectEqual('request header wins', documentPrecedence.document.header, 'Draft')
expectEqual('front matter footer default', documentPrecedence.document.footer, '')
expectEqual('front matter page numbers kept', documentPrecedence.document.pageNumbers, true)
expectEqual('request toc wins', documentPrecedence.document.toc, true)

// A page override emits only what the user explicitly set.
const fontOnly = pageOverrideCss({ fontSize: 12 })
expectTrue('font size override emits body size', fontOnly.includes('body{font-size:12px}'))
expectTrue('font size override leaves @page alone', !fontOnly.includes('@page'))

const marginOnly = pageOverrideCss({ marginMm: 20 })
expectTrue('margin override emits the page margin', marginOnly.includes('@page{margin:20mm}'))
expectTrue('margin override leaves the paper size alone', !marginOnly.includes('size:'))

const paperSize = pageOverrideCss({ size: 'A3', landscape: true })
expectTrue('paper size override emits size', paperSize.includes('@page{size:A3 landscape}'))
expectTrue('paper size override leaves the margin alone', !paperSize.includes('margin:'))

const explicitPortrait = pageOverrideCss({ landscape: false })
expectEqual('explicit portrait is emitted', explicitPortrait, '@page{size:portrait}')
expectEqual('empty override emits nothing', pageOverrideCss({}), '')
expectEqual('full override emits one page block plus body size',
  pageOverrideCss({ size: 'A4', marginMm: 18, fontSize: 15, landscape: false }),
  '@page{size:A4;margin:18mm}\nbody{font-size:15px}')

// The preview and the print engine read the last @page margin in the document.
const gongwenHtml = '<style>@page{margin:37mm 26mm 35mm 28mm}</style>'
expectEqual('shorthand from @page', pageMarginShorthand(gongwenHtml), '37mm 26mm 35mm 28mm')
expectEqual('last @page wins', pageMarginShorthand(
  '@page{margin:18mm}@page { size: A4; margin: 20mm 10mm }',
), '20mm 10mm')
expectEqual('margin whitespace is normalized', pageMarginShorthand('@page { margin:\n  12mm  8mm }'), '12mm 8mm')
expectEqual('missing @page falls back to the default geometry', pageMarginShorthand('<style></style>'), '18mm')
expectRejected('auto margin refused', () => pageMarginShorthand('@page{margin:auto}'), 'bad-request')
expectRejected('calc margin refused', () => pageMarginShorthand('@page{margin:calc(10mm + 2mm)}'), 'bad-request')

// Four printed margins in inches, from the shorthand the stylesheet set.
const margins = pageMarginsInches(gongwenHtml)
expectClose('margin top', margins.top, 1.4567)
expectClose('margin right', margins.right, 1.0236)
expectClose('margin bottom', margins.bottom, 1.378)
expectClose('margin left', margins.left, 1.1024)

const uniform = pageMarginsInches('@page{margin:20mm}')
expectClose('one value: top', uniform.top, 0.7874)
expectClose('one value: right', uniform.right, 0.7874)
expectClose('one value: bottom', uniform.bottom, 0.7874)
expectClose('one value: left', uniform.left, 0.7874)

const verticalHorizontal = pageMarginsInches('@page{margin:20mm 10mm}')
expectClose('two values: top', verticalHorizontal.top, 0.7874)
expectClose('two values: right', verticalHorizontal.right, 0.3937)
expectClose('two values: bottom', verticalHorizontal.bottom, 0.7874)
expectClose('two values: left', verticalHorizontal.left, 0.3937)

const threeValues = pageMarginsInches('@page{margin:10mm 20mm 30mm}')
expectClose('three values: top', threeValues.top, 0.3937)
expectClose('three values: right', threeValues.right, 0.7874)
expectClose('three values: bottom', threeValues.bottom, 1.1811)
expectClose('three values: left', threeValues.left, 0.7874)

const unitChecks = [
  ['cm', '2.54cm'],
  ['in', '1in'],
  ['pt', '72pt'],
]
for (const [unit, value] of unitChecks) {
  const inches = pageMarginsInches(`@page{margin:${value}}`)
  expectClose(`${unit} converts to inches`, inches.top, 1)
}
expectClose('unitless zero is accepted', pageMarginsInches('@page{margin:0}').top, 0)
expectRejected('unsupported margin unit refused',
  () => pageMarginsInches('@page{margin:20px}'), 'bad-request')
expectRejected('too many margin values refused',
  () => pageMarginsInches('@page{margin:1mm 2mm 3mm 4mm 5mm}'), 'bad-request')

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`)
process.exit(failures === 0 ? 0 : 1)
