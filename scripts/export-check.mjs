/**
 * Assertions for the two-step export: prepare renders a page and starts the
 * one-shot loopback server; finish validates the returned bytes, stages them
 * beside the target, renames the file into place, and commits the job.
 *
 * The checks drive the real renderer against a temporary copy of
 * `samples/sample.md`. They never touch the shipped sample or its PDF, and they
 * prove the server is closed after a finish, after a refused finish, and after
 * the job deadline.
 *
 * Run: node scripts/export-check.mjs
 */
import { copyFile, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
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
  process.stdout.write(`FAIL ${label}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}\n`)
}

/**
 * Assert two numbers match within a tolerance.
 * @param label - what the check proves.
 * @param actual - produced number.
 * @param expected - required number.
 * @param tolerance - largest accepted difference.
 */
function expectClose(label, actual, expected, tolerance = 0.0002) {
  checks += 1
  if (typeof actual === 'number' && Math.abs(actual - expected) <= tolerance) return
  failures += 1
  process.stdout.write(`FAIL ${label}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}\n`)
}

/**
 * Run one async call and return the error it throws.
 * @param run - the call expected to refuse its input.
 * @returns the thrown error, or null when the call returned.
 */
async function capture(run) {
  try {
    await run()
  } catch (error) {
    return error
  }
  return null
}

/** Pause for a while. */
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * Run one async call and return its error or its value.
 * @param run - the call under test.
 * @returns the produced value or the thrown error.
 */
async function outcome(run) {
  try {
    return { value: await run() }
  } catch (error) {
    return { error }
  }
}

/**
 * Poll one job until it reaches a terminal state.
 *
 * A fixed sleep would race the render and the platform timer on a slow machine;
 * polling proves the state the deadline produced instead of assuming it.
 * @param store - the job store.
 * @param token - the job's finish token.
 * @param state - the required state.
 * @param timeoutMs - how long to wait.
 * @returns true when the state was observed inside the window.
 */
async function waitForJobState(store, token, state, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const job = store.get(token)
    if (job !== null && job.state === state) return true
    await sleep(20)
  }
  return false
}

/**
 * Report whether a URL stopped accepting connections.
 * @param url - the loopback document URL.
 * @param timeoutMs - how long to wait for the refusal.
 * @returns true when a request was refused inside the window.
 */
async function isClosed(url, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const open = await fetch(url).then((response) => {
      response.body?.cancel().catch(() => {})
      return true
    }, () => false)
    if (!open) return true
    await sleep(20)
  }
  return false
}

/**
 * Report whether any staging file is left in a directory.
 * @param directory - directory to scan.
 * @returns true when a `.md2pdf-*.pdf.tmp` file remains.
 */
async function hasStagingFile(directory) {
  const names = await readdir(directory)
  return names.some(name => name.startsWith('.md2pdf-') && name.endsWith('.pdf.tmp'))
}

/**
 * Read one loopback page's status without letting a closed server end the suite.
 * @param url - the loopback document URL.
 * @returns the HTTP status, or 0 when the server is closed.
 */
async function httpStatus(url) {
  try {
    const response = await fetch(url)
    await response.text()
    return response.status
  } catch {
    return 0
  }
}

const here = dirname(fileURLToPath(import.meta.url))
const home = await mkdtemp(join(tmpdir(), 'dsh-md2pdf-export-home-'))
const work = await mkdtemp(join(tmpdir(), 'dsh-md2pdf-export-work-'))
process.env['MD2PDF_HOME'] = home

const {
  atomicWritePdf, exportMarkdownToPdf, finishExport, prepareExport, sessionFileAddress, verifyPdf,
} = await import('../src/export.js')
const { createPrintJobs } = await import('../src/print-jobs.js')
const { describeEngines, printBrowser } = await import('../src/pdf.js')
const { savePresetPage, selectPreset } = await import('../src/presets.js')
const { scanAssets } = await import('../src/asset-scan.js')

const PDF = Buffer.from('%PDF-1.4\n%%EOF\n', 'latin1')
const OTHER_PDF = Buffer.from('%PDF-1.5\n%%EOF\n', 'latin1')

