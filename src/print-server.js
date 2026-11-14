/**
 * The one-shot loopback server that feeds the DSH print webview.
 *
 * DSH's webview session blocks `file:`, so a print job must deliver its HTML,
 * images, and fonts over HTTP. This server lives only as long as one job:
 * `document.html` comes from memory, assets come from the source file's
 * directory under a random token path, and `close()` destroys every connection.
 *
 * The path jail checks each request twice. Every relative path segment is
 * rejected when it is empty, a dotfile, or a symbolic link; then `realpath`
 * must still land inside the asset root, which also catches a symlinked parent
 * swapped in after the first check. Only regular files under the per-file
 * ceiling are read. Directories, devices, and directory listings do not exist
 * here.
 */
import { lstat, readFile, realpath } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'

/** The only address the server binds and accepts in its Host header. */
const LOOPBACK = '127.0.0.1'

/** Content file names never served as assets. */
const DOCUMENT_NAME = 'document.html'

/** The page CSP from `docs/DESIGN.md`; scripts, frames, forms, and connect are off. */
const CSP = [
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

/** Asset extensions mapped to the MIME type the print webview needs. */
const MIME_TYPES = new Map([
  ['.html', 'text/html'],
  ['.htm', 'text/html'],
  ['.css', 'text/css'],
  ['.txt', 'text/plain'],
  ['.json', 'application/json'],
  ['.xml', 'application/xml'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.avif', 'image/avif'],
  ['.bmp', 'image/bmp'],
  ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.otf', 'font/otf'],
  ['.eot', 'application/vnd.ms-fontobject'],
])

/**
 * Resolve the MIME type of one asset path.
 * @param path - a file path or pathname with an extension.
 * @returns the MIME type, or `application/octet-stream` when unknown.
 */
export function mimeForPath(path) {
  const extension = typeof path === 'string' ? extname(path).toLowerCase() : ''
  return MIME_TYPES.get(extension) ?? 'application/octet-stream'
}

/**
 * Headers every response carries: the page policy, no caching, and no sniffing.
 * @returns a fresh header object.
 */
function securityHeaders() {
  return {
    'cache-control': 'no-store',
    'content-security-policy': CSP,
    'x-content-type-options': 'nosniff',
  }
}

/**
 * Answer one request without a body.
 * @param res - the response to finish.
 * @param status - HTTP status.
 * @param extra - additional headers.
 */
function sendEmpty(res, status, extra = {}) {
  res.writeHead(status, { ...securityHeaders(), ...extra })
  res.end()
}

/**
 * Report whether a candidate path is a strict child of a base path.
 * @param base - normalized absolute base directory.
 * @param target - normalized absolute candidate.
 * @returns true when the candidate is inside the base and not the base itself.
 */
function inside(base, target) {
  const rel = relative(base, target)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * Start a loopback server for one rendered document.
 *
 * The server is bound to an operating-system-assigned port on `127.0.0.1`.
 * The returned `url` ends with `/p/<assetToken>/`, so relative image and font
 * URLs in the document resolve under the token gate.
 * @param options - document html, asset directory, token, and size ceiling.
 * @param options.html - the complete printable HTML page, served from memory.
 * @param options.assetRoot - directory holding the markdown source and its assets.
 * @param options.assetToken - random token that forms the URL path prefix.
 * @param options.maxFileBytes - largest asset the server will read.
 * @returns the loopback base URL and an idempotent close function.
 */
export async function startPrintServer({
  html,
  assetRoot,
  assetToken,
  maxFileBytes = 32 * 1024 * 1024,
} = {}) {
  if (typeof html !== 'string') throw new TypeError('html must be text')
  if (typeof assetRoot !== 'string' || assetRoot === '') {
    throw new TypeError('assetRoot must be a directory path')
  }
  if (typeof assetToken !== 'string' || assetToken === '') {
    throw new TypeError('assetToken must be text')
  }
  if (!Number.isFinite(maxFileBytes) || maxFileBytes <= 0) {
    throw new TypeError('maxFileBytes must be a positive number')
  }

  const root = resolve(assetRoot)
  const rootReal = await realpath(root)
  const htmlBytes = Buffer.from(html, 'utf8')
  const prefix = `/p/${assetToken}/`
  const sockets = new Set()
  let expectedHost = ''
  let url = ''
  let closePromise = null

  /**
   * Resolve one asset request into file bytes, or refuse it.
   * @param encoded - the path after the token prefix, still URL-encoded.
   * @returns the file metadata and bytes, an oversize marker, or null.
   */
  async function assetOf(encoded) {
    let decoded
    try {
      decoded = decodeURIComponent(encoded)
    } catch {
      return null
    }
    if (decoded === '' || decoded.includes('\\') || decoded.includes('\0')) return null
    if (/[\u0000-\u001f\u007f]/.test(decoded)) return null

    const segments = decoded.split('/')
    if (segments.some(segment => segment === '' || segment.startsWith('.'))) return null

    const candidate = resolve(root, ...segments)
    if (!inside(root, candidate)) return null

    let info = null
    let current = root
    for (const segment of segments) {
      current = join(current, segment)
      info = await lstat(current).catch(() => null)
      if (info === null || info.isSymbolicLink()) return null
    }
    if (info === null || !info.isFile()) return null
    if (info.size > maxFileBytes) return { tooLarge: true }

    let real
    try {
      real = await realpath(candidate)
    } catch {
      return null
    }
    if (!inside(rootReal, real)) return null

    const data = await readFile(real).catch(() => null)
    if (data === null) return null
    if (data.length > maxFileBytes) return { tooLarge: true }
    return { data, type: mimeForPath(candidate) }
  }

  /**
   * Answer one request after the Host header has been checked.
   * @param req - the HTTP request.
   * @param res - the HTTP response.
   */
  async function respond(req, res) {
    if (req.headers.host !== expectedHost) return sendEmpty(res, 403)
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendEmpty(res, 405, { allow: 'GET, HEAD' })
    }

    let pathname
    try {
      pathname = new URL(req.url ?? '/', url).pathname
    } catch {
      return sendEmpty(res, 404)
    }
    if (!pathname.startsWith(prefix)) return sendEmpty(res, 404)

    const encoded = pathname.slice(prefix.length)
    if (encoded === DOCUMENT_NAME) {
      res.writeHead(200, {
        ...securityHeaders(),
        'content-type': 'text/html; charset=utf-8',
        'content-length': String(htmlBytes.length),
      })
      res.end(req.method === 'HEAD' ? undefined : htmlBytes)
      return
    }

    const asset = await assetOf(encoded)
    if (asset === null) return sendEmpty(res, 404)
    if (asset.tooLarge === true) return sendEmpty(res, 413)
    res.writeHead(200, {
      ...securityHeaders(),
      'content-type': asset.type,
      'content-length': String(asset.data.length),
    })
    res.end(req.method === 'HEAD' ? undefined : asset.data)
  }

  const server = createServer((req, res) => {
    respond(req, res).catch(() => {
      if (!res.headersSent) sendEmpty(res, 500)
      else res.destroy()
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })

  await new Promise((resolveListen, rejectListen) => {
    const onError = (error) => {
      server.off('listening', onListening)
      rejectListen(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolveListen()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(0, LOOPBACK)
  })

  const port = server.address().port
  expectedHost = `${LOOPBACK}:${port}`
  url = `http://${expectedHost}${prefix}`

  /**
   * Stop accepting connections, destroy the live ones, and resolve when closed.
   * @returns a promise that settles with the server's close event.
   */
  function close() {
    if (closePromise !== null) return closePromise
    closePromise = new Promise((resolveClose) => {
      server.close(() => resolveClose())
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
      for (const socket of sockets) socket.destroy()
    })
    return closePromise
  }

  return { url, close }
}
