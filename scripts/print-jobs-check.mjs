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

const badHeader = captureError(() => jobs.finish(second.finishToken, Buffer.from('not a pdf')))
expectEqual('pdf header is validated', badHeader?.code, 'pdf-invalid')
expectEqual('invalid pdf maps to 502', badHeader?.status, 502)
expectEqual('invalid bytes leave the job claimable', second.state, 'claimed')

const badTrailer = captureError(() => jobs.finish(second.finishToken, Buffer.from('%PDF-1.4\nbody only')))
expectEqual('pdf trailer is validated', badTrailer?.code, 'pdf-invalid')

const lateTrailer = Buffer.concat([Buffer.from('%PDF-1.4\n%%EOF\n', 'latin1'), Buffer.alloc(3000, 0x20)])
const earlyTrailer = captureError(() => jobs.finish(second.finishToken, lateTrailer))
expectEqual('the trailer must be in the last 2 KiB', earlyTrailer?.code, 'pdf-invalid')

const unknown = captureError(() => jobs.finish('missing-token', PDF))
expectEqual('unknown token code', unknown?.code, 'bad-request')
expectEqual('unknown token maps to 400', unknown?.status, 400)

const secondResult = jobs.finish(second.finishToken, PDF)
expectEqual('a claimed job can finish after a refused attempt', secondResult.jobId, second.id)

clock += 10
const third = jobs.create(jobInput('third', 'ui'))
const fourth = jobs.create(jobInput('fourth', 'tool'))
expectTrue('claim skips finished jobs', jobs.claimNext() === third)
expectEqual('new claimed job', third.state, 'claimed')

const expired = jobs.expire(clock + 120_001)
expectEqual('expire returns both open jobs', expired.length, 2)
expectEqual('claimed job expires', third.state, 'expired')
expectEqual('prepared job expires', fourth.state, 'expired')
expectEqual('a finished job is not expired', first.state, 'finished')
expectEqual('expired jobs are not claimable', jobs.claimNext(), null)

const recordedAt = clock
jobs.presence.record('client-a')
expectTrue('a recorded client is present', jobs.presence.isPresent(recordedAt))
expectTrue('the client is present just inside 10 s', jobs.presence.isPresent(recordedAt + 9_999))
expectEqual('the client is absent at 10 s', jobs.presence.isPresent(recordedAt + 10_000), false)

await jobs.close()
expectEqual('close clears presence', jobs.presence.isPresent(recordedAt + 1), false)

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`)
process.exit(failures === 0 ? 0 : 1)
