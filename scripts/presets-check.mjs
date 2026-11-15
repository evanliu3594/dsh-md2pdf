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

const { listPresets, readPreset, presetCssPath, savePresetPage, runPresetAction } =
  await import('../src/presets.js')

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

/**
 * Run one call and return the error it throws.
 * @param run - the call, or a promise of it, expected to refuse its input.
 * @returns the thrown error, or null when the call returned.
 */
async function capture(run) {
  try {
    await (typeof run === 'function' ? run() : run)
  } catch (error) {
    return error
  }
  return null
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

  // Index version 2: a v1 library migrates without touching CSS, and page
  // metadata exists only after the user saves page settings.
  const pageHome = await mkdtemp(join(tmpdir(), 'dsh-md2pdf-page-'))
  process.env['MD2PDF_HOME'] = pageHome
  await writeFile(join(pageHome, 'lark.css'), 'body { color: teal; }', 'utf8')
  await writeFile(join(pageHome, 'presets.json'), JSON.stringify({
    version: 1,
    selected: 'gongwen',
    presets: [
      { id: 'lark', name: 'Lark' },
      { id: 'gongwen', name: '公文' },
      { id: 'paper', name: '论文' },
    ],
  }), 'utf8')

  const migratedIndex = await listPresets()
  expectEqual('v1 selection survives migration', migratedIndex.selected, 'gongwen')
  expectEqual('v1 order survives migration',
    migratedIndex.presets.map(preset => preset.id).join(','), 'lark,gongwen,paper')
  const writtenV1 = JSON.parse(await readFile(join(pageHome, 'presets.json'), 'utf8'))
  expectEqual('v1 index is written back as version 2', writtenV1.version, 2)
  expectTrue('v1 presets gain a description',
    writtenV1.presets.every(preset => typeof preset.description === 'string'))
  expectTrue('v1 presets gain no page',
    writtenV1.presets.every(preset => !Object.hasOwn(preset, 'page')))
  expectEqual('v1 preset css is untouched',
    await readFile(join(pageHome, 'lark.css'), 'utf8'), 'body { color: teal; }')

  await runPresetAction({ action: 'save-page', id: 'lark', page: { marginMm: 20 } })
  const savedPage = JSON.parse(await readFile(join(pageHome, 'presets.json'), 'utf8'))
  const larkEntry = savedPage.presets.find(preset => preset.id === 'lark')
  expectEqual('save-page writes only its explicit field',
    JSON.stringify(larkEntry.page), JSON.stringify({ marginMm: 20 }))
  expectEqual('save-page keeps the index version', savedPage.version, 2)
  expectEqual('readPreset returns page metadata', (await readPreset('lark')).page.marginMm, 20)
  const listedPage = await listPresets()
  expectEqual('listPresets returns page metadata',
    listedPage.presets.find(preset => preset.id === 'lark').page.marginMm, 20)
  expectTrue('a preset without page metadata carries no page',
    !Object.hasOwn(listedPage.presets.find(preset => preset.id === 'gongwen'), 'page'))
  const pagePreviews = await (await import('../src/previews.js')).buildPreviews()
  expectTrue('a preview applies the saved page metadata',
    pagePreviews.presets.lark.includes('padding:20mm'))

  // The settings route exposes the stored page on each preset.
  const { apply, SETTINGS_PATH } = await import('../index.js')
  const routes = new Map()
  apply({
    effect(register) {
      register()
      return () => {}
    },
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
        return () => {}
      },
    },
    connection: { requestRejection() { return undefined } },
    tools: { register() { return () => {} } },
    get() { return undefined },
  }, {})
  const settingsResponse = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name] = value },
    end(body = '') { this.body = body },
  }
  await routes.get(SETTINGS_PATH)({ method: 'GET', headers: {} }, settingsResponse)
  expectEqual('settings route answers', settingsResponse.statusCode, 200)
  const settingsPage = JSON.parse(settingsResponse.body)
  expectEqual('settings route returns page per preset',
    settingsPage.presets.find(preset => preset.id === 'lark').page.marginMm, 20)
  expectTrue('settings route omits an unset page',
    !Object.hasOwn(settingsPage.presets.find(preset => preset.id === 'gongwen'), 'page'))

  const badPages = [
    ['an invalid size', { size: 'B5' }],
    ['an out-of-range margin', { marginMm: 61 }],
    ['an out-of-range font size', { fontSize: 7 }],
    ['an unknown page field', { bleed: 3 }],
  ]
  for (const [label, page] of badPages) {
    let refused = null
    try {
      await runPresetAction({ action: 'save-page', id: 'lark', page })
    } catch (error) {
      refused = error
    }
    expectEqual(`save-page refuses ${label}`, refused?.code, 'bad-request')
  }
  let unknownPagePreset = null
  try {
    await runPresetAction({ action: 'save-page', id: 'missing', page: { marginMm: 20 } })
  } catch (error) {
    unknownPagePreset = error
  }
  expectEqual('save-page refuses an unknown preset', unknownPagePreset?.code, 'not-found')

  // A later save stores only its own explicit fields; an empty page removes the
  // metadata, and the actions that rewrite the index keep what is stored.
  await savePresetPage('lark', { fontSize: 12 })
  const fontPage = JSON.parse(await readFile(join(pageHome, 'presets.json'), 'utf8'))
  expectEqual('a later save writes only its own field',
    JSON.stringify(fontPage.presets.find(preset => preset.id === 'lark').page),
    JSON.stringify({ fontSize: 12 }))
  await savePresetPage('lark', {})
  const clearedPage = JSON.parse(await readFile(join(pageHome, 'presets.json'), 'utf8'))
  expectTrue('an empty page removes the metadata',
    !Object.hasOwn(clearedPage.presets.find(preset => preset.id === 'lark'), 'page'))
  expectTrue('readPreset reports no page after clearing', (await readPreset('lark')).page === undefined)

  await savePresetPage('lark', { marginMm: 20, fontSize: 12 })
  await savePreset({ id: 'lark', name: 'Lark', css: 'body { color: teal; }' })
  const afterSave = JSON.parse(await readFile(join(pageHome, 'presets.json'), 'utf8'))
  expectEqual('saving a preset keeps its page metadata',
    JSON.stringify(afterSave.presets.find(preset => preset.id === 'lark').page),
    JSON.stringify({ marginMm: 20, fontSize: 12 }))
  expectEqual('saving a preset keeps its description',
    afterSave.presets.find(preset => preset.id === 'lark').description, '')
  await orderPresets(['paper', 'lark', 'gongwen'])
  const afterOrder = JSON.parse(await readFile(join(pageHome, 'presets.json'), 'utf8'))
  expectEqual('reordering keeps page metadata',
    JSON.stringify(afterOrder.presets.find(preset => preset.id === 'lark').page),
    JSON.stringify({ marginMm: 20, fontSize: 12 }))
  await rm(pageHome, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})

  // The settings page and the preview route can read a v1 library at the same
  // time. The migration write is serialized, so neither read fails.
  const concurrentHome = await mkdtemp(join(tmpdir(), 'dsh-md2pdf-concurrent-'))
  process.env['MD2PDF_HOME'] = concurrentHome
  await writeFile(join(concurrentHome, 'presets.json'), JSON.stringify({
    version: 1,
    selected: 'lark',
    presets: [
      { id: 'lark', name: 'Lark' },
      { id: 'gongwen', name: '公文' },
      { id: 'paper', name: '论文' },
    ],
  }), 'utf8')
  const concurrentReads = await Promise.all([listPresets(), listPresets(), listPresets()])
  expectEqual('concurrent first reads all see the library',
    concurrentReads.every(result => result.presets.length === 3), true)
  const concurrentIndex = JSON.parse(await readFile(join(concurrentHome, 'presets.json'), 'utf8'))
  expectEqual('concurrent first reads migrate once', concurrentIndex.version, 2)
  await rm(concurrentHome, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})

  // Every index mutation is one read-modify-write transaction. A page save that
  // overlaps a select, an order, or a settings save must keep both results, and
  // a failed transaction must not block the next one.
  const raceHome = await mkdtemp(join(tmpdir(), 'dsh-md2pdf-race-'))
  process.env['MD2PDF_HOME'] = raceHome
  await listPresets()
  await selectPreset('lark')
  await Promise.all([
    savePresetPage('lark', { marginMm: 20 }),
    selectPreset('paper'),
  ])
  const racedSelect = JSON.parse(await readFile(join(raceHome, 'presets.json'), 'utf8'))
  expectEqual('a page save racing a select keeps the page',
    racedSelect.presets.find(preset => preset.id === 'lark').page?.marginMm, 20)
  expectEqual('a page save racing a select keeps the selection', racedSelect.selected, 'paper')

  await Promise.all([
    savePresetPage('gongwen', { fontSize: 12 }),
    orderPresets(['paper', 'lark', 'gongwen']),
  ])
  const racedOrder = JSON.parse(await readFile(join(raceHome, 'presets.json'), 'utf8'))
  expectEqual('a page save racing an order keeps the page',
    racedOrder.presets.find(preset => preset.id === 'gongwen').page?.fontSize, 12)
  expectEqual('a page save racing an order keeps the order',
    racedOrder.presets.map(preset => preset.id).join(','), 'paper,lark,gongwen')

  await Promise.all([
    savePresetPage('paper', { marginMm: 18 }),
    savePreset({ id: 'lark', name: 'Lark 竞态', css: 'body { color: red; }' }),
  ])
  const racedSave = JSON.parse(await readFile(join(raceHome, 'presets.json'), 'utf8'))
  expectEqual('a page save racing a settings save keeps the page',
    racedSave.presets.find(preset => preset.id === 'paper').page?.marginMm, 18)
  expectEqual('a page save racing a settings save keeps the name',
    racedSave.presets.find(preset => preset.id === 'lark').name, 'Lark 竞态')
  expectEqual('a page save racing a settings save keeps the selection', racedSave.selected, 'lark')

  let raceFailure = null
  try {
    await savePresetPage('missing', { marginMm: 20 })
  } catch (error) {
    raceFailure = error
  }
  expectEqual('a failed transaction is refused', raceFailure?.code, 'not-found')
  await selectPreset('lark')
  expectEqual('a failed transaction does not block the next one',
    JSON.parse(await readFile(join(raceHome, 'presets.json'), 'utf8')).selected, 'lark')
  await rm(raceHome, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})

  // A stored page is validated like a request page; a hand-edited invalid value
  // is refused instead of silently printing with a different page box.
  const invalidPageHome = await mkdtemp(join(tmpdir(), 'dsh-md2pdf-invalid-page-'))
  process.env['MD2PDF_HOME'] = invalidPageHome
  await writeFile(join(invalidPageHome, 'presets.json'), JSON.stringify({
    version: 2,
    selected: 'lark',
    presets: [{ id: 'lark', name: 'Lark', page: { size: 'B5' } }],
  }), 'utf8')
  let storedPage = null
  try {
    await listPresets()
  } catch (error) {
    storedPage = error
  }
  expectEqual('an invalid stored page is refused', storedPage?.code, 'bad-request')
  await rm(invalidPageHome, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})

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

  // Bundle export, import, and preset history.
  const bundleHome = await mkdtemp(join(tmpdir(), 'dsh-md2pdf-bundle-'))
  process.env['MD2PDF_HOME'] = bundleHome
  const {
    exportPresetBundle, importPresetBundle, listPresetHistory, restorePresetHistory, savePreset: saveBundlePreset,
  } = await import('../src/presets.js')

  const bundle = await exportPresetBundle()
  expectEqual('a bundle carries three presets', bundle.presets.length, 3)
  expectEqual('a bundle carries the selected id', bundle.selected, 'lark')
  expectEqual('a bundle keeps the preset order', bundle.presets.map(preset => preset.id).join(','), 'lark,gongwen,paper')
  expectTrue('a bundle carries css', bundle.presets.every(preset => typeof preset.css === 'string' && preset.css.length > 200))
  expectEqual('a bundle is version 2', bundle.version, 2)

  const importHome = await mkdtemp(join(tmpdir(), 'dsh-md2pdf-import-'))
  process.env['MD2PDF_HOME'] = importHome
  const customBundle = {
    version: 2,
    selected: 'custom-a',
    presets: [
      ...bundle.presets,
      { id: 'custom-a', name: 'Custom A', css: 'body { color: red; }', page: { marginMm: 20 } },
    ],
  }
  const imported = await importPresetBundle(customBundle)
  expectEqual('import creates a new preset', imported.imported.join(','), 'custom-a')
  expectEqual('import reports every existing preset', imported.warnings.length, 3)
  const customRead = await readPreset('custom-a')
  expectEqual('an imported css is stored', customRead.css, 'body { color: red; }')
  expectEqual('an imported page is stored', customRead.page.marginMm, 20)
  expectEqual('an imported preset is not builtin',
    (await listPresets()).presets.find(preset => preset.id === 'custom-a').builtin, false)

  const larkBefore = (await readPreset('lark')).css
  const secondImport = await importPresetBundle(customBundle)
  expectEqual('a second import imports nothing', secondImport.imported.length, 0)
  expectEqual('a second import reports all conflicts', secondImport.warnings.length, 4)
  expectEqual('a second import keeps the existing css', (await readPreset('lark')).css, larkBefore)

  const overwritten = await importPresetBundle({
    version: 2,
    presets: [{ id: 'custom-a', name: 'Custom B', css: 'body { color: blue; }', page: { marginMm: 30 } }],
  }, { overwrite: true })
  expectEqual('overwrite imports the preset', overwritten.imported.join(','), 'custom-a')
  const customOverwritten = await readPreset('custom-a')
  expectEqual('overwrite replaces the css', customOverwritten.css, 'body { color: blue; }')
  expectEqual('overwrite replaces the page', customOverwritten.page.marginMm, 30)
  expectEqual('overwrite keeps the existing name', customOverwritten.name, 'Custom A')

  expectEqual('a path-like id is refused',
    (await capture(importPresetBundle({ version: 2, presets: [{ id: '../evil', name: 'x', css: '' }] })))?.code, 'bad-request')
  expectEqual('an oversized css is refused',
    (await capture(importPresetBundle({
      version: 2,
      presets: [{ id: 'big', name: 'x', css: 'a'.repeat(524289) }],
    })))?.code, 'too-large')
  expectEqual('an invalid page is refused',
    (await capture(importPresetBundle({
      version: 2,
      presets: [{ id: 'bad-page', name: 'x', css: '', page: { size: 'B5' } }],
    })))?.code, 'bad-request')
  expectEqual('a foreign bundle version is refused',
    (await capture(importPresetBundle({ version: 1, presets: [] })))?.code, 'bad-request')
  expectEqual('a duplicate bundle id is refused',
    (await capture(importPresetBundle({
      version: 2,
      presets: [
        { id: 'dup', name: 'one', css: '' },
        { id: 'dup', name: 'two', css: '' },
      ],
    })))?.code, 'bad-request')
  await rm(importHome, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})

  const historyHome = await mkdtemp(join(tmpdir(), 'dsh-md2pdf-history-'))
  process.env['MD2PDF_HOME'] = historyHome
  await listPresets()
  await saveBundlePreset({ id: 'lark', name: 'Lark', css: 'body { color: red; }' })
  const history = await listPresetHistory('lark')
  expectEqual('a save records one history entry', history.length, 1)
  expectTrue('a history entry has a name', typeof history[0].name === 'string' && history[0].name !== '')
  expectTrue('a history entry has a time', typeof history[0].savedAt === 'string')
  const restoredHistory = await restorePresetHistory('lark', history[0].name)
  expectEqual('restore returns the stored css', restoredHistory.css, themeCss('lark'))
  expectEqual('restore writes the preset css', (await readPreset('lark')).css, themeCss('lark'))
  const afterRestore = await listPresetHistory('lark')
  expectEqual('restore records the replaced css', afterRestore.length, 2)
  expectEqual('restore of an unknown entry is refused',
    (await capture(restorePresetHistory('lark', '1700000000000-abcdef12.css')))?.code, 'not-found')
  expectEqual('a path-like history name is refused',
    (await capture(restorePresetHistory('lark', '../x')))?.code, 'bad-request')

  for (let index = 0; index < 25; index += 1) {
    await saveBundlePreset({ id: 'lark', name: 'Lark', css: 'body { color: rgb(' + index + ',0,0); }' })
  }
  const capped = await listPresetHistory('lark')
  expectEqual('history keeps twenty entries', capped.length, 20)
  expectTrue('history lists newest first', capped[0].savedAt >= capped[19].savedAt)
  await rm(historyHome, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
} finally {
  await rm(home, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
}

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`)
process.exit(failures === 0 ? 0 : 1)
