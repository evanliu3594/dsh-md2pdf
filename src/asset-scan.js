/**
 * Asset references in a printable document.
 *
 * The DSH print page is served from one loopback directory, so only relative
 * references that stay inside the source directory can load. The browser
 * fallback keeps its own `file:` behaviour; this scan exists for the DSH path,
 * where a missing image would otherwise print as alt text with no explanation.
 *
 * The scan never throws. Every unusable reference becomes one warning string
 * and the export continues, which is what the client reports in its toast.
 */
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/** `<img src>` in a quoted or unquoted form. */
const IMG_SOURCE = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi

/** One CSS `url()` token, as used by background images and `@font-face`. */
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"']*))\s*\)/gi

/** A data URL is self-contained and needs no filesystem lookup. */
const DATA_URL = /^data:/i

/** An absolute URL scheme such as `https:` or `file:`. */
const URL_SCHEME = /^([a-z][a-z0-9+.-]*):/i

/** Ceiling on filesystem probes for one document. */
const MAX_ASSETS = 256

/**
 * Report whether a candidate path is a strict child of a base path.
 * @param base - normalized absolute base directory.
 * @param target - normalized absolute candidate.
 * @returns true when the candidate is inside the base and not the base itself.
 */
function inside(base, target) {
  const rel = relative(base, target)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/**
 * Decode the few entities a URL attribute may carry.
 * @param text - raw attribute text.
 * @returns the text with `&amp;` decoded.
 */
function decodeEntities(text) {
  return text.replace(/&amp;/gi, '&').trim()
}

/**
 * Collect unique, non-data asset references in document order.
 * @param html - complete printable markup.
 * @returns the references in the order the document mentions them.
 */
function assetReferences(html) {
  const text = typeof html === 'string' ? html : ''
  const references = []
  const seen = new Set()
  const add = (raw) => {
    const url = decodeEntities(raw ?? '')
    if (url === '' || url.startsWith('#') || DATA_URL.test(url) || seen.has(url)) return
    seen.add(url)
    references.push(url)
  }
  for (const match of text.matchAll(IMG_SOURCE)) add(match[1] ?? match[2] ?? match[3])
  for (const match of text.matchAll(CSS_URL)) add(match[1] ?? match[2] ?? match[3])
  return references
}

/**
 * Remove the query and fragment before resolving a local reference.
 * @param url - one asset reference.
 * @returns the path part.
 */
function pathOf(url) {
  const query = url.indexOf('?')
  const fragment = url.indexOf('#')
  let end = url.length
  if (query >= 0) end = Math.min(end, query)
  if (fragment >= 0) end = Math.min(end, fragment)
  return url.slice(0, end)
}

/**
 * Resolve one reference against the print asset directory.
 * @param url - one asset reference.
 * @param root - absolute source directory.
 * @param realRoot - the directory's canonical path.
 * @returns a warning for an unusable reference, or null when it can load.
 */
async function inspect(url, root, realRoot) {
  if (url.startsWith('//')) {
    return `remote asset blocked by the print policy: ${url}`
  }
  const scheme = URL_SCHEME.exec(url)
  if (scheme !== null) {
    const name = scheme[1].toLowerCase()
    if (name === 'http' || name === 'https') {
      return `remote asset blocked by the print policy: ${url}`
    }
    return `unsupported asset scheme: ${url}`
  }

  const rawPath = pathOf(url)
  let decoded
  try {
    decoded = decodeURIComponent(rawPath)
  } catch {
    return `asset reference could not be decoded: ${url}`
  }
  if (decoded.includes('\\')) {
    return `unsupported asset reference: ${url}`
  }
  if (decoded.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(decoded)) {
    return `asset outside the source directory: ${url}`
  }

  const candidate = resolve(root, decoded)
  if (!inside(root, candidate)) {
    return `asset outside the source directory: ${url}`
  }
  // Dotfiles are never served; `./` and `../` inside the root are ordinary URL
  // navigation, which resolve() has already folded into the candidate path.
  if (relative(root, candidate).split(sep).some(segment => segment.startsWith('.'))) {
    return `unsupported asset path: ${url}`
  }

  // The print server rejects a symbolic link at any segment, so an asset that
  // reaches its file through a link is warned here rather than served later.
  let info = null
  let current = root
  for (const segment of relative(root, candidate).split(sep)) {
    current = join(current, segment)
    info = await lstat(current).catch(() => null)
    if (info === null) return `missing asset: ${url}`
    if (info.isSymbolicLink()) return `unsupported asset path: ${url}`
  }
  if (info === null || !info.isFile()) {
    return `asset is not a regular file: ${url}`
  }
  try {
    if (!inside(realRoot, await realpath(candidate))) {
      return `asset outside the source directory: ${url}`
    }
  } catch {
    return `missing asset: ${url}`
  }
  return null
}

/**
 * Report every asset reference the DSH print page cannot load.
 *
 * Only references written into `<img src>` and CSS `url()` are checked. Data
 * URLs are self-contained and skipped. A remote URL is a warning because the
 * print CSP blocks it; a relative path outside the source directory, a missing
 * file, a directory, a dotfile, or a symlink escape is a warning for the same
 * reason. The caller keeps printing.
 * @param html - complete printable markup.
 * @param assetRoot - directory the DSH print server serves assets from.
 * @returns one warning per unusable reference, in document order.
 */
export async function scanAssets(html, assetRoot) {
  if (typeof assetRoot !== 'string' || assetRoot === '') return []
  const root = resolve(assetRoot)
  let realRoot = root
  try {
    realRoot = await realpath(root)
  } catch {
    // A missing root makes every relative reference unusable; the stat below
    // reports each one as missing rather than failing the whole scan.
  }

  const references = assetReferences(html)
  const warnings = []
  if (references.length > MAX_ASSETS) {
    warnings.push(`more than ${MAX_ASSETS} asset references; the rest were not checked`)
  }
  const inspected = await Promise.all(
    references.slice(0, MAX_ASSETS).map(url => inspect(url, root, realRoot)),
  )
  for (const warning of inspected) {
    if (warning !== null && !warnings.includes(warning)) warnings.push(warning)
  }
  return warnings
}
