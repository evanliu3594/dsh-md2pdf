/**
 * Assertions for the print-job store.
 *
 * The store is the authority a finish request consults: it queues jobs, holds
 * the two independent tokens, expires work after the deadline, and commits one
 * PDF result per finish token. These checks use an injected clock so the 120 s
 * deadline and the 10 s presence window stay deterministic.
 *
 * Run: node scripts/print-jobs-check.mjs
 */
import { createPrintJobs } from '../src/print-jobs.js'

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
 * Run a call and return the error it throws.
 * @param run - the call expected to refuse its input.
 * @returns the thrown error, or null when the call returned.
 */
function captureError(run) {
  try {
    run()
  } catch (error) {
    return error
  }
  return null
}

/**
 * Build the input for one job.
 * @param name - source and target stem.
 * @param owner - `ui` or `tool`.
 * @returns a complete job request.
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

const PDF = Buffer.from('%PDF-1.4\n%%EOF\n', 'latin1')
const OTHER_PDF = Buffer.from('%PDF-1.5\n%%EOF\n', 'latin1')
const JOB_FIELDS = [
  'id', 'assetToken', 'finishToken', 'sessionId', 'sourcePath', 'targetPath',
  'html', 'assetRoot', 'printOptions', 'state', 'createdAt', 'deadline', 'owner',
]

let clock = 1_000_000
const jobs = createPrintJobs({ now: () => clock })

const first = jobs.create(jobInput('first', 'ui'))
clock += 1
const second = jobs.create(jobInput('second', 'tool'))

expectEqual('job shape', JOB_FIELDS.every(field => Object.hasOwn(first, field)), true)
expectEqual('created job starts prepared', first.state, 'prepared')
expectEqual('deadline uses the 120 s timeout', first.deadline - first.createdAt, 120_000)
expectEqual('ui owner', first.owner, 'ui')
expectEqual('tool owner', second.owner, 'tool')
expectTrue('asset and finish tokens are independent', first.assetToken !== first.finishToken)
expectEqual('asset token holds 32 random bytes', /^[0-9a-f]{64}$/.test(first.assetToken), true)
expectEqual('finish token holds 32 random bytes', /^[0-9a-f]{64}$/.test(first.finishToken), true)
expectTrue('jobs have distinct ids', first.id !== second.id)

expectTrue('first claim returns the first job', jobs.claimNext() === first)
expectEqual('claimed job records the state', first.state, 'claimed')
expectTrue('second claim returns the second job', jobs.claimNext() === second)
expectEqual('queue is empty after two claims', jobs.claimNext(), null)
expectTrue('get finds a job by id', jobs.get(first.id) === first)
expectTrue('get finds a job by finish token', jobs.get(first.finishToken) === first)

expectTrue('mark printing returns the job', jobs.markPrinting(first.finishToken) === first)
expectEqual('mark printing records the state', first.state, 'printing')
expectTrue('mark printing is idempotent', jobs.markPrinting(first.id) === first)
expectEqual('a repeated mark printing keeps the state', first.state, 'printing')

const result = jobs.finish(first.finishToken, PDF)
expectEqual('finish state', first.state, 'finished')
expectEqual('committed result names the job', result.jobId, first.id)
expectEqual('committed result records the byte count', result.bytes, PDF.length)
expectEqual('committed result records the state', result.state, 'finished')
expectEqual('committed result is stored on the job', first.result, result)
expectTrue('repeat finish returns the same result', jobs.finish(first.finishToken, Buffer.from(PDF)) === result)

const conflict = captureError(() => jobs.finish(first.finishToken, OTHER_PDF))
expectEqual('different bytes are refused with 409', conflict?.status, 409)
expectEqual('different bytes use a stable code', conflict?.code, 'finish-conflict')
expectEqual('a conflict keeps the committed result', first.result, result)
expectEqual('a conflict keeps the finished state', first.state, 'finished')

const failed = jobs.fail(second.assetToken, 'client-error')
expectTrue('fail returns the job', failed === second)
expectEqual('fail records the state', second.state, 'failed')
expectEqual('fail records the reason', second.failure.reason, 'client-error')
expectEqual('fail records when it happened', second.failure.failedAt, clock)
expectTrue('fail is idempotent', jobs.fail(second.id, 'other-error') === second)
expectEqual('a repeated fail keeps the first reason', second.failure.reason, 'client-error')
const finishFailed = captureError(() => jobs.finish(second.finishToken, PDF))
expectEqual('finish on a failed job is refused', finishFailed?.code, 'state-conflict')
expectEqual('finish on a failed job maps to 409', finishFailed?.status, 409)
expectEqual('a refused finish keeps the job failed', second.state, 'failed')
const failFinished = captureError(() => jobs.fail(first.id, 'late-error'))
expectEqual('fail on a finished job is refused', failFinished?.code, 'state-conflict')
expectEqual('a finished job keeps its result', first.result, result)
const markFailed = captureError(() => jobs.markPrinting(second.id))
expectEqual('mark printing on a failed job is refused', markFailed?.code, 'state-conflict')

clock += 10
const invalid = jobs.create(jobInput('invalid', 'ui'))
expectTrue('claim returns the invalid-payload job', jobs.claimNext() === invalid)
const badHeader = captureError(() => jobs.finish(invalid.finishToken, Buffer.from('not a pdf')))
expectEqual('pdf header is validated', badHeader?.code, 'pdf-invalid')
expectEqual('invalid pdf maps to 502', badHeader?.status, 502)
expectEqual('invalid pdf marks the job failed', invalid.state, 'failed')
expectEqual('invalid pdf records the failure', invalid.failure.reason, 'pdf-invalid')
const lateValid = captureError(() => jobs.finish(invalid.finishToken, PDF))
expectEqual('a failed job refuses later valid bytes', lateValid?.code, 'state-conflict')
expectEqual('the failed job stays failed', invalid.state, 'failed')

const badTrailerJob = jobs.create(jobInput('bad-trailer', 'tool'))
expectTrue('claim returns the bad-trailer job', jobs.claimNext() === badTrailerJob)
const badTrailer = captureError(() => jobs.finish(badTrailerJob.finishToken, Buffer.from('%PDF-1.4\nbody only')))
expectEqual('pdf trailer is validated', badTrailer?.code, 'pdf-invalid')
expectEqual('a bad trailer also fails the job', badTrailerJob.state, 'failed')

const lateTrailerJob = jobs.create(jobInput('late-trailer', 'ui'))
expectTrue('claim returns the late-trailer job', jobs.claimNext() === lateTrailerJob)
const lateTrailer = Buffer.concat([Buffer.from('%PDF-1.4\n%%EOF\n', 'latin1'), Buffer.alloc(3000, 0x20)])
const earlyTrailer = captureError(() => jobs.finish(lateTrailerJob.finishToken, lateTrailer))
expectEqual('the trailer must be in the last 2 KiB', earlyTrailer?.code, 'pdf-invalid')
expectEqual('a distant trailer fails the job', lateTrailerJob.state, 'failed')

const unknown = captureError(() => jobs.finish('missing-token', PDF))
expectEqual('unknown token code', unknown?.code, 'bad-request')
expectEqual('unknown token maps to 400', unknown?.status, 400)
const unknownMark = captureError(() => jobs.markPrinting('missing-token'))
expectEqual('mark printing refuses an unknown job', unknownMark?.code, 'bad-request')
const unknownFail = captureError(() => jobs.fail('missing-token'))
expectEqual('fail refuses an unknown job', unknownFail?.code, 'bad-request')

clock += 10
const third = jobs.create(jobInput('third', 'ui'))
const fourth = jobs.create(jobInput('fourth', 'tool'))
const unclaimed = jobs.create(jobInput('unclaimed', 'ui'))
expectTrue('claim skips finished and failed jobs', jobs.claimNext() === third)
expectEqual('new claimed job', third.state, 'claimed')
expectTrue('claim takes the next prepared job', jobs.claimNext() === fourth)
expectEqual('second new claimed job', fourth.state, 'claimed')
expectTrue('mark printing before expiry', jobs.markPrinting(fourth.id) === fourth)
expectEqual('printing job records the state', fourth.state, 'printing')
const earlyPrint = captureError(() => jobs.markPrinting(unclaimed.id))
expectEqual('mark printing before a claim is refused', earlyPrint?.code, 'state-conflict')
expectEqual('a prepared job stays prepared', unclaimed.state, 'prepared')

const expired = jobs.expire(clock + 120_001)
expectEqual('expire returns every open job', expired.length, 3)
expectEqual('claimed job expires', third.state, 'expired')
expectEqual('printing job expires', fourth.state, 'expired')
expectEqual('prepared job expires', unclaimed.state, 'expired')
expectEqual('a finished job is not expired', first.state, 'finished')
expectEqual('a failed job is not expired', second.state, 'failed')
expectEqual('expired jobs are not claimable', jobs.claimNext(), null)
const expiredMark = captureError(() => jobs.markPrinting(unclaimed.id))
expectEqual('mark printing on an expired job maps to 504', expiredMark?.status, 504)
const expiredFail = captureError(() => jobs.fail(unclaimed.id))
expectEqual('fail on an expired job maps to 504', expiredFail?.status, 504)
const expiredFinish = captureError(() => jobs.finish(third.finishToken, PDF))
expectEqual('finish on an expired job maps to 504', expiredFinish?.status, 504)

const recordedAt = clock
jobs.presence.record('client-a')
expectTrue('a recorded client is present', jobs.presence.isPresent(recordedAt))
expectTrue('the client is present just inside 10 s', jobs.presence.isPresent(recordedAt + 9_999))
expectEqual('the client is absent at 10 s', jobs.presence.isPresent(recordedAt + 10_000), false)

await jobs.close()
expectEqual('close clears presence', jobs.presence.isPresent(recordedAt + 1), false)

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`)
process.exit(failures === 0 ? 0 : 1)
