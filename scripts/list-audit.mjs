/**
 * Reader-fidelity audit: render one corpus through every reader the exporter
 * can use and report, per case, whether the expected markup appears.
 *
 * Run: node scripts/list-audit.mjs
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadMathRenderer } from '../src/math.js'
import { renderMarkdown } from '../src/markdown.js'
import { run, which } from '../src/proc.js'

/** Reader configurations compared below. */
const READERS = [
  {
    name: 'markdown(old)',
    legacy: true,
    format: [
      'markdown', '+tex_math_dollars', '+pipe_tables', '+task_lists', '+strikeout', '+footnotes',
      '+autolink_bare_uris', '+gfm_auto_identifiers', '+yaml_metadata_block', '+definition_lists',
      '+fenced_divs', '+bracketed_spans',
    ].join(''),
  },
  { name: 'gfm+math', format: 'gfm-emoji+tex_math_dollars' },
]

/**
 * @typedef {object} Case
 * @property {string} name - what the case proves.
 * @property {string} markdown - the source.
 * @property {string} pattern - markup the rendered paper must contain.
 * @property {boolean} [absent] - the pattern must be missing instead.
 */

/** @type {readonly Case[]} */
const CASES = [
  // Lists: the reported defect lives here.
  { name: 'list after blank line', markdown: '段落。\n\n- 项目一\n- 项目二', pattern: '<ul' },
  { name: 'list right after paragraph', markdown: '说明文字：\n- 项目一\n- 项目二', pattern: '<ul' },
  { name: 'list right after heading', markdown: '## 标题\n- 项目一\n- 项目二', pattern: '<ul' },
  { name: 'star bullets after paragraph', markdown: '说明文字：\n* 项目一\n* 项目二', pattern: '<ul' },
  { name: 'plus bullets after paragraph', markdown: '说明文字：\n+ 项目一\n+ 项目二', pattern: '<ul' },
  { name: 'ordered after paragraph', markdown: '说明文字：\n1. 项目一\n2. 项目二', pattern: '<ol' },
  { name: 'ordered with parenthesis', markdown: '说明文字：\n1) 项目一\n2) 项目二', pattern: '<ol' },
  { name: 'ordered starting at three', markdown: '说明：\n\n3. 项目三\n4. 项目四', pattern: '<ol' },
  { name: 'nested by two spaces', markdown: '- 一级\n  - 二级\n- 一级二', pattern: /一级\s*<ul/ },
  { name: 'nested by four spaces', markdown: '- 一级\n    - 二级\n- 一级二', pattern: '<ul' },
  { name: 'nested by tab', markdown: '- 一级\n\t- 二级\n- 一级二', pattern: '<ul' },
  { name: 'loose list', markdown: '- 项目一\n\n- 项目二', pattern: '<ul' },
  { name: 'loose list after paragraph', markdown: '说明：\n- 项目一\n\n- 项目二', pattern: '<ul' },
  { name: 'continuation line', markdown: '- 项目一，这一行很长\n  续行属于同一项目\n- 项目二', pattern: '<ul' },
  { name: 'list inside blockquote', markdown: '> 引用\n>\n> - 项目一\n> - 项目二', pattern: '<blockquote>' },
  { name: 'task list', markdown: '- [x] 已完成\n- [ ] 未完成', pattern: 'type="checkbox"' },
  { name: 'list after table', markdown: '| a | b |\n|---|---|\n| 1 | 2 |\n- 项目一', pattern: '<ul' },
  { name: 'list after code fence', markdown: '```js\nlet a = 1\n```\n- 项目一', pattern: '<ul' },
  { name: 'five levels', markdown: '- 一\n  - 二\n    - 三\n      - 四\n        - 五', pattern: /四\s*<ul/ },
  { name: 'bold at item start', markdown: '- **重点**：说明\n- 普通项目', pattern: '<ul' },
  { name: 'item with two paragraphs', markdown: '- 第一段\n\n  第二段\n- 另一个项目', pattern: '<ul' },
  { name: 'item with code span', markdown: '- `npm run dev` 启动', pattern: '<ul' },
  { name: 'numbered list after colon', markdown: '步骤如下：\n1. 打开设置\n2. 选择语言', pattern: '<ol' },
  // Non-lists: must not become lists.
  { name: 'asterisk emphasis stays text', markdown: '*这是强调，不是列表。*', pattern: '<ul', absent: true },
  { name: 'single dash is a setext heading', markdown: '标题\n-', pattern: '<ul', absent: true },
  { name: 'inline hyphen stays text', markdown: '范围 10-20 之间。', pattern: '<ul', absent: true },
  // Other features, so a reader switch cannot silently regress them.
  { name: 'table', markdown: '| a | b |\n|---|---|\n| 1 | 2 |', pattern: '<table' },
  { name: 'table alignment', markdown: '| a |\n|---:|\n| 1 |', pattern: 'text-align' },
  { name: 'strikeout', markdown: '~~删除~~', pattern: '<del>' },
  { name: 'footnote', markdown: '正文[^1]\n\n[^1]: 注释内容', pattern: /id="fn-?1"/ },
  { name: 'inline math', markdown: '公式 $a+b$ 结束', pattern: '<math' },
  { name: 'display math', markdown: '$$\nx = 1\n$$', pattern: 'display="block"' },
  { name: 'bracketed autolink', markdown: '<https://example.com>', pattern: 'href="https://example.com"' },
  { name: 'bare autolink', markdown: '见 https://example.com 说明', pattern: 'href="https://example.com"' },
  { name: 'heading identifier', markdown: '## 标题', pattern: '<h2 id=' },
  { name: 'raw html block', markdown: '<div class="x">y</div>', pattern: 'class="x"' },
  { name: 'fenced code language', markdown: '```js\nlet a = 1\n```', pattern: /class="js"|language-js/ },
  { name: 'hard line break', markdown: 'a  \nb', pattern: '<br' },
  { name: 'image', markdown: '![alt](./a.png)', pattern: '<img' },
  { name: 'link with title', markdown: '[t](https://e.com "标题")', pattern: 'title="标题"' },
  { name: 'blockquote', markdown: '> 引用', pattern: '<blockquote>' },
  { name: 'setext heading', markdown: '标题\n===', pattern: '<h1' },
  { name: 'strong', markdown: '**粗**', pattern: '<strong>' },
  { name: 'emphasis', markdown: '*斜*', pattern: '<em>' },
  { name: 'thematic break', markdown: '***', pattern: '<hr' },
  { name: 'inline code', markdown: '`a<b`', pattern: '<code>' },
]

