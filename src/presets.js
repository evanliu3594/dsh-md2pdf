/**
 * The preset store: one CSS file per preset plus one index that carries the
 * display order, the selected preset, and optional page metadata.
 *
 * ```
 * $DSH_HOME/md2pdf/
 *   presets.json            { version, selected, presets: [{ id, name, description?, page? }] }
 *   presets/<id>.css        that preset's override layer
 * ```
 *
 * The index is the authority. Every write puts the CSS file down first and the
 * index second, so an interrupted write can leave an unreferenced file but
 * never an entry without a stylesheet.
 *
 * `page` is a partial page override: it contains only the fields the user
 * saved, and its absence means the preset's own `@page` box is the authority.
 * A version 1 index is rewritten as version 2 on its first read; its
 * stylesheets are not touched.
 */
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { validatePageOverride } from './document-config.js'
import { PdfError } from './pdf.js'
import { MAX_CSS_BYTES, settingsDirectory } from './settings.js'
import { DEFAULT_THEME, THEMES, themeCss } from './themes.js'

/** Index format written by this release. */
export const PRESET_INDEX_VERSION = 2

/** Identifiers safe to place in a file name. */
const PRESET_ID = /^[a-z0-9-]{1,64}$/

/** History snapshots kept per preset. */
const HISTORY_LIMIT = 20

/** One history file name: a millisecond stamp and random bytes. */
const HISTORY_NAME = /^[0-9]+-[a-f0-9]{8}\.css$/

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
 * Read a stored page override.
 *
 * The value is validated exactly like a request page, so a hand-edited invalid
 * size or an out-of-range margin is refused instead of silently printing a
 * different page box. An empty object is treated as absent: the index stores no
 * page when the user has not saved page settings.
 * @param raw - the stored `page` value.
 * @param id - preset identifier, for the failure message.
 * @returns the validated partial page, or undefined when absent or empty.
 * @throws {PdfError} when a stored field is invalid.
 */
function storedPage(raw, id) {
  if (raw === undefined || raw === null) return undefined
  const page = validatePageOverride(raw, `presets.${id}.page`)
  return Object.keys(page).length === 0 ? undefined : page
}

/**
 * Read the index from disk.
 * @returns the parsed index, whether the file exists but could not be used, and
 *   whether the parsed file must be rewritten in the current format.
 */
async function readIndexFile() {
  let raw
  try {
    raw = await readFile(presetIndexPath(), 'utf8')
  } catch {
    return { index: null, corrupt: false, migrate: false }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { index: null, corrupt: true, migrate: false }
  }
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.presets)) {
    return { index: null, corrupt: true, migrate: false }
  }
  const previous = parsed.version !== PRESET_INDEX_VERSION
  const presets = parsed.presets
    .filter(entry => typeof entry?.id === 'string' && PRESET_ID.test(entry.id))
    .map((entry) => {
      const preset = {
        id: entry.id,
        name: typeof entry.name === 'string' ? entry.name : entry.id,
      }
      if (typeof entry.description === 'string') {
        preset.description = entry.description
      } else if (previous) {
        // A version 1 entry has no description; the v2 format adds it.
        preset.description = ''
      }
      const page = storedPage(entry.page, entry.id)
      if (page !== undefined) preset.page = page
      return preset
    })
  return {
    corrupt: false,
    migrate: previous,
    index: {
      version: PRESET_INDEX_VERSION,
      selected: typeof parsed.selected === 'string' ? parsed.selected : '',
      presets,
    },
  }
}

/** One in-process transaction queue per settings directory. */
const indexTransactions = new Map()

/**
 * Run one read-modify-write transaction after every earlier transaction for the
 * same settings directory.
 *
 * Serializing only the write is not enough: two actions can read the same index
 * and the second write then discards the first change. The queue therefore
 * covers the whole read-modify-write. It is keyed by the settings directory, so
 * two `MD2PDF_HOME` values never wait on each other, and it continues after a
 * refused transaction so one invalid action cannot wedge the settings page. A
 * transaction body must call the internal unlocked helpers, never a public
 * action, or it would wait on its own queued slot.
 * @param work - the transaction body.
 * @returns the transaction's result or error.
 */
