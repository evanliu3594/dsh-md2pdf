/**
 * Checks for the DSH preview address and the font diagnostics.
 *
 * The address checks pin the one grammar the DSH viewer accepts: a POSIX path
 * keeps its leading slash, a Windows drive colon stays literal, every other
 * segment is encoded, and the Session id is encoded too. The preview checks
 * drive a real prepare/finish pair, so the address is the one the Host returns
 * after it has written and verified the target.
 *
 * The font checks pin the Host-side parser: it reads concrete families from
 * `font-family` declarations, skips generic families, dedupes in first-seen
 * order, and never throws on malformed CSS. The settings route is asked for its
 * font table, and the client file is checked for the wiring that does the
 * availability check in the browser; that check itself is manual.
 *
 * Run: node scripts/dsh-preview-check.mjs
 */
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describeCapability, finishExport, prepareExport, sessionFileAddress } from '../src/export.js'
import { fontFacesInCss, fontsInCss } from '../src/font-css.js'
import { THEMES, themeCss } from '../src/themes.js'

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
 * Assert two JSON values are structurally equal.
 * @param label - what the check proves.
 * @param actual - produced value.
 * @param expected - required value.
 */
function expectJson(label, actual, expected) {
  expectEqual(label, JSON.stringify(actual), JSON.stringify(expected))
}

const here = dirname(fileURLToPath(import.meta.url))
const home = await mkdtemp(join(tmpdir(), 'dsh-md2pdf-preview-home-'))
const work = await mkdtemp(join(tmpdir(), 'dsh-md2pdf-preview-work-'))
process.env['MD2PDF_HOME'] = home

/** A payload every finish accepts. */
const PDF = Buffer.from('%PDF-1.4\n%%EOF\n', 'latin1')

/**
 * Mount the Host routes on a fake context, the form the checks use.
 * @param options - row configuration.
 * @returns the registered handlers by path.
 */
function mountRoutes(options = {}) {
  const routes = new Map()
  const { apply } = indexModule
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
  }, options)
  return routes
}

/**
 * Read the settings route's JSON answer.
 * @param routes - mounted handlers.
 * @returns the status and parsed body.
 */
async function readSettings(routes) {
  const response = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name] = value },
    end(body = '') { this.body = body },
  }
  await routes.get(indexModule.SETTINGS_PATH)({ method: 'GET', headers: {} }, response)
  return { status: response.statusCode, payload: JSON.parse(response.body) }
}

const indexModule = await import('../index.js')
const { selectPreset, savePreset } = await import('../src/presets.js')