/** Features the built-in renderer knowingly leaves to pandoc. */
const FALLBACK_GAPS = new Set(['heading identifier'])

/**
 * Render one case with one pandoc reader.
 * @param pandoc - resolved executable.
 * @param format - reader format string.
 * @param markdown - source.
 * @param work - scratch directory.
 * @returns the fragment, or null when pandoc failed.
 */
async function pandocRender(pandoc, format, markdown, work) {
  const source = join(work, 'case.md')
  await writeFile(source, markdown, 'utf8')
  const result = await run(pandoc, [
    '--from', format, '--to', 'html5', '--mathml', '--no-highlight', '--wrap=none', source,
  ], { timeoutMs: 30_000 })
  return result.code === 0 ? result.stdout : null
}

/**
 * Judge one rendered output against a case.
 * @returns ok, or the reason the case failed.
 */
function judge(testCase, rendered) {
  const found = testCase.pattern instanceof RegExp
    ? testCase.pattern.test(rendered)
    : rendered.includes(testCase.pattern)
  return testCase.absent === true ? (found ? 'UNEXPECTED' : 'ok') : (found ? 'ok' : 'MISS')
}

const pandoc = await which('pandoc')
const mathRenderer = await loadMathRenderer()
const renderOptions = mathRenderer === null ? {} : { math: mathRenderer }
process.stdout.write(`pandoc: ${pandoc ?? 'absent'}  math: ${mathRenderer === null ? 'fallback' : 'temml'}\n\n`)
const work = await mkdtemp(join(tmpdir(), 'dsh-md2pdf-audit-'))
const rows = []
const totals = new Map()

try {
  for (const testCase of CASES) {
    const row = { name: testCase.name, builtin: null, pandoc: {} }
    const builtinVerdict = judge(testCase, renderMarkdown(testCase.markdown, renderOptions).body)
    const isGap = builtinVerdict !== 'ok' && FALLBACK_GAPS.has(testCase.name)
    row.builtin = isGap ? 'gap' : builtinVerdict
    if (row.builtin !== 'ok' && !isGap) totals.set('builtin', (totals.get('builtin') ?? 0) + 1)
    for (const reader of READERS) {
      if (pandoc === null) {
        row.pandoc[reader.name] = 'no-pandoc'
        continue
      }
      const output = await pandocRender(pandoc, reader.format, testCase.markdown, work)
      row.pandoc[reader.name] = output === null ? 'ERROR' : judge(testCase, output)
      // The historical reader is kept for reference: its list failures are the
      // defect this suite exists to prove, not a regression to gate on.
      if (row.pandoc[reader.name] !== 'ok' && reader.legacy !== true) {
        totals.set(reader.name, (totals.get(reader.name) ?? 0) + 1)
      }
    }
    rows.push(row)
  }
} finally {
  await rm(work, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
}

const names = ['builtin', ...READERS.map(reader => reader.name)]
const width = Math.max(...rows.map(row => row.name.length))
process.stdout.write(`${'case'.padEnd(width)}  ${names.map(name => name.padEnd(17)).join('')}\n`)
for (const row of rows) {
  const cells = [row.builtin.padEnd(17), ...READERS.map(reader => String(row.pandoc[reader.name]).padEnd(17))]
  process.stdout.write(`${row.name.padEnd(width)}  ${cells.join('')}\n`)
}
process.stdout.write(`\nfailures: ${names.map(name => `${name}=${totals.get(name) ?? 0}`).join('  ')}\n`)
process.exit([...totals.values()].some(count => count > 0) ? 1 : 0)


