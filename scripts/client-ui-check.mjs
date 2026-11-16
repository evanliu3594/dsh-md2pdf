/**
 * Source contracts for the settings page and the one-off document overrides.
 *
 * The client is a classic script mounted by the browser module loader, so its
 * React components cannot be imported by a Node check. These assertions pin the
 * wiring that must survive a refactor: the controls exist, both dictionaries
 * carry the text, the overrides reach both export engines, the test print uses
 * the Host-owned sample, and the diagnostics payload holds no document content.
 *
 * Run: node scripts/client-ui-check.mjs
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
let checks = 0

/**
 * Assert a condition holds.
 * @param label - what the check proves.
 * @param condition - required truth.
 */
function expectTrue(label, condition) {
  checks += 1
  if (condition === true) return
  failures += 1
  process.stdout.write('FAIL ' + label + '\n')
}

/**
 * Assert one string occurs at least a number of times.
 * @param label - what the check proves.
 * @param text - source text.
 * @param needle - substring to count.
 * @param minimum - required occurrences.
 */
function expectCount(label, text, needle, minimum) {
  const count = text.split(needle).length - 1
  expectTrue(label + ' (' + count + ' occurrences)', count >= minimum)
}

const here = dirname(fileURLToPath(import.meta.url))
const client = await readFile(join(here, '..', 'client.js'), 'utf8')
const manifest = JSON.parse(await readFile(join(here, '..', 'package.json'), 'utf8'))

// Both dictionaries carry every new control label.
const bilingual = [
  'settings.engineRefresh',
  'settings.testPrint',
  'settings.testPrinting',
  'settings.testPrintDone',
  'settings.testPrintFailed',
  'settings.docHeading',
  'settings.docHint',
  'settings.docPageHint',
  'settings.docHeader',
  'settings.docFooter',
  'settings.docPageNumbers',
  'settings.docToc',
  'settings.docDefault',
  'settings.docOn',
  'settings.docOff',
  'settings.docSave',
  'settings.docReset',
  'settings.docSaved',
  'settings.docCleared',
  'settings.docInvalid',
  'settings.docActive',
  'settings.previewCss',
  'settings.previewCssHint',
  'settings.diagnostics',
  'settings.diagnosticsHint',
  'settings.diagnosticsCopy',
  'settings.diagnosticsCopied',
  'settings.diagnosticsCopyFailed',
  'settings.lastError',
  'settings.lastErrorNone',
  'settings.homePath',
  'settings.testPath',
  'settings.exportPresets',
  'settings.importPresets',
  'settings.historyPresets',
  'settings.bundleExported',
  'settings.bundleExportFailed',
  'settings.bundleImported',
  'settings.bundleImportFailed',
  'settings.bundleInvalid',
  'settings.bundleOverwriteTitle',
  'settings.bundleOverwriteBody',
  'settings.historyEmpty',
  'settings.historyRestore',
  'settings.historyRestored',
  'settings.historyFailed',
  'settings.historyLoadFailed',
]
for (const key of bilingual) {
  expectCount('both dictionaries define ' + key, client, "'" + key + "'", 2)
}

// The settings controls are addressable and wired to their handlers.
for (const action of [
  'refresh-engine',
  'test-print',
  'save-document',
  'reset-document',
  'copy-diagnostics',
  'export-presets',
  'import-presets',
  'history',
  'restore-history',
]) {
  expectTrue('the settings action ' + action + ' exists',
    client.includes("'data-md2pdf-action': '" + action + "'"))
}
for (const marker of [
  'engine',
  'test-status',
  'doc-form',
  'doc-active',
  'preview-css',
  'last-error',
  'diagnostics',
]) {
  expectTrue('the settings marker ' + marker + ' exists',
    client.includes("'data-md2pdf': '" + marker + "'"))
}

expectTrue('the GB badge follows the national-standard flag',
  client.includes('preset.gb === true'))

// Optional preview styling is scoped to DSH's Markdown root and drops page geometry.
expectTrue('the preview style targets the DSH Markdown root',
  client.includes('data-document-markdown'))
expectTrue('the preview style uses CSSOM',
  client.includes('new CSSStyleSheet') && client.includes('selectorText'))
expectTrue('the preview style drops page rules', client.includes('rule.type === 6'))
expectTrue('the preview style is opt-in',
  client.includes('localStorage.getItem(PREVIEW_STYLE_KEY)'))
expectTrue('the preview style is injected', client.includes("'preview-style'"))
expectTrue('the preview font crosses DSH wrappers',
  client.includes('font-family: inherit') && client.includes(':where(div, p, li, td, th'))
expectTrue('the preview toggle is styled', client.includes('.md2pdf-check'))
expectTrue('the preview toggle follows the preset heading',
  client.indexOf("key: 'preset-heading'") < client.indexOf("'data-md2pdf': 'preview-css'"))
expectTrue('font availability uses canvas metrics',
  client.includes('measureText') && client.includes('actualBoundingBoxAscent'))
expectTrue('font availability does not trust the fallback-aware FontFaceSet check',
  !client.includes('document.fonts.check'))

