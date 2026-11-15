/**
 * Assertions for the built-in Markdown renderer and the printed shell.
 * Run: node scripts/render-check.mjs
 */
import { buildHtml, DEFAULT_PAGE } from '../src/document.js'
import { addHeadingIds, parseFrontmatter, renderFrontmatter, renderMarkdown, splitFrontmatter } from '../src/markdown.js'
import { normalizePageBreaks, renderDocument, sanitizeFragment } from '../src/html-build.js'
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

expectContains('atx heading', html('# 标题'), '<h1 id="md2pdf-h-标题">标题</h1>')
expectContains('heading level six', html('###### six'), '<h6 id="md2pdf-h-six">six</h6>')
expectContains('setext heading', html('Title\n====='), '<h1 id="md2pdf-h-title">Title</h1>')
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
  buildHtml({ title: 'T', body: '' }, DEFAULT_PAGE), '<style id="md2pdf-page">')

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

// ---- Heading ids, table of contents, page breaks, paper fields -------------

// Heading ids are the anchor contract between the TOC and the body. Slugs keep
// CJK text, lower-case Latin, and give repeated headings a numeric suffix.
expectContains('duplicate heading keeps the base id', html('# x\n\n# x'), 'id="md2pdf-h-x"')
expectContains('duplicate heading gains a suffix', html('# x\n\n# x'), 'id="md2pdf-h-x-2"')
expectContains('a third duplicate gains -3', html('# x\n\n# x\n\n# x'), 'id="md2pdf-h-x-3"')
expectContains('heading slug lowercases latin', html('# Hello World'), 'id="md2pdf-h-hello-world"')
expectContains('heading slug drops punctuation', html('# 1. 引言'), 'id="md2pdf-h-1-引言"')
expectContains('heading slug uses the plain text', html('# **粗** 体'), 'id="md2pdf-h-粗-体"')
expectContains('an empty slug has a fallback', html('# ---'), 'id="md2pdf-h-section"')
expectContains('a raw heading id is replaced', html('<h2 id="old">x</h2>'), 'id="md2pdf-h-x"')
expectMissing('a raw heading id does not survive', html('<h2 id="old">x</h2>'), 'id="old"')
expectEqual('headings are reported in order', renderMarkdown('# A\n\n## B').headings.map(h => h.id).join(','),
  'md2pdf-h-a,md2pdf-h-b')

const tocDoc = await renderDocument({
  markdown: '# 第一章\n\n## 第一节\n\n### 小节\n\n#### 四级\n\n正文。',
  title: 'T',
  toc: true,
})
expectContains('toc block', tocDoc.html, '<nav class="md2pdf-toc">')
expectContains('toc links a level one heading', tocDoc.html, '<a href="#md2pdf-h-第一章">第一章</a>')
expectContains('toc links a level two heading', tocDoc.html, '<a href="#md2pdf-h-第一节">第一节</a>')
expectContains('toc links a level three heading', tocDoc.html, '<a href="#md2pdf-h-小节">小节</a>')
expectMissing('toc excludes level four', tocDoc.html, 'href="#md2pdf-h-四级"')
expectContains('toc has a title element', tocDoc.html, '<p class="md2pdf-toc-title">目录</p>')
expectTrue('toc starts a new page', /\.md2pdf-toc\s*\{[^}]*break-before: page/.test(tocDoc.html))
expectContains('the body follows the toc on a new page', tocDoc.html, '<div class="md2pdf-body">')
const tocNav = /<nav class="md2pdf-toc">[\s\S]*?<\/nav>/.exec(tocDoc.html)?.[0] ?? ''
expectTrue('the toc nav exists', tocNav !== '')
expectTrue('toc precedes the body',
  tocDoc.html.indexOf('<p class="md2pdf-toc-title">') < tocDoc.html.indexOf('<h1 id="md2pdf-h-第一章"'))
const plainDoc = await renderDocument({ markdown: '# A', title: 'T' })
expectMissing('no toc block by default', plainDoc.html, '<nav class="md2pdf-toc">')
expectMissing('no body wrapper without a toc', plainDoc.html, '<div class="md2pdf-body">')
const englishToc = await renderDocument({ markdown: '# A', title: 'T', toc: true, lang: 'en-US' })
expectContains('toc title follows the language', englishToc.html, 'Contents')

