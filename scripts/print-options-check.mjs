/**
 * Assertions for the print options the DSH Chromium guest receives.
 *
 * The Host owns every header, footer, page-number, outline, and margin option;
 * the client forwards the object unchanged. These checks pin the template
 * escaping, the centered page-number footer, the default footer, the outline
 * default, the document-config precedence, and the prepare/finish handoff.
 *
 * Run: node scripts/print-options-check.mjs
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
  process.stdout.write('FAIL ' + label + '\n  expected: ' + String(expected) + '\n  actual:   ' + String(actual) + '\n')
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
 * Assert one string contains another.
 * @param label - what the check proves.
 * @param text - produced text.
 * @param needle - required substring.
 */
function expectIncludes(label, text, needle) {
  expectTrue(label, typeof text === 'string' && text.includes(needle))
}

/**
 * Assert one string does not contain another.
 * @param label - what the check proves.
 * @param text - produced text.
 * @param needle - forbidden substring.
 */
function expectExcludes(label, text, needle) {
  expectTrue(label, typeof text === 'string' && !text.includes(needle))
}

const here = dirname(fileURLToPath(import.meta.url))
const home = await mkdtemp(join(tmpdir(), 'dsh-md2pdf-options-home-'))
const work = await mkdtemp(join(tmpdir(), 'dsh-md2pdf-options-work-'))
process.env['MD2PDF_HOME'] = home

const {
  buildPrintOptions, DEFAULT_PAGE_FOOTER, INERT_HEADER_FOOTER_TEMPLATE,
  renderFooterTemplate, renderHeaderTemplate,
} = await import('../src/print-options.js')
const { documentDefaults, mergeDocumentConfig, parseDocumentConfig } = await import('../src/document-config.js')
const { createPrintJobs } = await import('../src/print-jobs.js')
const { finishExport, prepareExport } = await import('../src/export.js')

const PDF = Buffer.from('%PDF-1.4\n%%EOF\n', 'latin1')

