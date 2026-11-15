/**
 * Markdown to printable HTML.
 *
 * Two generators share one shell and one stylesheet. pandoc, when installed,
 * contributes richer fidelity — TeX math as MathML, footnotes, definition
 * lists, exact CommonMark edge cases. The built-in renderer stands in when
 * pandoc is absent, so the export never depends on a tool the user may not
 * have. Both produce the same frontmatter block and the same CSS contract.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import { PAPER_FIELDS } from './document-config.js'
import { buildHtml, DEFAULT_PAGE } from './document.js'
import { loadMathRenderer } from './math.js'
import { addHeadingIds, renderFrontmatter, renderMarkdown, splitFrontmatter, tocHtml } from './markdown.js'
import { run, which } from './proc.js'

/**
 * pandoc reader configuration.
 *
 * The base is `gfm` — the CommonMark dialect the DSH preview shows, so the PDF
 * agrees with what the reader saw on screen. pandoc's own `markdown` reader is
 * stricter in one visible way: it refuses to start a list on the line after a
 * paragraph unless a blank line separates them, which turns the common Chinese
 * pattern `说明文字：` followed by `- 条目` into a paragraph. Two adjustments ride
 * on top of the base: TeX math, which GFM lacks, and no emoji substitution, so
 * `:name:` in technical prose stays literal.
 */
const PANDOC_READER = 'gfm-emoji+tex_math_dollars'

/** Elements removed from third-party HTML before it reaches the printed page. */
const DROPPED_ELEMENTS = /<(script|iframe|object|embed|template)\b[\s\S]*?<\/\1\s*>/gi

/**
 * Remove executable markup from a generated fragment.
 * @param html - markup from pandoc or a raw HTML block.
 * @returns the fragment without script-bearing elements or inline handlers.
 */
export function sanitizeFragment(html) {
  return html
    .replace(DROPPED_ELEMENTS, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '')
}

/**
 * Fold pandoc's layout hints into the stylesheet's own table rules.
 *
 * pandoc writes a `<colgroup>` of percentage widths and an inline table width
 * from its own heuristics. Those numbers make a numeric column wide and a text
 * column narrow, which no reader expects. Dropping them lets the browser size
 * columns by content, exactly as the built-in renderer's tables already do.
 * @param html - the pandoc fragment.
 * @returns the fragment without per-table width overrides.
 */