// An explicit page break is author-controlled in the built-in renderer; the
// pandoc fragment is normalized by normalizePageBreaks above.
expectContains('explicit page break', html('a\n\n<!-- pagebreak -->\n\n<!-- pagebreak -->\n\nb'),
  '<div class="md2pdf-pagebreak"></div>')
expectContains('page break css', buildHtml({ title: 'T', body: '' }, DEFAULT_PAGE), '.md2pdf-pagebreak')
const breakDoc = await renderDocument({ markdown: 'A\n\n<!-- pagebreak -->\n\nB', title: 'T' })
expectContains('page break survives the printable shell', breakDoc.html, '<div class="md2pdf-pagebreak"></div>')

// The paper template renders its fields on the first body page; there is no
// separate cover. Fields are plain text and are escaped like any other input.
const paperSource = {
  title: '题名',
  authors: '张三、李四',
  affiliations: '某大学',
  abstract: '摘要正文。',
  keywords: '关键词一；关键词二',
  date: '2026-11-15',
}
const paperDoc = await renderDocument({
  markdown: '---\ntitle: 示例\n---\n\n# 一、引言\n\n正文。',
  title: 'T',
  theme: 'paper',
  themeCss: themeCss('paper'),
  paper: paperSource,
})
expectContains('paper block', paperDoc.html, '<section class="md2pdf-paper">')
expectContains('paper title', paperDoc.html, 'md2pdf-paper-title">题名<')
expectContains('paper authors', paperDoc.html, 'md2pdf-paper-authors">张三、李四<')
expectContains('paper affiliations', paperDoc.html, 'md2pdf-paper-affiliations">某大学<')
expectContains('paper abstract label', paperDoc.html, '摘要：')
expectContains('paper keywords label', paperDoc.html, '关键词：')
expectContains('paper date', paperDoc.html, '2026-11-15')
expectContains('paper title is styled', themeCss('paper'), '.md2pdf-paper-title')
expectTrue('paper block precedes the body',
  paperDoc.html.indexOf('<section class="md2pdf-paper">') < paperDoc.html.indexOf('<h1 id="md2pdf-h-一-引言"'))
expectTrue('paper block precedes the frontmatter table',
  paperDoc.html.indexOf('<section class="md2pdf-paper">') < paperDoc.html.indexOf('<table class="frontmatter">'))
expectMissing('paper keys stay out of the frontmatter table', paperDoc.html, 'pdf.paper.title')
const larkPaper = await renderDocument({
  markdown: '# A', title: 'T', theme: 'lark', paper: { title: '题名' },
})
expectMissing('paper fields need the paper preset', larkPaper.html, '<section class="md2pdf-paper">')
const escapedPaper = await renderDocument({
  markdown: '# A', title: 'T', theme: 'paper', paper: { title: '<b>x</b>', authors: 'a & b' },
})
expectContains('paper title is escaped', escapedPaper.html, '&lt;b&gt;x&lt;/b&gt;')
expectContains('paper authors are escaped', escapedPaper.html, 'a &amp; b')


// ---- Page-break block rules -------------------------------------------------
expectContains('a tab-indented directive stays code',
  html('A\n\n\t<!-- pagebreak -->\n\nB'), '<pre><code>&lt;!-- pagebreak --&gt;</code></pre>')
expectMissing('a tab-indented directive is not a break',
  html('A\n\n\t<!-- pagebreak -->\n\nB'), '<div class="md2pdf-pagebreak">')
expectContains('a four-space directive stays code',
  html('A\n\n    <!-- pagebreak -->\n\nB'), '<pre><code>&lt;!-- pagebreak --&gt;</code></pre>')
expectContains('a directive after a paragraph is a block',
  html('A\n<!-- pagebreak -->\nB'), '<div class="md2pdf-pagebreak"></div>')
expectContains('a directive closes the paragraph', html('A\n<!-- pagebreak -->\nB'), '<p>A</p>')
expectContains('a fenced directive stays code',
  html('```\n<!-- pagebreak -->\n```'), '&lt;!-- pagebreak --&gt;')
