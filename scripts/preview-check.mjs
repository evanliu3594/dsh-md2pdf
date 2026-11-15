/**
 * Checks for the settings-page previews: the page margin read back out of a
 * document, the screen frame that shows it, and one document per preset.
 *
 * Run: node scripts/preview-check.mjs
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildHtml, DEFAULT_PAGE } from '../src/document.js'
import { buildPreviews, pageMarginOf, PREVIEW_MARKDOWN, previewHtml, withPageFrame } from '../src/previews.js'
import { themeCss } from '../src/themes.js'

const home = await mkdtemp(join(tmpdir(), 'dsh-md2pdf-previews-'))
process.env['MD2PDF_HOME'] = home

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

try {
  // The base sheet alone declares the default margin.
  const baseOnly = buildHtml({ title: 'T', body: '<p>x</p>' }, DEFAULT_PAGE)
  expectEqual('base margin read back', pageMarginOf(baseOnly), '18mm')

  // A preset's later @page wins, exactly as the print engine resolves it.
  const framed = withPageFrame(buildHtml({ title: 'T', body: '<p>x</p>', themeCss: themeCss('gongwen') }, DEFAULT_PAGE))
  expectEqual('preset margin read back', pageMarginOf(framed), '37mm 26mm 35mm 28mm')
  expectTrue('page margin becomes body padding', framed.includes('body{padding:37mm 26mm 35mm 28mm'))

  // A user rule that changes the margin must win as well.
  const userMargin = withPageFrame(buildHtml({
    title: 'T', body: '', themeCss: themeCss('lark'), customCss: '@page { margin: 12mm; }',
  }, DEFAULT_PAGE))
  expectEqual('user margin read back', pageMarginOf(userMargin), '12mm')

  // One document per stored preset, each carrying that preset's stylesheet.
  const marks = { lark: '#3370ff', gongwen: '#e60012', paper: '25mm 22mm' }
  const previews = await buildPreviews()
  expectEqual('one preview per preset', Object.keys(previews.presets).join(','), 'lark,gongwen,paper')
  expectEqual('previews report the selection', previews.selected, 'lark')
  for (const [id, html] of Object.entries(previews.presets)) {
    expectTrue(`preview exists for ${id}`, typeof html === 'string' && html.length > 2000)
    expectTrue(`preview carries the ${id} sheet`, html.includes(marks[id]))
    expectTrue(`preview of ${id} shows its page margin`, html.includes('padding:'))
  }

  // A preset's own rules reach its preview once stored.
  const { savePreset } = await import('../src/presets.js')
  await savePreset({ id: 'paper', name: '学术论文', css: `${themeCss('paper')}\nbody { color: red }` })
  const edited = await buildPreviews()
  expectTrue('edited preset reaches its preview', edited.presets.paper.includes('body { color: red }'))
  expectTrue('other previews stay unchanged', !edited.presets.lark.includes('body { color: red }'))

  // The sample covers the structures a preset is judged on.
  for (const fragment of ['# 文档标题', '| 参数 | 取值 |', '- 列表项目一', '[链接示例]', '`行内代码`']) {
    expectTrue(`sample contains ${fragment}`, PREVIEW_MARKDOWN.includes(fragment))
  }

  // A stylesheet passed directly is rendered as given.
  const direct = await previewHtml('body { color: red }')
  expectTrue('direct stylesheet rendered', direct.includes('body { color: red }'))

  // One unusable preset must not blank the whole preview route.
  const broken = await savePreset({ name: 'Broken page', css: '@page { margin: auto; }' })
  const resilient = await buildPreviews()
  expectEqual('a bad preset still yields a preview', typeof resilient.presets[broken.id], 'string')
  expectEqual('every preview survives one bad preset', Object.keys(resilient.presets).length, 4)
} finally {
  await rm(home, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
}

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`)
process.exit(failures === 0 ? 0 : 1)
