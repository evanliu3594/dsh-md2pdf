/**
 * Say why a Markdown line is or is not a list to the renderer.
 *
 * Run: node scripts/diagnose-lists.mjs <file.md>
 *
 * Prints every line whose written form suggests a list but whose marker the
 * CommonMark reader does not accept, so the fix is obvious: change the marker,
 * not the renderer.
 */
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'

import { renderMarkdown } from '../src/markdown.js'

const target = process.argv[2]
if (target === undefined) {
  process.stderr.write('usage: node scripts/diagnose-lists.mjs <file.md>\n')
  process.exit(2)
}

const source = await readFile(target, 'utf8')
const lines = source.replace(/\r\n?/g, '\n').split('\n')

/** A CommonMark list marker: bullet or ordered, followed by spaces or end. */
const STANDARD = /^[ \t]*([-*+]|\d{1,9}[.)])([ \t]+|$)/

/** Written forms that look like a list to a human but are plain text here. */
const SUSPECTS = [
  { pattern: /^[ \t]*\d{1,2}、/, reason: '全角顿号编号（`1、`）不是 Markdown 有序列表，请改成 `1.`' },
  { pattern: /^[ \t]*[（(]\d{1,2}[）)]/, reason: '括号编号（`（1）`）不是 Markdown 有序列表，请改成 `1.`' },
  { pattern: /^[ \t]*[\u2460-\u2473]/, reason: '带圈数字（`①`）不是 Markdown 列表，请改成 `1.`' },
  { pattern: /^[ \t]*[-*+][\u3000\u00a0]/, reason: '项目符号后是全角或不间断空格，请改成普通空格' },
  { pattern: /^[ \t]*[-*+][^\s]/, reason: '项目符号后没有空格（会被当成强调或普通文字）', unless: /^[ \t]*(\*{1,2}[^*]|_[^_])|^[ \t]*\*[^*\s][^*]*\*[ \t]*$/ },
  { pattern: /^[ \t]*[\u00b7\u2022\u25aa\u25cf\uff65]/, reason: '圆点或方点符号（`·`/`•`）不是 Markdown 项目符号，请改成 `-`' },
  { pattern: /^[ \t]*\d{1,9}[.)][^\s\d]/, reason: '编号后没有空格' },
]

const found = []
let standardCount = 0
let inFence = false

for (let index = 0; index < lines.length; index += 1) {
  const line = lines[index]
  if (/^[ \t]*([`~]{3,})/.test(line)) {
    inFence = !inFence
    continue
  }
  if (inFence) continue
  if (STANDARD.test(line)) {
    standardCount += 1
    const previous = index > 0 ? lines[index - 1] : ''
    if (previous.trim() !== '' && !STANDARD.test(previous) && !/^[ \t]*>/.test(previous)) {
      found.push({
        line: index + 1,
        text: line,
        reason: '列表紧接上一行段落，中间没有空行（新读取器可以识别；旧版本会并成段落）',
        severity: 'note',
      })
    }
    continue
  }
  for (const suspect of SUSPECTS) {
    if (!suspect.pattern.test(line)) continue
    if (suspect.unless !== undefined && suspect.unless.test(line)) continue
    found.push({ line: index + 1, text: line, reason: suspect.reason, severity: 'text' })
    break
  }
}

const rendered = renderMarkdown(source).body
const counts = {
  ul: (rendered.match(/<ul[\s>]/g) ?? []).length,
  ol: (rendered.match(/<ol[\s>]/g) ?? []).length,
  li: (rendered.match(/<li[\s>]/g) ?? []).length,
}

process.stdout.write(`file: ${basename(target)}\n`)
process.stdout.write(`lines: ${lines.length}  standard markers: ${standardCount}\n`)
process.stdout.write(`built-in renderer: ul=${counts.ul} ol=${counts.ol} li=${counts.li}\n\n`)

if (found.length === 0) {
  process.stdout.write('no suspicious list lines found\n')
  process.exit(0)
}

for (const entry of found) {
  const tag = entry.severity === 'note' ? '提示' : '需改'
  process.stdout.write(`line ${entry.line} [${tag}]: ${entry.reason}\n    ${entry.text.trim().slice(0, 120)}\n`)
}
process.stdout.write(`\n${found.length} line(s) need a look\n`)
