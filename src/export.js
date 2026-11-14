/**
 * Export orchestration.
 *
 * Two callers reach the same placement rule and the same failure vocabulary.
 * The DSH path is two steps: {@link prepareExport} renders the page, starts the
 * one-shot loopback server, and creates a print job; {@link finishExport}
 * receives the PDF bytes from the DSH client, validates them, stages them beside
 * the target, renames the file into place, and commits the job. The browser
 * fallback ({@link exportMarkdownToPdf}) renders, prints with a Chromium-family
 * browser, validates, and renames through the same helper, so no path can leave
 * a half PDF over a complete one.
 *
 * Write order is deliberate: validate the payload, write the staging file,
 * fsync it, rename it over the target, then commit the job. A finished job
 * therefore always points at a file that is already in place. A failure before
 * the rename leaves the old PDF untouched.
 */
import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, mkdtemp, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'

import { mergeDocumentConfig } from './document-config.js'
import { DEFAULT_PAGE } from './document.js'
import { baseHrefOf, renderDocument } from './html-build.js'
import { parseFrontmatter, splitFrontmatter } from './markdown.js'
import { pageMarginsInches, pageOverrideCss } from './page-css.js'
import { describeEngines, PdfError, printBrowser, verifyPdf } from './pdf.js'
import { createPrintJobs } from './print-jobs.js'
import { listPresets, presetCssPath, readPreset } from './presets.js'
import { startPrintServer } from './print-server.js'

export { verifyPdf } from './pdf.js'

/** File extensions this plugin treats as markdown. */
export const MARKDOWN_EXTENSIONS = Object.freeze(['.md', '.markdown', '.mdown', '.mkd', '.mdwn', '.mdx'])

/** One export per target; a second request for the same file joins the first. */
const inFlight = new Map()

/** The process-wide job store; tests and tools may pass their own. */
const defaultJobs = createPrintJobs()

/** Live loopback servers, keyed by job id, with the timer that closes them. */
const printServers = new Map()

/** Render details kept until a job ends, so finish can report them. */
const renderDetails = new Map()

/** Per-job finish chains, so two retries cannot write the staging file at once. */
const finishChains = new Map()

/** How long a locked target is retried before the export reports `file-busy`. */
const LOCK_RETRY_DELAYS_MS = Object.freeze([100, 300, 900])

/** Error codes that mean "another process holds the target". */
const LOCK_ERRORS = new Set(['EPERM', 'EBUSY', 'EACCES', 'EEXIST'])

/** Staging ids are hex job ids; anything else would escape the directory. */
const STAGING_ID = /^[a-z0-9-]{1,64}$/

/**
 * @param {string} path - a source path.
 * @returns whether the name carries a markdown extension.
 */
export function isMarkdownPath(path) {
  return MARKDOWN_EXTENSIONS.includes(extname(String(path)).toLowerCase())
}

/**
 * Resolve the request's path against its stated working directory.
 * @param path - absolute path, or one relative to `cwd`.
 * @param cwd - absolute directory used for a relative path.
 * @returns the absolute source path.
 * @throws {PdfError} when the request has no usable path.
 */
function absoluteSource(path, cwd) {
  if (typeof path !== 'string' || path === '') {
    throw new PdfError('bad-request', 'path is required')
  }
  if (isAbsolute(path)) return resolve(path)
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
    throw new PdfError('bad-request', `relative path needs an absolute working directory: ${path}`)
  }
  return resolve(cwd, path)
}

/**
 * Compute the only PDF target this plugin may write for one source.
 * @param sourcePath - absolute markdown path.
 * @returns the absolute target beside the source.
 */
function targetOf(sourcePath) {
  const directory = dirname(sourcePath)
  const name = basename(sourcePath)
  const stem = name.slice(0, name.length - extname(name).length)
  return join(directory, `${stem}.pdf`)
}

/**
 * Coerce one page option, keeping the stylesheet inside values Chromium accepts.
 *
 * This is the browser fallback's one-off page shape. The DSH path uses the
 * partial `PageOverride` model instead, so an unset field never rewrites the
 * preset's `@page` box.
 * @param page - caller-supplied overrides.
 * @returns the effective page geometry.
 */