// The settings page reads top to bottom: page settings, document overrides,
// style library, editor and preview, fonts, diagnostics. Moving the font table
// between the library and the editor made the two halves feel disconnected.
const settingsOrder = [
  "rows.push(h('h3', { key: 'page-heading'",
  "rows.push(h('h3', { key: 'doc-heading'",
  'if (presets.length > 0) {',
  "rows.push(h('div', { key: 'editor-head'",
  "if (typeof previews[selected] === 'string'",
  "rows.push(h('h3', { key: 'fonts-heading'",
  "rows.push(h('h3', { key: 'diag-heading'",
]
let previousSection = -1
for (const marker of settingsOrder) {
  const index = client.indexOf(marker)
  expectTrue('the settings section ' + marker + ' exists', index >= 0)
  if (index >= 0) {
    expectTrue('the settings order keeps ' + marker + ' after the previous section',
      index > previousSection)
    previousSection = index
  }
}

// The document form covers every one-off field.
for (const field of [
  'doc-size',
  'doc-orientation',
  'doc-margin',
  'doc-font',
  'doc-header',
  'doc-footer',
  'doc-page-numbers',
  'doc-toc',
]) {
  expectTrue('the document form field ' + field + ' exists',
    client.includes("'data-md2pdf': '" + field + "'"))
}

// One-off overrides reach both export engines and no tool path.
expectCount('the browser export applies the overrides', client, 'documentOverrides.page', 2)
expectTrue('the DSH export applies the document overrides',
  client.includes('documentOverrides.documentConfig'))
expectTrue('the overrides are window state, not storage',
  client.includes('let documentOverrides = {}'))
expectTrue('an active override is reported',
  client.includes('documentOverridesActive'))
expectTrue('the override form validates page ranges',
  client.includes('documentDraftInvalid'))
expectTrue('the override form builds only explicit fields',
  client.includes('documentOverridesOf'))
expectTrue('the override never writes the source file',
  !client.includes("'md2pdf/export' {") && !client.includes('writeFile'))

// The test print is a Host-owned sample, printed through the same guest.
expectTrue('the test print calls the Host route',
  client.includes('TEST_PRINT_ROUTE'))
expectTrue('the test print uses the normal guest print',
  client.includes('runPrintJob({'))
expectTrue('the test print can fall back to the browser',
  client.includes('exportPdf({ path: payload.sourcePath })'))
expectTrue('the unused prepared test job is failed before the fallback',
  client.includes("reason: 'client-required'"))

// Diagnostics carry configuration facts, never document content.
const start = client.indexOf('const diagnostics = {')
const end = start < 0 ? -1 : client.indexOf('\n          }', start)
const diagnosticsSource = start < 0 || end < 0 ? '' : client.slice(start, end)
expectTrue('the diagnostics block exists', diagnosticsSource !== '')
for (const key of ['engine', 'printEngine', 'afterExport', 'fonts', 'lastError', 'homePath', 'documentOverrides']) {
  expectTrue('diagnostics include ' + key, diagnosticsSource.includes(key + ':'))
}
for (const forbidden of ['markdown', 'sourcePath', 'html', 'pdfBytes']) {
  expectTrue('diagnostics exclude ' + forbidden, !diagnosticsSource.includes(forbidden))
}
expectTrue('diagnostics can be copied', client.includes('navigator.clipboard.writeText'))
expectTrue('the diagnostics block is styled', client.includes('.md2pdf-diagnostics'))

// The client stays a classic script with no Node or DSH package imports.
expectTrue('the client imports no Node module', !client.includes("require('node:"))
// Preset bundles and history stay Host-mediated; the client never sends a path.
expectTrue('the client exports a bundle', client.includes("action: 'export-bundle'"))
expectTrue('the client imports a bundle', client.includes("action: 'import-bundle'"))
expectTrue('the client lists preset history', client.includes("action: 'list-history'"))
expectTrue('the client restores a snapshot', client.includes("action: 'restore-history'"))
expectTrue('the client downloads the bundle as a blob', client.includes('URL.createObjectURL'))
expectTrue('the client reads an imported file', client.includes('await file.text()'))
expectTrue('the import asks before overwriting', client.includes("kind: 'import-overwrite'"))
expectTrue('the import input is hidden', client.includes("'data-md2pdf': 'import-file'"))
expectTrue('the history panel is addressable', client.includes("'data-md2pdf': 'history-panel'"))

// A failed UI print ends the Host job before the browser fallback runs.
const printStart = client.indexOf('async function printWithDsh')
const printEnd = printStart < 0 ? -1 : client.indexOf('\n        }', printStart)
const printSource = printStart < 0 || printEnd < 0 ? '' : client.slice(printStart, printEnd)
expectTrue('the UI print function exists', printSource !== '')
expectTrue('a failed UI print reports the job failure',
  printSource.includes('reportBrokerFailure(payload.finishToken'))

expectTrue('the client imports no DSH client package', !client.includes("require('@deepseek-ai/"))

expectTrue('the test chain runs this check',
  String(manifest.scripts.test).includes('scripts/client-ui-check.mjs'))

process.stdout.write('\n' + (checks - failures) + '/' + checks + ' checks passed\n')
process.exit(failures === 0 ? 0 : 1)
