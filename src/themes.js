/**
 * Built-in page styles.
 *
 * One preset reproduces the visual language of the MWEB theme collection
 * (github.com/imageslr/mweb-themes): its palette, type scale and spacing are
 * design parameters, and the rules below are written for this exporter rather
 * than copied from that repository, which declares no licence. Two further
 * presets follow Chinese national standards:
 *
 *   - 红头公文: GB/T 9704-2012《党政机关公文格式》
 *   - 学术论文: GB/T 7713.2-2022《学术论文编写规则》
 *
 * Every preset is an override layer: it is emitted after the structural
 * stylesheet and before the user's own CSS, so a user rule still wins.
 */

/** Theme used when nothing else is stored. */
export const DEFAULT_THEME = 'lark'

/**
 * Font stacks for the two national-standard presets.
 *
 * Latin faces come first and Chinese faces after them: a Latin character is
 * found in Times New Roman and stops there, while a Chinese character is
 * missing from every Latin face and falls through to the Chinese face that
 * follows. That is how the two scripts get different fonts in one element.
 */
const LATIN = '"Times New Roman",Times,"Liberation Serif","Nimbus Roman"'
const FANGSONG = `${LATIN},"FangSong","FangSong_GB2312","STFangsong","仿宋",FangSong,serif`
const SONG = `${LATIN},"SimSun","宋体","Songti SC","STSong","Source Han Serif SC","Noto Serif CJK SC",serif`
const HEITI = `${LATIN},"SimHei","黑体","Heiti SC","PingFang SC","Source Han Sans SC","Noto Sans CJK SC",sans-serif`
const KAITI = `${LATIN},"KaiTi","KaiTi_GB2312","STKaiti","Kaiti SC","楷体",KaiTi,serif`
const XIAOBIAOSONG = `${LATIN},"FZXiaoBiaoSong-B05S","方正小标宋简体","STZhongsong","华文中宋","Songti SC","SimSun","宋体",serif`

/** Rules shared by the two national-standard presets: a three-line table. */
const THREE_LINE_TABLE = `
table {
  border-collapse: collapse;
  border-top: 1.5pt solid #000;
  border-bottom: 1.5pt solid #000;
  background: none;
}
thead { display: table-header-group; }
thead th {
  border: none;
  border-bottom: 0.75pt solid #000;
  background: none;
  font-weight: 600;
}
tbody td { border: none; background: none; }
tbody tr:nth-child(even) td { background: none; }
`.trim()

/** Metadata block shared by the two standards: readable, no rules at all. */
const PLAIN_FRONTMATTER = `
.frontmatter-caption { display: none; }
table.frontmatter {
  border: none;
  width: auto;
  margin: 0 0 10pt;
  font-size: 10.5pt;
  line-height: 1.5;
}
table.frontmatter th, table.frontmatter td {
  border: none;
  background: none;
  padding: 1pt 10pt 1pt 0;
  text-align: left;
  font-weight: normal;
  color: #333;
}
table.frontmatter th { width: auto; white-space: nowrap; }
`.trim()

/** Lark: the blue-on-white document style of the Feishu (Lark) cloud editor. */
const LARK = `
@page { margin: 20mm 18mm; }
body {
  color: #1f2329;
  font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, "Segoe UI",
    "PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", sans-serif;
  font-size: 16px;
  line-height: 1.68;
}
h1, h2, h3, h4, h5, h6 {
  color: #1f2329;
  font-weight: 600;
  border-bottom: none;
  padding-bottom: 0;
  line-height: 1.4;
}
h1 { font-size: 26px; margin: 26px 0 10px; }
h2 { font-size: 22px; margin: 22px 0 8px; }
h3 { font-size: 20px; margin: 20px 0 8px; }
h4 { font-size: 18px; margin: 18px 0 8px; }
h5, h6 { font-size: 16px; margin: 16px 0 8px; }
p { margin: 8px 0; }
a { color: #3370ff; border-bottom: none; }
strong { font-weight: 600; }
mark { background: rgba(255, 246, 122, 0.8); }
hr { background: #dee0e3; margin: 1.6em 0; }
ul, ol { padding-left: 1.8em; }
li { margin: 4px 0; }
blockquote {
  border-left: 3px solid #dee0e3;
  background: transparent;
  color: #646a73;
  padding-left: 1em;
}
code {
  background: #f5f6f7;
  color: #1f2329;
  border-radius: 4px;
  padding: 0.1em 0.35em;
}
pre {
  background: #f5f6f7;
  border: none;
  border-radius: 6px;
  padding: 10px 12px;
}
pre code { font-size: 14px; line-height: 1.6; background: none; }
table { border-collapse: collapse; }
th, td { border: 1px solid #dee0e3; padding: 8px; }
th { background: #f5f6f7; font-weight: 500; }
tbody tr:nth-child(even) td { background: none; }
img { border-radius: 4px; }
`.trim()

