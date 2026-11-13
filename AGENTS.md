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
| 打印器两级发现 | Electron 优先省一个进程，浏览器兜底覆盖桌面版拿不到 Electron 的情况 |
| 打印后轮询落盘 | 打印进程退出早于文件写完，直接读会拿到半个或旧的 PDF |
| 每条路由先过信任栅栏 | 只有本机页面能触发打印、改预设、开文件 |
| 打开文件只认预设标识 | 路径由 Host 从标识拼出并校验，客户端传不进任意路径 |
| 预设 CSS 当数据插入并转义 `</style` | 用户样式不能跳出样式块 |

## 数据管线

### 导出

```
文件树右键 / 标签工具栏 / 路径右键 / md2pdf_export
  → POST /md2pdf/export { path }
  → 栅栏校验 → 路径规范化 → 后缀校验 → 读源文件
  → listPresets() → readPreset(selected) → 该预设的 CSS
  → renderDocument()：markdown.js → html-build.js → document.js
  → 写 HTML 到打印用临时目录
  → printPdf()：Electron 或 Chromium 无头打印
  → awaitPdf()：等文件大小/时间戳变化且出现 %%EOF
  → <源目录>/<源文件名>.pdf
  → 返回 { pdfPath, bytes, generator, math, theme, engine, printer, durationMs }
```

### 预设

```
打开设置页 → GET /md2pdf/settings
  → ensurePresets()：索引缺失则播种三个内置预设，并迁移旧的 settings.json / custom.css
  → listPresets()：逐个读 CSS，算出 builtin 与 unmodified
  → 返回 { selected, presets, builtins, css, cssPath, presetsPath, maxBytes }

卡片操作 → POST /md2pdf/presets { action }
  → runPresetAction()：read | select | save | order | delete | restore | open
  → presets.js 写 CSS 文件，再写 presets.json

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
| 打印 | Electron `printToPDF`，或 Chromium `--print-to-pdf` | pandoc 仅作可选渲染器 |
| 测试 | 纯 Node 脚本，不引测试框架 | `scripts/*.mjs`，共 147 条断言 + 46 个列表用例 |
| 文档 | Markdown + PNG | 图片由真实渲染管线生成 |

## 模块职责

```
index.js          Host 入口：五条路由、md2pdf_export 工具、失败码映射
client.js         Client 入口：菜单项、工具栏控件、设置页、对话框、文案
src/markdown.js   内置渲染器
src/math.js       temml 懒加载与降级
src/themes.js     三个内置预设的 CSS 文本与名称
src/presets.js    预设库：播种、迁移、增删改排、动作分发
src/opener.js     用系统默认程序打开文件
src/previews.js   每预设一份预览文档，边距回读
src/settings.js   用户目录解析与样式上限
src/document.js   纸质 HTML 外壳与结构样式表
src/html-build.js 正文生成与文档组装
src/export.js     导出编排与能力上报
src/pdf.js        打印器发现、无头打印、落盘等待
src/proc.js       PATH 查找与子进程执行
```

## 不变量

破坏其中任何一条，会丢掉用户数据、安全边界或一次导出。

1. 写入顺序：先 CSS 文件，后 `presets.json`。
2. 预设标识匹配 `^[a-z0-9-]{1,64}$`。`presetCssPath()` 是唯一把标识拼进路径的地方。
3. 每条路由先调 `ctx.connection.requestRejection()`，再加其它逻辑。
4. 导出目标只能是 `<源目录>/<源文件名>.pdf`。
5. 「打开」只接受索引里已知的预设标识，客户端不传路径。
6. 用户状态只写在 `MD2PDF_HOME` 之内。
7. 版本号保持在 `0.1.0`，发布时才变。
8. 运行时依赖只有 `temml`。
9. 预设 CSS 以文本插入，`</style` 必须转义。

## 命令与验证

```powershell
npm test                  # 四套断言，应为 82 / 37 / 23 / 5
node scripts/list-audit.mjs
node scripts/export-cli.mjs samples/sample.md --html out.html
node scripts/pdf-info.mjs samples/sample.pdf
```

`npm test` 是闸门，必须打印 `82/82`、`37/37`、`23/23`、`5/5`。`list-audit` 必须打印 `failures: builtin=0 markdown(old)=0 gfm+math=0`。

两条环境事实：`src/` 或 `index.js` 的改动要重启 DSH 才加载；只改客户端刷新页面即可。打印会启动 Chromium 系浏览器。

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
