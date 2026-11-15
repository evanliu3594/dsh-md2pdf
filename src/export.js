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

import { scanAssets } from './asset-scan.js'
import { documentDefaults, mergeDocumentConfig } from './document-config.js'
import { DEFAULT_PAGE } from './document.js'
import { baseHrefOf, renderDocument } from './html-build.js'
import { parseFrontmatter, splitFrontmatter } from './markdown.js'
import { openPath } from './opener.js'
import { pageMarginsInches, pageOverrideCss } from './page-css.js'
import { describeEngines, PdfError, printBrowser, verifyPdf } from './pdf.js'
import { buildPrintOptions } from './print-options.js'
import { CLIENT_FAILURE_REASONS, createPrintJobs } from './print-jobs.js'
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

/** How often the tool watches a brokered job before checking again. */
const TOOL_WATCH_MS = 100

/** How long a cancelled tool waits for a finish write it already started. */
const FINISH_SETTLE_MS = 30_000

/**
 * How long an agent tool waits for a connected client before choosing an
 * engine. This is a client-presence check, not a queue-idle check.
 */
export const TOOL_PRESENCE_WAIT_MS = 10_000

/** How often the tool rechecks presence during that wait. */
const TOOL_PRESENCE_POLL_MS = 100

/**
 * Failure reasons a tool may retry through the browser in `auto` mode.
 *
 * Every reason here means no file was written. `file-busy` and `pdf-invalid`
 * are absent because the target may already hold a committed result.
 */
const TOOL_FALLBACK_REASONS = new Set([
  'client-required',
  'no-printer',
  'print-failed',
  'asset-server-failed',
])

/**
 * Resolve the print-job store one operation should use.
 * @param options - row configuration, possibly carrying a test store.
 * @returns the injected store, or this process's shared store.
 */
export function resolvePrintJobs(options = {}) {
  return options.jobs ?? defaultJobs
}

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
 * Validate one export source before any printer or engine is chosen.
 *
 * A bad path is the caller's own mistake, so it must be reported before the
 * tool waits for a client or reports a printer problem. The same three
 * refusals are shared by both export paths and the agent tool.
 * @param request - a request carrying `path` and an optional `cwd`.
 * @returns the absolute source path.
 * @throws {PdfError} for a missing path, a non-markdown name, a missing file, or
 *   a non-file.
 */
