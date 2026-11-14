/**
 * Client half of the md2pdf bundle.
 *
 * Four surfaces share one Host:
 *   - the right-click menu on a markdown file,
 *   - a toolbar control in the sidebar file tab's header,
 *   - a settings page for the layout preset and the user stylesheet,
 *   - the toast that reports every outcome.
 *
 * Routes are addressed relative to `document.baseURI`, the form the shipped
 * application routes use, so a deployment under a nested base path still
 * reaches the Host.
 */
window.__ModuleLoader__.load({
  id: 'dsh-md2pdf',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Routes the Host registers; the browser addresses them relatively. */
    const EXPORT_ROUTE = 'md2pdf/export'
    const PREPARE_ROUTE = 'md2pdf/prepare'
    const FINISH_ROUTE = 'md2pdf/finish'
    const OPEN_ROUTE = 'md2pdf/open'
    const CAPABILITY_ROUTE = 'md2pdf/capability'
    const SETTINGS_ROUTE = 'md2pdf/settings'
    const PRESETS_ROUTE = 'md2pdf/presets'
    const PREVIEWS_ROUTE = 'md2pdf/previews'
    const NEXT_JOB_ROUTE = 'md2pdf/print-jobs/next'
    const FAIL_JOB_ROUTE = 'md2pdf/print-jobs/fail'

    /** The print guest must attach and become ready before this deadline. */
    const PRINT_ATTACH_TIMEOUT_MS = 20000
    /** A slow loopback page may not take longer than this to finish loading. */
    const PRINT_LOAD_TIMEOUT_MS = 60000
    /** Bounds the whole guest-side print and the finish request. */
    const PRINT_RUN_TIMEOUT_MS = 120000
    /** Images may not hold the print past this; a failed decode never blocks. */
    const IMAGE_DECODE_TIMEOUT_MS = 3000

    /** Failure codes for which `auto` may retry through the browser fallback. */
    const FALLBACK_CODES = new Set([
      'client-required',
      'no-printer',
      'print-failed',
      'job-timeout',
      'asset-server-failed',
    ])

    /** How long one broker long poll holds its request open. */
    const BROKER_WAIT_SECONDS = 20

    /** How long the broker waits after a transport or Host error. */
    const BROKER_RETRY_MS = 1000

    /**
     * Reasons the broker fail route accepts. The list mirrors the Host's
     * allowlist; an unexpected client code is reported as `client-error`.
     */
    const BROKER_FAILURE_REASONS = new Set([
      'client-error',
      'client-required',
      'no-printer',
      'print-failed',
      'pdf-invalid',
      'file-busy',
      'job-timeout',
      'asset-server-failed',
    ])

    /** A4 at 96 dpi: the width every preview is laid out at before scaling. */
    const PAGE_WIDTH = 794
    const PAGE_HEIGHT = 1123
    /** Preset card miniature. */
    const CARD_WIDTH = 166
    const CARD_HEIGHT = 104
    /** Preview of the saved stylesheet, shown large enough to read. */
    const PREVIEW_WIDTH = 552
    const PREVIEW_HEIGHT = 224

    /** Page values the Host accepts; mirrors src/document-config.js. */
    const PAGE_SIZES = ['A3', 'A4', 'A5', 'Letter', 'Legal']
    const PAGE_DEFAULTS = { size: 'A4', marginMm: 18, fontSize: 15, landscape: false }
    const PAGE_MARGIN_RANGE = { min: 0, max: 60 }
    const PAGE_FONT_RANGE = { min: 8, max: 24 }

    /** Source suffixes this plugin exports. */
    const MARKDOWN_PATTERN = /\.(md|markdown|mdown|mkd|mdwn|mdx)$/i

    /** Menu glyph key registered into the shared icon seat. */
    const ICON_KEY = 'md2pdf.pdf'

    /** Nav position of the settings page, after the shipped sections. */
    const SETTINGS_ORDER = 160

    /** Example the empty editor shows, so the format needs no explanation. */
    const CSS_PLACEHOLDER = [
      '/* 追加在内置样式之后，可覆盖内置规则 */',
      'body { font-size: 16px; line-height: 1.8; }',
      'h1, h2 { color: #123a5e; }',
      '@page { margin: 22mm 18mm; }',
    ].join('\n')

    /** Client-side copy; the Host's display metadata lives in locale/*.json. */
    const DICTIONARIES = {
      en: {
        'menu.export': 'Export to PDF',
        'menu.unavailable': 'Export to PDF (no printer available)',
        'tool.export': 'Export to PDF',
        'tool.busy': 'Exporting to PDF…',
        'tool.failed': 'Export failed',
        'toast.ok': 'PDF written to {path} (engine: {engine})',
        'toast.warnings': 'warnings: {message}',
        'toast.failed': 'PDF export failed: {message}',
        'toast.previewUnavailable': 'the DSH preview could not open; open the PDF from {path}',
        'toast.previewFallback': 'the DSH preview was unavailable; opened the PDF with the system default app',
        'toast.openFailed': 'the PDF was written, but the system default app could not open it: {message}',
        'engine.dsh': 'DSH',
        'settings.label': 'dsh-md2pdf',
        'settings.heading': 'Printed page styles',
        'settings.hint': 'A preset is one stylesheet. Click a card to use it, edit it below, or add your own. A change applies to the next export with no restart.',
        'settings.engine': 'Print engine: {engine}',
        'settings.engineChecking': 'checking…',
        'settings.engineDsh': 'DSH built-in',
        'settings.engineBrowser': '{name} (browser fallback)',
        'settings.engineNone': 'none',
        'settings.pageHeading': 'Page',
        'settings.pageHint': 'The page box for the preset in use. Only fields you change are stored; an empty field keeps the preset stylesheet in charge.',
        'settings.pageSize': 'Paper size',
        'settings.pageOrientation': 'Orientation',
        'settings.pageMargin': 'Margin (mm)',
        'settings.pageFontSize': 'Body font size (px)',
        'settings.pageDefault': 'Preset default',
        'settings.pagePortrait': 'Portrait',
        'settings.pageLandscape': 'Landscape',
        'settings.pageSave': 'Save page',
        'settings.pageReset': 'Reset page',
        'settings.pageSaved': 'Page settings saved.',
        'settings.pageResetDone': 'Page settings reset.',
        'settings.pageSaveFailed': 'Could not save page settings: {message}',
        'settings.pageResetFailed': 'Could not reset page settings: {message}',
        'settings.pageInvalid': 'Page settings are out of range.',
        'settings.pageUnsupported': 'This preset uses an unsupported @page form ({detail}); printing uses one uniform page box.',
        'settings.fontHeading': 'Fonts',
        'settings.fontHint': 'Families declared by the preset in use. Availability is checked in this window; a @font-face family stays unverified.',
        'settings.fontEmpty': 'The selected preset declares no specific font family.',
        'settings.fontFamily': 'Family',
        'settings.fontCjk': 'CJK',
        'settings.fontLatin': 'Latin',
        'settings.fontState': 'State',
        'settings.fontAvailable': 'available',
        'settings.fontMissingCjk': 'missing CJK',
        'settings.fontMissingLatin': 'missing Latin',
        'settings.fontMissingBoth': 'missing CJK and Latin',
        'settings.fontUnverified': 'unverified',
        'settings.fontsSummary': 'Available {available}, missing CJK {cjk}, missing Latin {latin}, unverified {unverified}.',
        'settings.fontFaceNote': 'A @font-face family is marked unverified because this window has not confirmed it is loaded.',
        'settings.presetLabel': 'Presets',
        'settings.selected': 'In use: {name}',
        'settings.editing': 'Editing: {name}',
        'settings.editingNew': 'Editing: new preset',
        'settings.dirty': 'unsaved',
        'settings.save': 'Save',
        'settings.create': 'New',
        'settings.reload': 'Reload',
        'settings.moveUp': 'Move up',
        'settings.moveDown': 'Move down',
        'settings.restore': 'Restore built-in presets',
        'settings.open': 'Open',
        'settings.saveTitle': 'Save preset',
        'settings.saveNameLabel': 'Preset name',
        'settings.saveHint': 'Saving under a name that already exists asks before replacing it.',
        'settings.overwriteTitle': 'Name already used',
        'settings.overwriteBody': 'A preset named “{name}” exists. Replace its stylesheet?',
        'settings.deleteTitle': 'Delete preset',
        'settings.deleteBody': 'Delete “{name}”? This cannot be undone.',
        'settings.cancel': 'Cancel',
        'settings.remove': 'Delete',
        'settings.confirmSave': 'Save',
        'settings.overwrite': 'Replace',
        'settings.applied': 'Using {name}.',
        'settings.applyFailed': 'Could not switch preset: {message}',
        'settings.saved': 'Saved {name}.',
        'settings.created': 'Created {name}.',
        'settings.deleted': 'Deleted {name}.',
        'settings.saveFailed': 'Save failed: {message}',
        'settings.deleteFailed': 'Delete failed: {message}',
        'settings.orderFailed': 'Could not reorder: {message}',
        'settings.restored': 'Restored the built-in presets.',
        'settings.restoreFailed': 'Could not restore: {message}',
        'settings.opened': 'Opened {path}.',
        'settings.openFailed': 'Could not open the file: {message}',
        'settings.loadFailed': 'Could not read the presets: {message}',
        'settings.emptyName': 'A preset name is required.',
        'settings.limit': 'Stylesheet limit {bytes} bytes.',
        'settings.path': 'Stylesheet: {path}',
        'settings.dir': 'Preset folder: {path}',
        'settings.preview': 'Preview of the selected preset',
        'settings.previewHint': 'The first page of the sample document, rendered with the preset in use.',
        'settings.editPreset': 'Edit {name}',
        'settings.removePreset': 'Delete {name}',
        'settings.edit': 'Edit',
        'settings.applyPreset': 'Use {name}',
        'settings.gbTag': 'GB',
        'settings.placeholder': 'body { font-size: 16px; }',
      },
      zh: {
        'menu.export': '导出为 PDF',
        'menu.unavailable': '导出为 PDF（无可用打印器）',
        'tool.export': '导出为 PDF',
        'tool.busy': '正在导出 PDF…',
        'tool.failed': '导出失败',
        'toast.ok': 'PDF 已输出到 {path}（引擎：{engine}）',
        'toast.warnings': '警告：{message}',
        'toast.failed': '导出 PDF 失败：{message}',
        'toast.previewUnavailable': 'DSH 预览未能打开；请从 {path} 打开 PDF',
        'toast.previewFallback': 'DSH 预览不可用；已用系统默认程序打开 PDF',
        'toast.openFailed': 'PDF 已写出，但系统默认程序未能打开：{message}',
        'engine.dsh': 'DSH 内置',
        'settings.label': 'dsh-md2pdf',
        'settings.heading': '打印样式',
        'settings.hint': '一个预设就是一份样式表。点卡片应用到导出，点「编辑」改它的样式，也能新建、排序、删除。改动在下次导出生效，不需要重启。',
        'settings.engine': '打印引擎：{engine}',
        'settings.engineChecking': '检查中…',
        'settings.engineDsh': 'DSH 内置',
        'settings.engineBrowser': '{name}（浏览器回退）',
        'settings.engineNone': '无',
        'settings.pageHeading': '页面',
        'settings.pageHint': '当前预设的页面设置。只保存你改动过的字段；留空的字段由预设样式决定。',
        'settings.pageSize': '纸张',
        'settings.pageOrientation': '方向',
        'settings.pageMargin': '页边距（mm）',
        'settings.pageFontSize': '正文字号（px）',
        'settings.pageDefault': '预设默认',
        'settings.pagePortrait': '纵向',
        'settings.pageLandscape': '横向',
        'settings.pageSave': '保存页面',
        'settings.pageReset': '重置页面',
        'settings.pageSaved': '页面设置已保存。',
        'settings.pageResetDone': '页面设置已重置。',
        'settings.pageSaveFailed': '保存页面设置失败：{message}',
        'settings.pageResetFailed': '重置页面设置失败：{message}',
        'settings.pageInvalid': '页面设置的取值超出范围。',
        'settings.pageUnsupported': '此预设使用了不支持的 @page 写法（{detail}）；打印按统一页框处理。',
        'settings.fontHeading': '字体',
        'settings.fontHint': '当前预设声明的字体族。可用性在本窗口检测；@font-face 自定义字体标为未验证。',
        'settings.fontEmpty': '当前预设未声明具体字体族。',
        'settings.fontFamily': '字体',
        'settings.fontCjk': '汉字',
        'settings.fontLatin': '拉丁',
        'settings.fontState': '状态',
        'settings.fontAvailable': '可用',
        'settings.fontMissingCjk': '缺汉字',
        'settings.fontMissingLatin': '缺拉丁',
        'settings.fontMissingBoth': '缺汉字和拉丁',
        'settings.fontUnverified': '未验证',
        'settings.fontsSummary': '可用 {available}，缺汉字 {cjk}，缺拉丁 {latin}，未验证 {unverified}。',
        'settings.fontFaceNote': '@font-face 声明的字体在本窗口尚未确认加载，因此标为未验证。',
        'settings.presetLabel': '版式预设',
        'settings.selected': '当前使用：{name}',
        'settings.editing': '正在编辑：{name}',
        'settings.editingNew': '正在编辑：新预设',
        'settings.dirty': '未保存',
        'settings.save': '保存',
        'settings.create': '新建',
        'settings.reload': '重新载入',
        'settings.moveUp': '上移',
        'settings.moveDown': '下移',
        'settings.restore': '恢复内置预设',
        'settings.open': '打开',
        'settings.saveTitle': '保存预设',
        'settings.saveNameLabel': '预设名称',
        'settings.saveHint': '用已有名称保存时会先确认是否覆盖。',
        'settings.overwriteTitle': '名称已存在',
        'settings.overwriteBody': '已有同名预设「{name}」。覆盖它的样式？',
        'settings.deleteTitle': '删除预设',
        'settings.deleteBody': '删除「{name}」？此操作不可撤销。',
        'settings.cancel': '取消',
        'settings.remove': '删除',
        'settings.confirmSave': '保存',
        'settings.overwrite': '覆盖',
        'settings.applied': '已应用「{name}」。',
        'settings.applyFailed': '切换预设失败：{message}',
        'settings.saved': '已保存「{name}」。',
        'settings.created': '已新建「{name}」。',
        'settings.deleted': '已删除「{name}」。',
        'settings.saveFailed': '保存失败：{message}',
        'settings.deleteFailed': '删除失败：{message}',
        'settings.orderFailed': '排序失败：{message}',
        'settings.restored': '已补回内置预设。',
        'settings.restoreFailed': '恢复失败：{message}',
        'settings.opened': '已打开 {path}。',
        'settings.openFailed': '打开文件失败：{message}',
        'settings.loadFailed': '读取预设失败：{message}',
        'settings.emptyName': '预设名称不能为空。',
        'settings.limit': '样式上限 {bytes} 字节。',
        'settings.path': '样式文件：{path}',
        'settings.dir': '预设目录：{path}',
        'settings.preview': '当前预设的效果预览',
        'settings.previewHint': '下面是用当前使用的预设渲染出的页面首屏。',
        'settings.editPreset': '编辑「{name}」',
        'settings.removePreset': '删除「{name}」',
        'settings.edit': '编辑',
        'settings.applyPreset': '使用「{name}」',
        'settings.gbTag': '国标',
        'settings.placeholder': 'body { font-size: 16px; }',
      },
    }

    /** Fill `{name}` placeholders without a formatting dependency. */
    function format(template, variables) {
      if (variables === undefined) return template
      return template.replace(/\{(\w+)\}/g, (match, name) => (
        Object.prototype.hasOwnProperty.call(variables, name) ? String(variables[name]) : match
      ))
    }

    /** Coerce a thrown value into a readable message. */
    function messageOf(error) {
      return error instanceof Error ? error.message : String(error)
    }

    /** Whether one path names a markdown source. */
    function isMarkdownPath(path) {
      return typeof path === 'string' && MARKDOWN_PATTERN.test(path)
    }

    /** One CSS length in millimetres, or null for an unsupported unit. */
    function lengthInMm(text) {
      const match = /^(\d+(?:\.\d+)?|\.\d+)(mm|cm|in|pt|px)$/i.exec(String(text).trim())
      if (match === null) return null
      const unit = match[2].toLowerCase()
      const factor = unit === 'mm'
        ? 1
        : unit === 'cm'
          ? 10
          : unit === 'in'
            ? 25.4
            : unit === 'pt' ? 25.4 / 72 : 25.4 / 96
      return Math.round(Number.parseFloat(match[1]) * factor * 100) / 100
    }

    /** The declarations of the last @page block, or null. */
    function lastPageDeclarations(css) {
      let block = null
      const pattern = /@page\b[^{]*\{([^}]*)\}/gi
      for (const match of String(css ?? '').matchAll(pattern)) block = match[1]
      return block
    }

    /**
     * Read the paper size and orientation a preset stylesheet declares.
     * A declared value the form cannot represent stays null.
     */
    function presetPageBox(css) {
      const declarations = lastPageDeclarations(css)
      const box = { declared: false, size: null, landscape: null }
      if (declarations === null) return box
      const match = /(?:^|;)\s*size\s*:\s*([^;]+)/i.exec(declarations)
      if (match === null) return box
      box.declared = true
      for (const token of match[1].trim().split(/\s+/)) {
        const size = PAGE_SIZES.find(known => known.toLowerCase() === token.toLowerCase())
        if (size !== undefined) box.size = size
        if (/^landscape$/i.test(token)) box.landscape = true
        if (/^portrait$/i.test(token)) box.landscape = false
      }
      return box
    }

    /**
     * Read the uniform page margin a preset stylesheet declares.
     * A non-uniform shorthand is a real page box the single margin field cannot
     * represent, so it reports null instead of one of its sides.
     */
    function presetMargin(css) {
      const declarations = lastPageDeclarations(css)
      if (declarations === null) return { declared: false, mm: null }
      const match = /(?:^|;)\s*margin\s*:\s*([^;]+)/i.exec(declarations)
      if (match === null) return { declared: false, mm: null }
      const values = match[1].trim().split(/\s+/).map(lengthInMm)
      if (values.length < 1 || values.length > 4 || values.some(value => value === null)) {
        return { declared: true, mm: null }
      }
      return { declared: true, mm: values.every(value => value === values[0]) ? values[0] : null }
    }

    /** Read the root body font size a preset stylesheet declares, in px. */
    function presetFontSize(css) {
      const text = String(css ?? '')
      const rule = /([^{}]+)\{([^{}]*)\}/g
      let result = { declared: false, px: null }
      for (const match of text.matchAll(rule)) {
        const selector = match[1].trim()
        if (!selector.split(',').some(part => part.trim().toLowerCase() === 'body')) continue
        const size = /(?:^|;)\s*font-size\s*:\s*([^;]+)/i.exec(match[2])
        if (size === null) continue
        const token = size[1].trim()
        const px = /^(\d+(?:\.\d+)?|\.\d+)px$/i.exec(token)
        const pt = /^(\d+(?:\.\d+)?|\.\d+)pt$/i.exec(token)
        const mm = /^(\d+(?:\.\d+)?|\.\d+)mm$/i.exec(token)
        if (px !== null) {
          result = { declared: true, px: Math.round(Number.parseFloat(px[1]) * 10) / 10 }
        } else if (pt !== null) {
          result = { declared: true, px: Math.round((Number.parseFloat(pt[1]) * 4 / 3) * 10) / 10 }
        } else if (mm !== null) {
          result = { declared: true, px: Math.round((Number.parseFloat(mm[1]) * 96 / 25.4) * 10) / 10 }
        } else {
          result = { declared: true, px: null }
        }
      }
      return result
    }

    /**
     * Resolve the values the preset stylesheet alone produces. A null field
     * means the stylesheet declares a value the single-field form cannot
     * represent; the plugin's base sheet supplies the rest.
     */
    function basePageOf(css) {
      const box = presetPageBox(css)
      const margin = presetMargin(css)
      const font = presetFontSize(css)
      const size = box.declared ? box.size : PAGE_DEFAULTS.size
      const landscape = box.landscape !== null
        ? box.landscape
        : box.declared && box.size === null ? null : PAGE_DEFAULTS.landscape
      return {
        size,
        marginMm: margin.declared ? margin.mm : PAGE_DEFAULTS.marginMm,
        fontSize: font.declared ? font.px : PAGE_DEFAULTS.fontSize,
        landscape,
      }
    }

    /**
     * Resolve the values the page form shows: saved metadata first, then the
     * preset stylesheet. The stylesheet-only values stay the comparison base
     * for saving, so re-saving an existing override does not drop it.
     */
    function effectivePageOf(css, stored) {
      const base = basePageOf(css)
      const saved = stored !== null && typeof stored === 'object' ? stored : {}
      return {
        size: typeof saved.size === 'string' ? saved.size : base.size,
        marginMm: typeof saved.marginMm === 'number' ? saved.marginMm : base.marginMm,
        fontSize: typeof saved.fontSize === 'number' ? saved.fontSize : base.fontSize,
        landscape: typeof saved.landscape === 'boolean' ? saved.landscape : base.landscape,
      }
    }

    /** Turn an effective page into the strings the form fields hold. */
    function pageFormOf(page) {
      return {
        size: page.size === null ? '' : page.size,
        landscape: page.landscape === null ? '' : page.landscape ? 'landscape' : 'portrait',
        marginMm: page.marginMm === null ? '' : String(page.marginMm),
        fontSize: page.fontSize === null ? '' : String(page.fontSize),
      }
    }

    /**
     * Build the page override to store from the current form.
     *
     * Only fields that differ from what the preset already produces are sent,
     * so changing the font size never writes a default margin over a gongwen
     * 37/26/35/28 mm page box.
     */
    function pageOverrideOf(draft, base) {
      const page = {}
      if (draft.size !== '' && draft.size !== base.size) page.size = draft.size
      const orientation = draft.landscape === 'landscape'
        ? true
        : draft.landscape === 'portrait' ? false : null
      if (orientation !== null && orientation !== base.landscape) page.landscape = orientation
      if (draft.marginMm !== '') {
        const margin = Number(draft.marginMm)
        if (Number.isFinite(margin) && margin !== base.marginMm) page.marginMm = margin
      }
      if (draft.fontSize !== '') {
        const font = Number(draft.fontSize)
        if (Number.isFinite(font) && font !== base.fontSize) page.fontSize = font
      }
      return page
    }

    /** Whether a form value is outside the range the Host accepts. */
    function pageDraftInvalid(draft) {
      const margin = draft.marginMm === '' ? null : Number(draft.marginMm)
      if (margin !== null
        && (!Number.isFinite(margin) || margin < PAGE_MARGIN_RANGE.min || margin > PAGE_MARGIN_RANGE.max)) {
        return true
      }
      const font = draft.fontSize === '' ? null : Number(draft.fontSize)
      return font !== null
        && (!Number.isFinite(font) || font < PAGE_FONT_RANGE.min || font > PAGE_FONT_RANGE.max)
    }

    /**
     * Name the @page forms the unified page box cannot honour.
     *
     * v2 prints one page box. Pseudo pages and named pages cannot be expressed,
     * and longhand margins or `!important` inside the block cannot be folded
     * into the single `size`/`margin` pair.
     */
    function unsupportedPageForms(css) {
      const forms = new Set()
      const pattern = /@page\b([^{]*)\{([^}]*)\}/gi
      for (const match of String(css ?? '').matchAll(pattern)) {
        const selector = match[1].trim()
        if (selector !== '') forms.add(`@page ${selector}`)
        if (/\bmargin-(?:top|right|bottom|left)\s*:/i.test(match[2])) forms.add('margin longhand')
        if (/!important/i.test(match[2])) forms.add('!important')
      }
      return [...forms]
    }

    /** Candidate URLs for one Host route: document-relative first, then root. */
    function routeUrls(route) {
      const urls = []
      try {
        urls.push(new URL(route, document.baseURI).href)
      } catch {
        // A document without a usable base falls through to the root form.
      }
      urls.push(`/${route}`)
      return [...new Set(urls)]
    }

    /**
     * Post one request to the first route form that answers.
     * @param route - registered route path without its leading slash.
     * @param init - fetch options.
     * @returns the first non-404 response and its parsed JSON body.
     */
    async function requestRoute(route, init) {
      let lastError = null
      for (const url of routeUrls(route)) {
        let response
        try {
          response = await fetch(url, init)
        } catch (error) {
          lastError = error
          continue
        }
        if (response.status === 404) {
          lastError = new Error(`route not found: ${url}`)
          continue
        }
        const payload = await response.json().catch(() => null)
        return { response, payload }
      }
      throw lastError ?? new Error(`route unreachable: ${route}`)
    }

    /** Read the Host's printer capability once per page. */
    let capability = null
    /** The resolved capability, so the synchronous engine status can read it. */
    let capabilityValue = null
    function loadCapability() {
      capability ??= requestRoute(CAPABILITY_ROUTE, { headers: { accept: 'application/json' } })
        .then(({ payload }) => {
          capabilityValue = payload ?? { engine: null }
          return capabilityValue
        })
        .catch(() => {
          capabilityValue = { engine: null }
          return capabilityValue
        })
      return capability
    }

    /**
     * Short name of the browser the Host would use for the fallback.
     * @param path - executable path resolved by the Host, or null.
     * @returns a label safe for the settings page.
     */
    function browserEngineName(path) {
      const name = typeof path === 'string' ? path.split(/[\\/]/).pop() ?? '' : ''
      if (/edge/i.test(name)) return 'Edge'
      if (/chrome/i.test(name)) return 'Chrome'
      if (/chromium/i.test(name)) return 'Chromium'
      if (/brave/i.test(name)) return 'Brave'
      return 'browser'
    }

    /**
     * Read the configured print engine. An unknown or absent value means auto.
     * @param ready - the capability answer, or null.
     * @returns `dsh`, `browser`, or `auto`.
     */
    function printEngineOf(ready) {
      const value = ready !== null && typeof ready === 'object' ? ready.printEngine : undefined
      return value === 'dsh' || value === 'browser' ? value : 'auto'
    }

    /**
     * Read the configured post-export action. An unknown or absent value means
     * the DSH preview, which is the default the design asks for.
     * @param ready - the capability answer, or null.
     * @returns `dsh`, `system`, or `none`.
     */
    function afterExportOf(ready) {
      const value = ready !== null && typeof ready === 'object' ? ready.afterExport : undefined
      return value === 'system' || value === 'none' ? value : 'dsh'
    }

    /**
     * Build one failure carrying a Host-style code.
     * @param code - stable machine code.
     * @param message - operator-facing explanation.
     * @returns the failure to throw.
     */
    function namedError(code, message) {
      const error = new Error(message)
      error.code = code
      return error
    }

    /**
     * Treat an unexpected rejection as a print failure, keeping a code the
     * fallback policy already understands.
     * @param error - the rejected value.
     * @param message - context for the failure.
     * @returns a coded failure.
     */
    function asPrintFailure(error, message) {
      if (error !== null && typeof error === 'object' && typeof error.code === 'string') return error
      return namedError('print-failed', `${message}: ${messageOf(error)}`)
    }

    /**
     * Bound one promise so a lost guest cannot stall the print queue.
     * @param task - work to bound.
     * @param ms - deadline.
     * @param message - text when the deadline passes.
     * @returns the task's value.
     */
    async function withinTimeout(task, ms, message) {
      let timer
      const deadline = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(namedError('print-failed', message)), ms)
      })
      try {
        return await Promise.race([task, deadline])
      } finally {
        clearTimeout(timer)
      }
    }

    /**
     * Wait for one webview lifecycle event before a deadline.
     * @param element - the attached webview.
     * @param name - event name.
     * @param timeoutMs - deadline for the event.
     * @param message - text when the event never arrives.
     * @param watchFailures - also stop on a main-frame load failure.
     * @returns after the event fires.
     */
    function waitForWebviewEvent(element, name, timeoutMs, message, watchFailures) {
      return new Promise((resolve, reject) => {
        let timer
        const cleanup = () => {
          clearTimeout(timer)
          element.removeEventListener(name, onEvent)
          element.removeEventListener('did-fail-load', onFail)
          element.removeEventListener('render-process-gone', onGone)
        }
        const fail = (error) => {
          cleanup()
          reject(error)
        }
        const onEvent = () => {
          cleanup()
          resolve()
        }
        const onFail = (event) => {
          if (event !== null && typeof event === 'object' && event.isMainFrame === false) return
          if (event !== null && typeof event === 'object' && event.errorCode === -3) return
          const explanation = event !== null && typeof event === 'object' && typeof event.errorDescription === 'string'
            ? event.errorDescription
            : 'load failed'
          fail(namedError('print-failed', `${message}: ${explanation}`))
        }
        const onGone = () => {
          fail(namedError('print-failed', `${message}: the print guest went away`))
        }
        timer = setTimeout(() => { fail(namedError('print-failed', message)) }, timeoutMs)
        element.addEventListener(name, onEvent)
        if (watchFailures === true) {
          element.addEventListener('did-fail-load', onFail)
          element.addEventListener('render-process-gone', onGone)
        }
      })
    }

    /**
     * Page script run inside the guest before printing. It waits for fonts and
     * for every image decode, but a failed decode never blocks and the whole
     * image wait is capped.
     */
    const RESOURCE_WAIT_SCRIPT = `(async () => {
  try {
    if (document.fonts && document.fonts.ready) await document.fonts.ready
  } catch {}
  const images = Array.from(document.images || [])
  const decoded = images.map(image => image.decode().then(() => true, () => false))
  await Promise.race([
    Promise.all(decoded),
    new Promise(resolve => setTimeout(resolve, ${IMAGE_DECODE_TIMEOUT_MS})),
  ])
  return true
})()`

    /**
     * Commit bytes through the Host's finish route. A transport failure is
     * retried once with the same token; the Host answers a replay idempotently.
     * @param finishToken - the job's write credential.
     * @param pdfBytes - bytes returned by `printToPDF`.
     * @returns the Host's finish result.
     */
    async function finishPrintedPdf(finishToken, pdfBytes) {
      let transportError = null
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let answer
        try {
          answer = await requestRoute(FINISH_ROUTE, {
            method: 'POST',
            headers: {
              'content-type': 'application/pdf',
              'x-md2pdf-token': finishToken,
            },
            body: pdfBytes,
          })
        } catch (error) {
          transportError = error
          continue
        }
        const { response, payload } = answer
        if (response.ok && payload !== null && payload.ok === true) return payload
        const code = payload !== null && typeof payload.code === 'string' ? payload.code : 'print-failed'
        const message = payload !== null && typeof payload.message === 'string'
          ? payload.message
          : `HTTP ${response.status}`
        throw namedError(code, message)
      }
      throw namedError('print-failed', `the printed PDF could not be committed: ${messageOf(transportError)}`)
    }

    /**
     * Create one detached print guest for an approved lease.
     *
     * The main process accepts the webview only when `src` is
     * `about:blank#<lease>`, the partition equals the lease partition, and the
     * lease has not been attached before. `name` is the guest's stable handle.
     * @param reservation - the bridge's lease and partition.
     * @returns a configured but unattached webview.
     */
    function createPrintWebview(reservation) {
      const element = document.createElement('webview')
      element.setAttribute('name', reservation.lease)
      element.setAttribute('partition', reservation.partition)
      element.setAttribute('src', `about:blank#${reservation.lease}`)
      element.style.display = 'block'
      element.style.width = `${PAGE_WIDTH}px`
      element.style.height = `${PAGE_HEIGHT}px`
      element.style.border = '0'
      element.style.background = '#fff'
      return element
    }

    /**
     * The Desktop browser bridge, or null outside the DSH main frame.
     * @returns the bridge that issues guest leases.
     */
    function dshBrowserBridge() {
      if (typeof window === 'undefined') return null
      try {
        if (window.top !== window.self) return null
      } catch {
        return null
      }
      const desktop = window.dshDesktop
      if (desktop === null || typeof desktop !== 'object') return null
      if (typeof desktop.protocolVersion !== 'number' || desktop.protocolVersion < 1) return null
      const bridge = desktop.browser
      if (bridge === null || typeof bridge !== 'object') return null
      if (typeof bridge.acquire !== 'function' || typeof bridge.release !== 'function') return null
      return bridge
    }

    /**
     * Whether this window can host a DSH print guest.
     *
     * The Web GUI and every non-app frame fail this check; the attached
     * element's own `printToPDF` is checked again immediately before printing.
     * @returns whether the DSH printer can be used here.
     */
    function dshPrinterAvailable() {
      if (dshBrowserBridge() === null) return false
      try {
        const probe = document.createElement('webview')
        // Electron installs the WebView API on the element prototype when the
        // window enables `webviewTag`; a bare HTMLElement has no such method.
        return typeof probe.printToPDF === 'function'
      } catch {
        return false
      }
    }

    /**
     * Engine the UI should report, honoring the configured preference.
     *
     * The capability is cached by {@link loadCapability}; callers that need the
     * first answer wait for that load and then read this synchronous status.
     * @returns `dsh`, `browser`, or `none`.
     */
    function printEngineStatus() {
      const ready = capabilityValue
      const configured = printEngineOf(ready)
      const browser = ready !== null && ready.engine !== null && ready.engine !== undefined
      const dsh = dshPrinterAvailable()
      if (configured === 'dsh') return dsh ? 'dsh' : 'none'
      if (configured === 'browser') return browser ? 'browser' : 'none'
      if (dsh) return 'dsh'
      return browser ? 'browser' : 'none'
    }

    /**
     * Whether the configured engine has a usable printer for an export.
     * @param ready - the capability answer, or null.
     * @returns whether the export action can run.
     */
    function exportAvailable(ready) {
      const configured = printEngineOf(ready)
      const browser = ready !== null && ready.engine !== null && ready.engine !== undefined
      if (configured === 'browser') return browser
      if (configured === 'dsh') return dshPrinterAvailable()
      return dshPrinterAvailable() || browser
    }

    /** The mounted PrintHost container; only the persistent slot sets it. */
    let printHostContainer = null

    /** One client print at a time; queued callers keep their order. */
    let printTail = Promise.resolve()

    /**
     * Queue one guest print behind every earlier print.
     * @param task - work to run when the queue reaches it.
     * @returns the task's result.
     */
    function enqueuePrint(task) {
      const next = printTail.then(task, task)
      printTail = next.then(() => undefined, () => undefined)
      return next
    }

    /**
     * Print one prepared job through the DSH guest and commit its bytes.
     * @param job - print URL, finish token, print options, and Session id.
     * @returns the Host's finish result.
     */
    function runPrintJob(job) {
      return enqueuePrint(async () => {
        const container = printHostContainer
        if (container === null || !container.isConnected) {
          throw namedError('client-required', 'the DSH print host is not mounted')
        }
        const bridge = dshBrowserBridge()
        if (bridge === null) throw namedError('client-required', 'this window has no DSH browser lease')
        let reservation
        try {
          reservation = await bridge.acquire(`md2pdf:${job.sessionId ?? 'ui'}`)
        } catch (error) {
          throw asPrintFailure(error, 'could not lease a print guest')
        }
        let element = null
        try {
          element = createPrintWebview(reservation)
          const ready = waitForWebviewEvent(
            element, 'dom-ready', PRINT_ATTACH_TIMEOUT_MS, 'the print guest did not become ready', true,
          )
          try {
            container.append(element)
          } catch (error) {
            ready.catch(() => {})
            throw asPrintFailure(error, 'the print guest could not be attached')
          }
          await ready
          if (typeof element.loadURL !== 'function'
            || typeof element.executeJavaScript !== 'function'
            || typeof element.printToPDF !== 'function') {
            throw namedError('no-printer', 'the attached DSH webview cannot print')
          }
          try {
            const finished = waitForWebviewEvent(
              element, 'did-finish-load', PRINT_LOAD_TIMEOUT_MS, 'the print page did not finish loading', true,
            )
            let loading
            try {
              loading = element.loadURL(job.printUrl)
            } catch (error) {
              finished.catch(() => {})
              throw error
            }
            await withinTimeout(
              Promise.all([loading, finished]),
              PRINT_LOAD_TIMEOUT_MS,
              'the print page did not load',
            )
          } catch (error) {
            throw asPrintFailure(error, 'the print page did not load')
          }
          try {
            await withinTimeout(
              element.executeJavaScript(RESOURCE_WAIT_SCRIPT),
              PRINT_RUN_TIMEOUT_MS,
              'the print page did not settle its fonts and images',
            )
          } catch (error) {
            throw asPrintFailure(error, 'the print page did not settle')
          }
          let pdfBytes
          try {
            pdfBytes = await withinTimeout(
              element.printToPDF(job.printOptions),
              PRINT_RUN_TIMEOUT_MS,
              'the print guest did not return a PDF',
            )
          } catch (error) {
            throw asPrintFailure(error, 'the print guest did not return a PDF')
          }
          if (!(pdfBytes instanceof Uint8Array) || pdfBytes.byteLength === 0) {
            throw namedError('print-failed', 'the print guest returned no bytes')
          }
          try {
            return await withinTimeout(
              finishPrintedPdf(job.finishToken, pdfBytes),
              PRINT_RUN_TIMEOUT_MS,
              'the printed PDF was not committed',
            )
          } catch (error) {
            throw asPrintFailure(error, 'the printed PDF was not committed')
          }
        } finally {
          if (element !== null) element.remove()
          try {
            await bridge.release(reservation.lease)
          } catch {
            // The guest is destroyed with the element; a failed release must not
            // replace the print failure the caller needs to see.
          }
        }
      })
    }

    /**
     * Sleep for a bounded time without blocking the page.
     * @param ms - milliseconds.
     * @returns a promise that resolves after the delay.
     */
    function sleep(ms) {
      return new Promise(resolveSleep => { setTimeout(resolveSleep, ms) })
    }

    /** The running broker poll state, or null while the print host is unmounted. */
    let brokerPoll = null

    /**
     * Tell the Host that one brokered job failed.
     *
     * Only the claimed job's finish token and a reason from the closed list
     * cross here. The Host has already ended the job in most cases, so a
     * failed report is not surfaced: there is no user action for it.
     * @param finishToken - the job's write credential.
     * @param code - the failure code the print flow produced, if any.
     * @returns a promise that resolves after the report attempt.
     */
    async function reportBrokerFailure(finishToken, code) {
      if (typeof finishToken !== 'string' || finishToken === '') return
      const reason = BROKER_FAILURE_REASONS.has(code) ? code : 'client-error'
      try {
        await requestRoute(FAIL_JOB_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ finishToken, reason }),
        })
      } catch {
        // The job is already ended or the page is unloading. A broker job has
        // no toast, so there is nothing to report and nothing to retry.
      }
    }

    /**
     * Print one job the Host brokered and commit or fail it.
     *
     * The job follows the same guest print flow as a UI export. The difference
     * is what happens after: a tool job never opens the DSH preview, never
     * runs `afterExport`, and never shows a toast.
     * @param job - the Host payload: print URL, finish token, and print options.
     * @returns a promise that resolves after the job is finished or reported.
     */
    async function runBrokerJob(job) {
      try {
        await runPrintJob({
          printUrl: job.printUrl,
          finishToken: job.finishToken,
          printOptions: job.printOptions,
          sessionId: job.sessionId,
        })
      } catch (error) {
        const code = error !== null && typeof error === 'object' ? error.code : undefined
        await reportBrokerFailure(job.finishToken, code)
      }
    }

    /**
     * Long-poll the Host for agent tool jobs until the print host unmounts.
     *
     * Polling starts only when this window has the DSH printer and the
     * configured engine allows it. A 204 means the queue is empty, so the loop
     * asks again immediately; a transport or Host error backs off briefly.
     * The in-flight request is aborted when the component is disposed.
     * @param state - the poll state with a stop flag and the current abort hook.
     * @returns a promise that resolves when polling stops.
     */
    async function runBrokerPoll(state) {
      const ready = await loadCapability()
      if (state.stopped) return
      if (printEngineOf(ready) === 'browser') return
      if (!dshPrinterAvailable()) return
      while (!state.stopped) {
        const request = new AbortController()
        state.abort = () => request.abort()
        let answer
        try {
          answer = await requestRoute(`${NEXT_JOB_ROUTE}?wait=${BROKER_WAIT_SECONDS}`, {
            headers: { accept: 'application/json' },
            signal: request.signal,
          })
        } catch {
          state.abort = null
          if (state.stopped) return
          await sleep(BROKER_RETRY_MS)
          continue
        }
        state.abort = null
        if (state.stopped) return
        const { response, payload } = answer
        if (response.status === 204) continue
        if (!response.ok
          || payload === null
          || typeof payload.printUrl !== 'string'
          || typeof payload.finishToken !== 'string') {
          await sleep(BROKER_RETRY_MS)
          continue
        }
        await runBrokerJob(payload)
      }
    }

    /**
     * Start the broker poll if it is not already running.
     */
    function startPrintBroker() {
      if (brokerPoll !== null) return
      const state = { stopped: false, abort: null }
      brokerPoll = state
      runBrokerPoll(state)
        .catch(() => {
          // A failed capability read must not leave a dead loop registered.
          if (brokerPoll === state) brokerPoll = null
        })
    }

    /**
     * Stop the broker poll and abort the request it is holding.
     */
    function stopPrintBroker() {
      const state = brokerPoll
      brokerPoll = null
      if (state === null) return
      state.stopped = true
      if (typeof state.abort === 'function') state.abort()
      state.abort = null
    }

    /**
     * Run one export through the Host's browser fallback.
     * @param input - source path and the Session that reported it.
     * @returns the Host's answer, or a named failure.
     */
    async function exportPdf(input) {
      const body = { path: input.path }
      if (typeof input.sessionId === 'string' && input.sessionId !== '') body.sessionId = input.sessionId
      if (input.page !== undefined) body.page = input.page
      const { response, payload } = await requestRoute(EXPORT_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (response.ok && payload !== null && payload.ok === true) return { ok: true, result: payload }
      const message = payload !== null && typeof payload.message === 'string'
        ? payload.message
        : `HTTP ${response.status}`
      return { ok: false, code: payload !== null ? payload.code : undefined, message }
    }

    /** Styles shared by the toolbar control and the settings page. */
    const STYLES = `
.md2pdf-tool {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  margin: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #5b6470);
  cursor: pointer;
  flex: 0 0 auto;
}
.md2pdf-tool:hover { background: var(--dsw-alias-bg-layer-2, rgba(120, 132, 148, 0.14)); color: var(--dsw-alias-label-primary, #1c1f23); }
.md2pdf-tool[data-phase="busy"] { cursor: progress; opacity: 0.65; }
.md2pdf-tool[data-phase="error"] { color: var(--dsw-alias-state-error-primary, #c0392b); }
.md2pdf-tool:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #2f6fa8); outline-offset: 1px; }
.md2pdf-glyph { display: block; }
.md2pdf-spin { animation: md2pdf-rotate 0.9s linear infinite; transform-origin: 50% 50%; }
@keyframes md2pdf-rotate { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .md2pdf-spin { animation-duration: 2.4s; } }

.md2pdf-section { display: flex; flex-direction: column; gap: 12px; width: 100%; max-width: 560px; min-width: 0; box-sizing: border-box; }
.md2pdf-section * { box-sizing: border-box; }
.md2pdf-print-host {
  position: fixed;
  top: 0;
  left: -10000px;
  width: 794px;
  height: 1123px;
  overflow: hidden;
  opacity: 0;
  pointer-events: none;
  z-index: 0;
}
.md2pdf-heading { margin: 0; font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary, #1c1f23); }
.md2pdf-hint { margin: 0; font-size: 12px; line-height: 1.65; color: var(--dsw-alias-label-secondary, #6b7280); }
.md2pdf-cards { display: flex; flex-wrap: wrap; gap: 10px; }
.md2pdf-card {
  position: relative;
  width: 178px;
  height: 162px;
  padding: 5px;
  border: 1px solid var(--dsw-alias-border-l2, #d7dce3);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1, #fff);
}
.md2pdf-card[data-selected="true"] {
  border-color: var(--dsw-alias-brand-primary, #2f6fa8);
  box-shadow: 0 0 0 2px var(--dsw-alias-brand-primary, #2f6fa8);
}
.md2pdf-card-apply {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 4px;
  width: 100%;
  height: 100%;
  padding: 0 0 24px;
  margin: 0;
  border: 0;
  border-radius: 8px;
  background: none;
  font: inherit;
  text-align: center;
  cursor: pointer;
}
.md2pdf-card-apply:disabled { opacity: 0.6; cursor: default; }
.md2pdf-card-apply:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #2f6fa8); outline-offset: 2px; }
.md2pdf-card-label {
  font-size: 12px;
  line-height: 1.3;
  color: var(--dsw-alias-label-primary, #1c1f23);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.md2pdf-card-tag {
  position: absolute;
  top: 9px;
  left: 9px;
  padding: 0 4px;
  border-radius: 3px;
  background: #e8f0fe;
  color: #2f6fa8;
  font-size: 10px;
  line-height: 16px;
}
.md2pdf-card-edit {
  position: absolute;
  left: 5px;
  right: 5px;
  bottom: 5px;
  height: 15%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: var(--dsw-alias-brand-primary, #2f6fa8);
  color: #fff;
  font: inherit;
  font-size: 11px;
  cursor: pointer;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.12s ease;
}
.md2pdf-card-remove {
  position: absolute;
  top: 5px;
  right: 5px;
  height: 20%;
  min-width: 42px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 8px;
  border: 0;
  border-radius: 6px;
  background: rgba(88, 96, 108, 0.62);
  color: #fff;
  cursor: pointer;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.12s ease;
}
.md2pdf-card:hover .md2pdf-card-edit,
.md2pdf-card:hover .md2pdf-card-remove,
.md2pdf-card:focus-within .md2pdf-card-edit,
.md2pdf-card:focus-within .md2pdf-card-remove { opacity: 1; pointer-events: auto; }
.md2pdf-card-edit:focus-visible,
.md2pdf-card-remove:focus-visible { outline: 2px solid #fff; outline-offset: -2px; opacity: 1; pointer-events: auto; }
@media (prefers-reduced-motion: reduce) {
  .md2pdf-card-edit, .md2pdf-card-remove { transition: none; }
}
.md2pdf-thumb {
  display: block;
  position: relative;
  overflow: hidden;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l1, #e6e9ee);
  background: #fff;
}
.md2pdf-thumb-frame {
  position: absolute;
  top: 0;
  left: 0;
  border: 0;
  background: #fff;
  transform-origin: top left;
  pointer-events: none;
}
.md2pdf-preview { display: flex; flex-direction: column; gap: 6px; }

.md2pdf-backdrop {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(15, 20, 28, 0.42);
}
.md2pdf-dialog {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 340px;
  max-width: 100%;
  padding: 16px 18px;
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1, #fff);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.24);
}
.md2pdf-dialog-title { margin: 0; font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary, #1c1f23); }
.md2pdf-dialog-body { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary, #6b7280); }
.md2pdf-dialog-input {
  width: 100%;
  height: 34px;
  padding: 0 10px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2, #d7dce3);
  background: var(--dsw-alias-bg-layer-1, #fff);
  color: var(--dsw-alias-label-primary, #1c1f23);
  font: inherit;
  font-size: 13px;
}
.md2pdf-dialog-input:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #2f6fa8); outline-offset: 1px; }
.md2pdf-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 2px; }
.md2pdf-field {
  display: block;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  min-height: 200px;
  max-height: 55vh;
  resize: vertical;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l2, #dfe4ea);
  background: var(--dsw-alias-bg-layer-1, #fff);
  color: var(--dsw-alias-label-primary, #1c1f23);
  font-family: ui-monospace, SFMono-Regular, Consolas, Menlo, monospace;
  font-size: 12px;
  line-height: 1.6;
  tab-size: 2;
}
.md2pdf-field:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #2f6fa8); outline-offset: 1px; }
.md2pdf-page-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px 12px;
}
.md2pdf-page-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.md2pdf-page-label { font-size: 12px; line-height: 1.3; color: var(--dsw-alias-label-secondary, #6b7280); }
.md2pdf-input {
  width: 100%;
  min-width: 0;
  height: 32px;
  padding: 0 8px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2, #d7dce3);
  background: var(--dsw-alias-bg-layer-1, #fff);
  color: var(--dsw-alias-label-primary, #1c1f23);
  font: inherit;
  font-size: 13px;
}
.md2pdf-input:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #2f6fa8); outline-offset: 1px; }
.md2pdf-warn { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-state-warn-primary, #b45309); }
.md2pdf-font-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.md2pdf-font-table th,
.md2pdf-font-table td {
  text-align: left;
  padding: 4px 6px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, #e6e9ee);
  vertical-align: top;
}
.md2pdf-font-table th { font-weight: 500; color: var(--dsw-alias-label-secondary, #6b7280); }
.md2pdf-font-name { word-break: break-word; }
.md2pdf-font-mark { width: 44px; text-align: center; }
.md2pdf-font-state { white-space: nowrap; }
.md2pdf-font-state[data-state="available"] { color: var(--dsw-alias-state-success-primary, #2f8f5b); }
.md2pdf-font-state[data-state="cjk"],
.md2pdf-font-state[data-state="latin"],
.md2pdf-font-state[data-state="both"] { color: var(--dsw-alias-state-warn-primary, #b45309); }
.md2pdf-font-state[data-state="face"],
.md2pdf-font-state[data-state="unknown"] { color: var(--dsw-alias-label-secondary, #6b7280); }
.md2pdf-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.md2pdf-btn {
  font: inherit;
  font-size: 13px;
  height: 32px;
  padding: 0 14px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2, #d7dce3);
  background: var(--dsw-alias-bg-layer-1, #fff);
  color: var(--dsw-alias-label-primary, #1c1f23);
  cursor: pointer;
}
.md2pdf-btn:disabled { opacity: 0.55; cursor: default; }
.md2pdf-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #2f6fa8); outline-offset: 1px; }
.md2pdf-btn[data-tone="primary"] { background: var(--dsw-alias-brand-primary, #2f6fa8); border-color: transparent; color: #fff; }
.md2pdf-btn[data-tone="danger"] {
  background: var(--dsw-alias-state-error-primary, #c0392b);
  border-color: transparent;
  color: #fff;
}
.md2pdf-flag {
  padding: 0 6px;
  border-radius: 999px;
  background: var(--dsw-alias-state-warn-primary, #b45309);
  color: #fff;
  font-size: 11px;
  line-height: 18px;
}
.md2pdf-path-row { display: flex; align-items: center; gap: 8px; }
.md2pdf-path-row .md2pdf-path { flex: 1 1 auto; min-width: 0; }
.md2pdf-status { margin: 0; font-size: 12px; line-height: 1.6; }
.md2pdf-status[data-kind="ok"] { color: var(--dsw-alias-state-success-primary, #2f8f5b); }
.md2pdf-status[data-kind="error"] { color: var(--dsw-alias-state-error-primary, #c0392b); }
.md2pdf-path { margin: 0; font-family: ui-monospace, SFMono-Regular, Consolas, Menlo, monospace; font-size: 11px; color: var(--dsw-alias-label-secondary, #6b7280); word-break: break-all; }
`

    /** One style element; duplicate instances are harmless. */
    function Styles() {
      return h('style', { 'data-md2pdf': 'styles' }, STYLES)
    }

    /**
     * A miniature of a real printable page.
     *
     * The frame renders the document at its own A4 width and scales it down, so
     * a preset keeps its line breaks, margins and type scale instead of being
     * approximated. The frame never takes pointer events: the surrounding card
     * owns the click.
     */
    function Thumb({ html, width, height }) {
      const ready = typeof html === 'string' && html !== ''
      return h('span', { className: 'md2pdf-thumb', style: { width: `${width}px`, height: `${height}px` } },
        ready
          ? h('iframe', {
            className: 'md2pdf-thumb-frame',
            srcDoc: html,
            sandbox: '',
            tabIndex: -1,
            'aria-hidden': 'true',
            style: {
              width: `${PAGE_WIDTH}px`,
              height: `${PAGE_HEIGHT}px`,
              transform: `scale(${width / PAGE_WIDTH})`,
            },
          })
          : null)
    }

    /**
     * Ask this window whether one family covers a sample character.
     *
     * The Font Loading API is the check the design names. A window without it
     * returns null, which the table renders as unverified rather than missing.
     * @param family - one concrete family name.
     * @param sample - one character the family should cover.
     * @returns true, false, or null when this window cannot check.
     */
    function fontAvailable(family, sample) {
      if (typeof document === 'undefined') return null
      if (document.fonts === undefined || document.fonts === null) return null
      if (typeof document.fonts.check !== 'function') return null
      try {
        return document.fonts.check(`16px ${JSON.stringify(family)}`, sample) === true
      } catch {
        return null
      }
    }

    /**
     * Turn the Host's font table into rows with this window's availability.
     *
     * The Host sends `{ family, face }` only. Any availability field would be a
     * guess from the wrong machine, so the check happens here.
     * @param table - the settings route's `fonts` value.
     * @returns family rows with the CJK and Latin results.
     */
    function checkFonts(table) {
      if (!Array.isArray(table)) return []
      return table
        .filter(entry => entry !== null && typeof entry === 'object'
          && typeof entry.family === 'string' && entry.family !== '')
        .map((entry) => {
          const family = entry.family
          // A face family is not a system family; until this window proves it
          // loaded, the table must not call it available.
          if (entry.face === true) return { family, face: true, cjk: null, latin: null }
          return {
            family,
            face: false,
            cjk: fontAvailable(family, '汉'),
            latin: fontAvailable(family, 'A'),
          }
        })
    }

    /**
     * Classify one checked family for the table.
     * @param font - one row from {@link checkFonts}.
     * @returns a stable state name used by the row and the summary.
     */
    function fontState(font) {
      if (font.face === true) return 'face'
      if (font.cjk === null || font.latin === null) return 'unknown'
      if (font.cjk === false && font.latin === false) return 'both'
      if (font.cjk === false) return 'cjk'
      if (font.latin === false) return 'latin'
      return 'available'
    }

    /** One labelled control in the page settings form. */
    function PageField({ label, children }) {
      return h('label', { className: 'md2pdf-page-field' },
        h('span', { className: 'md2pdf-page-label' }, label),
        children)
    }

    /** Pencil glyph for a card's edit bar. */
    function EditGlyph() {
      return h('svg', {
        width: 11, height: 11, viewBox: '0 0 16 16', 'aria-hidden': true, focusable: 'false',
      },
      h('path', {
        d: 'M2.6 13.4h2.9l7-7-2.9-2.9-7 7v2.9z',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinejoin: 'round',
      }))
    }

    /** Trash glyph for a card's delete control. */
    function TrashGlyph() {
      return h('svg', {
        width: 12, height: 12, viewBox: '0 0 16 16', 'aria-hidden': true, focusable: 'false',
      },
      h('path', {
        d: 'M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.6 8.2h4.8l.6-8.2',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.3,
        strokeLinecap: 'round', strokeLinejoin: 'round',
      }))
    }

    /**
     * A confirmation surface for the settings page.
     *
     * The backdrop is fixed to the viewport, so the panel is not clipped by the
     * settings column. Escape and a backdrop click cancel; an input, when
     * given, takes focus so the name can be typed without another click.
     */
    function Dialog(props) {
      const inputRef = React.useRef(null)
      React.useEffect(() => {
        const field = inputRef.current
        if (field !== null) {
          field.focus()
          field.select()
        }
      }, [])
      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          props.onCancel()
        }
        document.addEventListener('keydown', onKey, true)
        return () => { document.removeEventListener('keydown', onKey, true) }
      }, [props.onCancel])
      return h('div', {
        className: 'md2pdf-backdrop',
        onClick: (event) => { if (event.target === event.currentTarget) props.onCancel() },
      },
      h('div', {
        className: 'md2pdf-dialog',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': props.title,
      },
      h('p', { className: 'md2pdf-dialog-title' }, props.title),
      props.description === undefined
        ? null
        : h('p', { className: 'md2pdf-dialog-body' }, props.description),
      props.draft === undefined
        ? null
        : h('input', {
          ref: inputRef,
          className: 'md2pdf-dialog-input',
          value: props.draft,
          'aria-label': props.draftLabel,
          onChange: (event) => { props.onDraft(event.target.value) },
          onKeyDown: (event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            props.onSubmit()
          },
        }),
      h('div', { className: 'md2pdf-dialog-actions' },
        h('button', { type: 'button', className: 'md2pdf-btn', onClick: props.onCancel }, props.cancelLabel),
        h('button', {
          type: 'button',
          className: 'md2pdf-btn',
          'data-tone': props.danger === true ? 'danger' : 'primary',
          onClick: props.onSubmit,
        }, props.submitLabel))))
    }

    /** The page-and-arrow glyph used by both the toolbar control and the menu row. */
    function DocumentGlyph({ size, spinning }) {
      return h('svg', {
        className: spinning === true ? 'md2pdf-glyph md2pdf-spin' : 'md2pdf-glyph',
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        'aria-hidden': true,
        focusable: 'false',
      },
      h('path', {
        d: 'M4 1.75h5.1L12.5 5v2.2',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.25,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }),
      h('path', {
        d: 'M4 1.75A1.25 1.25 0 0 0 2.75 3v10a1.25 1.25 0 0 0 1.25 1.25h4.4',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.25,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }),
      h('path', {
        d: 'M9 1.9V5h3.1',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.25,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }),
      h('path', {
        d: 'M11.6 9.1v4.3',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
      }),
      h('path', {
        d: 'M9.9 11.8 11.6 13.5l1.7-1.7',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }))
    }

    /**
     * The persistent print surface.
     *
     * The guest is created imperatively for one job and removed with it; this
     * component owns only the laid-out container the guest attaches to. It
     * stays offscreen with `opacity: 0` so the page keeps a real A4 box tree
     * instead of a `display: none` box that would not lay out.
     */
    function PrintHost() {
      const hostRef = React.useRef(null)
      React.useEffect(() => {
        const container = hostRef.current
        if (container === null) return undefined
        printHostContainer = container
        return () => {
          if (printHostContainer === container) printHostContainer = null
        }
      }, [])
      // The broker loop is mounted with the surface. It stops on unmount, so a
      // page refresh or a closed window leaves no poll behind.
      React.useEffect(() => {
        startPrintBroker()
        return () => { stopPrintBroker() }
      }, [])
      return h(React.Fragment, null,
        h(Styles, null),
        h('div', {
          ref: hostRef,
          className: 'md2pdf-print-host',
          'data-md2pdf': 'print-host',
          'aria-hidden': 'true',
        }))
    }

    return {
      inject: ['slots', 'contextMenus', 'locale', 'sidebarRight'],

      apply(ctx) {
        // One dictionary per registered language: the client locale service
        // takes a namespace plus a single locale in this form.
        for (const locale of Object.keys(DICTIONARIES)) {
          ctx.effect(() => ctx.locale.register('md2pdf', locale, DICTIONARIES[locale]), `md2pdf: ${locale}`)
        }

        /**
         * Translate one key through the locale service, re-binding on every
         * call so a language switch reaches an already-mounted control.
         * Falls back to the key itself when the dictionary has no entry.
         */
        const t = (key, variables) => {
          try {
            const text = ctx.locale.bind('md2pdf')(key, variables)
            return typeof text === 'string' ? format(text, variables) : key
          } catch {
            return key
          }
        }

        /**
         * Report one outcome through the shared toast.
         * @param text - localized message.
         * @param success - whether the operation succeeded.
         */
        const notify = (text, success) => {
          try {
            ctx.contextMenus.notify(text, success)
          } catch {
            // A Host without the menu surface has no toast to show; the control
            // still exposes the same outcome through its own error state.
          }
        }

        /**
         * Print one file through the DSH Chromium guest.
         * @param input - source path and render overrides.
         * @returns the Host's finish result and the job's finish token, which
         *   the viewer fallback needs to resolve the committed target.
         * @throws {Error & { code?: string }} with the Host's failure code.
         */
        async function printWithDsh(input) {
          if (!dshPrinterAvailable()) {
            throw namedError('client-required', 'the DSH printer is not available in this window')
          }
          const body = { path: input.path }
          if (typeof input.sessionId === 'string' && input.sessionId !== '') body.sessionId = input.sessionId
          if (typeof input.preset === 'string' && input.preset !== '') body.preset = input.preset
          if (input.page !== undefined) body.page = input.page
          if (input.documentConfig !== undefined) body.documentConfig = input.documentConfig
          let answer
          try {
            answer = await requestRoute(PREPARE_ROUTE, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            })
          } catch (error) {
            throw asPrintFailure(error, 'the print job could not be prepared')
          }
          const { response, payload } = answer
          if (!response.ok
            || payload === null
            || typeof payload.printUrl !== 'string'
            || typeof payload.finishToken !== 'string') {
            const code = payload !== null && typeof payload.code === 'string' ? payload.code : 'print-failed'
            const message = payload !== null && typeof payload.message === 'string'
              ? payload.message
              : `HTTP ${response.status}`
            throw namedError(code, message)
          }
          const result = await runPrintJob({
            printUrl: payload.printUrl,
            finishToken: payload.finishToken,
            printOptions: payload.printOptions,
            sessionId: input.sessionId,
          })
          return { result, finishToken: payload.finishToken }
        }

        /**
         * Pick the engine the configuration allows. `auto` retries through the
         * browser only for failures that cannot have written the target.
         * @param input - source path and render overrides.
         * @returns the Host's answer, or a named failure.
         */
        async function exportWithEngine(input) {
          const ready = await loadCapability()
          const configured = printEngineOf(ready)
          if (configured === 'browser') return exportPdf(input)
          const dsh = dshPrinterAvailable()
          if (!dsh) {
            if (configured === 'dsh') {
              return {
                ok: false,
                code: 'client-required',
                message: 'The DSH printer is not available in this window. Set printEngine to auto or browser to use a browser.',
              }
            }
            return exportPdf(input)
          }
          try {
            const printed = await printWithDsh(input)
            return { ok: true, result: printed.result, finishToken: printed.finishToken }
          } catch (error) {
            const code = error !== null && typeof error === 'object' ? error.code : undefined
            const failure = { ok: false, code, message: messageOf(error) }
            if (configured === 'dsh' || !FALLBACK_CODES.has(code)) return failure
            return exportPdf(input)
          }
        }

        /**
         * Ask the Host to open the committed PDF with the system default app.
         *
         * Only the finish token crosses from here. The Host resolves the target
         * from its own job record, so this window cannot choose a file.
         * @param finishToken - the token the Host returned from prepare.
         * @returns whether the Host started the opener.
         */
        async function openWithSystem(finishToken) {
          if (typeof finishToken !== 'string' || finishToken === '') return false
          try {
            const { response, payload } = await requestRoute(OPEN_ROUTE, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ finishToken }),
            })
            return response.ok && payload !== null && payload.ok === true
          } catch (error) {
            console.warn('md2pdf: could not ask the Host to open the PDF', error)
            return false
          }
        }

        /**
         * Fall back to the system opener when the DSH viewer is unavailable.
         * @param finishToken - the token the Host needs to resolve the PDF.
         * @param path - the written PDF, for the toast.
         * @returns the note to append to the success toast.
         */
        async function previewFallback(finishToken, path) {
          const opened = await openWithSystem(finishToken)
          return opened
            ? t('toast.previewFallback', { path })
            : t('toast.previewUnavailable', { path })
        }

        /**
         * Open the DSH viewer after a successful DSH export.
         *
         * The client opens only the address the Host computed; it never builds
         * a path. When the viewer or the address is missing, or the viewer
         * refuses the address, the Host opens the committed PDF instead.
         * @param result - the Host's finish result.
         * @param finishToken - the token the Host needs to resolve the PDF.
         * @returns a note for the success toast, or null when none is needed.
         */
        async function openPreview(result, finishToken) {
          if (afterExportOf(capabilityValue) !== 'dsh') return null
          const path = String(result?.pdfPath ?? '')
          const address = result?.previewAddress
          if (typeof address !== 'string' || address === '') {
            return previewFallback(finishToken, path)
          }
          if (ctx.sidebarRight === undefined
            || typeof ctx.sidebarRight.openResource !== 'function') {
            return previewFallback(finishToken, path)
          }
          try {
            ctx.sidebarRight.openResource(result.previewAddress)
            return null
          } catch (error) {
            // A viewer that refuses the address leaves the written PDF in
            // place; hand it to the system opener instead.
            console.warn('md2pdf: could not open the PDF preview', error)
            return previewFallback(finishToken, path)
          }
        }

        /**
         * Export one file and report the result.
         * @returns whether the Host wrote a PDF.
         */
        async function runExport(input) {
          const outcome = await exportWithEngine(input)
            .catch(error => ({ ok: false, code: error?.code, message: messageOf(error) }))
          if (outcome.ok) {
            const warnings = Array.isArray(outcome.result.warnings)
              ? outcome.result.warnings.filter(warning => typeof warning === 'string' && warning !== '')
              : []
            const engine = outcome.result.engine === 'dsh'
              ? t('engine.dsh')
              : browserEngineName(outcome.result.printer)
            let message = t('toast.ok', { path: outcome.result.pdfPath, engine })
            if (warnings.length > 0) {
              message += ` — ${t('toast.warnings', { message: warnings.join('; ') })}`
            }
            // The viewer is a DSH export surface. A browser fallback has no
            // preview address; `system` is opened by the Host during finish,
            // and a missing viewer falls back to that same Host opener.
            if (afterExportOf(capabilityValue) === 'system') {
              const opened = outcome.result.open
              if (opened !== null && typeof opened === 'object' && opened.ok === false) {
                const reason = typeof opened.message === 'string' ? opened.message : ''
                message += ` — ${t('toast.openFailed', { message: reason })}`
              }
            } else if (outcome.result.engine === 'dsh') {
              const previewNote = await openPreview(outcome.result, outcome.finishToken)
              if (previewNote !== null) message += ` — ${previewNote}`
            }
            notify(message, true)
            return true
          }
          notify(t('toast.failed', { message: outcome.message }), false)
          return false
        }

        // The context-menu glyph, so the row matches the other file actions.
        ctx.effect(() => ctx.slots.inject('contextMenu.icon', () => ctx.slots.register({
          name: 'contextMenu.icon',
          key: ICON_KEY,
        }, () => h(DocumentGlyph, { size: 16 }))), 'md2pdf: menu icon')

        // Right-click on a markdown file: in the workspace tree, on the file
        // tab's path label, or on a delivered file.
        ctx.effect(() => ctx.contextMenus.register({
          id: 'md2pdf.export',
          target: 'file',
          order: 40,
          async resolve(target) {
            if (!isMarkdownPath(target.path)) return []
            const ready = await loadCapability()
            const available = exportAvailable(ready)
            return [{
              id: 'md2pdf.export',
              label: available ? t('menu.export') : t('menu.unavailable'),
              icon: { key: ICON_KEY },
              disabled: !available,
              run: async () => {
                await runExport({ path: target.path, sessionId: target.sessionId })
              },
            }]
          },
        }), 'md2pdf: file menu')

        // One-click control beside the file tab's own tools.
        function ExportControl(props) {
          const path = props.absolutePath
          const [phase, setPhase] = React.useState('idle')
          const supported = isMarkdownPath(path)
          const start = React.useCallback(() => {
            if (phase === 'busy') return
            setPhase('busy')
            runExport({ path, sessionId: props.sessionId })
              .then(ok => { setPhase(ok ? 'idle' : 'error') })
              .catch(() => { setPhase('error') })
          }, [path, props.sessionId, phase])
          if (!supported) return null
          const label = phase === 'busy'
            ? t('tool.busy')
            : phase === 'error' ? t('tool.failed') : t('tool.export')
          return h(React.Fragment, null,
            h(Styles, null),
            h('button', {
              type: 'button',
              className: 'md2pdf-tool',
              'data-md2pdf-tool': 'export',
              'data-phase': phase,
              'aria-label': label,
              title: label,
              disabled: phase === 'busy',
              onClick: start,
            }, h(DocumentGlyph, { size: 16, spinning: phase === 'busy' })))
        }

        ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document.actions', () => ctx.slots.register({
          name: 'sidebar.right.tab.document.actions',
          id: 'md2pdf-export',
          order: 20,
        }, ExportControl)), 'md2pdf: preview control')

        // The print surface lives in the always-mounted frame overlay; it must
        // not append a webview host to document.body.
        ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'md2pdf-print-host',
        }, PrintHost)), 'md2pdf: print host')

        // Settings page: the preset library, its editor, and the dialogs that
        // confirm a save or a deletion.
        function SettingsSection() {
          const [phase, setPhase] = React.useState('loading')
          const [presets, setPresets] = React.useState([])
          const [builtins, setBuiltins] = React.useState([])
          const [selected, setSelected] = React.useState('')
          const [editingId, setEditingId] = React.useState(null)
          const [name, setName] = React.useState('')
          const [css, setCss] = React.useState('')
          const [savedCss, setSavedCss] = React.useState('')
          const [previews, setPreviews] = React.useState({})
          const [meta, setMeta] = React.useState({ cssPath: '', presetsPath: '', maxBytes: 0 })
          const [status, setStatus] = React.useState(null)
          const [engine, setEngine] = React.useState(null)
          const [busy, setBusy] = React.useState(false)
          const [dialog, setDialog] = React.useState(null)
          const [selectedCss, setSelectedCss] = React.useState('')
          const [pageBaseline, setPageBaseline] = React.useState({
            size: PAGE_DEFAULTS.size,
            marginMm: PAGE_DEFAULTS.marginMm,
            fontSize: PAGE_DEFAULTS.fontSize,
            landscape: PAGE_DEFAULTS.landscape,
          })
          const [pageDraft, setPageDraft] = React.useState(pageFormOf({
            size: PAGE_DEFAULTS.size,
            marginMm: PAGE_DEFAULTS.marginMm,
            fontSize: PAGE_DEFAULTS.fontSize,
            landscape: PAGE_DEFAULTS.landscape,
          }))
          const [pageBusy, setPageBusy] = React.useState(false)
          const [fonts, setFonts] = React.useState([])

          const nameOf = React.useCallback((id) => {
            const found = presets.find(preset => preset.id === id)
            return found === undefined ? String(id ?? '') : found.name
          }, [presets])

          /** Read the library and fold it into state. */
          const refresh = React.useCallback(async () => {
            const { response, payload } = await requestRoute(SETTINGS_ROUTE, { headers: { accept: 'application/json' } })
            if (payload === null || !Array.isArray(payload.presets)) {
              // A rejected or malformed answer must not look like an empty
              // library; name the status and the body so the cause is visible.
              const body = payload === null ? 'no JSON body' : JSON.stringify(payload).slice(0, 160)
              throw new Error(`HTTP ${response.status} ${response.url} — ${body}`)
            }
            setPresets(payload.presets)
            setBuiltins(Array.isArray(payload.builtins) ? payload.builtins : [])
            setSelected(typeof payload.selected === 'string' ? payload.selected : '')
            setMeta({
              cssPath: typeof payload.cssPath === 'string' ? payload.cssPath : '',
              presetsPath: typeof payload.presetsPath === 'string' ? payload.presetsPath : '',
              maxBytes: typeof payload.maxBytes === 'number' ? payload.maxBytes : 0,
            })
            return payload
          }, [])

          /**
           * Show the selected preset's effective page values: saved metadata
           * first, then the preset stylesheet, then the plugin defaults.
           */
          const applyPageState = React.useCallback((payload) => {
            const current = Array.isArray(payload.presets)
              ? payload.presets.find(preset => preset.id === payload.selected)
              : undefined
            const cssText = typeof payload.css === 'string' ? payload.css : ''
            // The baseline is the stylesheet alone: it is what a field must
            // differ from before it is stored, so saving an unchanged form
            // does not clear an override the form is merely displaying.
            setPageBaseline(basePageOf(cssText))
            setPageDraft(pageFormOf(effectivePageOf(cssText, current === undefined ? undefined : current.page)))
            setSelectedCss(cssText)
            // The Host sends families and whether each came from @font-face.
            // This window adds the CJK and Latin checks.
            setFonts(checkFonts(Array.isArray(payload.fonts) ? payload.fonts : []))
          }, [])

          /** Reload the library and put the selected preset back in the editor. */
          const load = React.useCallback(async () => {
            setPhase('loading')
            let lastError = null
            for (let attempt = 0; attempt < 3; attempt += 1) {
              try {
                const payload = await refresh()
                const current = payload.presets.find(preset => preset.id === payload.selected)
                setEditingId(typeof payload.selected === 'string' && payload.selected !== '' ? payload.selected : null)
                setName(current === undefined ? '' : current.name)
                setCss(typeof payload.css === 'string' ? payload.css : '')
                setSavedCss(typeof payload.css === 'string' ? payload.css : '')
                applyPageState(payload)
                setStatus(null)
                setPhase('ready')
                return
              } catch (error) {
                // A page opened while the Host is still starting can reach the
                // window before the route exists; retry briefly before giving up.
                lastError = error
                await new Promise(resolve => setTimeout(resolve, 400))
              }
            }
            setPhase('error')
            setStatus({ kind: 'error', text: t('settings.loadFailed', { message: messageOf(lastError) }) })
          }, [refresh, applyPageState])

          const loadPreviews = React.useCallback(async () => {
            try {
              const { payload } = await requestRoute(PREVIEWS_ROUTE, { headers: { accept: 'application/json' } })
              if (payload === null || typeof payload !== 'object') return
              setPreviews(typeof payload.presets === 'object' && payload.presets !== null ? { ...payload.presets } : {})
            } catch {
              // Leaves the previous thumbnails in place.
            }
          }, [])

          React.useEffect(() => {
            load()
            loadPreviews()
          }, [load, loadPreviews])

          React.useEffect(() => {
            let live = true
            loadCapability()
              .then(() => {
                if (!live) return
                const status = printEngineStatus()
                setEngine({
                  status,
                  name: status === 'browser' ? browserEngineName(capabilityValue?.engine) : '',
                })
              })
              .catch(() => {
                if (live) setEngine({ status: 'none', name: '' })
              })
            return () => { live = false }
          }, [])

          /** Run one preset action, surfacing the Host's failure code. */
          const act = React.useCallback(async (body) => {
            const { response, payload } = await requestRoute(PRESETS_ROUTE, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            })
            if (!response.ok || payload === null || payload.ok !== true) {
              const failure = new Error(payload !== null && typeof payload.message === 'string'
                ? payload.message
                : `HTTP ${response.status}`)
              failure.code = payload === null ? undefined : payload.code
              failure.details = payload === null ? undefined : payload.details
              throw failure
            }
            return payload
          }, [])

          const fail = React.useCallback((key, error) => {
            setStatus({ kind: 'error', text: t(key, { message: messageOf(error) }) })
          }, [])

          const applyPreset = React.useCallback(async (id) => {
            setBusy(true)
            try {
              await act({ action: 'select', id })
              await load()
              await loadPreviews()
              setStatus({ kind: 'ok', text: t('settings.applied', { name: nameOf(id) }) })
            } catch (error) {
              fail('settings.applyFailed', error)
            } finally {
              setBusy(false)
            }
          }, [act, load, loadPreviews, nameOf, fail])

          const editPreset = React.useCallback(async (id) => {
            try {
              const payload = await act({ action: 'read', id })
              setEditingId(id)
              setName(typeof payload.name === 'string' ? payload.name : '')
              setCss(typeof payload.css === 'string' ? payload.css : '')
              setSavedCss(typeof payload.css === 'string' ? payload.css : '')
              setStatus(null)
            } catch (error) {
              fail('settings.loadFailed', error)
            }
          }, [act, fail])

          const openPresetFile = React.useCallback(async (id) => {
            try {
              const payload = await act({ action: 'open', id })
              setStatus({ kind: 'ok', text: t('settings.opened', { path: String(payload.path ?? '') }) })
            } catch (error) {
              fail('settings.openFailed', error)
            }
          }, [act, fail])

          const savePreset = React.useCallback(async (draftName, overwrite) => {
            setBusy(true)
            try {
              const payload = await act({
                action: 'save',
                id: editingId ?? undefined,
                name: draftName,
                css,
                overwrite,
              })
              await load()
              await loadPreviews()
              setDialog(null)
              setSavedCss(css)
              setStatus({
                kind: 'ok',
                text: t(payload.created === true ? 'settings.created' : 'settings.saved',
                  { name: String(payload.name ?? draftName) }),
              })
            } catch (error) {
              if (error.code === 'name-exists') {
                setDialog({ kind: 'overwrite', draft: draftName })
              } else {
                setDialog(null)
                fail('settings.saveFailed', error)
              }
            } finally {
              setBusy(false)
            }
          }, [act, editingId, css, load, loadPreviews, fail])

          const removePreset = React.useCallback(async (id, presetName) => {
            setBusy(true)
            try {
              await act({ action: 'delete', id })
              await load()
              await loadPreviews()
              setDialog(null)
              setStatus({ kind: 'ok', text: t('settings.deleted', { name: presetName }) })
            } catch (error) {
              setDialog(null)
              fail('settings.deleteFailed', error)
            } finally {
              setBusy(false)
            }
          }, [act, load, loadPreviews, fail])

          const movePreset = React.useCallback(async (id, delta) => {
            const ids = presets.map(preset => preset.id)
            const from = ids.indexOf(id)
            const to = from + delta
            if (from < 0 || to < 0 || to >= ids.length) return
            const next = ids.slice()
            next.splice(to, 0, next.splice(from, 1)[0])
            setBusy(true)
            try {
              await act({ action: 'order', ids: next })
              await load()
              await loadPreviews()
            } catch (error) {
              fail('settings.orderFailed', error)
            } finally {
              setBusy(false)
            }
          }, [act, presets, load, loadPreviews, fail])

          const restoreShipped = React.useCallback(async () => {
            setBusy(true)
            try {
              await act({ action: 'restore' })
              await load()
              await loadPreviews()
              setStatus({ kind: 'ok', text: t('settings.restored') })
            } catch (error) {
              fail('settings.restoreFailed', error)
            } finally {
              setBusy(false)
            }
          }, [act, load, loadPreviews, fail])

          /**
           * Save one page override on the selected preset. The refresh after the
           * write updates the form baseline without discarding unsaved CSS.
           */
          const writePage = React.useCallback(async (page, doneKey, failedKey) => {
            if (selected === '') return
            setPageBusy(true)
            try {
              await act({ action: 'save-page', id: selected, page })
              const payload = await refresh()
              applyPageState(payload)
              await loadPreviews()
              setStatus({ kind: 'ok', text: t(doneKey) })
            } catch (error) {
              fail(failedKey, error)
            } finally {
              setPageBusy(false)
            }
          }, [act, applyPageState, fail, loadPreviews, refresh, selected])

          /** Store only the page fields that differ from the preset's own box. */
          const submitPage = React.useCallback(() => {
            if (pageDraftInvalid(pageDraft)) {
              setStatus({ kind: 'error', text: t('settings.pageInvalid') })
              return
            }
            writePage(pageOverrideOf(pageDraft, pageBaseline),
              'settings.pageSaved', 'settings.pageSaveFailed')
          }, [pageBaseline, pageDraft, writePage])

          /** Remove the preset's page metadata; its stylesheet decides again. */
          const resetPage = React.useCallback(() => {
            writePage({}, 'settings.pageResetDone', 'settings.pageResetFailed')
          }, [writePage])

          const startNewPreset = React.useCallback(() => {
            setEditingId(null)
            setName('')
            setCss('')
            setSavedCss('')
            setStatus(null)
          }, [])

          const dirty = css !== savedCss
          const missingBuiltin = builtins.some(id => !presets.some(preset => preset.id === id))
          const pageCssSource = editingId === selected ? css : selectedCss
          const pageForms = unsupportedPageForms(pageCssSource)
          const fontRows = fonts.map(font => ({ font, state: fontState(font) }))
          const fontStateText = (state) => {
            if (state === 'available') return t('settings.fontAvailable')
            if (state === 'cjk') return t('settings.fontMissingCjk')
            if (state === 'latin') return t('settings.fontMissingLatin')
            if (state === 'both') return t('settings.fontMissingBoth')
            return t('settings.fontUnverified')
          }
          const fontSummary = {
            available: fontRows.filter(row => row.state === 'available').length,
            cjk: fontRows.filter(row => row.state === 'cjk' || row.state === 'both').length,
            latin: fontRows.filter(row => row.state === 'latin' || row.state === 'both').length,
            unverified: fontRows.filter(row => row.state === 'face' || row.state === 'unknown').length,
          }
          const hasFaceFamily = fontRows.some(row => row.state === 'face')
          const editingLabel = editingId === null ? t('settings.editingNew') : t('settings.editing', { name })
          const engineText = engine === null
            ? t('settings.engineChecking')
            : engine.status === 'dsh'
              ? t('settings.engineDsh')
              : engine.status === 'browser'
                ? t('settings.engineBrowser', { name: engine.name })
                : t('settings.engineNone')
          const rows = []

          rows.push(h('h3', { key: 'heading', className: 'md2pdf-heading' }, t('settings.heading')))
          rows.push(h('p', { key: 'hint', className: 'md2pdf-hint' }, t('settings.hint')))
          rows.push(h('p', {
            key: 'engine',
            className: 'md2pdf-hint',
            'data-md2pdf': 'engine',
            'data-engine': engine === null ? 'checking' : engine.status,
          }, t('settings.engine', { engine: engineText })))

          if (presets.length > 0) {
            rows.push(h('div', {
              key: 'cards',
              className: 'md2pdf-cards',
              role: 'group',
              'aria-label': t('settings.presetLabel'),
            }, presets.map(preset => h('div', {
              key: preset.id,
              className: 'md2pdf-card',
              'data-preset': preset.id,
              'data-selected': selected === preset.id ? 'true' : 'false',
            },
            h('button', {
              type: 'button',
              className: 'md2pdf-card-apply',
              'data-action': 'apply',
              disabled: busy || pageBusy || phase === 'loading',
              title: preset.name,
              'aria-label': t('settings.applyPreset', { name: preset.name }),
              onClick: () => { applyPreset(preset.id) },
            },
            h(Thumb, { html: previews[preset.id], width: CARD_WIDTH, height: CARD_HEIGHT }),
            h('span', { className: 'md2pdf-card-label' }, preset.name)),
            preset.unmodified === true
              ? h('span', { className: 'md2pdf-card-tag' }, t('settings.gbTag'))
              : null,
            h('button', {
              type: 'button',
              className: 'md2pdf-card-edit',
              'data-action': 'edit',
              disabled: phase === 'loading',
              'aria-label': t('settings.editPreset', { name: preset.name }),
              onClick: () => { editPreset(preset.id) },
            }, h(EditGlyph, null), t('settings.edit')),
            h('button', {
              type: 'button',
              className: 'md2pdf-card-remove',
              'data-action': 'remove',
              disabled: busy || pageBusy || phase === 'loading',
              'aria-label': t('settings.removePreset', { name: preset.name }),
              onClick: () => { setDialog({ kind: 'delete', id: preset.id, name: preset.name }) },
            }, h(TrashGlyph, null))))))
            rows.push(h('p', { key: 'current', className: 'md2pdf-hint' },
              t('settings.selected', { name: nameOf(selected) })))
          }

          rows.push(h('h3', { key: 'page-heading', className: 'md2pdf-heading' }, t('settings.pageHeading')))
          rows.push(h('p', { key: 'page-hint', className: 'md2pdf-hint' }, t('settings.pageHint')))
          rows.push(h('div', { key: 'page-form', className: 'md2pdf-page-form', 'data-md2pdf': 'page-form' },
            h(PageField, { key: 'size', label: t('settings.pageSize') },
              h('select', {
                className: 'md2pdf-input',
                value: pageDraft.size,
                'data-md2pdf': 'page-size',
                'aria-label': t('settings.pageSize'),
                onChange: (event) => { setPageDraft(draft => ({ ...draft, size: event.target.value })) },
              }, [
                h('option', { key: 'default', value: '' }, t('settings.pageDefault')),
                ...PAGE_SIZES.map(size => h('option', { key: size, value: size }, size)),
              ])),
            h(PageField, { key: 'orientation', label: t('settings.pageOrientation') },
              h('select', {
                className: 'md2pdf-input',
                value: pageDraft.landscape,
                'data-md2pdf': 'page-orientation',
                'aria-label': t('settings.pageOrientation'),
                onChange: (event) => { setPageDraft(draft => ({ ...draft, landscape: event.target.value })) },
              }, [
                h('option', { key: 'default', value: '' }, t('settings.pageDefault')),
                h('option', { key: 'portrait', value: 'portrait' }, t('settings.pagePortrait')),
                h('option', { key: 'landscape', value: 'landscape' }, t('settings.pageLandscape')),
              ])),
            h(PageField, { key: 'margin', label: t('settings.pageMargin') },
              h('input', {
                type: 'number',
                className: 'md2pdf-input',
                min: PAGE_MARGIN_RANGE.min,
                max: PAGE_MARGIN_RANGE.max,
                step: '0.5',
                value: pageDraft.marginMm,
                placeholder: t('settings.pageDefault'),
                'data-md2pdf': 'page-margin',
                'aria-label': t('settings.pageMargin'),
                onChange: (event) => { setPageDraft(draft => ({ ...draft, marginMm: event.target.value })) },
              })),
            h(PageField, { key: 'font', label: t('settings.pageFontSize') },
              h('input', {
                type: 'number',
                className: 'md2pdf-input',
                min: PAGE_FONT_RANGE.min,
                max: PAGE_FONT_RANGE.max,
                step: '0.5',
                value: pageDraft.fontSize,
                placeholder: t('settings.pageDefault'),
                'data-md2pdf': 'page-font',
                'aria-label': t('settings.pageFontSize'),
                onChange: (event) => { setPageDraft(draft => ({ ...draft, fontSize: event.target.value })) },
              }))))
          rows.push(h('div', { key: 'page-actions', className: 'md2pdf-row' },
            h('button', {
              type: 'button',
              className: 'md2pdf-btn',
              'data-tone': 'primary',
              'data-md2pdf-action': 'save-page',
              disabled: busy || pageBusy || phase === 'loading' || selected === '',
              onClick: submitPage,
            }, t('settings.pageSave')),
            h('button', {
              type: 'button',
              className: 'md2pdf-btn',
              'data-md2pdf-action': 'reset-page',
              disabled: busy || pageBusy || phase === 'loading' || selected === '',
              onClick: resetPage,
            }, t('settings.pageReset'))))
          if (pageForms.length > 0) {
            rows.push(h('p', {
              key: 'page-warning',
              className: 'md2pdf-warn',
              'data-md2pdf': 'page-warning',
              role: 'status',
            }, t('settings.pageUnsupported', { detail: pageForms.join(', ') })))
          }

          rows.push(h('h3', { key: 'fonts-heading', className: 'md2pdf-heading' }, t('settings.fontHeading')))
          rows.push(h('p', { key: 'fonts-hint', className: 'md2pdf-hint' }, t('settings.fontHint')))
          if (fontRows.length === 0) {
            rows.push(h('p', {
              key: 'fonts-empty',
              className: 'md2pdf-hint',
              'data-md2pdf-fonts': 'empty',
            }, t('settings.fontEmpty')))
          } else {
            rows.push(h('p', {
              key: 'fonts-summary',
              className: 'md2pdf-hint',
              'data-md2pdf-fonts': 'summary',
              'data-available': String(fontSummary.available),
              'data-missing-cjk': String(fontSummary.cjk),
              'data-missing-latin': String(fontSummary.latin),
              'data-unverified': String(fontSummary.unverified),
            }, t('settings.fontsSummary', fontSummary)))
            rows.push(h('table', {
              key: 'fonts-table',
              className: 'md2pdf-font-table',
              'data-md2pdf-fonts': 'table',
            },
            h('thead', null, h('tr', null,
              h('th', { scope: 'col' }, t('settings.fontFamily')),
              h('th', { scope: 'col' }, t('settings.fontCjk')),
              h('th', { scope: 'col' }, t('settings.fontLatin')),
              h('th', { scope: 'col' }, t('settings.fontState')))),
            h('tbody', null, fontRows.map(({ font, state }) => h('tr', {
              key: `font-${font.family}`,
              'data-font': font.family,
              'data-state': state,
            },
            h('td', { className: 'md2pdf-font-name' }, font.family),
            h('td', { className: 'md2pdf-font-mark' }, font.cjk === null ? '—' : font.cjk ? '✓' : '✗'),
            h('td', { className: 'md2pdf-font-mark' }, font.latin === null ? '—' : font.latin ? '✓' : '✗'),
            h('td', null, h('span', {
              className: 'md2pdf-font-state',
              'data-state': state,
            }, fontStateText(state))))))))
            if (hasFaceFamily) {
              rows.push(h('p', {
                key: 'fonts-face-note',
                className: 'md2pdf-hint',
                'data-md2pdf-fonts': 'face-note',
              }, t('settings.fontFaceNote')))
            }
          }

          rows.push(h('div', { key: 'editor-head', className: 'md2pdf-row' },
            h('span', { className: 'md2pdf-heading' }, editingLabel),
            dirty ? h('span', { className: 'md2pdf-flag' }, t('settings.dirty')) : null))

          rows.push(h('textarea', {
            key: 'field',
            className: 'md2pdf-field',
            spellCheck: false,
            value: css,
            placeholder: CSS_PLACEHOLDER,
            'aria-label': editingLabel,
            onChange: (event) => { setCss(event.target.value) },
          }))

          rows.push(h('div', { key: 'actions', className: 'md2pdf-row' },
            h('button', {
              type: 'button',
              className: 'md2pdf-btn',
              'data-tone': 'primary',
              'data-md2pdf-action': 'save',
              disabled: busy || pageBusy || phase === 'loading',
              onClick: () => { setDialog({ kind: 'save', draft: name }) },
            }, t('settings.save')),
            h('button', {
              type: 'button',
              className: 'md2pdf-btn',
              'data-md2pdf-action': 'new',
              disabled: busy || pageBusy || phase === 'loading',
              onClick: startNewPreset,
            }, t('settings.create')),
            h('button', {
              type: 'button',
              className: 'md2pdf-btn',
              'data-md2pdf-action': 'reload',
              disabled: busy || pageBusy || phase === 'loading',
              onClick: () => { if (editingId === null) load(); else editPreset(editingId) },
            }, t('settings.reload')),
            h('button', {
              type: 'button',
              className: 'md2pdf-btn',
              'data-md2pdf-action': 'up',
              disabled: busy || pageBusy || phase === 'loading' || editingId === null,
              onClick: () => { movePreset(editingId, -1) },
            }, t('settings.moveUp')),
            h('button', {
              type: 'button',
              className: 'md2pdf-btn',
              'data-md2pdf-action': 'down',
              disabled: busy || pageBusy || phase === 'loading' || editingId === null,
              onClick: () => { movePreset(editingId, 1) },
            }, t('settings.moveDown')),
            missingBuiltin
              ? h('button', {
                type: 'button',
                className: 'md2pdf-btn',
                'data-md2pdf-action': 'restore',
                disabled: busy || pageBusy || phase === 'loading',
                onClick: restoreShipped,
              }, t('settings.restore'))
              : null))

          if (status !== null) {
            rows.push(h('p', {
              key: 'status',
              className: 'md2pdf-status',
              'data-kind': status.kind,
              role: 'status',
              'aria-live': 'polite',
            }, status.text))
          }

          if (meta.cssPath !== '') {
            rows.push(h('div', { key: 'path-row', className: 'md2pdf-path-row' },
              h('p', { className: 'md2pdf-path' }, t('settings.path', { path: meta.cssPath })),
              h('button', {
                type: 'button',
                className: 'md2pdf-btn',
                'data-md2pdf-action': 'open',
                disabled: busy || selected === '',
                onClick: () => { openPresetFile(selected) },
              }, t('settings.open'))))
          }
          if (meta.presetsPath !== '') {
            rows.push(h('p', { key: 'dir', className: 'md2pdf-path' }, t('settings.dir', { path: meta.presetsPath })))
          }

          if (typeof previews[selected] === 'string' && previews[selected] !== '') {
            rows.push(h('div', {
              key: 'preview',
              className: 'md2pdf-preview',
              'data-md2pdf': 'preview',
            },
            h('p', { className: 'md2pdf-card-label', style: { textAlign: 'left' } }, t('settings.preview')),
            h('p', { className: 'md2pdf-hint' }, t('settings.previewHint')),
            h(Thumb, { html: previews[selected], width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT })))
          }

          if (meta.maxBytes > 0) {
            rows.push(h('p', { key: 'limit', className: 'md2pdf-path' }, t('settings.limit', { bytes: String(meta.maxBytes) })))
          }

          if (dialog !== null && dialog.kind === 'save') {
            rows.push(h(Dialog, {
              key: 'dialog-save',
              title: t('settings.saveTitle'),
              description: t('settings.saveHint'),
              draft: dialog.draft,
              draftLabel: t('settings.saveNameLabel'),
              cancelLabel: t('settings.cancel'),
              submitLabel: t('settings.confirmSave'),
              onDraft: (value) => { setDialog({ kind: 'save', draft: value }) },
              onSubmit: () => {
                if (String(dialog.draft ?? '').trim() === '') {
                  setStatus({ kind: 'error', text: t('settings.emptyName') })
                  return
                }
                savePreset(dialog.draft, false)
              },
              onCancel: () => { setDialog(null) },
            }))
          }
          if (dialog !== null && dialog.kind === 'overwrite') {
            rows.push(h(Dialog, {
              key: 'dialog-overwrite',
              title: t('settings.overwriteTitle'),
              description: t('settings.overwriteBody', { name: String(dialog.draft).trim() }),
              cancelLabel: t('settings.cancel'),
              submitLabel: t('settings.overwrite'),
              onSubmit: () => { savePreset(dialog.draft, true) },
              onCancel: () => { setDialog(null) },
            }))
          }
          if (dialog !== null && dialog.kind === 'delete') {
            rows.push(h(Dialog, {
              key: 'dialog-delete',
              title: t('settings.deleteTitle'),
              description: t('settings.deleteBody', { name: dialog.name }),
              cancelLabel: t('settings.cancel'),
              submitLabel: t('settings.remove'),
              danger: true,
              onSubmit: () => { removePreset(dialog.id, dialog.name) },
              onCancel: () => { setDialog(null) },
            }))
          }

          return h('div', { className: 'md2pdf-section' }, h(Styles, null), rows)
        }

        ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'md2pdf',
          order: SETTINGS_ORDER,
          label: () => t('settings.label'),
        }, SettingsSection)), 'md2pdf: settings section')
      },
    }
  },
})
