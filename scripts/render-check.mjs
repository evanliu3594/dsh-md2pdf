/**
 * Assertions for the built-in Markdown renderer and the printed shell.
 * Run: node scripts/render-check.mjs
 */
import { buildHtml, DEFAULT_PAGE } from '../src/document.js'
import { parseFrontmatter, renderFrontmatter, renderMarkdown, splitFrontmatter } from '../src/markdown.js'
import { renderDocument, sanitizeFragment } from '../src/html-build.js'
import { DEFAULT_THEME, THEMES, resolveTheme, themeCss } from '../src/themes.js'

let failures = 0
let checks = 0

/**
 * Assert one substring is present in a rendered value.
 * @param label - what the check proves.
 * @param haystack - rendered output.
 * @param needle - expected substring.
 */
function expectContains(label, haystack, needle) {
  checks += 1
  if (haystack.includes(needle)) return
  failures += 1
  process.stdout.write(`FAIL ${label}\n  expected to contain: ${needle}\n  actual: ${haystack.slice(0, 300)}\n`)
}

/**
 * Assert one substring is absent from a rendered value.
 * @param label - what the check proves.
 * @param haystack - rendered output.
 * @param needle - forbidden substring.
 */
function expectMissing(label, haystack, needle) {
  checks += 1
  if (!haystack.includes(needle)) return
  failures += 1
  process.stdout.write(`FAIL ${label}\n  expected to omit: ${needle}\n`)
}

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

const html = (source) => renderMarkdown(source).body

expectContains('atx heading', html('# 标题'), '<h1>标题</h1>')
expectContains('heading level six', html('###### six'), '<h6>six</h6>')
expectContains('setext heading', html('Title\n====='), '<h1>Title</h1>')
expectContains('bold', html('**粗**'), '<strong>粗</strong>')
expectContains('italic', html('*斜*'), '<em>斜</em>')
expectContains('strikethrough', html('~~gone~~'), '<del>gone</del>')
expectContains('inline code escapes markup', html('a `<b>` b'), '<code>&lt;b&gt;</code>')
expectContains('thematic break', html('***'), '<hr>')
expectContains('paragraph', html('hello'), '<p>hello</p>')
expectContains('hard break', html('a  \nb'), '<br>')

expectContains('unordered list', html('- a\n- b'), '<ul>')
expectContains('ordered list start', html('3. a\n4. b'), '<ol start="3">')
expectContains('nested list', html('- a\n  - b'), '<li>a\n<ul>')
expectContains('task list checked', html('- [x] done'), '<input type="checkbox" disabled checked>')
expectContains('task list open', html('- [ ] todo'), '<input type="checkbox" disabled>')

expectContains('fenced code language', html('```js\nlet a = 1\n```'), '<pre><code class="language-js">')
expectContains('fenced code content escaped', html('```\n<b>\n```'), '&lt;b&gt;')
expectContains('tilde fence', html('~~~\nx\n~~~'), '<pre><code>')
expectContains('indented code', html('    code'), '<pre><code>code</code></pre>')
expectContains('indented code keeps blank line', html('    a\n\n    b'), '<pre><code>a\n\nb</code></pre>')

expectContains('blockquote', html('> 引用'), '<blockquote><p>引用</p></blockquote>')
expectContains('blockquote nesting', html('> a\n>\n> > b'), '<blockquote><p>a</p>')

expectContains('table header', html('| a | b |\n|---|---|\n| 1 | 2 |'), '<thead><tr><th>a</th><th>b</th></tr></thead>')
expectContains('table alignment right', html('| a |\n|---:|\n| 1 |'), '<th style="text-align:right">a</th>')
expectContains('table alignment center', html('| a |\n|:--:|\n| 1 |'), 'text-align:center')
expectContains('table escaped pipe', html('| a |\n|---|\n| x \\| y |'), '<td>x | y</td>')
expectContains('table caption classified', html('表1 参数表\n\n| a |\n|---|\n| 1 |'), '<p class="table-caption">表1 参数表</p>')
expectContains('table caption accepts Table 2', html('Table 2 Results\n\n| a |\n|---|\n| 1 |'), '<p class="table-caption">Table 2 Results</p>')
expectContains('table note classified', html('| a |\n|---|\n| 1 |\n\n注：数据来源见正文。'), '<p class="table-note">注：数据来源见正文。</p>')
expectMissing('ordinary paragraph after table stays plain', html('| a |\n|---|\n| 1 |\n\n普通段落。'), 'table-note')

expectContains('link', html('[t](https://e.com)'), '<a href="https://e.com">t</a>')
expectContains('link title', html('[t](https://e.com "标题")'), 'title="标题"')
expectContains('image', html('![alt](./a.png)'), '<img src="./a.png" alt="alt">')
expectContains('autolink', html('<https://e.com>'), '<a href="https://e.com">https://e.com</a>')
expectContains('bare autolink', html('见 https://e.com 说明'), '<a href="https://e.com">https://e.com</a>')
expectContains('bare autolink trims punctuation', html('见 https://e.com。'), '<a href="https://e.com">https://e.com</a>。')
expectContains('escape', html('\\*not italic\\*'), '*not italic*')

