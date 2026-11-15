/**
 * Checks for the after-export open: the configured system opener on a
 * successful UI finish, and the token-keyed fallback the client uses when the
 * DSH viewer is unavailable.
 *
 * The Host checks drive a real prepare/finish pair and inject the opener, so
 * the system action is observable without launching an application. They pin
 * that only a UI job opens, that a repeated finish opens once, that a failed or
 * conflicted finish opens nothing, and that an opener failure is reported on
 * the result without turning the write into a failed export.
 *
 * The token checks pin one rule: the caller sends the finish token, and only
 * that. The target is the job's committed target, so a path, job id, or URL in
 * the request is ignored. A job that is not finished, or a token that is not
 * the finish secret, is refused before the opener runs.
 *
 * The client function is extracted from `client.js` and run in this process
 * with stubs. That proves the DSH preview is tried first and the Host fallback
 * runs only when the viewer or its address is unavailable.
 *
 * Run: node scripts/after-export-check.mjs
 */
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
 * Assert a condition holds.
 * @param label - what the check proves.
 * @param condition - required truth.
 */
function expectTrue(label, condition) {
  expectEqual(label, condition === true, true)
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

/**
 * Run one async call and return either its value or the error it throws.
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

const here = dirname(fileURLToPath(import.meta.url))
const home = await mkdtemp(join(tmpdir(), 'dsh-md2pdf-after-home-'))
const work = await mkdtemp(join(tmpdir(), 'dsh-md2pdf-after-work-'))
process.env['MD2PDF_HOME'] = home

/** A payload every finish accepts. */
const PDF = Buffer.from('%PDF-1.4\n%%EOF\n', 'latin1')
/** A different complete PDF, for the conflict checks. */
const OTHER_PDF = Buffer.from('%PDF-1.5\n%%EOF\n', 'latin1')

const {
  finishExport, openFinishedExport, prepareExport,
} = await import('../src/export.js')
const { createPrintJobs } = await import('../src/print-jobs.js')
const { PdfError } = await import('../src/pdf.js')
const indexModule = await import('../index.js')

/**
 * Build one response object for a mounted route.
 * @returns the fake response.
 */
function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name] = value },
    end(body = '') { this.body = body },
  }
}

/**
 * Build one request object with an optional text body.
 * @param method - HTTP method.
 * @param body - request text, or undefined for no body.
 * @param contentType - content-type header; null omits it.
 * @returns the request the route handler reads.
 */
function fakeRequest(method, body, contentType = 'application/json') {
  const headers = {}
  if (contentType !== null) headers['content-type'] = contentType
  return {
    method,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(body)
    },
  }
}

/**
 * Call one mounted route and parse its JSON answer.
 * @param routes - registered handlers by path.
 * @param path - route path.
 * @param req - fake request.
 * @returns the status and parsed body.
 */
async function callRoute(routes, path, req) {
  const res = fakeResponse()
  const handler = routes.get(path)
  if (handler === undefined) return { status: 0, payload: null }
  await handler(req, res)
  return { status: res.statusCode, payload: res.body === '' ? null : JSON.parse(res.body) }
}

/**
 * Mount the Host routes on a fake context, the form the checks use.
 * @param config - row configuration, including the injected opener.
 * @param rejection - status the trust fence returns; undefined accepts.
 * @returns the registered handlers by path.
 */
function mountRoutes(config = {}, rejection = undefined) {
  const routes = new Map()
  const { apply } = indexModule
  apply({
    effect(register) {
      register()
      return () => {}
    },
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
        return () => {}
      },
    },
    connection: { requestRejection() { return rejection } },
    tools: { register() { return () => {} } },
    get() { return undefined },
  }, config)
  return routes
}

/**
 * Extract one function declaration from the client source.
 *
 * The client is a classic script with no importable surface, so the checks run
 * the one function that makes the fallback decision under stubs. Braces inside
 * strings are not expected in that function; the body is counted literally.
 * @param source - client source text.
 * @param signature - function header to find.
 * @returns the function source, or null when it is not found.
 */
