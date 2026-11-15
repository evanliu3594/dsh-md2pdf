/**
 * Assertions for the one-shot loopback asset server.
 *
 * The server is the only way the DSH print webview reaches local images and
 * fonts, so these checks cover the token gate, the path jail, the CSP, and the
 * shutdown behavior a finished print job depends on.
 *
 * Run: node scripts/print-server-check.mjs
 */
import { request } from 'node:http'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { mimeForPath, startPrintServer } from '../src/print-server.js'

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
 * Ask one URL for a status while sending a forged Host header.
 *
 * `fetch` owns the Host header, so this check drops to node:http to prove the
 * server refuses DNS-rebinding requests that reach loopback with another name.
 * @param target - absolute URL.
 * @param host - Host header to send.
 * @returns the response status.
 */
function statusWithHost(target, host) {
  const parsed = new URL(target)
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: `${parsed.pathname}${parsed.search}`,
      headers: { host },
    }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    })
    req.on('error', reject)
    req.end()
  })
}

/**
 * Collapse a CSP header into its directive list for order-sensitive comparison.
 * @param value - raw header text.
 * @returns normalized directives.
 */
function cspDirectives(value) {
  return (value ?? '').split(';').map(part => part.trim()).filter(Boolean).join('; ')
}

const TOKEN = 'asset-token-1'
const EXPECTED_CSP = [
  "default-src 'none'",
  "img-src 'self' data:",
  "style-src 'unsafe-inline'",
  "font-src 'self' data:",
  "script-src 'none'",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'self'",
].join('; ')

