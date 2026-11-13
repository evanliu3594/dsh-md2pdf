/**
 * The one export operation: read a markdown file, render it, print it, and put
 * the PDF beside the source.
 *
 * Both callers — the browser route and the agent tool — enter here, so the
 * placement rule, the validation, and the failure vocabulary cannot drift
 * between what the user clicks and what the model calls.
 */
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'

import { DEFAULT_PAGE } from './document.js'
import { baseHrefOf, renderDocument } from './html-build.js'
import { describeEngines, PdfError, printPdf } from './pdf.js'
import { listPresets, readPreset } from './presets.js'
import { presetCssPath } from './presets.js'

/** File extensions this plugin treats as markdown. */
export const MARKDOWN_EXTENSIONS = Object.freeze(['.md', '.markdown', '.mdown', '.mkd', '.mdwn', '.mdx'])

/** One export per target; a second request for the same file joins the first. */
const inFlight = new Map()

/**
 * @param {string} path - a source path.
 * @returns whether the name carries a markdown extension.
 */
export function isMarkdownPath(path) {
  return MARKDOWN_EXTENSIONS.includes(extname(String(path)).toLowerCase())
}

/**
 * Resolve the request's path against its stated working directory.
 * @param path - absolute path, or one relative to `cwd`.
 * @param cwd - absolute directory used for a relative path.
 * @returns the absolute source path.
 */
function absoluteSource(path, cwd) {
  if (typeof path !== 'string' || path === '') {
    throw new PdfError('bad-request', 'path is required')
  }
  if (isAbsolute(path)) return resolve(path)
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
    throw new PdfError('bad-request', `relative path needs an absolute working directory: ${path}`)
  }
  return resolve(cwd, path)
}

/**
 * Coerce one page option, keeping the stylesheet inside values Chromium accepts.
 * @param page - caller-supplied overrides.
 * @returns the effective page geometry.
 */
function normalizePage(page) {
  const source = page ?? {}
  const size = typeof source.size === 'string' && /^[A-Za-z0-9]+$/.test(source.size)
    ? source.size
    : DEFAULT_PAGE.size
  const margin = Number(source.marginMm)
  const fontSize = Number(source.fontSize)
  return {
    size,
    marginMm: Number.isFinite(margin) ? Math.min(Math.max(margin, 0), 60) : DEFAULT_PAGE.marginMm,
    fontSize: Number.isFinite(fontSize) ? Math.min(Math.max(fontSize, 8), 24) : DEFAULT_PAGE.fontSize,
    landscape: source.landscape === true,
  }
}

/**
 * Export one markdown file to a PDF in the same directory.
 * @param request - `{ path, cwd?, page?, engine?, browserPath? }`.
 * @param options - process-level defaults merged under the request.
 * @returns the produced file, its printer, and the timings.
 * @throws {PdfError} for every refusal the caller can act on.
 */
export async function exportMarkdownToPdf(request, options = {}) {
  const sourcePath = absoluteSource(request?.path, request?.cwd)
  if (!isMarkdownPath(sourcePath)) {
    throw new PdfError('not-markdown', `not a markdown file: ${sourcePath}`)
  }
  const info = await stat(sourcePath).catch(() => null)
  if (info === null) throw new PdfError('not-found', `file not found: ${sourcePath}`)
  if (!info.isFile()) throw new PdfError('not-a-file', `not a regular file: ${sourcePath}`)

  const directory = dirname(sourcePath)
  const name = basename(sourcePath)
  const stem = name.slice(0, name.length - extname(name).length)
  const target = join(directory, `${stem}.pdf`)
  if (target === sourcePath) throw new PdfError('bad-request', 'the PDF target would replace the source file')

  const previous = inFlight.get(target)
  if (previous !== undefined) return previous

  const started = Date.now()
  const task = (async () => {
    const markdown = await readFile(sourcePath, 'utf8')
    if (markdown.includes('\u0000')) {
      throw new PdfError('not-text', `file is not plain text: ${sourcePath}`)
    }
    const page = normalizePage(request?.page ?? options.page)
    const engine = request?.engine ?? options.engine ?? 'auto'
    const browserPath = request?.browserPath ?? options.browserPath
    const { selected } = await listPresets()
    const preset = await readPreset(selected)

    const rendered = await renderDocument({
      markdown,
      title: stem,
      baseHref: baseHrefOf(directory),
      page,
      theme: selected,
      themeCss: preset.css,
      renderer: request?.renderer ?? options.renderer,
    }, { pandocPath: options.pandocPath })

    const printed = await printPdf(rendered.html, target, {
      page,
      engine,
      browserPath,
      timeoutMs: options.timeoutMs,
    })

    const written = await stat(target).catch(() => null)
    if (written === null || written.size === 0) {
      throw new PdfError('empty-output', `printer left no bytes at ${target}`)
    }
    return {
      ok: true,
      pdfPath: target,
      sourcePath,
      bytes: written.size,
      generator: rendered.generator,
      math: rendered.math,
      theme: rendered.theme,
      engine: printed.engine,
      printer: printed.printer,
      durationMs: Date.now() - started,
    }
  })()

  inFlight.set(target, task)
  try {
    return await task
  } finally {
    inFlight.delete(target)
  }
}

/**
 * Report what this Host can print with, once, for a capability check.
 * @param options - engine preference and explicit paths.
 * @returns the chosen engine, the alternatives found, and the render settings.
 */
export async function describeCapability(options = {}) {
  const [engines, library] = await Promise.all([describeEngines(options), listPresets()])
  const selected = library.selected
  return {
    engine: engines.chosen,
    available: engines.available,
    renderer: options.renderer ?? 'builtin',
    theme: selected,
    page: DEFAULT_PAGE,
    extensions: MARKDOWN_EXTENSIONS,
    cssPath: presetCssPath(selected),
  }
}
