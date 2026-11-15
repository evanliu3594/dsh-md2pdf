# 设计方案

本文记录 dsh-md2pdf 的确定设计：架构、数据结构、交互语义与边界。实现以本文为准；设计与实现同步修改。

版本：v2，2026-11-14。v2 在 v0.1.0 的预设与渲染基础上增加 DSH 内打印、页面模型、DSH 内预览与字体检查。文末保留 v0.1.0 的既有设计，未变部分继续有效。

## 评审结论

上一轮提案指出 Mac 上没有 Chromium 时无法导出，这个判断成立。提案把 18 项能力放在同一版里，范围过大；其中三项属于不同项目：

- 打印器与页面模型：决定方案能否成立，必须先做技术验证。
- 文档质量：页码、页眉、目录，依赖打印器。
- 工作流与差异化：批量、保存即导出、对话导出、合并成书，依赖前两项。

v2 只做前两项。第三项另立计划；对话导出、合并成书、工作区样式各自单独设计。

打印器方案存在一个必须正视的事实：DSH 的 Host 进程不能调用 Electron 主进程。v2 借 DSH 客户端的隐藏 webview 打印，依赖 sidebar browser 租约和 `<webview>.printToPDF`。这两个都是 DSH 内部接口，Electron 已把 `<webview>` 标为不推荐。方案必须先做一个可失败的 spike，验证通过后再写文档质量功能。

## 目标与范围

### v2 目标

1. 在 Windows 与 macOS 的 DSH Desktop 中，不安装 Edge/Chrome 也能导出 PDF。
2. 纸张、方向、页边距、正文字号可由预设、front matter 或单次导出覆盖，三处规则一致。
3. 导出后能在 DSH 右侧栏用内置 PDF 查看器打开，不启动外部程序。
4. 设置页能报告预设字体的可用性，缺失字体给出警告与回退结果。
5. 支持页眉、页脚、页码、PDF 大纲书签（Stage 2）。
6. 支持显式分页、页眉页脚、页码、PDF 大纲与可点击目录（Stage 2）。封面、完整红头模板、水印不在 v2。
7. 预设可导入、导出、带页面元数据与历史版本（Stage 2）。
8. 输出原子落盘；Windows 文件占用、符号链接、临时文件、并发打印有确定行为。
9. 保留浏览器回退，供 Web GUI 或 DSH 接口变化时使用；回退时能力提示必须明确。
10. 不新增运行时 npm 依赖；不改 DSH 的 app.asar 或主进程。

### 非目标

- 批量导出、保存即导出、命令面板、快捷键：Stage 3。
- 当前对话导出、合并成书、工作区级样式：各自单独立项。
- 参考文献著录、图表交叉引用、目录页码：v2 不做。目录只做可点击列表与 PDF 大纲。
- 所见即所得编辑器、Mermaid、PDF 合并、PDF 库、外部 Chromium 伴生包。
- 跨系统逐字节一致的 PDF。验收看页数、字体、页边距与文本。

### 反目标

- Mac 上没有 DSH 打印器时静默启动 Edge/Chrome，并当作成功。能力状态必须显示实际引擎。
- 为了通过验收而修改 DSH 主进程、app.asar 或用户 profile 之外的 DSH 文件。
- 客户端传任意路径、任意目标目录或任意打印命令。
- Markdown 中的脚本、iframe、事件属性在打印页面执行。
- 导出失败时用半个 PDF 覆盖上一份完整 PDF。
- 把用户预设或历史写到 `MD2PDF_HOME` 之外；目标目录的短命 staging 文件是唯一例外，见“落盘与校验”。

## 约束

- 运行环境：DSH Desktop 0.2.2-rc.3；Host 是 `ELECTRON_RUN_AS_NODE=1` 的 Node 进程；主进程没有打印 IPC。
- DSH 客户端提供 `ctx.sidebarRight.openResource()` 与内置 PDF.js 预览；主窗口启用 `webviewTag`；sidebar browser 租约通过 `window.dshDesktop.browser.acquire()` 暴露。
- Electron 44 的 `<webview>.printToPDF(options)` 返回 `Promise<Uint8Array>`；`PrintToPDFOptions` 支持 `preferCSSPageSize`、`margins`、`displayHeaderFooter`、`generateDocumentOutline`、`generateTaggedPDF`。
- DSH 的 webview session 拦截 `file:` 请求，只允许 http/https/about/data/blob；应用自身 host 也被拦截。打印页面必须由本地 HTTP 服务提供，或使用 data URL。
- Windows 与 macOS；Node 24.21.0 与 Node 26.13.1 都要跑通。
- 项目无构建步骤；Host 是 ESM；客户端是单文件经典脚本；运行时依赖只有 `temml`。
- 用户状态只写 `MD2PDF_HOME`；导出目标只写 `<源目录>/<源文件名>.pdf`；预设标识匹配 `^[a-z0-9-]{1,64}$`。
- DSH 插件实践：不在 `document.body` 追加 DOM；不加载其他 DSH Client 包作为模块；不把 Host HTML 塞进 iframe。
- 现有 147 条断言与 46 个列表用例必须继续通过。

## 方案选择

### 方案 A：Host 继续调用外部 Chromium

现状。Host 用 `--headless=new --print-to-pdf` 调 Edge/Chrome/Chromium/Brave。

优点：实现简单；现有测试覆盖；Windows 自带 Edge，Mac 装 Chrome 后可用；没有内部接口风险。

缺点：干净 Mac 没有 Chromium 就失败；页码、页眉、PDF 大纲做不到；不同浏览器版本输出会漂移；不满足“只利用 DSH 内部组件”。

结论：保留为回退，不作为 v2 主路径。

### 方案 B：Host 渲染，客户端 DSH Chromium 打印，Host 写盘

客户端用 sidebar browser 租约创建隐藏 `<webview>`，加载 Host 准备的打印页面，调用 `<webview>.printToPDF()` 得到字节，回传 Host 写盘。Host 负责渲染、资源服务、任务队列、落盘与校验。