function extractFunction(source, signature) {
  const start = source.indexOf(signature)
  if (start < 0) return null
  let depth = 0
  let seen = false
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]
    if (character === '{') {
      depth += 1
      seen = true
    } else if (character === '}') {
      depth -= 1
      if (seen && depth === 0) return source.slice(start, index + 1)
    }
  }
  return null
}

try {
  await copyFile(join(here, '..', 'samples', 'sample.md'), join(work, 'sample.md'))
  const source = join(work, 'sample.md')
  const target = join(work, 'sample.pdf')

  // 1. Default and `none` never reach the Host opener. The default is `dsh`,
  // which the client opens; `none` only reports the path.
  const quietJobs = createPrintJobs()
  const quietOpens = []
  const quietPrepared = await prepareExport({ path: source, sessionId: 's1' }, { jobs: quietJobs })
  const quiet = await finishExport(
    { finishToken: quietPrepared.finishToken, pdfBytes: PDF },
    { jobs: quietJobs, open: async path => quietOpens.push(path) },
  )
  expectEqual('the default afterExport does not call the Host opener', quietOpens.length, 0)
  expectEqual('the default result has no open record', Object.hasOwn(quiet, 'open'), false)

  const noneJobs = createPrintJobs()
  const noneOpens = []
  const nonePrepared = await prepareExport({ path: source, sessionId: 's1' }, { jobs: noneJobs })
  const none = await finishExport(
    { finishToken: nonePrepared.finishToken, pdfBytes: PDF },
    { jobs: noneJobs, afterExport: 'none', open: async path => noneOpens.push(path) },
  )
  expectEqual('afterExport none never opens with the system opener', noneOpens.length, 0)
  expectEqual('afterExport none returns no open record', Object.hasOwn(none, 'open'), false)

  // 2. A UI finish with `system` opens the committed target exactly once, even
  // when the client replays the same finish token and bytes.
  const uiJobs = createPrintJobs()
  const uiOpens = []
  const uiOptions = { jobs: uiJobs, afterExport: 'system', open: async path => uiOpens.push(path) }
  const uiPrepared = await prepareExport({ path: source, sessionId: 's1' }, { jobs: uiJobs })
  const ui = await finishExport(
    { finishToken: uiPrepared.finishToken, pdfBytes: PDF },
    uiOptions,
  )
  expectEqual('a UI system finish opens the written target', uiOpens[0], target)
  expectEqual('a UI system finish opens once', uiOpens.length, 1)
  expectEqual('the open record names the system action', ui.open?.mode, 'system')
  expectEqual('the open record reports success', ui.open?.ok, true)
  expectEqual('the export is still successful', ui.ok, true)
  expectEqual('the export still reports the PDF', ui.pdfPath, target)

  const uiReplay = await finishExport(
    { finishToken: uiPrepared.finishToken, pdfBytes: PDF },
    uiOptions,
  )
  expectEqual('a replayed finish returns the committed result', uiReplay, ui)
  expectEqual('a replayed finish does not open again', uiOpens.length, 1)
  const uiConflict = await capture(() => finishExport(
    { finishToken: uiPrepared.finishToken, pdfBytes: OTHER_PDF },
    uiOptions,
  ))
  expectEqual('different bytes still conflict after a system open', uiConflict?.code, 'finish-conflict')
  expectEqual('a conflicted finish does not open again', uiOpens.length, 1)

  // 3. A tool job is printed through the client but never opened: Task 7 keeps
  // the broker's result to a path and does not apply afterExport.
  const toolJobs = createPrintJobs()
  const toolOpens = []
  const toolPrepared = await prepareExport(
    { path: source, sessionId: 's1', owner: 'tool' },
    { jobs: toolJobs },
  )
  const tool = await finishExport(
    { finishToken: toolPrepared.finishToken, pdfBytes: PDF },
    { jobs: toolJobs, afterExport: 'system', open: async path => toolOpens.push(path) },
  )
  expectEqual('a tool system finish never calls the opener', toolOpens.length, 0)
  expectEqual('a tool result carries no open record', Object.hasOwn(tool, 'open'), false)

  // 4. A failed finish opens nothing and keeps the old PDF.
  await writeFile(target, PDF)
  const failJobs = createPrintJobs()
  const failOpens = []
  const failPrepared = await prepareExport({ path: source, sessionId: 's1' }, { jobs: failJobs })
  const failed = await capture(() => finishExport(
    { finishToken: failPrepared.finishToken, pdfBytes: Buffer.from('not a pdf') },
    { jobs: failJobs, afterExport: 'system', open: async path => failOpens.push(path) },
  ))
  expectEqual('an invalid payload still fails the finish', failed?.code, 'pdf-invalid')
  expectEqual('a failed finish never calls the opener', failOpens.length, 0)
  expectEqual('a failed finish keeps the previous PDF', (await readFile(target)).equals(PDF), true)

  // 5. An opener failure is reported on the result and never fails the write.
  const brokenJobs = createPrintJobs()
  const brokenPrepared = await prepareExport({ path: source, sessionId: 's1' }, { jobs: brokenJobs })
  const broken = await outcome(() => finishExport(
    { finishToken: brokenPrepared.finishToken, pdfBytes: PDF },
    {
      jobs: brokenJobs,
      afterExport: 'system',
      open: async () => { throw new PdfError('open-failed', 'there is no launcher') },
    },
  ))
  expectEqual('an opener failure still returns a result', broken.value?.ok, true)
  expectEqual('an opener failure is reported separately', broken.value?.open?.ok, false)
  expectEqual('an opener failure keeps its code', broken.value?.open?.code, 'open-failed')
  expectTrue('an opener failure carries a message',
    typeof broken.value?.open?.message === 'string' && broken.value.open.message !== '')
  expectEqual('an opener failure still writes the PDF', (await readFile(target)).equals(PDF), true)

  const plainJobs = createPrintJobs()
  const plainPrepared = await prepareExport({ path: source, sessionId: 's1' }, { jobs: plainJobs })
  const plain = await outcome(() => finishExport(
    { finishToken: plainPrepared.finishToken, pdfBytes: PDF },
    { jobs: plainJobs, afterExport: 'system', open: async () => { throw new Error('spawn failed') } },
  ))
  expectEqual('an unexpected opener error is normalized', plain.value?.open?.code, 'open-failed')

  // 6. The token action refuses everything that is not a committed finish
  // secret: missing, blank, unknown, an asset token, or a job id.
  const actionJobs = createPrintJobs()
  const actionOpens = []
  const actionOptions = { jobs: actionJobs, open: async path => actionOpens.push(path) }
  for (const token of [undefined, null, '', '   ', 42, {}]) {
    const refused = await capture(() => openFinishedExport({ finishToken: token }, actionOptions))
    expectEqual(`the open action refuses ${JSON.stringify(token)}`, refused?.code, 'bad-request')
  }
  expectEqual('the open action refuses an absent body', (await capture(() => openFinishedExport())).code, 'bad-request')
  expectEqual('refused tokens never open', actionOpens.length, 0)

  const actionPrepared = await prepareExport({ path: source, sessionId: 's1' }, { jobs: actionJobs })
  const assetToken = /\/p\/([0-9a-f]{64})\/document\.html$/.exec(actionPrepared.printUrl)?.[1] ?? ''
  expectEqual('the print url carries an asset token', /^[0-9a-f]{64}$/.test(assetToken), true)
  expectEqual('the open action refuses an unknown token',
    (await capture(() => openFinishedExport({ finishToken: 'missing' }, actionOptions)))?.code, 'bad-request')
  expectEqual('the open action refuses the asset token',
    (await capture(() => openFinishedExport({ finishToken: assetToken }, actionOptions)))?.code, 'bad-request')
  expectEqual('the open action refuses the job id',
    (await capture(() => openFinishedExport({ finishToken: actionPrepared.jobId }, actionOptions)))?.code,
    'bad-request')

  const early = await capture(() => openFinishedExport(
    { finishToken: actionPrepared.finishToken }, actionOptions))
  expectEqual('the open action refuses an unfinished job', early?.code, 'state-conflict')
  expectEqual('an unfinished job never opens', actionOpens.length, 0)
  await finishExport({ finishToken: actionPrepared.finishToken, pdfBytes: PDF }, { jobs: actionJobs })

  const failingAction = await prepareExport({ path: source, sessionId: 's1' }, { jobs: actionJobs })
  await capture(() => finishExport(
    { finishToken: failingAction.finishToken, pdfBytes: Buffer.from('bad') }, { jobs: actionJobs }))
  const failedAction = await capture(() => openFinishedExport(
    { finishToken: failingAction.finishToken }, actionOptions))
  expectEqual('the open action refuses a failed job', failedAction?.code, 'state-conflict')
  expectEqual('a failed job never opens', actionOpens.length, 0)

  const toolAction = await prepareExport(
    { path: source, sessionId: 's1', owner: 'tool' },
    { jobs: actionJobs },
  )
  await finishExport({ finishToken: toolAction.finishToken, pdfBytes: PDF }, { jobs: actionJobs })
  const toolRefused = await capture(() => openFinishedExport(
    { finishToken: toolAction.finishToken }, actionOptions))
  expectEqual('the open action refuses a tool job', toolRefused?.code, 'bad-request')
  expectEqual('a tool job never opens through the fallback', actionOpens.length, 0)

  // 7. The committed target is the only target: extra client fields are
  // dropped before the action runs.
  const accepted = await outcome(() => openFinishedExport({
    finishToken: actionPrepared.finishToken,
    path: join(work, 'evil.pdf'),
    jobId: actionPrepared.jobId,
    url: 'https://example.com/evil.pdf',
  }, actionOptions))
  expectEqual('the open action accepts a committed token', accepted.value?.ok, true)
  expectEqual('the open action opens the Host target', actionOpens.at(-1), target)
  expectEqual('the open action opens once', actionOpens.length, 1)
  const actionOpenFailure = await capture(() => openFinishedExport(
    { finishToken: actionPrepared.finishToken },
    { jobs: actionJobs, open: async () => { throw new Error('no opener') } },
  ))
  expectEqual('the open action reports an opener failure', actionOpenFailure?.code, 'open-failed')

  // 8. The route runs the trust fence first, then accepts only the token.
  const fencedOpens = []
  const fenced = mountRoutes({ open: async path => fencedOpens.push(path) }, 403)
  const fencedAnswer = await callRoute(
    fenced,
    indexModule.OPEN_PATH,
    fakeRequest('POST', 'not json', 'text/plain'),
  )
  expectEqual('the open route asks the fence first', fencedAnswer.status, 403)
  expectEqual('a fenced request never opens', fencedOpens.length, 0)

  const routePrepared = await prepareExport({ path: source, sessionId: 's1' })
  await finishExport({ finishToken: routePrepared.finishToken, pdfBytes: PDF })

  const routeOpens = []
  const routes = mountRoutes({ open: async path => routeOpens.push(path) })
  expectEqual('the open route is registered', routes.has(indexModule.OPEN_PATH), true)
  const wrongType = await callRoute(
    routes, indexModule.OPEN_PATH, fakeRequest('POST', JSON.stringify({
      finishToken: routePrepared.finishToken,
    }), 'text/plain'))
  expectEqual('the open route requires JSON', wrongType.status, 415)
  expectEqual('a refused content type never opens', routeOpens.length, 0)

  const wrongMethod = await callRoute(routes, indexModule.OPEN_PATH, fakeRequest('GET', undefined, null))
  expectEqual('the open route is POST-only', wrongMethod.status, 405)

  for (const body of ['not json', '{}', '{"finishToken":""}', '{"finishToken":42}', '[]']) {
    const answer = await callRoute(routes, indexModule.OPEN_PATH, fakeRequest('POST', body))
    expectEqual(`the open route refuses ${body}`, answer.status, 400)
  }
  expectEqual('refused route bodies never open', routeOpens.length, 0)

  const unknownToken = await callRoute(routes, indexModule.OPEN_PATH, fakeRequest(
    'POST', JSON.stringify({ finishToken: 'missing' })))
  expectEqual('the open route refuses an unknown token', unknownToken.status, 400)
  const assetRoute = await callRoute(routes, indexModule.OPEN_PATH, fakeRequest(
    'POST', JSON.stringify({ finishToken: assetToken })))
  expectEqual('the open route refuses an asset token', assetRoute.status, 400)

  const routeAccepted = await callRoute(routes, indexModule.OPEN_PATH, fakeRequest(
    'POST',
    JSON.stringify({
      finishToken: routePrepared.finishToken,
      path: join(work, 'evil.pdf'),
      jobId: routePrepared.jobId,
      url: 'https://example.com/evil.pdf',
    }),
  ))
  expectEqual('the open route accepts the committed token', routeAccepted.status, 200)
  expectEqual('the open route answers ok', routeAccepted.payload?.ok, true)
  expectEqual('the open route opens the committed target', routeOpens[0], target)
  expectEqual('the open route ignores extra fields', routeOpens.length, 1)

  const openFailureRoutes = mountRoutes({
    open: async () => { throw new PdfError('open-failed', 'there is no launcher') },
  })
  const routeOpenFailure = await callRoute(openFailureRoutes, indexModule.OPEN_PATH, fakeRequest(
    'POST', JSON.stringify({ finishToken: routePrepared.finishToken })))
  expectEqual('the open route reports an opener failure', routeOpenFailure.status, 500)
  expectEqual('the open route names the failure code', routeOpenFailure.payload?.code, 'open-failed')
  expectEqual('the open route failure does not unset ok', routeOpenFailure.payload?.ok, false)

  const latePrepared = await prepareExport({ path: source, sessionId: 's1' })
  const lateAnswer = await callRoute(routes, indexModule.OPEN_PATH, fakeRequest(
    'POST', JSON.stringify({ finishToken: latePrepared.finishToken })))
  expectEqual('the open route refuses an unfinished job', lateAnswer.status, 409)
  expectEqual('an unfinished route job never opens', routeOpens.length, 1)
  await finishExport({ finishToken: latePrepared.finishToken, pdfBytes: PDF })

  const routeTool = await prepareExport({ path: source, sessionId: 's1', owner: 'tool' })
  await finishExport({ finishToken: routeTool.finishToken, pdfBytes: PDF })
  const routeToolAnswer = await callRoute(routes, indexModule.OPEN_PATH, fakeRequest(
    'POST', JSON.stringify({ finishToken: routeTool.finishToken })))
  expectEqual('the open route refuses a tool job', routeToolAnswer.status, 400)
  expectEqual('a tool job never opens through the route', routeOpens.length, 1)

  // 9. The client tries the DSH viewer first and asks the Host only when the
  // viewer or its address is unavailable. The function is run with stubs.
  const client = await readFile(join(here, '..', 'client.js'), 'utf8')
  expectTrue('the client defines the Host open route', client.includes("const OPEN_ROUTE = 'md2pdf/open'"))
  expectTrue('the client sends only the finish token',
    client.includes('JSON.stringify({ finishToken })'))
  expectTrue('the client awaits the preview decision',
    client.includes('await openPreview(outcome.result, outcome.finishToken)'))
  expectTrue('the client reports a system open failure', client.includes('toast.openFailed'))

  const previewSource = extractFunction(client, 'async function openPreview(')
  expectTrue('the client openPreview function is present', typeof previewSource === 'string')
  /**
   * Build one runnable copy of `openPreview` with stubbed dependencies.
   * @param mode - afterExport answer.
   * @param viewer - `ctx.sidebarRight` value.
   * @param fallback - `previewFallback` stub.
   * @returns the extracted function.
   */
  function previewFunction(mode, viewer, fallback) {
    return new Function(
      'afterExportOf',
      'capabilityValue',
      'ctx',
      't',
      'previewFallback',
      'console',
      `return (${previewSource})`,
    )(
      () => mode,
      {},
      viewer === undefined ? {} : { sidebarRight: viewer },
      key => key,
      fallback,
      { warn() {} },
    )
  }

  const viewerCalls = []
  let fallbackCalls = []
  const viewer = { openResource(address) { viewerCalls.push(address) } }
  const fallback = async (token, path) => {
    fallbackCalls.push([token, path])
    return 'fallback'
  }
  const working = previewFunction('dsh', viewer, fallback)
  const workingNote = await working(
    { pdfPath: '/w/a.pdf', previewAddress: 'dsh-resource://file/session/s1//w/a.pdf' }, 'token-1')
  expectEqual('a working viewer opens the Host address',
    viewerCalls[0], 'dsh-resource://file/session/s1//w/a.pdf')
  expectEqual('a working viewer appends no note', workingNote, null)
  expectEqual('a working viewer does not call the Host fallback', fallbackCalls.length, 0)

  for (const mode of ['system', 'none']) {
    viewerCalls.length = 0
    fallbackCalls = []
    const gated = previewFunction(mode, viewer, fallback)
    const note = await gated({ pdfPath: '/w/a.pdf', previewAddress: 'dsh-resource://x' }, 'token-2')
    expectEqual(`${mode} appends no DSH preview note`, note, null)
    expectEqual(`${mode} never opens the DSH viewer`, viewerCalls.length, 0)
    expectEqual(`${mode} never calls the Host fallback`, fallbackCalls.length, 0)
  }

  const unavailable = [
    ['a missing viewer', undefined, { pdfPath: '/w/a.pdf', previewAddress: 'dsh-resource://x' }],
    ['a viewer that refuses the address', { openResource() { throw new Error('refused') } },
      { pdfPath: '/w/a.pdf', previewAddress: 'dsh-resource://x' }],
    ['a missing address', viewer, { pdfPath: '/w/a.pdf' }],
  ]
  for (const [label, missingViewer, result] of unavailable) {
    fallbackCalls = []
    viewerCalls.length = 0
    const fn = previewFunction('dsh', missingViewer, fallback)
    const note = await fn(result, 'token-3')
    expectEqual(`${label} falls back to the Host`, note, 'fallback')
    expectEqual(`${label} sends the finish token`,
      JSON.stringify(fallbackCalls), JSON.stringify([['token-3', '/w/a.pdf']]))
  }

  fallbackCalls = []
  const refusedFallback = previewFunction('dsh', undefined, async () => 'unavailable')
  const unavailableNote = await refusedFallback({ pdfPath: '/w/a.pdf' }, 'token-4')
  expectEqual('a refused fallback reports the path note', unavailableNote, 'unavailable')

  const missingPreview = previewFunction('dsh', undefined, fallback)
  fallbackCalls = []
  const missingNote = await missingPreview({}, 'token-5')
  expectEqual('an empty preview result has no address to open', missingNote, 'fallback')
  expectEqual('the empty preview result still falls back', fallbackCalls.length, 1)
} finally {
  await rm(home, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  await rm(work, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
}

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`)
if (failures > 0) process.exitCode = 1
