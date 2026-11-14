/**
 * Paper output: the browser fallback and PDF payload validation.
 *
 * The DSH path renders HTML and lets the DSH client's own Chromium print it.
 * This module owns the fallback that works from any Node host: a Chromium-family
 * browser prints a `file:` document, and the caller waits for the written file.
 * The host Electron printer was removed in v2 because the Host process cannot
 * reach the Electron main process.
 *
 * Both paths share {@link verifyPdf}, so a printer that exits zero without a
 * complete PDF still fails.
 */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { run, which } from './proc.js'

/** Chromium switches that keep a print run headless, silent, and offline. */
const PRINT_FLAGS = [
  '--headless=new',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-sync',
  '--mute-audio',
  '--hide-scrollbars',
  '--run-all-compositor-stages-before-draw',
  '--virtual-time-budget=20000',
  '--no-pdf-header-footer',
  '--print-to-pdf-no-header',
]

/** Windows install locations, in preference order. */
function windowsCandidates() {
  const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files'
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const localAppData = process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local')
  return [
    join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(programFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    join(localAppData, 'Chromium', 'Application', 'chrome.exe'),
  ]
}

/** macOS application bundle executables, in preference order. */
const MACOS_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
]

/** Commands tried on `PATH` when no known install location matched. */
const PATH_COMMANDS = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'msedge', 'chrome']

/** Cached browser resolution for this process, keyed by the configured override. */
const browserCache = new Map()

/**
 * Resolve a Chromium-family executable.
 * @param options - explicit `browserPath` or a preferred engine.
 * @returns the executable path, or null when none is installed.
 */
export async function findBrowser(options = {}) {
  const override = options.browserPath ?? process.env['MD2PDF_BROWSER']
  const key = `${override ?? ''}`
  const cached = browserCache.get(key)
  if (cached !== undefined) return cached

  let resolved = null
  if (typeof override === 'string' && override !== '') {
    resolved = await which(override)
  }
  if (resolved === null) {
    const candidates = process.platform === 'win32'
      ? windowsCandidates()
      : process.platform === 'darwin' ? MACOS_CANDIDATES : []
    for (const candidate of candidates) {
      if (await which(candidate) !== null) {
        resolved = candidate
        break
      }
    }
  }
  if (resolved === null) {
    for (const command of PATH_COMMANDS) {
      const found = await which(command)
      if (found !== null) {
        resolved = found
        break
      }
    }
  }
  browserCache.set(key, resolved)
  return resolved
}

/**
 * Describe which engine this Host can use without printing anything.
 *
 * The only Host-side engine is the browser fallback. The DSH engine lives in the
 * client, so the Host reports it as unknown rather than guessing.
 * @param options - engine preference and explicit paths.
 * @returns the requested engine, the chosen engine, and the resolved executable.
 */
export async function describeEngines(options = {}) {
  const request = options.engine ?? 'auto'
  const browser = await findBrowser(options)
  const available = { browser: browser === null ? null : browser }
  return { request, chosen: available.browser, available }
}

/** Throwable carrier for one named renderer failure. */
export class PdfError extends Error {
  /**
   * @param code - stable machine code, such as `no-printer`.
   * @param message - operator-facing explanation.
   */
  constructor(code, message) {
    super(message)
    this.name = 'PdfError'
    this.code = code
  }
}

/** Leading bytes every accepted PDF starts with. */
const PDF_HEADER = Buffer.from('%PDF-', 'latin1')

/** Trailer bytes every accepted PDF ends with. */
const PDF_TRAILER = Buffer.from('%%EOF', 'latin1')

/** How much of the end of the byte stream may hold the trailer. */
const PDF_TRAILER_BYTES = 2048

/**
 * Validate one PDF payload.
 *
 * This mirrors the print-job store's predicate so the exporter and the commit
 * step cannot disagree about what a complete document is.
 * @param pdfBytes - bytes returned by a printer.
 * @returns `{ ok: true }`, or `{ ok: false, code }` with a stable failure code.
 */
