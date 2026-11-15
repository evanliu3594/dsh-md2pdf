/**
 * The print-job state machine shared by UI exports and the agent broker.
 *
 * A job owns two independent secrets. `assetToken` gates the one-shot resource
 * server and dies with it; `finishToken` commits the returned PDF and stays
 * replayable, so a client retry after a network error is harmless. The store
 * keeps bytes only as a SHA-256 digest; writing the PDF belongs to the
 * exporter. Finish is idempotent for identical bytes and refuses different
 * bytes once a result is committed.
 *
 * State transitions:
 *
 * ```
 * prepared -> claimed -> printing -> finishing -> finished
 * prepared/claimed/printing/finishing -> failed
 * prepared/claimed/printing -> expired
 * finishing -> expired (only after the finish grace)
 * ```
 *
 * `finishing` is the write lease a commit takes before it touches the target.
 * The broker poll sweeps expiry every 100 ms, so without the lease a slow
 * rename could land after the deadline and leave a written PDF behind a
 * timeout result. The lease keeps `fail` out and stops the deadline sweep; a
 * write that never settles still expires once the grace has passed.
 *
 * `failed` is terminal for committing. The design treats a client error or an
 * invalid PDF payload as the end of that job, so `finish` refuses a failed job
 * even when later bytes are valid. `markPrinting` records that the client began
 * printing; `fail` records a client-side error. Both are idempotent for the
 * state they produce. `finish` accepts any open state so a client that omits
 * the printing signal can still commit; the intended path is claim, mark
 * printing, finish.
 *
 * The queue is FIFO over insertion order. A job's deadline starts at creation,
 * so time spent waiting for a client counts against the 120 s timeout.
 */
import { createHash, randomBytes } from 'node:crypto'

/** Default print-job deadline in milliseconds. */
const DEFAULT_TIMEOUT_MS = 120_000

/** Default client-presence window in milliseconds. */
const DEFAULT_PRESENCE_MS = 10_000

/** Leading bytes every accepted PDF starts with. */
const PDF_HEADER = Buffer.from('%PDF-', 'latin1')

/** Trailer bytes every accepted PDF ends with. */
const PDF_TRAILER = Buffer.from('%%EOF', 'latin1')

/** How much of the end of the byte stream may hold the trailer. */
const PDF_TRAILER_BYTES = 2048

/** States whose deadline can still expire them. */
const OPEN_STATES = new Set(['prepared', 'claimed', 'printing'])

/** State of a job whose finish write is in flight. */
const FINISHING = 'finishing'

/** How long a started write may run before the deadline sweep expires it. */
const DEFAULT_FINISH_GRACE_MS = 30_000

/**
 * Reasons a client may report through the broker's fail route.
 *
 * The list is closed so a caller cannot write arbitrary text into a job's
 * failure record. A reason the list does not name is refused by the route and
 * replaced by `client-error` on the client.
 */
export const CLIENT_FAILURE_REASONS = Object.freeze([
  'client-error',
  'client-required',
  'no-printer',
  'print-failed',
  'pdf-invalid',
  'file-busy',
  'job-timeout',
  'asset-server-failed',
])

/**
 * Build one named store error with both the project code and an HTTP status.
 * @param code - stable machine code, such as `pdf-invalid`.
 * @param status - HTTP status the finish route should answer with.
 * @param message - operator-facing explanation.
 * @returns the throwable error.
 */
function jobError(code, status, message) {
  const error = new Error(message)
  error.name = 'PrintJobError'
  error.code = code
  error.status = status
  return error
}

/**
 * Read one PDF payload as bytes.
 * @param value - caller-supplied payload.
 * @returns a Buffer, or null when the value is not byte-like.
 */
function bytesOf(value) {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  return null
}

/**
 * Check the `%PDF-` header and the `%%EOF` trailer of one payload.
 * @param bytes - payload bytes.
 * @returns true when both markers are present in their required places.
 */
function completePdf(bytes) {
  if (bytes.length < PDF_HEADER.length) return false
  if (!bytes.subarray(0, PDF_HEADER.length).equals(PDF_HEADER)) return false
  const tail = bytes.subarray(Math.max(0, bytes.length - PDF_TRAILER_BYTES))
  return tail.includes(PDF_TRAILER)
}

/**
 * Create an in-memory print-job store.
 *
 * @param options - clock, deadline, presence window, and finish grace.
 * @param options.now - clock function in milliseconds; defaults to `Date.now`.
 * @param options.timeoutMs - how long a job may live; defaults to 120000.
 * @param options.presenceMs - how long a client record counts; defaults to 10000.
 * @param options.finishGraceMs - how long a started write is protected; defaults
 *   to 30000.
 * @returns the job operations, transitions, presence probe, and close function.
 */
