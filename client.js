// dsh-vision-tool — browser half.
//
// 在「设置」面板注册一个与「Agent 预设」并列的「识图模型」页
// （settings.section，order 21，紧跟 agent-presets 的 20）。整页只有
// 一个参数：下拉选择当前「模型」设置里已配置的 provider/model 作为
// 识图模型，选中即写回宿主 settings 的 `vision-tool` 命名空间
// （ctx.configForms 绑定，即时保存，无需保存按钮）。
//
// 导航行图标：宿主壳的导航图标是按 section id 写死的 switch（无图标位
// 的 Slot 契约），本节 id 不在其中、回落齿轮；这里用浏览器侧 DOM 协调
// 把本节行的齿轮换成 ic_ds 同风格眼睛 SVG（见 installEyeIcon）。
//
// 模型目录来自 remote.session.modelCatalog()（与 composer 模型选择器、
// 设置 → 模型 页同源：活 LLM 注册表的非空 provider 组），在适配器/
// 设置/凭据变更事件时自动刷新。
//
// 加载形式：手写 ClientModuleLoader 工厂（tsdown 对内置包 emit 的同一
// 包装）；外部 require 是 'react' 与 '@deepseek-ai/dsh-client-ui-primitives'
// （两者都在 shell 静态模块表，见 client/web seed.ts）。本包经
// plugin_manager install_bundle 安装为 profile bundle，宿主 client-modules
// 服务提供本文件；已打开的页面随 HMR 实时组合拿到，改动约 1 秒内热生效。

