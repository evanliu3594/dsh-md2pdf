/**
 * Font-family diagnostics for one preset stylesheet.
 *
 * The settings page needs the concrete families a preset asks for, not the
 * generic fallbacks. This module is the one place that reads them: it scans
 * every `font-family` declaration, splits the value on commas that are not
 * inside a quoted name, drops generic families and CSS-wide keywords, dedupes
 * by name while keeping the first spelling and position, and never throws on a
 * broken stylesheet.
 *
 * `fontFacesInCss` reports the families declared by `@font-face` separately.
 * The Host has no way to know whether such a face is loaded, so the client
 * marks those families unverified instead of claiming a local system font.
 */

/** Families that name a fallback category, not an installed face. */
const GENERIC_FAMILIES = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'math',
  'emoji',
])

/** Keywords that stand in for a family but name no face. */
const CSS_WIDE_KEYWORDS = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer'])

/** A `font-family` property at a declaration boundary, not a custom property. */
const FONT_FAMILY = /(?<![-\w])font-family\s*:/gi

/** An `@font-face` rule opener. */
const FONT_FACE = /@font-face\s*\{/gi

/**
 * Remove CSS comments so a commented declaration is not read as a real one.
 * @param css - stylesheet text.
 * @returns the text without comments; an unterminated comment is kept as-is.
 */
function withoutComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/**
 * Read one declaration value up to its terminator, ignoring terminators inside
 * quotes.
 * @param text - stylesheet text starting just after the colon.
 * @returns the value text.
 */
function declarationValue(text) {
  let quote = null
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote !== null) {
      if (char === '\\') {
        index += 1
      } else if (char === quote) {
        quote = null
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === ';' || char === '}' || char === '{') {
      return text.slice(0, index)
    }
  }
  return text
}

/**
 * Split a family list on commas outside quotes.
 * @param value - a `font-family` value.
 * @returns the raw list items.
 */
function splitFamilies(value) {
  const items = []
  let item = ''
  let quote = null
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (quote !== null) {
      item += char
      if (char === '\\' && index + 1 < value.length) {
        index += 1
        item += value[index]
      } else if (char === quote) {
        quote = null
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      item += char
      continue
    }
    if (char === ',') {
      items.push(item)
      item = ''
      continue
    }
    item += char
  }
  items.push(item)
  return items
}

/**
 * Read one quoted family item.
 * @param item - a trimmed list item that starts with a quote.
 * @param quote - the opening quote character.
 * @returns the decoded name, or null for a malformed item.
 */
function quotedFamily(item, quote) {
  let name = ''
  for (let index = 1; index < item.length; index += 1) {
    const char = item[index]
    if (char === '\\' && index + 1 < item.length) {
      index += 1
      name += item[index]
      continue
    }
    if (char === quote) {
      // Only whitespace or an `!important` flag may follow the closing quote;
      // anything else means this item is not one CSS family name.
      const rest = item.slice(index + 1).trim()
      return rest === '' || /^!\s*important$/i.test(rest) ? name : null
    }
    name += char
  }
  return null
}

/**
 * Turn one raw list item into a usable family name.
 * @param item - a comma-separated item.
 * @returns the family, or null when the item names no concrete face.
 */
function concreteFamily(item) {
  const trimmed = item.trim()
  if (trimmed === '') return null
  const first = trimmed[0]
  if (first === '"' || first === "'") {
    const name = quotedFamily(trimmed, first)
    return name === null || name.trim() === '' ? null : name
  }
  const name = trimmed.replace(/!\s*important\s*$/i, '').trim().replace(/\s+/g, ' ')
  if (name === '' || name.includes('(')) return null
  const key = name.toLowerCase()
  if (GENERIC_FAMILIES.has(key) || CSS_WIDE_KEYWORDS.has(key)) return null
  return name
}

/**
 * Extract the concrete families a stylesheet declares.
 *
 * The scan is text-only and deliberately tolerant: a broken rule or quote is
 * skipped, never thrown. Order follows the stylesheet; a repeated name keeps
 * its first spelling and position.
 * @param css - stylesheet text.
 * @returns the concrete family names, in first-seen order.
 */
export function fontsInCss(css) {
  if (typeof css !== 'string' || css === '') return []
  const text = withoutComments(css)
  const seen = new Set()
  const families = []
  for (const match of text.matchAll(FONT_FAMILY)) {
    const start = (match.index ?? 0) + match[0].length
    for (const item of splitFamilies(declarationValue(text.slice(start)))) {
      const family = concreteFamily(item)
      if (family === null) continue
      const key = family.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      families.push(family)
    }
  }
  return families
}

/**
 * Find the closing brace of a rule, or -1 when the block is unterminated.
 * @param text - stylesheet text.
 * @param open - index of the opening brace.
 * @returns the index of the matching closing brace.
 */
function closingBrace(text, open) {
  let depth = 0
  let quote = null
  for (let index = open; index < text.length; index += 1) {
    const char = text[index]
    if (quote !== null) {
      if (char === '\\') index += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/**
 * Extract the families declared by `@font-face` rules.
 *
 * A face family is not a system family: the client cannot infer whether the
 * face is loaded, so it marks these families unverified. An unterminated rule
 * is skipped rather than guessed.
 * @param css - stylesheet text.
 * @returns the declared face families, in first-seen order.
 */
export function fontFacesInCss(css) {
  if (typeof css !== 'string' || css === '') return []
  const text = withoutComments(css)
  const seen = new Set()
  const families = []
  for (const match of text.matchAll(FONT_FACE)) {
    const open = (match.index ?? 0) + match[0].length - 1
    const close = closingBrace(text, open)
    if (close < 0) continue
    const block = text.slice(open + 1, close)
    for (const declaration of block.matchAll(FONT_FAMILY)) {
      const start = (declaration.index ?? 0) + declaration[0].length
      const value = declarationValue(block.slice(start))
      const family = concreteFamily(splitFamilies(value)[0] ?? '')
      if (family === null) break
      const key = family.toLowerCase()
      if (!seen.has(key)) {
        seen.add(key)
        families.push(family)
      }
      break
    }
  }
  return families
}
