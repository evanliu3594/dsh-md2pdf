/**
 * The preset store: one CSS file per preset plus one index that carries the
 * display order and the selected preset.
 *
 * ```
 * $DSH_HOME/md2pdf/
 *   presets.json            { version, selected, presets: [{ id, name }] }
 *   presets/<id>.css        that preset's override layer
 * ```
 *
 * The index is the authority. Every write puts the CSS file down first and the
 * index second, so an interrupted write can leave an unreferenced file but
 * never an entry without a stylesheet.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { PdfError } from './pdf.js'
import { MAX_CSS_BYTES, settingsDirectory } from './settings.js'
import { DEFAULT_THEME, THEMES, themeCss } from './themes.js'

/** Index format written by this release. */
export const PRESET_INDEX_VERSION = 1

/** Identifiers safe to place in a file name. */
const PRESET_ID = /^[a-z0-9-]{1,64}$/

/**
 * The directory holding one stylesheet per preset.
 * @returns an absolute directory path.
 */
export function presetsDirectory() {
  return join(settingsDirectory(), 'presets')
}

/**
 * The index that carries order and selection.
 * @returns an absolute file path.
 */
export function presetIndexPath() {
  return join(settingsDirectory(), 'presets.json')
}

/**
 * The stylesheet path of one preset.
 * @param id - preset identifier.
 * @returns an absolute file path.
 * @throws {PdfError} when the identifier could escape the preset directory.
 */
export function presetCssPath(id) {
  if (typeof id !== 'string' || !PRESET_ID.test(id)) {
    throw new PdfError('bad-request', `invalid preset id: ${String(id)}`)
  }
  return join(presetsDirectory(), `${id}.css`)
}

/** The identifiers this build ships. */
function builtinIds() {
  return THEMES.map(preset => preset.id)
}

/**
 * Read the index from disk.
 * @returns the parsed index and whether the file exists but could not be used.
 */
async function readIndexFile() {
  let raw
  try {
    raw = await readFile(presetIndexPath(), 'utf8')
  } catch {
    return { index: null, corrupt: false }
  }
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.presets)) {
      return { index: null, corrupt: true }
    }
    return {
      corrupt: false,
      index: {
        version: PRESET_INDEX_VERSION,
        selected: typeof parsed.selected === 'string' ? parsed.selected : '',
        presets: parsed.presets
          .filter(entry => typeof entry?.id === 'string' && PRESET_ID.test(entry.id))
          .map(entry => ({ id: entry.id, name: typeof entry.name === 'string' ? entry.name : entry.id })),
      },
    }
  } catch {
    return { index: null, corrupt: true }
  }
}

/**
 * Write the index, replacing it in one rename.
 * @param index - the complete index to store.
 */
