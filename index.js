/**
 * Host half of the md2pdf bundle.
 *
 * Two routes carry the browser's export request and the capability probe the
 * client uses to decide whether its controls are usable at all; one tool lets
 * the agent run the same operation. Both callers enter `exportMarkdownToPdf`,
 * so placement, validation, and failure codes have a single definition.
 *
 * Every route asks the composition's `connection` service for a rejection
 * first: that fence checks Host and Origin and the browser's login token, so
 * only the local page can reach a printer that writes into the user's
 * workspace.
 */
import { isAbsolute } from 'node:path'

import { describeCapability, exportMarkdownToPdf, MARKDOWN_EXTENSIONS } from './src/export.js'
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
    browserPath: config?.browserPath,
    pandocPath: config?.pandocPath,
    renderer: config?.renderer,
    timeoutMs: config?.timeoutMs,
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
        sendJson(res, 200, {
          selected,
          presets,
          builtins: THEMES.map(theme => theme.id),
          css: current.css,
          cssPath: presetCssPath(selected),
          presetsPath: presetsDirectory(),
          maxBytes: MAX_PRESET_CSS_BYTES,
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
      const result = await exportMarkdownToPdf({ path: requested, cwd }, options)
      return {
        ok: result.ok,
        pdfPath: result.pdfPath,
        sourcePath: result.sourcePath,
        bytes: result.bytes,
        engine: result.engine,
        generator: result.generator,
        durationMs: result.durationMs,
      }
    },
  }), 'md2pdf: md2pdf_export tool')
}