window.__ModuleLoader__.load({
  id: 'dsh-vision-tool',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')
    // 宿主静态模块表（client/web seed.ts）暴露 ui-primitives：Modal/Button/Switch
    // 原语经 require 直接命中种子表，零构建装配（见 makeRequire 的 seed 分支）。
    const { Modal, Button, Switch } = require('@deepseek-ai/dsh-client-ui-primitives')

    const NAMESPACE = 'vision-tool'

    /** 本节在设置导航里的显示名（DOM 图标协调也按它匹配本节按钮）。 */
    const sectionLabel = () => '识图模型'

    // ── 页面样式：对齐宿主设置页（ui-settings-models / ui-settings-general）
    //    的确切配方——.section/.title/.intro/.field/.fieldLabel/.input/
    //    select.input/.linkButton/.savedNotice（含同一枚 12px 内嵌 chevron、
    //    focus-visible 光环与 0.4 disabled 亮度），后续区块用 l2 hairline 分
    //    隔（仿 .customized）；token 引用不带字面量回退（暗色主题纪律）。
    //    类名加 dsh-vt- 前缀避免碰撞；style 元素随插件 effect 生命周期注入/移除。
    const SECTION_STYLES = `
.dsh-vt-section {
  display: flex; flex-direction: column; gap: 12px; max-width: 720px;
  color: var(--dsw-alias-label-primary);
}
.dsh-vt-title {
  margin: 0; font-size: 16px; line-height: 24px; font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.dsh-vt-intro {
  margin: 0; font-size: 14px; line-height: 22px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-vt-field { display: flex; flex-direction: column; gap: 6px; }
.dsh-vt-fieldLabel {
  display: inline-flex; align-items: center; gap: 10px;
  font-size: 12px; line-height: 18px; font-weight: 500;
  color: var(--dsw-alias-label-secondary);
}
.dsh-vt-input {
  box-sizing: border-box; width: 100%; height: 32px; padding: 0 10px;
  border: 0.5px solid var(--dsw-alias-border-l4); border-radius: 8px;
  font: inherit; font-size: 14px; line-height: 22px;
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
}
.dsh-vt-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.dsh-vt-input:disabled { opacity: 0.6; cursor: default; }
select.dsh-vt-input { max-width: 240px; cursor: pointer; }
.dsh-vt-selectInput {
  appearance: none; padding-right: 32px;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 12px center;
  background-size: 12px 12px;
}
/* 宿主 ui-settings-models 的 .linkButton 配方（次级文字按钮）。 */
.dsh-vt-linkButton {
  box-sizing: border-box; display: inline-flex; align-items: center;
  height: 28px; padding: 0 10px; border: none; border-radius: 14px;
  background: transparent; color: var(--dsw-alias-label-tertiary);
  font: inherit; font-size: 12px; line-height: 18px; cursor: pointer;
}
.dsh-vt-linkButton:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}
.dsh-vt-linkButton:focus-visible {
  outline: none; box-shadow: 0 0 0 2px var(--dsw-alias-border-l3);
}
.dsh-vt-linkButton:disabled { opacity: 0.4; cursor: default; }
/* 宿主 .savedNotice/.notice/.error 配方：12/18 状态行，token 不带回退。 */
.dsh-vt-status { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.dsh-vt-statusWarn { color: var(--dsw-alias-state-warn-label); }
.dsh-vt-statusOk { color: var(--dsw-alias-state-success-primary); }
.dsh-vt-statusError { color: var(--dsw-alias-state-error-primary); }
/* 「+ 识图」开关列表：分组小标题 + 每行模型名与 Switch（控件本身用 ui-primitives）。 */
.dsh-vt-twinList { margin-top: 2px; }
.dsh-vt-toggleGroup { display: flex; flex-direction: column; gap: 2px; }
.dsh-vt-toggleGroupTitle {
  font-size: 12px; line-height: 18px; font-weight: 500; margin-top: 8px;
  color: var(--dsw-alias-label-secondary);
}
.dsh-vt-toggleRow {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  min-height: 30px;
}
.dsh-vt-toggleName {
  font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* 清理区块与表单的分区（仿 .customized 的 l2 hairline）。 */
.dsh-vt-separator { border-top: 0.5px solid var(--dsw-alias-border-l2); padding-top: 12px; }
/* 清理确认对话框（仿 ui-settings-models 的 .deleteDialog/.deleteConfirm）。 */
.dsh-vt-cleanupDialog { width: min(480px, 100%); }
.dsh-vt-dangerConfirm:not(:disabled) {
  border-color: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-state-error-primary);
}
.dsh-vt-dangerConfirm:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-danger);
}
`

    const installStyles = () => {
      const element = document.createElement('style')
      element.id = 'dsh-vision-tool-styles'
      element.textContent = SECTION_STYLES
      document.head.appendChild(element)
      return () => { element.remove() }
    }

    // ── apply 世界持有的单例（一个插件 = 一个实例，模块级句柄是自然归属，
    //    与 dsh-git-sidebar 的 shared store 同一先例）。remote 经 inject 声明
    //    后在 apply 时捕获。───────────────────────────────────────────────
    let boundScope
    let remote

    const encodeKey = (provider, model) => JSON.stringify([provider, model])
    const decodeKey = (key) => {
      try {
        const value = JSON.parse(key)
        return Array.isArray(value) && typeof value[0] === 'string' && typeof value[1] === 'string'
          ? { provider: value[0], model: value[1] }
          : undefined
      } catch {
        return undefined
      }
    }

    function VisionToolSection() {
      const h = React.createElement
      // configForms 快照（reactive read：uSES 订阅控制器本身）
      const getSnapshot = React.useMemo(() => boundScope.getSnapshot.bind(boundScope), [])
      const subscribe = React.useMemo(() => (listener) => boundScope.subscribe(listener), [])
      const snap = React.useSyncExternalStore(subscribe, getSnapshot)
      // 模型目录
      const [catalog, setCatalog] = React.useState({ status: 'loading', groups: [], error: '' })
      const [savedFlash, setSavedFlash] = React.useState(0)

      const loadCatalog = React.useCallback(async () => {
        try {
          const response = await remote.session.modelCatalog()
          if (!response || response.ok !== true) {
            const message =
              response && response.error
                ? `${response.error.code ?? 'ERROR'}: ${response.error.message ?? ''}`
                : '模型目录响应异常'
            throw new Error(message)
          }
          const value = response.value
          if (!value || !Array.isArray(value.groups)) throw new Error('模型目录响应缺少 groups')
          setCatalog({ status: 'ready', groups: value.groups, error: '' })
        } catch (error) {
          setCatalog({ status: 'error', groups: [], error: error?.message ?? String(error) })
        }
      }, [])

      React.useEffect(() => {
        void loadCatalog()
        const disposers = []
        if (remote && typeof remote.$on === 'function') {
          disposers.push(remote.$on('llm/adapters-updated', () => { void loadCatalog() }))
          disposers.push(remote.$on('settings/document-updated', () => { void loadCatalog() }))
          disposers.push(remote.$on('credentials/reference-updated', () => { void loadCatalog() }))
        }
        return () => { for (const dispose of disposers) dispose() }
      }, [loadCatalog])

      React.useEffect(() => {
        if (savedFlash === 0) return undefined
        const timer = setTimeout(() => setSavedFlash(0), 2000)
        return () => clearTimeout(timer)
      }, [savedFlash])

      // 清理暂存图片（同源 POST → 宿主半边扫描会话日志，删除未被任何
      // 未归档会话引用且写入超过 5 分钟的附件对象；已归档会话不算引用）。
      // 确认走宿主 Modal/Button 原语（仿模型页删除确认），不再用
      // window.confirm 的 OS 对话框；运行中 Esc/遮罩点击不关窗。
      const [confirmOpen, setConfirmOpen] = React.useState(false)
      const [cleanup, setCleanup] = React.useState({ phase: 'idle', message: '' })

      const performCleanup = React.useCallback(async () => {
        setCleanup({ phase: 'running', message: '正在扫描会话并清理…' })
        try {
          const response = await fetch('/plugins/dsh-vision-tool/cleanup-attachments', {
            method: 'POST',
          })
          const payload = await response.json().catch(() => undefined)
          if (!response.ok || !payload || payload.ok !== true) {
            throw new Error(payload && payload.error ? payload.error : `HTTP ${response.status}`)
          }
          const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`
          const archivedNote = payload.skippedArchivedSessions > 0
            ? `；${payload.skippedArchivedSessions} 个已归档会话按已删除处理（其图片属于清理对象）`
            : ''
          setCleanup({
            phase: 'done',
            message:
              `已清理 ${payload.removedCount} 个暂存图片（释放 ${mb(payload.removedBytes)}）；` +
              `仍保留 ${payload.keptCount} 个（${mb(payload.keptBytes)}，被未归档会话引用或近期写入）${archivedNote}。`,
          })
          // 成功即关窗（结果文案落在页内清理行）；失败保留对话框展示错误。
          setConfirmOpen(false)
        } catch (error) {
          setCleanup({ phase: 'error', message: `清理失败：${error?.message ?? String(error)}` })
        }
      }, [])

      const closeCleanupDialog = () => {
        if (cleanup.phase === 'running') return
        setConfirmOpen(false)
      }

      // 已保存的选择
      const savedValue =
        snap.status === 'ready' && snap.value && typeof snap.value === 'object'
          ? {
              provider: String(snap.value.visionProvider ?? ''),
              model: String(snap.value.visionModel ?? ''),
            }
          : undefined
      const savedKey =
        savedValue && savedValue.provider !== '' && savedValue.model !== ''
          ? encodeKey(savedValue.provider, savedValue.model)
          : ''

      // 目录投影：只保留带模型的 provider 组
      const known = new Set()
      const groupViews = []
      for (const group of catalog.groups) {
        if (!group || typeof group.id !== 'string' || group.id === '') continue
        // 排除「+ 识图」孪生路由：那是给聊天模型发图的包装入口，
        // 不能当识图后端用。
        if (group.id.endsWith('-vision')) continue
        const models = Array.isArray(group.models)
          ? group.models.filter((m) => m && typeof m.id === 'string' && m.id !== '')
          : []
        if (models.length === 0) continue
        groupViews.push({
          id: group.id,
          name: typeof group.name === 'string' && group.name !== '' ? group.name : group.id,
          models,
        })
        for (const model of models) known.add(encodeKey(group.id, model.id))
      }
      const savedMissing = savedKey !== '' && !known.has(savedKey)

      // 「+ 识图」孪生开关：key 与宿主 encodeTwinKey 同款（encodeKey(provider,
      // model)）。缺省（无记录）= 关。记录读自 settings 快照，随写入即时刷新。
      const twinEnabled =
        snap.status === 'ready' && snap.value !== undefined && snap.value !== null
        && typeof snap.value.twinEnabled === 'object'
          ? snap.value.twinEnabled
          : {}
      // 目录未就绪时列表本身不渲染；设置只读/未就绪时开关禁用。
      const twinToggleDisabled = snap.status !== 'ready' || snap.writable === false
      const toggleTwin = (provider, model, next) => {
        // 嵌套路径定点写单个记录 key：原子、按 revision 围栏——快速连续切换
        // 各写各的 key，不会像整记录读-改-写那样互相覆盖。
        void boundScope.mutate([
          { op: 'set', path: ['twinEnabled', encodeKey(provider, model)], value: next },
        ])
        setSavedFlash(Date.now())
      }

      const onChange = (event) => {
        const picked = decodeKey(event.target.value)
        if (picked === undefined) return
        void boundScope.set('visionProvider', picked.provider)
        void boundScope.set('visionModel', picked.model)
        setSavedFlash(Date.now())
      }

      const statusClass =
        snap.status === 'unavailable' || (snap.status === 'ready' && snap.writable === false)
          ? 'dsh-vt-status dsh-vt-statusWarn'
          : savedFlash !== 0
            ? 'dsh-vt-status dsh-vt-statusOk'
            : 'dsh-vt-status'
      const statusText =
        snap.status === 'loading'
          ? '正在读取设置…'
          : snap.status === 'unavailable'
            ? '设置命名空间不可用（识图模型选择将无法保存）'
            : snap.status === 'ready' && snap.writable === false
              ? '当前设置提供方只读，无法保存选择。'
              : savedFlash !== 0
                ? '已保存 ✓'
                : ''

      return h(
        'div',
        { className: 'dsh-vt-section' },
        h('h2', { className: 'dsh-vt-title' }, '识图模型'),
        h(
          'p',
          { className: 'dsh-vt-intro' },
          '先在下方为需要的模型打开「+ 识图」开关，再到聊天页右下角选择带「+ 识图」的模型即可发送图片：图片不会发给该语言模型，而是由它调用 recognize_images 工具转发给这里选定的识图模型。',
        ),
        // ── 「+ 识图」孪生开关列表（识图模型下拉框上方）─────────────────────
        // 每个已接入模型一个开关，控制它在聊天页模型选择里是否展示「+ 识图」
        // 条目；默认全部关闭（自带多模态的模型保持关闭即不再出现孪生选项）。
        h(
          'div',
          { className: 'dsh-vt-field dsh-vt-twinList' },
          h('span', { className: 'dsh-vt-fieldLabel' }, '「+ 识图」模型选项'),
          h(
            'p',
            { className: 'dsh-vt-intro' },
            '按模型单独控制，默认全部关闭；自带多模态的模型保持关闭即可。',
          ),
          catalog.status === 'ready'
            ? groupViews.length === 0
              ? h('p', { className: 'dsh-vt-status' }, '暂无已接入的模型。')
              : groupViews.map((group) =>
                  h(
                    'div',
                    { key: group.id, className: 'dsh-vt-toggleGroup' },
                    h('div', { className: 'dsh-vt-toggleGroupTitle' }, group.name),
                    group.models.map((model) => {
                      const on = twinEnabled[encodeKey(group.id, model.id)] === true
                      const name =
                        typeof model.name === 'string' && model.name !== '' ? model.name : model.id
                      return h(
                        'div',
                        { key: model.id, className: 'dsh-vt-toggleRow' },
                        h('span', { className: 'dsh-vt-toggleName', title: name }, name),
                        h(Switch, {
                          checked: on,
                          label: `${name} + 识图`,
                          disabled: twinToggleDisabled,
                          onChange: (next) => { toggleTwin(group.id, model.id, next) },
                        }),
                      )
                    }),
                  ),
                )
            : h('p', { className: 'dsh-vt-status' }, '正在加载模型列表…'),
        ),
        h(
          'label',
          { className: 'dsh-vt-field' },
          h('span', { className: 'dsh-vt-fieldLabel' }, '识图模型'),
          h(
            'select',
            {
              className: 'dsh-vt-input dsh-vt-selectInput',
              value: savedKey,
              onChange,
              disabled: catalog.status !== 'ready',
            },
            savedKey === ''
              ? h('option', { value: '' }, catalog.status === 'ready' ? '请选择识图模型…' : '正在加载模型列表…')
              : null,
            savedMissing && savedValue
              ? h('option', { value: savedKey }, `${savedValue.provider} / ${savedValue.model}（已保存，当前模型列表中不存在）`)
              : null,
            groupViews.map((group) =>
              h(
                'optgroup',
                { key: group.id, label: group.name },
                group.models.map((model) =>
                  h('option', { key: model.id, value: encodeKey(group.id, model.id) }, model.id),
                ),
              ),
            ),
          ),
        ),
        // 状态行（仿宿主 .savedNotice：role=status 让读屏播报保存/异常）。
        h(
          'p',
          { className: statusClass, role: 'status', 'aria-live': 'polite' },
          statusText,
        ),
        h(
          'div',
          { className: 'dsh-vt-separator' },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-vt-linkButton',
                onClick: () => { setConfirmOpen(true) },
                disabled: cleanup.phase === 'running',
              },
              cleanup.phase === 'running' ? '正在清理…' : '清理暂存图片',
            ),
            cleanup.message !== ''
              ? h(
                  'span',
                  {
                    className:
                      cleanup.phase === 'error'
                        ? 'dsh-vt-status dsh-vt-statusError'
                        : cleanup.phase === 'done'
                          ? 'dsh-vt-status dsh-vt-statusOk'
                          : 'dsh-vt-status',
                  },
                  cleanup.message,
                )
              : null,
          ),
        ),
        catalog.status === 'error'
          ? h('p', { className: 'dsh-vt-status dsh-vt-statusError', role: 'alert' }, `模型列表加载失败：${catalog.error}`)
          : null,
        // 清理确认：宿主 Modal + Button 原语（仿模型页删除确认对话框）。
        h(
          Modal,
          {
            open: confirmOpen,
            onClose: closeCleanupDialog,
            title: '清理暂存图片',
            closeLabel: '关闭',
            description:
              '将扫描全部会话日志并删除附件库中未被任何未归档会话引用、且写入超过 5 分钟的暂存图片。' +
              '已归档会话中出现的图片也会一并清理（归档后无法再查看）。',
            className: 'dsh-vt-cleanupDialog',
            footer: h(
              React.Fragment,
              null,
              h(
                Button,
                { variant: 'outline', onClick: closeCleanupDialog, disabled: cleanup.phase === 'running' },
                '取消',
              ),
              h(
                Button,
                {
                  variant: 'outline',
                  className: 'dsh-vt-dangerConfirm',
                  disabled: cleanup.phase === 'running',
                  onClick: () => { void performCleanup() },
                },
                cleanup.phase === 'running' ? '正在清理…' : '确定清理',
              ),
            ),
          },
          cleanup.phase === 'error'
            ? h('p', { className: 'dsh-vt-status dsh-vt-statusError', role: 'alert' }, cleanup.message)
            : null,
        ),
      )
    }

    // ── 设置导航行的眼睛图标 ────────────────────────────────────────────────
    //
    // 宿主设置壳（ui-settings-general SettingsRoot）的导航图标是壳内写死的
    // 按 section id 的 switch（models/agent-presets/plugins 三个专属，其余
    // 一律回落齿轮），settings.section 的 Slot 契约（{id, order, label}）
    // 没有图标位——正规注册改不了它。这里在浏览器侧做精准 DOM 协调：
    // 按钮命中本节 label 时，隐藏齿轮 SVG（不删除——React 仍持有该节点，
    // 删除会破坏其协调），在其前插入一枚 ic_ds 同风格（16×16、
    // currentColor、outline 环线）的眼睛 SVG。MutationObserver 驱动、
    // 幂等、可自愈（React 重渲染重建行后自动重新套用），插件卸载时还原。
    const EYE_SVG =
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<path fill-rule="evenodd" clip-rule="evenodd" ' +
      'd="M1 8C2.6 4.9 5.1 3.3 8 3.3C10.9 3.3 13.4 4.9 15 8C13.4 11.1 10.9 12.7 8 12.7C5.1 12.7 2.6 11.1 1 8Z' +
      'M2.35 8C3.75 5.45 5.75 4.25 8 4.25C10.25 4.25 12.25 5.45 13.65 8C12.25 10.55 10.25 11.75 8 11.75C5.75 11.75 3.75 10.55 2.35 8Z" ' +
      'fill="currentColor"/>' +
      '<path fill-rule="evenodd" clip-rule="evenodd" ' +
      'd="M10.55 8A2.55 2.55 0 1 1 5.45 8A2.55 2.55 0 1 1 10.55 8Z' +
      'M9.35 8A1.35 1.35 0 1 0 6.65 8A1.35 1.35 0 1 0 9.35 8Z" ' +
      'fill="currentColor"/>' +
      '</svg>'

    const eyeNodes = new Set() // 已插入的眼睛节点（卸载还原用）

    const buildEye = (gearSvg) => {
      const template = document.createElement('template')
      template.innerHTML = EYE_SVG
      const eye = template.content.firstChild.cloneNode(true)
      // 沿用齿轮的 class（壳 CSS 模块的 navIcon 样式）与显式尺寸。
      const moved = gearSvg.getAttribute('class')
      if (moved !== null && moved !== '') eye.setAttribute('class', moved)
      const width = gearSvg.getAttribute('width')
      const height = gearSvg.getAttribute('height')
      if (width !== null) eye.setAttribute('width', width)
      if (height !== null) eye.setAttribute('height', height)
      eye.setAttribute('data-vision-eye', '1')
      return eye
    }

    /** 幂等协调：命中 label 的导航按钮 = 齿轮隐藏 + 眼睛就位。 */
    const reconcileEyeIcon = () => {
      const label = sectionLabel()
      for (const button of document.querySelectorAll('nav button')) {
        const span = [...button.querySelectorAll('span')].find(
          (node) => node.textContent.trim() === label,
        )
        if (span === undefined) continue
        const svgs = [...button.querySelectorAll('svg')]
        if (svgs.length === 0) continue
        const eye = svgs.find((svg) => svg.getAttribute('data-vision-eye') === '1')
        const gear = svgs.find((svg) => svg.getAttribute('data-vision-eye') !== '1')
        if (gear !== undefined && gear.style.display !== 'none') gear.style.display = 'none'
        if (eye === undefined && gear !== undefined) {
          const node = buildEye(gear)
          gear.parentNode.insertBefore(node, gear)
          eyeNodes.add(node)
        }
      }
    }

    const installEyeIcon = () => {
      reconcileEyeIcon()
      // 门闩尽量便宜：仅当新增子树里有 nav、或变更点位于某个 nav 内时才
      // 扫描（流式转录的变更既不含 nav 也不在 nav 内，直接跳过）。
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          const insideNav =
            mutation.target.nodeType === 1 && mutation.target.closest('nav') !== null
          const addsNav =
            !insideNav
            && [...mutation.addedNodes].some(
              (node) => node.nodeType === 1 && node.querySelector('nav') !== null,
            )
          if (insideNav || addsNav) {
            reconcileEyeIcon()
            return
          }
        }
      })
      observer.observe(document.body, { childList: true, subtree: true })
      return () => {
        observer.disconnect()
        // 还原：移除眼睛、取消齿轮隐藏。
        for (const node of eyeNodes) {
          if (node.isConnected) node.remove()
        }
        eyeNodes.clear()
        for (const svg of document.querySelectorAll('nav svg[data-vision-eye="1"]')) svg.remove()
        for (const button of document.querySelectorAll('nav button')) {
          for (const svg of button.querySelectorAll('svg')) {
            if (svg.getAttribute('data-vision-eye') !== '1' && svg.style.display === 'none') {
              svg.style.display = ''
            }
          }
        }
      }
    }

    function apply(ctx) {
      boundScope = ctx.configForms.get(NAMESPACE)
      // remote 与 remote.session 均已在 inject 声明，apply 时即可安全捕获。
      remote = ctx.remote
      ctx.effect(
        () =>
          ctx.slots.inject('settings.section', function* () {
            yield ctx.slots.register(
              {
                name: 'settings.section',
                id: 'vision-tool',
                order: 21,
                label: sectionLabel,
                inject: () => ({}),
              },
              VisionToolSection,
            )
          }),
        'dsh-vision-tool: settings section',
      )
      ctx.effect(() => installEyeIcon(), 'dsh-vision-tool: nav eye icon')
      ctx.effect(() => installStyles(), 'dsh-vision-tool: section styles')
    }

    exports.apply = apply
    // configForms：0.1.7 起设置域的客户端服务（ui-settings 提供；旧版
    // settingsScope 已移除）。
    exports.inject = ['configForms', 'slots', 'remote', 'remote.session']
    return module.exports
  },
})