expectMissing('a fenced directive is not a break',
  html('```\n<!-- pagebreak -->\n```'), 'md2pdf-pagebreak')

// The fragment normalizer only replaces a standalone comment block.
expectContains('a standalone comment becomes a break',
  normalizePageBreaks('<p>a</p>\n<!-- pagebreak -->\n<p>b</p>'), '<div class="md2pdf-pagebreak"></div>')
expectMissing('an inline comment stays text',
  normalizePageBreaks('<p>a <!-- pagebreak --> b</p>'), '<div class="md2pdf-pagebreak">')
expectContains('an inline comment survives literally',
  normalizePageBreaks('<p>a <!-- pagebreak --> b</p>'), '<!-- pagebreak -->')
expectMissing('a comment inside pre stays code',
  normalizePageBreaks('<pre>\n<!-- pagebreak -->\n</pre>'), '<div class="md2pdf-pagebreak">')
expectContains('a pre comment survives literally',
  normalizePageBreaks('<pre>\n<!-- pagebreak -->\n</pre>'), '<!-- pagebreak -->')

// ---- Language reaches the shell and the TOC --------------------------------
const englishDoc = await renderDocument({ markdown: '# A', title: 'T', toc: true, lang: 'en-US' })
expectContains('the document language reaches html', englishDoc.html, '<html lang="en-US">')
expectContains('the english toc title is used', englishDoc.html, '<p class="md2pdf-toc-title">Contents</p>')

// ---- Heading text, ids, and escaped markup ---------------------------------
const caseEntities = addHeadingIds('<h2>&Aacute; &Alpha; &aacute; &AACUTE; &nosuch;</h2>')
expectEqual('named entities match case exactly', caseEntities.headings[0].label,
  'Á Α á &AACUTE; &nosuch;')
const entityHeading = addHeadingIds('<h2>&copy; 2026</h2>')
expectEqual('an entity heading label is decoded', entityHeading.headings[0].label, '© 2026')
expectEqual('an entity heading id is built from the text', entityHeading.headings[0].id, 'md2pdf-h-2026')
const numericHeading = addHeadingIds('<h2>&#x1F600; 标题</h2>')
expectEqual('a numeric entity is decoded', numericHeading.headings[0].label, '😀 标题')
const mathHeading = addHeadingIds('<h2>Formula <math><semantics><mrow><mi>E</mi></mrow><annotation encoding="application/x-tex">E=mc^2</annotation></semantics></math> end</h2>')
expectEqual('a math annotation is not part of the label', mathHeading.headings[0].label, 'Formula E end')
expectEqual('a math annotation is not part of the id', mathHeading.headings[0].id, 'md2pdf-h-formula-e-end')
const pandocNote = addHeadingIds('<h2>A<a class="footnote-ref" href="#fn1" id="fnref1"><sup>1</sup></a></h2>')
expectEqual('a pandoc footnote does not enter the label', pandocNote.headings[0].label, 'A')
const commented = addHeadingIds('<!-- <h2>Hidden</h2> -->\n<h2>Shown</h2>')
expectEqual('a commented heading is not inventoried', commented.headings.length, 1)
expectEqual('a commented heading is not given an id', commented.html.includes('md2pdf-h-hidden'), false)
const attrHeading = addHeadingIds('<h2 title="a id=b">x</h2>')
expectContains('a quoted id lookalike survives', attrHeading.html, 'title="a id=b"')
expectEqual('the attribute id is replaced once', attrHeading.html.split('id="md2pdf-h-x"').length - 1, 1)
const greaterAttr = addHeadingIds('<h2 title="a>b">x</h2>')
expectContains('an attribute may contain a greater-than', greaterAttr.html, 'title="a>b"')
expectEqual('the greater-than heading gets one id', greaterAttr.headings[0].id, 'md2pdf-h-x')
const imageHeading = renderMarkdown('# ![Logo](logo.png)').headings[0]
expectEqual('an image-only heading gets a fallback label', imageHeading.label, 'section')
expectContains('an underscore folds to a hyphen', html('# foo_bar'), 'id="md2pdf-h-foo-bar"')

