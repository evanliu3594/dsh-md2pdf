/**
 * Development entry point: run one export through the real pipeline without a
 * Harness. Usage: node scripts/export-cli.mjs <file.md> [--html <out.html>]
 */
import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, resolve } from 'node:path'

import { baseHrefOf, renderDocument } from '../src/html-build.js'
import { describeCapability, exportMarkdownToPdf } from '../src/export.js'
import { listPresets, readPreset } from '../src/presets.js'

const argv = process.argv.slice(2)
const target = argv.find(argument => !argument.startsWith('--'))
const htmlIndex = argv.indexOf('--html')
const htmlOut = htmlIndex === -1 ? null : argv[htmlIndex + 1]

if (target === undefined) {
  process.stderr.write('usage: node scripts/export-cli.mjs <file.md> [--html <out.html>]\n')
  process.exit(2)
}

const source = resolve(target)
process.stdout.write(`capability: ${JSON.stringify(await describeCapability({}))}\n`)

if (htmlOut !== null) {
  const markdown = await readFile(source, 'utf8')
  const { selected } = await listPresets()
  const preset = await readPreset(selected)
  const rendered = await renderDocument({
    markdown,
    title: basename(source, extname(source)),
    baseHref: baseHrefOf(dirname(source)),
    theme: selected,
    themeCss: preset.css,
  })
  await writeFile(htmlOut, rendered.html, 'utf8')
  process.stdout.write(`html: ${htmlOut} (generator ${rendered.generator}, math ${rendered.math}, theme ${rendered.theme})\n`)
}

const result = await exportMarkdownToPdf({ path: source })
process.stdout.write(`export: ${JSON.stringify(result, null, 2)}\n`)
