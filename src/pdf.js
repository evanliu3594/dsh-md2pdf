/**
 * Paper output engines.
 *
 * Two printers exist because the two hosts differ. A Chromium-family browser
 * prints a `file:` document from its own process, which works from any Node
 * host; inside the Desktop shell the running Electron binary prints the same
 * document without starting a second browser. Both honour the stylesheet's
 * `@page` box, so the page geometry a caller asks for is the geometry it gets.
 *
 * Every engine writes the target file and then verifies the leading `%PDF-`
 * bytes, so a printer that exits zero without producing paper still fails.
 */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
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

/** Whether the running process is an Electron main process with printing. */
async function electronPrinter() {
  if (process.versions.electron === undefined) return null
  try {
    const electron = await import('electron')
    const browserWindow = electron.BrowserWindow
    if (typeof browserWindow !== 'function') return null
    return browserWindow
  } catch {
    return null
  }
}

/**
 * Describe which engines this host can use without printing anything.
 * @param options - engine preference and explicit paths.
 * @returns the chosen engine, the alternatives, and the resolved executables.
 */
export async function describeEngines(options = {}) {
  const request = options.engine ?? 'auto'
  const [browser, electron] = await Promise.all([findBrowser(options), electronPrinter()])
  const available = {
    browser: browser === null ? null : browser,
    electron: electron === null ? null : 'electron',
  }
  const ordered = request === 'auto' ? ['electron', 'browser'] : [request]
  const chosen = ordered.find(candidate => available[candidate] !== null) ?? null
  return { request, chosen, available }
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
 * @param htmlPath - the `file:` document to print.
 * @param outPath - absolute PDF target.
 * @param options - engine preference, explicit paths, and deadlines.
 * @returns the chosen executable and produced byte count.
 */
async function printWithBrowser(htmlPath, outPath, options) {
  const browser = await findBrowser(options)
  if (browser === null) throw new PdfError('no-printer', 'no Chromium-family browser found')
  const before = await snapshotOf(outPath)
  const profile = await mkdtemp(join(tmpdir(), 'dsh-md2pdf-profile-'))
  let result
  try {
    result = await run(browser, [
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
    return { engine: 'browser', printer: browser, bytes }
  } finally {
    await rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  }
}

/**
 * Print one HTML file inside the running Electron process.
 * @param htmlPath - the `file:` document to print.
 * @param outPath - absolute PDF target.
 * @param page - page geometry.
 * @returns the engine name and produced byte count.
 */
async function printWithElectron(htmlPath, outPath, page) {
  const BrowserWindow = await electronPrinter()
  if (BrowserWindow === null) throw new PdfError('no-printer', 'this process cannot print with Electron')
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 1600,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true },
  })
  try {
    await window.loadURL(pathToFileURL(htmlPath).href)
    // Give layout, fonts, and file images one compositor frame to settle.
    await new Promise((resolve) => { setTimeout(resolve, 350) })
    const marginInches = page.marginMm / 25.4
    const data = await window.webContents.printToPDF({
      printBackground: true,
      landscape: page.landscape,
      pageSize: page.size,
      margins: { top: marginInches, bottom: marginInches, left: marginInches, right: marginInches },
      displayHeaderFooter: false,
      preferCSSPageSize: false,
    })
    if (data.byteLength < 5 || data.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new PdfError('not-a-pdf', 'Electron returned no PDF bytes')
    }
    await writeFile(outPath, data)
    return { engine: 'electron', printer: 'electron', bytes: data.byteLength }
  } finally {
    window.destroy()
  }
}

/**
 * Print a printable document to a PDF file.
 * @param html - the complete HTML document.
 * @param outPath - absolute PDF target; an existing file is replaced.
 * @param input - page geometry and engine preferences.
 * @returns the engine, printer, and produced byte count.
 */
export async function printPdf(html, outPath, input) {
  const page = input.page
  const options = {
    engine: input.engine ?? 'auto',
    browserPath: input.browserPath,
    timeoutMs: input.timeoutMs,
  }
  const work = await mkdtemp(join(tmpdir(), 'dsh-md2pdf-'))
  const htmlPath = join(work, 'document.html')
  try {
    await writeFile(htmlPath, html, 'utf8')
    if (options.engine === 'browser') return await printWithBrowser(htmlPath, outPath, options)
    if (options.engine === 'electron') return await printWithElectron(htmlPath, outPath, page)

    // The Desktop shell prints from its own process: no second browser starts,
    // and the page never leaves the application. A plain Node host falls back
    // to a Chromium-family browser.
    if (await electronPrinter() !== null) return await printWithElectron(htmlPath, outPath, page)
    const browser = await findBrowser(options)
    if (browser !== null) return await printWithBrowser(htmlPath, outPath, options)
    throw new PdfError(
      'no-printer',
      'no PDF printer found: install Microsoft Edge or Google Chrome, or run inside the Desktop application',
    )
  } finally {
    await rm(work, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  }
}
