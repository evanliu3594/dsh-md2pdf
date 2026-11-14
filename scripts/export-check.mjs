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

const here = dirname(fileURLToPath(import.meta.url))
const home = await mkdtemp(join(tmpdir(), 'dsh-md2pdf-export-home-'))
const work = await mkdtemp(join(tmpdir(), 'dsh-md2pdf-export-work-'))
process.env['MD2PDF_HOME'] = home

const {
  atomicWritePdf, finishExport, prepareExport, sessionFileAddress, verifyPdf,
} = await import('../src/export.js')
const { createPrintJobs } = await import('../src/print-jobs.js')
const { describeEngines, printBrowser } = await import('../src/pdf.js')

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
  // drive colon through so the viewer sees an ordinary absolute path.
  expectEqual('session file address',
    sessionFileAddress('s1', '/Users/liu/a b.md'),
    'dsh-resource://file/session/s1/Users/liu/a%20b.md')
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
  expectEqual('the outline stays off for now', prepared.printOptions.generateDocumentOutline, false)

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
  expectEqual('finish returns the preview address', first.previewAddress, sessionFileAddress('s1', target))
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

  // Deadline: the timer expires the job and closes its server.
  const urgent = createPrintJobs({ timeoutMs: 150 })
  const expiring = await prepareExport({ path: source }, { jobs: urgent })
  expectEqual('a timed job starts prepared', urgent.get(expiring.finishToken).state, 'prepared')
  expectEqual('the server closes at the deadline', await isClosed(expiring.printUrl), true)
  expectEqual('the deadline expires the job', urgent.get(expiring.finishToken).state, 'expired')
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