// Lists that follow a paragraph without a blank line are the reported defect:
// pandoc's `markdown` reader joined them into the paragraph, CommonMark does not.
expectContains('list right after paragraph', html('说明文字：\n- 项目一\n- 项目二'), '<ul>')
expectContains('ordered list right after paragraph', html('步骤如下：\n1. 打开\n2. 保存'), '<ol>')
expectContains('star list right after paragraph', html('说明文字：\n* 项目一'), '<ul>')

expectContains('math inline kept visible', html('$a+b$'), '<span class="math">a+b</span>')
expectContains('math block kept visible', html('$$\nx=1\n$$'), '<div class="math-display">')

// Footnotes: definitions leave the block stream and return as a numbered list.
expectContains('footnote reference', html('正文[^a]\n\n[^a]: 注释'), '<sup class="footnote-ref">')
expectContains('footnote body', html('正文[^a]\n\n[^a]: 注释'), '<li id="fn-1">注释')
expectMissing('footnote definition leaves the body', html('正文[^a]\n\n[^a]: 注释'), '<p>[^a]: 注释</p>')
expectContains('unknown footnote stays literal', html('未知[^zz]'), '[^zz]')
expectContains('footnote numbering follows first use',
  html('二[^b] 一[^a]\n\n[^a]: A\n[^b]: B'), '<li id="fn-1">B')

expectContains('raw html passthrough', html('<div class="x">y</div>'), '<div class="x">y</div>')
expectMissing('script removed', sanitizeFragment(html('<script>alert(1)</script>')), '<script')
expectMissing('inline handler removed', sanitizeFragment('<p onclick="x()">a</p>'), 'onclick')

const frontmatter = splitFrontmatter('---\ntitle: 示例\nauthor: DSH\n---\nbody')
expectEqual('frontmatter body', frontmatter.body, 'body')
expectContains('frontmatter row', renderFrontmatter(frontmatter.frontmatter), '<th>title</th><td>示例</td>')
expectEqual('unterminated frontmatter stays body', splitFrontmatter('---\ntitle: x').frontmatter, null)

// The config parser reads the same flat block as a record: one colon per line,
// quoted values unwrapped, indented YAML left alone because only flat keys count.
const fields = parseFrontmatter('title: 示例\nauthor: "DSH"\npdf.footer: Page {page} / {total}\n  nested: skipped')
expectEqual('frontmatter record keeps ordinary keys', fields['title'], '示例')
expectEqual('frontmatter record unwraps quoted values', fields['author'], 'DSH')
expectEqual('frontmatter record keeps colons in values', fields['pdf.footer'], 'Page {page} / {total}')
expectEqual('frontmatter record skips nested lines', Object.hasOwn(fields, 'nested'), false)
expectEqual('absent frontmatter parses to no fields', Object.keys(parseFrontmatter(null)).join(','), '')

// Flat pdf.* keys configure the export and stay out of the visible field table.
const configFrontmatter = splitFrontmatter('---\ntitle: 示例\npdf.header: 内部资料\npdf.page.size: A3\n---\nbody')
const configBlock = renderFrontmatter(configFrontmatter.frontmatter)
expectContains('frontmatter keeps ordinary fields', configBlock, '<th>title</th><td>示例</td>')
expectMissing('frontmatter hides pdf keys', configBlock, 'pdf.header')
expectMissing('frontmatter hides pdf values', configBlock, '内部资料')

const page = buildHtml({ title: 'T', body: '<p>x</p>' }, DEFAULT_PAGE)
expectContains('page doctype', page, '<!doctype html>')
expectContains('page margin', page, 'margin: 18mm;')
expectContains('page font stack has CJK', page, 'Microsoft YaHei')
expectContains('page title escaped', buildHtml({ title: '<x>', body: '' }, DEFAULT_PAGE), '&lt;x&gt;')
expectContains('page base href', buildHtml({ title: 'T', body: '', baseHref: 'file:///D:/a/' }, DEFAULT_PAGE), '<base href="file:///D:/a/">')

// The printable page carries its own policy so the browser fallback, which has
// no response header, cannot load scripts, frames, or network resources.
expectContains('page carries a csp meta', page, '<meta http-equiv="Content-Security-Policy"')
expectContains('page csp blocks scripts', page, "script-src 'none'")
expectContains('page csp blocks connections', page, "connect-src 'none'")
expectContains('page csp allows file images', page, "img-src 'self' data: file:")
expectContains('page csp allows file fonts', page, "font-src 'self' data: file:")
expectContains('page csp allows the file base', page, "base-uri 'self' file:")