export function createPrintJobs({
  now = Date.now,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  presenceMs = DEFAULT_PRESENCE_MS,
  finishGraceMs = DEFAULT_FINISH_GRACE_MS,
} = {}) {
  const clock = typeof now === 'function' ? now : Date.now
  const jobs = new Map()
  const digests = new Map()
  const lastSeen = new Map()

  /**
   * Find one job by its finish token.
   * @param token - caller-supplied finish token.
   * @returns the job, or null.
   */
  function byFinishToken(token) {
    if (typeof token !== 'string' || token === '') return null
    for (const job of jobs.values()) {
      if (job.finishToken === token) return job
    }
    return null
  }

  /**
   * Create one prepared job and append it to the queue.
   * @param input - the job fields owned by the caller.
   * @returns the new job.
   */
  function create(input = {}) {
    const createdAt = clock()
    const job = {
      id: randomBytes(16).toString('hex'),
      assetToken: randomBytes(32).toString('hex'),
      finishToken: randomBytes(32).toString('hex'),
      sessionId: input.sessionId,
      sourcePath: input.sourcePath,
      targetPath: input.targetPath,
      html: input.html,
      assetRoot: input.assetRoot,
      printOptions: input.printOptions,
      state: 'prepared',
      // A tool job is not claimable until its print URL exists. The exporter
      // creates the job before the loopback server has an address and calls
      // markReady once the URL is stored.
      ready: false,
      createdAt,
      deadline: createdAt + timeoutMs,
      owner: input.owner === 'tool' ? 'tool' : 'ui',
    }
    jobs.set(job.id, job)
    return job
  }

  /**
   * Mark one job ready for a broker claim.
   *
   * A tool job is created before its loopback server has an address, so the
   * broker must not hand it out until `printUrl` exists. Readiness is separate
   * from `prepared`: the job is prepared while the server starts and becomes
   * claimable only after the exporter has the printable URL.
   * @param idOrToken - job id, asset token, or finish token.
   * @returns the ready job.
   * @throws {Error} with `code` and `status` when the job is unknown.
   */
  function markReady(idOrToken) {
    const job = get(idOrToken)
    if (job === null) throw jobError('bad-request', 400, 'unknown print job')
    job.ready = true
    return job
  }

  /**
   * Mark one prepared job claimed and record when that happened.
   *
   * `claimedAt` outlives the `claimed` state, so a watcher can tell a job that
   * timed out after a client took it from one that was never picked up.
   * @param job - the prepared job.
   * @returns the same job in `claimed`.
   */
  function takeClaim(job) {
    job.state = 'claimed'
    job.claimedAt = clock()
    return job
  }

  /**
   * Claim the oldest prepared job.
   * @returns the claimed job, or null when the queue holds only finished work.
   */
  function claimNext() {
    for (const job of jobs.values()) {
      if (job.state !== 'prepared') continue
      return takeClaim(job)
    }
    return null
  }

  /**
   * Claim the oldest prepared tool job.
   *
   * The broker prints one tool job at a time. A tool job that is already
   * claimed, printing, or finishing means the client is still busy, so a
   * second tool job waits even when it is older in the queue. UI jobs never participate; they
   * are printed by the client that created them. Overdue work expires first,
   * so a job past its deadline is never handed out.
   * @returns the claimed tool job, or null when none is ready.
   */
  function claimToolJob() {
    expire()
    for (const job of jobs.values()) {
      if (job.owner !== 'tool') continue
      if (job.state === 'claimed' || job.state === 'printing' || job.state === FINISHING) return null
    }
    for (const job of jobs.values()) {
      if (job.owner !== 'tool' || job.state !== 'prepared') continue
      if (job.ready !== true) continue
      return takeClaim(job)
    }
    return null
  }

  /**
   * Move one claimed job to printing.
   *
   * Repeating the call on a printing job returns it unchanged. A prepared job
   * must be claimed first; failed, finished, and expired jobs never print.
   * @param idOrToken - job id, asset token, or finish token.
   * @returns the job in `printing`.
   * @throws {Error} with `code` and `status` when the job cannot print.
   */
  function markPrinting(idOrToken) {
    const job = get(idOrToken)
    if (job === null) throw jobError('bad-request', 400, 'unknown print job')
    if (job.state === 'expired') throw jobError('job-timeout', 504, 'this print job has expired')
    if (job.state === 'failed') throw jobError('state-conflict', 409, 'this print job has failed')
    if (job.state === 'finished') throw jobError('state-conflict', 409, 'this print job already finished')
    if (job.state === FINISHING) throw jobError('state-conflict', 409, 'this print job is being written')
    if (job.state === 'prepared') throw jobError('state-conflict', 409, 'claim the job before printing')
    job.state = 'printing'
    return job
  }

  /**
   * Mark one job failed and record why.
   * @param job - the open job to fail.
   * @param reason - short machine code for the failure.
   * @returns the failed job.
   */
  function markFailed(job, reason) {
    job.state = 'failed'
    job.failure = { reason, failedAt: clock() }
    return job
  }

  /**
   * Mark one open job failed from the outside.
   *
   * The first reason wins; repeating the call returns the same job and keeps
   * the original reason and timestamp. A finished job is never demoted, and a
   * job whose write lease is live refuses the call: only its owner may end it.
   * @param idOrToken - job id, asset token, or finish token.
   * @param reason - short machine code, such as `client-error`.
   * @returns the failed job.
   * @throws {Error} with `code` and `status` when the job cannot fail.
   */
  function fail(idOrToken, reason = 'client-error') {
    if (typeof reason !== 'string' || reason === '') {
      throw new TypeError('failure reason must be text')
    }
    const job = get(idOrToken)
    if (job === null) throw jobError('bad-request', 400, 'unknown print job')
    if (job.state === 'expired') throw jobError('job-timeout', 504, 'this print job has expired')
    if (job.state === 'finished') throw jobError('state-conflict', 409, 'this print job already finished')
    if (job.state === FINISHING) throw jobError('state-conflict', 409, 'this print job is being written')
    if (job.state === 'failed') return job
    return markFailed(job, reason)
  }

  /**
   * Take the write lease for one finish.
   *
   * The exporter calls this before the first await of a commit, so a deadline
   * sweep or a client fail cannot end a job whose bytes are already being
   * written. The lease is short-lived: the same finish commits or abandons it.
   * @param finishToken - the job's finish secret.
   * @returns the job in `finishing`, or the finished job on a replay.
   * @throws {Error} with `code` and `status` when the job cannot be written.
   */
  function beginFinish(finishToken) {
    const job = byFinishToken(finishToken)
    if (job === null) throw jobError('bad-request', 400, 'unknown finish token')
    if (job.state === 'expired') throw jobError('job-timeout', 504, 'this print job has expired')
    if (job.state === 'failed') throw jobError('state-conflict', 409, 'this print job has failed')
    if (job.state === 'finished') return job
    job.state = FINISHING
    job.finishingAt = clock()
    return job
  }

  /**
   * Fail one job from inside its own finish attempt.
   *
   * This is the finish owner's exit after the write refused, for example a
   * locked target. The route-facing `fail` cannot be used here because the
   * job is in `finishing` and a foreign caller must not end a live write.
   * @param idOrToken - job id, asset token, or finish token.
   * @param reason - short machine code for the failure.
   * @returns the failed job.
   * @throws {Error} with `code` and `status` when the job cannot fail.
   */
  function abandonFinish(idOrToken, reason = 'write-failed') {
    if (typeof reason !== 'string' || reason === '') {
      throw new TypeError('failure reason must be text')
    }
    const job = get(idOrToken)
    if (job === null) throw jobError('bad-request', 400, 'unknown print job')
    if (job.state === 'expired') throw jobError('job-timeout', 504, 'this print job has expired')
    if (job.state === 'finished') throw jobError('state-conflict', 409, 'this print job already finished')
    if (job.state === 'failed') return job
    return markFailed(job, reason)
  }

  /**
   * Commit one PDF payload for a finish token.
   *
   * The first successful call stores a result on the job. Repeating it with the
   * same bytes returns that same object; repeating it with different bytes
   * refuses the write with status 409. An invalid payload fails the job, so a
   * later valid payload cannot commit work the design already ended. No file is
   * written here.
   * @param finishToken - the job's finish secret.
   * @param pdfBytes - payload returned by the client printer.
   * @returns the committed result object stored on the job.
   * @throws {Error} with `code` and `status` when the token, state, or PDF is refused.
   */
  function finish(finishToken, pdfBytes) {
    const job = byFinishToken(finishToken)
    if (job === null) throw jobError('bad-request', 400, 'unknown finish token')
    if (job.state === 'expired') throw jobError('job-timeout', 504, 'this print job has expired')
    if (job.state === 'failed') throw jobError('state-conflict', 409, 'this print job has failed')

    const bytes = bytesOf(pdfBytes)
    if (job.state === 'finished') {
      const digest = bytes === null ? null : createHash('sha256').update(bytes).digest('hex')
      if (digest !== null && digest === digests.get(job.id)) return job.result
      throw jobError('finish-conflict', 409, 'this print job already committed different bytes')
    }

    if (bytes === null || !completePdf(bytes)) {
      markFailed(job, 'pdf-invalid')
      throw jobError('pdf-invalid', 502, 'the payload is not a complete PDF')
    }

    const digest = createHash('sha256').update(bytes).digest('hex')
    job.state = 'finished'
    digests.set(job.id, digest)
    job.result = {
      jobId: job.id,
      state: 'finished',
      bytes: bytes.length,
      sha256: digest,
      finishedAt: clock(),
    }
    return job.result
  }

  /**
   * Expire every open job whose deadline has passed.
   * @param instant - clock reading to compare against; defaults to the current time.
   * @returns the jobs that moved to `expired`.
   */
  function expire(instant = clock()) {
    const at = Number.isFinite(instant) ? instant : clock()
    const expired = []
    for (const job of jobs.values()) {
      if (job.state === FINISHING) {
        const started = Number.isFinite(job.finishingAt) ? job.finishingAt : job.deadline
        if (at - started < finishGraceMs) continue
        job.state = 'expired'
        expired.push(job)
        continue
      }
      if (!OPEN_STATES.has(job.state)) continue
      if (job.deadline > at) continue
      job.state = 'expired'
      expired.push(job)
    }
    return expired
  }

  /**
   * Find a job by id or by either token.
   * @param idOrToken - job id, asset token, or finish token.
   * @returns the job, or null.
   */
  function get(idOrToken) {
    if (typeof idOrToken !== 'string' || idOrToken === '') return null
    const byId = jobs.get(idOrToken)
    if (byId !== undefined) return byId
    for (const job of jobs.values()) {
      if (job.assetToken === idOrToken || job.finishToken === idOrToken) return job
    }
    return null
  }

  /** Record that a client was seen during this poll. */
  const presence = {
    /**
     * Mark a client present now.
     *
     * Recording also drops every entry older than the presence window, so a
     * long-lived Host does not accumulate dead keys.
     * @param clientId - stable identifier for the polling client.
     * @returns the recorded timestamp.
     */
    record(clientId) {
      const at = clock()
      const key = typeof clientId === 'string' && clientId !== '' ? clientId : 'client'
      for (const [seenId, seenAt] of lastSeen) {
        if (at - seenAt >= presenceMs) lastSeen.delete(seenId)
      }
      lastSeen.set(key, at)
      return at
    },

    /**
     * Report whether any client was seen inside the presence window.
     *
     * A tool job in `claimed`, `printing`, or `finishing` also counts: the
     * client that took it is busy and only returns to polling afterwards, so
     * the heartbeat stops while the work is live.
     * @param instant - clock reading to compare against; defaults to the current time.
     * @returns true when a recorded client or an active tool job is present.
     */
    isPresent(instant = clock()) {
      const at = Number.isFinite(instant) ? instant : clock()
      for (const job of jobs.values()) {
        if (job.owner === 'tool'
          && (job.state === 'claimed' || job.state === 'printing' || job.state === FINISHING)) return true
      }
      for (const seenAt of lastSeen.values()) {
        if (at - seenAt < presenceMs) return true
      }
      return false
    },

    /**
     * Drop every record older than the presence window.
     * @param instant - clock reading to compare against; defaults to the current time.
     * @returns how many records were removed.
     */
    prune(instant = clock()) {
      const at = Number.isFinite(instant) ? instant : clock()
      let removed = 0
      for (const [seenId, seenAt] of lastSeen) {
        if (at - seenAt >= presenceMs) {
          lastSeen.delete(seenId)
          removed += 1
        }
      }
      return removed
    },

    /**
     * Report how many client records are tracked.
     * @returns the size of the presence map.
     */
    size() {
      return lastSeen.size
    },
  }

  /**
   * Stop the store: forget presence and expire open jobs.
   * @returns a promise that resolves when the store has been cleared.
   */
  async function close() {
    lastSeen.clear()
    for (const job of jobs.values()) {
      if (OPEN_STATES.has(job.state) || job.state === FINISHING) job.state = 'expired'
    }
  }

  return {
    create, claimNext, claimToolJob, markReady, markPrinting, beginFinish, abandonFinish,
    fail, finish, expire, get, presence, close,
  }
}