优点：不依赖外部浏览器；与 DSH 同一套 Chromium；能传页眉页脚模板与 PDF 大纲选项；Win/Mac 引擎一致；能直接用 DSH 的 PDF 查看器预览。

缺点：依赖内部租约与已弃用的 `<webview>`；DSH 升级可能破坏；打印逻辑从 Host 移到客户端，架构变化大；需要本地资源服务与 PDF 回传；agent 工具需要额外的打印代理；Web GUI 不能用。

结论：选为 v2 主路径。Windows 与 macOS 使用同一个客户端 DSH 打印器；Edge/Chrome 只在 Web GUI 或 DSH 打印器不可用时回退，Windows 不再以 Edge 为主路径。用适配器隔离，先做 spike，失败就停。

### 方案 C：伴生 Electron 或 Playwright

主包不动，另装一个带 Chromium 的伴生包，Host 调它打印。

优点：稳定；无内部接口；Win/Mac 一致；能页眉页脚与大纲。

缺点：下载与安装体积百 MB 级；新增运行时依赖；违反“只利用 DSH 内部组件”；安装失败、签名、缓存都要处理。

结论：本版不作主路径。若 S1 在 Windows 或 macOS 失败，且用户不接受外部浏览器，再评估一个可选的伴生包；不默认安装。

## 架构

### Host 与 Client 的职责

v2 把“渲染”和“打印”拆开。

- Host 负责：校验源文件、读预设、合并文档配置、渲染 HTML、启动一次性资源服务、创建打印任务、接收 PDF 字节、原子写盘、校验、返回结果。
- Client 负责：判断 DSH 打印器是否可用、申请 webview 租约、加载打印页面、调用 `printToPDF`、回传字节、打开 DSH 预览、显示字体与能力状态。
- 浏览器回退仍由 Host 完成：`/md2pdf/export` 保持现有行为，供 Web GUI、agent 工具和 DSH 打印器不可用时使用。

### 模块

| 模块 | 职责 |
|---|---|
| `index.js` | 路由、工具、失败码；新增 prepare、finish、print-jobs 路由 |
| `src/export.js` | 导出编排；拆成 prepare 与 finish 两步；浏览器回退 |
| `src/document-config.js` | 解析 `pdf.*` front matter，合并默认值、预设元数据、front matter、请求覆盖 |
| `src/page-css.js` | 生成最终 `@page`/`body` 覆盖层；把 CSS 边距解析成英寸；复用 `pageMarginOf()` |
| `src/print-options.js` | 生成 `printToPDF` 参数：页眉页脚模板、居中页码、PDF 大纲开关、边距 |
| `src/test-print.js` | 在 `MD2PDF_HOME/test-print` 写内置测试页 |
| `src/print-jobs.js` | 打印任务状态机、令牌、队列、超时、客户端在场判断 |
| `src/print-server.js` | 一次性 loopback 资源服务：HTML、图片、字体；token、CSP、路径校验、超时关闭 |
| `src/pdf.js` | 浏览器打印适配器、`awaitPdf()`、PDF 头尾校验；删除不可达的 Host Electron 分支 |
| `src/presets.js` | 预设库 v2：页面元数据、导入导出、历史、迁移 |
| `src/previews.js` | 缩略图；页面边距回读改为复用 `page-css.js` |
| `client.js` | PrintHost 组件、webview 租约、打印流程、DSH 预览、字体检查、设置页 |
| `src/themes.js` | 内置预设；补 macOS 字体名 |

客户端仍是单文件。打印适配器作为 `client.js` 内的独立 section；若代码超过可维护上限，再引入构建步骤。v2 不引入构建步骤。

### UI 导出时序

```
用户点导出
  → POST /md2pdf/prepare { path, preset?, page? }
  → Host 校验、渲染、启动资源服务、创建任务
  → 返回 { jobId, printUrl, finishToken, margins, printOptions, ... }
  → Client 申请 webview 租约，创建隐藏 webview，加载 printUrl
  → 等 did-finish-load、document.fonts.ready、所有 img.decode()（单项失败不阻塞，3 秒上限）
  → webview.printToPDF(printOptions)
  → POST /md2pdf/finish（application/pdf + finishToken）
  → Host 原子写盘、校验、关闭资源服务
  → 返回 { pdfPath, previewAddress, bytes, engine: 'dsh', ... }
  → Client 用 ctx.sidebarRight.openResource(previewAddress) 打开 DSH 预览
```

Client 拿不到 DSH 打印器时，改调 `/md2pdf/export`。两条路径返回同一结果结构，`engine` 不同。

### Agent 工具时序

`md2pdf_export` 在 Host 里执行，没有客户端对象。v2 增加打印代理：

```
工具 execute
  → Host 创建打印任务，进入队列
  → Client 空闲时 GET /md2pdf/print-jobs/next（长轮询）
  → 拿到任务，走同一套 webview 打印
  → POST /md2pdf/finish
  → Host 写盘、解析任务 Promise
  → 工具返回结果

失败分支：Client → POST /md2pdf/print-jobs/fail { finishToken, reason }
  → Host 置 failed、关闭资源服务、不写盘
```

Host 记录最近一次客户端轮询时间。工具等待任务时，若 10 秒内没有客户端在场，回退浏览器；浏览器也不可用，返回 `no-printer`。Web GUI 没有 DSH 打印器，客户端不启动轮询；任务只能走浏览器。

轮询默认持有 20 秒，入口记录一次在场，此后每 5 秒续一次；单个固定键，避免长轮询超过 10 秒在场窗口。

任何已连接的 Desktop 客户端都可以认领工具任务，先到先得。工具任务不执行 `afterExport`，不打开预览，只返回路径。UI 导出由发起的客户端打印，`afterExport` 适用。用户切换会话不影响工具任务的写盘；预览只属于 UI 导出。

### 打印引擎接口

Host 侧保留一个窄接口：

```js
{ kinds: ['browser'], printBrowser(htmlPath, target, options) }
```