function withIndexTransaction(work) {
  const key = settingsDirectory()
  const previous = indexTransactions.get(key) ?? Promise.resolve()
  const next = previous.then(work, work)
  const settled = next.then(() => undefined, () => undefined)
  indexTransactions.set(key, settled)
  settled.then(() => {
    if (indexTransactions.get(key) === settled) indexTransactions.delete(key)
  })
  return next
}

/**
 * Write the index file, replacing it in one rename.
 * @param index - the complete index to store.
 * @param directory - directory that holds the index.
 * @param target - absolute index path.
 * @param staging - fixed staging path beside the target.
 */
async function writeIndexFile(index, directory, target, staging) {
  await mkdir(directory, { recursive: true })
  await writeFile(staging, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
  await rename(staging, target)
}

/**
 * Write the index file from inside a transaction.
 *
 * The transaction queue guarantees that no two writers reach this staging path
 * at once, so one fixed staging name is safe.
 * @param index - the complete index to store.
 * @returns a promise for this write.
 */
async function writeIndex(index) {
  const directory = settingsDirectory()
  const target = presetIndexPath()
  await writeIndexFile(index, directory, target, `${target}.tmp`)
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
 *
 * This is the unlocked body: its callers hold the directory's transaction, so a
 * concurrent action cannot read the same version and write over the migration.
 * @returns the stored index.
 */
async function readOrSeedIndex() {
  const stored = await readIndexFile()
  if (stored.index !== null && stored.index.presets.length > 0) {
    // The first read of a version 1 index writes the version 2 format back;
    // only metadata changes, and `writeIndex` replaces the file in one rename.
    if (stored.migrate) await writeIndex(stored.index)
    return stored.index
  }
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
 * Seed the store when it does not exist yet, then return the index.
 *
 * Reads and migrations share the directory's transaction queue, so a migration
 * write cannot replace a concurrent selection or page save with stale state.
 * @returns the stored index.
 */
export async function ensurePresets() {
  return withIndexTransaction(readOrSeedIndex)
}

/**
 * List every preset with the flags the settings page shows.
 *
 * Optional metadata is copied only when it exists, so an unset description or
 * page stays absent from the response and the JSON body.
 * @returns the selected identifier and one entry per preset, in display order.
 */
export async function listPresets() {
  const index = await ensurePresets()
  const builtin = builtinIds()
  const presets = []
  for (const entry of index.presets) {
    const shipped = builtin.includes(entry.id)
    const unmodified = shipped && (await readPresetCss(entry.id)) === themeCss(entry.id)
    const national = shipped && THEMES.some(theme => theme.id === entry.id && theme.gb === true)
    const preset = { id: entry.id, name: entry.name, builtin: shipped, unmodified, gb: national }
    if (entry.description !== undefined) preset.description = entry.description
    if (entry.page !== undefined) preset.page = { ...entry.page }
    presets.push(preset)
  }
  const selected = presets.some(preset => preset.id === index.selected) ? index.selected : presets[0].id
  return { selected, presets }
}

/**
 * Read one preset's name, optional metadata, and stylesheet.
 * @param id - preset identifier.
 * @returns the preset.
 * @throws {PdfError} when the identifier is unknown.
 */
export async function readPreset(id) {
  const index = await ensurePresets()
  const entry = index.presets.find(preset => preset.id === id)
  if (entry === undefined) throw new PdfError('not-found', `unknown preset: ${String(id)}`)
  const preset = { id: entry.id, name: entry.name, css: await readPresetCss(entry.id) }
  if (entry.description !== undefined) preset.description = entry.description
  if (entry.page !== undefined) preset.page = { ...entry.page }
  return preset
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
  return withIndexTransaction(() => savePresetLocked(input))
}

/**
 * Apply one preset save inside its directory's transaction.
 * @param input - the same input as {@link savePreset}.
 * @returns the stored preset identity and whether it was created.
 */
async function savePresetLocked(input) {
  const index = await readOrSeedIndex()
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
  else await recordPresetHistory(targetId, await readPresetCss(targetId))

  await writePresetCss(targetId, css)
  const presets = created
    ? [...index.presets, { id: targetId, name }]
    : index.presets.map(preset => (preset.id === targetId ? { ...preset, name } : preset))
  await writeIndex({ ...index, selected: targetId, presets })
  return { id: targetId, name, created }
}

/**
 * Store or clear one preset's page metadata.
 *
 * The page is a partial override: only the fields in `page` are stored, and a
 * field passed as `null` is ignored. An empty page, `null`, or `undefined`
 * removes the metadata, which makes the preset's own `@page` box the
 * authority again. A later save replaces the stored override; the settings
 * page sends the complete set of fields that differ from the preset CSS.
 * @param id - preset identifier.
 * @param page - the page fields to store, or an empty value to clear.
 * @returns the stored identifier and page, with `page` absent after clearing.
 * @throws {PdfError} when the preset is unknown or a page field is invalid.
 */
export async function savePresetPage(id, page) {
  return withIndexTransaction(() => savePresetPageLocked(id, page))
}

/**
 * Store or clear one preset's page inside its directory's transaction.
 * @param id - preset identifier.
 * @param page - the page fields to store, or an empty value to clear.
 * @returns the stored identifier and page, with `page` absent after clearing.
 */
async function savePresetPageLocked(id, page) {
  const index = await readOrSeedIndex()
  if (!index.presets.some(preset => preset.id === id)) {
    throw new PdfError('not-found', `unknown preset: ${String(id)}`)
  }
  const override = page === undefined || page === null ? {} : validatePageOverride(page, 'page')
  const presets = index.presets.map((preset) => {
    if (preset.id !== id) return preset
    const next = { ...preset }
    if (Object.keys(override).length === 0) delete next.page
    else next.page = override
    return next
  })
  await writeIndex({ ...index, presets })
  return Object.keys(override).length === 0 ? { id } : { id, page: override }
}

/**
 * Make one preset the selected one.
 * @param id - preset identifier.
 * @returns the stored selection.
 */
export async function selectPreset(id) {
  return withIndexTransaction(() => selectPresetLocked(id))
}

/**
 * Apply one selection inside its directory's transaction.
 * @param id - preset identifier.
 * @returns the stored selection.
 */
async function selectPresetLocked(id) {
  const index = await readOrSeedIndex()
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
  return withIndexTransaction(() => orderPresetsLocked(ids))
}

/**
 * Apply one reorder inside its directory's transaction.
 * @param ids - every preset identifier, in the new order.
 * @returns the reordered presets.
 */
async function orderPresetsLocked(ids) {
  const index = await readOrSeedIndex()
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
  return withIndexTransaction(() => deletePresetLocked(id))
}

/**
 * Apply one deletion inside its directory's transaction.
 * @param id - preset identifier.
 * @returns the selection after deletion and the remaining presets.
 */
async function deletePresetLocked(id) {
  const index = await readOrSeedIndex()
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
  return withIndexTransaction(restoreBuiltinsLocked)
}

/**
 * Restore the missing shipped presets inside the directory's transaction.
 * @returns every preset after restoration, in display order.
 */
async function restoreBuiltinsLocked() {
  const index = await readOrSeedIndex()
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

/**
 * The history directory of one preset.
 * @param id - preset identifier.
 * @returns an absolute directory path.
 * @throws {PdfError} when the identifier could escape the plugin directory.
 */
function historyDirectory(id) {
  if (typeof id !== 'string' || !PRESET_ID.test(id)) {
    throw new PdfError('bad-request', 'invalid preset id: ' + String(id))
  }
  return join(settingsDirectory(), 'history', id)
}

/**
 * Keep at most the newest history snapshots.
 * @param directory - one preset's history directory.
 */
async function prunePresetHistory(directory) {
  let names
  try {
    names = await readdir(directory)
  } catch {
    return
  }
  const entries = []
  for (const name of names) {
    if (!HISTORY_NAME.test(name)) continue
    const info = await stat(join(directory, name)).catch(() => null)
    if (info !== null) entries.push({ name, stamp: Number(name.slice(0, name.indexOf('-'))), at: info.mtimeMs })
  }
  entries.sort((left, right) => right.stamp - left.stamp || right.at - left.at)
  for (const entry of entries.slice(HISTORY_LIMIT)) {
    await rm(join(directory, entry.name), { force: true }).catch(() => {})
  }
}

/**
 * Record one snapshot of a preset's previous stylesheet.
 *
 * History is written before the preset changes, so the entry is the state the
 * user is leaving. An empty stylesheet is not recorded: it is the absence of a
 * stylesheet, not a version.
 * @param id - preset identifier.
 * @param css - the stylesheet being replaced.
 */
async function recordPresetHistory(id, css) {
  if (typeof css !== 'string' || css === '') return
  const directory = historyDirectory(id)
  await mkdir(directory, { recursive: true })
  const name = String(Date.now()) + '-' + randomBytes(4).toString('hex') + '.css'
  await writeFile(join(directory, name), css, 'utf8')
  await prunePresetHistory(directory)
}

/**
 * List one preset's history, newest first.
 * @param id - preset identifier.
 * @returns one entry per snapshot, with its file name and save time.
 * @throws {PdfError} for an invalid or unknown preset.
 */
export async function listPresetHistory(id) {
  const directory = historyDirectory(id)
  const index = await ensurePresets()
  if (!index.presets.some(preset => preset.id === id)) {
    throw new PdfError('not-found', 'unknown preset: ' + String(id))
  }
  let names
  try {
    names = await readdir(directory)
  } catch {
    return []
  }
  const entries = []
  for (const name of names) {
    if (!HISTORY_NAME.test(name)) continue
    const info = await stat(join(directory, name)).catch(() => null)
    if (info === null) continue
    const stamp = Number(name.slice(0, name.indexOf('-')))
    entries.push({
      name,
      stamp,
      at: info.mtimeMs,
      savedAt: new Date(stamp).toISOString(),
    })
  }
  entries.sort((left, right) => right.stamp - left.stamp || right.at - left.at)
  return entries.map(({ name, savedAt }) => ({ name, savedAt }))
}

/**
 * Restore one history snapshot.
 *
 * The snapshot becomes the preset's current stylesheet. The stylesheet it
 * replaces is recorded first, so a restore is itself reversible.
 * @param id - preset identifier.
 * @param name - a history file name returned by listPresetHistory.
 * @returns the restored preset identifier and stylesheet.
 * @throws {PdfError} for an invalid or unknown identifier, name, or snapshot.
 */
export async function restorePresetHistory(id, name) {
  if (typeof name !== 'string' || !HISTORY_NAME.test(name)) {
    throw new PdfError('bad-request', 'invalid history name: ' + String(name))
  }
  const directory = historyDirectory(id)
  const index = await ensurePresets()
  if (!index.presets.some(preset => preset.id === id)) {
    throw new PdfError('not-found', 'unknown preset: ' + String(id))
  }
  let css
  try {
    css = await readFile(join(directory, name), 'utf8')
  } catch {
    throw new PdfError('not-found', 'unknown history entry: ' + name)
  }
  return withIndexTransaction(async () => {
    const current = await readOrSeedIndex()
    if (!current.presets.some(preset => preset.id === id)) {
      throw new PdfError('not-found', 'unknown preset: ' + String(id))
    }
    await recordPresetHistory(id, await readPresetCss(id))
    await writePresetCss(id, css)
    return { id, css }
  })
}

/**
 * Read one bundle entry as a validated preset.
 * @param entry - one bundle preset.
 * @param seen - identifiers already present in the bundle.
 * @returns the normalized entry.
 * @throws {PdfError} for an invalid identifier, name, stylesheet, or page.
 */
function bundleEntry(entry, seenIds, seenNames) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new PdfError('bad-request', 'every bundle preset must be an object')
  }
  if (typeof entry.id !== 'string' || !PRESET_ID.test(entry.id)) {
    throw new PdfError('bad-request', 'invalid preset id: ' + String(entry.id))
  }
  if (seenIds.has(entry.id)) throw new PdfError('bad-request', 'duplicate preset id: ' + entry.id)
  seenIds.add(entry.id)
  const name = typeof entry.name === 'string' ? entry.name.trim() : ''
  if (name === '') throw new PdfError('bad-request', 'preset name is required: ' + entry.id)
  if (seenNames.has(name)) throw new PdfError('bad-request', 'duplicate preset name: ' + name)
  seenNames.add(name)
  if (typeof entry.css !== 'string') throw new PdfError('bad-request', 'stylesheet is required: ' + entry.id)
  if (Buffer.byteLength(entry.css, 'utf8') > MAX_CSS_BYTES) {
    throw new PdfError('too-large', 'stylesheet exceeds ' + MAX_CSS_BYTES + ' bytes: ' + entry.id)
  }
  const normalized = { id: entry.id, name, css: entry.css }
  if (typeof entry.description === 'string') normalized.description = entry.description
  if (entry.page !== undefined && entry.page !== null) {
    const page = validatePageOverride(entry.page, 'bundle.' + entry.id + '.page')
    if (Object.keys(page).length > 0) normalized.page = page
  }
  return normalized
}

/**
 * Export every preset as one JSON bundle.
 *
 * The bundle is data, not a route: it carries no path, so the settings page can
 * download it as a Blob and import it on another machine.
 * @returns the version, the selection, and one entry per preset.
 */
export async function exportPresetBundle() {
  const index = await ensurePresets()
  const presets = []
  for (const entry of index.presets) {
    const preset = { id: entry.id, name: entry.name, css: await readPresetCss(entry.id) }
    if (entry.description !== undefined) preset.description = entry.description
    if (entry.page !== undefined) preset.page = { ...entry.page }
    presets.push(preset)
  }
  return { version: PRESET_INDEX_VERSION, selected: index.selected, presets }
}

/**
 * Import one preset bundle.
 *
 * Every entry is validated before any write, so a bad entry leaves the library
 * untouched. A preset that already exists is a conflict unless overwrite is
 * true; a conflict is reported and that entry is skipped. An overwrite replaces
 * the stylesheet, page, and description, and keeps the stored name. Stylesheets
 * are written before the index, as everywhere else.
 * @param bundle - the exported bundle.
 * @param options.overwrite - whether existing presets may be replaced.
 * @returns the imported identifiers and one warning per conflict.
 * @throws {PdfError} for an invalid bundle.
 */
export async function importPresetBundle(bundle, options = {}) {
  if (bundle === null || typeof bundle !== 'object' || Array.isArray(bundle)) {
    throw new PdfError('bad-request', 'bundle must be an object')
  }
  if (bundle.version !== PRESET_INDEX_VERSION) {
    throw new PdfError('bad-request', 'unsupported bundle version: ' + String(bundle.version))
  }
  if (!Array.isArray(bundle.presets)) throw new PdfError('bad-request', 'bundle.presets must be an array')
  const seenIds = new Set()
  const seenNames = new Set()
  const entries = bundle.presets.map(entry => bundleEntry(entry, seenIds, seenNames))
  const overwrite = options.overwrite === true
  return withIndexTransaction(async () => {
    const index = await readOrSeedIndex()
    const presets = index.presets.map(preset => ({ ...preset }))
    const imported = []
    const warnings = []
    for (const entry of entries) {
      // Identity is the id, but a user-visible name is also an identity here:
      // importing a second "Lark" under a new id must ask, not create a twin.
      let position = presets.findIndex(preset => preset.id === entry.id)
      if (position < 0) position = presets.findIndex(preset => preset.name.trim() === entry.name)
      if (position >= 0) {
        const existing = presets[position]
        if (!overwrite) {
          warnings.push('preset exists: ' + existing.id)
          continue
        }
        await writePresetCss(existing.id, entry.css)
        const updated = { ...existing }
        if (entry.page !== undefined) updated.page = entry.page
        else delete updated.page
        if (entry.description !== undefined) updated.description = entry.description
        presets[position] = updated
        imported.push(existing.id)
        continue
      }
      await writePresetCss(entry.id, entry.css)
      const created = { id: entry.id, name: entry.name }
      if (entry.description !== undefined) created.description = entry.description
      if (entry.page !== undefined) created.page = entry.page
      presets.push(created)
      imported.push(entry.id)
    }
    if (imported.length > 0) {
      const selected = presets.some(preset => preset.id === index.selected) ? index.selected : presets[0].id
      await writeIndex({ ...index, selected, presets })
    }
    return { imported, warnings }
  })
}

export { MAX_CSS_BYTES }

/**
 * Run one settings action.
 *
 * The HTTP route parses a body and hands it here, so every operation the page
 * offers is reachable from a check without a server.
 * @param action - `{ action, id?, name?, css?, page?, ids?, overwrite? }`.
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
    case 'save-page':
      return savePresetPage(action.id, action.page)
    case 'export-bundle':
      return exportPresetBundle()
    case 'import-bundle':
      return importPresetBundle(action.bundle, { overwrite: action.overwrite === true })
    case 'list-history':
      return { history: await listPresetHistory(action.id) }
    case 'restore-history':
      return restorePresetHistory(action.id, action.name)
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