try {
  await copyFile(join(here, '..', 'samples', 'sample.md'), join(work, 'sample.md'))
  const source = join(work, 'sample.md')
  const target = join(work, 'sample.pdf')

  // Payload validation is the one predicate the job store and the exporter share.
  expectEqual('a non-pdf payload is refused', verifyPdf(Buffer.from('nope')).code, 'pdf-invalid')
  expectEqual('a non-pdf payload is not ok', verifyPdf(Buffer.from('nope')).ok, false)
  expectEqual('a complete pdf is accepted', verifyPdf(PDF).ok, true)
  expectEqual('a truncated pdf is refused', verifyPdf(Buffer.from('%PDF-1.4\nbody only')).code, 'pdf-invalid')

  // DSH resource addresses keep the leading slash, encode spaces, and let the
  // drive colon through so the viewer sees an ordinary absolute path. The path
  // keeps its own leading separator, so a POSIX address has two after the id.
  expectEqual('session file address',
    sessionFileAddress('s1', '/Users/liu/a b.md'),
    'dsh-resource://file/session/s1//Users/liu/a%20b.md')
  expectEqual('session file address normalizes windows separators',
    sessionFileAddress('s2', 'C:\\Users\\liu\\a b.md'),
    'dsh-resource://file/session/s2/C:/Users/liu/a%20b.md')

  // Prepare renders with the requested preset, serves the page, and holds the job.
  const prepared = await prepareExport({ path: source, sessionId: 's1', preset: 'paper' })
  expectEqual('prepare returns a job id', /^[0-9a-f]{32}$/.test(prepared.jobId), true)
  expectEqual('prepare returns a loopback document url',
    /^http:\/\/127\.0\.0\.1:\d+\/p\/[0-9a-f]{64}\/document\.html$/.test(prepared.printUrl), true)
  expectEqual('prepare returns a finish token', /^[0-9a-f]{64}$/.test(prepared.finishToken), true)
  expectEqual('prepare returns a warnings list', Array.isArray(prepared.warnings), true)
  expectEqual('prepare warns about an asset outside the source directory',
    prepared.warnings.some(warning => warning.includes('icon.svg')), true)
  expectEqual('prepare does not open a preview', Object.hasOwn(prepared, 'previewAddress'), false)

  const margins = prepared.printOptions.margins
  expectEqual('print options carry four margins', Object.keys(margins).join(','), 'top,bottom,left,right')
  expectEqual('all margins are positive numbers',
    Object.values(margins).every(value => typeof value === 'number' && value > 0), true)
  // `paper` sets 25mm 22mm; the selected default preset would be 20mm 18mm.
  expectClose('the requested preset sets the margins', margins.top, 0.9843)
  expectClose('the requested preset sets the right margin', margins.right, 0.8661)
  expectEqual('print background is on', prepared.printOptions.printBackground, true)
  expectEqual('css page size wins', prepared.printOptions.preferCSSPageSize, true)
  expectEqual('landscape is absent unless explicit', Object.hasOwn(prepared.printOptions, 'landscape'), false)
  expectEqual('headers and footers stay off', prepared.printOptions.displayHeaderFooter, false)
  expectEqual('the header template is empty by default', prepared.printOptions.headerTemplate, '')
  expectEqual('the footer template is empty by default', prepared.printOptions.footerTemplate, '')
  expectEqual('the outline is generated by default', prepared.printOptions.generateDocumentOutline, true)

  const served = await fetch(prepared.printUrl)
  expectEqual('the print page is served', served.status, 200)
  expectEqual('the print page is html', served.headers.get('content-type'), 'text/html; charset=utf-8')
  expectEqual('the server sets the csp', (served.headers.get('content-security-policy') ?? '').includes("script-src 'none'"), true)
  const servedHtml = await served.text()
  // The DSH webview blocks file: requests, so the served document must resolve
  // relative assets through the token path instead of a file base URL.
  expectEqual('the dsh page carries no file base', servedHtml.includes('<base href="file:'), false)
  expectEqual('the dsh page carries the csp meta', servedHtml.includes('<meta http-equiv="Content-Security-Policy"'), true)

  const first = await finishExport({ finishToken: prepared.finishToken, pdfBytes: PDF })
  expectEqual('finish reports the dsh engine', first.engine, 'dsh')
  expectEqual('finish writes the source-stem target', first.pdfPath, target)
  expectEqual('finish reports the byte count', first.bytes, PDF.byteLength)
  // Literal expectation: the address is the encoded session id, one separator,
  // then the absolute path with its own leading slash. The temp fixture holds
  // no reserved path characters beyond a possible space.
  const literalTarget = target.replace(/\\/g, '/').replace(/ /g, '%20')
  expectEqual('finish returns the literal preview address', first.previewAddress,
    `dsh-resource://file/session/s1/${literalTarget}`)
  expectEqual('finish writes the returned bytes', (await readFile(target)).equals(PDF), true)
  expectEqual('the server closes after finish', await isClosed(prepared.printUrl), true)
  expectEqual('finish leaves no staging file', await hasStagingFile(work), false)

  // A retry with the same token and bytes reuses the committed result.
  const repeated = await finishExport({ finishToken: prepared.finishToken, pdfBytes: PDF })
  expectEqual('a repeated finish returns the same result', repeated, first)
  const different = await capture(() => finishExport({
    finishToken: prepared.finishToken, pdfBytes: OTHER_PDF,
  }))
  expectEqual('different bytes after a commit conflict', different?.code, 'finish-conflict')
  expectEqual('a conflict keeps the committed pdf', (await readFile(target)).equals(PDF), true)

  // Two retries that arrive together still commit one file and one result.
  const parallel = await prepareExport({ path: source, sessionId: 's1' })
  const [left, right] = await Promise.all([
    finishExport({ finishToken: parallel.finishToken, pdfBytes: PDF }),
    finishExport({ finishToken: parallel.finishToken, pdfBytes: PDF }),
  ])
  expectEqual('concurrent finishes share one result', left, right)
  expectEqual('concurrent finishes keep one complete pdf', (await readFile(target)).equals(PDF), true)
  expectEqual('concurrent finishes leave no staging file', await hasStagingFile(work), false)

  const unknown = await capture(() => finishExport({ finishToken: 'missing-token', pdfBytes: PDF }))
  expectEqual('an unknown finish token is a bad request', unknown?.code, 'bad-request')

  // Only the finish token may commit. The asset token sits in the print URL and
  // the job id is returned to the client, so either one reaching finish must be
  // refused before any validation, write, or server shutdown.
  const guarded = await prepareExport({ path: source, sessionId: 's1' })
  const assetToken = /\/p\/([0-9a-f]{64})\/document\.html$/.exec(guarded.printUrl)?.[1] ?? ''
  expectEqual('the print url carries a 64-hex asset token', /^[0-9a-f]{64}$/.test(assetToken), true)
  const viaAsset = await capture(() => finishExport({ finishToken: assetToken, pdfBytes: OTHER_PDF }))
  expectEqual('an asset token is refused as a finish token', viaAsset?.code, 'bad-request')
  const viaJobId = await capture(() => finishExport({ finishToken: guarded.jobId, pdfBytes: OTHER_PDF }))
  expectEqual('a job id is refused as a finish token', viaJobId?.code, 'bad-request')
  expectEqual('a mismatched token leaves the target untouched', (await readFile(target)).equals(PDF), true)
  expectEqual('a mismatched token leaves no staging file', await hasStagingFile(work), false)
  expectEqual('a mismatched token leaves the job server up', await httpStatus(guarded.printUrl), 200)
  const guardedFinish = await outcome(() => finishExport({ finishToken: guarded.finishToken, pdfBytes: PDF }))
  expectEqual('the real token still finishes after a refused token', guardedFinish.value?.bytes, PDF.byteLength)
  expectEqual('the guarded server closes after the real finish', await isClosed(guarded.printUrl), true)

  // Invalid bytes fail the job, keep the old PDF, and close the server.
  const invalid = await prepareExport({ path: source, sessionId: 's1' })
  const rejected = await capture(() => finishExport({
    finishToken: invalid.finishToken, pdfBytes: Buffer.from('nope'),
  }))
  expectEqual('an invalid payload is refused', rejected?.code, 'pdf-invalid')
  expectEqual('an invalid payload keeps the old pdf', (await readFile(target)).equals(PDF), true)
  expectEqual('the server closes after a failed finish', await isClosed(invalid.printUrl), true)
  const late = await capture(() => finishExport({ finishToken: invalid.finishToken, pdfBytes: PDF }))
  expectEqual('a failed job refuses later valid bytes', late?.code, 'state-conflict')

  // No session id means no viewer address, but the file is still written.
  const anonymous = await prepareExport({ path: source })
  const written = await finishExport({ finishToken: anonymous.finishToken, pdfBytes: PDF })
  expectEqual('no session id means no preview address', Object.hasOwn(written, 'previewAddress'), false)
  expectEqual('an anonymous job still writes the pdf', written.bytes, PDF.byteLength)

  // An explicit landscape flag reaches the client print options; a missing flag
  // must stay absent so the CSS @page box decides the orientation.
  const landscape = await prepareExport({ path: source, page: { landscape: true } })
  expectEqual('an explicit landscape reaches the print options', landscape.printOptions.landscape, true)
  await finishExport({ finishToken: landscape.finishToken, pdfBytes: PDF })

  const rejectedPage = await capture(() => prepareExport({ path: source, page: { size: 'B5' } }))
  expectEqual('an invalid page override is refused', rejectedPage?.code, 'bad-request')
  const unknownPageField = await capture(() => prepareExport({ path: source, page: { bleed: 3 } }))
  expectEqual('an unknown request page field is refused', unknownPageField?.code, 'bad-request')

  // Preset page metadata is the lowest explicit page layer. Only its explicit
  // fields are emitted, so a font-size-only metadata leaves the preset's own
  // @page box in charge; the gongwen margins must survive it.
  await savePresetPage('paper', { marginMm: 20 })
  const metadataPage = await prepareExport({ path: source, preset: 'paper' })
  expectClose('preset page metadata sets the print margin', metadataPage.printOptions.margins.top, 0.7874)
  const metadataHtml = await (await fetch(metadataPage.printUrl)).text()
  expectEqual('preset page metadata reaches the page css',
    metadataHtml.includes('@page{margin:20mm}'), true)
  await finishExport({ finishToken: metadataPage.finishToken, pdfBytes: PDF })

  await savePresetPage('gongwen', { fontSize: 12 })
  const fontMetadata = await prepareExport({ path: source, preset: 'gongwen' })
  expectClose('font-only preset page metadata keeps the gongwen margin',
    fontMetadata.printOptions.margins.top, 1.4567)
  const fontMetadataHtml = await (await fetch(fontMetadata.printUrl)).text()
  expectEqual('font-only preset page metadata emits only the body size',
    fontMetadataHtml.includes('body{font-size:12px}'), true)
  expectEqual('font-only preset page metadata emits no page margin',
    fontMetadataHtml.includes('@page{margin:20mm}'), false)
  await finishExport({ finishToken: fontMetadata.finishToken, pdfBytes: PDF })

  // The document config reaches the rendered page: a TOC links the heading ids,
  // an explicit page break becomes the break element, and the paper fields
  // render on the paper template's first body page.
  const tocSource = join(work, 'toc.md')
  await writeFile(tocSource, [
    '---',
    'pdf.toc: true',
    '---',
    '',
    '# 第一章',
    '',
    '## 第一节',
    '',
    '正文。',
    '',
  ].join('\n'))
  const tocPrepared = await prepareExport({ path: tocSource })
  const tocHtml = await (await fetch(tocPrepared.printUrl)).text()
  expectEqual('a front matter toc reaches the page',
    tocHtml.includes('<nav class="md2pdf-toc">'), true)
  expectEqual('the toc links the heading id',
    tocHtml.includes('<a href="#md2pdf-h-第一章">第一章</a>'), true)
  await finishExport({ finishToken: tocPrepared.finishToken, pdfBytes: PDF })

  const breakSource = join(work, 'break.md')
  await writeFile(breakSource, 'A\n\n<!-- pagebreak -->\n\nB\n')
  const breakPrepared = await prepareExport({ path: breakSource })
  const breakHtml = await (await fetch(breakPrepared.printUrl)).text()
  expectEqual('an explicit page break reaches the page',
    breakHtml.includes('<div class="md2pdf-pagebreak"></div>'), true)
  await finishExport({ finishToken: breakPrepared.finishToken, pdfBytes: PDF })

  const paperFieldsSource = join(work, 'paper-fields.md')
  await writeFile(paperFieldsSource, [
    '---',
    'pdf.paper.title: 题名',
    'pdf.paper.authors: 张三',
    '---',
    '',
    '# 引言',
    '',
  ].join('\n'))
  const paperPrepared = await prepareExport({ path: paperFieldsSource, preset: 'paper' })
  const paperHtml = await (await fetch(paperPrepared.printUrl)).text()
  expectEqual('paper fields reach the paper page',
    paperHtml.includes('<section class="md2pdf-paper">'), true)
  expectEqual('paper authors reach the paper page',
    paperHtml.includes('md2pdf-paper-authors">张三<'), true)
  expectEqual('paper fields produce no warning on the paper preset',
    paperPrepared.warnings.some(warning => warning.includes('paper preset')), false)
  await finishExport({ finishToken: paperPrepared.finishToken, pdfBytes: PDF })

  const larkPaperPrepared = await prepareExport({ path: paperFieldsSource, preset: 'lark' })
  expectEqual('paper fields warn on another preset',
    larkPaperPrepared.warnings.some(warning => warning.includes('paper preset')), true)
  const larkPaperHtml = await (await fetch(larkPaperPrepared.printUrl)).text()
  expectEqual('another preset renders no paper block',
    larkPaperHtml.includes('<section class="md2pdf-paper">'), false)
  await finishExport({ finishToken: larkPaperPrepared.finishToken, pdfBytes: PDF })

  const englishSource = join(work, 'english.md')
  await writeFile(englishSource, [
    '---',
    'lang: en-US',
    'pdf.toc: true',
    'pdf.paper.abstract: English abstract.',
    '---',
    '',
    '# English heading',
    '',
  ].join('\n'))
  const englishPrepared = await prepareExport({ path: englishSource, preset: 'paper' })
  const englishHtml = await (await fetch(englishPrepared.printUrl)).text()
  expectEqual('the document language reaches the export',
    englishHtml.includes('<html lang="en-US">'), true)
  expectEqual('an english export uses the english toc title',
    englishHtml.includes('<p class="md2pdf-toc-title">Contents</p>'), true)
  expectEqual('an english export uses english paper labels',
    englishHtml.includes('Abstract: '), true)
  await finishExport({ finishToken: englishPrepared.finishToken, pdfBytes: PDF })

  const emptyPaperSource = join(work, 'empty-paper.md')
  await writeFile(emptyPaperSource, ['---', 'pdf.paper.title:', '---', '', '# 正文', ''].join('\n'))
  const emptyPaper = await prepareExport({ path: emptyPaperSource, preset: 'lark' })
  expectEqual('an empty paper field is not a paper warning',
    emptyPaper.warnings.some(warning => warning.includes('paper preset')), false)
  await finishExport({ finishToken: emptyPaper.finishToken, pdfBytes: PDF })

  const unknownPaperSource = join(work, 'unknown-paper.md')
  await writeFile(unknownPaperSource, ['---', 'pdf.paper.unknown: x', '---', '', '# 正文', ''].join('\n'))
  const unknownPaper = await prepareExport({ path: unknownPaperSource, preset: 'paper' })
  expectEqual('an unknown paper field warns',
    unknownPaper.warnings.includes('pdf.paper.unknown'), true)
  await finishExport({ finishToken: unknownPaper.finishToken, pdfBytes: PDF })

  // Flat `pdf.*` front matter configures the page and the preset. A request
  // preset outranks `pdf.preset`, which outranks the selected preset, and an
  // unknown `pdf.*` key is reported as a warning instead of blocking.
  const configuredSource = join(work, 'frontmatter.md')
  await writeFile(configuredSource, [
    '---',
    'title: Front matter',
    'pdf.preset: paper',
    'pdf.page.size: A3',
    'pdf.page.landscape: true',
    'pdf.page.marginMm: 30',
    'pdf.unknown: keep',
    '---',
    '',
    '# Heading',
    '',
  ].join('\n'))
  const configured = await prepareExport({ path: configuredSource, sessionId: 's1' })
  expectEqual('front matter warnings are returned', configured.warnings.join(','), 'pdf.unknown')
  expectEqual('front matter landscape reaches print options', configured.printOptions.landscape, true)
  expectClose('front matter margin reaches print options', configured.printOptions.margins.top, 1.1811)
  const configuredResponse = await fetch(configured.printUrl)
  const configuredHtml = await configuredResponse.text()
  expectEqual('front matter page override reaches the page css',
    configuredHtml.includes('@page{size:A3 landscape;margin:30mm}'), true)
  expectEqual('front matter preset is honoured', configuredHtml.includes('sup.footnote-ref a'), true)
  await finishExport({ finishToken: configured.finishToken, pdfBytes: PDF })

  // The request page is the highest layer: it outranks the file's front matter,
  // which already outranks the preset metadata.
  const requestPage = await prepareExport({
    path: configuredSource,
    preset: 'paper',
    page: { marginMm: 20 },
  })
  expectClose('a request page outranks front matter', requestPage.printOptions.margins.top, 0.7874)
  await finishExport({ finishToken: requestPage.finishToken, pdfBytes: PDF })

  // A request page with one explicit field leaves the other layers alone.
  const requestFont = await prepareExport({ path: source, page: { fontSize: 13 } })
  expectClose('a font-size-only request keeps the preset page box',
    requestFont.printOptions.margins.top, 0.7874)
  await finishExport({ finishToken: requestFont.finishToken, pdfBytes: PDF })

  const overriding = await prepareExport({ path: configuredSource, preset: 'gongwen' })
  const overridingResponse = await fetch(overriding.printUrl)
  const overridingHtml = await overridingResponse.text()
  expectEqual('a request preset outranks the front matter preset',
    overridingHtml.includes('sup.footnote-ref a'), false)
  expectEqual('the request preset stylesheet is used', overridingHtml.includes('color: #e60012'), true)
  await finishExport({ finishToken: overriding.finishToken, pdfBytes: PDF })

  const badPresetSource = join(work, 'bad-preset.md')
  await writeFile(badPresetSource, '---\npdf.preset: missing\n---\n\n# Heading\n')
  const badPreset = await capture(() => prepareExport(
    { path: badPresetSource },
    { jobs: createPrintJobs({ timeoutMs: 150 }) },
  ))
  expectEqual('an unknown front matter preset is not found', badPreset?.code, 'not-found')

  // Deadline: the timer expires the job and closes its server. The window is
  // long enough for a slow render; the state is polled, not assumed.
  const urgent = createPrintJobs({ timeoutMs: 1_000 })
  const expiring = await prepareExport({ path: source }, { jobs: urgent })
  expectEqual('a timed job starts prepared', urgent.get(expiring.finishToken).state, 'prepared')
  expectEqual('the deadline expires the job',
    await waitForJobState(urgent, expiring.finishToken, 'expired'), true)
  expectEqual('the server closes at the deadline', await isClosed(expiring.printUrl), true)
  const expired = await capture(() => finishExport({
    finishToken: expiring.finishToken, pdfBytes: PDF,
  }, { jobs: urgent }))
  expectEqual('an expired job refuses a late finish', expired?.code, 'job-timeout')

  // Atomic output: bytes land beside the target, and staging never survives.
  const atomicTarget = join(work, 'atomic.pdf')
  await atomicWritePdf(atomicTarget, PDF)
  expectEqual('atomic write stores the bytes', (await readFile(atomicTarget)).equals(PDF), true)
  expectEqual('atomic write leaves no staging file', await hasStagingFile(work), false)

  // A symlink target is refused and the file it points at stays untouched.
  const realTarget = join(work, 'real.pdf')
  await writeFile(realTarget, PDF)
  const linkTarget = join(work, 'link.pdf')
  let linked = false
  try {
    await symlink(realTarget, linkTarget, 'file')
    linked = true
  } catch (error) {
    // Windows without the file-symlink privilege cannot make the fixture.
    if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) throw error
  }
  if (linked) {
    const refusedLink = await capture(() => atomicWritePdf(linkTarget, OTHER_PDF))
    expectEqual('a symlink target is refused', refusedLink?.code, 'bad-request')
    expectEqual('a symlink target keeps its file', (await readFile(realTarget)).equals(PDF), true)
  }

  // A locked target is retried at 100/300/900 ms, then refused as file-busy.
  const busyTarget = join(work, 'busy.pdf')
  await writeFile(busyTarget, PDF)
  let attempts = 0
  const busy = await capture(() => atomicWritePdf(busyTarget, OTHER_PDF, {
    jobId: 'testbusy',
    rename: async () => {
      attempts += 1
      const error = new Error('the target is locked')
      error.code = 'EPERM'
      throw error
    },
  }))
  expectEqual('a locked target is file-busy', busy?.code, 'file-busy')
  expectEqual('a locked target is tried once plus three retries', attempts, 4)
  expectEqual('a locked target keeps the old pdf', (await readFile(busyTarget)).equals(PDF), true)
  expectEqual('a locked target leaves no staging file', await hasStagingFile(work), false)

  // Asset scan: local references resolve under the source directory; a missing
  // file, an escape, a remote URL, and an unsupported scheme are warnings. The
  // export continues, so the caller can report them without failing the PDF.
  await writeFile(join(work, 'present.png'), Buffer.from('89504e470d0a1a0a', 'hex'))
  const assetWarnings = await scanAssets([
    '<img src="present.png">',
    '<img src="missing.png">',
    '<img src="https://example.com/remote.png">',
    '<img src="data:image/png;base64,AAAA">',
    '<style>body { background: url(../outside.png) }</style>',
    '<style>@font-face { font-family: X; src: url(missing.woff2) }</style>',
  ].join(''), work)
  expectEqual('a missing local asset is warned',
    assetWarnings.some(warning => warning.includes('missing.png')), true)
  expectEqual('a missing local font is warned',
    assetWarnings.some(warning => warning.includes('missing.woff2')), true)
  expectEqual('a remote asset is warned',
    assetWarnings.some(warning => warning.includes('https://example.com/remote.png')), true)
  expectEqual('an asset outside the root is warned',
    assetWarnings.some(warning => warning.includes('../outside.png')), true)
  expectEqual('a present asset is not warned',
    assetWarnings.some(warning => warning.includes('present.png')), false)
  expectEqual('a data url is not warned',
    assetWarnings.some(warning => warning.includes('data:')), false)
  await writeFile(join(work, '.secret.png'), Buffer.from('89504e47', 'hex'))
  const dotWarning = await scanAssets('<img src=".secret.png">', work)
  expectEqual('a dotfile asset is warned',
    dotWarning.some(warning => warning.includes('.secret.png')), true)
  const dotNavigation = await scanAssets('<img src="./present.png">', work)
  expectEqual('ordinary ./ navigation is not warned',
    dotNavigation.some(warning => warning.includes('present.png')), false)

  // The print server rejects a symlink at any segment; the scan must agree.
  const assetLink = join(work, 'asset-link.png')
  let assetLinked = false
  try {
    await symlink(join(work, 'present.png'), assetLink, 'file')
    assetLinked = true
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) throw error
  }
  if (assetLinked) {
    const linkedWarnings = await scanAssets('<img src="asset-link.png">', work)
    expectEqual('an asset reached through a symlink is warned',
      linkedWarnings.some(warning => warning.includes('asset-link.png')), true)
  }

  // The browser fallback applies the same page model as the DSH path: selected
  // preset page metadata, then the file's front matter, then the request page;
  // a request preset outranks `pdf.preset`, which outranks the selected preset.
  // The printer is injected so the rendered HTML can be inspected without
  // launching a browser; a failing executable stands in if the injection is
  // ever bypassed.
  const fallbackCalls = []
  const fallbackPrinter = async (htmlPath, outPath) => {
    fallbackCalls.push(await readFile(htmlPath, 'utf8'))
    await writeFile(outPath, PDF)
    return { engine: 'browser', printer: 'fake-browser', bytes: PDF.byteLength }
  }
  const failingBrowser = join(work, 'failing-browser')
  await writeFile(failingBrowser, `#!${process.execPath}\nprocess.exit(1)\n`, { mode: 0o755 })
  const fallbackOptions = {
    browserPath: failingBrowser,
    printBrowser: fallbackPrinter,
    timeoutMs: 2_000,
  }

  await selectPreset('paper')
  const fallbackPreset = await outcome(() => exportMarkdownToPdf({ path: source }, fallbackOptions))
  expectEqual('the fallback exports the file', fallbackPreset.value?.ok, true)
  expectEqual('the fallback reports the browser engine', fallbackPreset.value?.engine, 'browser')
  expectEqual('the fallback writes beside the source',
    fallbackPreset.value?.pdfPath, join(work, 'sample.pdf'))
  expectEqual('the fallback keeps the existing response shape',
    Object.keys(fallbackPreset.value ?? {}).sort().join(','),
    'bytes,durationMs,engine,generator,math,ok,pdfPath,printer,sourcePath,theme')
  expectEqual('the fallback applies the selected preset page metadata',
    fallbackCalls.at(-1)?.includes('<style id="md2pdf-page">\n@page{margin:20mm}\n</style>'), true)
  expectEqual('the fallback reports the selected preset', fallbackPreset.value?.theme, 'paper')

  // The fallback renders the same document config as the DSH path.
  const fallbackToc = join(work, 'fallback-toc.md')
  await writeFile(fallbackToc, [
    '---',
    'pdf.toc: true',
    '---',
    '',
    '# Fallback heading',
    '',
    '## Fallback sub',
    '',
  ].join('\n'))
  const fallbackTocRun = await outcome(() => exportMarkdownToPdf({ path: fallbackToc }, fallbackOptions))
  expectEqual('the fallback exports a toc document', fallbackTocRun.value?.ok, true)
  expectEqual('the fallback renders a toc',
    fallbackCalls.at(-1)?.includes('<nav class="md2pdf-toc">'), true)
  expectEqual('the fallback toc links the heading id',
    fallbackCalls.at(-1)?.includes('href="#md2pdf-h-fallback-heading"'), true)

  const fallbackPaper = join(work, 'fallback-paper.md')
  await writeFile(fallbackPaper, [
    '---',
    'pdf.paper.title: 题名',
    'pdf.paper.authors: 张三',
    '---',
    '',
    '# 引言',
    '',
  ].join('\n'))
  const fallbackPaperRun = await outcome(() => exportMarkdownToPdf({ path: fallbackPaper }, fallbackOptions))
  expectEqual('the fallback exports a paper document', fallbackPaperRun.value?.ok, true)
  expectEqual('the fallback renders the paper block',
    fallbackCalls.at(-1)?.includes('<section class="md2pdf-paper">'), true)
  expectEqual('the fallback renders paper authors',
    fallbackCalls.at(-1)?.includes('md2pdf-paper-authors">张三<'), true)

  const fallbackFront = join(work, 'fallback-frontmatter.md')
  await writeFile(fallbackFront, [
    '---',
    'pdf.page.marginMm: 30',
    'pdf.page.fontSize: 13',
    '---',
    '',
    '# Fallback front matter',
    '',
  ].join('\n'))
  const fallbackFrontRun = await outcome(() => exportMarkdownToPdf({ path: fallbackFront }, fallbackOptions))
  expectEqual('the fallback renders a front matter file', fallbackFrontRun.value?.ok, true)
  expectEqual('fallback front matter outranks the preset page',
    fallbackCalls.at(-1)?.includes('<style id="md2pdf-page">\n@page{margin:30mm}\nbody{font-size:13px}\n</style>'), true)

  const fallbackDeclared = join(work, 'fallback-declared.md')
  await writeFile(fallbackDeclared, '---\npdf.preset: gongwen\n---\n\n# Fallback preset\n')
  const fallbackDeclaredRun = await outcome(() => exportMarkdownToPdf({ path: fallbackDeclared }, fallbackOptions))
  expectEqual('the fallback honours the front matter preset', fallbackDeclaredRun.value?.theme, 'gongwen')
  expectEqual('the fallback uses the front matter preset stylesheet',
    fallbackCalls.at(-1)?.includes('color: #e60012'), true)
  expectEqual('font-only preset metadata reaches the fallback page layer',
    fallbackCalls.at(-1)?.includes('<style id="md2pdf-page">\nbody{font-size:12px}\n</style>'), true)

  const fallbackRequestPreset = await outcome(() => exportMarkdownToPdf(
    { path: fallbackDeclared, preset: 'paper' }, fallbackOptions))
  expectEqual('a fallback request preset outranks the front matter preset',
    fallbackRequestPreset.value?.theme, 'paper')
  expectEqual('the fallback request preset stylesheet is used',
    fallbackCalls.at(-1)?.includes('color: #e60012'), false)
  expectEqual('the fallback request preset page metadata is used',
    fallbackCalls.at(-1)?.includes('<style id="md2pdf-page">\n@page{margin:20mm}\n</style>'), true)

  const fallbackRequestPage = await outcome(() => exportMarkdownToPdf(
    { path: fallbackFront, page: { marginMm: 12 } }, fallbackOptions))
  expectEqual('a fallback request page outranks front matter', fallbackRequestPage.value?.ok, true)
  expectEqual('the fallback request page is the last page layer',
    fallbackCalls.at(-1)?.includes('<style id="md2pdf-page">\n@page{margin:12mm}\nbody{font-size:13px}\n</style>'), true)

  await selectPreset('lark')
  const fallbackEmptyPage = await outcome(() => exportMarkdownToPdf(
    { path: source, page: {} }, fallbackOptions))
  expectEqual('an empty fallback page adds no override', fallbackEmptyPage.value?.ok, true)
  expectEqual('an empty fallback page emits no page style',
    fallbackCalls.at(-1)?.includes('<style id="md2pdf-page">'), false)

  const fallbackCallsBefore = fallbackCalls.length
  const fallbackBadSize = await outcome(() => exportMarkdownToPdf(
    { path: source, page: { size: 'B5' } }, fallbackOptions))
  expectEqual('the fallback refuses an invalid page', fallbackBadSize.error?.code, 'bad-request')
  const fallbackBadField = await outcome(() => exportMarkdownToPdf(
    { path: source, page: { bleed: 3 } }, fallbackOptions))
  expectEqual('the fallback refuses an unknown page field', fallbackBadField.error?.code, 'bad-request')
  expectEqual('a refused fallback page never prints', fallbackCalls.length, fallbackCallsBefore)

  // The browser fallback is still exported and reports only the browser engine.
  expectEqual('the browser printer is exported', typeof printBrowser, 'function')
  const engines = await describeEngines({ browserPath: join(work, 'missing-browser') })
  expectEqual('the host no longer reports an electron engine', Object.hasOwn(engines.available, 'electron'), false)
} finally {
  await rm(work, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  await rm(home, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
}

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`)
process.exit(failures === 0 ? 0 : 1)
