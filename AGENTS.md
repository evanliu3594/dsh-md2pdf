# AGENTS.md

本文件记录项目目标、设计思路、数据管线、技术栈、所用技能与禁止事项。改动代码前先读这一页，再读 `docs/DESIGN.md`。

## 项目目标

让 DSH 侧边栏里打开的 Markdown 一步变成可分发、可打印的 PDF，版式由用户自己管理。

三条验收标准：

1. 导出只靠插件本身。机器上没有 pandoc、LaTeX 或任何命令行工具，产出仍然一致。
2. 预设是用户的文件。用户能新增、改名、排序、删除，也能用系统编辑器直接改。
3. 升级不丢数据。旧版本的选择与自定义样式在首次读取时迁移，导出结果与迁移前一致。

## 设计思路

| 决策 | 理由 |
|---|---|
| 预设是一份 CSS 文件，不是数据库记录 | 用户能直接编辑、备份、放进版本库 |
| 索引是权威，写入先 CSS 后索引 | 中断最多留下没人引用的文件，不会出现条目指向空样式 |
| Host 管权限与副作用，Client 只管界面 | 信任检查、文件写入、进程启动都集中在 Host |
| 自带 Markdown 渲染器 | 不要求用户装 pandoc，所有机器产出相同 |
| DSH 客户端打印 | 客户端用 DSH 自带 Chromium 的 `<webview>.printToPDF`；浏览器只做回退 |
| 写锁保护落盘 | finish 先取得写锁再写盘，超时清扫与外部 fail 不得打断已开始的提交 |
| 打印后轮询落盘 | 浏览器回退的打印进程退出早于文件写完，直接读会拿到半个或旧的 PDF |
| 每条路由先过信任栅栏 | 只有本机页面能触发打印、改预设、开文件 |
| 打开文件只认预设标识 | 路径由 Host 从标识拼出并校验，客户端传不进任意路径 |
| 预设 CSS 当数据插入并转义 `</style` | 用户样式不能跳出样式块 |

## 数据管线

### 导出

```
文件树右键 / 标签工具栏 / 路径右键 / md2pdf_export
  → POST /md2pdf/prepare { path, preset?, page?, documentConfig? }
  → 栅栏校验 → inspectSource() → 读源文件 → 合并 pdf.* 配置
  → renderDocument()：markdown.js → html-build.js → document.js
  → 启动一次性 loopback 资源服务 → 创建打印任务（ready=false → markReady）
  → 客户端长轮询或 UI 直接认领 → <webview>.printToPDF(printOptions)
  → POST /md2pdf/finish（字节 + finishToken）
  → 取写锁 → 校验 %PDF-/%%EOF → 写 .md2pdf-<jobId>.pdf.tmp → fsync → 改名
  → <源目录>/<源文件名>.pdf
  → 返回 { pdfPath, bytes, engine, previewAddress, warnings, ... }

浏览器回退：POST /md2pdf/export 渲染后由 Chromium 打印到临时文件，
走同一套校验与改名；只有它能用 file: 资源。
```

### 预设

```
打开设置页 → GET /md2pdf/settings
  → ensurePresets()：索引缺失则播种三个内置预设，并迁移旧的 settings.json / custom.css
  → listPresets()：逐个读 CSS，算出 builtin 与 unmodified
  → 返回 { selected, presets, builtins, css, cssPath, presetsPath, maxBytes }

卡片操作 → POST /md2pdf/presets { action }
  → runPresetAction()：read | select | save | order | delete | restore | open
       | export-bundle | import-bundle | list-history | restore-history
  → presets.js 写 CSS 文件，再写 presets.json
  → 保存与恢复前把旧样式写入 history/<id>/；每个预设保留 20 份

缩略图 → GET /md2pdf/previews
  → buildPreviews()：每个预设渲一份 HTML，边距从 @page 回读成 body 内边距
```

