/**
 * Checks for the preset store: seeding, reading, legacy migration, mutation,
 * ordering, deletion, restoration and the action dispatcher.
 *
 * Run: node scripts/presets-check.mjs
 */
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { themeCss } from '../src/themes.js'

const home = await mkdtemp(join(tmpdir(), 'dsh-md2pdf-presets-'))
process.env['MD2PDF_HOME'] = home

const { listPresets, readPreset, presetCssPath } = await import('../src/presets.js')

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
  const first = await listPresets()
  expectEqual('seeds three presets', first.presets.length, 3)
  expectEqual('seeds in order', first.presets.map(preset => preset.id).join(','), 'lark,gongwen,paper')
  expectEqual('lark selected by default', first.selected, 'lark')
  expectEqual('lark is builtin and unmodified',
    `${first.presets[0].builtin}/${first.presets[0].unmodified}`, 'true/true')

  const lark = await readPreset('lark')
  expectEqual('lark named Lark', lark.name, 'Lark')
  expectTrue('lark css matches the shipped sheet', lark.css === themeCss('lark'))
  expectTrue('preset file exists', existsSync(presetCssPath('lark')))

  let bad = null
  try {
    presetCssPath('../evil')
  } catch (error) {
    bad = error
  }
  expectEqual('path traversal rejected', bad?.code, 'bad-request')

  // Legacy migration: settings.json + custom.css become one preset library.
  const legacy = await mkdtemp(join(tmpdir(), 'dsh-md2pdf-legacy-'))
  process.env['MD2PDF_HOME'] = legacy
  await writeFile(join(legacy, 'settings.json'), JSON.stringify({ theme: 'gongwen' }), 'utf8')
  await writeFile(join(legacy, 'custom.css'), 'body { font-size: 18px; }', 'utf8')

  const migrated = await listPresets()
  expectEqual('migration keeps the selected preset', migrated.selected, 'gongwen')
  const gongwen = await readPreset('gongwen')
  expectTrue('custom css lands in the selected preset', gongwen.css.endsWith('body { font-size: 18px; }'))
  expectTrue('builtin css stays first', gongwen.css.startsWith(themeCss('gongwen')))
  expectTrue('old files kept under .migrated',
    existsSync(join(legacy, 'settings.migrated.json')) && existsSync(join(legacy, 'custom.migrated.css')))
  expectTrue('old files removed from their original names',
    !existsSync(join(legacy, 'settings.json')) && !existsSync(join(legacy, 'custom.css')))
  await rm(legacy, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})

  // Mutations: create, rename, conflict, overwrite, ordering, deletion.
  const { savePreset, selectPreset, orderPresets, deletePreset, restoreBuiltins } =
    await import('../src/presets.js')
  const library = await mkdtemp(join(tmpdir(), 'dsh-md2pdf-library-'))
  process.env['MD2PDF_HOME'] = library

  const created = await savePreset({ name: '我的模板', css: 'body { font-size: 17px; }' })
  expectEqual('new preset appended', (await listPresets()).presets.length, 4)
  expectTrue('new preset id is generated', /^p[a-z0-9]+$/.test(created.id))

  const renamed = await savePreset({ id: 'lark', name: 'Lark 改', css: 'body { color: red; }' })
  expectEqual('rename keeps the id', renamed.id, 'lark')

  let conflict = null
  try {
    await savePreset({ name: 'Lark 改', css: 'body { color: blue; }' })
  } catch (error) {
    conflict = error
  }
  expectEqual('duplicate name refused without overwrite', conflict?.code, 'name-exists')

  await savePreset({ name: 'Lark 改', css: 'body { color: blue; }', overwrite: true })
  expectEqual('overwrite replaces the colliding preset css', (await readPreset('lark')).css, 'body { color: blue; }')

  let blank = null
  try {
    await savePreset({ name: '   ', css: '' })
  } catch (error) {
    blank = error
  }
  expectEqual('blank name refused', blank?.code, 'bad-request')

  await orderPresets(['paper', 'lark', 'gongwen', created.id])
  expectEqual('order applied', (await listPresets()).presets.map(preset => preset.id).join(','),
    `paper,lark,gongwen,${created.id}`)

  await selectPreset('paper')
  expectEqual('select persists', (await selectPreset('paper')).selected, 'paper')

  await selectPreset('gongwen')
  const afterDelete = await deletePreset('gongwen')
  expectEqual('deleting the selected preset falls back to the first', afterDelete.selected, 'paper')
  expectTrue('deleted preset file is gone', !existsSync(presetCssPath('gongwen')))

  await restoreBuiltins()
  const restored = await listPresets()
  expectTrue('restore brings back the missing builtins', restored.presets.some(preset => preset.id === 'gongwen'))
  expectTrue('restore keeps the existing presets', restored.presets.some(preset => preset.id === 'lark'))

  const remaining = (await listPresets()).presets.map(preset => preset.id)
  for (const id of remaining.slice(0, -1)) await deletePreset(id)
  const lastOne = await listPresets()
  expectEqual('one preset left before the final delete', lastOne.presets.length, 1)
  const rebuilt = await deletePreset(lastOne.presets[0].id)
  expectEqual('deleting the last preset rebuilds the default', rebuilt.presets.map(preset => preset.id).join(','), 'lark')
  expectEqual('rebuilt preset is selected', rebuilt.selected, 'lark')
  await rm(library, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})

  // A corrupt index must not wedge the plugin.
  const broken = await mkdtemp(join(tmpdir(), 'dsh-md2pdf-broken-'))
  process.env['MD2PDF_HOME'] = broken
  await writeFile(join(broken, 'presets.json'), '{ not json', 'utf8')
  const recovered = await listPresets()
  expectEqual('corrupt index recovers to the builtins', recovered.presets.length, 3)
  expectTrue('corrupt index kept as a backup', existsSync(join(broken, 'presets.json.corrupt')))
  await rm(broken, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})

  // Action dispatcher and the platform opener mapping.
  const actions = await mkdtemp(join(tmpdir(), 'dsh-md2pdf-actions-'))
  process.env['MD2PDF_HOME'] = actions
  const { runPresetAction } = await import('../src/presets.js')
  const { openCommandFor } = await import('../src/opener.js')

  const opened = await runPresetAction({ action: 'open', id: 'lark' })
  expectEqual('open resolves the preset file', opened.path, presetCssPath('lark'))

  let unknownPreset = null
  try {
    await runPresetAction({ action: 'open', id: 'nope' })
  } catch (error) {
    unknownPreset = error
  }
  expectEqual('open of an unknown preset refused', unknownPreset?.code, 'not-found')

  let unknownAction = null
  try {
    await runPresetAction({ action: 'explode' })
  } catch (error) {
    unknownAction = error
  }
  expectEqual('unknown action refused', unknownAction?.code, 'bad-request')

  expectEqual('windows opener uses start', openCommandFor('win32').args.join(' '), '/c start ""')
  expectEqual('macos opener uses open', openCommandFor('darwin').file, 'open')
  expectEqual('linux opener uses xdg-open', openCommandFor('linux').file, 'xdg-open')
  expectEqual('unknown platform has no opener', openCommandFor('aix'), null)
  await rm(actions, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
} finally {
  await rm(home, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
}

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`)
process.exit(failures === 0 ? 0 : 1)