Client 侧的 DSH 适配器不进入 Host。能力上报分成两段：

- `/md2pdf/capability` 返回 Host 已知信息：浏览器路径、`printEngine` 配置、浏览器是否可用。
- Client 在自己这一侧检查 `window.dshDesktop?.browser`、`webviewTag` 与 `printToPDF`，把 `dsh` 能力合并进 UI 状态。Host 不猜测客户端能力。

## 文档模型

### 页面

`PageConfig` 字段：

| 字段 | 默认 | 说明 |
|---|---|---|
| `size` | `A4` | CSS 纸张关键字；允许 A3/A4/A5/Letter/Legal |
| `marginMm` | 18 | 均匀页边距；0–60 |
| `fontSize` | 15 | 根字号 px；8–24 |
| `landscape` | false | 横向 |

`PageConfig` 是默认值。`PageOverride` 只含显式字段；预设元数据、`pdf.page.*`、单次请求都用它。只有显式字段进入最终层，未设置的字段不覆盖预设 CSS。

来源优先级从低到高：

1. `DEFAULT_PAGE`。
2. 预设元数据 `page`，只在用户显式保存页面设置时存在。
3. front matter 的 `pdf.page.*`。
4. 单次请求的 `page`。

任一高优先级来源提供显式字段时，Host 在预设 CSS 之后追加对应的 `@page`/`body` 规则。只改 `fontSize` 时不要输出 `@page` 边距；只改 `marginMm` 时不要输出纸张尺寸。全部缺省时，预设 CSS 的 `@page` 是权威。内置国标预设不写 `page` 元数据，避免公文 37/26/35/28 mm 被默认 18 mm 覆盖。

v2 只支持一个统一页框：`@page` 的 `size` 与 `margin`（1–4 个值）。不支持 `:first`、`:left`、`:right`、命名页、`margin-top` 等长写，也不支持用 `!important` 改页框。预设使用这些写法时，DSH 路径按统一页框打印并给出警告；浏览器回退保持浏览器自己的行为。

### front matter

front matter 用扁平键，避免引入 YAML 库：

```
---
title: 示例文档
author: DSH
pdf.preset: gongwen
pdf.page.size: A3
pdf.page.landscape: true
pdf.page.marginMm: 20
pdf.header: 内部资料
pdf.footer: 第 {page} 页 / 共 {total} 页
pdf.pageNumbers: true
pdf.toc: true
---
```

`pdf.*` 键只作为配置，不进入正文的 front matter 表格。`title`、`author`、`date`、`tags` 继续显示。

解析规则：

- 布尔只接受 `true`/`false`。
- 数字做范围校验；非法值返回 `bad-request`，不静默回落。
- `pdf.preset` 必须是现存预设标识；找不到时返回 `not-found`，不偷偷用当前预设。
- 预设选择优先级：本次请求 `preset` > `pdf.preset` > 全局 `selected`。
- 除页面外，文档配置优先级：默认值 < front matter `pdf.*` < 本次请求 `documentConfig`。
- 未知 `pdf.*` 键记录警告，不阻断导出。

### 模板字段（Stage 2）

这些键只影响内置模板；用户 CSS 仍可直接排版。

| 模板 | 键 |
|---|---|
| 论文 | `pdf.paper.title`、`authors`、`affiliations`、`abstract`、`keywords`、`date` |
| 通用 | `pdf.header`、`pdf.footer`、`pdf.pageNumbers`、`pdf.toc`、`pdf.outline` |

语义：

- 论文：题名、作者、单位、摘要、关键词、日期由 paper 预设排版；不做独立封面，题名页就是正文首页。
- 目录：按 h1–h3 生成可点击列表，标题由 front matter `lang` 决定（默认 `zh-CN`，取“目录”或“Contents”）；目录独占一页，正文从下一页开始；不做目录页码。
- 标题 id：`md2pdf-h-<slug>`，同文重名依次加 `-2`、`-3`；slug 保留中文，拉丁字母转小写，空白、标点与下划线折成一个连字符。两种生成器使用同一套 id 规则；标题含公式、原始实体或脚注时，各自的可见文本可能不同，id 与目录标签也可能不同。
- 显式分页：正文单独一行 `<!-- pagebreak -->` 生成 `<div class="md2pdf-pagebreak"></div>`。行首缩进四列属于代码块，行内出现不算指令。
- 论文字段由 paper 预设渲染成正文首页的标题块，不设独立封面；非空字段换用其它预设时不渲染，并记录一条警告；未知 `pdf.paper.*` 键单独警告；浏览器回退不返回警告。
- 页眉页脚：模板字符串，支持 `{page}`、`{total}`、`{title}`、`{author}`、`{date}`；由 `pageNumbers`/`header`/`footer` 任一启用 `displayHeaderFooter`。

### 样式分层

v2 的顺序：

1. 结构样式表（`src/document.js`）。
2. 预设样式表（用户 CSS）。
3. 页面覆盖层（显式 `page` 时）。
4. 打印页面附加层（页眉页脚占位、目录、分页）。

用户 CSS 的 `</style` 继续转义。页面覆盖层只包含 `@page` 与 `body` 的字号/行高，不重写预设的其它规则。

### 预设库 v2

`presets.json` 升到版本 2：

```json
{
  "version": 2,
  "selected": "lark",
  "presets": [
    {
      "id": "lark",
      "name": "Lark",
      "description": "通用文档"
    }
  ]
}
```

