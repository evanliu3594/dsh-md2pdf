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
    const CAPABILITY_ROUTE = 'md2pdf/capability'
    const SETTINGS_ROUTE = 'md2pdf/settings'
    const PRESETS_ROUTE = 'md2pdf/presets'
    const PREVIEWS_ROUTE = 'md2pdf/previews'

    /** A4 at 96 dpi: the width every preview is laid out at before scaling. */
    const PAGE_WIDTH = 794
    const PAGE_HEIGHT = 1123
    /** Preset card miniature. */
    const CARD_WIDTH = 166
    const CARD_HEIGHT = 104
    /** Preview of the saved stylesheet, shown large enough to read. */
    const PREVIEW_WIDTH = 552
    const PREVIEW_HEIGHT = 224

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
        'toast.ok': 'PDF written to {path}',
        'toast.failed': 'PDF export failed: {message}',
        'settings.label': 'dsh-md2pdf',
        'settings.heading': 'Printed page styles',
        'settings.hint': 'A preset is one stylesheet. Click a card to use it, edit it below, or add your own. A change applies to the next export with no restart.',
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
        'toast.ok': 'PDF 已输出到 {path}',
        'toast.failed': '导出 PDF 失败：{message}',
        'settings.label': 'dsh-md2pdf',
        'settings.heading': '打印样式',
        'settings.hint': '一个预设就是一份样式表。点卡片应用到导出，点「编辑」改它的样式，也能新建、排序、删除。改动在下次导出生效，不需要重启。',
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
    function loadCapability() {
      capability ??= requestRoute(CAPABILITY_ROUTE, { headers: { accept: 'application/json' } })
        .then(({ payload }) => payload ?? { engine: null })
        .catch(() => ({ engine: null }))
      return capability
    }

    /**
     * Run one export through the Host.
     * @param input - source path and the Session that reported it.
     * @returns the Host's answer, or a named failure.
     */
    async function exportPdf(input) {
      const body = { path: input.path }
      if (typeof input.sessionId === 'string' && input.sessionId !== '') body.sessionId = input.sessionId
      const { response, payload } = await requestRoute(EXPORT_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (response.ok && payload !== null && payload.ok === true) return { ok: true, result: payload }
      const message = payload !== null && typeof payload.message === 'string'
        ? payload.message
        : `HTTP ${response.status}`
      return { ok: false, message }
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
.md2pdf-heading { margin: 0; font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary, #1c1f23); }
.md2pdf-hint { margin: 0; font-size: 12px; line-height: 1.65; color: var(--dsw-alias-label-secondary, #6b7280); }
.md2pdf-cards { display: flex; flex-wrap: wrap; gap: 10px; }
.md2pdf-card {
  position: relative;
  width: 178px;
  height: 148px;
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
  padding: 0 0 26px;
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

    return {
      inject: ['slots', 'contextMenus', 'locale'],

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
         * Export one file and report the result.
         * @returns whether the Host wrote a PDF.
         */
        async function runExport(input) {
          const outcome = await exportPdf(input).catch(error => ({ ok: false, message: messageOf(error) }))
          if (outcome.ok) {
            notify(t('toast.ok', { path: outcome.result.pdfPath }), true)
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
            const available = ready !== null && ready.engine !== null && ready.engine !== undefined
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
          const [busy, setBusy] = React.useState(false)
          const [dialog, setDialog] = React.useState(null)

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
          }, [refresh])

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
            try {
              await act({ action: 'select', id })
              await load()
              await loadPreviews()
              setStatus({ kind: 'ok', text: t('settings.applied', { name: nameOf(id) }) })
            } catch (error) {
              fail('settings.applyFailed', error)
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
            try {
              await act({ action: 'order', ids: next })
              await load()
              await loadPreviews()
            } catch (error) {
              fail('settings.orderFailed', error)
            }
          }, [act, presets, load, loadPreviews, fail])

          const restoreShipped = React.useCallback(async () => {
            try {
              await act({ action: 'restore' })
              await load()
              await loadPreviews()
              setStatus({ kind: 'ok', text: t('settings.restored') })
            } catch (error) {
              fail('settings.restoreFailed', error)
            }
          }, [act, load, loadPreviews, fail])

          const startNewPreset = React.useCallback(() => {
            setEditingId(null)
            setName('')
            setCss('')
            setSavedCss('')
            setStatus(null)
          }, [])

          const dirty = css !== savedCss
          const missingBuiltin = builtins.some(id => !presets.some(preset => preset.id === id))
          const editingLabel = editingId === null ? t('settings.editingNew') : t('settings.editing', { name })
          const rows = []

          rows.push(h('h3', { key: 'heading', className: 'md2pdf-heading' }, t('settings.heading')))
          rows.push(h('p', { key: 'hint', className: 'md2pdf-hint' }, t('settings.hint')))

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
              disabled: phase === 'loading',
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
              disabled: phase === 'loading',
              'aria-label': t('settings.removePreset', { name: preset.name }),
              onClick: () => { setDialog({ kind: 'delete', id: preset.id, name: preset.name }) },
            }, h(TrashGlyph, null))))))
            rows.push(h('p', { key: 'current', className: 'md2pdf-hint' },
              t('settings.selected', { name: nameOf(selected) })))
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
              disabled: busy || phase === 'loading',
              onClick: () => { setDialog({ kind: 'save', draft: name }) },
            }, t('settings.save')),
            h('button', {
              type: 'button',
              className: 'md2pdf-btn',
              'data-md2pdf-action': 'new',
              disabled: busy || phase === 'loading',
              onClick: startNewPreset,
            }, t('settings.create')),
            h('button', {
              type: 'button',
              className: 'md2pdf-btn',
              'data-md2pdf-action': 'reload',
              disabled: busy || phase === 'loading',
              onClick: () => { if (editingId === null) load(); else editPreset(editingId) },
            }, t('settings.reload')),
            h('button', {
              type: 'button',
              className: 'md2pdf-btn',
              'data-md2pdf-action': 'up',
              disabled: busy || phase === 'loading' || editingId === null,
              onClick: () => { movePreset(editingId, -1) },
            }, t('settings.moveUp')),
            h('button', {
              type: 'button',
              className: 'md2pdf-btn',
              'data-md2pdf-action': 'down',
              disabled: busy || phase === 'loading' || editingId === null,
              onClick: () => { movePreset(editingId, 1) },
            }, t('settings.moveDown')),
            missingBuiltin
              ? h('button', {
                type: 'button',
                className: 'md2pdf-btn',
                'data-md2pdf-action': 'restore',
                disabled: busy || phase === 'loading',
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
