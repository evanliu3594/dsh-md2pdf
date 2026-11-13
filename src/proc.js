/**
 * Process helpers for the export pipeline: PATH lookup without a shell, and a
 * bounded child-process run.
 *
 * The run redirects the child's streams to files instead of pipes. That choice
 * keeps the pipeline working where a sandbox refuses to create the named pipes
 * a piped `spawn` needs, and it costs nothing for a printer whose output is a
 * file anyway.
 */
import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access, mkdtemp, open, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'

/** Executable suffixes Windows tries for a bare command name. */
const WINDOWS_SUFFIXES = (process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD')
  .split(';')
  .filter(suffix => suffix !== '')
  .map(suffix => suffix.toLowerCase())

/**
 * @typedef {object} RunResult
 * @property {number} code - exit status, or -1 when the child never ran to completion.
 * @property {string} stdout - captured standard output.
 * @property {string} stderr - captured standard error, or the spawn failure.
 */

/**
 * Run one executable without a shell, bounded by a deadline.
 * @param file - absolute executable path.
 * @param args - argument vector.
 * @param options - working directory, environment additions, and deadline.
 * @returns the settled result; a refused spawn resolves with code -1.
 */
export async function run(file, args, options = {}) {
  const timeout = options.timeoutMs ?? 120_000
  const env = options.env === undefined ? process.env : { ...process.env, ...options.env }
  const work = await mkdtemp(join(tmpdir(), 'dsh-md2pdf-run-'))
  const stdoutPath = join(work, 'stdout.log')
  const stderrPath = join(work, 'stderr.log')
  const stdoutHandle = await open(stdoutPath, 'w')
  const stderrHandle = await open(stderrPath, 'w')
  let spawnFailure = null
  let child
  try {
    child = spawn(file, args, {
      cwd: options.cwd,
      env,
      windowsHide: true,
      stdio: ['ignore', stdoutHandle.fd, stderrHandle.fd],
    })
  } catch (error) {
    spawnFailure = error
  }

  let code = -1
  if (child === undefined) {
    code = -1
  } else {
    code = await new Promise((resolve) => {
      let settled = false
      const settle = (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      }
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        settle(-1)
      }, timeout)
      child.once('error', (error) => {
        spawnFailure = error
        settle(-1)
      })
      child.once('close', (exitCode) => { settle(exitCode ?? -1) })
    })
  }

  await stdoutHandle.close().catch(() => {})
  await stderrHandle.close().catch(() => {})
  const stdout = await readFile(stdoutPath, 'utf8').catch(() => '')
  const captured = await readFile(stderrPath, 'utf8').catch(() => '')
  await rm(work, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  const stderr = captured.trim() === '' && spawnFailure !== null
    ? String(spawnFailure.message ?? spawnFailure)
    : captured
  return { code, stdout, stderr }
}

/** Whether a path names a regular file this process may execute. */
async function isExecutableFile(candidate) {
  try {
    const info = await stat(candidate)
    if (!info.isFile()) return false
    await access(candidate, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Resolve a command name against an explicit directory list, then `PATH`.
 * @param name - bare command name or absolute path.
 * @param options - extra directories searched before `PATH`.
 * @returns the first executable match, or null.
 */
export async function which(name, options = {}) {
  const suffixes = process.platform === 'win32' ? WINDOWS_SUFFIXES : ['']
  const namedWithSuffix = process.platform !== 'win32'
    || suffixes.some(suffix => name.toLowerCase().endsWith(suffix))

  if (isAbsolute(name)) {
    if (await isExecutableFile(name)) return name
    for (const suffix of suffixes) {
      if (await isExecutableFile(`${name}${suffix}`)) return `${name}${suffix}`
    }
    return null
  }

  const directories = [...(options.searchPaths ?? []), ...(process.env['PATH'] ?? '').split(delimiter)]
  for (const directory of directories) {
    if (directory === '') continue
    const base = join(directory, name)
    if (namedWithSuffix && await isExecutableFile(base)) return base
    for (const suffix of suffixes) {
      const candidate = `${base}${suffix}`
      if (await isExecutableFile(candidate)) return candidate
    }
  }
  return null
}
