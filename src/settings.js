/**
 * Where this plugin keeps its user files, and the one size limit they share.
 *
 * The files themselves are a preset library: `presets.json` plus one stylesheet
 * per preset. See `presets.js` for the store.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Upper bound for one stylesheet; a document style is never this large. */
export const MAX_CSS_BYTES = 512 * 1024

/**
 * The directory holding this plugin's user files.
 *
 * `MD2PDF_HOME` overrides it; otherwise it sits under the Harness home so every
 * profile on the machine shares one library.
 * @returns an absolute directory path.
 */
export function settingsDirectory() {
  const override = process.env['MD2PDF_HOME']
  if (typeof override === 'string' && override !== '') return override
  const home = process.env['DSH_HOME']
  const base = typeof home === 'string' && home !== '' ? home : join(homedir(), '.dsh')
  return join(base, 'md2pdf')
}