const root = await mkdtemp(join(tmpdir(), 'dsh-md2pdf-print-server-'))
const outside = await mkdtemp(join(tmpdir(), 'dsh-md2pdf-print-server-outside-'))
let server = null
try {
  await writeFile(join(root, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  await writeFile(join(root, 'one.bin'), Buffer.alloc(8, 0x61))
  await writeFile(join(root, 'two.bin'), Buffer.alloc(8, 0x62))
  await writeFile(join(root, 'extra.bin'), Buffer.alloc(6, 0x63))
  await writeFile(join(root, '.hidden'), 'hidden')
  await mkdir(join(root, 'folder'))
  await writeFile(join(root, 'folder', 'inside.txt'), 'inside')
  await writeFile(join(outside, 'secret'), 'secret')
  await writeFile(join(outside, 'secret.txt'), 'secret')
  // A junction works on Windows without the file-symlink privilege; on macOS
  // and Linux the type argument is ignored and a normal directory symlink is made.
  await symlink(outside, join(root, 'outside'), 'junction')

  server = await startPrintServer({ html: '<h1>ok</h1>', assetRoot: root, assetToken: TOKEN })
  const url = server.url
  expectTrue('url is loopback with the token path',
    /^http:\/\/127\.0\.0\.1:\d+\/p\/asset-token-1\/$/.test(url))

  const document = await fetch(`${url}document.html`)
  expectEqual('document status', document.status, 200)
  expectEqual('document content type', document.headers.get('content-type'), 'text/html; charset=utf-8')
  expectEqual('document is served from memory', await document.text(), '<h1>ok</h1>')
  expectEqual('document csp', cspDirectives(document.headers.get('content-security-policy')), EXPECTED_CSP)
  expectEqual('document cache control', document.headers.get('cache-control'), 'no-store')
  expectEqual('document type sniffing is off', document.headers.get('x-content-type-options'), 'nosniff')

  const head = await fetch(`${url}document.html`, { method: 'HEAD' })
  expectEqual('head status', head.status, 200)
  expectEqual('head has no body', await head.text(), '')
  expectEqual('head carries the document length', head.headers.get('content-length'), String(Buffer.byteLength('<h1>ok</h1>')))

  const image = await fetch(`${url}img.png`)
  expectEqual('image status', image.status, 200)
  expectEqual('image content type', image.headers.get('content-type'), 'image/png')
  expectEqual('image bytes', (await image.arrayBuffer()).byteLength, 8)
  expectEqual('asset cache control', image.headers.get('cache-control'), 'no-store')
  expectEqual('asset type sniffing is off', image.headers.get('x-content-type-options'), 'nosniff')

  const limited = await startPrintServer({
    html: '<p>limited</p>',
    assetRoot: root,
    assetToken: 'limited-token',
    maxFileBytes: 4,
  })
  try {
    expectEqual('oversized asset', (await fetch(`${limited.url}img.png`)).status, 413)
    expectEqual('document is not subject to the asset ceiling', (await fetch(`${limited.url}document.html`)).status, 200)
  } finally {
    await limited.close()
  }

  // The 256 MiB default ceiling is too large to exercise; a tiny budget proves
  // the same arithmetic. The document is 11 bytes, so the budget below leaves
  // room for the document plus one 8-byte asset and less than two.
  const documentBytes = Buffer.byteLength('<h1>ok</h1>')
  const budget = await startPrintServer({
    html: '<h1>ok</h1>',
    assetRoot: root,
    assetToken: 'budget-token',
    maxFileBytes: 1024,
    maxTotalBytes: documentBytes + 8 + 7,
  })
  try {
    expectEqual('the document spends the total ceiling', (await fetch(`${budget.url}document.html`)).status, 200)
    expectEqual('the first asset fits the total ceiling', (await fetch(`${budget.url}one.bin`)).status, 200)
    expectEqual('the second asset exceeds the total ceiling', (await fetch(`${budget.url}two.bin`)).status, 413)
    expectEqual('a refused body does not spend the ceiling', (await fetch(`${budget.url}extra.bin`)).status, 200)
    expectEqual('a refetch exceeds the total ceiling', (await fetch(`${budget.url}one.bin`)).status, 413)
  } finally {
    await budget.close()
  }

  const tinyBudget = await startPrintServer({
    html: '<h1>ok</h1>',
    assetRoot: root,
    assetToken: 'tiny-budget-token',
    maxTotalBytes: 4,
  })
  try {
    expectEqual('the document obeys the total ceiling', (await fetch(`${tinyBudget.url}document.html`)).status, 413)
  } finally {
    await tinyBudget.close()
  }

  // Two concurrent requests must not both spend the same last byte allowance.
  // Whichever request reserves first wins, so the pair is always one 200 and
  // one 413, even though the server cannot predict the winning order.
  const race = await startPrintServer({
    html: '<h1>ok</h1>',
    assetRoot: root,
    assetToken: 'race-token',
    maxTotalBytes: 8,
  })
  try {
    const raced = await Promise.all([fetch(`${race.url}one.bin`), fetch(`${race.url}one.bin`)])
    expectEqual('concurrent bodies cannot overshoot the total ceiling',
      raced.map(response => response.status).sort().join(','), '200,413')
  } finally {
    await race.close()
  }

  const badBudget = await startPrintServer({
    html: '<p>bad budget</p>',
    assetRoot: root,
    assetToken: 'bad-budget-token',
    maxTotalBytes: 0,
  }).then(() => null, error => error)
  expectTrue('the total ceiling must be positive', badBudget instanceof TypeError)

  expectEqual('relative escape', (await fetch(`${url}../secret`)).status, 404)
  expectEqual('encoded escape', (await fetch(`${url}%2e%2e%2fsecret`)).status, 404)
  expectEqual('missing asset', (await fetch(`${url}missing.png`)).status, 404)
  expectEqual('symlink escape', (await fetch(`${url}outside/secret.txt`)).status, 404)
  expectEqual('symlink itself is not a file', (await fetch(`${url}outside`)).status, 404)
  expectEqual('directory', (await fetch(`${url}folder`)).status, 404)
  expectEqual('directory with slash', (await fetch(`${url}folder/`)).status, 404)
  expectEqual('dotfile', (await fetch(`${url}.hidden`)).status, 404)
  expectEqual('wrong token', (await fetch(`${url.replace(`/p/${TOKEN}/`, '/p/other-token/')}document.html`)).status, 404)

  const post = await fetch(`${url}document.html`, { method: 'POST' })
  expectEqual('post status', post.status, 405)
  expectEqual('post advertises the two allowed methods', post.headers.get('allow'), 'GET, HEAD')

  expectEqual('foreign host is refused', await statusWithHost(`${url}document.html`, 'evil.example'), 403)

  expectEqual('png mime', mimeForPath('/tmp/image.PNG'), 'image/png')
  expectEqual('woff2 mime', mimeForPath('font.woff2'), 'font/woff2')
  expectEqual('unknown mime', mimeForPath('asset.unknown'), 'application/octet-stream')

  const closing = server.close()
  await closing
  expectTrue('close is idempotent', server.close() === closing)
  server = null

  let refused = false
  try {
    await fetch(`${url}document.html`, { signal: AbortSignal.timeout(3000) })
  } catch {
    refused = true
  }
  expectTrue('closed server refuses connections', refused)
} finally {
  if (server !== null) await server.close()
  await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  await rm(outside, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
}

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`)
process.exit(failures === 0 ? 0 : 1)