/**
 * 红头公文, after GB/T 9704-2012.
 *
 * Page box: 37 mm top, 35 mm bottom, 28 mm left, 26 mm right, which leaves the
 * 156 mm x 225 mm type area the standard prescribes. Body text is 3 号 (16 pt)
 * 仿宋 on a 29 pt line pitch, so 22 lines fill the area; 28 full-width
 * characters fill a line. Heading faces follow the standard: 小标宋 for the
 * title, 黑体 for the first level, 楷体 for the second, 仿宋 bold below that.
 * Latin letters, digits and Western punctuation take Times New Roman; Chinese
 * characters fall through to the face named after it.
 */
const GONGWEN = `
@page { margin: 37mm 26mm 35mm 28mm; }
body {
  color: #000;
  font-family: ${FANGSONG};
  font-size: 16pt;
  line-height: 29pt;
  text-align: justify;
  font-variant-numeric: normal;
}
h1, h2, h3, h4, h5, h6 {
  color: #000;
  border-bottom: none;
  padding: 0;
  font-weight: normal;
  line-height: 1.6;
  text-indent: 0;
}
h1 {
  font-family: ${XIAOBIAOSONG};
  font-size: 22pt;
  color: #e60012;
  text-align: center;
  line-height: 1.5;
  margin: 0 0 14pt;
  padding-bottom: 8pt;
  border-bottom: 1.2pt solid #e60012;
  font-weight: 600;
}
h2 { font-family: ${HEITI}; font-size: 16pt; margin: 12pt 0 6pt; }
h3 { font-family: ${KAITI}; font-size: 16pt; margin: 10pt 0 6pt; }
h4 { font-family: ${FANGSONG}; font-size: 16pt; font-weight: bold; margin: 8pt 0 4pt; }
h5, h6 { font-family: ${FANGSONG}; font-size: 16pt; margin: 8pt 0 4pt; }
p { margin: 0; text-indent: 2em; }
p:empty { display: none; }
a { color: #000; border-bottom: 1px solid #000; }
strong { font-weight: bold; }
em { font-family: ${KAITI}; font-style: normal; }
hr { border: none; border-top: 1pt solid #000; margin: 12pt 0; }
ul, ol { margin: 0; padding-left: 2em; }
li { margin: 0; text-indent: 0; }
blockquote {
  border-left: 3pt solid #000;
  background: none;
  color: #000;
  margin: 6pt 0;
  padding: 0 0 0 1em;
}
blockquote p { text-indent: 2em; }
code, pre { font-family: "Cascadia Mono", Consolas, "Courier New", monospace; }
code { background: #f2f2f2; font-size: 10.5pt; padding: 0 0.2em; border-radius: 0; }
pre { background: #f7f7f7; border: 0.5pt solid #999; padding: 6pt 8pt; }
pre code { font-size: 10.5pt; line-height: 1.5; background: none; }
${THREE_LINE_TABLE}
table { font-size: 12pt; line-height: 1.5; width: 100%; }
th, td { padding: 4pt 6pt; }
.table-caption { text-align: center; text-indent: 0; font-family: ${HEITI}; font-size: 12pt; margin: 8pt 0 3pt; }
.table-note { text-indent: 0; font-size: 10.5pt; line-height: 1.6; margin: 3pt 0 10pt; }
${PLAIN_FRONTMATTER}
img { max-width: 100%; display: block; margin: 0 auto; }
`.trim()

/**
 * 学术论文, after GB/T 7713.2-2022.
 *
 * The standard governs how a paper is composed — title, abstract, keywords,
 * numbered sections, figures and tables, references — and the widely used
 * journal layout supplies the point sizes. Sections are numbered 1, 1.1, 1.1.1
 * in the reader's own text; the stylesheet gives each level its conventional
 * face. Tables are three-line tables. Latin letters, digits and Western
 * punctuation take Times New Roman; Chinese characters fall through to 宋体.
 */