- `description`、`page` 可选。`page` 只在用户显式保存页面设置时写入，且只保存用户改过的字段；缺省时预设 CSS 的 `@page` 是权威。字体仍由预设 CSS 决定。
- 页眉、页脚、页码、目录属于文档配置（`pdf.*`）或插件配置，不写入预设元数据。预设只负责这些结构的样式。
- 版本 1 索引读取时补默认值，写回版本 2；CSS 文件不动。
- 内置预设的 CSS 只在首次播种或「恢复内置预设」时写入磁盘。升级不会改写已有的预设文件，因此新增的论文块样式只对新建或恢复的预设生效；结构样式表仍为旧预设提供最小重置。
- 保存顺序不变：先 CSS，后索引。
- 导入/导出用一份 JSON 包：`{ version, presets: [{ id, name, description, page, css }] }`。导入时校验标识、名称、CSS 大小、重名；默认不覆盖，用户确认后覆盖。
- 历史版本放在 `MD2PDF_HOME/history/<id>/<timestamp>.css`；保存前备份；保留最近 20 份；设置页可查看与恢复。
- 工作区级样式不在 v2；它会改变“用户状态只写 `MD2PDF_HOME`”这条不变量。

## DSH Chromium 打印器

### 发现与降级

Client 判断顺序：

1. `window.dshDesktop?.protocolVersion >= 1` 且 `window.dshDesktop.browser.acquire` 是函数。
2. 当前窗口能创建 `<webview>`，且元素上有 `printToPDF`。
3. 不在 iframe 内。

三条都满足才认为 DSH 打印器可用。否则：

- `printEngine: dsh`：直接报 `no-printer`，并说明当前窗口没有 DSH 打印器。
- `printEngine: auto`：改走 Host 浏览器回退。
- `printEngine: browser`：只走浏览器。

能力状态在设置页显示实际引擎：`DSH 内置`、`Edge`、`Chrome`、`无`。不把回退成功显示成 DSH 成功。

### PrintHost 与租约

PrintHost 是客户端常驻组件，挂在 `shell.overlay` 或等效常驻 slot。它渲染一个隐藏容器，不向 `document.body` 追加节点。

- 容器尺寸按 A4 比例设置（约 794×1123 px），`position: fixed` 放到视口外或用裁剪隐藏；保持布局，不能用 `display: none`。
- 导出时申请租约：`window.dshDesktop.browser.acquire('md2pdf:<sessionId>')`，得到 `{ lease, partition }`。
- 创建 `<webview name=lease partition=partition src="about:blank#lease">`，追加到 PrintHost 容器。
- 等 `dom-ready` 后调用 `loadURL(printUrl)`。
- 打印结束或失败都移除 webview，并 `browser.release(lease)`。
- 同一时刻只打印一份；并发请求进队列。

租约的 `workspace` 只用于分区隔离；使用 `md2pdf:<sessionId>`，不写用户路径。

### 资源服务

DSH 的 webview session 拦截 `file:`，所以打印页面必须由 HTTP 提供。

`src/print-server.js`：

- 绑定 `127.0.0.1:0`，端口由系统分配。
- 每次任务生成 32 字节随机 `assetToken`，路径前缀 `/p/<assetToken>/`。
- `GET /p/<assetToken>/document.html` 返回渲染好的 HTML，带 CSP。
- `GET /p/<assetToken>/<relative>` 读取资源根目录下的文件；资源根是源文件所在目录，与现有 `<base href>` 一致。相对 URL 按源文件目录解析；`../` 跳出源目录的引用在 DSH 路径被拒绝。
- 路径先解码、再 `realpath`，必须落在资源根内；拒绝目录、设备文件、符号链接逃逸、点文件。
- 只允许 GET/HEAD；无目录列表；响应带 `cache-control: no-store`、`x-content-type-options: nosniff`。
- 单文件上限 32 MiB；单任务总响应上限 256 MiB。
- 任务结束、失败或 120 秒超时后关闭服务；关闭时销毁所有连接。
- 只监听 loopback；校验 `Host` 头是 `127.0.0.1:<port>`。

HTML 的 `<base href>` 指向 `/p/<assetToken>/`，图片与字体按相对路径加载。远程图片默认被 CSP 拦截；用户可在设置里允许 `https:`。

CSP：

```
default-src 'none';
img-src 'self' data:;
style-src 'unsafe-inline';
font-src 'self' data:;
script-src 'none';
connect-src 'none';
frame-src 'none';
object-src 'none';
form-action 'none';
base-uri 'self';
```

允许远程图片时把 `img-src` 改为 `'self' data: https:`。

`prepare` 扫描 HTML 中的本地图片与字体引用。缺失文件、源目录外引用、被 CSP 拦截的远程图片进入 `warnings`；导出继续，PDF 使用 alt 文本或回退字体。`finish` 结果带 `warnings`，客户端提示，不把导出判为失败。

### printToPDF 参数

Client 把 Host 返回的参数原样传给 `<webview>.printToPDF()`：

```js
{
  printBackground: true,
  preferCSSPageSize: true,
  margins: { top, bottom, left, right }, // 英寸
  landscape: config.page?.landscape,   // 未显式设置时为 undefined
  displayHeaderFooter: config.displayHeaderFooter,
  headerTemplate: config.headerTemplate,
  footerTemplate: config.footerTemplate,
  generateDocumentOutline: config.outline,
  pageRanges: '',
}
```

页边距从最终 `@page` 解析。禁止继续使用固定的 `page.marginMm`，否则公文预设的 37/26/35/28 mm 会被压成 18 mm。Host 传给 Client 的 `config.page` 是只含显式字段的 `PageOverride`；`landscape` 未设置时不传，交给 CSS `@page`。`displayHeaderFooter` 由页眉、页脚或页码任一启用决定。

Chromium 把空字符串的页眉或页脚模板当作未设置，改用自带默认值：页眉显示日期与标题，页脚显示 URL 与页码。因此 `displayHeaderFooter` 为真时，未配置的一侧必须传一个非空且不可见的模板（`<span></span>`）。只有 `displayHeaderFooter` 为假（页眉、页脚、页码都未配置）时，两侧模板才为空。

Host 在 `src/print-options.js` 生成参数，Client 原样转发；参数只由 Host 决定。

页眉页脚模板由 Host 生成并转义：

- 页码页脚默认居中，作用于所有页；v2 不做奇偶交替。
- 页脚支持 `{page}`、`{total}`、`{title}`、`{author}`、`{date}`。
- 页眉支持同样五个变量；未识别的占位符保持字面文本，已识别但没有取值的变量渲染为空。
- 模板内联字体与字号；不加载外部资源。
- `generateDocumentOutline` 用标题生成书签；标题需要稳定 id 时由渲染器补 slug。

