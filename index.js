/**
 * Host half of the md2pdf bundle.
 *
 * The browser's export path is two steps: `/md2pdf/prepare` renders the page and
 * creates a print job, and `/md2pdf/finish` receives the PDF bytes the DSH
 * client printed. `/md2pdf/export` stays as the browser fallback for the Web
 * GUI, the agent tool, and any install without a DSH printer. The capability
 * route reports the Host's browser and leaves the client-side DSH printer
 * unknown.
 *
 * Every route asks the composition's `connection` service for a rejection
 * first: that fence checks Host and Origin and the browser's login token, so
 * only the local page can reach a printer that writes into the user's
 * workspace.
 */
import { isAbsolute } from 'node:path'

import {
  describeCapability, exportMarkdownToPdf, exportTool, failPrintJob, finishExport, MARKDOWN_EXTENSIONS,
  openFinishedExport, prepareExport, resolvePrintJobs,
} from './src/export.js'
import { fontFacesInCss, fontsInCss } from './src/font-css.js'
import { openPath } from './src/opener.js'
import { PdfError } from './src/pdf.js'
import {
  listPresets, MAX_CSS_BYTES as MAX_PRESET_CSS_BYTES, presetCssPath, presetsDirectory,
  readPreset, runPresetAction,
} from './src/presets.js'
import { buildPreviews } from './src/previews.js'
import { THEMES } from './src/themes.js'

/** Route serving one export request. */
export const EXPORT_PATH = '/md2pdf/export'

/** Route rendering a document and creating one print job. */
export const PREPARE_PATH = '/md2pdf/prepare'

/** Route accepting the PDF bytes a DSH client printed. */
export const FINISH_PATH = '/md2pdf/finish'

/** Route reporting a client-side print failure for one claimed job. */
export const FAIL_JOB_PATH = '/md2pdf/print-jobs/fail'

/** Route a connected DSH client long-polls for agent tool jobs. */
export const NEXT_JOB_PATH = '/md2pdf/print-jobs/next'

/** Route opening the committed PDF of one finished UI job with the system opener. */
export const OPEN_PATH = '/md2pdf/open'

/** Route reporting which printers this Host can use. */
export const CAPABILITY_PATH = '/md2pdf/capability'

/** Route reading the preset library and the stylesheet of the selected preset. */
export const SETTINGS_PATH = '/md2pdf/settings'

/** Route running one preset action. */
export const PRESETS_PATH = '/md2pdf/presets'

/** Route serving the miniature pages the settings page shows. */
export const PREVIEWS_PATH = '/md2pdf/previews'

/** Request bodies are small JSON objects; anything larger is hostile. */
const MAX_BODY_BYTES = 1024 * 1024

/** The PDF a client may return in one finish request. */
const MAX_PDF_BYTES = 64 * 1024 * 1024

/** How long a broker poll waits when the client sends no `wait`. */
const BROKER_WAIT_DEFAULT_SECONDS = 20

/** The longest the broker route may hold one request open. */
const BROKER_WAIT_MAX_SECONDS = 30

/** How often the broker route checks the queue while it holds. */
const BROKER_POLL_MS = 100

/** How often a held poll re-records the client presence. */
const BROKER_HEARTBEAT_MS = 5000

/** The one presence key the broker poll writes; polls never mint client keys. */
const BROKER_PRESENCE_KEY = 'md2pdf-broker'

/** The route carrier, the trust fence, and the tool registry. */
export const inject = ['webServer', 'connection', 'tools']

/** One HTTP status per failure code. */
const FAILURE_STATUS = {
  'bad-request': 400,
  'not-markdown': 400,
  'not-found': 404,
  'not-a-file': 400,
  'not-text': 415,
  'too-large': 413,
  'name-exists': 409,
  'open-failed': 500,
  'not-a-pdf': 502,
  'empty-output': 502,
  'print-failed': 502,
  'no-printer': 503,
  'pdf-invalid': 502,
  'finish-conflict': 409,
  'state-conflict': 409,
  'file-busy': 409,
  'asset-server-failed': 500,
  'job-timeout': 504,
  'client-required': 503,
}

/**
 * Write one JSON response; live facts are never cached.
 * @param res - the response to answer.
 * @param status - HTTP status.
 * @param payload - JSON body.
 */