export function normalizePandocFragment(html) {
  return html
    .replace(/<colgroup>[\s\S]*?<\/colgroup>\s*/gi, '')
    .replace(/(<table[^>]*?)\s+style\s*=\s*("[^"]*"|'[^']*')/gi, '$1')
}

/**
 * Replace a standalone page-break comment with the break element.
 *
 * The built-in renderer emits the element itself; pandoc passes the raw HTML
 * comment through. Only a whole line is a directive: an inline comment and a
 * comment inside preformatted content stay literal, so a code sample never
 * turns into a page break.
 * @param html - a rendered document body.
 * @returns the body with standalone page-break comments replaced.
 */
export function normalizePageBreaks(html) {
  const held = []
  const protectedText = String(html).replace(/<(pre|code)\b[\s\S]*?<\/\1\s*>/gi, (match) => {
    held.push(match)
    return '\u0000' + (held.length - 1) + '\u0000'
  })
  const replaced = protectedText.replace(
    /^[ \t]*<!--[ \t]*pagebreak[ \t]*-->[ \t]*$/gmi,
    '<div class="md2pdf-pagebreak"></div>',
  )
  return replaced.replace(/\u0000(\d+)\u0000/g, (_match, index) => held[Number(index)] ?? '')
}

/**
 * Escape one value for an HTML text node.
 * @param value - raw text.
 * @returns the escaped text.
 */
function escapeText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Paper-template field labels by document language. */
const PAPER_LABELS = {
  zh: { abstract: '摘要：', keywords: '关键词：' },
  en: { abstract: 'Abstract: ', keywords: 'Keywords: ' },
}

/**
 * Render the paper template's own fields.
 *
 * These fields describe one paper, so they belong to the built-in paper
 * template only; a custom preset lays its document out with its own CSS. The
 * block is ordinary escaped text. There is no separate cover page: the block
 * is the first content of the body page.
 * @param paper - `pdf.paper.*` fields.
 * @param options - the document language.
 * @returns the paper block, empty when no field is set.
 */
export function renderPaperBlock(paper, options = {}) {
  if (paper === null || typeof paper !== 'object') return ''
  const fields = {}
  for (const key of PAPER_FIELDS) {
    const value = paper[key]
    if (typeof value === 'string' && value.trim() !== '') fields[key] = value.trim()
  }
  if (Object.keys(fields).length === 0) return ''
  // The TOC and the paper labels share one rule: Chinese for zh, English for
  // every other language, so a third language never mixes the two.
  const lang = typeof options.lang === 'string' ? options.lang.toLowerCase() : 'zh-cn'
  const labels = lang.startsWith('zh') ? PAPER_LABELS.zh : PAPER_LABELS.en
  const rows = []
  if (fields.title !== undefined) rows.push(`<p class="md2pdf-paper-title">${escapeText(fields.title)}</p>`)
  if (fields.authors !== undefined) rows.push(`<p class="md2pdf-paper-authors">${escapeText(fields.authors)}</p>`)
  if (fields.affiliations !== undefined) {
    rows.push(`<p class="md2pdf-paper-affiliations">${escapeText(fields.affiliations)}</p>`)
  }
  if (fields.date !== undefined) rows.push(`<p class="md2pdf-paper-date">${escapeText(fields.date)}</p>`)
  if (fields.abstract !== undefined) {
    rows.push(`<p class="md2pdf-paper-abstract"><span class="md2pdf-paper-label">`
      + `${escapeText(labels.abstract)}</span>${escapeText(fields.abstract)}</p>`)
  }
  if (fields.keywords !== undefined) {
    rows.push(`<p class="md2pdf-paper-keywords"><span class="md2pdf-paper-label">`
      + `${escapeText(labels.keywords)}</span>${escapeText(fields.keywords)}</p>`)
  }
  return `<section class="md2pdf-paper">\n${rows.join('\n')}\n</section>`
}

/**
 * Locate pandoc once per call; the path may change between user sessions.
 * @param options - explicit executable or a directory to search first.
 * @returns the resolved executable, or null.
 */
export async function findPandoc(options = {}) {
  if (typeof options.pandocPath === 'string' && options.pandocPath !== '') {
    return which(options.pandocPath)
  }
  return which('pandoc')
}

/**
 * Render the document body with pandoc.
 *
 * The body travels through a scratch file rather than stdin: a redirect needs
 * no pipe, so the call works under a sandbox that refuses to create one.
 * @param markdown - the body, frontmatter already removed.
 * @param pandoc - resolved pandoc executable.
 * @param timeoutMs - deadline for the conversion.
 * @returns the HTML fragment, or null when pandoc refuses the document.
 */
async function pandocBody(markdown, pandoc, timeoutMs) {
  const work = await mkdtemp(join(tmpdir(), 'dsh-md2pdf-pandoc-'))
  const sourcePath = join(work, 'document.md')
  try {
    await writeFile(sourcePath, markdown, 'utf8')
    const result = await run(pandoc, [
      '--from', PANDOC_READER,
      '--to', 'html5',
      '--mathml',
      '--no-highlight',
      '--wrap=none',
      sourcePath,
    ], { timeoutMs })
    if (result.code !== 0) return null
    return result.stdout
  } finally {
    await rm(work, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  }
}

/**
 * Build the complete printable page for one markdown document.
 *
 * The built-in renderer is the default: every install then produces the same
 * paper, with no dependence on a tool the machine happens to have. pandoc and
 * Temml are opt-in refinements, and their absence changes nothing else.
 * @param input - markdown text, title, base URL, page geometry, page override
 *   CSS, and user CSS.
 * @param options - renderer choice and pandoc discovery overrides.
 * @returns the HTML document, the generator that produced its body, and the
 *   typesetter used for TeX.
 */
export async function renderDocument(input, options = {}) {
  const page = { ...DEFAULT_PAGE, ...(input.page ?? {}) }
  const markdown = String(input.markdown ?? '').replace(/\r\n?/g, '\n')
  const { frontmatter, body } = splitFrontmatter(markdown)

  let bodyHtml = null
  let generator = 'builtin'
  const requested = input.renderer ?? options.renderer ?? 'builtin'
  if (requested === 'pandoc' || requested === 'auto') {
    const pandoc = await findPandoc(options)
    if (pandoc !== null) {
      const fragment = await pandocBody(body, pandoc, options.pandocTimeoutMs ?? 60_000)
      if (fragment !== null) {
        bodyHtml = sanitizeFragment(normalizePandocFragment(fragment))
        generator = 'pandoc'
      }
    }
  }

  let math = false
  if (bodyHtml === null) {
    const mathRenderer = await loadMathRenderer()
    math = mathRenderer !== null
    // The built-in renderer assigns ids itself; the shared pass below keeps the
    // pandoc and built-in bodies on one anchor scheme.
    bodyHtml = renderMarkdown(body, math ? { math: mathRenderer } : {}).body
  }

  const identified = addHeadingIds(normalizePageBreaks(bodyHtml))
  const theme = input.theme ?? 'default'
  // The TOC is built from the same ids the body carries, so every link resolves
  // in the PDF viewer. The paper block belongs to the built-in paper template.
  const toc = input.toc === true ? tocHtml(identified.headings, { lang: input.lang }) : ''
  const paper = theme === 'paper' ? renderPaperBlock(input.paper, { lang: input.lang }) : ''

  return {
    generator,
    math,
    theme,
    html: buildHtml({
      title: input.title,
      lang: input.lang,
      baseHref: input.baseHref,
      frontmatter: renderFrontmatter(frontmatter),
      paper,
      toc,
      body: identified.html,
      bodyAfterToc: toc !== '',
      themeCss: input.themeCss,
      customCss: input.customCss,
      pageCss: input.pageCss,
    }, page),
  }
}

/**
 * A `file:` base URL for one directory, with the trailing separator the browser
 * needs to treat it as a directory rather than as a file.
 * @param directory - absolute directory path.
 * @returns the base URL text.
 */
export function baseHrefOf(directory) {
  const withSeparator = directory.endsWith(sep) ? directory : `${directory}${sep}`
  return pathToFileURL(withSeparator).href
}