## 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 运行时 | Node.js ≥ 20.11，ESM | 无构建步骤，发布物就是源码 |
| 插件框架 | `@deepseek-ai/cordis` ~4.1（peer，可选） | Host 用 `apply(ctx, config)`；Client 用 `window.__ModuleLoader__`，模块 id 等于包名 |
| 客户端 | React（由浏览器模块表提供），DSH 的 slots、contextMenus、locale 服务 | 不打包 React |
| Markdown | 自带渲染器 `src/markdown.js` | CommonMark 核心 + GFM 表格、任务列表、删除线、自动链接 + 脚注 + TeX |
| 公式 | `temml` ^0.14 转 MathML | 唯一运行时依赖 |
| 打印 | DSH 客户端 `<webview>.printToPDF`；Chromium `--print-to-pdf` 回退 | pandoc 仅作可选渲染器 |
| 测试 | 纯 Node 脚本，不引测试框架 | `scripts/*.mjs`，13 套断言 + 46 个列表用例 |
| 文档 | Markdown + PNG | 图片由真实渲染管线生成 |

## 模块职责

```
index.js          Host 入口：路由、md2pdf_export 工具、失败码映射
client.js         Client 入口：菜单项、工具栏、PrintHost、broker 轮询、设置页、文档覆盖
src/markdown.js   内置渲染器；标题 id、目录、显式分页
src/math.js       temml 懒加载与降级
src/themes.js     三个内置预设的 CSS 文本与名称
src/presets.js    预设库：播种、迁移、增删改排、导入导出、历史、动作分发
src/opener.js     用系统默认程序打开文件
src/previews.js   每预设一份预览文档，边距回读
src/settings.js   用户目录解析与样式上限
src/document.js   纸质 HTML 外壳与结构样式表；目录、分页、论文块样式
src/document-config.js 解析 pdf.*；合并行配置、预设页、front matter、请求
src/page-css.js   页面覆盖层与 @page 边距解析
src/print-options.js 打印参数：页眉页脚模板、居中页码、大纲开关、边距
src/print-jobs.js 打印任务状态机（含 finishing 写锁）、令牌、在场判断
src/print-server.js 一次性 loopback 资源服务
src/test-print.js 内置测试页（写入 MD2PDF_HOME/test-print）
src/asset-scan.js 本地资源引用扫描与警告
src/font-css.js   字体族与 @font-face 解析
src/html-build.js 正文生成与文档组装
src/export.js     导出编排：prepare/finish、浏览器回退、agent broker
src/pdf.js        浏览器回退打印、awaitPdf、PDF 校验
src/proc.js       PATH 查找与子进程执行
```

## 不变量

破坏其中任何一条，会丢掉用户数据、安全边界或一次导出。

1. 写入顺序：先 CSS 文件，后 `presets.json`。
2. 预设标识匹配 `^[a-z0-9-]{1,64}$`。`presetCssPath()` 与 `historyDirectory()` 是仅有的把标识拼进路径的地方，二者都先校验标识。
3. 每条路由先调 `ctx.connection.requestRejection()`，再加其它逻辑。
4. 导出目标只能是 `<源目录>/<源文件名>.pdf`。
5. 「打开」只接受索引里已知的预设标识，客户端不传路径。
6. 用户状态只写在 `MD2PDF_HOME` 之内。
7. 版本号在发布时递增；当前 `0.1.1`。
8. 运行时依赖只有 `temml`。
9. 预设 CSS 以文本插入，`</style` 必须转义。
10. `finish` 先调 `beginFinish()` 取写锁。写锁期间外部 `fail` 被拒绝，超时清扫跳过；写盘失败只能由写入方 `abandonFinish()` 结束任务。
11. 打印参数只由 Host 生成。`displayHeaderFooter` 为真时，未配置的一侧必须传非空不可见模板（`<span></span>`）。
12. 页码居中且作用于所有页；v2 不设封面、完整红头模板或水印。

## 命令与验证