### 落盘与校验

Host 收到 PDF 字节后：

1. 校验 `content-type: application/pdf`。
2. 校验 `finishToken` 属于未完成任务。
3. 校验字节以 `%PDF-` 开头、尾部 2 KiB 内含 `%%EOF`。
4. 写到目标目录的临时文件 `.md2pdf-<jobId>.pdf.tmp`，`fsync` 后改名到 `<源名>.pdf`。这是“用户状态只写 `MD2PDF_HOME`”的明确例外：临时文件是短命 staging，不是用户状态，成功、失败、启动清理都会删除。
5. Windows 上目标被占用时，重试 3 次，间隔 100/300/900 ms；仍失败返回 `file-busy`，保留旧文件。
6. 目标存在且是符号链接时拒绝写入，返回 `bad-request`。
7. 写盘成功后删除临时文件、关闭资源服务、结束任务。

浏览器回退也改为先打印到临时文件，再走同一套校验与改名。`awaitPdf()` 继续负责等待浏览器写完。

### 打印任务

状态：

```
prepared → claimed → printing → finishing → finished
                                   ↘ failed（仅写入方）
prepared/claimed/printing → expired
finishing → expired（仅在 finishGraceMs 之后）
```

- `prepared`：Host 已渲染，等待客户端。
- `claimed`：客户端已取走任务。
- `printing`：客户端已开始打印。
- `finishing`：写入方已取得写锁，正在写盘。写锁期间外部 `fail` 被拒绝，超时清扫跳过该任务；写入方提交后转 `finished`，写盘失败时由写入方转 `failed`。停在 `finishing` 超过 `finishGraceMs`（默认 30 秒）的任务才允许被清扫成 `expired`。
- `finished`：PDF 已写盘。
- `failed`：客户端报告错误、PDF 校验失败或写盘失败。
- `expired`：超时，资源服务关闭。

任务字段：`id`、`assetToken`、`finishToken`、`sessionId`、`sourcePath`、`targetPath`、`html`、`assetRoot`、`printOptions`、`state`、`createdAt`、`deadline`、`owner`（`ui` 或 `tool`）。

工具的 10 秒在场检查发生在创建任务之前：有客户端轮询就创建任务，没有则按引擎回退。任务在资源服务启动、`printUrl` 可用之前不可被 broker 认领；`ready` 标记由导出器在资源服务就绪后设置。长轮询只交付 ready 的 tool 任务。

队列同一时刻只允许一个 `printing` 任务；其余 `prepared` 等待。客户端一次只执行一个 `printToPDF`。UI 直连导出与 tool 代理任务都经过客户端同一个打印队列；Host 任务队列负责顺序与状态。

任务超时从 `prepare` 起算，队列等待计入。工具等待 10 秒是客户端在场检查，不是队列空闲检查；有客户端在场就等到 `jobTimeoutMs`。v2 串行打印，一次一个任务。

Agent 工具结果只返回路径与结果，不打开预览。

### 失败与回退

新增失败码：

| 码 | 状态 | 含义 |
|---|---|---|
| `client-required` | 503 | 只允许 DSH 打印器，但当前没有客户端 |
| `job-timeout` | 504 | 打印任务超时 |
| `file-busy` | 409 | 目标 PDF 被占用，无法替换 |
| `asset-server-failed` | 500 | 资源服务启动失败 |
| `pdf-invalid` | 502 | 回传字节不是完整 PDF |
| `client-error` | 502 | 客户端报告的未分类错误 |
| `write-failed` | 500 | 临时文件写入失败 |

现有 `no-printer`、`print-failed`、`not-a-pdf`、`empty-output` 保留。

UI 失败顺序：

1. DSH 打印器失败：释放租约，关闭任务；`auto` 下再试浏览器。
2. 浏览器失败：返回具体错误。
3. 两者都不可用：`no-printer`，提示安装 Chromium 或用 DSH Desktop。

回退只发生在没有写盘的失败：`no-printer`、`print-failed`、`job-timeout`、`asset-server-failed`。`file-busy`、`pdf-invalid`、`not-a-pdf`、`empty-output` 不回退；这些失败可能已有目标文件或已有提交结果。

`finish` 幂等：已完成任务保留提交结果；同一 token 重试返回已提交结果，不再次写盘；任务成功后再收到不同字节的 `finish` 返回 `409`，不覆盖。客户端网络错误重试同一 token。

Agent 工具失败顺序：

1. 有客户端认领：等结果；超时返回 `job-timeout`。
2. 10 秒内无客户端：`auto` 下走浏览器。
3. 浏览器不可用：`no-printer`。

## DSH 预览与字体检查

### 预览

导出成功后，Host 在 `finish` 结果里返回 `previewAddress`。地址由本次任务的 `sessionId` 与 `targetPath` 计算：

```
dsh-resource://file/session/<encodedSessionId>/<encodedPath>
```

路径保留开头的 `/`；每段用 `encodeURIComponent`，`:` 保持字面；Windows 反斜杠先换成 `/`。

Client 只打开 Host 给出的地址：

```js
ctx.sidebarRight.openResource(result.previewAddress)
```

客户端不自行拼路径，也不传任意路径。DSH 的内置 document preview 按 `.pdf` 分派到 PDF.js，右侧栏展开并显示。该服务是 DSH 的公开客户端能力，Win/Mac 一致。

客户端的 `dsh.client.inject` 增加 `@deepseek-ai/dsh-client-ui-sidebar-right`，只使用 `ctx.sidebarRight` 服务，不 import 该包。

`afterExport` 设置：

- `dsh`：默认，打开 DSH 预览。
- `system`：用系统默认程序打开（现有 `openPath`）。
- `none`：只提示路径。

成功 `finish` 后，Host 对 UI 任务执行 `afterExport`：`system` 由 Host 调 `openPath`。打开失败记在结果的 `open` 字段，写盘仍算成功。工具任务不执行 `afterExport`。

