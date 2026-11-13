/**
 * Checks for the print settle logic that waits out Chromium's deferred write.
 *
 * The browser exits before the PDF reaches disk, so the exporter polls for a
 * changed file with a complete trailer. These checks drive that wait with a
 * delayed writer instead of a real browser.
 *
 * Run: node scripts/printer-check.mjs
 */
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { awaitPdf } from '../src/pdf.js'

const pdfBytes = Buffer.from('%PDF-1.4\nfake body\n%%EOF\n', 'latin1')

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

/** Pause for a while. */
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

const work = await mkdtemp(join(tmpdir(), 'dsh-md2pdf-printer-'))
try {
  // A file that appears after the caller has already started waiting.
  const delayed = join(work, 'delayed.pdf')
  const delayedWrite = sleep(250).then(() => writeFile(delayed, pdfBytes))
  expectEqual('file written after the wait starts is found', await awaitPdf(delayed, null, 5_000), pdfBytes.byteLength)
  await delayedWrite

  // Nothing ever arrives.
  expectEqual('absent file times out with null', await awaitPdf(join(work, 'never.pdf'), null, 400), null)

  // A file that exists but never changes belongs to an earlier run.
  const stale = join(work, 'stale.pdf')
  await writeFile(stale, pdfBytes)
  await sleep(20)
  const staleInfo = await stat(stale)
  expectEqual('unchanged file is not reported as printed',
    await awaitPdf(stale, { size: staleInfo.size, mtimeMs: staleInfo.mtimeMs }, 400), null)

  // A partial file without the trailer is not accepted.
  const partial = join(work, 'partial.pdf')
  const partialWrite = sleep(150).then(() => writeFile(partial, Buffer.from('%PDF-1.4\nno trailer', 'latin1')))
  expectEqual('file without a trailer is refused', await awaitPdf(partial, null, 600), null)
  await partialWrite

  // A complete replacement of an existing file is accepted.
  const replaced = join(work, 'replaced.pdf')
  const oldBytes = Buffer.from('%PDF-1.4\nold\n%%EOF\n', 'latin1')
  await writeFile(replaced, oldBytes)
  const oldInfo = await stat(replaced)
  const replaceWrite = sleep(150).then(() => writeFile(replaced, pdfBytes))
  expectEqual('changed file is accepted',
    await awaitPdf(replaced, { size: oldInfo.size, mtimeMs: oldInfo.mtimeMs }, 5_000), pdfBytes.byteLength)
  await replaceWrite
} finally {
  await rm(work, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
}

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`)
process.exit(failures === 0 ? 0 : 1)
