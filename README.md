# dsh-md2pdf

[English](README.en.md) | 中文

DeepSeek Harness 侧边栏插件。把侧边栏文件标签中打开的 Markdown 导出为 PDF，PDF 写在源文件同一目录；配套一个可管理的版式预设库。

## 目录

- [功能](#功能)
- [安装](#安装)
- [使用](#使用)
- [版式预设](#版式预设)
- [预设文件](#预设文件)
- [配置](#配置)
- [渲染与打印](#渲染与打印)
- [安全边界](#安全边界)
- [目录结构](#目录结构)
- [开发](#开发)
- [已知限制](#已知限制)
- [许可与致谢](#许可与致谢)

## 功能

- 一处导出：在文件标签里打开 Markdown，右键或点工具栏按钮即可生成 PDF。
- 零外部工具：不需要 pandoc、LaTeX 或任何命令行程序，渲染由插件自带的渲染器完成。
- 可管理的预设：每份预设是一份 CSS 文件，可应用、编辑、新建、排序、删除，样式文件可用系统编辑器直接打开。
- 内置国标版式：红头公文按 GB/T 9704-2012 排，学术论文按 GB/T 7713.2-2022 排，两者都使用三线表。
- 供 Agent 调用：注册模型工具 `md2pdf_export`，可导出任意 Markdown 路径。

## 安装

插件以 bundle 形式安装到 DSH profile，在 profile 目录里加一条依赖。

从源码安装时用链接形式，改动即时生效：

```json
{ "dependencies": { "dsh-md2pdf": "link:D:/path/to/dsh-md2pdf" } }
```

```powershell
pnpm install
```

包发布到 npm 之后，也可以直接写版本号：

```json
{ "dependencies": { "dsh-md2pdf": "^0.1.0" } }
```

两种方式都要再把 `dsh-md2pdf` 加进同一文件的 `dsh.profile.bundles`，然后重启 DSH。

运行前提：Node.js 20.11 或更新版本，以及一个 Chromium 内核的浏览器（Microsoft Edge、Google Chrome、Chromium 或 Brave 任一）。宿主进程能加载 Electron 时改用应用自身进程打印。

## 使用

插件作用于右侧边栏打开的文件标签。聊天里渲染的 Markdown 不在此列；需要导出时，把 `.md` 文件作为标签打开。

| 位置 | 触发方式 | 适用范围 |
|---|---|---|
| 侧边栏文件树文件行 | 右键 → 导出为 PDF | `.md` 等 Markdown 后缀 |
| 文件标签头部工具栏 | 点击 PDF 图标 | 该标签中打开的 Markdown |
| 文件标签头部的文件路径 | 右键 → 导出为 PDF | 该标签中打开的 Markdown |
| 设置 → dsh-md2pdf | 选择预设、编辑样式 | 全局 |
| 模型工具 `md2pdf_export` | Agent 调用 | 任意 Markdown 路径 |

输出规则固定：`<源目录>/<源文件名去掉后缀>.pdf`。同名 PDF 直接覆盖。

## 版式预设

设置页把预设当作可管理的模板。默认预设是 Lark。

### 卡片

```
┌─────────────────────┐
│ [缩略图]        ╭─╮ │ ← 右上角灰色圆角条，垃圾桶
│                 ╰─╯ │
├─────────────────────┤ ← 卡片下方 15%，蓝色横条 + 铅笔
│ ✎ 编辑              │
└─────────────────────┘
   上半部分点击 = 应用这个预设
```

三个热区在鼠标悬停或键盘聚焦时出现。点上半部分应用该预设，点蓝色横条把它的 CSS 读进下方编辑器，点垃圾桶弹出删除确认。选中的卡片有蓝色描边。

缩略图由该预设真实渲染后等比缩小，配色、字号阶梯、页边距、表格线与导出的 PDF 一致。

### 编辑与保存

编辑器标题显示正在编辑的预设名，有改动时标「未保存」。按钮依次是保存、新建、重新载入、上移、下移。

保存会弹出名称对话框，默认值就是当前编辑的预设名：

- 名称不变：原地保存。
- 名称与别的预设相同：提示是否覆盖它的样式。
- 名称是新的：新建一个预设，追加到列表末尾。

「新建」清空编辑器，从零写一份。名称不能为空。

### 排序与删除

上移、下移作用于当前编辑的预设，只改卡片顺序，不影响导出内容。

删除会先确认。删掉正在使用的预设后，自动切到列表第一项；删到只剩最后一个再删，会重建默认的 Lark。

删过内置预设后，编辑器按钮行出现「恢复内置预设」，只补回缺的那几个，已有预设不动。

### 打开样式文件

样式文件路径右侧有「打开」按钮，用系统默认程序打开当前选中预设的 CSS。客户端不传路径；Host 只接受清单里已知的预设 id，路径由 id 拼出并校验在 `presets/` 内。

### 内置预设

| 预设 | 依据 | 主要特征 |
|---|---|---|
| Lark | MWEB 主题集的设计参数 | 主色 #3370ff，正文 #1f2329、16px / 行距 1.68，标题无下划线，浅灰表格 |
| 红头公文 | GB/T 9704-2012《党政机关公文格式》 | 页边距 37/35/28/26mm，版心 156×225mm，3 号仿宋，29pt 行距（22 行），标题红色小标宋带红色分隔线，三线表 |
| 学术论文 | GB/T 7713.2-2022《学术论文编写规则》 | 五号宋体正文，题名三号黑体居中，各级标题黑体分级，三线表 |

两个国家标准预设未改动时，缩略图左上角显示「国标」小标签；改过就消失。

两个国家标准预设把中文与西文分开排：拉丁字母、阿拉伯数字与西文标点使用 Times New Roman，汉字回退到各自的中文字体（公文为仿宋、黑体、楷体、小标宋；论文为宋体、黑体）。代码块保持等宽字体，因为 Times New Roman 不是等宽体，会破坏缩进对齐。

### 三线表

两个国家标准预设都使用三线表：顶线与底线 1.5pt，栏目线 0.75pt，无竖线，表头无底色。

渲染器识别表题与表注。紧挨表格上方、以「表 1」或「Table 1」开头的段落成为表题并居中；紧接表格下方、以「注：」「注:」「Note:」开头的段落成为表注。其余段落按普通段落处理。

```markdown
表1 版式预设

| 预设 | 版心 | 正文字体 |
|:-----|:-----|:---------|
| Lark | A4 | 无衬线 |

注：参数可在配置中覆盖。
```

需要辅助线时，在预设的 CSS 里加一条规则，例如 `tbody tr + tr td { border-top: 0.5pt solid #999; }`。

## 预设文件

```
$DSH_HOME/md2pdf/
  presets.json          { version, selected, presets: [{ id, name }] }
  presets/<id>.css      该预设的样式
```

`presets.json` 是权威：数组顺序就是卡片顺序，`selected` 记当前使用的预设。写入时先落 CSS 文件再落清单，中途中断最多留下一个没人引用的 CSS 文件。

预设 id 只允许小写字母、数字与连字符。读写都做校验，含路径分隔符的 id 一律拒绝。

单个样式上限 512 KiB。`MD2PDF_HOME` 环境变量可以改整个目录。

### 从旧版本迁移

0.1.0 之前的版本把选择存在 `settings.json`、覆盖样式存在 `custom.css`。新版首次读取时自动迁移：

1. 用内置样式生成三个预设文件。
2. 旧 `custom.css` 的内容追加到旧选择指向的预设末尾。
3. 选中项沿用旧选择；旧选择指向已删除的预设时回落到 Lark。
4. 旧文件改名为 `settings.migrated.json` 与 `custom.migrated.css`，不删除。

迁移后导出的版面与迁移前一致。

### 样式如何生效

预设的 CSS 以 `<style id="md2pdf-theme">` 原样插入页面，位于内置结构样式之后。其中的 `</style` 会被转义，不能跳出样式块。保存后在下次导出生效，不需要重启。

## 配置

行配置可选，全部有默认值：

```yaml
- insert:
    - id: md2pdf
      name: dsh-md2pdf
      config:
        engine: auto          # auto | electron | browser
        renderer: builtin     # builtin | pandoc | auto
        browserPath: ''       # 显式指定 Chromium 系浏览器
        pandocPath: ''        # renderer: pandoc 时显式指定 pandoc
        timeoutMs: 120000
```

环境变量：

| 变量 | 作用 |
|---|---|
| `MD2PDF_HOME` | 改预设库根目录，默认 `$DSH_HOME/md2pdf` |
| `MD2PDF_BROWSER` | 指定浏览器可执行文件 |

## 渲染与打印

Markdown 转 HTML：

- 默认走内置渲染器 `src/markdown.js`：CommonMark 核心，加 GFM 表格、任务列表、删除线、自动链接，加脚注与 TeX 公式。
- 公式由 `temml` 转 MathML，浏览器原生排版，不嵌入字体。temml 缺失时公式保留为等宽源码，其余内容不受影响。
- 行配置 `renderer: pandoc` 可切到 pandoc，读取器固定为 `gfm-emoji+tex_math_dollars`，与 DSH 里看到的 Markdown 渲染一致。

HTML 转 PDF：

- 宿主进程能加载 Electron 时：Electron `BrowserWindow.printToPDF`，不启动第二个浏览器。
- 否则：Chromium 系浏览器无头模式 `--print-to-pdf`。
- 打印进程退出早于文件落盘，导出会轮询目标文件直到内容完整，避免读到半个 PDF。
- 页面几何默认 A4、18 mm 页边距、15 px 正文，可用配置覆盖。

## 安全边界

五条路由注册为 `/md2pdf/capability`、`/md2pdf/export`、`/md2pdf/settings`、`/md2pdf/presets`、`/md2pdf/previews`。处理前都先问 `ctx.connection.requestRejection()`：该检查校验 Host、Origin 与浏览器登录令牌，只有本机页面能触发打印、读写预设或打开文件。

请求体限定 `application/json`，大小有上限。导出目标只可能是既有 Markdown 文件的同目录同名 PDF。「打开」只接受清单里已知的预设 id，客户端不能传路径。

## 目录结构

```
index.js              Host 半：五条 HTTP 路由 + md2pdf_export 工具
client.js             Client 半：右键菜单项、工具栏按钮、设置页、Toast
src/markdown.js       内置 Markdown 渲染器
src/math.js           temml 懒加载与降级
src/themes.js         三个内置预设的样式与名称
src/presets.js        预设库：索引、读写、增删改排、动作分发
src/opener.js         用系统默认程序打开文件
src/previews.js       设置页缩略图的生成
src/settings.js       用户文件目录与样式上限
src/document.js       纸质 HTML 模板与打印样式表
src/html-build.js     正文生成与 HTML 组装
src/export.js         导出流程编排
src/pdf.js            打印器发现、无头打印、落盘等待
src/proc.js           PATH 查找与子进程执行
locale/*.json         插件管理页的标题、描述、详情文档指针
docs/                 详情文档与特征图
scripts/              开发与诊断脚本
samples/              样例 Markdown 与已验证的输出
```

## 开发

```powershell
npm install                      # 只为本地调试装 temml

npm test                         # 四套断言
node scripts/export-cli.mjs samples/sample.md --html out.html
node scripts/pdf-info.mjs samples/sample.pdf
node scripts/list-audit.mjs      # 46 个用例 × 3 种读取器
node scripts/diagnose-lists.mjs <文件.md>
```

断言分布：

| 脚本 | 条数 | 覆盖 |
|---|---|---|
| `render-check.mjs` | 82 | 渲染、预设、三线表、脚注、公式 |
| `presets-check.mjs` | 37 | 预设库读写、迁移、增删改排、损坏恢复 |
| `preview-check.mjs` | 23 | 缩略图与页面边距 |
| `printer-check.mjs` | 5 | 打印落盘等待 |

`scripts/export-cli.mjs` 走与插件相同的 `exportMarkdownToPdf`，可在不启动 Harness 的情况下验证渲染与打印。

## 已知限制

- 无页眉、页脚与页码。Chromium 命令行打印无法传入自定义页脚模板，GB/T 9704 要求的页码位、GB/T 7713.2 要求的页眉均未实现。
- 公文预设把一级标题渲染成红色小标宋并带红色分隔线，用来模拟红头。发文机关标志、发文字号、签发人、印章等要素需要写在正文里，或用预设 CSS 补。
- 论文预设只落实国标里可排版的部分：纸张、字体字号层级、缩进、三线表、图表题注位置。摘要、关键词、参考文献著录格式由作者按 GB/T 7714 写在正文中。
- 「国标」标签只在预设 CSS 与内置原文完全一致时显示。
- 排序只影响卡片显示顺序，导出只认当前使用的预设。
- 「打开」依赖系统关联的默认程序。没有关联程序时打开失败，界面给出提示，不影响导出。
- 相对图片依赖 `<base href>` 指向源文件目录。跨盘符的绝对 `file:` 引用可能被浏览器安全策略拒绝。
- 内置渲染器不生成标题锚点 id，也不支持 pandoc 特有的定义列表与 fenced div。
- PDF 覆盖同名文件，不保留历史版本。

### 列表识别

读取器按 CommonMark 规则识别列表标记：

| 写法 | 是否识别 |
|---|---|
| `- 项目`、`* 项目`、`+ 项目` | 识别 |
| `1. 项目`、`1) 项目` | 识别 |
| 列表紧接段落下一行（无空行） | 识别 |
| 列表紧接标题下一行 | 识别 |
| `1、项目` | 不识别，属中文编号习惯 |
| `（1）项目`、`①项目` | 不识别 |
| `· 项目`、`• 项目` | 不识别 |
| `-项目`（符号后无空格） | 不识别 |
| `*文字*` 整行 | 按强调处理 |

`scripts/diagnose-lists.mjs` 会逐行报告后几类写法，按提示换成 Markdown 标记即可。

## 许可与致谢

MIT 许可，见 [LICENSE](LICENSE)。

Lark 预设的配色、字号阶梯、行距与间距取自 [imageslr/mweb-themes](https://github.com/imageslr/mweb-themes) 的公开设计参数。该仓库未声明开源许可，因此本项目没有复制其 SCSS，只按这些参数重写了打印用 CSS，并补上分页相关规则。

红头公文与学术论文的版式依 GB/T 9704-2012《党政机关公文格式》与 GB/T 7713.2-2022《学术论文编写规则》编写。
