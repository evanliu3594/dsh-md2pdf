/**
 * The built-in sample behind Settings -> Test print.
 *
 * The test page lives under the plugin's own user directory, so a test print
 * never writes into the user's workspace. It carries page numbers so the
 * default centered footer is part of the check, and two headings so the PDF
 * outline has bookmarks. The one-off document overrides from the settings page
 * still apply, which is how a user checks a header or a footer without
 * touching a real file.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { settingsDirectory } from './settings.js'

/** File name of the generated sample. */
export const TEST_PRINT_FILE = 'test-print.md'

/** Fixed one-page markdown the test print renders. */
export const TEST_PRINT_MARKDOWN = [
  '---',
  'title: dsh-md2pdf 打印测试',
  'pdf.pageNumbers: true',
  '---',
  '',
  '# dsh-md2pdf 打印测试',
  '',
  '若本页出现居中的页脚页码，并且 PDF 查看器显示书签，说明 DSH 打印链路正常。',
  '',
  '| 项目 | 期望 |',
  '|---|---|',
  '| 引擎 | DSH 内置 |',
  '| 纸张 | A4 |',
  '| 页脚 | 居中页码 |',
  '',
  '## 二级标题',
  '',
  '第二段用于确认正文与标题的层级；页脚页码应出现在每一页。',
  '',
].join('\n')

/**
 * Write the test page and return its path.
 *
 * The file is rewritten on every request, so a stale sample can never change
 * what the test prints. Only MD2PDF_HOME is written.
 * @returns the absolute sample path.
 */
export async function writeTestPrintSource() {
  const directory = join(settingsDirectory(), 'test-print')
  await mkdir(directory, { recursive: true })
  const sourcePath = join(directory, TEST_PRINT_FILE)
  await writeFile(sourcePath, TEST_PRINT_MARKDOWN, 'utf8')
  return sourcePath
}
