/**
 * Checks for the agent print broker.
 *
 * The broker lets the `md2pdf_export` tool use a connected DSH Desktop client's
 * own printer. These checks pin the four pieces that make that safe:
 *
 *   - the job store claims only tool jobs, one at a time, oldest first;
 *   - presence is a 10 s window that a long poll keeps alive with a heartbeat;
 *   - the tool engine policy and its narrow fallback list;
 *   - the long-poll route and the fail route, including what they never expose.
 *
 * The tool checks run the real `prepareExport` / `finishExport` pair against a
 * temporary copy of `samples/sample.md`. When a browser fallback is expected,
 * the checks inject a fake browser printer, so no Chromium process is started.
 *
 * Run: node scripts/broker-check.mjs
 */
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
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
 * Assert two JSON values are structurally equal.
 * @param label - what the check proves.
 * @param actual - produced value.
 * @param expected - required value.
 */
function expectJson(label, actual, expected) {
  expectEqual(label, JSON.stringify(actual), JSON.stringify(expected))
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
 * Start one tool call and settle it separately, so a rejection observed later
 * is never reported as an unhandled rejection.
 * @param run - the call under test.
 * @returns the settled-value promise.
 */
function settle(run) {
  return Promise.resolve()
    .then(run)
    .then(value => ({ value }), error => ({ error }))
}

/**
 * Sleep for a bounded time.
 * @param ms - milliseconds.
 * @returns a promise that resolves after the delay.
 */
function sleep(ms) {
  return new Promise(resolveSleep => { setTimeout(resolveSleep, ms) })
}

/**
 * Wait until a predicate holds or a deadline passes.
 * @param predicate - condition to poll.
 * @param timeoutMs - longest wait.
 * @returns whether the predicate became true.
 */
async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(10)
  }
  return predicate()
}

const here = dirname(fileURLToPath(import.meta.url))
const home = await mkdtemp(join(tmpdir(), 'dsh-md2pdf-broker-home-'))
const work = await mkdtemp(join(tmpdir(), 'dsh-md2pdf-broker-work-'))
process.env['MD2PDF_HOME'] = home

/** A payload every finish accepts. */
const PDF = Buffer.from('%PDF-1.4\n%%EOF\n', 'latin1')

const {
  chooseToolEngine, exportTool, failPrintJob, finishExport, prepareExport, TOOL_PRESENCE_WAIT_MS,
} = await import('../src/export.js')
const { CLIENT_FAILURE_REASONS, createPrintJobs } = await import('../src/print-jobs.js')
const indexModule = await import('../index.js')

const {
  CAPABILITY_PATH, EXPORT_PATH, FAIL_JOB_PATH, FINISH_PATH, NEXT_JOB_PATH, PREPARE_PATH,
  PRESETS_PATH, PREVIEWS_PATH, SETTINGS_PATH, TEST_PRINT_PATH, brokerWaitSeconds,
} = indexModule

/**
 * Build one fake response with close-listener support.
 * @returns the response object.
 */
function fakeResponse() {
  const listeners = new Map()
  return {
    statusCode: 0,
    headers: {},
    body: '',
    ended: false,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value },
    end(body = '') { this.body = body; this.ended = true },
    once(name, listener) {
      const list = listeners.get(name) ?? []
      list.push(listener)
      listeners.set(name, list)
      return this
    },
    off(name, listener) {
      const list = listeners.get(name)
      if (list !== undefined) {
        const index = list.indexOf(listener)
        if (index >= 0) list.splice(index, 1)
      }
      return this
    },
    emit(name) {
      for (const listener of [...(listeners.get(name) ?? [])]) listener()
    },
  }
}

/**
 * Build one fake request.
 * @param method - HTTP method.
 * @param url - request URL.
 * @param body - text body, or undefined.
 * @param headers - request headers.
 * @returns the request object.
 */