// The user stylesheet rides after the built-in sheet and cannot break out of it.
const customPage = buildHtml({ title: 'T', body: '', customCss: 'body{color:red}' }, DEFAULT_PAGE)
expectContains('custom css block', customPage, '<style id="md2pdf-custom">')
expectContains('custom css content', customPage, 'body{color:red}')
expectEqual('custom css follows builtin sheet',
  customPage.indexOf('margin: 18mm;') < customPage.indexOf('body{color:red}'), true)
expectContains('custom css escapes closing tag',
  buildHtml({ title: 'T', body: '', customCss: 'a{}</style><b>' }, DEFAULT_PAGE), '<\\/style>')
expectMissing('no custom css block when empty', buildHtml({ title: 'T', body: '' }, DEFAULT_PAGE), 'md2pdf-custom')

// The explicit page override is the last stylesheet layer and cannot break out.
const pageCss = 'body{font-size:12px}'
const pageOverride = buildHtml({
  title: 'T', body: '', themeCss: 'body{color:blue}', customCss: 'body{color:red}', pageCss,
}, DEFAULT_PAGE)
expectContains('page override block', pageOverride, '<style id="md2pdf-page">')
expectContains('page override content', pageOverride, pageCss)
expectEqual('page override follows preset css',
  pageOverride.indexOf('color:blue') < pageOverride.indexOf(pageCss), true)
expectEqual('page override follows user css',
  pageOverride.indexOf('color:red') < pageOverride.indexOf(pageCss), true)
expectContains('page override escapes closing tag',
  buildHtml({ title: 'T', body: '', pageCss: 'a{}</style><b>' }, DEFAULT_PAGE), '<\\/style>')
expectMissing('no page override block when empty',
  buildHtml({ title: 'T', body: '' }, DEFAULT_PAGE), 'md2pdf-page')

// Presets: one default, three choices, and a theme layer between base and user CSS.
expectEqual('default preset', DEFAULT_THEME, 'lark')
expectEqual('preset count', THEMES.length, 3)
expectEqual('preset ids', THEMES.map(theme => theme.id).join(','), 'lark,gongwen,paper')
expectEqual('default preset is named Lark', THEMES[0].label, 'Lark')
expectTrue('every preset carries css', THEMES.every(theme => theme.css.length > 200))
expectEqual('unknown preset falls back', resolveTheme('nope').id, 'lark')
expectTrue('official document uses a three line table', themeCss('gongwen').includes('border-top: 1.5pt solid #000'))
expectTrue('official document sets the standard page box', themeCss('gongwen').includes('margin: 37mm 26mm 35mm 28mm'))
expectTrue('paper uses a three line table', themeCss('paper').includes('border-bottom: 0.75pt solid #000'))
expectTrue('paper sets song body text', themeCss('paper').includes('font-size: 10.5pt'))
expectTrue('lark uses its accent', themeCss('lark').includes('#3370ff'))

// The two national-standard presets put Latin in Times New Roman and let
// Chinese fall through to the Chinese face named after it.
const bodyBlockOf = (id) => /body\s*\{([\s\S]*?)\n\}/.exec(themeCss(id))?.[1] ?? ''
const gongwenBody = bodyBlockOf('gongwen')
const paperBody = bodyBlockOf('paper')
expectTrue('official document puts Times New Roman before FangSong',
  gongwenBody.includes('"Times New Roman"') && gongwenBody.indexOf('"Times New Roman"') < gongwenBody.indexOf('FangSong'))
expectTrue('official document keeps the Chinese face', gongwenBody.includes('"FangSong"'))
expectTrue('paper puts Times New Roman before Song',
  paperBody.includes('"Times New Roman"') && paperBody.indexOf('"Times New Roman"') < paperBody.indexOf('SimSun'))
expectTrue('paper keeps the Chinese face', paperBody.includes('SimSun'))
expectTrue('official document heading stack starts with Latin',
  /h2\s*\{[^}]*"Times New Roman"/.test(themeCss('gongwen')))
expectTrue('paper heading stack starts with Latin',
  /h2\s*\{[^}]*"Times New Roman"/.test(themeCss('paper')))

const themed = buildHtml({ title: 'T', body: '', themeCss: 'body{color:blue}', customCss: 'body{color:red}' }, DEFAULT_PAGE)
expectContains('theme style block', themed, '<style id="md2pdf-theme">')
expectEqual('custom css follows theme', themed.indexOf('color:blue') < themed.indexOf('color:red'), true)

// renderDocument carries the page override and leaves pdf.* front matter out.
const rendered = await renderDocument({
  markdown: '---\ntitle: 示例\npdf.header: 内部资料\n---\n# 标题',
  title: 'T',
  themeCss: 'body{color:blue}',
  pageCss: 'body{font-size:12px}',
})
expectContains('render carries page override', rendered.html, '<style id="md2pdf-page">')
expectEqual('render keeps page override after preset',
  rendered.html.indexOf('color:blue') < rendered.html.indexOf('body{font-size:12px}'), true)
expectMissing('render hides pdf keys from frontmatter', rendered.html, 'pdf.header')

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`)
process.exit(failures === 0 ? 0 : 1)