// ---- TOC and paper paragraphs reset the preset indentation -----------------
expectTrue('the toc title resets the paragraph indent',
  /\.md2pdf-toc-title\s*\{[^}]*text-indent:\s*0/.test(tocDoc.html))
expectTrue('the paper block resets the paragraph indent',
  /\.md2pdf-paper-title\s*\{[^}]*text-indent:\s*0/.test(paperDoc.html))
expectTrue('the body after a toc starts a page',
  /\.md2pdf-body\s*\{[^}]*break-before:\s*page/.test(tocDoc.html))


// ---- Inline comments and block guards --------------------------------------
const inlineComment = addHeadingIds('<h2>A <!-- note --> C</h2>')
expectEqual('an inline comment is not part of the label', inlineComment.headings[0].label, 'A  C')
expectEqual('an inline comment is not part of the id', inlineComment.headings[0].id, 'md2pdf-h-a-c')
expectEqual('an inline comment does not leak a placeholder',
  inlineComment.headings[0].label.includes('\u0000'), false)
const commentOnly = addHeadingIds('<h2><!-- note --></h2>')
expectEqual('a comment-only heading gets the fallback label', commentOnly.headings[0].label, 'section')
expectEqual('a comment-only heading gets the fallback id', commentOnly.headings[0].id, 'md2pdf-h-section')
expectContains('a raw heading keeps its comment', inlineComment.html, '<!-- note -->')
expectContains('a comment-only heading keeps its comment', commentOnly.html, '<!-- note -->')
expectEqual('a built-in inline comment is not visible', html('A <!-- note --> C'), '<p>A  C</p>')
const builtinComment = renderMarkdown('# A <!-- note --> C').headings[0]
expectEqual('a built-in heading comment is not in the label', builtinComment.label, 'A  C')
expectEqual('a built-in heading comment is not in the id', builtinComment.id, 'md2pdf-h-a-c')
expectEqual('a built-in comment-only heading falls back',
  renderMarkdown('# <!-- note -->').headings[0].id, 'md2pdf-h-section')
const tabParagraph = html('A\n\t<!-- pagebreak -->\nB')
expectMissing('a tab-indented directive does not become a break', tabParagraph, '<div class="md2pdf-pagebreak">')
expectMissing('a tab-indented directive does not open a code block', tabParagraph, '<pre><code>')
expectContains('a tab-indented directive stays in the paragraph', tabParagraph, '<p>A')

// ---- Front matter and language policy --------------------------------------
const langBlock = renderFrontmatter('lang: en-US\npdf.toc: true\ntitle: T')
expectMissing('the language key stays out of the front matter table', langBlock, 'lang</th>')
expectContains('ordinary front matter still renders', langBlock, '<th>title</th>')
const frenchDoc = await renderDocument({
  markdown: '---\nlang: fr-FR\n---\n\n# A',
  title: 'T',
  theme: 'paper',
  toc: true,
  lang: 'fr-FR',
  paper: { abstract: 'Resume.' },
})
expectContains('a third language uses the english toc title', frenchDoc.html, '<p class="md2pdf-toc-title">Contents</p>')
expectContains('a third language uses english paper labels', frenchDoc.html, 'Abstract: ')

// ---- Indent resets cover every block --------------------------------------
const paperSheet = themeCss('paper')
const ruleHasIndent = (css, selector) => {
  const at = css.indexOf(selector)
  if (at < 0) return false
  const end = css.indexOf('}', at)
  return end > at && /text-indent:\s*0/.test(css.slice(at, end))
}
for (const selector of ['.md2pdf-toc-title', '.md2pdf-paper-title', '.md2pdf-paper-authors',
  '.md2pdf-paper-affiliations', '.md2pdf-paper-date', '.md2pdf-paper-abstract', '.md2pdf-paper-keywords']) {
  expectTrue('the paper preset resets ' + selector, ruleHasIndent(paperSheet, selector))
}
expectTrue('the structural sheet resets toc items',
  /\.md2pdf-toc li\s*\{[^}]*text-indent:\s*0/.test(tocDoc.html))

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`)
process.exit(failures === 0 ? 0 : 1)