function fakeRequest(method, url, body, headers = {}) {
  return {
    method,
    url,
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
 * @returns the status, parsed payload, and the response.
 */
async function callRoute(routes, path, req) {
  const res = fakeResponse()
  const handler = routes.get(path)
  if (handler === undefined) return { status: 0, payload: null, res }
  await handler(req, res)
  return {
    status: res.statusCode,
    payload: res.body === '' ? null : JSON.parse(res.body),
    res,
  }
}

/**
 * Mount the Host routes on a fake context, the form the checks use.
 * @param config - row configuration, including the injected job store.
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
 * Wrap one store so the checks can inspect the jobs the exporter created.
 * @param options - store options.
 * @returns the wrapped store and the created jobs.
 */
function trackJobs(options = {}) {
  const store = createPrintJobs(options)
  const created = []
  const jobs = {
    ...store,
    create(input) {
      const job = store.create(input)
      created.push(job)
      return job
    },
  }
  return { jobs, created }
}

/**
 * Build one job input for the pure store checks.
 * @param name - source and target stem.
 * @param owner - `ui` or `tool`.
 * @returns the job input.
 */
function jobInput(name, owner) {
  return {
    sessionId: 'session-1',
    sourcePath: `/work/${name}.md`,
    targetPath: `/work/${name}.pdf`,
    html: `<h1>${name}</h1>`,
    assetRoot: '/work',
    printOptions: { printBackground: true },
    owner,
  }
}

/**
 * Build a fake browser printer that writes one complete PDF.
 * @param calls - array that records each run.
 * @returns the printer function.
 */
function fakeBrowserPrinter(calls) {
  return async (htmlPath, staging) => {
    calls.push({ htmlPath, staging })
    await writeFile(staging, PDF)
    return { printer: 'fake-browser' }
  }
}

try {
  await copyFile(join(here, '..', 'samples', 'sample.md'), join(work, 'sample.md'))
  const source = join(work, 'sample.md')
  const target = join(work, 'sample.pdf')

  // 1. Store: the tool queue claims only tool jobs, oldest first, one at a time.
  let clock = 1_000_000
  const store = createPrintJobs({ now: () => clock })
  const uiFirst = store.create(jobInput('ui-first', 'ui'))
  clock += 1
  const toolFirst = store.create(jobInput('tool-first', 'tool'))
  clock += 1
  const toolSecond = store.create(jobInput('tool-second', 'tool'))

  expectEqual('a new tool job is not ready', toolFirst.ready, false)
  expectEqual('an unready tool job is not claimable', store.claimToolJob(), null)
  let unknownReady = null
  try {
    store.markReady('missing-token')
  } catch (error) {
    unknownReady = error
  }
  expectEqual('markReady refuses an unknown job', unknownReady?.code, 'bad-request')
  store.markReady(toolFirst.id)
  store.markReady(toolSecond.id)
  expectEqual('markReady makes the tool job ready', toolFirst.ready, true)

  expectTrue('claimToolJob takes the oldest prepared tool job', store.claimToolJob() === toolFirst)
  expectEqual('a claimed tool job records the state', toolFirst.state, 'claimed')
  expectTrue('a claimed tool job records when it was claimed', typeof toolFirst.claimedAt === 'number')
  expectEqual('a second active tool job is refused', store.claimToolJob(), null)
  expectEqual('a UI job stays prepared while a tool job is active', uiFirst.state, 'prepared')
  expectTrue('claimNext keeps its original FIFO order for UI', store.claimNext() === uiFirst)
  expectEqual('claimNext claimed the UI job', uiFirst.state, 'claimed')

  store.finish(toolFirst.finishToken, PDF)
  expectTrue('the next tool job is claimable after the first finishes',
    store.claimToolJob() === toolSecond)
  expectEqual('a finished tool job is never claimed again', store.claimToolJob(), null)
  store.markPrinting(toolSecond.finishToken)
  clock += 1
  const toolThird = store.create(jobInput('tool-third', 'tool'))
  store.markReady(toolThird.id)
  expectEqual('a printing tool job also blocks the next claim', store.claimToolJob(), null)
  store.finish(toolSecond.finishToken, PDF)
  expectTrue('the blocked job is claimable once the printing job finishes',
    store.claimToolJob() === toolThird)
  store.finish(toolThird.finishToken, PDF)
  expectEqual('an empty tool queue returns null', store.claimToolJob(), null)

  const uiOnly = createPrintJobs({ now: () => clock })
  const lonelyUi = uiOnly.create(jobInput('lonely', 'ui'))
  expectEqual('claimToolJob never claims a UI job', uiOnly.claimToolJob(), null)
  expectEqual('the UI job stays prepared', lonelyUi.state, 'prepared')
  expectTrue('claimNext still claims that UI job', uiOnly.claimNext() === lonelyUi)

  const expiredStore = createPrintJobs({ now: () => clock })
  const late = expiredStore.create(jobInput('late', 'tool'))
  expiredStore.markReady(late.id)
  clock += 120_001
  expectEqual('claimToolJob expires overdue work before claiming', expiredStore.claimToolJob(), null)
  expectEqual('the overdue tool job is expired', late.state, 'expired')

  const failedStore = createPrintJobs({ now: () => clock })
  const failedTool = failedStore.create(jobInput('failed', 'tool'))
  failedStore.markReady(failedTool.id)
  failedStore.fail(failedTool.id, 'client-error')
  expectEqual('claimToolJob skips a failed tool job', failedStore.claimToolJob(), null)
  const finishedStore = createPrintJobs({ now: () => clock })
  const finishedTool = finishedStore.create(jobInput('finished', 'tool'))
  finishedStore.markReady(finishedTool.id)
  finishedStore.finish(finishedTool.finishToken, PDF)
  expectEqual('claimToolJob skips a finished tool job', finishedStore.claimToolJob(), null)

  const mixedStore = createPrintJobs({ now: () => clock })
  const uiBusy = mixedStore.create(jobInput('ui-busy', 'ui'))
  mixedStore.claimNext()
  mixedStore.markPrinting(uiBusy.finishToken)
  const toolAfterUi = mixedStore.create(jobInput('tool-after-ui', 'tool'))
  mixedStore.markReady(toolAfterUi.id)
  expectTrue('an active UI job never blocks a tool claim',
    mixedStore.claimToolJob() === toolAfterUi)

  // 2. Presence: one window, one key per client, pruned on record.
  let presenceClock = 2_000_000
  const presenceStore = createPrintJobs({ now: () => presenceClock })
  presenceStore.presence.record('client-a')
  expectTrue('a recorded client is present', presenceStore.presence.isPresent())
  expectTrue('the client is present just inside 10 s', presenceStore.presence.isPresent(presenceClock + 9_999))
  expectEqual('the client is absent at 10 s', presenceStore.presence.isPresent(presenceClock + 10_000), false)
  expectEqual('the presence map holds one entry per key', presenceStore.presence.size(), 1)
  presenceStore.presence.record('client-a')
  expectEqual('recording the same key keeps one entry', presenceStore.presence.size(), 1)

  presenceClock += 1
  presenceStore.presence.record('client-b')
  expectEqual('two live clients get two entries', presenceStore.presence.size(), 2)
  presenceClock += 10_000
  presenceStore.presence.record('client-c')
  expectEqual('a new record prunes stale clients', presenceStore.presence.size(), 1)
  expectTrue('the fresh client is present', presenceStore.presence.isPresent())
  presenceClock += 10_000
  expectEqual('prune reports and removes the stale entry', presenceStore.presence.prune(), 1)
  expectEqual('the presence map is empty after prune', presenceStore.presence.size(), 0)
  expectEqual('a pruned client is absent', presenceStore.presence.isPresent(), false)

  const activePresence = createPrintJobs({ now: () => presenceClock })
  const activeJob = activePresence.create(jobInput('active', 'tool'))
  activePresence.markReady(activeJob.id)
  activePresence.claimToolJob()
  presenceClock += 60_000
  expectTrue('a claimed tool job counts as a present client', activePresence.presence.isPresent())
  activePresence.markPrinting(activeJob.finishToken)
  expectTrue('a printing tool job counts as a present client', activePresence.presence.isPresent())
  activePresence.finish(activeJob.finishToken, PDF)
  expectEqual('a finished tool job stops counting as presence', activePresence.presence.isPresent(), false)

  const failedPresence = createPrintJobs({ now: () => presenceClock })
  const failedActive = failedPresence.create(jobInput('failed-active', 'tool'))
  failedPresence.markReady(failedActive.id)
  failedPresence.claimToolJob()
  failedPresence.fail(failedActive.id, 'client-error')
  expectEqual('a failed tool job stops counting as presence', failedPresence.presence.isPresent(), false)

  const closedPresence = createPrintJobs({ now: () => presenceClock })
  closedPresence.presence.record('client-a')
  await closedPresence.close()
  expectEqual('close clears presence', closedPresence.presence.isPresent(), false)

  // 3. Engine policy: a table, not a guess.
  const policy = [
    [{ printEngine: 'browser', clientPresent: false, browserAvailable: false }, 'browser'],
    [{ printEngine: 'browser', clientPresent: true, browserAvailable: true }, 'browser'],
    [{ printEngine: 'dsh', clientPresent: true, browserAvailable: false }, 'dsh'],
    [{ printEngine: 'dsh', clientPresent: false, browserAvailable: true }, 'client-required'],
    [{ printEngine: 'dsh', clientPresent: false, browserAvailable: false }, 'client-required'],
    [{ printEngine: 'auto', clientPresent: true, browserAvailable: true }, 'dsh'],
    [{ printEngine: 'auto', clientPresent: true, browserAvailable: false }, 'dsh'],
    [{ printEngine: 'auto', clientPresent: false, browserAvailable: true }, 'browser'],
    [{ printEngine: 'auto', clientPresent: false, browserAvailable: false }, 'no-printer'],
    [{ printEngine: 'unknown', clientPresent: false, browserAvailable: false }, 'no-printer'],
  ]
  for (const [input, expected] of policy) {
    expectEqual(`policy ${input.printEngine}/${input.clientPresent}/${input.browserAvailable}`,
      chooseToolEngine(input), expected)
  }

  expectEqual('the broker presence wait defaults to 10 s', TOOL_PRESENCE_WAIT_MS, 10_000)

  // Browser mode does not wait for a client.
  const browserWaitStarted = Date.now()
  const browserNoWait = await exportTool({ path: source }, {
    printEngine: 'browser',
    presenceWaitMs: 5000,
    browserAvailable: true,
    printBrowser: fakeBrowserPrinter([]),
  })
  expectEqual('browser mode ignores the presence wait', browserNoWait.engine, 'browser')
  expectTrue('browser mode returns before the presence window',
    Date.now() - browserWaitStarted < 1000)

  // A client that appears after the call starts is used.
  const latePresence = trackJobs()
  const latePresenceRoutes = mountRoutes({ jobs: latePresence.jobs })
  const latePresenceCalls = []
  const latePresenceSettled = settle(() => exportTool({ path: source }, {
    jobs: latePresence.jobs,
    printEngine: 'auto',
    browserAvailable: true,
    printBrowser: fakeBrowserPrinter(latePresenceCalls),
    presenceWaitMs: 600,
  }))
  await sleep(80)
  latePresence.jobs.presence.record('late-client')
  expectTrue('a late client moves the tool to the broker',
    await waitFor(() => latePresence.created.length === 1, 1000))
  const latePoll = await callRoute(latePresenceRoutes, NEXT_JOB_PATH,
    fakeRequest('GET', `${NEXT_JOB_PATH}?wait=2`))
  await finishExport({ finishToken: latePoll.payload.finishToken, pdfBytes: PDF }, { jobs: latePresence.jobs })
  const lateOutcome = await latePresenceSettled
  expectEqual('the late-client tool reports dsh', lateOutcome.value?.engine, 'dsh')
  expectEqual('the late client never starts the browser', latePresenceCalls.length, 0)

  // The presence wait is bounded, then auto falls back to the browser.
  const noClientAutoRun = trackJobs()
  const autoWaitStarted = Date.now()
  const autoWaited = await exportTool({ path: source }, {
    jobs: noClientAutoRun.jobs,
    printEngine: 'auto',
    browserAvailable: true,
    printBrowser: fakeBrowserPrinter([]),
    presenceWaitMs: 180,
  })
  expectEqual('auto uses the browser after the presence wait', autoWaited.engine, 'browser')
  expectTrue('auto spends the presence window before falling back', Date.now() - autoWaitStarted >= 160)
  expectEqual('the empty presence wait creates no broker job', noClientAutoRun.jobs.claimToolJob(), null)

  const noClientDshRun = trackJobs()
  const dshWaitStarted = Date.now()
  const dshWaited = await capture(() => exportTool({ path: source }, {
    jobs: noClientDshRun.jobs,
    printEngine: 'dsh',
    presenceWaitMs: 160,
  }))
  expectEqual('dsh reports client-required after the presence wait', dshWaited?.code, 'client-required')
  expectTrue('dsh spends the presence window before refusing', Date.now() - dshWaitStarted >= 140)

  // Abort during the wait is observed.
  const abortWaitRun = trackJobs()
  const abortWaitController = new AbortController()
  const abortWaitStarted = Date.now()
  const abortWaitSettled = settle(() => exportTool({ path: source }, {
    jobs: abortWaitRun.jobs,
    printEngine: 'auto',
    browserAvailable: true,
    presenceWaitMs: 5000,
    signal: abortWaitController.signal,
    printBrowser: fakeBrowserPrinter([]),
  }))
  await sleep(50)
  abortWaitController.abort()
  const abortWaitOutcome = await abortWaitSettled
  expectEqual('aborting the presence wait rejects with AbortError', abortWaitOutcome.error?.name, 'AbortError')
  expectTrue('aborting the presence wait returns promptly', Date.now() - abortWaitStarted < 1000)
  expectEqual('aborting the presence wait creates no job', abortWaitRun.jobs.claimToolJob(), null)

  // 4. Tool execution: browser, client-required, no-printer, broker.
  const browserCalls = []
  const browserResult = await exportTool({ path: source }, {
    printEngine: 'browser',
    browserAvailable: true,
    printBrowser: fakeBrowserPrinter(browserCalls),
  })
  expectEqual('a browser-configured tool exports with the browser', browserResult.engine, 'browser')
  expectEqual('a browser tool result is exactly the tool shape',
    Object.keys(browserResult).sort().join(','),
    'bytes,durationMs,engine,generator,ok,pdfPath,sourcePath')

  const noClientJobs = createPrintJobs()
  const clientRequired = await capture(() => exportTool({ path: source }, {
    jobs: noClientJobs,
    printEngine: 'dsh',
    browserAvailable: true,
    presenceWaitMs: 0,
  }))
  expectEqual('dsh without a client reports client-required', clientRequired?.code, 'client-required')
  expectEqual('dsh without a client creates no print job', noClientJobs.claimToolJob(), null)

  const autoBrowserCalls = []
  const autoBrowserJobs = createPrintJobs()
  const autoBrowser = await exportTool({ path: source }, {
    jobs: autoBrowserJobs,
    printEngine: 'auto',
    browserAvailable: true,
    printBrowser: fakeBrowserPrinter(autoBrowserCalls),
    presenceWaitMs: 0,
  })
  expectEqual('auto without a client falls back to the browser', autoBrowser.engine, 'browser')
  expectEqual('auto without a client creates no broker job', autoBrowserJobs.claimToolJob(), null)
  expectEqual('the browser fallback ran once', autoBrowserCalls.length, 1)

  const noPrinterCalls = []
  const noPrinter = await capture(() => exportTool({ path: source }, {
    jobs: createPrintJobs(),
    printEngine: 'auto',
    browserAvailable: false,
    printBrowser: fakeBrowserPrinter(noPrinterCalls),
    presenceWaitMs: 0,
  }))
  expectEqual('auto without a client or browser reports no-printer', noPrinter?.code, 'no-printer')
  expectEqual('no-printer never starts the browser', noPrinterCalls.length, 0)

  const assetServerJobs = createPrintJobs()
  assetServerJobs.presence.record('client-a')
  const assetServerCalls = []
  const assetServer = await exportTool({ path: source }, {
    jobs: assetServerJobs,
    printEngine: 'auto',
    browserAvailable: true,
    printBrowser: fakeBrowserPrinter(assetServerCalls),
    startPrintServer: async () => { throw new Error('no loopback port') },
  })
  expectEqual('asset-server-failed falls back to the browser in auto', assetServer.engine, 'browser')
  expectEqual('the asset-server fallback starts the browser', assetServerCalls.length, 1)

  const assetServerDshJobs = createPrintJobs()
  assetServerDshJobs.presence.record('client-a')
  const assetServerDsh = await capture(() => exportTool({ path: source }, {
    jobs: assetServerDshJobs,
    printEngine: 'dsh',
    startPrintServer: async () => { throw new Error('no loopback port') },
  }))
  expectEqual('dsh mode never falls back after asset-server-failed',
    assetServerDsh?.code, 'asset-server-failed')

  // The broker path: the tool creates a tool-owned job, a client polls the
  // route, fetches the print page, and returns PDF bytes through finish.
  const broker = trackJobs()
  const brokerRoutes = mountRoutes({ jobs: broker.jobs, browserAvailable: false })
  broker.jobs.presence.record('client-a')
  const finishCalls = []
  const finishPrintBrowser = fakeBrowserPrinter(finishCalls)
  const brokerSettled = settle(() => exportTool({ path: source, sessionId: 's1' }, {
    jobs: broker.jobs,
    printEngine: 'auto',
    browserAvailable: true,
    printBrowser: finishPrintBrowser,
  }))
  const brokerPoll = await callRoute(brokerRoutes, NEXT_JOB_PATH,
    fakeRequest('GET', `${NEXT_JOB_PATH}?wait=2`))
  expectEqual('the broker route answers a waiting tool job', brokerPoll.status, 200)
  expectEqual('the broker route claimed the tool job', broker.created[0]?.state, 'claimed')
  const printPage = await fetch(brokerPoll.payload.printUrl)
  expectEqual('the print url serves the document', printPage.status, 200)
  const finished = await finishExport({
    finishToken: brokerPoll.payload.finishToken,
    pdfBytes: PDF,
  }, { jobs: broker.jobs })
  expectEqual('finish returns the DSH engine', finished.engine, 'dsh')
  const brokerReplay = await finishExport({
    finishToken: brokerPoll.payload.finishToken,
    pdfBytes: PDF,
  }, { jobs: broker.jobs })
  expectEqual('finish is idempotent for the brokered job', brokerReplay, finished)
  const brokerOutcome = await brokerSettled
  expectEqual('the tool returns success', brokerOutcome.value?.ok, true)
  expectEqual('the tool reports the DSH engine', brokerOutcome.value?.engine, 'dsh')
  expectEqual('the tool result has no preview address', Object.hasOwn(brokerOutcome.value ?? {}, 'previewAddress'), false)
  expectEqual('the tool result has no open record', Object.hasOwn(brokerOutcome.value ?? {}, 'open'), false)
  expectEqual('the tool result hides the print url', Object.hasOwn(brokerOutcome.value ?? {}, 'printUrl'), false)
  expectEqual('the tool result hides the finish token', Object.hasOwn(brokerOutcome.value ?? {}, 'finishToken'), false)
  expectEqual('the tool result hides the job id', Object.hasOwn(brokerOutcome.value ?? {}, 'jobId'), false)
  expectEqual('a successful broker finish never falls back to the browser', finishCalls.length, 0)
  expectEqual('the tool target stays beside the source', brokerOutcome.value?.pdfPath, target)
  const printPageAfter = await fetch(brokerPoll.payload.printUrl).catch(() => null)
  expectTrue('finish closes the print server', printPageAfter === null)

  // A tool job is created before its loopback server has an address. The broker
  // must not hand it out until the print URL exists; otherwise the client would
  // receive a payload without printUrl and leave the job claimed until timeout.
  const readyRun = trackJobs({ timeoutMs: 500 })
  const readyRoutes = mountRoutes({ jobs: readyRun.jobs })
  readyRun.jobs.presence.record('client-a')
  let releaseServer = null
  const serverGate = new Promise(resolveGate => { releaseServer = resolveGate })
  const readySettled = settle(() => exportTool({ path: source }, {
    jobs: readyRun.jobs,
    printEngine: 'dsh',
    presenceWaitMs: 0,
    startPrintServer: async ({ assetToken }) => {
      await serverGate
      return {
        url: `http://127.0.0.1:9/p/${assetToken}/`,
        close: async () => {},
      }
    },
  }))
  expectTrue('the delayed-server job is created before its server',
    await waitFor(() => readyRun.created.length === 1, 1000))
  expectEqual('a new tool job starts unready', readyRun.created[0].ready, false)
  const unreadyPoll = await callRoute(readyRoutes, NEXT_JOB_PATH,
    fakeRequest('GET', `${NEXT_JOB_PATH}?wait=0`))
  expectEqual('an unready tool job is never claimed', unreadyPoll.status, 204)
  expectEqual('an unready tool job stays prepared', readyRun.created[0].state, 'prepared')
  releaseServer()
  expectTrue('the job becomes ready after the server starts',
    await waitFor(() => readyRun.created[0].ready === true, 1000))
  expectTrue('the ready job has a print url', typeof readyRun.created[0].printUrl === 'string')
  const readyPoll = await callRoute(readyRoutes, NEXT_JOB_PATH,
    fakeRequest('GET', `${NEXT_JOB_PATH}?wait=0`))
  expectEqual('the ready tool job is claimable', readyPoll.status, 200)
  expectEqual('the ready payload carries the print url',
    typeof readyPoll.payload?.printUrl, 'string')
  await failPrintJob({ finishToken: readyPoll.payload.finishToken, reason: 'print-failed' },
    { jobs: readyRun.jobs })
  const readyOutcome = await readySettled
  expectEqual('the delayed-server job fails through the broker', readyOutcome.error?.code, 'print-failed')

  // A failed client print: dsh mode reports the failure; auto may fall back
  // only for the allowlisted reasons.
  const failClasses = [
    ['print-failed', true],
    ['client-required', true],
    ['no-printer', true],
    ['asset-server-failed', true],
    ['file-busy', false],
    ['pdf-invalid', false],
  ]
  for (const [reason, fallsBack] of failClasses) {
    const run = trackJobs()
    const routes = mountRoutes({ jobs: run.jobs, browserAvailable: true })
    run.jobs.presence.record('client-a')
    const calls = []
    const settled = settle(() => exportTool({ path: source }, {
      jobs: run.jobs,
      printEngine: 'auto',
      browserAvailable: true,
      printBrowser: fakeBrowserPrinter(calls),
    }))
    const poll = await callRoute(routes, NEXT_JOB_PATH,
      fakeRequest('GET', `${NEXT_JOB_PATH}?wait=2`))
    await failPrintJob({ finishToken: poll.payload.finishToken, reason }, { jobs: run.jobs })
    const outcome = await settled
    expectEqual(`failure ${reason} uses the browser fallback`, calls.length, fallsBack ? 1 : 0)
    if (fallsBack) {
      expectEqual(`failure ${reason} returns a browser result`, outcome.value?.engine, 'browser')
    } else {
      expectEqual(`failure ${reason} keeps its error code`, outcome.error?.code, reason)
    }
  }

  const dshFail = trackJobs()
  const dshFailRoutes = mountRoutes({ jobs: dshFail.jobs, browserAvailable: true })
  dshFail.jobs.presence.record('client-a')
  const dshFailSettled = settle(() => exportTool({ path: source }, {
    jobs: dshFail.jobs,
    printEngine: 'dsh',
    browserAvailable: true,
    printBrowser: fakeBrowserPrinter([]),
  }))
  const dshFailPoll = await callRoute(dshFailRoutes, NEXT_JOB_PATH,
    fakeRequest('GET', `${NEXT_JOB_PATH}?wait=2`))
  await failPrintJob({ finishToken: dshFailPoll.payload.finishToken, reason: 'print-failed' }, { jobs: dshFail.jobs })
  expectEqual('dsh mode never falls back after a client failure',
    (await dshFailSettled).error?.code, 'print-failed')

  // An unclaimed timeout: dsh reports job-timeout; auto falls back. The old PDF
  // survives, no staging file remains, and the print server is closed.
  await writeFile(target, PDF)
  const timeoutRun = trackJobs({ timeoutMs: 120 })
  timeoutRun.jobs.presence.record('client-a')
  const timeoutSettled = settle(() => exportTool({ path: source }, {
    jobs: timeoutRun.jobs,
    printEngine: 'dsh',
    browserAvailable: true,
  }))
  const timeoutOutcome = await timeoutSettled
  expectEqual('an unclaimed dsh job reports job-timeout', timeoutOutcome.error?.code, 'job-timeout')
  expectEqual('the timed-out job expired', timeoutRun.created[0]?.state, 'expired')
  expectTrue('the timeout keeps the old PDF', (await readFile(target)).equals(PDF))
  const stagedAfterTimeout = (await readdir(work)).filter(name => name.startsWith('.md2pdf-'))
  expectEqual('the timeout leaves no staging file', stagedAfterTimeout.length, 0)
  const timedOutPage = await fetch(timeoutRun.created[0].printUrl).catch(() => null)
  expectTrue('the timeout closes the print server', timedOutPage === null)

  const autoTimeoutRun = trackJobs({ timeoutMs: 120 })
  autoTimeoutRun.jobs.presence.record('client-a')
  const autoTimeoutCalls = []
  const autoTimeout = await exportTool({ path: source }, {
    jobs: autoTimeoutRun.jobs,
    printEngine: 'auto',
    browserAvailable: true,
    printBrowser: fakeBrowserPrinter(autoTimeoutCalls),
  })
  expectEqual('an unclaimed auto timeout falls back to the browser', autoTimeout.engine, 'browser')
  expectEqual('the unclaimed job is expired', autoTimeoutRun.created[0]?.state, 'expired')

  const claimedTimeoutRun = trackJobs({ timeoutMs: 120 })
  const claimedTimeoutRoutes = mountRoutes({ jobs: claimedTimeoutRun.jobs })
  claimedTimeoutRun.jobs.presence.record('client-a')
  const claimedTimeoutCalls = []
  const claimedTimeoutSettled = settle(() => exportTool({ path: source }, {
    jobs: claimedTimeoutRun.jobs,
    printEngine: 'auto',
    browserAvailable: true,
    printBrowser: fakeBrowserPrinter(claimedTimeoutCalls),
  }))
  const claimedPoll = await callRoute(claimedTimeoutRoutes, NEXT_JOB_PATH,
    fakeRequest('GET', `${NEXT_JOB_PATH}?wait=2`))
  expectEqual('the claimed timeout test claimed its job', claimedPoll.status, 200)
  const claimedOutcome = await claimedTimeoutSettled
  expectEqual('a claimed timeout reports job-timeout', claimedOutcome.error?.code, 'job-timeout')
  expectEqual('a claimed timeout never falls back to the browser', claimedTimeoutCalls.length, 0)
  expectEqual('the claimed job expired', claimedTimeoutRun.created[0]?.state, 'expired')

  const abortRun = trackJobs()
  const abortRoutes = mountRoutes({ jobs: abortRun.jobs })
  abortRun.jobs.presence.record('client-a')
  const abortController = new AbortController()
  const abortCalls = []
  const abortSettled = settle(() => exportTool({ path: source }, {
    jobs: abortRun.jobs,
    printEngine: 'auto',
    browserAvailable: true,
    printBrowser: fakeBrowserPrinter(abortCalls),
    signal: abortController.signal,
  }))
  const abortPoll = await callRoute(abortRoutes, NEXT_JOB_PATH,
    fakeRequest('GET', `${NEXT_JOB_PATH}?wait=2`))
  abortController.abort()
  const abortOutcome = await abortSettled
  expectEqual('an aborted tool call rejects with AbortError', abortOutcome.error?.name, 'AbortError')
  expectEqual('an aborted job is failed', abortRun.created[0]?.state, 'failed')
  expectEqual('an aborted tool call never falls back', abortCalls.length, 0)
  const abortedPage = await fetch(abortRun.created[0].printUrl).catch(() => null)
  expectTrue('an abort closes the print server', abortedPage === null)
  expectEqual('an abort leaves no staging file',
    (await readdir(work)).filter(name => name.startsWith('.md2pdf-')).length, 0)
  expectEqual('the abort poll claimed the job', abortPoll.status, 200)

  // 5. The long-poll route.
  expectEqual('wait is 20 s by default', brokerWaitSeconds(undefined), 20)
  expectEqual('an empty wait is 20 s', brokerWaitSeconds(''), 20)
  expectEqual('a non-numeric wait is 20 s', brokerWaitSeconds('soon'), 20)
  expectEqual('wait 0 is accepted', brokerWaitSeconds('0'), 0)
  expectEqual('a negative wait clamps to 0', brokerWaitSeconds('-4'), 0)
  expectEqual('wait maxes out at 30 s', brokerWaitSeconds('31'), 30)
  expectEqual('a fractional wait survives', brokerWaitSeconds('2.5'), 2.5)

  const routeRun = trackJobs()
  const route = mountRoutes({ jobs: routeRun.jobs })
  const noJob = await callRoute(route, NEXT_JOB_PATH,
    fakeRequest('GET', `${NEXT_JOB_PATH}?wait=0`))
  expectEqual('wait=0 answers 204 when no job is queued', noJob.status, 204)
  expectEqual('the 204 answer is never cached', noJob.res.headers['cache-control'], 'no-store')

  const wrongMethod = await callRoute(route, NEXT_JOB_PATH,
    fakeRequest('POST', NEXT_JOB_PATH, '{}', { 'content-type': 'application/json' }))
  expectEqual('the broker route is GET-only', wrongMethod.status, 405)
  expectEqual('the 405 answer names the allowed method', wrongMethod.res.headers.allow, 'GET')

  const fenceRun = trackJobs()
  const beforeFence = await prepareExport({ path: source, owner: 'tool' }, { jobs: fenceRun.jobs })
  const fenced = mountRoutes({ jobs: fenceRun.jobs }, 403)
  const fencedGet = await callRoute(fenced, NEXT_JOB_PATH,
    fakeRequest('GET', `${NEXT_JOB_PATH}?wait=1`))
  expectEqual('the trust fence answers first', fencedGet.status, 403)
  const fencedPost = await callRoute(fenced, NEXT_JOB_PATH,
    fakeRequest('POST', NEXT_JOB_PATH, '{}', { 'content-type': 'application/json' }))
  expectEqual('the fence precedes the method check', fencedPost.status, 403)
  expectEqual('a fenced poll claims nothing', fenceRun.created[0].state, 'prepared')
  await failPrintJob({ finishToken: beforeFence.finishToken, reason: 'client-error' }, { jobs: fenceRun.jobs })

  const payloadRun = trackJobs()
  const payloadRoutes = mountRoutes({ jobs: payloadRun.jobs })
  const payloadSource = join(work, 'payload.md')
  const payloadTarget = join(work, 'payload.pdf')
  await writeFile(payloadSource, '# Payload\n\nA clean document.\n')
  const payloadPrepared = await prepareExport({
    path: payloadSource,
    sessionId: 's 1',
    owner: 'tool',
    targetPath: '/tmp/not-the-target.pdf',
  }, { jobs: payloadRun.jobs })
  const payload = await callRoute(payloadRoutes, NEXT_JOB_PATH,
    fakeRequest('GET', `${NEXT_JOB_PATH}?wait=0&targetPath=/tmp/evil&url=https://evil.example`))
  expectEqual('a queued tool job answers 200', payload.status, 200)
  const payloadKeys = Object.keys(payload.payload).sort()
  expectJson('the payload carries only the client fields',
    payloadKeys, ['finishToken', 'jobId', 'printOptions', 'printUrl', 'sessionId'])
  expectEqual('the payload names the created job', payload.payload.jobId, payloadRun.created[0].id)
  expectEqual('the payload carries the finish token', payload.payload.finishToken, payloadRun.created[0].finishToken)
  expectEqual('the finish token is not the asset token', payload.payload.finishToken !== payloadRun.created[0].assetToken, true)
  expectEqual('the print url is the job asset server', payload.payload.printUrl,
    `http://127.0.0.1:${new URL(payload.payload.printUrl).port}/p/${payloadRun.created[0].assetToken}/document.html`)
  expectEqual('the payload carries the print options',
    payload.payload.printOptions.printBackground, true)
  expectEqual('the payload carries the session id', payload.payload.sessionId, 's 1')
  for (const forbidden of ['sourcePath', 'targetPath', 'assetRoot', 'assetToken', 'html', 'owner', 'state', 'deadline', 'failure', 'result']) {
    expectEqual(`the payload never exposes ${forbidden}`,
      Object.hasOwn(payload.payload, forbidden), false)
  }
  expectEqual('the target stays Host-computed', payloadRun.created[0].targetPath, payloadTarget)
  expectEqual('the 200 answer is never cached', payload.res.headers['cache-control'], 'no-store')
  expectEqual('the poll claimed the queued job', payloadRun.created[0].state, 'claimed')
  const secondPoll = await callRoute(payloadRoutes, NEXT_JOB_PATH,
    fakeRequest('GET', `${NEXT_JOB_PATH}?wait=0`))
  expectEqual('a second poll gets 204 while the first job is active', secondPoll.status, 204)
  await failPrintJob({ finishToken: payloadPrepared.finishToken, reason: 'client-error' }, { jobs: payloadRun.jobs })

  const warningSource = join(work, 'warning.md')
  await writeFile(warningSource, '---\npdf.unknown: x\n---\n\n# Warning\n\nBody.\n')
  const warningRun = trackJobs()
  const warningRoutes = mountRoutes({ jobs: warningRun.jobs })
  const warningPrepared = await prepareExport({ path: warningSource, owner: 'tool' }, { jobs: warningRun.jobs })
  const warningPoll = await callRoute(warningRoutes, NEXT_JOB_PATH,
    fakeRequest('GET', `${NEXT_JOB_PATH}?wait=0`))
  expectTrue('a job warning reaches the client', Array.isArray(warningPoll.payload.warnings))
  expectEqual('the warning names the ignored key', warningPoll.payload.warnings?.[0], 'pdf.unknown')
  await failPrintJob({ finishToken: warningPrepared.finishToken, reason: 'client-error' }, { jobs: warningRun.jobs })

  const anonymousRun = trackJobs()
  const anonymousRoutes = mountRoutes({ jobs: anonymousRun.jobs })
  const anonymousPrepared = await prepareExport({ path: source, owner: 'tool' }, { jobs: anonymousRun.jobs })
  const anonymousPoll = await callRoute(anonymousRoutes, NEXT_JOB_PATH,
    fakeRequest('GET', `${NEXT_JOB_PATH}?wait=0`))
  expectEqual('a job without a session omits the session id',
    Object.hasOwn(anonymousPoll.payload, 'sessionId'), false)
  await failPrintJob({ finishToken: anonymousPrepared.finishToken, reason: 'client-error' }, { jobs: anonymousRun.jobs })

  const uiRun = trackJobs()
  const uiRoutes = mountRoutes({ jobs: uiRun.jobs })
  const uiJob = uiRun.jobs.create(jobInput('ui-only', 'ui'))
  const uiPoll = await callRoute(uiRoutes, NEXT_JOB_PATH,
    fakeRequest('GET', `${NEXT_JOB_PATH}?wait=0.1`))
  expectEqual('the broker route ignores UI jobs', uiPoll.status, 204)
  expectEqual('a UI job is never claimed by the broker', uiJob.state, 'prepared')

  const arrivalRun = trackJobs()
  const arrivalRoutes = mountRoutes({ jobs: arrivalRun.jobs })
  const arrivalStarted = Date.now()
  const arrivalPoll = callRoute(arrivalRoutes, NEXT_JOB_PATH,
    fakeRequest('GET', `${NEXT_JOB_PATH}?wait=2`))
  await sleep(40)
  const arrivalPrepared = await prepareExport({ path: source, owner: 'tool' }, { jobs: arrivalRun.jobs })
  const arrival = await arrivalPoll
  expectEqual('the poll holds for a job that arrives later', arrival.status, 200)
  expectTrue('the held poll returned before its deadline', Date.now() - arrivalStarted < 2000)
  await failPrintJob({ finishToken: arrivalPrepared.finishToken, reason: 'client-error' }, { jobs: arrivalRun.jobs })

  const waitRun = trackJobs()
  const waitRoutes = mountRoutes({ jobs: waitRun.jobs })
  const waitStarted = Date.now()
  const waited = await callRoute(waitRoutes, NEXT_JOB_PATH,
    fakeRequest('GET', `${NEXT_JOB_PATH}?wait=0.4`))
  const waitedMs = Date.now() - waitStarted
  expectEqual('an empty poll still answers 204', waited.status, 204)
  expectTrue('the poll holds for the requested wait', waitedMs >= 380)

  const closeRun = trackJobs()
  const closeRoutes = mountRoutes({ jobs: closeRun.jobs })
  const closeReq = fakeRequest('GET', `${NEXT_JOB_PATH}?wait=2`)
  const closeRes = fakeResponse()
  const closeStarted = Date.now()
  const closing = closeRoutes.get(NEXT_JOB_PATH)(closeReq, closeRes)
  await sleep(60)
  closeRes.emit('close')
  await closing
  expectTrue('a closed connection stops the poll', Date.now() - closeStarted < 1000)
  expectEqual('a closed poll answers nothing', closeRes.ended, false)

  const heartbeatRun = trackJobs({ presenceMs: 120 })
  const heartbeatRoutes = mountRoutes({ jobs: heartbeatRun.jobs, brokerHeartbeatMs: 40 })
  const heartbeat = await callRoute(heartbeatRoutes, NEXT_JOB_PATH,
    fakeRequest('GET', `${NEXT_JOB_PATH}?wait=0.3`))
  expectEqual('the heartbeat poll answers 204', heartbeat.status, 204)
  expectTrue('the heartbeat keeps the poller present', heartbeatRun.jobs.presence.isPresent())
  expectEqual('every poll uses one fixed presence key', heartbeatRun.jobs.presence.size(), 1)
  await sleep(160)
  expectEqual('presence expires after the last heartbeat', heartbeatRun.jobs.presence.isPresent(), false)

  // 6. The fail route.
  await copyFile(source, join(work, 'fail.md'))
  const failSource = join(work, 'fail.md')
  const failRun = trackJobs()
  const failRoutes = mountRoutes({ jobs: failRun.jobs })
  const failPrepared = await prepareExport({ path: failSource, owner: 'tool' }, { jobs: failRun.jobs })
  const failJob = failRun.created[0]
  const failUrl = failPrepared.printUrl
  const failBody = JSON.stringify({ finishToken: failJob.finishToken, reason: 'client-error' })

  const failGet = await callRoute(failRoutes, FAIL_JOB_PATH, fakeRequest('GET', FAIL_JOB_PATH))
  expectEqual('the fail route is POST-only', failGet.status, 405)
  expectEqual('the fail 405 names POST', failGet.res.headers.allow, 'POST')
  const failFence = mountRoutes({ jobs: failRun.jobs }, 403)
  const fencedFail = await callRoute(failFence, FAIL_JOB_PATH, fakeRequest('POST', FAIL_JOB_PATH,
    failBody, { 'content-type': 'application/json' }))
  expectEqual('the fail route asks the fence first', fencedFail.status, 403)
  expectEqual('a fenced fail never moves the job', failJob.state, 'prepared')

  const wrongType = await callRoute(failRoutes, FAIL_JOB_PATH, fakeRequest('POST', FAIL_JOB_PATH,
    failBody, { 'content-type': 'text/plain' }))
  expectEqual('the fail route requires JSON', wrongType.status, 415)
  const malformed = await callRoute(failRoutes, FAIL_JOB_PATH, fakeRequest('POST', FAIL_JOB_PATH,
    '{', { 'content-type': 'application/json' }))
  expectEqual('the fail route refuses a malformed body', malformed.status, 400)
  const noReason = await callRoute(failRoutes, FAIL_JOB_PATH, fakeRequest('POST', FAIL_JOB_PATH,
    JSON.stringify({ finishToken: failJob.finishToken }), { 'content-type': 'application/json' }))
  expectEqual('the fail route requires a reason', noReason.status, 400)
  const foreignReason = await callRoute(failRoutes, FAIL_JOB_PATH, fakeRequest('POST', FAIL_JOB_PATH,
    JSON.stringify({ finishToken: failJob.finishToken, reason: 'hacked' }), { 'content-type': 'application/json' }))
  expectEqual('the fail route refuses a reason outside the allowlist', foreignReason.status, 400)
  expectTrue('the allowlist contains a client error', CLIENT_FAILURE_REASONS.includes('client-error'))
  expectTrue('the allowlist excludes an unknown reason', !CLIENT_FAILURE_REASONS.includes('hacked'))
  const assetFail = await callRoute(failRoutes, FAIL_JOB_PATH, fakeRequest('POST', FAIL_JOB_PATH,
    JSON.stringify({ finishToken: failJob.assetToken, reason: 'client-error' }), { 'content-type': 'application/json' }))
  expectEqual('the fail route refuses the asset token', assetFail.status, 400)
  const idFail = await callRoute(failRoutes, FAIL_JOB_PATH, fakeRequest('POST', FAIL_JOB_PATH,
    JSON.stringify({ finishToken: failJob.id, reason: 'client-error' }), { 'content-type': 'application/json' }))
  expectEqual('the fail route refuses the job id', idFail.status, 400)
  const unknownFail = await callRoute(failRoutes, FAIL_JOB_PATH, fakeRequest('POST', FAIL_JOB_PATH,
    JSON.stringify({ finishToken: 'missing-token', reason: 'client-error' }), { 'content-type': 'application/json' }))
  expectEqual('the fail route refuses an unknown token', unknownFail.status, 400)
  expectEqual('refused fail calls leave the job prepared', failJob.state, 'prepared')
  const stillOpen = await fetch(failUrl).catch(() => null)
  expectEqual('a refused fail leaves the print server up', stillOpen?.status, 200)

  const failOk = await callRoute(failRoutes, FAIL_JOB_PATH, fakeRequest('POST', FAIL_JOB_PATH,
    failBody, { 'content-type': 'application/json' }))
  expectEqual('the fail route accepts the exact finish token', failOk.status, 200)
  expectEqual('the fail route reports ok', failOk.payload?.ok, true)
  expectEqual('the fail route never exposes job fields',
    Object.keys(failOk.payload ?? {}).sort().join(','), 'ok')
  expectEqual('the failed job records the reason', failJob.failure?.reason, 'client-error')
  expectEqual('the failed job state is failed', failJob.state, 'failed')
  const failPage = await fetch(failUrl).catch(() => null)
  expectTrue('the fail route closes the print server', failPage === null)
  expectEqual('the fail route writes nothing', (await readdir(work)).includes('fail.pdf'), false)
  const failAgain = await callRoute(failRoutes, FAIL_JOB_PATH, fakeRequest('POST', FAIL_JOB_PATH,
    failBody, { 'content-type': 'application/json' }))
  expectEqual('a repeated fail is idempotent', failAgain.status, 200)
  expectEqual('a repeated fail keeps the first reason', failJob.failure?.reason, 'client-error')

  const finishedRun = trackJobs()
  const finishedRoutes = mountRoutes({ jobs: finishedRun.jobs })
  const finishedPrepared = await prepareExport({ path: source, owner: 'tool' }, { jobs: finishedRun.jobs })
  await finishExport({ finishToken: finishedPrepared.finishToken, pdfBytes: PDF }, { jobs: finishedRun.jobs })
  const failedFinished = await callRoute(finishedRoutes, FAIL_JOB_PATH, fakeRequest('POST', FAIL_JOB_PATH,
    JSON.stringify({ finishToken: finishedPrepared.finishToken, reason: 'client-error' }),
    { 'content-type': 'application/json' }))
  expectEqual('a finished job refuses a late fail', failedFinished.status, 409)
  expectEqual('a late fail keeps the written target', finishedRun.created[0].state, 'finished')

  const lateRun = trackJobs({ timeoutMs: 60 })
  const lateRoutes = mountRoutes({ jobs: lateRun.jobs })
  const latePrepared = await prepareExport({ path: source, owner: 'tool' }, { jobs: lateRun.jobs })
  await sleep(100)
  const lateFail = await callRoute(lateRoutes, FAIL_JOB_PATH, fakeRequest('POST', FAIL_JOB_PATH,
    JSON.stringify({ finishToken: latePrepared.finishToken, reason: 'client-error' }),
    { 'content-type': 'application/json' }))
  expectEqual('an expired job refuses a late fail', lateFail.status, 504)

  // A fail and a finish for the same job are serialized. The finish that
  // started first wins; the fail refuses the committed result. The reverse
  // order fails the job before the finish can write.
  await copyFile(source, join(work, 'race.md'))
  const raceFinishJobs = trackJobs()
  const raceFinishPrepared = await prepareExport(
    { path: join(work, 'race.md'), owner: 'tool' },
    { jobs: raceFinishJobs.jobs },
  )
  const finishFirst = finishExport(
    { finishToken: raceFinishPrepared.finishToken, pdfBytes: PDF },
    { jobs: raceFinishJobs.jobs },
  )
  const failSecond = failPrintJob(
    { finishToken: raceFinishPrepared.finishToken, reason: 'client-error' },
    { jobs: raceFinishJobs.jobs },
  )
  const [finishFirstOutcome, failSecondOutcome] = await Promise.all([
    finishFirst.then(value => ({ value }), error => ({ error })),
    failSecond.then(value => ({ value }), error => ({ error })),
  ])
  expectEqual('a finish started first commits', finishFirstOutcome.value?.ok, true)
  expectEqual('a concurrent fail refuses a committed job', failSecondOutcome.error?.code, 'state-conflict')
  expectTrue('the committed PDF survives the refused fail',
    (await readFile(join(work, 'race.pdf'))).equals(PDF))

  await copyFile(source, join(work, 'race2.md'))
  const raceFailJobs = trackJobs()
  const raceFailPrepared = await prepareExport(
    { path: join(work, 'race2.md'), owner: 'tool' },
    { jobs: raceFailJobs.jobs },
  )
  const failFirst = failPrintJob(
    { finishToken: raceFailPrepared.finishToken, reason: 'client-error' },
    { jobs: raceFailJobs.jobs },
  )
  const finishSecond = finishExport(
    { finishToken: raceFailPrepared.finishToken, pdfBytes: PDF },
    { jobs: raceFailJobs.jobs },
  )
  const [failFirstOutcome, finishSecondOutcome] = await Promise.all([
    failFirst.then(value => ({ value }), error => ({ error })),
    finishSecond.then(value => ({ value }), error => ({ error })),
  ])
  expectEqual('a fail started first records failure', failFirstOutcome.value?.ok, true)
  expectEqual('a later finish refuses a failed job', finishSecondOutcome.error?.code, 'state-conflict')
  expectEqual('a refused finish writes no PDF', (await readdir(work)).includes('race2.pdf'), false)

  // 6a. A bad source is the caller's mistake, not a printer problem: it must
  // be reported before the presence wait or the engine choice.
  const missingTool = await capture(async () => exportTool(
    { path: join(work, 'does-not-exist.md') },
    { printEngine: 'dsh', presenceWaitMs: 0 },
  ))
  expectEqual('a missing source is reported before the engine choice', missingTool?.code, 'not-found')
  const markdownDir = join(work, 'folder.md')
  await mkdir(markdownDir, { recursive: true })
  const directoryTool = await capture(async () => exportTool(
    { path: markdownDir },
    { printEngine: 'dsh', presenceWaitMs: 0 },
  ))
  expectEqual('a directory source is refused before the engine choice', directoryTool?.code, 'not-a-file')
  const textTool = await capture(async () => exportTool(
    { path: join(work, 'notes.txt') },
    { printEngine: 'dsh', presenceWaitMs: 0 },
  ))
  expectEqual('a non-markdown source is refused before the engine choice', textTool?.code, 'not-markdown')

  // 6b. A commit owns its job once the write starts. The broker poll sweeps
  // expiry every 100 ms, so without a lease a slow rename can land after the
  // job expired and leave a written PDF behind a timeout result.
  const leaseShop = createPrintJobs({ timeoutMs: 60_000 })
  const leaseJob = leaseShop.create({ owner: 'tool' })
  expectEqual('a new job is not finishing', leaseJob.state, 'prepared')
  leaseShop.beginFinish(leaseJob.finishToken)
  expectEqual('a finish lease moves the job to finishing', leaseJob.state, 'finishing')
  expectEqual('an expiry sweep skips a finishing job', leaseShop.expire(leaseJob.finishingAt + 1).length, 0)
  expectEqual('a finishing job stays open', leaseJob.state, 'finishing')
  const leaseFail = await capture(async () => leaseShop.fail(leaseJob.finishToken, 'client-error'))
  expectEqual('a fail cannot end a finishing job', leaseFail?.code, 'state-conflict')
  expectEqual('a finishing job still commits', leaseShop.finish(leaseJob.finishToken, PDF).state, 'finished')

  const graceShop = createPrintJobs({ timeoutMs: 60_000, finishGraceMs: 50 })
  const graceJob = graceShop.create({})
  graceShop.beginFinish(graceJob.finishToken)
  expectEqual('a fresh write lease is protected',
    graceShop.expire(graceJob.finishingAt + 10).length, 0)
  expectEqual('a stuck write lease expires after the grace',
    graceShop.expire(graceJob.finishingAt + 60).length, 1)
  expectEqual('the stuck job ends expired', graceJob.state, 'expired')

  const abandonShop = createPrintJobs({ timeoutMs: 60_000 })
  const abandonJob = abandonShop.create({})
  abandonShop.beginFinish(abandonJob.finishToken)
  expectEqual('the finish owner can fail a starting job',
    abandonShop.abandonFinish(abandonJob.id, 'write-failed').state, 'failed')
  expectEqual('a failed starting job refuses a late finish',
    (await capture(async () => abandonShop.finish(abandonJob.finishToken, PDF)))?.code, 'state-conflict')

  await copyFile(source, join(work, 'lease.md'))
  const leaseFile = join(work, 'lease.md')
  const leaseTarget = join(work, 'lease.pdf')
  const commitShop = createPrintJobs({ timeoutMs: 60_000 })
  let leaseCalls = 0
  const sweepOnLease = {
    ...commitShop,
    beginFinish(token) {
      leaseCalls += 1
      const job = commitShop.beginFinish(token)
      // Stand in for a broker poll that sweeps expiry while the staging write
      // is in flight.
      commitShop.expire(Date.now())
      return job
    },
  }
  const leasePrepared = await prepareExport({ path: leaseFile, owner: 'tool' }, { jobs: sweepOnLease })
  const leaseResult = await finishExport(
    { finishToken: leasePrepared.finishToken, pdfBytes: PDF },
    { jobs: sweepOnLease },
  )
  expectEqual('a finish takes the write lease', leaseCalls, 1)
  expectEqual('a sweep during the write does not expire the job', leaseResult.ok, true)
  expectEqual('the committed bytes reach the target', (await readFile(leaseTarget)).equals(PDF), true)
  expectEqual('the leased job ends finished', commitShop.get(leasePrepared.finishToken).state, 'finished')

  // 6c. The built-in test page: one route writes it under MD2PDF_HOME, renders
  // it, and lets the normal finish path write the PDF beside it. The client
  // then prints it through the same guest as a real export.
  const testPrintJobs = createPrintJobs({ timeoutMs: 60_000 })
  const testPrintRoutes = mountRoutes({ jobs: testPrintJobs })
  const testPrint = await callRoute(testPrintRoutes, TEST_PRINT_PATH,
    fakeRequest('POST', TEST_PRINT_PATH, '{}', { 'content-type': 'application/json' }))
  expectEqual('the test print route prepares a job', testPrint.status, 200)
  expectEqual('the test print route returns its source',
    testPrint.payload?.sourcePath, join(home, 'test-print', 'test-print.md'))
  expectTrue('the test print source exists',
    (await readdir(join(home, 'test-print'))).includes('test-print.md'))
  expectEqual('the test print page carries page numbers',
    testPrint.payload?.printOptions.displayHeaderFooter, true)
  expectTrue('the test print page carries the default footer',
    String(testPrint.payload?.printOptions.footerTemplate).includes('pageNumber'))
  const testPage = await fetch(testPrint.payload.printUrl)
  expectEqual('the test page is served', testPage.status, 200)
  const testHtml = await testPage.text()
  expectTrue('the test page carries the built-in sample', testHtml.includes('dsh-md2pdf 打印测试'))
  expectTrue('the test page carries a heading id',
    testHtml.includes('id="md2pdf-h-dsh-md2pdf-打印测试"'))
  const testResult = await finishExport(
    { finishToken: testPrint.payload.finishToken, pdfBytes: PDF },
    { jobs: testPrintJobs },
  )
  expectEqual('the test print writes beside its sample',
    testResult.pdfPath, join(home, 'test-print', 'test-print.pdf'))
  expectTrue('the test pdf exists',
    (await readdir(join(home, 'test-print'))).includes('test-print.pdf'))

  const testGet = await callRoute(testPrintRoutes, TEST_PRINT_PATH,
    fakeRequest('GET', TEST_PRINT_PATH))
  expectEqual('the test print route is POST only', testGet.status, 405)
  const testFenceRoutes = mountRoutes({ jobs: createPrintJobs() }, 403)
  const testFence = await callRoute(testFenceRoutes, TEST_PRINT_PATH,
    fakeRequest('POST', TEST_PRINT_PATH, '{}', { 'content-type': 'application/json' }))
  expectEqual('the test print route checks the fence first', testFence.status, 403)
  const testBadBody = await callRoute(testPrintRoutes, TEST_PRINT_PATH,
    fakeRequest('POST', TEST_PRINT_PATH, 'not json', { 'content-type': 'application/json' }))
  expectEqual('the test print route refuses an unparsable body', testBadBody.status, 400)
  const testBadPage = await callRoute(testPrintRoutes, TEST_PRINT_PATH,
    fakeRequest('POST', TEST_PRINT_PATH, '{"page":"A4"}', { 'content-type': 'application/json' }))
  expectEqual('the test print route refuses a non-object page', testBadPage.status, 400)

  const testOverride = await callRoute(testPrintRoutes, TEST_PRINT_PATH,
    fakeRequest('POST', TEST_PRINT_PATH,
      JSON.stringify({ page: { marginMm: 20 }, documentConfig: { header: '测试页眉' } }),
      { 'content-type': 'application/json' }))
  expectTrue('a test print header override reaches the template',
    String(testOverride.payload?.printOptions.headerTemplate).includes('测试页眉'))
  expectEqual('a test print page override reaches the margins',
    testOverride.payload?.printOptions.margins.top, 0.7874)
  await finishExport(
    { finishToken: testOverride.payload.finishToken, pdfBytes: PDF },
    { jobs: testPrintJobs },
  )

  // 6d. The preset route reaches the bundle and history actions, and its body
  // ceiling fits a multi-preset bundle above the generic 1 MiB limit.
  const presetRoutes = mountRoutes({ jobs: createPrintJobs() })
  const bundleAnswer = await callRoute(presetRoutes, PRESETS_PATH,
    fakeRequest('POST', PRESETS_PATH, '{"action":"export-bundle"}', { 'content-type': 'application/json' }))
  expectEqual('the preset route exports a bundle', bundleAnswer.status, 200)
  expectEqual('the bundle carries the library', Array.isArray(bundleAnswer.payload?.presets), true)
  const importBody = JSON.stringify({
    action: 'import-bundle',
    bundle: { version: 2, presets: [{ id: 'route-a', name: 'Route A', css: 'body{color:red}' }] },
  })
  const importAnswer = await callRoute(presetRoutes, PRESETS_PATH,
    fakeRequest('POST', PRESETS_PATH, importBody, { 'content-type': 'application/json' }))
  expectEqual('the preset route imports a bundle', importAnswer.payload?.imported?.join(','), 'route-a')
  const historyAnswer = await callRoute(presetRoutes, PRESETS_PATH,
    fakeRequest('POST', PRESETS_PATH, '{"action":"list-history","id":"lark"}', { 'content-type': 'application/json' }))
  expectEqual('the preset route lists history', Array.isArray(historyAnswer.payload?.history), true)
  const large = [0, 1, 2].map(index => ({ id: 'large-' + index, name: 'Large ' + index, css: 'a'.repeat(480 * 1024) }))
  const largeBody = JSON.stringify({ action: 'import-bundle', bundle: { version: 2, presets: large } })
  expectEqual('a bundle body exceeds the generic limit', largeBody.length > 1024 * 1024, true)
  const largeAnswer = await callRoute(presetRoutes, PRESETS_PATH,
    fakeRequest('POST', PRESETS_PATH, largeBody, { 'content-type': 'application/json' }))
  expectEqual('the preset route accepts a bundle body under its ceiling', largeAnswer.status, 200)
  expectEqual('the large bundle imports every preset', largeAnswer.payload?.imported?.length, 3)

  const settingsRoutes = mountRoutes({ jobs: createPrintJobs() })
  const settingsAnswer = await callRoute(settingsRoutes, SETTINGS_PATH,
    fakeRequest('GET', SETTINGS_PATH))
  expectEqual('the settings route reports the plugin home',
    settingsAnswer.payload?.homePath, home)

  // The sweep must run at the job deadline while the write is in flight, not
  // before it: with the lease taken before the write, the sweep cannot expire
  // the job. A store clock placed near the deadline models that race.
  let leaseClock = Date.now()
  const deadlineShop = createPrintJobs({ now: () => leaseClock, timeoutMs: 1000 })
  let deadlineLeaseCalls = 0
  const sweepOnDeadline = {
    ...deadlineShop,
    beginFinish(token) {
      deadlineLeaseCalls += 1
      const job = deadlineShop.beginFinish(token)
      deadlineShop.expire(job.deadline + 1)
      return job
    },
  }
  const deadlinePrepared = await prepareExport({ path: leaseFile, owner: 'tool' }, { jobs: sweepOnDeadline })
  const deadlineJob = deadlineShop.get(deadlinePrepared.finishToken)
  leaseClock = deadlineJob.deadline - 50
  const deadlineResult = await finishExport(
    { finishToken: deadlinePrepared.finishToken, pdfBytes: PDF },
    { jobs: sweepOnDeadline },
  )
  expectEqual('a deadline finish takes the write lease', deadlineLeaseCalls, 1)
  expectEqual('a deadline sweep during the write does not expire the job', deadlineResult.ok, true)
  expectEqual('the deadline write reaches the target', (await readFile(leaseTarget)).equals(PDF), true)
  expectEqual('the deadline job ends finished', deadlineShop.get(deadlinePrepared.finishToken).state, 'finished')

  // A tool whose commit starts before the deadline must wait for the write
  // when the deadline passes, not report a timeout the file contradicts.
  await copyFile(source, join(work, 'watcher.md'))
  const watcherRun = trackJobs({ timeoutMs: 800 })
  watcherRun.jobs.presence.record('watcher-client')
  const watcherTool = exportTool({ path: join(work, 'watcher.md') }, {
    printEngine: 'dsh',
    jobs: watcherRun.jobs,
    presenceWaitMs: 0,
  })
  await waitFor(() => watcherRun.created.length === 1 && watcherRun.created[0].ready === true)
  const watchedJob = watcherRun.created[0]
  expectEqual('the watcher job is claimed', watcherRun.jobs.claimToolJob()?.id, watchedJob.id)
  const watcherDeadline = watchedJob.deadline
  setTimeout(() => {
    try {
      watcherRun.jobs.beginFinish(watchedJob.finishToken)
    } catch {
      // The outcome assertion below reports a missed window.
    }
  }, Math.max(0, watcherDeadline - 100 - Date.now()))
  setTimeout(() => {
    finishExport({ finishToken: watchedJob.finishToken, pdfBytes: PDF }, { jobs: watcherRun.jobs })
      .catch(() => {})
  }, Math.max(0, watcherDeadline + 250 - Date.now()))
  const watcherOutcome = await watcherTool
  expectEqual('a write past the deadline settles the tool with its result',
    watcherOutcome.engine, 'dsh')
  expectEqual('the watcher target is written',
    (await readFile(join(work, 'watcher.pdf'))).equals(PDF), true)

  // A cancelled tool that already started a commit waits for it and returns
  // the committed result, rather than a cancellation the file contradicts.
  await copyFile(source, join(work, 'abort-settle.md'))
  const abortSettleRun = trackJobs({ timeoutMs: 800 })
  abortSettleRun.jobs.presence.record('abort-settle-client')
  const abortSettleController = new AbortController()
  const abortSettleTool = exportTool({ path: join(work, 'abort-settle.md') }, {
    printEngine: 'dsh',
    jobs: abortSettleRun.jobs,
    presenceWaitMs: 0,
    signal: abortSettleController.signal,
  })
  await waitFor(() => abortSettleRun.created.length === 1 && abortSettleRun.created[0].ready === true)
  const settleJob = abortSettleRun.created[0]
  expectEqual('the abort-settle job is claimed',
    abortSettleRun.jobs.claimToolJob()?.id, settleJob.id)
  const settleDeadline = settleJob.deadline
  setTimeout(() => {
    try {
      abortSettleRun.jobs.beginFinish(settleJob.finishToken)
    } catch {
      // Reported by the outcome assertion.
    }
  }, Math.max(0, settleDeadline - 100 - Date.now()))
  setTimeout(() => { abortSettleController.abort() }, Math.max(0, settleDeadline + 50 - Date.now()))
  setTimeout(() => {
    finishExport({ finishToken: settleJob.finishToken, pdfBytes: PDF }, { jobs: abortSettleRun.jobs })
      .catch(() => {})
  }, Math.max(0, settleDeadline + 250 - Date.now()))
  const settleOutcome = await abortSettleTool
  expectEqual('a cancelled tool returns the commit it waited for',
    settleOutcome.engine, 'dsh')
  expectEqual('the abort-settle target is written',
    (await readFile(join(work, 'abort-settle.pdf'))).equals(PDF), true)

  // 6e. Every route checks the trust fence before anything else, and the
  // method table is exact. These are the routes the earlier checks did not call.
  const protectedRoutes = [
    [PREPARE_PATH, 'POST'],
    [FINISH_PATH, 'POST'],
    [EXPORT_PATH, 'POST'],
    [CAPABILITY_PATH, 'GET'],
    [PREVIEWS_PATH, 'GET'],
  ]
  const fenceRoutes = mountRoutes({}, 403)
  for (const [path, method] of protectedRoutes) {
    const answer = await callRoute(fenceRoutes, path, fakeRequest(method, path))
    expectEqual('the fence refuses ' + path, answer.status, 403)
  }
  const methodRoutes = mountRoutes({})
  for (const [path, method] of protectedRoutes) {
    const other = method === 'GET' ? 'POST' : 'GET'
    const answer = await callRoute(methodRoutes, path, fakeRequest(other, path))
    expectEqual('the method is refused on ' + path, answer.status, 405)
  }
  const noJson = await callRoute(methodRoutes, PREPARE_PATH,
    fakeRequest('POST', PREPARE_PATH, '{}'))
  expectEqual('prepare requires a JSON body', noJson.status, 415)

  // 7. The client wiring. The client is a classic script; the checks pin the
  // source contract and leave the real DSH window to the manual run.
  const client = await readFile(join(here, '..', 'client.js'), 'utf8')
  expectTrue('the client defines the broker poll route', client.includes("md2pdf/print-jobs/next"))
  expectTrue('the client defines the broker fail route', client.includes("md2pdf/print-jobs/fail"))
  expectTrue('the client gates polling on dshPrinterAvailable', client.includes('dshPrinterAvailable()'))
  expectTrue('the client reads the print engine', client.includes('printEngineOf'))
  expectTrue('the client loads the brokered print url', client.includes('job.printUrl'))
  expectTrue('the client prints with the brokered options', client.includes('job.printOptions'))
  expectTrue('the client finishes with the brokered token', client.includes('job.finishToken'))
  expectTrue('the client reports a broker failure by finish token', client.includes('reportBrokerFailure'))
  expectTrue('the client reports an unusable claimed payload',
    client.includes("reportBrokerFailure(payload.finishToken, 'client-error')"))
  expectTrue('the client send a reason with a broker failure', client.includes('finishToken, reason'))
  expectTrue('the client stops the broker loop on dispose', client.includes('stopPrintBroker'))
  expectTrue('the client aborts an in-flight poll', client.includes('.abort()'))
  const brokerFunctionStart = client.indexOf('async function runBrokerPoll')
  const brokerFunctionEnd = brokerFunctionStart < 0
    ? -1
    : client.indexOf('\n    }', brokerFunctionStart)
  const brokerSource = brokerFunctionStart < 0 || brokerFunctionEnd < 0
    ? ''
    : client.slice(brokerFunctionStart, brokerFunctionEnd)
  expectTrue('the broker loop exists', brokerSource !== '')
  expectEqual('the broker loop never shows a toast', brokerSource.includes('notify('), false)
  expectEqual('the broker loop never opens a preview', brokerSource.includes('openPreview'), false)
  expectEqual('the broker loop never applies afterExport', brokerSource.includes('afterExport'), false)

  const manifest = JSON.parse(await readFile(join(here, '..', 'package.json'), 'utf8'))
  expectTrue('the test chain runs this check',
    String(manifest.scripts.test).includes('scripts/broker-check.mjs'))
} finally {
  await rm(home, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  await rm(work, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
}

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`)
process.exitCode = failures === 0 ? 0 : 1
