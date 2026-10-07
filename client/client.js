/**
 * dsh-design-ledger —— 浏览器半区。
 *
 * 契约（已在 DSH 0.2.0-rc.2 上核实）：
 *   - 以经典脚本加载：window.__ModuleLoader__.load({ id: <包名>, factory });
 *   - `id` 必须等于包名；只能 require 平台种子模块（react / jsx-runtime / primitives）；
 *   - factory 返回 { inject, apply }，apply(ctx) 内注册槽位与副作用。
 *
 * 槽位：
 *   - sidebar.panellist  id=`design-ledger`, order=2 → 排在宿主「插件」(0) 与
 *     skill-mcp-panel 的「技能/MCP」(1) 之后，即"插件按钮下面"；
 *   - main               key=`design-ledger`        → 点击后切换的中央页面。
 *
 * 数据通道：宿主注册的 JSON 路由
 *   GET  /design-ledger/status.json   当前绑定与进度
 *   GET  /design-ledger/list.json     工作区目录浏览（只列子目录与 .md，带 mdCount）
 *   POST /design-ledger/bind.json     选定设计文档 → 建台账
 * 所有路径都由**宿主**做工作区内校验（面板无法越界读取）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-design-ledger',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 侧栏行 id 与 main 槽位的 key 必须一致（选中缺失 key 宿主会抛错）。 */
    const PANEL_ID = 'design-ledger'
    const LOCALE_NS = 'designLedger'
    const R = {
      status: '/design-ledger/status.json',
      list: '/design-ledger/list.json',
      bind: '/design-ledger/bind.json',
    }

    const zh = {
      nav: '设计文档包含',
      title: '设计文档包含 · 开发进度台账',
      loading: '读取中…',
      refresh: '刷新',
      notBound: '本工作区还没有台账。',
      pick: '选择设计文档',
      pickHint: '选一个 .md 文件，或一个包含 .md 的文件夹（文件夹会递归解析，并按子目录名推断系统/子系统）。',
      up: '上一级',
      root: '工作区根',
      searching: '正在浏览工作区',
      noWorkspace: '工作区未知：状态接口没返回 workspaceRoot，无法打开选择器。',
      empty: '（此目录下没有子目录或 .md 文件）',
      mdCount: '个 .md',
      bind: '载入为设计文档',
      binding: '正在建台账…',
      bound: '已绑定',
      designDoc: '设计文档',
      systems: '系统',
      progress: '进度',
      nodes: '节点',
      openBugs: '未修复 bug',
      marked: '当前聚焦',
      noMarked: '（未设置聚焦节点）',
      taskPrompt: '已记录任务开启提示词',
      noTaskPrompt: '未记录任务开启提示词',
      sections: '文档分组',
      error: '读取失败',
      updateHint: '完成功能后用 design_ledger_update 更新状态 / 代码索引 / 接口 / bug。',
      close: '关闭',
      forceBind: '台账已存在，改用「重建」会清空现有进度',
      rebuild: '重建台账（清空进度）',
      cancel: '取消',
      bindOk: '台账已建立',
    }
    const en = {
      nav: 'Design docs',
      title: 'Design docs · progress ledger',
      loading: 'Loading…',
      refresh: 'Refresh',
      notBound: 'No ledger in this workspace yet.',
      pick: 'Choose design document',
      pickHint:
        'Pick a .md file, or a folder containing .md files (folders are parsed recursively; subfolder names infer systems/subsystems).',
      up: 'Up',
      root: 'Workspace root',
      searching: 'Browsing workspace',
      noWorkspace: 'Workspace unknown: the status route returned no workspaceRoot, so the picker cannot open.',
      empty: '(no subfolder or .md file here)',
      mdCount: 'md',
      bind: 'Load as design document',
      binding: 'Building ledger…',
      bound: 'Bound',
      designDoc: 'Design doc',
      systems: 'Systems',
      progress: 'Progress',
      nodes: 'Nodes',
      openBugs: 'Open bugs',
      marked: 'Focused',
      noMarked: '(no focused node)',
      taskPrompt: 'Task-opening prompt recorded',
      noTaskPrompt: 'No task-opening prompt recorded',
      sections: 'Document groups',
      error: 'Load failed',
      updateHint: 'After finishing a feature, update status / code refs / interfaces / bugs with design_ledger_update.',
      close: 'Close',
      forceBind: 'A ledger already exists; rebuilding clears current progress',
      rebuild: 'Rebuild ledger (clears progress)',
      cancel: 'Cancel',
      bindOk: 'Ledger created',
    }

    const CSS = [
      '.dlg-root{padding:16px 20px;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary,inherit);max-width:960px}',
      '.dlg-head{display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap}',
      '.dlg-title{font-size:15px;font-weight:600;margin:0}',
      '.dlg-btn{border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.35));background:transparent;color:inherit;border-radius:6px;padding:3px 10px;cursor:pointer;font-size:12px}',
      '.dlg-btn:hover{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.12))}',
      '.dlg-btn[disabled]{opacity:.5;cursor:default}',
      '.dlg-primary{border-color:transparent;background:var(--dsw-alias-brand-primary,#4d6bfe);color:#fff}',
      '.dlg-card{border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25));border-radius:8px;padding:10px 12px;margin:8px 0}',
      '.dlg-kv{display:flex;gap:8px;flex-wrap:wrap;margin:6px 0}',
      '.dlg-sys{display:flex;align-items:center;gap:8px;padding:3px 0}',
      '.dlg-row{display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:5px;cursor:pointer}',
      '.dlg-row:hover{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.12))}',
      '.dlg-row.sel{background:var(--dsw-alias-bg-layer-2,rgba(77,107,254,.18))}',
      '.dlg-bar{flex:1;height:6px;border-radius:3px;background:var(--dsw-alias-bg-base,rgba(128,128,128,.2));overflow:hidden;min-width:80px}',
      '.dlg-bar>i{display:block;height:100%;background:currentColor;opacity:.55}',
      '.dlg-dim{opacity:.65}',
      '.dlg-code{font-family:ui-monospace,Consolas,monospace;font-size:12px;opacity:.9;word-break:break-all}',
      '.dlg-warn{color:var(--dsw-alias-state-warn-primary,#d08700)}',
      '.dlg-mark{color:var(--dsw-alias-brand-primary,#4d6bfe)}',
      '.dlg-crumb{display:flex;gap:4px;align-items:center;flex-wrap:wrap;font-size:12px;margin-bottom:6px}',
      '.dlg-list{max-height:340px;overflow:auto;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));border-radius:6px;padding:4px}',
      '.dlg-mask{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:9999}',
      '.dlg-modal{background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1,#2a2d33));color:var(--dsw-alias-label-primary,#e8eaed);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.45));border-radius:10px;padding:14px 16px;width:min(680px,92vw);max-height:86vh;overflow:auto;box-shadow:0 12px 40px rgba(0,0,0,.45)}',
      '.dlg-foot{display:flex;justify-content:flex-end;gap:8px;margin-top:10px}',
      '.dlg-tag{font-size:11px;opacity:.6;border:1px solid currentColor;border-radius:4px;padding:0 4px}',
    ].join('')

    /**
     * 稳健的 JSON 获取。
     *
     * 为什么不能直接 `fetch(…).then(r => r.json())`：宿主对未注册路由会返回
     * **空体**（或 HTML）响应，`r.json()` 于是抛
     *   Failed to execute 'json' on 'Response': Unexpected end of JSON input
     * —— 这条报错只看得到浏览器解析失败，看不到真正的 HTTP 状态，排障时极具误导性。
     * 这里统一：先取文本，再尝试解析，并把状态码/响应片段带进错误信息。
     */
    async function fetchJson(url, init) {
      const r = await fetch(url, Object.assign({ headers: { accept: 'application/json' } }, init || {}))
      const text = await r.text()
      let data = null
      if (text) {
        try {
          data = JSON.parse(text)
        } catch {
          if (r.ok) throw new Error('响应不是合法 JSON（HTTP ' + r.status + '）：' + text.slice(0, 120))
          data = null
        }
      }
      if (!r.ok) {
        const detail = data && (data.error || data.detail) ? data.error || data.detail : ''
        throw new Error(
          'HTTP ' + r.status + (detail ? ' · ' + detail : '') +
            (text ? '' : ' · 空响应（路由未注册？宿主 webServer 尚未就绪）'),
        )
      }
      if (data === null) {
        throw new Error('空响应或非法 JSON（HTTP ' + r.status + '）—— 面板路由可能未注册，请重开客户端后重试')
      }
      return data
    }

    /**
     * 工作区参数规范化。
     *
     * ⚠️ 必须**显式把工作区传给宿主路由**：路由不带 `workspace` 时会退化成
     * `workspaceRoot(undefined)` —— 那是 sandboxPolicy 的**部署默认根**（本机实测是
     * profile 目录 `D:\AppData\.dsh\profiles\desktop`），并不是当前会话的工作区。
     * 结果就是弹窗里一个文件夹都看不到（默认根里当然没有设计文档）。
     *
     * 反斜杠一律转成 `/`：Windows 路径放进 URL 查询串时反斜杠容易被中间层吃掉。
     * 服务端 `isInside()` 仍然会做工作区边界校验，越界照样 403。
     */
    function wsParam(ws) {
      return ws ? String(ws).replace(/\\/g, '/') : ''
    }

    /** 设计文档选择器（模态）。 */
    function Picker(props) {
      const t = props.t
      const workspace = props.workspace || ''
      const [rel, setRel] = React.useState('')
      const [data, setData] = React.useState(null)
      const [sel, setSel] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState(null)
      const [conflict, setConflict] = React.useState(false)

      const browse = React.useCallback(
        (nextRel) => {
          setMsg(null)
          setSel(null)
          setConflict(false)
          fetchJson(
            R.list +
              '?rel=' + encodeURIComponent(nextRel) +
              (workspace ? '&workspace=' + encodeURIComponent(wsParam(workspace)) : ''),
          )
            .then((d) => {
              if (d.error) {
                setMsg(d.error + (d.detail ? ': ' + d.detail : ''))
                return
              }
              setRel(d.rel)
              setData(d)
            })
            .catch((e) => setMsg(String((e && e.message) || e)))
        },
        [workspace],
      )

      React.useEffect(() => {
        browse('')
      }, [browse])

      const doBind = (force) => {
        if (sel === null) return
        setBusy(true)
        setMsg(null)
        fetchJson(R.bind, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // workspace 必须一起提交：宿主缺省解析到的是部署默认根，不是会话工作区
          body: JSON.stringify({ rel: sel, force: force === true, workspace: wsParam(workspace) }),
        })
          .then((d) => {
            setBusy(false)
            if (!d || d.error) {
              setMsg((d && d.error) || 'bind failed')
              return
            }
            props.onBound(d)
          })
          .catch((e) => {
            setBusy(false)
            const text = String((e && e.message) || e)
            // 409 = 台账已存在：后端返回的是结构化 JSON，只是被 fetchJson 归成了错误
            if (text.startsWith('HTTP 409')) {
              setConflict(true)
              return
            }
            setMsg(text)
          })
      }

      const crumbs = (rel || '').split('/').filter(Boolean)
      const list = data || { dirs: [], files: [] }

      return h(
        'div',
        { className: 'dlg-mask', onClick: (e) => e.target === e.currentTarget && props.onClose() },
        h(
          'div',
          { className: 'dlg-modal' },
          h('div', { className: 'dlg-head' }, h('h3', { className: 'dlg-title' }, t('pick'))),
          h('div', { className: 'dlg-dim' }, t('pickHint')),

          // 面包屑
          h(
            'div',
            { className: 'dlg-crumb' },
            h('button', { type: 'button', className: 'dlg-btn', onClick: () => browse('') }, t('root')),
            crumbs.map((c, i) =>
              h(
                'span',
                { key: i },
                h('span', { className: 'dlg-dim' }, '/'),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dlg-btn',
                    onClick: () => browse(crumbs.slice(0, i + 1).join('/')),
                  },
                  c,
                ),
              ),
            ),
            rel !== '' ? h('button', { type: 'button', className: 'dlg-btn', onClick: () => browse(data && data.parentRel !== null ? data.parentRel : '') }, t('up')) : null,
          ),

          // 目录 / 文件列表
          h('div', { className: 'dlg-dim dlg-code' }, t('searching') + ': ' + (data && data.workspaceRoot ? data.workspaceRoot : workspace || '?')),
          h(
            'div',
            { className: 'dlg-list' },
            workspace
              ? null
              : h('div', { className: 'dlg-warn', style: { padding: '8px' } }, t('noWorkspace')),
            (list.dirs || []).length === 0 && (list.files || []).length === 0
              ? h('div', { className: 'dlg-dim', style: { padding: '8px' } }, t('empty'))
              : null,
            // 当前目录本身可作为选择：点空白处选定"此文件夹"
            h(
              'div',
              {
                className: 'dlg-row' + (sel === rel ? ' sel' : ''),
                onClick: () => setSel(rel),
                title: t('bind') + ': ' + (rel || t('root')),
              },
              h('span', { className: 'dlg-tag' }, 'DIR'),
              h('span', { className: 'dlg-code' }, rel === '' ? t('root') : rel),
              h('span', { className: 'dlg-dim' }, '— ' + t('bind')),
            ),
            (list.dirs || []).map((d) =>
              h(
                'div',
                { key: 'd:' + d.rel, className: 'dlg-row' + (sel === d.rel ? ' sel' : '') },
                h('span', { className: 'dlg-tag' }, 'DIR'),
                h(
                  'span',
                  {
                    className: 'dlg-code',
                    style: { flex: 1 },
                    onClick: () => browse(d.rel),
                    title: '进入 ' + d.rel,
                  },
                  d.name + '/',
                ),
                d.mdCount > 0 ? h('span', { className: 'dlg-dim' }, d.mdCount + ' ' + t('mdCount')) : null,
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dlg-btn',
                    onClick: (e) => {
                      e.stopPropagation()
                      setSel(d.rel)
                    },
                  },
                  t('bind'),
                ),
              ),
            ),
            (list.files || []).map((f) =>
              h(
                'div',
                {
                  key: 'f:' + f.rel,
                  className: 'dlg-row' + (sel === f.rel ? ' sel' : ''),
                  onClick: () => setSel(f.rel),
                },
                h('span', { className: 'dlg-tag' }, 'MD'),
                h('span', { className: 'dlg-code', style: { flex: 1 } }, f.name),
                h('span', { className: 'dlg-dim' }, Math.round((f.bytes || 0) / 1024) + ' KB'),
              ),
            ),
          ),

          h('div', { className: 'dlg-kv' }, h('span', { className: 'dlg-dim' }, 'rel ='), h('span', { className: 'dlg-code' }, sel === null ? '(未选择)' : sel === '' ? '(' + t('root') + ')' : sel)),

          conflict
            ? h('div', { className: 'dlg-card' }, h('div', { className: 'dlg-warn' }, t('forceBind')))
            : null,
          msg ? h('div', { className: 'dlg-warn' }, msg) : null,

          h(
            'div',
            { className: 'dlg-foot' },
            h('button', { type: 'button', className: 'dlg-btn', onClick: props.onClose }, t('cancel')),
            conflict
              ? h(
                  'button',
                  { type: 'button', className: 'dlg-btn dlg-primary', disabled: busy, onClick: () => doBind(true) },
                  busy ? t('binding') : t('rebuild'),
                )
              : h(
                  'button',
                  {
                    type: 'button',
                    className: 'dlg-btn dlg-primary',
                    disabled: busy || sel === null,
                    onClick: () => doBind(false),
                  },
                  busy ? t('binding') : t('bind'),
                ),
          ),
        ),
      )
    }

    /** 侧栏图标：分支/树形。 */
    function PanelIcon(props) {
      const size = (props && props.size) || 16
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M4 2.5v11M4 5.5h4.5M4 10.5h4.5',
          stroke: 'currentColor',
          strokeWidth: '1.3',
          strokeLinecap: 'round',
        }),
        h('circle', { cx: '12', cy: '5.5', r: '1.6', stroke: 'currentColor', strokeWidth: '1.3' }),
        h('circle', { cx: '12.5', cy: '10.5', r: '1.6', stroke: 'currentColor', strokeWidth: '1.3' }),
      )
    }

    /** 主面板。 */
    function LedgerPanel(props) {
      const t = (k) => ((props && props.t ? props.t(k) : undefined) ?? zh[k] ?? k)
      const [state, setState] = React.useState({ phase: 'loading', data: null, error: null })
      const [picking, setPicking] = React.useState(false)

      const load = React.useCallback(() => {
        setState({ phase: 'loading', data: null, error: null })
        fetchJson(R.status)
          .then((data) => setState({ phase: 'ready', data, error: null }))
          .catch((e) => setState({ phase: 'error', data: null, error: String((e && e.message) || e) }))
      }, [])

      React.useEffect(() => {
        load()
      }, [load])

      /** 当前会话工作区（由状态接口解析，选择器取数时必须显式回传）。 */
      const panelWorkspace = (state.data && state.data.workspaceRoot) || ''

      const head = h(
        'div',
        { className: 'dlg-head' },
        h('h2', { className: 'dlg-title' }, t('title')),
        h('button', { type: 'button', className: 'dlg-btn', onClick: load }, t('refresh')),
        h(
          'button',
          {
            type: 'button',
            className: 'dlg-btn dlg-primary',
            // 工作区未知时不给开选择器：否则宿主会退化成"部署默认根"，弹窗里什么都看不到
            disabled: !panelWorkspace,
            title: panelWorkspace || 'workspace unknown',
            onClick: () => setPicking(true),
          },
          t('pick'),
        ),
      )

      const picker = picking
        ? h(Picker, {
            t,
            // 关键：把状态里解析出来的**会话工作区**传下去，面板取数必须显式带上它
            workspace: panelWorkspace,
            onClose: () => setPicking(false),
            onBound: () => {
              setPicking(false)
              load()
            },
          })
        : null

      if (state.phase === 'loading') {
        return h('div', { className: 'dlg-root' }, head, h('div', { className: 'dlg-dim' }, t('loading')), picker)
      }
      if (state.phase === 'error') {
        return h('div', { className: 'dlg-root' }, head, h('div', { className: 'dlg-warn' }, t('error') + ': ' + state.error), picker)
      }

      const d = state.data || {}
      if (!d.bound) {
        return h(
          'div',
          { className: 'dlg-root' },
          head,
          h(
            'div',
            { className: 'dlg-card' },
            h('div', null, t('notBound')),
            h('div', { className: 'dlg-dim' }, t('pickHint')),
            // 明确显示"浏览的是哪个工作区"：缺省解析会落到部署默认根（profile 目录），
            // 那样弹窗里会是空的 —— 显示出来才能一眼看出用错了根。
            h('div', { className: 'dlg-dim dlg-code' }, t('searching') + ': ' + (panelWorkspace || '?')),
            panelWorkspace ? null : h('div', { className: 'dlg-warn' }, t('noWorkspace')),
          ),
          picker,
        )
      }

      const totals = d.totals || {}
      const design = d.design || {}
      return h(
        'div',
        { className: 'dlg-root' },
        head,
        h(
          'div',
          { className: 'dlg-card' },
          h('div', null, t('designDoc') + ': ' + String(design.input || '')),
          h(
            'div',
            { className: 'dlg-kv' },
            h('span', null, t('systems') + ' ' + (d.systems || []).length),
            h('span', null, t('nodes') + ' ' + (totals.nodes || 0)),
            h('span', null, t('progress') + ' ' + (totals.done || 0) + '/' + (totals.nodes || 0)),
            h('span', { className: totals.openBugs > 0 ? 'dlg-warn' : 'dlg-dim' }, t('openBugs') + ' ' + (totals.openBugs || 0)),
          ),
          h('div', { className: 'dlg-dim' }, d.hasTaskPrompt ? t('taskPrompt') : t('noTaskPrompt')),
        ),
        (d.sections || []).length > 0
          ? h(
              'div',
              { className: 'dlg-card' },
              h('div', null, t('sections')),
              (d.sections || []).map((s) =>
                h(
                  'div',
                  { key: s.id, className: 'dlg-sys' },
                  h('span', null, s.name),
                  h('span', { className: 'dlg-dim' }, '≈' + Math.round((s.docTokens || 0) / 1000) + 'k tok'),
                ),
              ),
            )
          : null,
        h(
          'div',
          { className: 'dlg-card' },
          h('div', null, t('systems')),
          (d.systems || []).map((s) => {
            const pct = s.total > 0 ? Math.round((s.done / s.total) * 100) : 0
            return h(
              'div',
              { key: s.id, className: 'dlg-sys' },
              s.marked ? h('span', { className: 'dlg-mark' }, '●') : h('span', { className: 'dlg-dim' }, '○'),
              h('span', { style: { minWidth: '11em' } }, s.name),
              h('span', { className: 'dlg-bar' }, h('i', { style: { width: pct + '%' } })),
              h('span', { className: 'dlg-dim' }, s.done + '/' + s.total),
              s.openBugs > 0 ? h('span', { className: 'dlg-warn' }, 'bug:' + s.openBugs) : null,
              h('span', { className: 'dlg-dim' }, '≈' + Math.round((s.docTokens || 0) / 1000) + 'k tok'),
            )
          }),
        ),
        h(
          'div',
          { className: 'dlg-card' },
          h('div', null, t('marked')),
          (d.markedNodes || []).length === 0
            ? h('div', { className: 'dlg-dim' }, t('noMarked'))
            : (d.markedNodes || []).map((m) => h('div', { key: m.id, className: 'dlg-code' }, m.name + '  (' + m.id + ')')),
          h('div', { className: 'dlg-dim' }, t('updateHint')),
        ),
        picker,
      )
    }

    /**
     * 真正的注册逻辑。
     *
     * ⚠️ **绝不从这里抛出**：宿主把 apply() 的异常视为该客户端条目启动失败
     * （`web boot: N entry did not activate`），实测能连带把宿主的
     * `dsh-client-ui-sidebar` 一起拖垮、导致应用起不来。所有可能失败的动作
     * 都在内部 try/catch，外层 `apply` 再兜一层。
     */
    function applyInner(ctx) {
      {
        // ── 翻译 ──
        // 真实 API 是 `ctx.locale.register(ns, dict)` 与 `ctx.locale.bind(ns)`；
        // **`ctx.locale.get` 不存在** —— 曾经误用它，在 apply() 里同步抛出
        // `TypeError: ctx.locale.get is not a function`，导致客户端插件树整体
        // 启动失败、宿主 `dsh-client-ui-sidebar` 条目 failed。取翻译一律走
        // bind + 本地兜底，并且**绝不让它冒出 apply()**。
        let t = (k) => zh[k] ?? k
        try {
          ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'design-ledger: dictionaries')
        } catch (e) {
          console.warn('[design-ledger] locale.register failed:', e)
        }
        try {
          const bound = ctx.locale.bind(LOCALE_NS)
          if (typeof bound === 'function') t = (k) => bound(k)
        } catch (e) {
          console.warn('[design-ledger] locale.bind failed, falling back to zh:', e)
        }

        // ── 样式 ──
        try {
          ctx.effect(() => {
            const style = document.createElement('style')
            style.setAttribute('data-plugin', 'dsh-design-ledger')
            style.textContent = CSS
            document.head.appendChild(style)
            return () => {
              style.remove()
            }
          }, 'design-ledger: panel styles')
        } catch (e) {
          console.warn('[design-ledger] style injection failed:', e)
        }

        // ── 槽位注册 ──
        // 每处单独 try/catch：**任何一处失败都不能让 apply() 抛出**，否则会
        // 连带把宿主的客户端插件树（含 dsh-client-ui-sidebar）拖垮。
        try {
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              {
                name: 'sidebar.panellist',
                id: PANEL_ID,
                // order 2：排在宿主「插件」(0) 与 skill-mcp-panel「技能/MCP」(1) 之后
                order: 2,
                label: () => t('nav'),
              },
              PanelIcon,
            ),
          )
        } catch (e) {
          console.warn('[design-ledger] sidebar.panellist registration failed:', e)
        }

        try {
          ctx.slots.inject('main', () =>
            ctx.slots.register(
              {
                name: 'main',
                key: PANEL_ID,
                inject: () => ({ t }),
              },
              LedgerPanel,
            ),
          )
        } catch (e) {
          console.warn('[design-ledger] main panel registration failed:', e)
        }
      }
    }

    return {
      inject: ['slots', 'locale'],
      /**
       * 最外层兜底：即使 applyInner 内部有未预料的异常，也只是本插件降级，
       * **绝不让宿主的客户端插件树（含 dsh-client-ui-sidebar）启动失败**。
       */
      apply(ctx) {
        try {
          applyInner(ctx)
        } catch (e) {
          console.warn('[design-ledger] client half failed to apply; plugin disabled:', e)
        }
      },
    }
  },
})