function normalizePage(page) {
  const source = page ?? {}
  const size = typeof source.size === 'string' && /^[A-Za-z0-9]+$/.test(source.size)
    ? source.size
    : DEFAULT_PAGE.size
  const margin = Number(source.marginMm)
  const fontSize = Number(source.fontSize)
  return {
    size,
    marginMm: Number.isFinite(margin) ? Math.min(Math.max(margin, 0), 60) : DEFAULT_PAGE.marginMm,
    fontSize: Number.isFinite(fontSize) ? Math.min(Math.max(fontSize, 8), 24) : DEFAULT_PAGE.fontSize,
    landscape: source.landscape === true,
  }
}

/**
 * Encode one path segment for a DSH resource address.
 * @param segment - one slash-free path segment.
 * @returns the segment with `:` kept literal for Windows drive letters.
 */
function encodeResourceSegment(segment) {
  return encodeURIComponent(segment).replace(/%3A/gi, ':')
}

/**
 * Build the DSH resource address of one file in one Session.
 *
 * The address is what `ctx.sidebarRight.openResource()` accepts. The path keeps
 * its leading slash and every segment is encoded; a drive colon stays literal
 * so the viewer receives an ordinary absolute path.
 * @param sessionId - the Session that owns the file.
 * @param path - absolute file path, in native separators.
 * @returns the resource address.
 */
export function sessionFileAddress(sessionId, path) {
  const normalized = String(path).replace(/\\/g, '/')
  const encodedPath = normalized.split('/').map(encodeResourceSegment).join('/')
  // The grammar is `<session>/<path>`. The path keeps its own leading slash, so
  // a POSIX address shows two separators after the id and Windows one before
  // the drive path; neither form is trimmed.
  return `dsh-resource://file/session/${encodeURIComponent(String(sessionId))}/${encodedPath}`
}

/**
 * Build the staging path for one job.
 * @param target - absolute PDF target.
 * @param jobId - print job id, or a generated staging id for the browser path.
 * @returns the absolute staging path in the target directory.
 */
function stagingFile(target, jobId) {
  const id = typeof jobId === 'string' && STAGING_ID.test(jobId) ? jobId : randomBytes(8).toString('hex')
  return join(dirname(target), `.md2pdf-${id}.pdf.tmp`)
}

/**
 * Refuse a target that must not be replaced.
 * @param target - absolute PDF target.
 * @throws {PdfError} when the target is a symbolic link or a directory.
 */
async function assertReplaceable(target) {
  const info = await lstat(target).catch(() => null)
  if (info === null) return
  if (info.isSymbolicLink()) {
    throw new PdfError('bad-request', `refusing to replace a symbolic link: ${target}`)
  }
  if (!info.isFile()) {
    throw new PdfError('file-busy', `the PDF target is not a regular file: ${target}`)
  }
}

/**
 * Write bytes to a fixed staging path and flush them to disk.
 * @param staging - absolute staging path.
 * @param bytes - complete PDF bytes.
 * @throws when the file cannot be created or written.
 */
async function writeStaged(staging, bytes) {
  let handle
  try {
    handle = await open(staging, 'wx', 0o600)
  } catch (error) {
    // A staging file can survive a crash. Its name belongs to this one job, so
    // removing it before the exclusive retry cannot discard another job's work.
    if (error?.code !== 'EEXIST') throw error
    await rm(staging, { force: true })
    handle = await open(staging, 'wx', 0o600)
  }
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * Rename a complete staging file over its target.
 *
 * A viewer on Windows can hold the old PDF open. The rename is retried three
 * times at 100/300/900 ms, then refused as `file-busy`; the old file stays.
 * @param staging - absolute staging path.
 * @param target - absolute PDF target.
 * @param renameFile - rename implementation; tests may replace it.
 * @throws {PdfError} `file-busy` when the target stays locked.
 */
async function commitStaged(staging, target, renameFile = rename) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await renameFile(staging, target)
      return
    } catch (error) {
      if (!LOCK_ERRORS.has(error?.code)) throw error
      if (attempt >= LOCK_RETRY_DELAYS_MS.length) {
        throw new PdfError('file-busy', `the PDF target is locked: ${target}`)
      }
      await new Promise((resolveDelay) => { setTimeout(resolveDelay, LOCK_RETRY_DELAYS_MS[attempt]) })
    }
  }
}