try {
  // ---- Template rendering -------------------------------------------------

  const centeredFooter = renderFooterTemplate('第 {page} 页 / 共 {total} 页')
  expectIncludes('the footer is centered', centeredFooter, 'text-align:center')
  expectIncludes('the footer renders the page number span', centeredFooter,
    '<span class="pageNumber"></span>')
  expectIncludes('the footer renders the total span', centeredFooter,
    '<span class="totalPages"></span>')
  expectExcludes('the footer has no literal page placeholder', centeredFooter, '{page}')
  expectExcludes('the footer has no literal total placeholder', centeredFooter, '{total}')
  expectIncludes('the footer spans the print area', centeredFooter, 'width:100%;')
  expectIncludes('the footer sets an inline font size', centeredFooter, 'font-size:9px')
  expectIncludes('the footer sets an inline font family', centeredFooter, 'font-family:')

  const plainHeader = renderHeaderTemplate('内部资料')
  expectIncludes('the header keeps its text', plainHeader, '内部资料')
  expectIncludes('the header is left aligned', plainHeader, 'text-align:left')
  expectExcludes('the header loads no external style', plainHeader, '<link')
  expectExcludes('the header loads no script', plainHeader, '<script')
  expectExcludes('the header loads no external resource', plainHeader, 'url(')

  const escapedHeader = renderHeaderTemplate('<b>x</b>')
  expectIncludes('header markup is escaped', escapedHeader, '&lt;b&gt;x&lt;/b&gt;')
  expectExcludes('header markup stays inert', escapedHeader, '<b>x</b>')
  const escapedFooter = renderFooterTemplate('A & "B" <i>')
  expectIncludes('footer ampersands are escaped', escapedFooter, 'A &amp; &quot;B&quot; &lt;i&gt;')
  expectExcludes('footer quotes are not left raw', escapedFooter, '"B"')

  const context = { title: '示例文档', author: 'DSH', date: '2026-11-15' }
  const contextHeader = renderHeaderTemplate('{title} / {author} / {date}', context)
  expectIncludes('the header renders the title', contextHeader, '示例文档')
  expectIncludes('the header renders the author', contextHeader, 'DSH')
  expectIncludes('the header renders the date', contextHeader, '2026-11-15')
  const contextFooter = renderFooterTemplate('{title} {page}/{total} {date}', context)
  expectIncludes('the footer renders the title', contextFooter, '示例文档')
  expectIncludes('the footer renders the date', contextFooter, '2026-11-15')
  expectIncludes('the footer still renders the page span', contextFooter,
    '<span class="pageNumber"></span>')

  const escapedContext = renderHeaderTemplate('{author}', { author: '<i>' })
  expectIncludes('a context value is escaped', escapedContext, '&lt;i&gt;')
  expectExcludes('a context value stays inert', escapedContext, '<i>')
  expectIncludes('a missing context value is empty', renderHeaderTemplate('[{author}]', {}), '[]')
  expectIncludes('an unknown placeholder stays literal', renderFooterTemplate('{foo}'), '{foo}')
  expectIncludes('a placeholder name is case sensitive', renderFooterTemplate('{Page}'), '{Page}')
  expectIncludes('the total span is still rendered', renderFooterTemplate('{total}'),
    '<span class="totalPages"></span>')

  // Page numbers apply to every page: no page range narrows the print and the
  // footer template cannot hide itself on one page.
  expectEqual('the print range stays unrestricted', buildPrintOptions({ pageNumbers: true }, {}).pageRanges, '')
  expectExcludes('the footer cannot hide itself on one page', centeredFooter, 'display:none')

  // ---- buildPrintOptions --------------------------------------------------

  const margins = { top: 1.4567, bottom: 1.378, left: 1.1024, right: 1.0236 }
  // The inert template must stay non-empty and invisible: an empty string is
  // falsy and lets Chromium print its own default header or footer.
  expectEqual('the inert template is pinned', INERT_HEADER_FOOTER_TEMPLATE, '<span></span>')
  expectTrue('the inert template is not empty', INERT_HEADER_FOOTER_TEMPLATE.length > 0)

  const bare = buildPrintOptions({}, margins)
  expectEqual('print option keys', Object.keys(bare).join(','),
    'printBackground,preferCSSPageSize,margins,displayHeaderFooter,headerTemplate,footerTemplate,generateDocumentOutline,pageRanges')
  expectEqual('print background is on', bare.printBackground, true)
  expectEqual('css page size wins', bare.preferCSSPageSize, true)
  expectEqual('bare margins pass through', bare.margins.top, margins.top)
  expectEqual('bare options keep headers off', bare.displayHeaderFooter, false)
  expectEqual('bare options carry an empty header', bare.headerTemplate, '')
  expectEqual('bare options carry an empty footer', bare.footerTemplate, '')
  expectEqual('the outline is on by default', bare.generateDocumentOutline, true)
  expectEqual('no page range restriction', bare.pageRanges, '')

  const numbered = buildPrintOptions({ pageNumbers: true }, margins)
  expectEqual('page numbers enable the header and footer area', numbered.displayHeaderFooter, true)
  expectIncludes('the default footer is used', numbered.footerTemplate, '第 ')
  expectIncludes('the default footer counts pages', numbered.footerTemplate, '共 ')
  expectIncludes('the default footer centers its text', numbered.footerTemplate, 'text-align:center')
  expectIncludes('the default footer carries the page span', numbered.footerTemplate,
    '<span class="pageNumber"></span>')
  expectIncludes('the default footer carries the total span', numbered.footerTemplate,
    '<span class="totalPages"></span>')
  expectEqual('page numbers alone leave the header blank', numbered.headerTemplate, INERT_HEADER_FOOTER_TEMPLATE)
  expectEqual('the default footer is the design text', DEFAULT_PAGE_FOOTER, '第 {page} 页 / 共 {total} 页')
  expectIncludes('the default footer text is exported', DEFAULT_PAGE_FOOTER, '{page}')

  const customFooter = buildPrintOptions({ footer: 'Page {page} / {total}' }, margins)
  expectEqual('a custom footer enables the footer area', customFooter.displayHeaderFooter, true)
  expectIncludes('a custom footer is kept', customFooter.footerTemplate, 'Page ')
  expectExcludes('a custom footer replaces the default', customFooter.footerTemplate, '第 ')

  const numberedCustom = buildPrintOptions({ pageNumbers: true, footer: 'p{page}' }, margins)
  expectExcludes('a custom footer wins over the default', numberedCustom.footerTemplate, '共 ')

  const headerOnly = buildPrintOptions({ header: 'T' }, margins)
  expectEqual('a header alone enables the header and footer area', headerOnly.displayHeaderFooter, true)
  expectIncludes('the header text is kept', headerOnly.headerTemplate, 'T')
  expectEqual('a header alone keeps the footer blank', headerOnly.footerTemplate, INERT_HEADER_FOOTER_TEMPLATE)

  const footerOnly = buildPrintOptions({ footer: 'F' }, margins)
  expectEqual('a footer alone enables the header and footer area', footerOnly.displayHeaderFooter, true)
  expectIncludes('the footer text is kept', footerOnly.footerTemplate, 'F')
  expectEqual('a footer alone keeps the header blank', footerOnly.headerTemplate, INERT_HEADER_FOOTER_TEMPLATE)

  const offWins = buildPrintOptions({ pageNumbers: false, header: '', footer: '' }, margins)
  expectEqual('empty text keeps the header and footer area off', offWins.displayHeaderFooter, false)

  const blankFooter = buildPrintOptions({ pageNumbers: true, footer: '   ' }, margins)
  expectIncludes('a blank footer falls back to the default', blankFooter.footerTemplate, '共 ')

  const stringFlag = buildPrintOptions({ pageNumbers: 'true' }, margins)
  expectEqual('a string flag does not enable page numbers', stringFlag.displayHeaderFooter, false)

  // The row configuration is read strictly: a quoted YAML boolean is reported,
  // not coerced into the opposite value.
  const validDefaults = documentDefaults({ pageNumbers: true, outline: false })
  expectEqual('a row page-number default is read', validDefaults.defaults.pageNumbers, true)
  expectEqual('a row outline default is read', validDefaults.defaults.outline, false)
  expectEqual('valid row defaults warn nothing', validDefaults.warnings.join(','), '')
  const quotedDefaults = documentDefaults({ pageNumbers: 'true', outline: 'false' })
  expectEqual('a quoted row boolean is not coerced', quotedDefaults.defaults.pageNumbers, undefined)
  expectEqual('a quoted row boolean is reported', quotedDefaults.warnings.join(','),
    'pageNumbers must be true or false,outline must be true or false')
  expectEqual('an absent row field stays absent', Object.keys(documentDefaults({}).defaults).join(','), '')

  const nested = buildPrintOptions({ document: { pageNumbers: true }, outline: false }, margins)
  expectEqual('a nested document config enables page numbers', nested.displayHeaderFooter, true)
  expectEqual('an outline false reaches the options', nested.generateDocumentOutline, false)

  const nestedDocumentOutline = buildPrintOptions({ document: { pageNumbers: true, outline: false } }, margins)
  expectEqual('a document outline flag reaches the options',
    nestedDocumentOutline.generateDocumentOutline, false)

  const emptyMargins = buildPrintOptions({}, {})
  expectEqual('missing margins become zero', Object.values(emptyMargins.margins).join(','), '0,0,0,0')
  const badMargins = buildPrintOptions({}, { top: -1, bottom: 'x', left: Number.NaN, right: 2 })
  expectEqual('invalid margins become zero', Object.values(badMargins.margins).join(','), '0,0,0,2')
  expectEqual('margin key order is stable', Object.keys(badMargins.margins).join(','), 'top,bottom,left,right')

  const dated = buildPrintOptions({ footer: '{date}' }, margins, { date: '2026-01-02' })
  expectIncludes('the footer date comes from the context', dated.footerTemplate, '2026-01-02')
  const datedDefault = buildPrintOptions({ footer: '{date}' }, margins)
  expectTrue('the footer date defaults to today',
    /\d{4}-\d{2}-\d{2}/.test(plainText(datedDefault.footerTemplate)))
  const titled = buildPrintOptions({ header: '{title}' }, margins, { title: '题名 <x>' })
  expectIncludes('the header title comes from the context', titled.headerTemplate, '题名 &lt;x&gt;')
  expectExcludes('the header title is escaped', titled.headerTemplate, '题名 <x>')

  // ---- Document config precedence ----------------------------------------

  expectEqual('the document outline defaults on', parseDocumentConfig({}).document.outline, true)
  expectEqual('front matter can set the outline',
    parseDocumentConfig({ 'pdf.outline': 'false' }).document.outline, false)
  expectEqual('front matter outline does not warn',
    parseDocumentConfig({ 'pdf.outline': 'false' }).warnings.join(','), '')
  expectEqual('an invalid outline is refused', captureCode(
    () => parseDocumentConfig({ 'pdf.outline': 'yes' })), 'bad-request')
  expectEqual('row defaults seed the document outline',
    parseDocumentConfig({}, { outline: false }).document.outline, false)
  expectEqual('row defaults seed page numbers',
    parseDocumentConfig({}, { pageNumbers: true }).document.pageNumbers, true)
  expectEqual('front matter outranks a row default',
    parseDocumentConfig({ 'pdf.pageNumbers': 'false' }, { pageNumbers: true }).document.pageNumbers, false)
  expectEqual('a request document override outranks front matter',
    mergeDocumentConfig({
      frontmatter: { 'pdf.pageNumbers': 'true' },
      request: { documentConfig: { pageNumbers: false } },
    }).document.pageNumbers, false)
  expectEqual('a merge default reaches the document',
    mergeDocumentConfig({ defaults: { pageNumbers: true, outline: false } }).document.pageNumbers, true)
  expectEqual('a merge default keeps the outline',
    mergeDocumentConfig({ defaults: { pageNumbers: true, outline: false } }).document.outline, false)
  expectEqual('a request outline override is accepted',
    mergeDocumentConfig({ request: { documentConfig: { outline: false } } }).document.outline, false)

  // ---- prepareExport handoff ---------------------------------------------

  const options = {
    jobs: createPrintJobs({ timeoutMs: 60_000 }),
    startPrintServer: async () => ({
      url: 'http://127.0.0.1:1/p/deadbeef/',
      close: async () => {},
    }),
  }

  const plain = join(work, 'plain.md')
  await writeFile(plain, '# 标题\n\n正文。\n', 'utf8')
  const defaultPrepared = await prepareExport({ path: plain }, options)
  expectEqual('prepare keeps the header and footer area off by default',
    defaultPrepared.printOptions.displayHeaderFooter, false)
  expectEqual('prepare turns the outline on by default',
    defaultPrepared.printOptions.generateDocumentOutline, true)
  expectEqual('prepare keeps four margins', Object.keys(defaultPrepared.printOptions.margins).join(','),
    'top,bottom,left,right')
  await finishExport({ finishToken: defaultPrepared.finishToken, pdfBytes: PDF }, options)

  const rowPrepared = await prepareExport({ path: plain }, { ...options, pageNumbers: true })
  expectEqual('a row page-number default reaches prepare', rowPrepared.printOptions.displayHeaderFooter, true)
  expectIncludes('a row page-number default prints the default footer', rowPrepared.printOptions.footerTemplate, '共 ')
  await finishExport({ finishToken: rowPrepared.finishToken, pdfBytes: PDF }, options)

  const rowOutline = await prepareExport({ path: plain }, { ...options, outline: false })
  expectEqual('a row outline default reaches prepare', rowOutline.printOptions.generateDocumentOutline, false)
  await finishExport({ finishToken: rowOutline.finishToken, pdfBytes: PDF }, options)

  // One configured side must not let Chromium fill the other side with its own
  // default header or footer.
  const headerOnlyFile = join(work, 'header-only.md')
  await writeFile(headerOnlyFile, ['---', 'pdf.header: 内部资料', '---', '', '# 正文', ''].join('\n'), 'utf8')
  const headerOnlyPrepared = await prepareExport({ path: headerOnlyFile }, options)
  expectEqual('a header alone enables the header area', headerOnlyPrepared.printOptions.displayHeaderFooter, true)
  expectIncludes('a header alone renders the header', headerOnlyPrepared.printOptions.headerTemplate, '内部资料')
  expectEqual('a header alone keeps the footer blank',
    headerOnlyPrepared.printOptions.footerTemplate, INERT_HEADER_FOOTER_TEMPLATE)
  await finishExport({ finishToken: headerOnlyPrepared.finishToken, pdfBytes: PDF }, options)

  const numbersOnlyFile = join(work, 'numbers-only.md')
  await writeFile(numbersOnlyFile, ['---', 'pdf.pageNumbers: true', '---', '', '# 正文', ''].join('\n'), 'utf8')
  const numbersOnlyPrepared = await prepareExport({ path: numbersOnlyFile }, options)
  expectEqual('page numbers alone keep the header blank',
    numbersOnlyPrepared.printOptions.headerTemplate, INERT_HEADER_FOOTER_TEMPLATE)
  expectIncludes('page numbers alone print the default footer',
    numbersOnlyPrepared.printOptions.footerTemplate, '共 ')
  await finishExport({ finishToken: numbersOnlyPrepared.finishToken, pdfBytes: PDF }, options)

  const footerOnlyFile = join(work, 'footer-only.md')
  await writeFile(footerOnlyFile, ['---', 'pdf.footer: 页脚', '---', '', '# 正文', ''].join('\n'), 'utf8')
  const footerOnlyPrepared = await prepareExport({ path: footerOnlyFile }, options)
  expectEqual('a footer alone keeps the header blank',
    footerOnlyPrepared.printOptions.headerTemplate, INERT_HEADER_FOOTER_TEMPLATE)
  expectIncludes('a footer alone renders the footer',
    footerOnlyPrepared.printOptions.footerTemplate, '页脚')
  await finishExport({ finishToken: footerOnlyPrepared.finishToken, pdfBytes: PDF }, options)

  const warnedPrepared = await prepareExport({ path: plain }, {
    ...options,
    configWarnings: ['outline must be true or false'],
  })
  expectEqual('row config warnings reach the export',
    warnedPrepared.warnings.includes('outline must be true or false'), true)
  await finishExport({ finishToken: warnedPrepared.finishToken, pdfBytes: PDF }, options)

  const frontMatter = join(work, 'front.md')
  await writeFile(frontMatter, [
    '---',
    'title: 示例文档',
    'author: DSH',
    'date: 2026-11-13',
    'pdf.pageNumbers: true',
    'pdf.header: 内部资料',
    'pdf.footer: 第 {page} 页 / 共 {total} 页',
    '---',
    '',
    '# 正文',
    '',
  ].join('\n'), 'utf8')
  const frontPrepared = await prepareExport({ path: frontMatter }, options)
  expectEqual('front matter page numbers reach prepare', frontPrepared.printOptions.displayHeaderFooter, true)
  expectIncludes('front matter header reaches prepare', frontPrepared.printOptions.headerTemplate, '内部资料')
  expectIncludes('front matter footer reaches prepare', frontPrepared.printOptions.footerTemplate, '第 ')
  expectExcludes('front matter page numbers do not leak as text', frontPrepared.printOptions.footerTemplate, '{page}')
  await finishExport({ finishToken: frontPrepared.finishToken, pdfBytes: PDF }, options)

  const variables = join(work, 'variables.md')
  await writeFile(variables, [
    '---',
    'title: 示例文档',
    'author: DSH',
    'date: 2026-11-13',
    'pdf.header: {title} / {author}',
    'pdf.footer: {date}',
    '---',
    '',
    '# 正文',
    '',
  ].join('\n'), 'utf8')
  const variablePrepared = await prepareExport({ path: variables }, options)
  expectIncludes('prepare fills the title from front matter', variablePrepared.printOptions.headerTemplate, '示例文档')
  expectIncludes('prepare fills the author from front matter', variablePrepared.printOptions.headerTemplate, 'DSH')
  expectIncludes('prepare fills the document date', variablePrepared.printOptions.footerTemplate, '2026-11-13')
  await finishExport({ finishToken: variablePrepared.finishToken, pdfBytes: PDF }, options)

  const escaped = join(work, 'escaped.md')
  await writeFile(escaped, [
    '---',
    'pdf.header: <b>x</b>',
    '---',
    '',
    '# 正文',
    '',
  ].join('\n'), 'utf8')
  const escapedPrepared = await prepareExport({ path: escaped }, options)
  expectIncludes('prepare escapes header markup', escapedPrepared.printOptions.headerTemplate, '&lt;b&gt;x&lt;/b&gt;')
  expectExcludes('prepare leaves no active header markup', escapedPrepared.printOptions.headerTemplate, '<b>x</b>')
  await finishExport({ finishToken: escapedPrepared.finishToken, pdfBytes: PDF }, options)

  const numberedFile = join(work, 'numbered.md')
  await writeFile(numberedFile, [
    '---',
    'pdf.pageNumbers: true',
    '---',
    '',
    '# 正文',
    '',
  ].join('\n'), 'utf8')
  const numberedPrepared = await prepareExport({ path: numberedFile }, options)
  expectEqual('front matter alone turns page numbers on',
    numberedPrepared.printOptions.displayHeaderFooter, true)
  await finishExport({ finishToken: numberedPrepared.finishToken, pdfBytes: PDF }, options)

  const overridePrepared = await prepareExport({
    path: numberedFile,
    documentConfig: { pageNumbers: false, outline: false },
  }, options)
  expectEqual('a request override turns page numbers off',
    overridePrepared.printOptions.displayHeaderFooter, false)
  expectEqual('a request override turns the outline off',
    overridePrepared.printOptions.generateDocumentOutline, false)
  await finishExport({ finishToken: overridePrepared.finishToken, pdfBytes: PDF }, options)

  // ---- Client and package contract ---------------------------------------

  const clientSource = await readFile(join(here, '..', 'client.js'), 'utf8')
  expectTrue('the client forwards the host print options unchanged',
    /\.printToPDF\(\s*job\.printOptions\s*[,)]/.test(clientSource))
  expectTrue('the client never assigns to one print option',
    !/printOptions\.[A-Za-z_$][\w$]*\s*=/.test(clientSource))
  expectTrue('the client builds no header or footer template',
    !/renderHeaderTemplate|renderFooterTemplate/.test(clientSource))

  const indexSource = await readFile(join(here, '..', 'index.js'), 'utf8')
  expectTrue('the host maps row defaults through documentDefaults',
    indexSource.includes('documentDefaults(config)'))
  expectTrue('the host forwards row warnings to the export',
    indexSource.includes('configWarnings: rowDocument.warnings'))

  const packageText = await readFile(join(here, '..', 'package.json'), 'utf8')
  expectTrue('the test chain runs the print option checks',
    packageText.includes('scripts/print-options-check.mjs'))
} finally {
  await rm(work, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  await rm(home, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
}

process.stdout.write('\n' + (checks - failures) + '/' + checks + ' checks passed\n')
process.exit(failures === 0 ? 0 : 1)

/**
 * Remove tags from a rendered template so its visible text can be read.
 * @param template - a rendered header or footer template.
 * @returns the template text without tags.
 */
function plainText(template) {
  return String(template).replace(/<[^>]*>/g, '')
}

/**
 * Run one call and return its error code.
 * @param run - the call expected to refuse its input.
 * @returns the error code, or undefined when no error was thrown.
 */
function captureCode(run) {
  try {
    run()
  } catch (error) {
    return error?.code
  }
  return undefined
}