export function verifyPdf(pdfBytes) {
  const bytes = Buffer.isBuffer(pdfBytes)
    ? pdfBytes
    : pdfBytes instanceof Uint8Array ? Buffer.from(pdfBytes) : null
  if (bytes === null) return { ok: false, code: 'pdf-invalid' }
  if (bytes.byteLength === 0) return { ok: false, code: 'empty-output' }
  if (bytes.byteLength < PDF_HEADER.length) return { ok: false, code: 'pdf-invalid' }
  if (!bytes.subarray(0, PDF_HEADER.length).equals(PDF_HEADER)) return { ok: false, code: 'pdf-invalid' }
  const tail = bytes.subarray(Math.max(0, bytes.byteLength - PDF_TRAILER_BYTES))
  if (!tail.includes(PDF_TRAILER)) return { ok: false, code: 'pdf-invalid' }
  return { ok: true }
}

/**
 * Describe the current state of a file, or null when it is absent.
 * @param path - absolute file path.
 * @returns its size and modification time.
 */
async function snapshotOf(path) {
  const info = await stat(path).catch(() => null)
  return info === null ? null : { size: info.size, mtimeMs: info.mtimeMs }
}

/** Pause for a few milliseconds. */
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * Read a PDF that has finished being written.
 *
 * Chromium reports its exit before the renderer has flushed the document, so
 * the file appears shortly after the child closes. Polling for a changed file
 * with a complete trailer is what distinguishes "printed" from "still writing"
 * and from "the previous run's PDF is still lying there".
 * @param path - absolute PDF target.
 * @param before - state of that path before printing, or null.
 * @param settleMs - how long to wait for the file to appear and settle.
 * @returns the byte count, or null when nothing complete arrived in time.
 */
export async function awaitPdf(path, before, settleMs) {
  const deadline = Date.now() + settleMs
  let lastSize = -1
  while (Date.now() < deadline) {
    const current = await snapshotOf(path)
    if (current !== null && current.size > 0) {
      const changed = before === null || current.size !== before.size || current.mtimeMs !== before.mtimeMs
      // Two equal readings mean the writer stopped extending the file.
      const settled = current.size === lastSize
      lastSize = current.size
      if (changed && settled) {
        const buffer = await readFile(path).catch(() => null)
        if (buffer !== null && buffer.subarray(0, 5).toString('latin1') === '%PDF-') {
          const tail = buffer.subarray(Math.max(0, buffer.byteLength - 2048)).toString('latin1')
          if (tail.includes('%%EOF')) return buffer.byteLength
        }
      }
    }
    await sleep(60)
  }
  return null
}

/**
 * Print one HTML file with a Chromium-family browser.
 *
 * The caller passes a staging path, not the final target, so the exporter can
 * validate the bytes and rename them into place. Chromium reports its exit
 * before the renderer has flushed the document, so the wait polls the file.
 * @param htmlPath - the `file:` document to print.
 * @param outPath - absolute staging path for the PDF.
 * @param options - explicit browser path and deadlines.
 * @returns the produced byte count and the executable that printed it.
 * @throws {PdfError} when no browser is installed, the run fails, or the
 *   produced file is not a complete PDF.
 */
export async function printBrowser(htmlPath, outPath, options = {}) {
  const browser = await findBrowser(options)
  if (browser === null) throw new PdfError('no-printer', 'no Chromium-family browser found')
  const before = await snapshotOf(outPath)
  const profile = await mkdtemp(join(tmpdir(), 'dsh-md2pdf-profile-'))
  try {
    const result = await run(browser, [
      ...PRINT_FLAGS,
      `--user-data-dir=${profile}`,
      `--print-to-pdf=${outPath}`,
      pathToFileURL(htmlPath).href,
    ], { timeoutMs: options.timeoutMs ?? 120_000 })
    if (result.code !== 0) {
      throw new PdfError('print-failed', `browser exited ${result.code}: ${result.stderr.trim().slice(0, 400)}`)
    }
    // The profile outlives the child: Chromium keeps using it while it writes.
    const bytes = await awaitPdf(outPath, before, options.settleMs ?? 20_000)
    if (bytes === null) {
      throw new PdfError(
        'print-failed',
        `browser exited without writing ${outPath}${result.stderr.trim() === '' ? '' : `: ${result.stderr.trim().slice(0, 400)}`}`,
      )
    }
    const written = await readFile(outPath).catch(() => null)
    if (written === null) {
      throw new PdfError('print-failed', `browser wrote a file that is no longer readable: ${outPath}`)
    }
    const verified = verifyPdf(written)
    if (!verified.ok) {
      throw new PdfError(verified.code, `the browser left an unusable PDF at ${outPath}`)
    }
    return { engine: 'browser', printer: browser, bytes: written.byteLength }
  } finally {
    await rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  }
}