Host 在 `finish` 前检查目标文件可读；可读时才返回 `previewAddress`。`openResource` 返回 void，查看器后续加载失败由 DSH 显示。查看器、地址缺失或 `openResource` 同步抛错时，Client 用 `finishToken` 调 `/md2pdf/open`，由 Host 解析已提交目标后回退系统打开。

v2 不自动刷新已经打开的 PDF。重新导出后，用户关闭再打开该标签；自动刷新留给后续版本。PDF 在会话工作区外时，预览可能被文件访问策略拒绝；此时回退系统打开，并提示原因。`ctx.sidebarRight` 不可用时同样回退系统打开。

### 字体检查

设置页读取当前预设 CSS，提取 `font-family` 声明中的具体字体族。对每个族执行：

```js
document.fonts.check('16px "Family"', '汉')
document.fonts.check('16px "Family"', 'A')
```

结果分三类：可用、缺汉字、缺拉丁。通用族（serif、sans-serif、monospace、system-ui）跳过。`@font-face` 自定义字体在客户端未加载时标为“未验证”，不冒充可用。

检查结果用于：

- 设置页字体表；缺失项给出警告。
- 导出前的轻提示；不阻断导出。
- 预设编辑建议；例如 Mac 上提示 `STZhongsong` 缺失、标题回退到 Songti SC。

内置字体栈补 macOS 名称：

- `FANGSONG` 保留 `STFangsong`。
- `SONG` 保留 `Songti SC`、`STSong`。
- `KAITI` 保留 `STKaiti`、`Kaiti SC`。
- `HEITI` 增加 `Heiti SC`、`PingFang SC`。
- `XIAOBIAOSONG` 增加 `Songti SC` 作为显式回退。

字体检查在 DSH 客户端 Chromium 里运行，与 DSH 打印器使用同一套系统字体，结果对 DSH 路径准确。浏览器回退时系统字体相同，结果仍可参考。

## 安全与可靠性

### 路由

| 路由 | 方法 | 作用 |
|---|---|---|
| `/md2pdf/capability` | GET | Host 打印能力与配置 |
| `/md2pdf/export` | POST | 浏览器回退导出；agent 工具无客户端时使用 |
| `/md2pdf/prepare` | POST | 渲染并创建打印任务 |
| `/md2pdf/finish` | POST | 接收 PDF 字节并写盘 |
| `/md2pdf/open` | POST | 用系统默认程序打开已完成 UI 任务的 PDF |
| `/md2pdf/print-jobs/next` | GET | 客户端长轮询取任务 |
| `/md2pdf/print-jobs/fail` | POST | 客户端报告工具任务失败 |
| `/md2pdf/test-print` | POST | 渲染内置测试页并创建打印任务 |
| `/md2pdf/settings` | GET | 预设库、选中 CSS |
| `/md2pdf/presets` | POST | 预设动作 |
| `/md2pdf/previews` | GET | 缩略图页面 |

每条路由先调用 `ctx.connection.requestRejection()`。`finish` 额外校验 `finishToken`；`open` 只接受 `finishToken`，只服务 UI 任务，目标由 Host 从任务解析，客户端不传路径、任务 id 或 URL；`print-jobs/next` 只返回未认领任务，客户端每次轮询由 connection fence 鉴权；`print-jobs/fail` 只接受任务的确切 `finishToken` 与白名单失败原因，把任务置为 `failed` 并关闭资源服务，不写盘；`finish` 只接受 `application/pdf`，上限 64 MiB。

`prepare` 请求体：`{ path, sessionId?, preset?, page?, documentConfig? }`。`sessionId` 用于计算 `previewAddress`；没有它时不返回预览地址。`documentConfig` 只来自本次 UI 覆盖，不写回源文件。

客户端不能传目标路径、命令、资源根或任意 URL。目标由 Host 从源路径计算；资源根由 Host 固定为源文件目录。

### 路径与文件

- 源路径规范化、后缀校验、普通文件校验。
- 目标只能是 `<源目录>/<源文件名>.pdf`。
- 目标存在时检查 `lstat`：符号链接拒绝；普通文件允许覆盖。
- 写临时文件用 `O_EXCL`；写后 `fsync`；改名覆盖。
- Windows 占用重试；失败保留旧文件。
- 临时目录在启动时清理超过 24 小时的文件；任务结束立即清理。

### 页面安全

- DSH 路径的 CSP 见资源服务；脚本、iframe、object、表单全部禁止。
- 浏览器回退使用同一份 HTML 与同一套 CSP，只把 `img-src`/`font-src`/`base-uri` 增加 `file:`。浏览器直接读源目录的 `file:` 资源；资源服务不参与回退。远程图片默认同样拦截。
- Markdown 原始 HTML 中的 `<script>`、事件属性、`javascript:` 链接不会执行；CSP 兜底。
- 远程图片默认拦截；用户显式允许后才加载。
- 资源服务只读；`assetToken` 随服务关闭失效；`finishToken` 在任务完成后仍可幂等重放。两个 token 独立。
- 打印 webview 由 DSH 租约创建，沙箱、无 Node、无下载、无权限。

### 并发与资源

- Host 队列串行打印；一次一个 webview。
- 浏览器回退同样串行，最多一个子进程。
- 打印超时默认 120 秒；任务超时 120 秒；`awaitPdf` 20 秒。
- 客户端关闭或刷新时，任务转 `failed` 或 `expired`，资源服务关闭。

## 设置页

新增区域：