try {
  // 1. Address grammar. The literal strings are the contract, not a round trip.
  expectEqual('posix address keeps the leading slash and encodes the space',
    sessionFileAddress('s1', '/Users/liu/a b.md'),
    'dsh-resource://file/session/s1//Users/liu/a%20b.md')
  expectEqual('windows address keeps the drive colon and uses slashes',
    sessionFileAddress('s1', 'C:\\x\\y.md'),
    'dsh-resource://file/session/s1/C:/x/y.md')
  expectEqual('session id, non-ascii path and parentheses are encoded',
    sessionFileAddress('s 1', '/Users/liu/报告 (1).md'),
    'dsh-resource://file/session/s%201//Users/liu/%E6%8A%A5%E5%91%8A%20(1).md')
  expectEqual('a path fragment and query are encoded, not passed through',
    sessionFileAddress('s1', '/Users/liu/a#b?c.md'),
    'dsh-resource://file/session/s1//Users/liu/a%23b%3Fc.md')
  expectEqual('a literal percent is encoded once more',
    sessionFileAddress('s1', '/Users/liu/a%20b.md'),
    'dsh-resource://file/session/s1//Users/liu/a%2520b.md')

  // 2. Font parser: concrete families only, first-seen order, no exceptions.
  expectJson('quoted families keep their order and skip the generic',
    fontsInCss('body{font-family:"FangSong","Songti SC",serif}'),
    ['FangSong', 'Songti SC'])
  expectJson('all four generic families are skipped',
    fontsInCss('body{font-family:serif,sans-serif,monospace,system-ui,"KaiTi"}'),
    ['KaiTi'])
  expectJson('generic names are matched without case',
    fontsInCss('body{font-family:Serif,SANS-SERIF,"Songti SC"}'),
    ['Songti SC'])
  expectJson('duplicates keep the first spelling and position',
    fontsInCss('a{font-family:FangSong,"Songti SC"}b{font-family:songti sc,FangSong,serif}'),
    ['FangSong', 'Songti SC'])
  expectJson('unquoted multi-word families survive',
    fontsInCss('p{font-family:Times New Roman, Arial,serif}'),
    ['Times New Roman', 'Arial'])
  expectJson('single quotes and an embedded comma survive',
    fontsInCss("body{font-family:'Foo, Bar',monospace}"),
    ['Foo, Bar'])
  expectJson('a quoted family keeps its double quotes out of the value',
    fontsInCss('body{font-family:"STFangsong"}'),
    ['STFangsong'])
  expectJson('!important is not part of the family',
    fontsInCss('body{font-family:"FangSong" !important}'),
    ['FangSong'])
  expectJson('property names are matched without case',
    fontsInCss('body{FONT-FAMILY:"KaiTi",serif}'),
    ['KaiTi'])
  expectJson('several declarations are collected in document order',
    fontsInCss('h1{font-family:"A",serif}h2{font-family:"B",sans-serif}'),
    ['A', 'B'])
  expectJson('a wrapped declaration is still one value',
    fontsInCss('body{font-family:\n  "L multiline",\n  serif;\n}'),
    ['L multiline'])
  expectJson('comments are not declarations',
    fontsInCss('/* font-family:"Gone"; */body{font-family:"Kept",serif}'),
    ['Kept'])
  expectJson('the font shorthand is not a font-family declaration',
    fontsInCss('body{font:16px/1.5 "Foo"}'),
    [])
  expectJson('an empty stylesheet has no families', fontsInCss(''), [])

  const malformed = [
    null,
    undefined,
    42,
    'body{font-family:"Unclosed, serif}',
    'body{font-family:',
    '}}}font-family:"x"{{{',
    '@font-face{font-family:',
    'body{font-family:"a" "b"}',
  ]
  let parserThrew = false
  for (const css of malformed) {
    try {
      const families = fontsInCss(css)
      if (!Array.isArray(families)) parserThrew = true
    } catch {
      parserThrew = true
    }
  }
  expectEqual('malformed css never throws', parserThrew, false)
  expectJson('an unterminated quote is not invented into a family',
    fontsInCss('body{font-family:"Unclosed, serif}'),
    [])

  // 3. @font-face families are declared separately, so the client can mark
  // them unverified instead of claiming a local system font.
  const faceCss = '@font-face{font-family:"My Face";src:url(face.woff2)}body{font-family:"My Face","Body Face",serif}'
  expectJson('the used family list includes the face family once',
    fontsInCss(faceCss),
    ['My Face', 'Body Face'])
  expectJson('font-face declarations are reported', fontFacesInCss(faceCss), ['My Face'])
  expectJson('css without font-face reports none', fontFacesInCss('body{font-family:"A"}'), [])
  expectJson('a malformed font-face still does not throw',
    fontFacesInCss('@font-face{font-family:"Broken"'),
    [])

  // 4. The built-in stacks carry the macOS names the design requires.
  const themed = THEMES.map(theme => theme.css).join('\n')
  for (const family of ['STFangsong', 'STKaiti', 'Songti SC', 'PingFang SC', 'Kaiti SC', 'Heiti SC']) {
    expectTrue(`the themed stacks contain ${family}`, themed.includes(family))
  }
  const gongwenFamilies = fontsInCss(themeCss('gongwen'))
  for (const family of ['STFangsong', 'STKaiti', 'Songti SC', 'PingFang SC', 'STZhongsong']) {
    expectTrue(`the gongwen font list contains ${family}`, gongwenFamilies.includes(family))
  }
  expectTrue('the gongwen font list skips the generic serif', !gongwenFamilies.includes('serif'))
  expectTrue('the gongwen font list skips the generic sans-serif', !gongwenFamilies.includes('sans-serif'))
  expectTrue('the gongwen font list skips the generic monospace', !gongwenFamilies.includes('monospace'))

  // 5. A real finish returns the address built from its Session and target.
  await copyFile(join(here, '..', 'samples', 'sample.md'), join(work, '样品 a.md'))
  const source = join(work, '样品 a.md')
  const target = join(work, '样品 a.pdf')
  const prepared = await prepareExport({ path: source, sessionId: 's 1' })
  const written = await finishExport({ finishToken: prepared.finishToken, pdfBytes: PDF })
  expectEqual('finish returns the address of the written target',
    written.previewAddress, sessionFileAddress('s 1', target))
  expectEqual('the returned address names the encoded Session',
    written.previewAddress.includes('/session/s%201/'), true)
  expectEqual('the returned address encodes the non-ascii file name',
    written.previewAddress.includes('%E6%A0%B7%E5%93%81%20a.pdf'), true)

  const anonymous = await prepareExport({ path: source })
  const anonymousWritten = await finishExport({ finishToken: anonymous.finishToken, pdfBytes: PDF })
  expectEqual('a job without a Session returns no preview address',
    Object.hasOwn(anonymousWritten, 'previewAddress'), false)

  // 6. The settings route returns the font table derived from the selected CSS,
  // keeps every existing field, and never claims availability.
  await selectPreset('gongwen')
  const routes = mountRoutes()
  const settings = await readSettings(routes)
  expectEqual('the settings route answers', settings.status, 200)
  for (const field of ['selected', 'presets', 'builtins', 'css', 'cssPath', 'presetsPath', 'maxBytes']) {
    expectEqual(`the settings route keeps ${field}`, Object.hasOwn(settings.payload, field), true)
  }
  expectEqual('the settings route returns a font table', Array.isArray(settings.payload.fonts), true)
  const expectedTable = fontsInCss(settings.payload.css).map(family => ({ family, face: false }))
  expectJson('the font table is the selected stylesheet in first-seen order',
    settings.payload.fonts, expectedTable)
  expectTrue('the font table names STZhongsong',
    settings.payload.fonts.some(entry => entry.family === 'STZhongsong'))
  const fontEntryKeys = settings.payload.fonts.map(entry => Object.keys(entry).sort().join(','))
  expectTrue('every font entry is family plus face only',
    fontEntryKeys.every(keys => keys === 'face,family'))
  expectTrue('the Host never returns an availability claim',
    settings.payload.fonts.every(entry => !Object.hasOwn(entry, 'cjk')
      && !Object.hasOwn(entry, 'latin')
      && !Object.hasOwn(entry, 'available')))

  const created = await savePreset({
    name: 'Face test',
    css: '@font-face{font-family:"My Face";src:url(face.woff2)}body{font-family:"My Face","Body Face",serif}',
  })
  await selectPreset(created.id)
  const faceSettings = await readSettings(routes)
  const faceEntry = faceSettings.payload.fonts.find(entry => entry.family === 'My Face')
  const bodyEntry = faceSettings.payload.fonts.find(entry => entry.family === 'Body Face')
  expectEqual('a font-face family is marked as a face', faceEntry?.face, true)
  expectEqual('an ordinary family is not marked as a face', bodyEntry?.face, false)

  // 7. afterExport is row configuration; the client reads it from capability.
  expectEqual('afterExport defaults to dsh', (await describeCapability({})).afterExport, 'dsh')
  expectEqual('afterExport accepts system', (await describeCapability({ afterExport: 'system' })).afterExport, 'system')
  expectEqual('afterExport accepts none', (await describeCapability({ afterExport: 'none' })).afterExport, 'none')
  expectEqual('an unknown afterExport falls back to dsh',
    (await describeCapability({ afterExport: 'bogus' })).afterExport, 'dsh')

  // 8. The client wiring is checked as text here. The real availability check
  // runs in the DSH Chromium and remains manual.
  const client = await readFile(join(here, '..', 'client.js'), 'utf8')
  expectTrue('the client measures font candidates on a canvas',
  client.includes('measureText') && client.includes('actualBoundingBoxAscent'))
expectTrue('the preview sheet outranks the DSH document font rule',
  client.includes("'[data-document-markdown][data-document-markdown]'"))
expectTrue('the font check does not trust fallback-aware FontFaceSet.check',
  !client.includes('document.fonts.check'))
  expectTrue('the client passes a CJK sample', client.includes("'汉'"))
  expectTrue('the client passes a Latin sample', client.includes("'A'"))
  expectTrue('the client opens the Host address through sidebarRight',
    client.includes('ctx.sidebarRight.openResource(result.previewAddress)'))
  expectTrue('the client gates the preview on afterExport', client.includes('afterExportOf'))
  expectTrue('the client renders a font table', client.includes('data-md2pdf-fonts'))
  expectTrue('the client does not import a DSH client package',
    !client.includes('@deepseek-ai/dsh-client-ui-sidebar-right'))

  const manifest = JSON.parse(await readFile(join(here, '..', 'package.json'), 'utf8'))
  expectTrue('the test chain runs this check',
    String(manifest.scripts.test).includes('scripts/dsh-preview-check.mjs'))
} finally {
  await rm(home, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  await rm(work, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
}

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`)
if (failures > 0) process.exitCode = 1