/**
 * Write one complete PDF beside its source, atomically.
 *
 * The bytes go to `.md2pdf-<jobId>.pdf.tmp` in the target directory, are
 * fsynced, and are renamed over the target. The staging file is removed on
 * every path, including failure. A symbolic-link target is refused, so a
 * rename can never follow a link out of the source directory.
 * @param target - absolute PDF target.
 * @param pdfBytes - complete PDF bytes.
 * @param options - staging id, and an injectable rename for tests.
 * @returns a promise that resolves when the target holds the new bytes.
 * @throws {PdfError} for a bad path, a symlink target, or a locked file.
 */
export async function atomicWritePdf(target, pdfBytes, options = {}) {
  if (typeof target !== 'string' || !isAbsolute(target)) {
    throw new PdfError('bad-request', 'the PDF target must be an absolute path')
  }
  const bytes = Buffer.isBuffer(pdfBytes)
    ? pdfBytes
    : pdfBytes instanceof Uint8Array ? Buffer.from(pdfBytes) : null
  if (bytes === null) throw new PdfError('pdf-invalid', 'the PDF payload must be bytes')
  await assertReplaceable(target)
  const staging = stagingFile(target, options.jobId)
  try {
    await writeStaged(staging, bytes)
    await commitStaged(staging, target, options.rename)
  } finally {
    await rm(staging, { force: true }).catch(() => {})
  }
}

/**
 * Close one job's print server and stop its deadline timer.
 * @param jobId - job id.
 */
async function closePrintServer(jobId) {
  const entry = printServers.get(jobId)
  if (entry === undefined) return
  printServers.delete(jobId)
  clearTimeout(entry.timer)
  renderDetails.delete(jobId)
  await entry.close().catch(() => {})
}

/**
 * Refuse every open job past its deadline and close its server.
 * @param jobId - the job whose timer fired.
 */
function expirePrintServer(jobId) {
  const entry = printServers.get(jobId)
  if (entry === undefined) return
  printServers.delete(jobId)
  clearTimeout(entry.timer)
  renderDetails.delete(jobId)
  try {
    // This timer belongs to one job. Expiring at its own deadline keeps the
    // state exact even when the platform fires a timer a millisecond early.
    entry.jobs.expire(entry.deadline + 1)
  } catch {
    // The store owns no timers; an expiry sweep must never keep the server up.
  }
  entry.close().catch(() => {})
}

/**
 * Report whether a file can be read now.
 * @param path - absolute path.
 * @returns true when the file is readable.
 */