function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/**
 * Refuse one untrusted or unauthenticated request.
 * @returns true when the request was answered here and the handler must stop.
 */
function refused(ctx, req, res) {
  let rejection
  try {
    rejection = ctx.connection.requestRejection(req)
  } catch {
    // A composition without the fence cannot authenticate the caller, so it
    // answers nothing rather than serving an unguarded print.
    res.statusCode = 503
    res.end()
    return true
  }
  if (rejection === undefined) return false
  res.statusCode = rejection
  res.end()
  return true
}

/**
 * Collect a bounded request body as text.
 * @returns the body text, or null past the ceiling.
 */
async function readBoundedBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += piece.byteLength
    if (size > MAX_BODY_BYTES) {
      req.resume()
      return null
    }
    chunks.push(piece)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

/**
 * Collect a bounded binary request body.
 * @param req - the request to read.
 * @param maxBytes - largest accepted body.
 * @returns the body bytes, or null past the ceiling.
 */
async function readBoundedBinary(req, maxBytes) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += piece.byteLength
    if (size > maxBytes) {
      req.resume()
      return null
    }
    chunks.push(piece)
  }
  return Buffer.concat(chunks, size)
}

/**
 * Parse the export body, rejecting anything the operation cannot use.
 * @returns the request, or null when the body is unusable.
 */
function parseExportBody(text) {
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof body !== 'object' || body === null) return null
  if (typeof body.path !== 'string' || body.path === '') return null
  const request = { path: body.path }
  if (typeof body.sessionId === 'string' && body.sessionId !== '') request.sessionId = body.sessionId
  if (typeof body.cwd === 'string' && body.cwd !== '') request.cwd = body.cwd
  if (typeof body.engine === 'string') request.engine = body.engine
  if (typeof body.browserPath === 'string' && body.browserPath !== '') request.browserPath = body.browserPath
  if (typeof body.page === 'object' && body.page !== null) request.page = body.page
  return request
}

/**
 * Parse the prepare body.
 *
 * Only the source path and render overrides are accepted. The target path, the
 * asset root, and any command stay Host-owned, so the client cannot choose
 * where a PDF is written.
 * @returns the request, or null when the body is unusable.
 */
function parsePrepareBody(text) {
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  if (typeof body.path !== 'string' || body.path === '') return null
  const request = { path: body.path, owner: 'ui' }
  if (typeof body.sessionId === 'string' && body.sessionId !== '') request.sessionId = body.sessionId
  if (typeof body.preset === 'string' && body.preset !== '') request.preset = body.preset
  if (typeof body.page === 'object' && body.page !== null) request.page = body.page
  if (typeof body.documentConfig === 'object' && body.documentConfig !== null) {
    request.documentConfig = body.documentConfig
  }
  return request
}

/**
 * Parse the open body.
 *
 * Only the finish token is read. A path, job id, or URL in the body is ignored,
 * because the Host resolves the target from the job record it owns.
 * @returns the request, or null when the body is unusable.
 */
function parseOpenBody(text) {
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  if (typeof body.finishToken !== 'string' || body.finishToken.trim() === '') return null
  return { finishToken: body.finishToken.trim() }
}

/**
 * Parse the broker fail body.
 *
 * Only the finish token and the reason are read. The reason is checked against
 * the closed client list by `failPrintJob`; a missing field is refused here so
 * the route never guesses.
 * @returns the request, or null when the body is unusable.
 */
function parseFailBody(text) {
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  if (typeof body.finishToken !== 'string' || body.finishToken.trim() === '') return null
  if (typeof body.reason !== 'string' || body.reason === '') return null
  return { finishToken: body.finishToken.trim(), reason: body.reason }
}

/**
 * Resolve the broker poll's wait from the query string.
 *
 * An absent or non-numeric value keeps the 20 s default. Every other value is
 * clamped to 0–30 s, so a client cannot pin a Host request open forever.
 * @param raw - the `wait` query value, or undefined.
 * @returns the wait in seconds.
 */
export function brokerWaitSeconds(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return BROKER_WAIT_DEFAULT_SECONDS
  const value = Number(raw)
  if (!Number.isFinite(value)) return BROKER_WAIT_DEFAULT_SECONDS
  return Math.min(BROKER_WAIT_MAX_SECONDS, Math.max(0, value))
}

