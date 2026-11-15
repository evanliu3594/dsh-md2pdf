/**
 * A dependency-free Markdown renderer: the default document generator, so a
 * published install produces the same paper on every machine.
 *
 * Scope: CommonMark core blocks and inlines, the GitHub extensions a document
 * preview shows — GFM tables, task lists, strikethrough, autolinks — footnotes,
 * TeX math (delegated to a typesetter the caller supplies), and a leading YAML
 * frontmatter block rendered as a field list.
 *
 * Every emitted string is either produced here or escaped by {@link escapeHtml}.
 * Raw HTML blocks pass through after script-bearing elements are removed.
 */

/** Block tags whose line may open an HTML block passthrough. */
const HTML_BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body', 'caption', 'center', 'col',
  'colgroup', 'dd', 'details', 'dialog', 'dir', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure',
  'footer', 'form', 'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hr',
  'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'menuitem', 'nav', 'noframes', 'ol',
  'optgroup', 'option', 'p', 'param', 'section', 'source', 'summary', 'table', 'tbody', 'td', 'tfoot',
  'th', 'thead', 'title', 'tr', 'track', 'ul', 'video', 'audio', 'canvas', 'svg', 'math', 'picture',
  'pre', 'script', 'style', 'template', 'textarea',
])

/** Tags removed with their content before a passthrough block reaches the page. */
const DROPPED_HTML = /<(script|style|iframe|object|embed|template)\b[\s\S]*?<\/\1\s*>/gi

const LIST_MARKER = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+|$)/

/** Escape text for an HTML text node or a quoted attribute value. */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Strip the HTML that could execute or frame content in a printed document. */
function sanitizeRawHtml(html) {
  return html
    .replace(DROPPED_HTML, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '')
}

/** Whether a line holds nothing but whitespace. */
function isBlank(line) {
  return line.trim() === ''
}

/** Leading whitespace width, with a tab counting as four columns. */
function indentOf(line) {
  let width = 0
  for (const character of line) {
    if (character === ' ') width += 1
    else if (character === '\t') width += 4 - (width % 4)
    else break
  }
  return width
}

/** Remove `width` columns of leading whitespace from a line. */
function stripIndent(line, width) {
  let consumed = 0
  let index = 0
  while (index < line.length && consumed < width) {
    const character = line[index]
    if (character === ' ') consumed += 1
    else if (character === '\t') consumed += 4 - (consumed % 4)
    else break
    index += 1
  }
  return line.slice(index)
}

/**
 * Render one TeX fragment when no typesetter was supplied: the source stays
 * visible in a monospace wrapper instead of disappearing.
 */
function fallbackMath(tex) {
  return `<span class="math">${escapeHtml(tex)}</span>`
}

/**
 * @typedef {object} RenderContext
 * @property {(tex: string, display: boolean) => string} math - TeX renderer.
 * @property {Map<string, string>} notes - footnote bodies by label.
 * @property {Map<string, number>} noteOrder - footnote label to assigned number.
 */

/**
 * A context with no footnotes and the fallback typesetter.
 * @param {Partial<RenderContext>} [overrides] - supplied fields.
 * @returns the context.
 */
function createContext(overrides = {}) {
  const supplied = overrides.math
  // A typesetter that declines one formula must not delete it from the page.
  const math = typeof supplied === 'function'
    ? (tex, display) => {
      const markup = supplied(tex, display === true)
      return typeof markup === 'string' && markup !== '' ? markup : fallbackMath(tex)
    }
    : fallbackMath
  return {
    math,
    notes: overrides.notes ?? new Map(),
    noteOrder: overrides.noteOrder ?? new Map(),
  }
}

/** Split a leading `---` fenced frontmatter block from the document body. */
export function splitFrontmatter(source) {
  const lines = source.split('\n')
  if (lines.length === 0 || lines[0].trim() !== '---') return { frontmatter: null, body: source }
  for (let index = 1; index < lines.length; index += 1) {
    const fence = lines[index].trim()
    if (fence === '---' || fence === '...') {
      return {
        frontmatter: lines.slice(1, index).join('\n'),
        body: lines.slice(index + 1).join('\n'),
      }
    }
  }
  return { frontmatter: null, body: source }
}