```powershell
npm test                  # 13 套断言，全部通过才算过
node scripts/list-audit.mjs
node scripts/export-cli.mjs samples/sample.md --html out.html
node scripts/pdf-info.mjs samples/sample.pdf
```

当前计数（2026-11-16）：render 203、document config 80、print options 131、presets 117、
previews 25、dsh preview 72、printer 5、print server 42、print jobs 80、export 139、
after export 95、broker 294、client UI 134。计数会随功能增长；闸门是「全部通过」。
Windows 10 账户没有符号链接权限时 export 为 136/136，少 3 条 symlink 断言。
`list-audit` 必须打印 `failures: builtin=0 markdown(old)=0 gfm+math=0`。

三条环境事实：`src/` 或 `index.js` 的改动要重启 DSH 才加载；只改 `client.js` 刷新页面即可。打印优先走 DSH 客户端；没有客户端时启动 Chromium 浏览器。测试打印写在 `MD2PDF_HOME/test-print`。

## 约定

- 导出的函数写 JSDoc，含 `@param` 与 `@returns`。
- 注释、标识符用英文。界面文案双语：`client.js` 两份字典，插件页文案在 `locale/*.json`。
- 错误码由 `PdfError` 表达，在 `FAILURE_STATUS` 里配状态码，两处一起改。
- 默认新开小模块，别把 `client.js` 继续撑大。设置页是唯一例外。
- 内置预设的 CSS 在 `src/themes.js`，首次使用落盘。两处必须一致：`themeCss()` 是「国标」标记与恢复动作的比较基准。

## 改动配方

加内置预设：

1. 在 `src/themes.js` 写 CSS 常量，字体栈里拉丁字体放最前。
2. 往 `THEMES` 加一条，含 `id`、`label`、`labelEn`、`note`。
3. 跑 `npm test`，`presets-check` 会核对播种数量与顺序。
4. 用一次性 `MD2PDF_HOME` 重新生成 `samples/` 里的样张与 `docs/images/`。

改存储结构：

1. 扩写 `migrateLegacy()`，保证已有目录仍能打开。
2. 在 `scripts/presets-check.mjs` 加一条从旧目录开始的断言。
3. 迁移前后各导出同一份样张一次，核对字节数一致。

加路由：

1. 在 `index.js` 导出路径常量。
2. 在 `ctx.effect(() => ctx.webServer.register(...))` 里注册，栅栏放最前。
3. 记进 `docs/DESIGN.md` 的路由表。

## 所用技能

开发流程用 superpowers 技能组：

- `brainstorming`：需求成形，先定目标、边界与验收。
- `writing-plans`：把设计拆成可执行任务，写进 `specs/`（只留本地）。
- `executing-plans`：在当前会话按计划逐任务实现。
- `test-driven-development`：每个功能先写失败测试，再写实现。

插件契约以 dsh-doc 技能记录的 Host 服务（`webServer`、`connection`、`tools`）、Client slot 与模块加载方式为准，不凭记忆写 API。

版式依据：

- GB/T 9704-2012《党政机关公文格式》。
- GB/T 7713.2-2022《学术论文编写规则》。
- GB/T 7714 用于参考文献著录，由作者写在正文中，插件不实现。
- MWEB 主题集（[imageslr/mweb-themes](https://github.com/imageslr/mweb-themes)）的公开设计参数，只取配色与字号阶梯。

## 禁止事项

- 不新增依赖。确需新增时，写明理由并同步 README。
- 不读写 `MD2PDF_HOME` 之外的用户状态。
- 不信任客户端传来的标识、名称、路径。
- 不在没有失败测试的情况下改渲染器或预设库。
- 不把 `specs/` 提交进仓库。
- 不把打印逻辑放进拿不到浏览器进程的沙箱；落盘等待依赖观察目标文件。
- 不在文档里写未验证的结论。工具没跑过就写「未验证」。

## 许可

MIT。贡献按同一许可接收。