- 打印引擎：显示 DSH 内置 / Edge / Chrome / 无；刷新按钮；测试打印。测试页写在 `MD2PDF_HOME/test-print`，不进入用户工作区；没有 DSH 打印器时走浏览器回退。
- 页面：纸张、方向、页边距、正文字号；保存到当前预设的 `page` 元数据；预览。
- 字体：字体表、缺失警告、回退预览。
- 预设：导出、导入、历史、恢复内置。导出是一个 JSON 包（版本 2，含每个预设的样式、页面元数据与当前选择），导入先在内存校验全部条目再写盘；同名预设默认跳过并报告，确认覆盖后替换样式、页面与描述，保留已有名称。历史保存在 `MD2PDF_HOME/history/<id>/<时间戳>-<随机>.css`，每个预设保留最近 20 份，保存与恢复前各记录一次。
- 文档覆盖：页面、页眉、页脚、页码、目录；只作用于本窗口后续导出，源文件与预设不变；清除即恢复文件取值。
- 诊断：引擎、字体、最近错误、插件目录、复制 JSON；不含文档内容。

现有卡片、编辑器、保存、排序、恢复交互不变。新增控件沿用 DSH 主题 token 与 locale 文案。

## 配置与常量

行配置新增：

| 字段 | 默认 | 作用 |
|---|---|---|
| `printEngine` | `auto` | `auto`、`dsh`、`browser` |
| `afterExport` | `dsh` | `dsh`、`system`、`none` |
| `pageNumbers` | false | 默认页码开关；front matter 与请求可覆盖 |
| `outline` | true | 生成 PDF 大纲；front matter `pdf.outline` 与请求可覆盖 |
| `allowRemoteImages` | false | 是否允许远程图片 |
| `jobTimeoutMs` | 120000 | 打印任务超时 |

继续使用 `browserPath`、`pandocPath`、`renderer`、`timeoutMs`。`engine` 字段保留兼容：`electron` 映射为 `auto` 并记录警告。

环境变量：

| 变量 | 作用 |
|---|---|
| `MD2PDF_HOME` | 预设库、历史、临时文件根目录 |
| `MD2PDF_BROWSER` | 浏览器回退路径 |

## 迁移与兼容

- `presets.json` v1 → v2：补 `version`、`description`；`page` 只在用户保存页面设置时添加；CSS 不动；写回 v2；测试覆盖。旧预设不加 `page`，版式不变。
- 旧 `settings.json`/`custom.css` 迁移保留。
- `engine: electron` 兼容映射；不再有 Host Electron 打印路径。
- 现有 `/md2pdf/export` 请求与响应保持；新增字段向后兼容。
- `md2pdf_export` 工具参数保持 `path` 必填；新增可选 `preset`、`page`；结果新增 `engine`、`preset`、`page`。
- 客户端能力检查兼容没有 `window.dshDesktop` 的 Web GUI。
- `docs/DESIGN.md`、`README.md`、`AGENTS.md` 在实现后同步；`AGENTS.md` 只留目标、架构、指针与禁止行为。

## 验证

### 自动断言

现有四套：82 / 37 / 23 / 5，全部保持。新增：

- 文档配置：默认值、预设元数据、front matter、请求覆盖、非法值、未知键。
- 页面 CSS：显式覆盖追加在预设之后；边距解析 mm/cm/in/pt；A3/横向。
- 资源服务：token、路径逃逸、符号链接、目录、点文件、MIME、CSP、超时、关闭。
- 打印任务：状态机、队列、两个 token 的边界、幂等 finish、超时、客户端在场、失败回退。
- PDF 写盘：`%PDF-`/`%%EOF`、临时文件、改名、Windows 占用模拟、符号链接目标、旧文件保留。
- 预设 v2：迁移、导入导出、重名、历史、恢复。
- 浏览器回退：现有 `awaitPdf` 用例继续。
- 渲染器：标题 slug、目录、分页指令、论文模板字段、front matter 过滤。
- 打印参数：页眉页脚模板与变量转义、未配置一侧的不可见模板（`<span></span>`）、居中页码、默认页脚、大纲开关、边距透传。

### 手动 spike

S1（阻断后续，Windows 与 macOS 各跑一次）：

macOS：

- 本机 macOS，DSH Desktop，`printEngine: dsh`。
- 一份含本地图片、公式、表格、脚注的 Markdown，公文预设。
- 不启动 Edge/Chrome。
- 验证：租约、webview、资源服务、`printToPDF`、PDF 字节、Host 写盘、DSH 预览、A4 页边距。

Windows：

- Windows 上的 DSH Desktop，同一个插件分支，`printEngine: dsh`。
- 同一份样张，路径含中文和空格。
- 检查结果为 `engine: 'dsh'`，导出期间没有新的 Edge 子进程；PDF 能打开，DSH 预览可用，页边距与字体符合预期。
- 记录 Windows 字体与文件锁行为。

任一端失败则停，回到方案 A 或 C 让用户决定。双端都通过后才进 Stage 2。

S2：

- 公文样张，页脚页码、页眉标题、PDF 大纲。
- 验证页数 4、页边距 37/26/35/28 mm、字体 STFangsong/STKaiti、页码位置、PDF 查看器书签。
- 页码全部居中，检查首页与末页。

S3：

- Agent 调用 `md2pdf_export`，客户端轮询取任务、打印、写盘。
- 验证无浏览器环境、任务超时、客户端关闭、回退。

### 双端矩阵

Windows 与 macOS 各跑：

- `npm test`。
- 同一份样张的公文、论文、Lark 预设；页数、字体、中文/空格路径。
- 目标 PDF 被查看器占用。
- 符号链接目标、只读目录、超长路径。
- DSH 打印器与浏览器回退各一次。

## 交付阶段

Stage 1（v2 基础，团队先做）：

1. PrintHost、租约、资源服务、prepare/finish、任务队列。
2. 页面模型、front matter、页面设置 UI 与预设 `page` 元数据。
3. DSH 预览。
4. 字体检查表与警告。
5. 安全、CSP、原子写盘、占用处理、资源警告。
6. S1 双端验证、S3 验证。S1 在 Windows 与 macOS 都通过后才进 Stage 2。

Stage 2（文档质量）：

