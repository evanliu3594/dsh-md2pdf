/**
 * Hand a file to the operating system's default application.
 *
 * The Host process is a plain Node runtime, so there is no Electron `shell` to
 * call. Each platform gets its own launcher, and an unknown platform reports
 * that it cannot open anything instead of guessing.
 */
import { spawn } from 'node:child_process'

import { PdfError } from './pdf.js'

/**
 * The command that opens one path with the platform's default application.
 * @param platform - `process.platform` value.
 * @returns the command and arguments, or null when the platform has no launcher.
 */
export function openCommandFor(platform) {
  if (platform === 'win32') {
    // explorer.exe receives the path as one argument and does not parse shell
    // metacharacters, so a file named report&powershell&.pdf stays a file name.
    return { file: 'explorer.exe', args: [] }
  }
  if (platform === 'darwin') return { file: 'open', args: [] }
  if (platform === 'linux') return { file: 'xdg-open', args: [] }
  return null
}

/**
 * Open one file with its default application.
 * @param path - absolute file path.
 * @param options - platform override, for checks.
 * @returns after the launcher has been started.
 * @throws {PdfError} when the platform cannot open files or the launch fails.
 */
export async function openPath(path, options = {}) {
  const platform = options.platform ?? process.platform
  const command = openCommandFor(platform)
  if (command === null) {
    throw new PdfError('open-failed', `cannot open files on ${platform}`)
  }
  await new Promise((resolve, reject) => {
    const child = spawn(command.file, [...command.args, path], {
      stdio: 'ignore',
      windowsHide: true,
      detached: false,
    })
    let settled = false
    child.once('error', (error) => {
      if (settled) return
      settled = true
      reject(new PdfError('open-failed', `could not start ${command.file}: ${error.message}`))
    })
    child.once('spawn', () => {
      if (settled) return
      settled = true
      child.unref()
      resolve()
    })
  })
}
