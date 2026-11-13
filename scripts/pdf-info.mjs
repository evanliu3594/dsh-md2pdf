/**
 * Structural report for a produced PDF: page count, page box, and every face
 * the document embeds. Development aid only.
 *
 * Two embedding forms are counted. A normal subset names its face in
 * `/BaseFont`; a face Chromium draws as outlines — a CJK face with synthetic
 * bold, for instance — becomes a Type3 font whose family is only recorded in
 * `/FontFamily`. Reading one and not the other under-reports the document.
 */
import { readFile } from 'node:fs/promises'

const path = process.argv[2]
if (path === undefined) {
  process.stderr.write('usage: node scripts/pdf-info.mjs <file.pdf>\n')
  process.exit(2)
}
const raw = await readFile(path)
const text = raw.toString('latin1')

const pages = (text.match(/\/Type\s*\/Page[^s]/g) ?? []).length
const boxes = [...new Set((text.match(/\/MediaBox\s*\[[^\]]*\]/g) ?? []))]

/** Strip the six-letter subset tag Chromium puts in front of a face name. */
const bareName = (name) => name.trim().replace(/^\/?[A-Z]{6}\+/, '')

const subsets = [...new Set((text.match(/\/BaseFont\s*\/([#\w+.-]+)/g) ?? [])
  .map(entry => bareName(entry.replace('/BaseFont', ''))))]
const type3 = [...new Set((text.match(/\/FontFamily\s*\(([^)]*)\)/g) ?? [])
  .map(entry => entry.replace(/\/FontFamily\s*\(|\)/g, '').trim()))]
const fonts = [...new Set([...subsets, ...type3])].sort()

process.stdout.write(`${JSON.stringify({
  file: path,
  bytes: raw.byteLength,
  header: text.slice(0, 9),
  pages,
  boxes,
  fonts,
  fontCount: fonts.length,
  type3Count: type3.length,
  hasXref: /startxref/.test(text),
}, null, 2)}\n`)