/**
 * Parse a leading frontmatter block into flat fields.
 *
 * v2 uses flat keys only, so one `key: value` line is one field. An indented
 * line starts a nested structure and is ignored rather than misread; a line
 * without a colon carries no field. Quotes around a value are removed. Values
 * stay text because the document-config parser decides whether a field is a
 * boolean, a number, or ordinary text.
 * @param source - YAML between the fences, or null.
 * @returns the flat fields in source order.
 */
export function parseFrontmatter(source) {
  const fields = {}
  if (typeof source !== 'string') return fields
  for (const raw of source.split('\n')) {
    if (raw.trim() === '' || /^\s/.test(raw)) continue
    const separator = raw.indexOf(':')
    if (separator <= 0) continue
    const key = raw.slice(0, separator).trim()
    if (key === '') continue
    fields[key] = raw.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '')
  }
  return fields
}

/**
 * Render frontmatter as a two-column field list.
 *
 * Flat `pdf.*` keys configure the export rather than describe the document, so
 * they stay out of the visible field table. Ordinary keys such as `title`,
 * `author`, `date` and `tags` still render.
 * @param source - YAML between the fences, or null.
 * @returns the block markup, empty when the block has no fields.
 */
export function renderFrontmatter(source) {
  if (source === null) return ''
  const rows = []
  for (const [key, value] of Object.entries(parseFrontmatter(source))) {
    // pdf.* keys configure the export; lang picks the TOC and paper labels.
    // Neither describes the document content.
    if (key.startsWith('pdf.') || key === 'lang') continue
    rows.push(`<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(value)}</td></tr>`)
  }
  if (rows.length === 0) return ''
  return `<table class="frontmatter"><tbody>${rows.join('')}</tbody></table>`
}

/** Named HTML entities decoded before a heading becomes a slug and TOC label. */
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', times: '×', divide: '÷',
  deg: '°', plusmn: '±', micro: 'µ', middot: '·', bull: '•', dagger: '†',
  laquo: '«', raquo: '»', euro: '€', pound: '£', yen: '¥', cent: '¢',
  sect: '§', para: '¶', eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç',
  uuml: 'ü', ouml: 'ö', auml: 'ä', szlig: 'ß', aacute: 'á', iacute: 'í',
  oacute: 'ó', uacute: 'ú', ntilde: 'ñ', Aacute: 'Á', Eacute: 'É', Iacute: 'Í',
  Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', zeta: 'ζ',
  eta: 'η', theta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν',
  xi: 'ξ', omicron: 'ο', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ',
  phi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Alpha: 'Α', Beta: 'Β', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ',
  Mu: 'Μ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
}

/**
 * Decode the HTML entities a heading may contain.
 *
 * Numeric references are decoded generally; the named table covers the
 * ordinary typography a document uses. An unknown name stays literal, exactly
 * as a browser shows an invalid reference.
 * @param text - text with entities.
 * @returns the decoded text.
 */