const PAPER = `
@page { margin: 25mm 22mm; }
body {
  color: #000;
  font-family: ${SONG};
  font-size: 10.5pt;
  line-height: 1.75;
  text-align: justify;
}
h1, h2, h3, h4, h5, h6 {
  color: #000;
  border-bottom: none;
  padding: 0;
  text-indent: 0;
}
h1 {
  font-family: ${HEITI};
  font-size: 16pt;
  text-align: center;
  margin: 0 0 10pt;
  line-height: 1.4;
  font-weight: 700;
}
h2 { font-family: ${HEITI}; font-size: 14pt; margin: 14pt 0 6pt; font-weight: 700; }
h3 { font-family: ${HEITI}; font-size: 12pt; margin: 12pt 0 4pt; font-weight: 700; }
h4 { font-family: ${SONG}; font-size: 10.5pt; margin: 10pt 0 4pt; font-weight: 700; }
h5, h6 { font-family: ${SONG}; font-size: 10.5pt; margin: 8pt 0 4pt; font-style: italic; }
p { margin: 0 0 6pt; text-indent: 2em; }
a { color: #000; border-bottom: none; text-decoration: none; }
strong { font-weight: 700; }
em { font-style: italic; }
hr { border: none; border-top: 0.5pt solid #000; margin: 10pt 0; }
ul, ol { margin: 0 0 6pt; padding-left: 2em; }
li { margin: 0 0 2pt; text-indent: 0; }
blockquote { border-left: none; background: none; margin: 6pt 2em; padding: 0; }
blockquote p { text-indent: 2em; }
code, pre { font-family: "Cascadia Mono", Consolas, "Courier New", monospace; }
code { background: none; font-size: 9pt; padding: 0; }
pre { background: #f7f7f7; border: 0.5pt solid #ccc; padding: 5pt 7pt; font-size: 9pt; line-height: 1.5; }
pre code { font-size: 9pt; background: none; }
${THREE_LINE_TABLE}
table { font-size: 9pt; line-height: 1.5; width: 100%; }
th, td { padding: 3pt 5pt; }
.table-caption { text-align: center; text-indent: 0; font-family: ${HEITI}; font-size: 9pt; margin: 8pt 0 3pt; }
.table-note { text-indent: 0; font-size: 9pt; line-height: 1.6; margin: 3pt 0 10pt; }
${PLAIN_FRONTMATTER}
img { max-width: 100%; display: block; margin: 6pt auto; }
sup.footnote-ref a { color: #000; }
.footnotes { font-size: 9pt; border-top: 0.5pt solid #000; }
.md2pdf-toc { font-size: 10.5pt; }
.md2pdf-toc-title { font-family: ${HEITI}; font-size: 14pt; margin: 0 0 9pt; text-indent: 0; }
.md2pdf-toc li { margin: 0 0 2pt; }
.md2pdf-paper { margin: 0 0 12pt; }
.md2pdf-paper-title {
  font-family: ${HEITI};
  font-size: 18pt;
  font-weight: 700;
  line-height: 1.4;
  margin: 0 0 8pt;
  text-indent: 0;
}
.md2pdf-paper-authors { font-family: ${SONG}; font-size: 12pt; margin: 0 0 4pt; text-indent: 0; }
.md2pdf-paper-affiliations { font-size: 9pt; color: #000; margin: 0 0 3pt; text-indent: 0; }
.md2pdf-paper-date { font-size: 9pt; color: #000; margin: 0 0 10pt; text-indent: 0; }
.md2pdf-paper-abstract, .md2pdf-paper-keywords {
  text-align: justify;
  font-size: 9pt;
  line-height: 1.65;
  text-indent: 0;
  margin: 0 0 8pt;
}
.md2pdf-paper-label { font-family: ${HEITI}; font-weight: 700; }
`.trim()

/**
 * One selectable preset.
 * @typedef {object} Theme
 * @property {string} id - stored identifier.
 * @property {string} label - Chinese display name shown in settings.
 * @property {string} labelEn - English display name.
 * @property {string} note - one-line description shown under the selector.
 * @property {boolean} [gb] - true for a preset that follows a Chinese national standard.
 * @property {string} css - override layer emitted after the base stylesheet.
 */

/** @type {readonly Theme[]} */
export const THEMES = Object.freeze([
  {
    id: 'lark',
    label: 'Lark',
    labelEn: 'Lark',
    note: '蓝黑配色，正文 16px / 行距 1.68，标题无下划线',
    css: LARK,
  },
  {
    id: 'gongwen',
    label: '红头公文',
    labelEn: 'Official document',
    note: 'GB/T 9704-2012：版心 156×225mm，3 号仿宋，22 行 × 28 字，三线表',
    gb: true,
    css: GONGWEN,
  },
  {
    id: 'paper',
    label: '学术论文',
    labelEn: 'Academic paper',
    note: 'GB/T 7713.2-2022：五号宋体正文，分级黑体标题，三线表',
    gb: true,
    css: PAPER,
  },
])

/** Every selectable identifier, in display order. */
export const THEME_IDS = Object.freeze(THEMES.map(theme => theme.id))

/**
 * Resolve one identifier to its preset.
 * @param id - stored or requested identifier.
 * @returns the preset; an unknown identifier falls back to the default.
 */
export function resolveTheme(id) {
  return THEMES.find(theme => theme.id === id)
    ?? THEMES.find(theme => theme.id === DEFAULT_THEME)
    ?? THEMES[0]
}

/**
 * The override layer for one identifier.
 * @param id - theme identifier.
 * @returns CSS text, never empty.
 */
export function themeCss(id) {
  return resolveTheme(id).css
}

/**
 * The selector rows the settings page renders.
 * @returns identifier and both display names for every preset.
 */
export function themeChoices() {
  return THEMES.map(theme => ({
    id: theme.id,
    label: theme.label,
    labelEn: theme.labelEn,
    note: theme.note,
  }))
}