1. 页眉、页脚、页码、PDF 大纲；页码统一居中。
2. 显式分页、可点击目录、论文模板字段。
3. 预设导入导出、历史。
4. 设置页文档覆盖表单：编辑本次导出的 `pdf.*`，不改源文件。
5. S2 验证：`samples/sample.md` + gongwen，4 页，A4，边距 37/26/35/28 mm（±0.5 mm），字体 STFangsong/STKaiti/Songti，页脚页码，PDF 大纲；文本抽取核对。paper 与 lark 样张再各跑一次，重点看页码、页眉和目录。

Stage 3（工作流，另立计划）：

- 批量导出、保存即导出、命令面板、快捷键、导出历史、Finder/Explorer 选中、诊断扩展。

后续独立项目：

- 当前对话导出、合并成书、工作区级样式、目录页码、图表编号与交叉引用。

## 已知限制

- DSH 打印器依赖内部租约与 `<webview>`；DSH 升级可能失效。适配器隔离，失败回退。
- Web GUI 没有 DSH 打印器，只能走浏览器。Windows 桌面端主路径与 macOS 相同，Edge 只作回退。
- Agent 工具需要已连接的 DSH 客户端；无客户端时只能走浏览器。
- 页眉页脚模板覆盖整份文档；v2 页码统一居中，不做奇偶交替。
- 目录只做可点击列表与 PDF 大纲；目录页码需要两遍排版，v2 不做。
- 资源根固定为源文件目录；引用根外图片或字体在 DSH 路径会失败。
- 远程图片默认拦截；自定义 `@font-face` 在字体检查里标为未验证。
- 跨系统不保证逐字节一致；验收看页数、字体、页边距与文本。
- 预设 v2 新增字段需要迁移；工作区级样式尚未支持。
- 批量、保存即导出、对话导出、合并成书不在 v2。
- DSH 路径只支持统一页框；`@page :first`、`:left`、`:right`、命名页与长写只在浏览器回退生效。

## 决策记录

2026-11-14 审核后，以下作为设计决策；用户可在批准时推翻：

1. 主路径选方案 B，Windows 与 macOS 同一套客户端 DSH 打印器；方案 A 只作回退；方案 C 只在 S1 双端失败且用户同意时评估。
2. v2 只做 Stage 1 与 Stage 2；Stage 3 与后续项目分开。
3. 目标用户优先：论文、技术文档；公文预设只作 CSS 能力展示，不做完整红头模板。对话导出延后。
4. 页码全部居中；不做封面，不做奇偶交替。
5. Agent 工具通过打印代理使用 DSH 打印器；无客户端回退浏览器。
6. 工作区级样式不做，保持 `MD2PDF_HOME` 不变量。
7. 不新增运行时 npm 依赖；S1 在 Windows 或 macOS 失败且用户同意时，才评估一个可选的伴生 npm 包。

## 留给实现者

- PrintHost 用哪个常驻 slot：优先 `shell.overlay`；实现前用 DSH Inspect 确认 slot 存在与 props。
- 资源服务的 MIME 表、单文件上限、CSP 头与连接关闭细节。
- 设置页布局、主题 token 与 locale 键。
- 测试夹具命名、手动 spike 记录位置与双端矩阵脚本。
- 页眉页脚模板的具体 HTML 结构与字体。

## 既有设计（v0.1.0，未变部分）

### 预设库

一份预设由标识、显示名、CSS 文本组成。标识决定文件名，显示名可改；CSS 是完整覆盖层，不继承其它预设。

内置 `lark`、`gongwen`、`paper`，与用户预设地位相同；删空后重建默认预设，恢复动作补回缺失项。

文件布局：

```
$DSH_HOME/md2pdf/
  presets.json
  presets/<id>.css
```

`presets.json` 是权威；数组顺序即卡片顺序；写入先 CSS 后索引；索引写 `.tmp` 再改名。

标识匹配 `^[a-z0-9-]{1,64}$`；单个样式上限 512 KiB；索引损坏改名 `.corrupt` 后重建；删除选中项后选第一项，删空只重建默认。

导出包是版本 2 的 JSON：`{ version, selected, presets: [{ id, name, description?, page?, css }] }`，不含任何路径。导入先在内存中校验全部条目（标识、名称、样式上限、页面字段、重复标识），再按「先 CSS 后索引」写入。同名预设默认跳过并在 `warnings` 中报告；确认覆盖后替换样式、页面与描述，保留已有名称。

历史写在 `history/<id>/<时间戳>-<随机>.css`，保存与恢复前各记录一次；每个预设保留最近 20 份，列表按时间戳倒序。恢复先记录当前样式，再写入快照，所以恢复本身可撤销。

### 渲染

内置渲染器实现 CommonMark 核心，加 GFM 表格、任务列表、删除线、自动链接、脚注与 TeX 公式。公式由 `temml` 转 MathML；temml 缺失时保留源码。

pandoc 通路可选，`renderer: pandoc` 时启用；读取器固定 `gfm-emoji+tex_math_dollars`。

### 中英分排

字体栈把拉丁字体放前，汉字回退到后面的中文字体。代码块用等宽字体。

### 三线表

两个国标预设使用三线表：顶线/底线 1.5pt，栏目线 0.75pt，无竖线，表头无底色。渲染器识别表题与表注。

### 缩略图

设置页缩略图把生效 `@page` 边距回读成 `body` 内边距。v2 继续用 `pageMarginOf()`，来源改为最终页面层。

### 打开文件

`open` 动作只接受索引中已知的预设标识；路径由 Host 拼出并校验。Host 用系统程序打开：Windows `cmd /c start ""`，macOS `open`，Linux `xdg-open`。v2 增加 DSH 预览；Finder/Explorer 选中与导出历史列入 Stage 3。

### 验证基线

四套断言：`render-check` 82、`presets-check` 37、`preview-check` 23、`printer-check` 5。`list-audit` 46 个用例。`export-cli.mjs` 可在不启动 Harness 时验证。

### 配置基线

`engine`、`renderer`、`browserPath`、`pandocPath`、`timeoutMs`；`MD2PDF_HOME`、`MD2PDF_BROWSER`。页面默认 A4、18 mm、15 px。v2 扩展见前文。