/**
 * Read one query parameter from a request URL without trusting it.
 * @param req - the HTTP request.
 * @param name - parameter name.
 * @returns the value, or undefined when absent or unparsable.
 */
function queryParameter(req, name) {
  try {
    const url = new URL(typeof req.url === 'string' ? req.url : '/', 'http://127.0.0.1')
    return url.searchParams.get(name) ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Build the only payload a broker poll may return.
 *
 * The fields are named one by one, so the job's asset token, source, target,
 * asset root, HTML, owner, and state cannot reach the client by accident.
 * @param job - the claimed tool job.
 * @returns the client payload.
 */
function brokerJobPayload(job) {
  const payload = {
    jobId: job.id,
    printUrl: job.printUrl,
    finishToken: job.finishToken,
    printOptions: job.printOptions,
  }
  if (typeof job.sessionId === 'string' && job.sessionId !== '') payload.sessionId = job.sessionId
  if (Array.isArray(job.warnings) && job.warnings.length > 0) payload.warnings = [...job.warnings]
  return payload
}

/**
 * Wait for one bounded interval.
 * @param ms - milliseconds.
 * @returns a promise that resolves after the delay.
 */
function brokerSleep(ms) {
  return new Promise(resolveSleep => { setTimeout(resolveSleep, ms) })
}

/**
 * Read one Session's effective working directory from the Host's own services.
 * @param ctx - host context.
 * @param sessionId - the Session that reported the relative path.
 * @returns the absolute directory, or undefined when the Session is unknown.
 */
function sessionDirectory(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  try {
    const sessions = ctx.get('sessions')
    const workingDirectory = ctx.get('workingDirectory')
    if (sessions === undefined || workingDirectory === undefined) return undefined
    const session = sessions.get(sessionId)
    if (session === undefined) return undefined
    return workingDirectory.get(session)
  } catch {
    return undefined
  }
}

/**
 * Fill in the workspace directory for a relative source path.
 * @returns the request with `cwd` set when the Session is known.
 */
function withSessionDirectory(ctx, request) {
  if (request.cwd !== undefined || isAbsolute(request.path)) return request
  const cwd = sessionDirectory(ctx, request.sessionId)
  return cwd === undefined ? request : { ...request, cwd }
}

/**
 * Map a thrown failure onto one HTTP answer.
 * @returns the status, code, and message to send.
 */
function failureResponse(error) {
  if (error instanceof PdfError) {
    return { status: FAILURE_STATUS[error.code] ?? 500, code: error.code, message: error.message }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { status: 500, code: 'internal', message }
}

/**
 * Register the routes and the agent tool for this plugin's lifetime.
 * @param ctx - host context carrying the route carrier, trust fence, and tools.
 * @param config - optional row configuration; every field has a default.
 */
export function apply(ctx, config) {
  const options = {
    engine: config?.engine,
    printEngine: config?.printEngine,
    afterExport: config?.afterExport,
    browserPath: config?.browserPath,
    pandocPath: config?.pandocPath,
    renderer: config?.renderer,
    timeoutMs: config?.timeoutMs,
    // Injectable opener for the checks; production uses the platform launcher.
    open: config?.open,
    // The checks inject a store and a fake browser printer; production uses the
    // process-wide store and the real Chromium printer.
    jobs: config?.jobs,
    browserAvailable: config?.browserAvailable,
    printBrowser: config?.printBrowser,
    startPrintServer: config?.startPrintServer,
    brokerHeartbeatMs: config?.brokerHeartbeatMs,
    presenceWaitMs: config?.presenceWaitMs,
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: SETTINGS_PATH,
    handler: async (req, res) => {
      if (refused(ctx, req, res)) return
      if (req.method !== 'GET') {
        res.statusCode = 405
        res.setHeader('allow', 'GET')
        res.end()
        return
      }
      try {
        const { selected, presets } = await listPresets()
        const current = await readPreset(selected)
        // The Host reports which families the stylesheet asks for and which
        // ones are declared by @font-face. Availability is a browser fact; the
        // client checks it with document.fonts and never trusts this table for it.
        const faces = new Set(fontFacesInCss(current.css).map(family => family.toLowerCase()))
        sendJson(res, 200, {
          selected,
          presets,
          builtins: THEMES.map(theme => theme.id),
          css: current.css,
          cssPath: presetCssPath(selected),
          presetsPath: presetsDirectory(),
          maxBytes: MAX_PRESET_CSS_BYTES,
          fonts: fontsInCss(current.css).map(family => ({
            family,
            face: faces.has(family.toLowerCase()),
          })),
        })
      } catch (error) {
        const failure = failureResponse(error)
        sendJson(res, failure.status, { ok: false, ...failure })
      }
    },
  }), `md2pdf: GET ${SETTINGS_PATH}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: PRESETS_PATH,
    handler: async (req, res) => {
      if (refused(ctx, req, res)) return
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end()
        return
      }
      const essence = String(req.headers['content-type']).split(';', 1)[0]?.trim().toLowerCase()
      if (essence !== 'application/json') {
        sendJson(res, 415, { ok: false, code: 'unsupported-media-type', message: 'content-type must be application/json' })
        return
      }
      let text
      try {
        text = await readBoundedBody(req)
      } catch {
        sendJson(res, 400, { ok: false, code: 'bad-request', message: 'request body unreadable' })
        return
      }
      if (text === null) {
        sendJson(res, 413, { ok: false, code: 'payload-too-large', message: 'request body is too large' })
        return
      }
      let body
      try {
        body = JSON.parse(text)
      } catch {
        sendJson(res, 400, { ok: false, code: 'bad-request', message: 'body must be JSON' })
        return
      }
      try {
        const result = await runPresetAction(body)
        if (body.action === 'open') await openPath(result.path)
        sendJson(res, 200, { ok: true, ...result })
      } catch (error) {
        const failure = failureResponse(error)
        sendJson(res, failure.status, { ok: false, ...failure, details: error?.details })
      }
    },
  }), `md2pdf: POST ${PRESETS_PATH}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: PREVIEWS_PATH,
    handler: async (req, res) => {
      if (refused(ctx, req, res)) return
      if (req.method !== 'GET') {
        res.statusCode = 405
        res.setHeader('allow', 'GET')
        res.end()
        return
      }
      try {
        sendJson(res, 200, await buildPreviews())
      } catch (error) {
        const failure = failureResponse(error)
        sendJson(res, failure.status, { ok: false, ...failure })
      }
    },
  }), `md2pdf: GET ${PREVIEWS_PATH}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CAPABILITY_PATH,
    handler: (req, res) => {
      if (refused(ctx, req, res)) return
      if (req.method !== 'GET') {
        res.statusCode = 405
        res.setHeader('allow', 'GET')
        res.end()
        return
      }
      describeCapability(options)
        .then(capability => sendJson(res, 200, capability))
        .catch((error) => {
          const failure = failureResponse(error)
          sendJson(res, failure.status, { ok: false, ...failure })
        })
    },
  }), `md2pdf: GET ${CAPABILITY_PATH}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: PREPARE_PATH,
    handler: async (req, res) => {
      if (refused(ctx, req, res)) return
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end()
        return
      }
      const essence = String(req.headers['content-type']).split(';', 1)[0]?.trim().toLowerCase()
      if (essence !== 'application/json') {
        sendJson(res, 415, { ok: false, code: 'unsupported-media-type', message: 'content-type must be application/json' })
        return
      }
      let text
      try {
        text = await readBoundedBody(req)
      } catch {
        sendJson(res, 400, { ok: false, code: 'bad-request', message: 'request body unreadable' })
        return
      }
      if (text === null) {
        sendJson(res, 413, { ok: false, code: 'payload-too-large', message: 'request body is too large' })
        return
      }
      const request = parsePrepareBody(text)
      if (request === null) {
        sendJson(res, 400, { ok: false, code: 'bad-request', message: 'body must be JSON with a string "path"' })
        return
      }
      try {
        sendJson(res, 200, await prepareExport(withSessionDirectory(ctx, request), options))
      } catch (error) {
        const failure = failureResponse(error)
        sendJson(res, failure.status, { ok: false, ...failure })
      }
    },
  }), `md2pdf: POST ${PREPARE_PATH}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: FINISH_PATH,
    handler: async (req, res) => {
      if (refused(ctx, req, res)) return
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end()
        return
      }
      const essence = String(req.headers['content-type']).split(';', 1)[0]?.trim().toLowerCase()
      if (essence !== 'application/pdf') {
        sendJson(res, 415, { ok: false, code: 'unsupported-media-type', message: 'content-type must be application/pdf' })
        return
      }
      const header = req.headers['x-md2pdf-token']
      const finishToken = typeof header === 'string' ? header.trim() : ''
      if (finishToken === '') {
        sendJson(res, 400, { ok: false, code: 'bad-request', message: 'x-md2pdf-token is required' })
        return
      }
      const declared = Number(req.headers['content-length'])
      if (Number.isFinite(declared) && declared > MAX_PDF_BYTES) {
        req.resume()
        sendJson(res, 413, { ok: false, code: 'payload-too-large', message: 'PDF body is too large' })
        return
      }
      let pdfBytes
      try {
        pdfBytes = await readBoundedBinary(req, MAX_PDF_BYTES)
      } catch {
        sendJson(res, 400, { ok: false, code: 'bad-request', message: 'request body unreadable' })
        return
      }
      if (pdfBytes === null) {
        sendJson(res, 413, { ok: false, code: 'payload-too-large', message: 'PDF body is too large' })
        return
      }
      try {
        sendJson(res, 200, await finishExport({ finishToken, pdfBytes }, options))
      } catch (error) {
        const failure = failureResponse(error)
        sendJson(res, failure.status, { ok: false, ...failure })
      }
    },
  }), `md2pdf: POST ${FINISH_PATH}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: NEXT_JOB_PATH,
    handler: async (req, res) => {
      if (refused(ctx, req, res)) return
      if (req.method !== 'GET') {
        res.statusCode = 405
        res.setHeader('allow', 'GET')
        res.end()
        return
      }
      const jobs = resolvePrintJobs(options)
      const waitMs = brokerWaitSeconds(queryParameter(req, 'wait')) * 1000
      const deadline = Date.now() + waitMs
      const heartbeatMs = Number.isFinite(options.brokerHeartbeatMs) && options.brokerHeartbeatMs > 0
        ? options.brokerHeartbeatMs
        : BROKER_HEARTBEAT_MS
      let closed = false
      let heartbeat = null
      const onClose = () => {
        closed = true
        if (heartbeat !== null) clearInterval(heartbeat)
      }
      if (typeof res.once === 'function') res.once('close', onClose)
      heartbeat = setInterval(() => {
        jobs.presence.record(BROKER_PRESENCE_KEY)
      }, heartbeatMs)
      if (typeof heartbeat.unref === 'function') heartbeat.unref()
      try {
        // Presence is recorded on entry, before the first claim, so a tool call
        // that starts while this poll holds sees a connected client.
        jobs.presence.record(BROKER_PRESENCE_KEY)
        for (;;) {
          if (closed) return
          const job = jobs.claimToolJob()
          if (job !== null) {
            sendJson(res, 200, brokerJobPayload(job))
            return
          }
          const remaining = deadline - Date.now()
          if (remaining <= 0) {
            res.statusCode = 204
            res.setHeader('cache-control', 'no-store')
            res.end()
            return
          }
          await brokerSleep(Math.min(BROKER_POLL_MS, remaining))
        }
      } finally {
        if (heartbeat !== null) clearInterval(heartbeat)
        if (typeof res.off === 'function') res.off('close', onClose)
      }
    },
  }), `md2pdf: GET ${NEXT_JOB_PATH}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: FAIL_JOB_PATH,
    handler: async (req, res) => {
      if (refused(ctx, req, res)) return
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end()
        return
      }
      const essence = String(req.headers['content-type']).split(';', 1)[0]?.trim().toLowerCase()
      if (essence !== 'application/json') {
        sendJson(res, 415, { ok: false, code: 'unsupported-media-type', message: 'content-type must be application/json' })
        return
      }
      let text
      try {
        text = await readBoundedBody(req)
      } catch {
        sendJson(res, 400, { ok: false, code: 'bad-request', message: 'request body unreadable' })
        return
      }
      if (text === null) {
        sendJson(res, 413, { ok: false, code: 'payload-too-large', message: 'request body is too large' })
        return
      }
      const request = parseFailBody(text)
      if (request === null) {
        sendJson(res, 400, {
          ok: false,
          code: 'bad-request',
          message: 'body must be JSON with a string "finishToken" and "reason"',
        })
        return
      }
      try {
        sendJson(res, 200, await failPrintJob(request, options))
      } catch (error) {
        const failure = failureResponse(error)
        sendJson(res, failure.status, { ok: false, ...failure })
      }
    },
  }), `md2pdf: POST ${FAIL_JOB_PATH}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: OPEN_PATH,
    handler: async (req, res) => {
      if (refused(ctx, req, res)) return
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end()
        return
      }
      const essence = String(req.headers['content-type']).split(';', 1)[0]?.trim().toLowerCase()
      if (essence !== 'application/json') {
        sendJson(res, 415, { ok: false, code: 'unsupported-media-type', message: 'content-type must be application/json' })
        return
      }
      let text
      try {
        text = await readBoundedBody(req)
      } catch {
        sendJson(res, 400, { ok: false, code: 'bad-request', message: 'request body unreadable' })
        return
      }
      if (text === null) {
        sendJson(res, 413, { ok: false, code: 'payload-too-large', message: 'request body is too large' })
        return
      }
      const request = parseOpenBody(text)
      if (request === null) {
        sendJson(res, 400, { ok: false, code: 'bad-request', message: 'body must be JSON with a string "finishToken"' })
        return
      }
      try {
        sendJson(res, 200, await openFinishedExport(request, options))
      } catch (error) {
        const failure = failureResponse(error)
        sendJson(res, failure.status, { ok: false, ...failure })
      }
    },
  }), `md2pdf: POST ${OPEN_PATH}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: EXPORT_PATH,
    handler: async (req, res) => {
      if (refused(ctx, req, res)) return
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end()
        return
      }
      const essence = String(req.headers['content-type']).split(';', 1)[0]?.trim().toLowerCase()
      if (essence !== 'application/json') {
        sendJson(res, 415, { ok: false, code: 'unsupported-media-type', message: 'content-type must be application/json' })
        return
      }
      let text
      try {
        text = await readBoundedBody(req)
      } catch {
        sendJson(res, 400, { ok: false, code: 'bad-request', message: 'request body unreadable' })
        return
      }
      if (text === null) {
        sendJson(res, 413, { ok: false, code: 'payload-too-large', message: 'request body is too large' })
        return
      }
      const request = parseExportBody(text)
      if (request === null) {
        sendJson(res, 400, { ok: false, code: 'bad-request', message: 'body must be JSON with a string "path"' })
        return
      }
      try {
        const result = await exportMarkdownToPdf(withSessionDirectory(ctx, request), options)
        sendJson(res, 200, result)
      } catch (error) {
        const failure = failureResponse(error)
        sendJson(res, failure.status, { ok: false, ...failure })
      }
    },
  }), `md2pdf: POST ${EXPORT_PATH}`)

  ctx.effect(() => ctx.tools.register({
    name: 'md2pdf_export',
    description: `Export a Markdown file to a PDF beside it. The PDF takes the source name with a .pdf suffix, in the source directory. Accepted extensions: ${MARKDOWN_EXTENSIONS.join(', ')}.`,
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Markdown file to export: an absolute path, or one relative to the session working directory.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          pdfPath: { type: 'string', description: 'Absolute path of the written PDF.' },
          sourcePath: { type: 'string' },
          bytes: { type: 'integer', description: 'Size of the written PDF.' },
          engine: { type: 'string', description: 'Printer that produced the file.' },
          generator: { type: 'string', description: 'Markdown renderer that produced the HTML.' },
          durationMs: { type: 'integer' },
        },
        required: ['ok', 'pdfPath'],
        additionalProperties: false,
      },
      render: (args, value) => [{
        type: 'text',
        text: `Exported ${String(args?.path ?? '')} to ${String(value?.pdfPath ?? '')}`,
      }],
    },
    async execute(args, exec) {
      const requested = typeof args?.path === 'string' ? args.path : ''
      const cwd = sessionDirectory(ctx, exec.agent?.id) ?? process.cwd()
      // The broker chooses the client printer when one is present and the
      // configured engine allows it; the signal cancels a queued tool job.
      return exportTool({ path: requested, cwd }, { ...options, signal: exec.signal })
    },
  }), 'md2pdf: md2pdf_export tool')
}