async function isReadable(path) {
  try {
    await access(path, constants.R_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Map a thrown failure onto this module's vocabulary.
 * @param error - anything thrown by the job store or the filesystem.
 * @returns a `PdfError` for a PrintJobError, the original otherwise.
 */
function exportFailure(error) {
  if (error instanceof PdfError) return error
  if (error !== null && typeof error === 'object'
    && error.name === 'PrintJobError' && typeof error.code === 'string') {
    return new PdfError(error.code, error instanceof Error ? error.message : String(error))
  }
  return error
}

/**
 * Run one finish attempt after every earlier attempt for the same job.
 * @param jobId - job id.
 * @param work - the attempt to run.
 * @returns the attempt's result.
 */
function serializeFinish(jobId, work) {
  const previous = finishChains.get(jobId) ?? Promise.resolve()
  const next = previous.then(work, work)
  finishChains.set(jobId, next)
  const clear = () => {
    if (finishChains.get(jobId) === next) finishChains.delete(jobId)
  }
  next.then(clear, clear)
  return next
}

/**
 * Commit one PDF payload for an open job.
 * @param job - the print job.
 * @param finishToken - the job's finish secret.
 * @param pdfBytes - bytes returned by the DSH client.
 * @param jobs - the job store that owns the job.
 * @returns the committed result.
 */
async function commitFinish(job, finishToken, pdfBytes, jobs) {
  // A job the store already ended is answered by the store, so the refusal
  // codes and the idempotent retry stay exactly Task 2's contract.
  if (job.state !== 'prepared' && job.state !== 'claimed' && job.state !== 'printing') {
    return jobs.finish(finishToken, pdfBytes)
  }

  const verified = verifyPdf(pdfBytes)
  if (!verified.ok) {
    // The store marks the job failed before it throws; that is the single place
    // where the failed state and the code are decided.
    jobs.finish(finishToken, pdfBytes)
    throw new PdfError(verified.code, 'the payload is not a complete PDF')
  }

  try {
    await atomicWritePdf(job.targetPath, pdfBytes, { jobId: job.id })
  } catch (error) {
    const reason = error instanceof PdfError ? error.code : 'write-failed'
    try {
      jobs.fail(job.id, reason)
    } catch {
      // Keep the write error; the job state is already unusable either way.
    }
    throw error
  }

  const committed = jobs.finish(finishToken, pdfBytes)
  const details = renderDetails.get(job.id) ?? { generator: 'builtin', math: false, theme: undefined, warnings: [] }
  committed.ok = true
  committed.sourcePath = job.sourcePath
  committed.pdfPath = job.targetPath
  committed.engine = 'dsh'
  committed.generator = details.generator
  committed.math = details.math
  committed.theme = details.theme
  committed.warnings = [...details.warnings]
  committed.durationMs = Date.now() - job.createdAt
  if (typeof job.sessionId === 'string' && job.sessionId !== '' && await isReadable(job.targetPath)) {
    committed.previewAddress = sessionFileAddress(job.sessionId, job.targetPath)
  }
  return committed
}

/**
 * Render one markdown document, start its loopback server, and create a job.
 *
 * The page merges, lowest to highest, preset page metadata (empty until the page
 * settings task), the file's flat `pdf.*` front matter, and this request's
 * explicit override. The preset is chosen by request, then `pdf.preset`, then
 * the selected preset. `mergeDocumentConfig` parses the front matter and returns
 * the unknown-key warnings this transport reports.
 * @param request - `{ path, cwd?, sessionId?, preset?, page?, documentConfig?, owner? }`.
 * @param options - process-level renderer, pandoc, and an injectable job store.
 * @returns the job id, the printable URL, the finish token, print options, and warnings.
 * @throws {PdfError} for a refused source, page, or preset, or a failed server.
 */
export async function prepareExport(request = {}, options = {}) {
  const sourcePath = absoluteSource(request?.path, request?.cwd)
  if (!isMarkdownPath(sourcePath)) {
    throw new PdfError('not-markdown', `not a markdown file: ${sourcePath}`)
  }
  const info = await stat(sourcePath).catch(() => null)
  if (info === null) throw new PdfError('not-found', `file not found: ${sourcePath}`)
  if (!info.isFile()) throw new PdfError('not-a-file', `not a regular file: ${sourcePath}`)

  const markdown = await readFile(sourcePath, 'utf8')
  if (markdown.includes('\u0000')) {
    throw new PdfError('not-text', `file is not plain text: ${sourcePath}`)
  }

  const directory = dirname(sourcePath)
  const targetPath = targetOf(sourcePath)
  if (targetPath === sourcePath) throw new PdfError('bad-request', 'the PDF target would replace the source file')
  const name = basename(sourcePath)
  const stem = name.slice(0, name.length - extname(name).length)
  const jobs = options.jobs ?? defaultJobs

  const { frontmatter } = splitFrontmatter(markdown)
  const fields = parseFrontmatter(frontmatter)
  // Preset metadata arrives with the page settings task, so the lowest page
  // layer is empty here; the merge still exercises the full precedence chain.
  const merged = mergeDocumentConfig({
    presetPage: {},
    frontmatter: fields,
    request: { page: request?.page, documentConfig: request?.documentConfig },
  })
  const page = merged.page
  const warnings = merged.warnings

  const { selected } = await listPresets()
  const requestedPreset = typeof request?.preset === 'string' && request.preset !== '' ? request.preset : null
  const declaredPreset = typeof fields['pdf.preset'] === 'string' && fields['pdf.preset'] !== ''
    ? fields['pdf.preset']
    : null
  const presetId = requestedPreset ?? declaredPreset ?? selected
  const preset = await readPreset(presetId)

  const rendered = await renderDocument({
    markdown,
    title: stem,
    page,
    theme: preset.id,
    themeCss: preset.css,
    pageCss: pageOverrideCss(page),
    renderer: request?.renderer ?? options.renderer,
  }, { pandocPath: options.pandocPath })

  const printOptions = {
    printBackground: true,
    preferCSSPageSize: true,
    margins: pageMarginsInches(rendered.html),
    displayHeaderFooter: false,
    generateDocumentOutline: false,
    pageRanges: '',
    ...(page.landscape === undefined ? {} : { landscape: page.landscape }),
  }
  const job = jobs.create({
    sessionId: typeof request?.sessionId === 'string' && request.sessionId !== '' ? request.sessionId : undefined,
    sourcePath,
    targetPath,
    html: rendered.html,
    assetRoot: directory,
    printOptions,
    owner: request?.owner,
  })

  let server
  try {
    server = await startPrintServer({
      html: rendered.html,
      assetRoot: directory,
      assetToken: job.assetToken,
    })
  } catch (error) {
    try {
      jobs.fail(job.id, 'asset-server-failed')
    } catch {
      // The job is unusable either way; report the server failure.
    }
    const message = error instanceof Error ? error.message : String(error)
    throw new PdfError('asset-server-failed', `could not start the print server: ${message}`)
  }

  const delay = Math.max(0, job.deadline - Date.now())
  const timer = setTimeout(() => { expirePrintServer(job.id) }, delay)
  if (typeof timer.unref === 'function') timer.unref()
  printServers.set(job.id, { jobs, close: server.close, timer, deadline: job.deadline })
  renderDetails.set(job.id, {
    generator: rendered.generator,
    math: rendered.math,
    theme: rendered.theme,
    warnings,
  })

  return {
    jobId: job.id,
    printUrl: `${server.url}document.html`,
    finishToken: job.finishToken,
    printOptions,
    warnings,
  }
}

/**
 * Validate and commit the PDF bytes a DSH client printed.
 *
 * The order is validate bytes, write staging, rename, commit job. A retry with
 * the same token and bytes returns the committed result without writing again;
 * different bytes after a commit are refused with `finish-conflict`. The print
 * server closes on success, on refusal, and on an expired job.
 * @param input - `{ finishToken, pdfBytes }`.
 * @param options - an injectable job store.
 * @returns the export result, including the viewer address when one is usable.
 * @throws {PdfError} for an unknown token, an invalid payload, a locked or
 *   symlinked target, a conflict, or an expired job.
 */
export async function finishExport({ finishToken, pdfBytes } = {}, options = {}) {
  const jobs = options.jobs ?? defaultJobs
  const job = jobs.get(finishToken)
  if (job === null) throw new PdfError('bad-request', 'unknown finish token')
  // `get` also matches the asset token and the job id. Only the finish secret
  // may commit, and this refusal precedes validation, any write, and server
  // shutdown, so a caller holding another job identifier has no side effect.
  if (job.finishToken !== finishToken) {
    throw new PdfError('bad-request', 'invalid finish token')
  }
  // The client returned its bytes before the deadline; stop the expiry timer so
  // a slow disk write cannot expire the job halfway through the commit. The
  // server itself stays up until the attempt ends, then closes in the finally.
  const entry = printServers.get(job.id)
  if (entry !== undefined) clearTimeout(entry.timer)
  try {
    return await serializeFinish(job.id, () => commitFinish(job, finishToken, pdfBytes, jobs))
  } catch (error) {
    throw exportFailure(error)
  } finally {
    await closePrintServer(job.id)
  }
}

/**
 * Export one markdown file to a PDF in the same directory through a browser.
 *
 * This is the fallback used by the Web GUI, the agent tool while no DSH client
 * is present, and any install without the DSH printer. The browser writes to a
 * staging file; the bytes are validated and renamed into place, so a failed
 * printer never replaces a complete old PDF.
 * @param request - `{ path, cwd?, page?, browserPath? }`.
 * @param options - process-level defaults merged under the request.
 * @returns the produced file, its printer, and the timings.
 * @throws {PdfError} for every refusal the caller can act on.
 */
export async function exportMarkdownToPdf(request, options = {}) {
  const sourcePath = absoluteSource(request?.path, request?.cwd)
  if (!isMarkdownPath(sourcePath)) {
    throw new PdfError('not-markdown', `not a markdown file: ${sourcePath}`)
  }
  const info = await stat(sourcePath).catch(() => null)
  if (info === null) throw new PdfError('not-found', `file not found: ${sourcePath}`)
  if (!info.isFile()) throw new PdfError('not-a-file', `not a regular file: ${sourcePath}`)

  const directory = dirname(sourcePath)
  const name = basename(sourcePath)
  const stem = name.slice(0, name.length - extname(name).length)
  const target = targetOf(sourcePath)
  if (target === sourcePath) throw new PdfError('bad-request', 'the PDF target would replace the source file')

  const previous = inFlight.get(target)
  if (previous !== undefined) return previous

  const started = Date.now()
  const task = (async () => {
    const markdown = await readFile(sourcePath, 'utf8')
    if (markdown.includes('\u0000')) {
      throw new PdfError('not-text', `file is not plain text: ${sourcePath}`)
    }
    const page = normalizePage(request?.page ?? options.page)
    const browserPath = request?.browserPath ?? options.browserPath
    const { selected } = await listPresets()
    const preset = await readPreset(selected)

    const rendered = await renderDocument({
      markdown,
      title: stem,
      baseHref: baseHrefOf(directory),
      page,
      theme: selected,
      themeCss: preset.css,
      renderer: request?.renderer ?? options.renderer,
    }, { pandocPath: options.pandocPath })

    await assertReplaceable(target)
    const staging = stagingFile(target, randomBytes(8).toString('hex'))
    const work = await mkdtemp(join(tmpdir(), 'dsh-md2pdf-browser-'))
    const htmlPath = join(work, 'document.html')
    try {
      await writeFile(htmlPath, rendered.html, 'utf8')
      const printed = await printBrowser(htmlPath, staging, {
        browserPath,
        timeoutMs: options.timeoutMs,
      })
      const bytes = await readFile(staging)
      const verified = verifyPdf(bytes)
      if (!verified.ok) {
        throw new PdfError(verified.code, `the browser left an unusable PDF at ${staging}`)
      }
      await commitStaged(staging, target)
      const written = await stat(target).catch(() => null)
      if (written === null || written.size === 0) {
        throw new PdfError('empty-output', `printer left no bytes at ${target}`)
      }
      return {
        ok: true,
        pdfPath: target,
        sourcePath,
        bytes: written.size,
        generator: rendered.generator,
        math: rendered.math,
        theme: rendered.theme,
        engine: 'browser',
        printer: printed.printer,
        durationMs: Date.now() - started,
      }
    } finally {
      await rm(staging, { force: true }).catch(() => {})
      await rm(work, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
    }
  })()

  inFlight.set(target, task)
  try {
    return await task
  } finally {
    inFlight.delete(target)
  }
}

/**
 * Report what this Host can print with, once, for a capability check.
 *
 * The Host knows its browser path and the configured print engine. The DSH
 * printer lives in the client, so `dsh` is reported as unknown, never guessed.
 * @param options - print engine preference and explicit paths.
 * @returns the browser path, the configured engine, and the render settings.
 */
export async function describeCapability(options = {}) {
  const [engines, library] = await Promise.all([describeEngines(options), listPresets()])
  const selected = library.selected
  const configured = typeof options.printEngine === 'string' && options.printEngine !== ''
    ? options.printEngine
    : 'auto'
  return {
    engine: engines.chosen,
    available: engines.available,
    browser: engines.available.browser,
    printEngine: configured,
    dsh: 'unknown',
    renderer: options.renderer ?? 'builtin',
    theme: selected,
    page: DEFAULT_PAGE,
    extensions: MARKDOWN_EXTENSIONS,
    cssPath: presetCssPath(selected),
  }
}