async function writeIndex(index) {
  await mkdir(settingsDirectory(), { recursive: true })
  const target = presetIndexPath()
  const staging = `${target}.tmp`
  await writeFile(staging, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
  await rename(staging, target)
}

/**
 * Write one preset's stylesheet, creating the directory it lives in.
 * @param id - preset identifier.
 * @param css - complete stylesheet text.
 */
async function writePresetCss(id, css) {
  await mkdir(presetsDirectory(), { recursive: true })
  await writeFile(presetCssPath(id), css, 'utf8')
}

/**
 * Read one preset's stylesheet.
 * @param id - preset identifier.
 * @returns the text, or an empty string when the file is missing.
 */
async function readPresetCss(id) {
  try {
    return await readFile(presetCssPath(id), 'utf8')
  } catch {
    return ''
  }
}

/**
 * Produce the index this build starts with.
 * @returns a fresh three-preset index.
 */
function seedIndex() {
  return {
    version: PRESET_INDEX_VERSION,
    selected: 'lark',
    presets: THEMES.map(preset => ({ id: preset.id, name: preset.label })),
  }
}

/**
 * Carry a pre-preset installation into the library.
 *
 * The old layout kept the choice in `settings.json` and one shared override in
 * `custom.css`. The choice becomes the selected preset; the shared override is
 * appended to that preset so the output stays what the user had. Both old files
 * are renamed rather than deleted.
 * @param index - the freshly seeded index.
 * @returns the index with the legacy selection applied.
 */
async function migrateLegacy(index) {
  const directory = settingsDirectory()
  let selected = index.selected

  try {
    const parsed = JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8'))
    if (typeof parsed?.theme === 'string' && index.presets.some(preset => preset.id === parsed.theme)) {
      selected = parsed.theme
    }
  } catch {
    // No legacy selection: the seeded default stands.
  }

  let custom = ''
  try {
    custom = await readFile(join(directory, 'custom.css'), 'utf8')
  } catch {
    // No legacy overrides: presets keep their shipped stylesheet.
  }

  if (custom.trim() !== '') {
    const base = await readPresetCss(selected)
    await writePresetCss(selected, `${base.trimEnd()}\n\n${custom.trimEnd()}`)
  }

  await rename(join(directory, 'settings.json'), join(directory, 'settings.migrated.json')).catch(() => {})
  await rename(join(directory, 'custom.css'), join(directory, 'custom.migrated.css')).catch(() => {})

  return { ...index, selected }
}

/**
 * Seed the store when it does not exist yet, then return the index.
 * @returns the stored index.
 */
export async function ensurePresets() {
  const stored = await readIndexFile()
  if (stored.index !== null && stored.index.presets.length > 0) return stored.index
  if (stored.corrupt) {
    // Keep the unusable file for inspection instead of overwriting it silently.
    await rename(presetIndexPath(), `${presetIndexPath()}.corrupt`).catch(() => {})
  }
  const seeded = seedIndex()
  for (const preset of THEMES) {
    await writePresetCss(preset.id, themeCss(preset.id))
  }
  const migrated = await migrateLegacy(seeded)
  await writeIndex(migrated)
  return migrated
}

/**
 * List every preset with the flags the settings page shows.
 * @returns the selected identifier and one entry per preset, in display order.
 */
export async function listPresets() {
  const index = await ensurePresets()
  const builtin = builtinIds()
  const presets = []
  for (const entry of index.presets) {
    const shipped = builtin.includes(entry.id)
    const unmodified = shipped && (await readPresetCss(entry.id)) === themeCss(entry.id)
    presets.push({ id: entry.id, name: entry.name, builtin: shipped, unmodified })
  }
  const selected = presets.some(preset => preset.id === index.selected) ? index.selected : presets[0].id
  return { selected, presets }
}

/**
 * Read one preset's name and stylesheet.
 * @param id - preset identifier.
 * @returns the preset.
 * @throws {PdfError} when the identifier is unknown.
 */
export async function readPreset(id) {
  const index = await ensurePresets()
  const entry = index.presets.find(preset => preset.id === id)
  if (entry === undefined) throw new PdfError('not-found', `unknown preset: ${String(id)}`)
  return { id: entry.id, name: entry.name, css: await readPresetCss(entry.id) }
}

/** A name conflict carries the id it collides with. */
function nameConflict(id) {
  const error = new PdfError('name-exists', `a preset named that already exists: ${id}`)
  error.details = { id }
  return error
}

/** A fresh identifier; stable once written and never reused. */
function newPresetId() {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/**
 * Put the default preset back, used when deleting would leave no preset at all.
 *
 * Only the default returns: the user deleted the others on purpose, and the
 * settings page offers an explicit restore for the shipped set.
 */
async function rebuildDefault() {
  const preset = THEMES.find(entry => entry.id === DEFAULT_THEME) ?? THEMES[0]
  await writePresetCss(preset.id, themeCss(preset.id))
  const index = {
    version: PRESET_INDEX_VERSION,
    selected: preset.id,
    presets: [{ id: preset.id, name: preset.label }],
  }
  await writeIndex(index)
  return index
}

/**
 * Create or update one preset.
 * @param input - the identifier to update, the display name, the stylesheet, and
 *   whether a name collision may replace the other preset.
 * @returns the stored preset identity and whether it was created.
 * @throws {PdfError} for a blank name, an unknown id, or an unconfirmed collision.
 */
export async function savePreset(input) {
  const index = await ensurePresets()
  const name = typeof input?.name === 'string' ? input.name.trim() : ''
  const css = typeof input?.css === 'string' ? input.css : ''
  if (name === '') throw new PdfError('bad-request', 'preset name is required')
  if (Buffer.byteLength(css, 'utf8') > MAX_CSS_BYTES) {
    throw new PdfError('too-large', `stylesheet exceeds ${MAX_CSS_BYTES} bytes`)
  }

  const colliding = index.presets.find(preset => preset.name === name)
  let targetId = typeof input?.id === 'string' ? input.id : undefined

  if (targetId !== undefined && !index.presets.some(preset => preset.id === targetId)) {
    throw new PdfError('not-found', `unknown preset: ${targetId}`)
  }
  if (colliding !== undefined && colliding.id !== targetId) {
    if (input?.overwrite !== true) throw nameConflict(colliding.id)
    targetId = colliding.id
  }

  const created = targetId === undefined
  if (created) targetId = newPresetId()

  await writePresetCss(targetId, css)
  const presets = created
    ? [...index.presets, { id: targetId, name }]
    : index.presets.map(preset => (preset.id === targetId ? { id: preset.id, name } : preset))
  await writeIndex({ ...index, selected: targetId, presets })
  return { id: targetId, name, created }
}

/**
 * Make one preset the selected one.
 * @param id - preset identifier.
 * @returns the stored selection.
 */
export async function selectPreset(id) {
  const index = await ensurePresets()
  if (!index.presets.some(preset => preset.id === id)) throw new PdfError('not-found', `unknown preset: ${String(id)}`)
  await writeIndex({ ...index, selected: id })
  return { selected: id }
}

/**
 * Replace the display order.
 * @param ids - every preset identifier, in the new order.
 * @returns the reordered presets.
 * @throws {PdfError} when `ids` is not a permutation of the stored identifiers.
 */
export async function orderPresets(ids) {
  const index = await ensurePresets()
  const byId = new Map(index.presets.map(preset => [preset.id, preset]))
  if (!Array.isArray(ids) || ids.length !== index.presets.length) {
    throw new PdfError('bad-request', 'order must list every preset exactly once')
  }
  const seen = new Set()
  const presets = ids.map((id) => {
    const preset = byId.get(id)
    if (preset === undefined || seen.has(id)) {
      throw new PdfError('bad-request', 'order must list every preset exactly once')
    }
    seen.add(id)
    return preset
  })
  await writeIndex({ ...index, presets })
  return { presets: presets.map(({ id, name }) => ({ id, name })) }
}

/**
 * Delete one preset.
 *
 * Deleting the selected preset selects the first remaining one; deleting the
 * last preset rebuilds the shipped three, so the library is never empty.
 * @param id - preset identifier.
 * @returns the selection after deletion and the remaining presets.
 */
export async function deletePreset(id) {
  const index = await ensurePresets()
  if (!index.presets.some(preset => preset.id === id)) {
    throw new PdfError('not-found', `unknown preset: ${String(id)}`)
  }
  const presets = index.presets.filter(preset => preset.id !== id)
  await rm(presetCssPath(id), { force: true })
  if (presets.length === 0) {
    const rebuilt = await rebuildDefault()
    return {
      selected: rebuilt.selected,
      presets: rebuilt.presets.map(({ id: presetId, name }) => ({ id: presetId, name })),
    }
  }
  const selected = index.selected === id ? presets[0].id : index.selected
  await writeIndex({ ...index, selected, presets })
  return { selected, presets: presets.map(({ id: presetId, name }) => ({ id: presetId, name })) }
}

/**
 * Put back the shipped presets that are missing, leaving the others untouched.
 * @returns every preset after restoration, in display order.
 */
export async function restoreBuiltins() {
  const index = await ensurePresets()
  const present = new Set(index.presets.map(preset => preset.id))
  const restored = [...index.presets]
  for (const theme of THEMES) {
    if (present.has(theme.id)) continue
    await writePresetCss(theme.id, themeCss(theme.id))
    restored.push({ id: theme.id, name: theme.label })
  }
  if (restored.length !== index.presets.length) {
    await writeIndex({ ...index, presets: restored })
  }
  return { presets: restored.map(({ id, name }) => ({ id, name })) }
}

export { MAX_CSS_BYTES }

/**
 * Run one settings action.
 *
 * The HTTP route parses a body and hands it here, so every operation the page
 * offers is reachable from a check without a server.
 * @param action - `{ action, id?, name?, css?, ids?, overwrite? }`.
 * @returns the action's own result.
 * @throws {PdfError} for an unknown action or a refused operation.
 */
export async function runPresetAction(action) {
  const kind = typeof action?.action === 'string' ? action.action : ''
  switch (kind) {
    case 'read':
      return readPreset(action.id)
    case 'select':
      return selectPreset(action.id)
    case 'save':
      return savePreset({ id: action.id, name: action.name, css: action.css, overwrite: action.overwrite })
    case 'order':
      return orderPresets(action.ids)
    case 'delete':
      return deletePreset(action.id)
    case 'restore':
      return restoreBuiltins()
    case 'open': {
      const index = await ensurePresets()
      if (!index.presets.some(preset => preset.id === action.id)) {
        throw new PdfError('not-found', `unknown preset: ${String(action.id)}`)
      }
      return { path: presetCssPath(action.id) }
    }
    default:
      throw new PdfError('bad-request', `unknown preset action: ${kind === '' ? '(missing)' : kind}`)
  }
}