async function inspectSource(request) {
  const sourcePath = absoluteSource(request?.path, request?.cwd)
  if (!isMarkdownPath(sourcePath)) {
    throw new PdfError('not-markdown', `not a markdown file: ${sourcePath}`)
  }
  const info = await stat(sourcePath).catch(() => null)
  if (info === null) throw new PdfError('not-found', `file not found: ${sourcePath}`)
  if (!info.isFile()) throw new PdfError('not-a-file', `not a regular file: ${sourcePath}`)
  return sourcePath
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
 * Resolve the preset and the effective page for one markdown document.
 *
 * This is the one page-precedence rule both export paths use. The preset is
 * chosen by the request, then the file's `pdf.preset`, then the selected
 * preset. The page merges, lowest to highest, the chosen preset's saved page
 * metadata, the file's flat `pdf.page.*` front matter, and the request's
 * explicit override. Only fields a layer sets participate, so a font-size-only
 * override leaves the preset's own `@page` box in charge.
 * @param markdown - the complete source text.
 * @param request - `{ preset?, page?, documentConfig? }`.
 * @param fallbackPage - process-level page used only when the request sets none.
 * @param documentDefaults - row configuration for page numbers and the outline.
 * @returns the preset, the effective partial page, the document config, the
 *   front matter fields, and the front matter warnings.
 * @throws {PdfError} for an unknown preset, an invalid page, or invalid front
 *   matter.
 */
async function resolveDocumentSetup(markdown, request, fallbackPage, documentDefaults) {
  const { frontmatter } = splitFrontmatter(markdown)
  const fields = parseFrontmatter(frontmatter)

  const { selected } = await listPresets()
  const requestedPreset = typeof request?.preset === 'string' && request.preset !== '' ? request.preset : null
  const declaredPreset = typeof fields['pdf.preset'] === 'string' && fields['pdf.preset'] !== ''
    ? fields['pdf.preset']
    : null
  const presetId = requestedPreset ?? declaredPreset ?? selected
  const preset = await readPreset(presetId)

  const merged = mergeDocumentConfig({
    presetPage: preset.page ?? {},
    frontmatter: fields,
    defaults: documentDefaults,
    request: { page: request?.page ?? fallbackPage, documentConfig: request?.documentConfig },
  })
  return {
    preset,
    page: merged.page,
    document: merged.document,
    frontmatter: fields,
    warnings: merged.warnings,
  }
}

/**
 * Read the row configuration that seeds the document config.
 *
 * Page numbers default off and the outline default on; both are row settings
 * that front matter and a one-off request may override.
 * @param options - row configuration.
 * @returns the document defaults, with only the fields the row sets.
 */
function documentDefaultsOf(options = {}) {
  return documentDefaults(options).defaults
}

/**
 * Read one front matter field as template text.
 * @param fields - flat front matter fields.
 * @param key - field name.
 * @returns the trimmed text, or an empty string.
 */
function frontmatterText(fields, key) {
  const value = fields[key]
  return typeof value === 'string' ? value.trim() : ''
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
 * Run the configured post-export action on a committed result.
 *
 * Only a UI job reaches this: the agent tool's jobs never open anything. The
 * first successful finish records the attempt on the result, so a replay of the
 * same token does not open the PDF twice. An opener failure is recorded on the
 * result and never changes the committed outcome; the PDF is already in place.
 * @param job - the print job behind the result.
 * @param committed - the result the store committed.
 * @param options - row configuration plus the injectable opener.
 * @returns the same result, with an `open` record when the system action ran.
 */
async function applyAfterExport(job, committed, options) {
  if (afterExportMode(options.afterExport) !== 'system') return committed
  if (job.owner !== 'ui') return committed
  // The store keeps one result object per finished job; a replay returns that
  // same object. The marker makes the open attempt happen exactly once.
  if (Object.hasOwn(committed, 'open')) return committed
  const open = typeof options.open === 'function' ? options.open : openPath
  try {
    await open(job.targetPath)
    committed.open = { mode: 'system', ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    committed.open = { mode: 'system', ok: false, code: 'open-failed', message }
  }
  return committed
}

/**
 * Commit one PDF payload for an open job.
 * @param job - the print job.
 * @param finishToken - the job's finish secret.
 * @param pdfBytes - bytes returned by the DSH client.
 * @param jobs - the job store that owns the job.
 * @param options - row configuration and the injectable opener.
 * @returns the committed result.
 */
async function commitFinish(job, finishToken, pdfBytes, jobs, options) {
  // A job the store already ended is answered by the store, so the refusal
  // codes and the idempotent retry stay exactly Task 2's contract.
  if (job.state !== 'prepared' && job.state !== 'claimed' && job.state !== 'printing') {
    return applyAfterExport(job, jobs.finish(finishToken, pdfBytes), options)
  }
  // Take the write lease before the first await. The broker poll sweeps expiry
  // every 100 ms, so without it a slow rename could land after the job expired
  // and leave a written PDF behind a timeout result.
  jobs.beginFinish(finishToken)

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
      jobs.abandonFinish(job.id, reason)
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
  return applyAfterExport(job, committed, options)
}

/**
 * Render one markdown document, start its loopback server, and create a job.
 *
 * The page merges, lowest to highest, the preset's saved page metadata, the
 * file's flat `pdf.*` front matter, and this request's explicit override. The
 * preset is chosen by request, then `pdf.preset`, then the selected preset.
 * `mergeDocumentConfig` parses the front matter and returns the unknown-key
 * warnings; {@link scanAssets} adds the asset references the print cannot
 * resolve. Neither kind blocks the export.
 * @param request - `{ path, cwd?, sessionId?, preset?, page?, documentConfig?, owner? }`.
 * @param options - process-level renderer, pandoc, and an injectable job store.
 * @returns the job id, the printable URL, the finish token, print options, and warnings.
 * @throws {PdfError} for a refused source, page, or preset, or a failed server.
 */
export async function prepareExport(request = {}, options = {}) {
  const sourcePath = await inspectSource(request)
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

  // The preset and page precedence are shared with the browser fallback:
  // request preset > `pdf.preset` > selected, and preset page < front matter
  // page < request page. Only explicit page fields participate.
  const { preset, page, document, frontmatter, warnings: mergeWarnings } = await resolveDocumentSetup(
    markdown,
    request,
    undefined,
    documentDefaultsOf(options),
  )

  const rendered = await renderDocument({
    markdown,
    title: stem,
    page,
    theme: preset.id,
    themeCss: preset.css,
    pageCss: pageOverrideCss(page),
    toc: document.toc,
    paper: document.paper,
    lang: frontmatterText(frontmatter, 'lang') || options.lang,
    renderer: request?.renderer ?? options.renderer,
  }, { pandocPath: options.pandocPath })

  // The paper fields belong to the built-in paper template; using a non-empty
  // field with another preset would silently drop it, so it is reported. An
  // empty value is not a field, and the parser already warns on unknown keys.
  const paperFields = Object.values(document.paper)
    .filter(value => typeof value === 'string' && value.trim() !== '')
  const paperWarnings = paperFields.length > 0 && preset.id !== 'paper'
    ? ['pdf.paper.* needs the paper preset']
    : []
  // Unknown `pdf.*` keys, invalid row booleans, and unresolvable asset
  // references are warnings: the PDF still prints, and the client reports what
  // was skipped.
  const configWarnings = Array.isArray(options.configWarnings)
    ? options.configWarnings.filter(warning => typeof warning === 'string')
    : []
  const warnings = [
    ...configWarnings,
    ...mergeWarnings,
    ...paperWarnings,
    ...await scanAssets(rendered.html, directory),
  ]

  // Header, footer, page numbers, and the outline come from the merged document
  // config; margins come from the final @page box, never from a fixed default.
  const printOptions = {
    ...buildPrintOptions(document, pageMarginsInches(rendered.html), {
      title: frontmatterText(frontmatter, 'title') || stem,
      author: frontmatterText(frontmatter, 'author'),
      date: frontmatterText(frontmatter, 'date'),
    }),
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
    const startServer = typeof options.startPrintServer === 'function'
      ? options.startPrintServer
      : startPrintServer
    server = await startServer({
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
  // The broker route serves these two fields without reading the exporter's
  // private maps: the printable URL of this job and the render warnings.
  job.printUrl = `${server.url}document.html`
  job.warnings = [...warnings]
  printServers.set(job.id, { jobs, close: server.close, timer, deadline: job.deadline })
  renderDetails.set(job.id, {
    generator: rendered.generator,
    math: rendered.math,
    theme: rendered.theme,
    warnings,
  })
  // Only now does the job have everything a client needs: a printable URL, a
  // live server entry, and the finish token. A broker claim before this point
  // would hand out a payload without a print URL and strand the job.
  jobs.markReady(job.id)

  return {
    jobId: job.id,
    printUrl: job.printUrl,
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
 * @param options - row configuration (`afterExport`), an injectable job store,
 *   and an injectable opener for the checks.
 * @returns the export result, including the viewer address when one is usable
 *   and the system-open record when `afterExport` is `system`.
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
    return await serializeFinish(job.id, () => commitFinish(job, finishToken, pdfBytes, jobs, options))
  } catch (error) {
    throw exportFailure(error)
  } finally {
    await closePrintServer(job.id)
  }
}

/**
 * Record a client-side failure for one open job and close its print server.
 *
 * The fail route is the client's other exit from a claimed job: when the guest
 * cannot print, the client reports the reason instead of returning bytes. Only
 * the exact finish token is accepted, so the asset token and the job id cannot
 * end someone else's job. The reason must come from the closed client list.
 * Nothing is written: a failed job leaves the old PDF and any staging file
 * untouched, and the one-shot print server is closed before this resolves.
 * @param input - `{ finishToken, reason }`.
 * @param options - an injectable job store, for the checks.
 * @returns `{ ok: true }` after the job has moved to `failed` and the server closed.
 * @throws {PdfError} for a missing or foreign token, a reason outside the
 *   allowlist, an expired job, or a job that already committed.
 */
export async function failPrintJob({ finishToken, reason } = {}, options = {}) {
  if (typeof finishToken !== 'string' || finishToken.trim() === '') {
    throw new PdfError('bad-request', 'finishToken is required')
  }
  if (!CLIENT_FAILURE_REASONS.includes(reason)) {
    throw new PdfError('bad-request', 'the failure reason is not allowed')
  }
  const token = finishToken.trim()
  const jobs = resolvePrintJobs(options)
  const job = jobs.get(token)
  if (job === null) throw new PdfError('bad-request', 'unknown finish token')
  // `get` also matches the asset token and the job id; only the finish secret
  // may end this job, and the refusal precedes the timer clear and the close.
  if (job.finishToken !== token) throw new PdfError('bad-request', 'invalid finish token')
  const entry = printServers.get(job.id)
  if (entry !== undefined) clearTimeout(entry.timer)
  try {
    // Fail shares the finish chain. A finish already writing runs first, so a
    // fail cannot mark the job failed while a rename is in flight; a fail that
    // runs first makes the later finish refuse before it writes anything.
    await serializeFinish(job.id, () => {
      jobs.fail(job.id, reason)
    })
  } catch (error) {
    throw exportFailure(error)
  } finally {
    await closePrintServer(job.id)
  }
  return { ok: true }
}

/**
 * Open the committed target of one finished print job with the system opener.
 *
 * The client sends only the finish token; the path comes from the Host's job
 * record, so a caller cannot choose which file opens. Only a finished UI job
 * may be opened: a failed, expired, or still-open job and a tool job are
 * refused before the opener runs. The open failure is a separate refusal: the
 * PDF is already committed, and this action does not change that.
 * @param input - `{ finishToken }`.
 * @param options - an injectable job store and opener, for the checks.
 * @returns `{ ok: true }` after the opener has been started.
 * @throws {PdfError} for a missing or foreign token, an uncommitted job, or a
 *   launcher that cannot start.
 */
export async function openFinishedExport({ finishToken } = {}, options = {}) {
  if (typeof finishToken !== 'string' || finishToken.trim() === '') {
    throw new PdfError('bad-request', 'finishToken is required')
  }
  const token = finishToken.trim()
  const jobs = options.jobs ?? defaultJobs
  const job = jobs.get(token)
  if (job === null) throw new PdfError('bad-request', 'unknown finish token')
  // `get` also matches the asset token and the job id; only the finish secret
  // may resolve the target. The refusal precedes the opener, so another token
  // never opens anything.
  if (job.finishToken !== token) throw new PdfError('bad-request', 'invalid finish token')
  if (job.state !== 'finished') {
    throw new PdfError('state-conflict', 'this print job has not committed a PDF')
  }
  // The agent tool's jobs never open anything; the system fallback belongs to
  // the UI export only.
  if (job.owner !== 'ui') {
    throw new PdfError('bad-request', 'only UI jobs may open the system fallback')
  }
  const open = typeof options.open === 'function' ? options.open : openPath
  try {
    await open(job.targetPath)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new PdfError('open-failed', message)
  }
  return { ok: true }
}

/**
 * Export one markdown file to a PDF in the same directory through a browser.
 *
 * This is the fallback used by the Web GUI, the agent tool while no DSH client
 * is present, and any install without the DSH printer. It applies the same
 * preset and page precedence as the DSH path: request preset > `pdf.preset` >
 * selected, and preset page < front matter page < request page. The browser
 * writes to a staging file; the bytes are validated and renamed into place, so
 * a failed printer never replaces a complete old PDF.
 * @param request - `{ path, cwd?, preset?, page?, browserPath?, renderer? }`.
 * @param options - process-level defaults merged under the request, plus an
 *   injectable `printBrowser` for the checks.
 * @returns the produced file, its printer, and the timings.
 * @throws {PdfError} for every refusal the caller can act on.
 */
export async function exportMarkdownToPdf(request, options = {}) {
  const sourcePath = await inspectSource(request)
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
    // The same rule the DSH path uses; the saved page settings, the file's
    // front matter, and the request override all reach the printed page.
    const { preset, page, document, frontmatter } = await resolveDocumentSetup(
      markdown, request, options.page, documentDefaultsOf(options),
    )
    const browserPath = request?.browserPath ?? options.browserPath
    const print = typeof options.printBrowser === 'function' ? options.printBrowser : printBrowser

    const rendered = await renderDocument({
      markdown,
      title: stem,
      baseHref: baseHrefOf(directory),
      page,
      theme: preset.id,
      themeCss: preset.css,
      pageCss: pageOverrideCss(page),
      toc: document.toc,
      paper: document.paper,
      lang: frontmatterText(frontmatter, 'lang') || options.lang,
      renderer: request?.renderer ?? options.renderer,
    }, { pandocPath: options.pandocPath })

    await assertReplaceable(target)
    const staging = stagingFile(target, randomBytes(8).toString('hex'))
    const work = await mkdtemp(join(tmpdir(), 'dsh-md2pdf-browser-'))
    const htmlPath = join(work, 'document.html')
    try {
      await writeFile(htmlPath, rendered.html, 'utf8')
      const printed = await print(htmlPath, staging, {
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
 * Choose the engine one agent tool call should use.
 *
 * This is the whole tool policy in one place. `browser` forces the Host's own
 * Chromium printer. `dsh` only uses a connected client and reports
 * `client-required` when none is present. `auto` uses the client when it is
 * present and the browser otherwise; with neither, it reports `no-printer`.
 * Presence is the store's 10 s client window, so the caller decides nothing.
 * @param input - configured engine, client presence, and browser availability.
 * @param input.printEngine - `auto`, `dsh`, `browser`, or an unknown value (auto).
 * @param input.clientPresent - whether a client polled inside the presence window.
 * @param input.browserAvailable - whether a browser executable was found.
 * @returns `browser`, `dsh`, `client-required`, or `no-printer`.
 */
export function chooseToolEngine({ printEngine = 'auto', clientPresent = false, browserAvailable = false } = {}) {
  if (printEngine === 'browser') return 'browser'
  if (printEngine === 'dsh') return clientPresent === true ? 'dsh' : 'client-required'
  return clientPresent === true ? 'dsh' : browserAvailable === true ? 'browser' : 'no-printer'
}

/**
 * Normalize the configured tool print engine.
 * @param value - row configuration value.
 * @returns `auto`, `dsh`, or `browser`.
 */
function toolPrintEngine(value) {
  return value === 'dsh' || value === 'browser' ? value : 'auto'
}

/**
 * Report whether a browser printer can be resolved.
 * @param options - row configuration plus the checks' explicit availability.
 * @returns whether the browser fallback can run.
 */
async function browserAvailableFor(options) {
  if (typeof options.browserAvailable === 'boolean') return options.browserAvailable
  const engines = await describeEngines(options)
  return engines.available.browser !== null
}

/**
 * Map one export result onto the `md2pdf_export` schema.
 *
 * Only the fields the tool declares cross this boundary. The print URL, the
 * finish token, the job id, warnings, and the preview address stay inside the
 * Host; an agent receives a path and a few facts about the file.
 * @param result - a DSH or browser export result.
 * @returns the tool result.
 */
function toolResultOf(result) {
  return {
    ok: result.ok === true,
    pdfPath: result.pdfPath,
    sourcePath: result.sourcePath,
    bytes: result.bytes,
    engine: result.engine,
    generator: result.generator,
    durationMs: result.durationMs,
  }
}

/**
 * Build the cancellation error a tool call should throw.
 * @param signal - the caller's abort signal, when one was supplied.
 * @returns the signal's reason, or a new `AbortError`.
 */
function abortErrorOf(signal) {
  if (signal !== undefined && signal.reason !== undefined) return signal.reason
  const error = new Error('the tool call was aborted')
  error.name = 'AbortError'
  return error
}

/**
 * Classify one watched job that has reached a terminal state.
 * @param job - the job record.
 * @returns the outcome, or null while the job is still open.
 */
function toolJobOutcome(job) {
  if (job.state === 'finished') return { kind: 'finished', result: job.result }
  if (job.state === 'failed') {
    return {
      kind: 'failed',
      reason: typeof job.failure?.reason === 'string' && job.failure.reason !== ''
        ? job.failure.reason
        : 'print-failed',
    }
  }
  if (job.state === 'expired') return { kind: 'expired' }
  return null
}

/**
 * Watch one brokered tool job until it ends, its deadline passes, or the
 * caller's signal aborts.
 *
 * The store's expiry timer should end a job at its deadline, but this loop also
 * runs the sweep itself, so a missed timer cannot leave the tool waiting past
 * the deadline. `claimed` records whether a client ever took the job; only an
 * unclaimed timeout may fall back to the browser in `auto` mode.
 * @param jobs - the job store that owns the job.
 * @param jobId - the job to watch.
 * @param options - the caller's abort signal.
 * @returns `finished`, `failed`, `expired`, or `aborted`, with `claimed`.
 */
async function waitForToolJob(jobs, jobId, { signal } = {}) {
  let claimed = false
  for (;;) {
    const job = jobs.get(jobId)
    if (job === null) return { kind: 'failed', reason: 'bad-request', claimed }
    // `claimedAt` survives the transition out of `claimed`, so a job that timed
    // out after a client took it can never be mistaken for an unclaimed one.
    if (job.claimedAt !== undefined) claimed = true
    if (job.state === 'claimed' || job.state === 'printing'
      || job.state === 'finishing' || job.state === 'finished') claimed = true
    const outcome = toolJobOutcome(job)
    if (outcome !== null) return { ...outcome, claimed }
    if (signal !== undefined && signal.aborted === true) return { kind: 'aborted', claimed }
    const now = Date.now()
    if (now >= job.deadline) {
      jobs.expire(now)
      const swept = jobs.get(jobId)
      const ended = swept === null ? null : toolJobOutcome(swept)
      if (ended !== null) return { ...ended, claimed }
      // A commit owns the job. The finish grace protects it from the sweep, so
      // wait for the write to settle instead of reporting a timeout it would
      // contradict.
      if (swept !== null && swept.state === 'finishing') {
        await new Promise(resolveWait => { setTimeout(resolveWait, TOOL_WATCH_MS) })
        continue
      }
      return { kind: 'expired', claimed }
    }
    await new Promise(resolveWait => { setTimeout(resolveWait, Math.min(TOOL_WATCH_MS, job.deadline - now)) })
  }
}

/**
 * Wait for a write lease to settle into a terminal state.
 *
 * Once a commit starts it owns the job, so cancellation must not report a
 * result the written file contradicts. The wait is bounded; a write that never
 * settles falls through to the normal abandonment path.
 * @param jobs - the job store that owns the job.
 * @param jobId - the job whose write is in flight.
 * @returns the terminal outcome, or null when the job stopped finishing or the
 *   window closed.
 */
async function waitForFinishingJob(jobs, jobId) {
  const deadline = Date.now() + FINISH_SETTLE_MS
  while (Date.now() < deadline) {
    const job = jobs.get(jobId)
    if (job === null) return { kind: 'failed', reason: 'bad-request' }
    const outcome = toolJobOutcome(job)
    if (outcome !== null) return outcome
    if (job.state !== 'finishing') return null
    await new Promise(resolveWait => { setTimeout(resolveWait, TOOL_WATCH_MS) })
  }
  return null
}

/**
 * Stop one abandoned tool job: fail it if still open, then close its server.
 * @param jobs - the job store that owns the job.
 * @param jobId - the abandoned job.
 * @param reason - short internal reason recorded on the job.
 * @returns a promise that resolves after the server is closed.
 */
async function abandonToolJob(jobs, jobId, reason) {
  const job = jobs.get(jobId)
  if (job !== null && (job.state === 'prepared' || job.state === 'claimed' || job.state === 'printing')) {
    try {
      jobs.fail(job.id, reason)
    } catch {
      // The job is already unusable; the close below still has to run.
    }
  }
  await closePrintServer(jobId)
}

/**
 * Run one tool export through the browser fallback after a broker failure.
 * @param request - the export request.
 * @param options - row configuration, including the injected browser printer.
 * @returns the browser export result.
 * @throws {PdfError} `no-printer` when no browser is available.
 */
async function browserFallbackTool(request, options) {
  if (options.signal !== undefined && options.signal.aborted === true) throw abortErrorOf(options.signal)
  if (!await browserAvailableFor(options)) {
    throw new PdfError('no-printer', 'the DSH client could not print and no browser is available')
  }
  return exportMarkdownToPdf(request, options)
}

/**
 * Wait up to the presence window for a connected client.
 *
 * DESIGN requires the tool to wait ten seconds for a client before it chooses
 * the browser fallback or reports `client-required`. This wait is about client
 * presence, not queue idleness: once a client is present the tool creates the
 * job and waits to the job deadline.
 * @param jobs - the job store that records client polls.
 * @param options - the caller's abort signal and a wait override for checks.
 * @returns true when a client is present, false when the window closes.
 * @throws the abort reason when the caller cancels during the wait.
 */
async function waitForToolPresence(jobs, { signal, waitMs } = {}) {
  const budget = Number.isFinite(waitMs) && waitMs >= 0 ? waitMs : TOOL_PRESENCE_WAIT_MS
  const deadline = Date.now() + budget
  for (;;) {
    if (signal !== undefined && signal.aborted === true) throw abortErrorOf(signal)
    if (jobs.presence.isPresent()) return true
    const remaining = deadline - Date.now()
    if (remaining <= 0) return false
    await new Promise(resolveWait => {
      setTimeout(resolveWait, Math.min(TOOL_PRESENCE_POLL_MS, remaining))
    })
  }
}

/**
 * Export one markdown file for the agent tool.
 *
 * The tool has no client object of its own, so it hands the work to a
 * connected DSH client through the print-job queue. It first waits up to the
 * 10 s presence window for that client to poll; if none appears, `auto` falls
 * back to the browser, `dsh` reports `client-required`, and a missing browser
 * with no client reports `no-printer`. When a client is present the engine
 * policy selects the broker, the job watcher returns the committed result, and
 * an `auto` job failure that cannot have written the target falls back to the
 * browser. A successful finish never falls back, and neither do `file-busy`
 * and `pdf-invalid`, because the target may already hold a result.
 *
 * The caller's `signal` is forwarded: an aborted tool call fails its job,
 * closes the loopback server, and rejects with the signal's reason, so no
 * orphan temp file or listening socket survives the cancellation.
 * @param request - `{ path, cwd?, preset?, page?, documentConfig? }`.
 * @param options - row configuration, the job store, an optional abort signal,
 *   a `presenceWaitMs` override for the checks, and the checks' injected
 *   browser printer.
 * @returns the `md2pdf_export` result: `{ ok, pdfPath, sourcePath, bytes, engine,
 *   generator, durationMs }`.
 * @throws {PdfError} for every refusal, failure, or timeout the agent can act on.
 */
export async function exportTool(request = {}, options = {}) {
  const signal = options.signal
  if (signal !== undefined && signal.aborted === true) throw abortErrorOf(signal)
  // A bad source is the caller's mistake, not a printer problem: report it
  // before waiting ten seconds for a client.
  await inspectSource(request)
  const jobs = resolvePrintJobs(options)
  const printEngine = toolPrintEngine(options.printEngine)
  // An explicit browser choice never needs a client and never waits.
  if (printEngine === 'browser') return toolResultOf(await exportMarkdownToPdf(request, options))

  // DESIGN: wait up to 10 s for a client before deciding to fall back. The
  // route records presence on every poll, so a connected Desktop client will
  // register even while the queue is empty.
  const clientPresent = await waitForToolPresence(jobs, {
    signal,
    waitMs: options.presenceWaitMs,
  })
  if (signal !== undefined && signal.aborted === true) throw abortErrorOf(signal)
  const browserAvailable = printEngine === 'auto' && !clientPresent
    ? await browserAvailableFor(options)
    : false
  if (signal !== undefined && signal.aborted === true) throw abortErrorOf(signal)
  const choice = chooseToolEngine({ printEngine, clientPresent, browserAvailable })
  if (choice === 'client-required') {
    throw new PdfError(
      'client-required',
      'no DSH client connected within the presence window and the DSH printer is required',
    )
  }
  if (choice === 'no-printer') {
    throw new PdfError(
      'no-printer',
      'no DSH client connected within the presence window and no browser is available',
    )
  }
  if (choice === 'browser') return toolResultOf(await exportMarkdownToPdf(request, options))

  let prepared
  try {
    prepared = await prepareExport({ ...request, owner: 'tool' }, options)
  } catch (error) {
    // A loopback server that cannot start is the one pre-job failure the
    // design lets `auto` retry through the browser.
    if (printEngine === 'auto' && error instanceof PdfError && error.code === 'asset-server-failed') {
      return toolResultOf(await browserFallbackTool(request, options))
    }
    throw error
  }
  const jobId = prepared.jobId
  let outcome
  try {
    outcome = await waitForToolJob(jobs, jobId, { signal })
  } catch (error) {
    await abandonToolJob(jobs, jobId, 'client-error')
    throw error
  }
  if (outcome.kind === 'aborted') {
    // A commit that already started owns the job. Report its result rather than
    // cancelling a call whose PDF is being written.
    const live = jobs.get(jobId)
    if (live !== null && live.state === 'finishing') {
      const settled = await waitForFinishingJob(jobs, jobId)
      if (settled !== null && settled.kind === 'finished') return toolResultOf(settled.result)
    }
    await abandonToolJob(jobs, jobId, 'client-error')
    throw abortErrorOf(signal)
  }
  if (outcome.kind === 'finished') return toolResultOf(outcome.result)

  // The job is failed or expired, so nothing will commit; close the one-shot
  // server before a possible browser run starts its own printer.
  await closePrintServer(jobId)
  if (outcome.kind === 'failed') {
    if (printEngine === 'auto' && TOOL_FALLBACK_REASONS.has(outcome.reason)) {
      return toolResultOf(await browserFallbackTool(request, options))
    }
    throw new PdfError(outcome.reason, `the DSH client could not print the document: ${outcome.reason}`)
  }
  if (printEngine === 'auto' && outcome.claimed !== true) {
    return toolResultOf(await browserFallbackTool(request, options))
  }
  throw new PdfError('job-timeout', 'the print job timed out before a client finished it')
}

/**
 * Normalize the post-export action from row configuration.
 *
 * `dsh` opens the DSH viewer, `system` uses the platform default program, and
 * `none` only reports the path. An absent or unknown value means `dsh`.
 * @param value - the configured `afterExport` value.
 * @returns `dsh`, `system`, or `none`.
 */
function afterExportMode(value) {
  return value === 'system' || value === 'none' ? value : 'dsh'
}

/**
 * Report what this Host can print with, once, for a capability check.
 *
 * The Host knows its browser path and the configured print engine. The DSH
 * printer lives in the client, so `dsh` is reported as unknown, never guessed.
 * @param options - print engine preference, post-export action, and explicit paths.
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
    afterExport: afterExportMode(options.afterExport),
    dsh: 'unknown',
    renderer: options.renderer ?? 'builtin',
    theme: selected,
    page: DEFAULT_PAGE,
    extensions: MARKDOWN_EXTENSIONS,
    cssPath: presetCssPath(selected),
  }
}
