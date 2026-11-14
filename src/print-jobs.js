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
 * prepared -> claimed -> finished
 * prepared/claimed/printing -> expired
 * ```
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
 * @param options - clock, deadline, and presence window.
 * @param options.now - clock function in milliseconds; defaults to `Date.now`.
 * @param options.timeoutMs - how long a job may live; defaults to 120000.
 * @param options.presenceMs - how long a client record counts; defaults to 10000.
 * @returns the job operations, presence probe, and close function.
 */
export function createPrintJobs({
  now = Date.now,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  presenceMs = DEFAULT_PRESENCE_MS,
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
      createdAt,
      deadline: createdAt + timeoutMs,
      owner: input.owner === 'tool' ? 'tool' : 'ui',
    }
    jobs.set(job.id, job)
    return job
  }

  /**
   * Claim the oldest prepared job.
   * @returns the claimed job, or null when the queue holds only finished work.
   */
  function claimNext() {
    for (const job of jobs.values()) {
      if (job.state !== 'prepared') continue
      job.state = 'claimed'
      return job
    }
    return null
  }

  /**
   * Commit one PDF payload for a finish token.
   *
   * The first successful call stores a result on the job. Repeating it with the
   * same bytes returns that same object; repeating it with different bytes
   * refuses the write with status 409. No file is written here.
   * @param finishToken - the job's finish secret.
   * @param pdfBytes - payload returned by the client printer.
   * @returns the committed result object stored on the job.
   * @throws {Error} with `code` and `status` when the token, state, or PDF is refused.
   */
  function finish(finishToken, pdfBytes) {
    const job = byFinishToken(finishToken)
    if (job === null) throw jobError('bad-request', 400, 'unknown finish token')
    if (job.state === 'expired') throw jobError('job-timeout', 504, 'this print job has expired')

    const bytes = bytesOf(pdfBytes)
    if (job.state === 'finished') {
      const digest = bytes === null ? null : createHash('sha256').update(bytes).digest('hex')
      if (digest !== null && digest === digests.get(job.id)) return job.result
      throw jobError('finish-conflict', 409, 'this print job already committed different bytes')
    }

    if (bytes === null || !completePdf(bytes)) {
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
     * @param clientId - stable identifier for the polling client.
     * @returns the recorded timestamp.
     */
    record(clientId) {
      const at = clock()
      lastSeen.set(clientId, at)
      return at
    },

    /**
     * Report whether any client was seen inside the presence window.
     * @param instant - clock reading to compare against; defaults to the current time.
     * @returns true when a recorded client is still present.
     */
    isPresent(instant = clock()) {
      const at = Number.isFinite(instant) ? instant : clock()
      for (const seenAt of lastSeen.values()) {
        if (at - seenAt < presenceMs) return true
      }
      return false
    },
  }

  /**
   * Stop the store: forget presence and expire open jobs.
   * @returns a promise that resolves when the store has been cleared.
   */
  async function close() {
    lastSeen.clear()
    for (const job of jobs.values()) {
      if (OPEN_STATES.has(job.state)) job.state = 'expired'
    }
  }

  return { create, claimNext, finish, expire, get, presence, close }
}