function decodeEntities(text) {
  return text.replace(/&(#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi, (match, body) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X'
      const code = hex ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match
      try {
        return String.fromCodePoint(code)
      } catch {
        return match
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match
  })
}

/**
 * Read the visible text of one rendered inline fragment.
 *
 * MathML annotations, pandoc footnote references, and the built-in footnote
 * superscripts are removed, because they are metadata rather than visible
 * heading text. Tags are then stripped and entities decoded.
 * @param html - rendered inline markup.
 * @returns the visible text.
 */
function plainTextOf(html) {
  return decodeEntities(String(html)
    .replace(/<annotation\b[^>]*>[\s\S]*?<\/annotation\s*>/gi, '')
    .replace(/<a\b[^>]*class="[^"]*footnote-ref[^"]*"[^>]*>[\s\S]*?<\/a\s*>/gi, '')
    .replace(/<sup class="footnote-ref"[\s\S]*?<\/sup>/gi, '')
    // A comment is invisible, so its protected placeholder must not join the
    // visible text. This also covers an inline comment inside a heading.
    .replace(/\u0000\d+\u0000/g, '')
    .replace(/<[^>]*>/g, ''))
}

/**
 * Build the anchor slug for one heading.
 *
 * Unicode letters and digits stay, so a Chinese heading keeps a readable
 * anchor. Latin text is lower-cased, whitespace and punctuation collapse to a
 * single hyphen, and a heading with no letters falls back to the literal
 * \`section\`.
 * @param text - the heading's visible text.
 * @returns the slug, never empty.
 */
function slugOf(text) {
  const slug = String(text)
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\s\u00a0]+/g, '-')
    .replace(/[^\p{Letter}\p{Number}-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug === '' ? 'section' : slug
}

/** A rendered heading element; quoted attributes may contain a greater-than. */
const HEADING_TAG = /<h([1-6])\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/h\1\s*>/gi

/**
 * Remove one id attribute from a start tag's attribute text.
 *
 * Attributes are read as whole tokens, so an \`id\` substring inside another
 * attribute's quoted value is not touched.
 * @param attributes - attribute text after the tag name.
 * @returns the attribute text without an id.
 */
function withoutIdAttribute(attributes) {
  let result = ''
  let last = 0
  const pattern = /\s+([^\s=/>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g
  for (const match of attributes.matchAll(pattern)) {
    result += attributes.slice(last, match.index)
    if (match[1].toLowerCase() !== 'id') result += match[0]
    last = match.index + match[0].length
  }
  return result + attributes.slice(last)
}

/**
 * Give every heading a stable id and report them in document order.
 *
 * The ids are the TOC's link targets and the PDF outline's anchors. An id the
 * generator already wrote is replaced, so both generators share one scheme; a
 * repeated slug gains \`-2\`, \`-3\` and so on until the id is unique. Headings
 * inside an HTML comment are left alone: a commented-out section is not part of
 * the visible document.
 * @param html - a rendered document body.
 * @returns the body with ids, and the headings in order.
 */
export function addHeadingIds(html) {
  const comments = []
  const protectedHtml = String(html ?? '').replace(/<!--[\s\S]*?-->/g, (match) => {
    comments.push(match)
    return '\u0000' + (comments.length - 1) + '\u0000'
  })
  const used = new Set()
  const headings = []
  const body = protectedHtml.replace(HEADING_TAG, (_match, level, attributes, inner) => {
    const label = plainTextOf(inner).trim() || 'section'
    const base = 'md2pdf-h-' + slugOf(label)
    let id = base
    let suffix = 1
    while (used.has(id)) {
      suffix += 1
      id = base + '-' + suffix
    }
    used.add(id)
    headings.push({ level: Number(level), id, label })
    const rest = withoutIdAttribute(attributes)
    return '<h' + level + ' id="' + id + '"' + rest + '>' + inner + '</h' + level + '>'
  })
  const restored = body.replace(/\u0000(\d+)\u0000/g, (_match, index) => comments[Number(index)] ?? '')
  return { html: restored, headings }
}

/**
 * Build the clickable table of contents.
 *
 * Only h1-h3 are listed; deeper headings still carry ids but stay out of the
 * TOC. The list has no page numbers, because a second layout pass is what
 * numbering needs and v2 does not do one. The title follows the document
 * language.
 * @param headings - headings reported by {@link addHeadingIds}.
 * @param options - the document language.
 * @returns the TOC block markup, empty without a listed heading.
 */
export function tocHtml(headings, options = {}) {
  const items = Array.isArray(headings)
    ? headings.filter(heading => heading.level >= 1 && heading.level <= 3)
    : []
  if (items.length === 0) return ''
  const lang = typeof options.lang === 'string' && options.lang !== '' ? options.lang : 'zh-CN'
  const title = lang.toLowerCase().startsWith('zh') ? '目录' : 'Contents'
  const links = items.map(heading => `<li class="md2pdf-toc-level-${heading.level}">`
    + `<a href="#${heading.id}">${escapeHtml(heading.label)}</a></li>`).join('\n')
  return `<nav class="md2pdf-toc">\n<p class="md2pdf-toc-title">${escapeHtml(title)}</p>\n`
    + `<ol>\n${links}\n</ol>\n</nav>`
}

/**
 * Lift `[^label]: body` definitions out of the block stream.
 * @param lines - document lines.
 * @returns the notes by label and the remaining lines.
 */
function extractFootnotes(lines) {
  const notes = new Map()
  const kept = []
  let index = 0
  while (index < lines.length) {
    const opening = /^[ \t]{0,3}\[\^([^\]]+)\]:[ \t]?(.*)$/.exec(lines[index])
    if (opening === null) {
      kept.push(lines[index])
      index += 1
      continue
    }
    const body = [opening[2]]
    index += 1
    while (index < lines.length) {
      if (isBlank(lines[index])) {
        const next = lines[index + 1]
        if (next !== undefined && /^[ \t]{2,}\S/.test(next)) {
          body.push('')
          index += 1
          continue
        }
        break
      }
      if (!/^[ \t]{2,}\S/.test(lines[index])) break
      body.push(lines[index].trim())
      index += 1
    }
    notes.set(opening[1], body.join('\n').trim())
  }
  return { notes, kept }
}

/**
 * Render one footnote reference.
 * @param label - the definition label.
 * @param ctx - render context carrying the note bodies and their order.
 * @returns the superscript, or the literal source when the label is unknown.
 */
function footnoteRef(label, ctx) {
  if (!ctx.notes.has(label)) return `[^${escapeHtml(label)}]`
  let number = ctx.noteOrder.get(label)
  if (number === undefined) {
    number = ctx.noteOrder.size + 1
    ctx.noteOrder.set(label, number)
  }
  return `<sup class="footnote-ref"><a href="#fn-${number}" id="fnref-${number}">${number}</a></sup>`
}

/**
 * Render the trailing footnote list.
 * @param ctx - render context after the body has been rendered.
 * @returns the section markup, empty without referenced notes.
 */
function footnoteSection(ctx) {
  if (ctx.noteOrder.size === 0) return ''
  const items = []
  for (const [label, number] of ctx.noteOrder) {
    const body = ctx.notes.get(label) ?? ''
    const markup = renderBlocks(body.split('\n'), ctx).replace(/^<p>([\s\S]*?)<\/p>$/, '$1')
    items.push(`<li id="fn-${number}">${markup} <a class="footnote-back" href="#fnref-${number}">\u21a9</a></li>`)
  }
  return `<section class="footnotes"><ol>${items.join('')}</ol></section>`
}

/**
 * Render inline Markdown to HTML.
 * @param text - one paragraph-level chunk of inline source.
 * @param [ctx] - render context; a fallback typesetter is used when omitted.
 * @returns escaped markup.
 */
export function renderInline(text, ctx = createContext()) {
  const slots = []
  /** Park a rendered fragment so later passes cannot rewrite its markup. */
  const hold = (html) => `\u0000${slots.push(html) - 1}\u0000`
  let source = text

  // Code spans bind tighter than anything else and keep their content literal.
  source = source.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_match, _fence, code) => {
    const body = code.replace(/^ (.*) $/, '$1')
    return hold(`<code>${escapeHtml(body)}</code>`)
  })

  // A backslash escape protects the punctuation that follows it.
  source = source.replace(/\\([\\`*_{}[\]()#+\-.!|<>~$"'])/g, (_match, character) => hold(escapeHtml(character)))

  // Footnote references bind before links: both start with a bracket.
  source = source.replace(/\[\^([^\]]+)\]/g, (_match, label) => hold(footnoteRef(label, ctx)))

  // Inline TeX, rendered by the typesetter the caller supplied.
  source = source.replace(/(^|[^\\$])\$([^\n$]+?)\$(?!\$)/g,
    (_match, lead, body) => `${lead}${hold(ctx.math(body, false))}`)

  // Images before links: both start with a bracket.
  source = source.replace(/!\[([^\]]*)\]\(\s*(<[^>\n]*>|[^\s)]+)(?:\s+("([^"]*)"|'([^']*)'))?\s*\)/g,
    (_match, alt, url, _title, doubleQuoted, singleQuoted) => {
      const target = url.replace(/^<|>$/g, '')
      const title = doubleQuoted ?? singleQuoted
      const titleAttribute = title === undefined ? '' : ` title="${escapeHtml(title)}"`
      return hold(`<img src="${escapeHtml(target)}" alt="${escapeHtml(alt)}"${titleAttribute}>`)
    })
  source = source.replace(/\[([^\]]*)\]\(\s*(<[^>\n]*>|[^\s)]+)(?:\s+("([^"]*)"|'([^']*)'))?\s*\)/g,
    (_match, label, url, _title, doubleQuoted, singleQuoted) => {
      const target = url.replace(/^<|>$/g, '')
      const title = doubleQuoted ?? singleQuoted
      const titleAttribute = title === undefined ? '' : ` title="${escapeHtml(title)}"`
      return hold(`<a href="${escapeHtml(target)}"${titleAttribute}>${renderInline(label, ctx)}</a>`)
    })

  // Autolinks written as <scheme:...> classify before raw tags are escaped.
  source = source.replace(/<((?:https?|mailto|ftp):[^>\s]+)>/g,
    (_match, url) => hold(`<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`))

  source = escapeHtml(source)
  source = source.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>')
  source = source.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
  source = source.replace(/(^|[^\w*])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<strong>$2</strong>')
  source = source.replace(/(^|[^\w*])\*(?=\S)([\s\S]*?\S)\*(?!\*)/g, '$1<em>$2</em>')
  source = source.replace(/(^|[^\w_])_(?=\S)([\s\S]*?\S)_(?!\w)/g, '$1<em>$2</em>')
  source = source.replace(/&lt;((?:https?|mailto|ftp):[^\s&]+)&gt;/g,
    (_match, url) => `<a href="${url}">${url}</a>`)
  // GFM bare autolinks: a URL in running text becomes a link, with trailing
  // sentence punctuation left outside it.
  source = source.replace(/(^|[\s(（[【])(https?:\/\/[^\s<>"'）)】」]+)/g, (match, lead, url) => {
    const trimmed = url.replace(/[.,;:!?。，；：！？]+$/, '')
    if (trimmed === '') return match
    return `${lead}<a href="${trimmed}">${trimmed}</a>${url.slice(trimmed.length)}`
  })
  source = source.replace(/ {2,}\n/g, '<br>\n')
  // Held fragments return last, so emphasis rules never see their markup or
  // the punctuation an escape protected.
  return source.replace(/\u0000(\d+)\u0000/g, (_match, index) => slots[Number(index)] ?? '')
}

/** Heading size and class for one ATX level. */
function headingTag(level) {
  const clamped = Math.min(Math.max(level, 1), 6)
  return `<h${clamped}>`
}

/** Whether a line is a setext heading underline. */
function isSetextUnderline(line) {
  return /^[ \t]{0,3}(=+|-+)[ \t]*$/.test(line)
}

/** Whether the line at `index` begins a block construct. */
function opensBlock(lines, index) {
  const line = lines[index]
  if (/^[ \t]*([`~]{3,})/.test(line)) return true
  if (/^[ \t]{0,3}#{1,6}[ \t]/.test(line)) return true
  if (/^[ \t]{0,3}((\*[ \t]*){3,}|(-[ \t]*){3,}|(_[ \t]*){3,})$/.test(line)) return true
  if (/^[ \t]{0,3}>/.test(line)) return true
  if (/^[ \t]{0,3}\$\$/.test(line)) return true
  // The directive is a block, so a paragraph ends before it even without a
  // blank line, matching the pandoc path. An indented directive is code.
  if (indentOf(line) < 4 && /^[ \t]{0,3}<!--[ \t]*pagebreak[ \t]*-->[ \t]*$/i.test(line)) return true
  if (LIST_MARKER.test(line)) return true
  if (line.includes('|') && index + 1 < lines.length && isDelimiterRow(lines[index + 1])) return true
  const tag = /^[ \t]{0,3}<([a-zA-Z][a-zA-Z0-9-]*)\b/.exec(line)
  if (tag !== null && HTML_BLOCK_TAGS.has(tag[1].toLowerCase())) return true
  return false
}

/** Whether a line is a GFM table delimiter row. */
function isDelimiterRow(line) {
  const trimmed = line.trim()
  if (trimmed === '' || !/[|\-:]/.test(trimmed)) return false
  return /^\|?[ \t]*:?-{1,}:?[ \t]*(\|[ \t]*:?-{1,}:?[ \t]*)*\|?[ \t]*$/.test(trimmed)
}

/** Split a table row into trimmed cell sources. */
function splitRow(line) {
  let source = line.trim()
  if (source.startsWith('|')) source = source.slice(1)
  if (source.endsWith('|') && !source.endsWith('\\|')) source = source.slice(0, -1)
  const cells = []
  let current = ''
  for (let position = 0; position < source.length; position += 1) {
    const character = source[position]
    if (character === '\\' && source[position + 1] === '|') {
      current += '|'
      position += 1
      continue
    }
    if (character === '|') {
      cells.push(current.trim())
      current = ''
      continue
    }
    current += character
  }
  cells.push(current.trim())
  return cells
}

/**
 * Render one GFM table starting at `start`.
 * @param lines - block lines.
 * @param start - index of the header row.
 * @param ctx - render context.
 * @returns the markup and the next index, or null when the table is malformed.
 */
function renderTable(lines, start, ctx) {
  const header = splitRow(lines[start])
  const delimiter = splitRow(lines[start + 1])
  if (delimiter.length !== header.length) return null
  const alignments = delimiter.map((cell) => {
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    if (left) return 'left'
    return null
  })
  const align = (position) => (alignments[position] === null ? '' : ` style="text-align:${alignments[position]}"`)
  let index = start + 2
  const rows = []
  while (index < lines.length && !isBlank(lines[index]) && lines[index].includes('|')) {
    rows.push(splitRow(lines[index]))
    index += 1
  }
  const head = header.map((cell, position) => `<th${align(position)}>${renderInline(cell, ctx)}</th>`).join('')
  const body = rows.map(cells => `<tr>${header
    .map((_unused, position) => `<td${align(position)}>${renderInline(cells[position] ?? '', ctx)}</td>`)
    .join('')}</tr>`).join('\n')
  return {
    html: `<table>\n<thead><tr>${head}</tr></thead>\n<tbody>${body}</tbody>\n</table>`,
    next: index,
  }
}

/**
 * Render one list starting at `start`.
 * @param lines - block lines.
 * @param start - index of the first marker.
 * @param ctx - render context.
 * @returns the markup and the next index, or null when no item was collected.
 */
function renderList(lines, start, ctx) {
  const opening = LIST_MARKER.exec(lines[start])
  /* c8 ignore next -- the caller only enters with a matching marker. */
  if (opening === null) return null
  const baseIndent = indentOf(opening[1].replace(/\t/g, '    '))
  const ordered = /^\d/.test(opening[2])
  const startNumber = ordered ? Number.parseInt(opening[2], 10) : 1
  const items = []
  let loose = false
  let index = start

  while (index < lines.length) {
    const line = lines[index]
    if (isBlank(line)) {
      const next = lines[index + 1]
      if (next === undefined) {
        index += 1
        break
      }
      const nextMarker = LIST_MARKER.exec(next)
      const nextIndent = indentOf(next.replace(/\t/g, '    '))
      if (nextMarker !== null && nextIndent === baseIndent && /^\d/.test(nextMarker[2]) === ordered) {
        loose = true
        index += 1
        continue
      }
      if (nextIndent > baseIndent) {
        items[items.length - 1].lines.push('')
        index += 1
        continue
      }
      break
    }
    const marker = LIST_MARKER.exec(line)
    const indent = indentOf(line.replace(/\t/g, '    '))
    if (marker !== null && indent === baseIndent) {
      if (/^\d/.test(marker[2]) !== ordered) break
      const contentIndent = indent + marker[0].replace(/^[ \t]*/, '').length
      items.push({ lines: [line.slice(contentIndent)], contentIndent })
      index += 1
      continue
    }
    if (indent > baseIndent) {
      const item = items[items.length - 1]
      item.lines.push(stripIndent(line, item.contentIndent))
      index += 1
      continue
    }
    // A shallow line continues the last item only as a lazy paragraph line.
    if (items.length > 0 && !opensBlock(lines, index)) {
      items[items.length - 1].lines.push(line.trim())
      index += 1
      continue
    }
    break
  }

  if (items.length === 0) return null
  const rendered = items.map((item) => {
    const task = /^\[([ xX])\][ \t]+/.exec(item.lines[0] ?? '')
    let body = item.lines
    let checkbox = ''
    if (task !== null) {
      body = [item.lines[0].slice(task[0].length), ...item.lines.slice(1)]
      checkbox = `<input type="checkbox" disabled${task[1].toLowerCase() === 'x' ? ' checked' : ''}> `
    }
    const markup = renderBlocks(body, ctx)
    // A tight item loses the paragraph wrappers around its own first block;
    // nested blocks keep theirs, as they do in CommonMark.
    const content = loose ? markup : markup.replace(/^<p>([\s\S]*?)<\/p>/, '$1')
    const className = task === null ? '' : ' class="task-item"'
    return `<li${className}>${checkbox}${content}</li>`
  })
  const tag = ordered ? 'ol' : 'ul'
  const startAttribute = ordered && startNumber !== 1 ? ` start="${startNumber}"` : ''
  return {
    html: `<${tag}${startAttribute}>\n${rendered.join('\n')}\n</${tag}>`,
    next: index,
  }
}

/**
 * Render a run of block-level lines.
 * @param lines - the block's source lines, indentation already stripped.
 * @param ctx - render context.
 * @returns the markup.
 */
function renderBlocks(lines, ctx) {
  const output = []
  let index = 0
  // A paragraph immediately after a table may be that table's note; the flag
  // survives exactly one iteration so only that paragraph is considered.
  let tableNotePending = false
  while (index < lines.length) {
    const line = lines[index]
    if (isBlank(line)) {
      index += 1
      continue
    }
    const afterTable = tableNotePending
    tableNotePending = false

    // An explicit page break is the author's control over pagination. A line
    // indented four columns is code, so the tab in front of a directive keeps
    // it literal.
    if (indentOf(line) < 4 && /^[ \t]{0,3}<!--[ \t]*pagebreak[ \t]*-->[ \t]*$/i.test(line)) {
      output.push('<div class="md2pdf-pagebreak"></div>')
      index += 1
      continue
    }

    // Fenced code: backticks or tildes, at least three.
    const fence = /^([ \t]*)(`{3,}|~{3,})[ \t]*([^`]*)$/.exec(line)
    if (fence !== null) {
      const marker = fence[2][0]
      const length = fence[2].length
      const language = fence[3].trim().split(/\s+/)[0] ?? ''
      const body = []
      index += 1
      while (index < lines.length) {
        const candidate = lines[index]
        const close = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(candidate)
        if (close !== null && close[1][0] === marker && close[1].length >= length) {
          index += 1
          break
        }
        body.push(stripIndent(candidate, fence[1].length))
        index += 1
      }
      const classAttribute = language === '' ? '' : ` class="language-${escapeHtml(language)}"`
      output.push(`<pre><code${classAttribute}>${escapeHtml(body.join('\n'))}</code></pre>`)
      continue
    }

    // Display math: an opening `$$` runs to the next `$$`.
    if (/^[ \t]{0,3}\$\$/.test(line)) {
      const collected = [line.replace(/^[ \t]{0,3}\$\$/, '')]
      let closed = collected[0].includes('$$')
      if (closed) collected[0] = collected[0].slice(0, collected[0].indexOf('$$'))
      index += 1
      while (!closed && index < lines.length) {
        const end = lines[index].indexOf('$$')
        if (end !== -1) {
          collected.push(lines[index].slice(0, end))
          index += 1
          closed = true
          break
        }
        collected.push(lines[index])
        index += 1
      }
      output.push(`<div class="math-display">${ctx.math(collected.join('\n').trim(), true)}</div>`)
      continue
    }

    // ATX heading.
    const atx = /^[ \t]{0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/.exec(line)
    if (atx !== null) {
      const level = atx[1].length
      output.push(`${headingTag(level)}${renderInline(atx[2], ctx)}</h${level}>`)
      index += 1
      continue
    }

    // Thematic break.
    if (/^[ \t]{0,3}((\*[ \t]*){3,}|(-[ \t]*){3,}|(_[ \t]*){3,})$/.test(line)) {
      output.push('<hr>')
      index += 1
      continue
    }

    // Indented code block: four columns of indentation at a block start. It is
    // checked before lists, because `    - x` is code rather than a deep list.
    if (indentOf(line) >= 4) {
      const body = []
      while (index < lines.length) {
        if (isBlank(lines[index])) {
          body.push('')
          index += 1
          continue
        }
        if (indentOf(lines[index]) < 4) break
        body.push(stripIndent(lines[index], 4))
        index += 1
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop()
      output.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`)
      continue
    }

    // Blockquote: strip one marker level, then reparse what remains.
    if (/^[ \t]{0,3}>/.test(line)) {
      const body = []
      while (index < lines.length && /^[ \t]{0,3}>/.test(lines[index])) {
        body.push(lines[index].replace(/^[ \t]{0,3}>[ \t]?/, ''))
        index += 1
      }
      output.push(`<blockquote>${renderBlocks(body, ctx)}</blockquote>`)
      continue
    }

    // GFM table: a header row, a delimiter row, then data rows.
    if (line.includes('|') && index + 1 < lines.length && isDelimiterRow(lines[index + 1])) {
      const table = renderTable(lines, index, ctx)
      if (table !== null) {
        // A caption line standing right above the table is the table's caption,
        // the position a Chinese academic table requires.
        const previous = output[output.length - 1]
        if (previous !== undefined && /^<p>(?:表|Table)\s*\d/.test(previous)) {
          output[output.length - 1] = previous.replace('<p>', '<p class="table-caption">')
        }
        output.push(table.html)
        index = table.next
        tableNotePending = true
        continue
      }
    }

    // List.
    if (LIST_MARKER.test(line)) {
      const list = renderList(lines, index, ctx)
      if (list !== null) {
        output.push(list.html)
        index = list.next
        continue
      }
    }

    // Raw HTML block.
    const openingTag = /^[ \t]{0,3}<([a-zA-Z][a-zA-Z0-9-]*)\b/.exec(line)
    if (openingTag !== null && HTML_BLOCK_TAGS.has(openingTag[1].toLowerCase())) {
      const body = []
      const tagName = openingTag[1].toLowerCase()
      const closesImmediately = new RegExp(`</${tagName}\\s*>`, 'i').test(line)
      while (index < lines.length && !isBlank(lines[index])) {
        body.push(lines[index])
        index += 1
        if (closesImmediately || new RegExp(`</${tagName}\\s*>`, 'i').test(body[body.length - 1])) break
      }
      output.push(sanitizeRawHtml(body.join('\n')))
      continue
    }

    // Paragraph, stopping at any block opener or at a setext underline.
    const paragraph = []
    while (index < lines.length && !isBlank(lines[index]) && !opensBlock(lines, index)) {
      if (paragraph.length > 0 && isSetextUnderline(lines[index])) break
      // Leading indentation belongs to the container; trailing spaces are a
      // hard line break and stay.
      paragraph.push(lines[index].replace(/^[ \t]+/, ''))
      index += 1
    }
    if (paragraph.length === 0) {
      // Nothing consumed: the line opens a block this renderer does not know,
      // so treat it as a one-line paragraph rather than looping forever.
      output.push(`<p>${renderInline(line.trim(), ctx)}</p>`)
      index += 1
      continue
    }
    if (index < lines.length && isSetextUnderline(lines[index])) {
      const level = lines[index].trim().startsWith('=') ? 1 : 2
      output.push(`${headingTag(level)}${renderInline(paragraph.join(' '), ctx)}</h${level}>`)
      index += 1
      continue
    }
    output.push(`<p${afterTable && /^(?:注|Notes?)[：:]/.test(paragraph[0]) ? ' class="table-note"' : ''}>${renderInline(paragraph.join('\n'), ctx)}</p>`)
  }
  return output.join('\n')
}

/**
 * Render a Markdown document body.
 * @param source - the file text.
 * @param [options] - `math` renders one TeX fragment to markup.
 * @returns the frontmatter block markup, the body markup with heading ids, and
 *   the headings in document order.
 */
export function renderMarkdown(source, options = {}) {
  const text = String(source).replace(/\r\n?/g, '\n')
  const { frontmatter, body } = splitFrontmatter(text)
  const { notes, kept } = extractFootnotes(body.split('\n'))
  const ctx = createContext({ math: options.math, notes })
  const markup = renderBlocks(kept, ctx)
  const assembled = addHeadingIds(markup + footnoteSection(ctx))
  return {
    frontmatter: renderFrontmatter(frontmatter),
    body: assembled.html,
    headings: assembled.headings,
  }
}
