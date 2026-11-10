window.__ModuleLoader__.load({
  id: 'dsh-evolution',
  factory: (require) => {
    const React = require('react')
    const { createElement: h, useCallback, useEffect, useRef, useState } = React
    const API = '/dsh-evolution/api'

    async function request(path, body, signal) {
      const res = await fetch(`${API}${path}`, body === undefined ? { signal } : {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.ok === false) {
        const error = new Error([data.error, data.hint].filter(Boolean).join('：') || `HTTP ${res.status}`)
        error.code = data.code
        throw error
      }
      return data
    }

    // Skill candidates are staged by the owner and promoted only from its panel;
    // this is the same-origin, session-authenticated review API.
    const HARNESS_API = '/dsh-continual-harness/api'

    async function harnessRequest(path, body, signal) {
      const res = await fetch(`${HARNESS_API}${path}`, body === undefined ? { signal } : {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.ok === false) {
        const error = new Error([data.error, data.hint].filter(Boolean).join('：') || `HTTP ${res.status}`)
        error.code = data.code
        throw error
      }
      return data
    }

    const KINDS = ['prompt', 'memory', 'skill', 'subagent']
    const TABS = [
      ['overview', '概览'],
      ['approval', '审批'],
      ['dream', 'AutoDream'],
      ['entries', '条目'],
      ['history', '精炼记录'],
      ['records', '进化记录'],
      ['sessions', '会话'],
      ['benchmark', '基准'],
      ['settings', '设置'],
    ]

    const EVO_CSS = `
      .evolution-panel{--evo-line:var(--dsw-alias-border-l2,rgba(127,127,127,.24));--evo-line-strong:var(--dsw-alias-border-l3,rgba(127,127,127,.4));--evo-brand:var(--dsw-alias-brand-primary,#2f6fed);--evo-ok:var(--dsw-alias-state-success-primary,#1a7f4b);--evo-warn:var(--dsw-alias-state-warn-primary,#a86a00);--evo-bad:var(--dsw-alias-state-error-primary,#c43b3b);--evo-fg:var(--dsw-alias-label-primary,#1f2329);--evo-fg2:var(--dsw-alias-label-secondary,rgba(0,0,0,.64));--evo-fg3:var(--dsw-alias-label-tertiary,rgba(0,0,0,.46));--evo-bg:var(--dsw-alias-bg-base,#fff);--evo-bg1:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.04));--evo-bg2:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));height:100%;display:flex;flex-direction:column;overflow:hidden;box-sizing:border-box;background:var(--evo-bg);color:var(--evo-fg);font:13.5px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
      .evolution-panel *{box-sizing:border-box}
      .evolution-panel h1,.evolution-panel h2,.evolution-panel h3,.evolution-panel p{margin:0}
      .evolution-panel a{color:var(--evo-brand)}
      .evo-head{flex:none;display:flex;align-items:flex-start;justify-content:space-between;gap:18px;padding:15px 22px 13px;border-bottom:1px solid var(--evo-line);background:linear-gradient(135deg,rgba(47,111,237,.10),rgba(255,122,162,.07) 58%,transparent)}
      .evo-head-main{min-width:0}
      .evo-kicker{margin:0 0 2px;font-size:10.5px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--evo-fg3)}
      .evo-head h1{font-size:19px;font-weight:660;letter-spacing:.01em}
      .evo-sub{margin-top:3px;font-size:12px;color:var(--evo-fg2);max-width:660px}
      .evo-head-actions{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:8px 12px;padding-top:2px}
      .evo-dots{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px 12px;max-width:100%}
      .evo-dot{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--evo-fg2);white-space:nowrap}
      .evo-dot::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--evo-fg3);box-shadow:0 0 0 3px rgba(127,127,127,.12);flex:none}
      .evo-dot.ok::before{background:var(--evo-ok);box-shadow:0 0 0 3px rgba(26,127,75,.16)}
      .evo-dot.warn::before{background:var(--evo-warn);box-shadow:0 0 0 3px rgba(168,106,0,.16)}
      .evo-dot.bad::before{background:var(--evo-bad);box-shadow:0 0 0 3px rgba(196,59,59,.16)}
      .evo-chip{display:inline-flex;align-items:center;gap:4px;padding:1px 7px;border-radius:999px;border:1px solid var(--evo-line-strong);font-size:11px;line-height:1.6;color:var(--evo-fg2);background:rgba(127,127,127,.06);white-space:nowrap}
      .evo-chip.ok{color:var(--evo-ok);border-color:rgba(26,127,75,.35);background:rgba(26,127,75,.1)}
      .evo-chip.warn{color:var(--evo-warn);border-color:rgba(168,106,0,.35);background:rgba(168,106,0,.1)}
      .evo-chip.bad{color:var(--evo-bad);border-color:rgba(196,59,59,.35);background:rgba(196,59,59,.1)}
      .evolution-panel button.evo-chip{appearance:none;font:inherit;font-size:11px;cursor:pointer}
      .evo-alerts{flex:none;display:flex;flex-direction:column;gap:6px;padding:8px 22px 0}
      .evo-alerts:empty{display:none;padding:0}
      .evo-alert{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:8px 11px;border-radius:9px;border:1px solid var(--evo-line-strong);background:var(--evo-bg2);font-size:12px;color:var(--evo-fg2)}
      .evo-alert.block{flex-direction:column;align-items:stretch;gap:6px}
      .evo-alert.danger{border-color:rgba(196,59,59,.35);background:rgba(196,59,59,.08);color:var(--evo-bad)}
      .evo-alert.warn{border-color:rgba(168,106,0,.35);background:rgba(168,106,0,.08);color:var(--evo-warn)}
      .evo-tabs{flex:none;display:flex;gap:2px;padding:0 14px;margin-top:8px;overflow-x:auto;overscroll-behavior-x:contain;scrollbar-width:none;border-bottom:1px solid var(--evo-line);background:var(--evo-bg1)}
      .evo-tabs::-webkit-scrollbar{display:none}
      .evo-tab{flex:none;appearance:none;background:none;border:0;border-bottom:2px solid transparent;border-radius:6px 6px 0 0;margin:0;padding:9px 12px 7px;font:inherit;font-size:12.5px;font-weight:500;color:var(--evo-fg2);cursor:pointer;transition:background .15s,color .15s,border-color .15s}
      .evo-tab:hover{background:rgba(127,127,127,.08);color:var(--evo-fg)}
      .evo-tab.on{color:var(--evo-brand);border-bottom-color:var(--evo-brand);font-weight:650}
      .evo-tab:focus-visible{outline:2px solid var(--evo-brand);outline-offset:-2px}
      .evo-body{flex:1;min-height:0;overflow:auto;padding:14px 20px 26px;scrollbar-gutter:stable}
      .evo-stack{display:flex;flex-direction:column;gap:13px;width:100%;max-width:1060px;margin:0 auto;outline:0}
      .evo-card{margin:0;padding:13px 15px 15px;border:1px solid var(--evo-line);border-radius:12px;background:var(--evo-bg1);box-shadow:0 1px 2px rgba(16,24,40,.04);min-width:0}
      .evo-card-title{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:14px;font-weight:660;margin-bottom:6px}
      .evo-card-actions{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
      .evo-card-body{display:flex;flex-direction:column;gap:8px;min-width:0}
      .evo-card-body>p{font-size:12px;color:var(--evo-fg2);word-break:break-word}
      .evo-card-body>.evo-btn,.evo-card-body>.evo-linkbtn{align-self:flex-start}
      .evo-card-subtitle{font-size:12.5px;font-weight:650}
      .evo-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:9px 12px}
      .evo-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:9px 12px}
      .evo-metric{font-size:22px;font-weight:650;line-height:1.15;letter-spacing:-.01em;font-variant-numeric:tabular-nums;word-break:break-word}
      .evo-metric-label{display:block;margin-top:2px;font-size:11px;font-weight:400;letter-spacing:0;color:var(--evo-fg3)}
      .evo-field{display:flex;flex-direction:column;gap:4px;margin:0;font-size:11.5px;color:var(--evo-fg3);min-width:140px;flex:1 1 160px}
      .evo-field>span{font-size:11.5px;color:var(--evo-fg3)}
      .evo-field>input,.evo-field>select,.evo-field>textarea{width:100%}
      .evo-field>.evo-btn{align-self:flex-start}
      .evo-check{display:inline-flex;align-items:flex-start;gap:7px;margin:2px 0;font-size:12.5px;color:var(--evo-fg);cursor:pointer}
      .evo-check input{width:15px;height:15px;margin:2px 0 0;accent-color:var(--evo-brand);flex:none}
      .evolution-panel input[type=text],.evolution-panel input[type=number],.evolution-panel input:not([type]),.evolution-panel select,.evolution-panel textarea{font:inherit;font-size:12.5px;color:var(--evo-fg);background:var(--evo-bg);border:1px solid var(--evo-line-strong);border-radius:8px;padding:5px 9px;height:31px;outline:none;transition:border-color .15s,box-shadow .15s}
      .evolution-panel textarea{height:auto;min-height:76px;padding:8px 10px;resize:vertical;line-height:1.55}
      .evolution-panel input[type=checkbox]{accent-color:var(--evo-brand)}
      .evolution-panel input[type=text]:focus,.evolution-panel input[type=number]:focus,.evolution-panel input:not([type]):focus,.evolution-panel select:focus,.evolution-panel textarea:focus{border-color:var(--evo-brand);box-shadow:0 0 0 3px rgba(47,111,237,.16)}
      .evolution-panel input:disabled,.evolution-panel select:disabled,.evolution-panel textarea:disabled{opacity:.55;cursor:not-allowed}
      .evo-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:5px;height:31px;margin:0;padding:0 12px;border-radius:8px;border:1px solid var(--evo-line-strong);background:var(--evo-bg);color:var(--evo-fg);font:inherit;font-size:12px;font-weight:550;white-space:nowrap;cursor:pointer;transition:background .15s,border-color .15s,color .15s}
      .evo-btn:hover:not(:disabled){background:var(--evo-bg2);border-color:var(--evo-fg3)}
      .evo-btn:focus-visible{outline:2px solid var(--evo-brand);outline-offset:1px}
      .evo-btn:disabled{opacity:.45;cursor:not-allowed}
      .evo-btn-primary{background:var(--evo-brand);border-color:var(--evo-brand);color:var(--evo-bg)}
      .evo-btn-primary:hover:not(:disabled){background:var(--evo-brand);border-color:var(--evo-brand);filter:brightness(1.07)}
      .evo-btn-danger{color:var(--evo-bad);border-color:rgba(196,59,59,.42);background:rgba(196,59,59,.07)}
      .evo-btn-danger:hover:not(:disabled){background:rgba(196,59,59,.14);border-color:var(--evo-bad)}
      .evo-btn-quiet{border-style:dashed;color:var(--evo-fg2)}
      .evo-linkbtn{appearance:none;display:inline-flex;align-items:center;gap:4px;margin:0;padding:2px 5px;border:0;border-radius:6px;background:transparent;color:var(--evo-brand);font:inherit;font-size:12px;cursor:pointer}
      .evo-linkbtn:hover:not(:disabled){background:rgba(127,127,127,.1);text-decoration:underline}
      .evo-linkbtn:focus-visible{outline:2px solid var(--evo-brand);outline-offset:1px}
      .evo-linkbtn.danger{color:var(--evo-bad)}
      .evo-linkbtn:disabled{opacity:.45;cursor:not-allowed}
      .evo-row{display:flex;flex-wrap:wrap;align-items:center;gap:7px;min-width:0}
      .evo-row.between{justify-content:space-between;row-gap:6px}
      .evo-rec{padding:11px 12px;border:1px solid var(--evo-line);border-radius:10px;background:var(--evo-bg);display:flex;flex-direction:column;gap:5px;min-width:0}
      .evo-list{display:flex;flex-direction:column;gap:8px}
      .evo-rec strong{font-size:13px;font-weight:620;word-break:break-word}
      .evo-rec p{font-size:12.5px;color:var(--evo-fg2);white-space:pre-wrap;word-break:break-word}
      .evo-text{margin:0;font-size:12.5px;color:var(--evo-fg2);white-space:pre-wrap;word-break:break-word}
      .evo-meta{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;font-size:11px;color:var(--evo-fg3);word-break:break-word}
      .evo-mono{font:11.5px/17px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--evo-fg3);word-break:break-all}
      .evo-col{display:flex;flex-direction:column;gap:3px}
      .evo-pre{margin:0;padding:9px 11px;max-height:280px;overflow:auto;border:1px solid var(--evo-line);border-radius:9px;background:var(--evo-bg2);color:var(--evo-fg);font:11.5px/17px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
      .evo-hint{font-size:11.5px;color:var(--evo-fg3);word-break:break-word}
      .evo-empty{padding:14px;text-align:center;font-size:12px;color:var(--evo-fg3);border:1px dashed var(--evo-line-strong);border-radius:10px}
      .evo-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
      .evo-table{width:100%;border-collapse:collapse;font-size:12px}
      .evo-table th{text-align:left;padding:6px 8px;border-bottom:1px solid var(--evo-line);color:var(--evo-fg3);font-weight:500;white-space:nowrap}
      .evo-table td{padding:6px 8px;border-bottom:1px solid var(--evo-line);vertical-align:top;word-break:break-word}
      .evo-table tr:last-child td{border-bottom:0}
      .evo-table tbody tr.clickable{cursor:pointer}
      .evo-table tbody tr.clickable:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08))}
      .evo-table tbody tr.on{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08))}
      .evo-bar{display:flex;height:6px;flex:1 1 80px;min-width:60px;max-width:100%;border-radius:999px;background:rgba(127,127,127,.18);overflow:hidden}
      .evo-bar-fill{height:100%;border-radius:999px;background:var(--evo-brand);transition:width .3s ease}
      .evo-bar-label{flex:0 1 110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;color:var(--evo-fg3)}
      .evo-bar-count{min-width:28px;text-align:right;font-size:11.5px;color:var(--evo-fg3);font-variant-numeric:tabular-nums}
      .evo-toast{position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:60;display:flex;align-items:center;gap:8px;max-width:min(560px,92vw);padding:9px 14px;border-radius:10px;border:1px solid var(--evo-line-strong);background:var(--evo-bg);color:var(--evo-fg);font-size:12.5px;box-shadow:0 8px 28px rgba(16,24,40,.18);animation:evo-in .18s ease}
      .evo-toast::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--evo-ok);flex:none}
      .evo-toast.danger::before{background:var(--evo-bad);box-shadow:0 0 0 3px rgba(196,59,59,.16)}
      .evo-toast-text{flex:1 1 auto;min-width:0;word-break:break-word}
      @keyframes evo-in{from{opacity:0;transform:translate(-50%,-6px)}to{opacity:1;transform:translate(-50%,0)}}
      @media(max-width:760px){.evo-head{flex-direction:column;gap:8px;padding:13px 14px 11px}.evo-head-actions{justify-content:flex-start}.evo-dots{max-width:100%;justify-content:flex-start}.evo-alerts{padding:7px 14px 0}.evo-tabs{padding:0 8px;margin-top:7px}.evo-body{padding:11px 12px 20px}.evo-grid,.evo-metrics{grid-template-columns:repeat(auto-fit,minmax(140px,1fr))}.evo-card-body>.evo-row>.evo-field{flex:1 1 100%}.evo-btn{height:30px;padding:0 10px}.evo-bar-label{flex:1 1 90px}}
      @media(prefers-reduced-motion:reduce){.evolution-panel *{transition:none!important;animation:none!important}}
    `

    const ROW_CSS = `
      .evo-settings-row{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
      .evo-settings-main{min-width:0}
      .evo-settings-title{font-size:14px;line-height:20px}
      .evo-settings-desc{margin-top:4px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
      .evo-settings-right{display:flex;align-items:center;flex-wrap:wrap;justify-content:flex-end;gap:10px}
      .evo-settings-chip{display:inline-flex;align-items:center;padding:1px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);font-size:11px;line-height:1.7;color:var(--dsw-alias-label-secondary);background:rgba(127,127,127,.06);white-space:nowrap}
      .evo-settings-chip.ok{color:var(--dsw-alias-state-success-primary,#1a7f4b);border-color:rgba(26,127,75,.35);background:rgba(26,127,75,.1)}
      .evo-settings-chip.warn{color:var(--dsw-alias-state-warn-primary,#a86a00);border-color:rgba(168,106,0,.35);background:rgba(168,106,0,.1)}
      .evo-settings-chip.bad{color:var(--dsw-alias-state-error-primary,#c43b3b);border-color:rgba(196,59,59,.35);background:rgba(196,59,59,.1)}
      .evo-settings-error{margin-top:5px;color:var(--dsw-alias-state-error-primary,#c43b3b);font-size:11.5px;word-break:break-word}
      .evo-settings-check{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary)}
      @media(max-width:760px){.evo-settings-row{flex-direction:column;align-items:flex-start;gap:10px}.evo-settings-right{justify-content:flex-start}}
    `

    function button(label, onClick, options = {}) {
      const kind = options.kind || ''
      const base = kind === 'link' ? 'evo-linkbtn' : 'evo-btn'
      const className = [base, kind === 'primary' && 'evo-btn-primary', kind === 'danger' && 'evo-btn-danger', kind === 'quiet' && 'evo-btn-quiet', options.className].filter(Boolean).join(' ')
      return h('button', { type: 'button', onClick, disabled: options.disabled, className, style: options.style }, label)
    }

    function fmtTime(value) {
      if (!value) return '—'
      const date = new Date(value)
      return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { hour12: false })
    }

    function fmtBytes(value) {
      const bytes = Number(value)
      if (!Number.isFinite(bytes) || bytes < 0) return '—'
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`
      return `${Math.round(bytes / 1024 / 102.4) / 10} MB`
    }

    function shortId(value, size = 8) {
      const text = String(value ?? '')
      return text.length > size ? text.slice(0, size) : text
    }

    function kindLabel(kind) {
      return ({ prompt: '提示', memory: '记忆', skill: '技能', subagent: '子代理' })[kind] ?? kind ?? '未知'
    }

    function fileLabel(key) {
      return ({ state: '状态', history: '精炼', reviews: '复审', log: '日志', usage: '用量' })[key] ?? key
    }

    function outcomeTone(outcome) {
      return outcome === 'approved' ? 'ok' : outcome === 'declined' || outcome === 'failed' ? 'bad' : 'warn'
    }

    function runTone(status) {
      return status === 'ACCEPTED' ? 'ok' : status === 'REJECTED' ? 'bad' : 'warn'
    }

    function clone(value) {
      return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
    }

    function readPath(object, path) {
      let node = object
      for (const key of path) {
        if (node === null || typeof node !== 'object') return undefined
        node = node[key]
      }
      return node
    }

    function writePath(object, path, value) {
      if (path.length === 0) return value
      const [head, ...rest] = path
      const base = object !== null && typeof object === 'object' && !Array.isArray(object) ? object : {}
      return { ...base, [head]: writePath(base[head], rest, value) }
    }

    function diffPatch(base, next) {
      const patch = {}
      const keys = new Set([...Object.keys(base ?? {}), ...Object.keys(next ?? {})])
      for (const key of keys) {
        const before = base?.[key]
        const after = next?.[key]
        if (after !== null && typeof after === 'object' && !Array.isArray(after)) {
          const child = diffPatch(before !== null && typeof before === 'object' && !Array.isArray(before) ? before : {}, after)
          if (Object.keys(child).length) patch[key] = child
        } else if (JSON.stringify(before) !== JSON.stringify(after)) {
          patch[key] = after
        }
      }
      return patch
    }

    async function copyText(value, notify, label = '已复制') {
      try {
        if (!navigator?.clipboard?.writeText) throw new Error('剪贴板不可用')
        await navigator.clipboard.writeText(String(value ?? ''))
        notify('ok', label)
      } catch (failure) {
        notify('error', `复制失败：${failure.message}`)
      }
    }

    function Badge({ children, kind }) {
      const tone = kind === 'warn' ? 'warn' : kind === 'error' ? 'bad' : kind === 'ok' ? 'ok' : ''
      return h('span', { className: tone ? `evo-chip ${tone}` : 'evo-chip' }, children)
    }

    function Card({ title, actions, children }) {
      return h('section', { className: 'evo-card' },
        title || actions ? h('div', { className: 'evo-card-title' },
          title ? h('span', null, title) : h('span'),
          actions ? h('div', { className: 'evo-card-actions' }, actions) : null) : null,
        h('div', { className: 'evo-card-body' }, children))
    }

    function Field({ label, children }) {
      return h('label', { className: 'evo-field' }, h('span', null, label), children)
    }

    function Empty({ children }) {
      return h('div', { className: 'evo-empty' }, children)
    }

    function Failure({ error, onRetry }) {
      if (!error) return null
      return h('div', { className: 'evo-alert danger', role: 'alert' },
        h('span', null, error),
        onRetry ? button('重试', onRetry, { kind: 'quiet' }) : null)
    }

    function Toast({ toast, onClose }) {
      useEffect(() => {
        if (!toast) return undefined
        const timer = setTimeout(onClose, 4000)
        return () => clearTimeout(timer)
      }, [toast, onClose])
      if (!toast) return null
      return h('div', {
        className: toast.kind === 'error' ? 'evo-toast danger' : 'evo-toast',
        role: toast.kind === 'error' ? 'alert' : 'status',
      },
        h('span', { className: 'evo-toast-text' }, toast.text),
        h('button', { type: 'button', className: 'evo-linkbtn', onClick: onClose, 'aria-label': '关闭提示' }, '关闭'))
    }

    function KindBars({ counts }) {
      const rows = KINDS.map(kind => [kindLabel(kind), counts?.[kind] ?? 0])
      const max = Math.max(1, ...rows.map(row => row[1]))
      return h(Card, { title: '条目分布' },
        rows.map(([label, count]) => h('div', { key: label, className: 'evo-row' },
          h('span', { className: 'evo-bar-label' }, label),
          h('div', { className: 'evo-bar' }, h('div', { className: 'evo-bar-fill', style: { width: `${(count / max) * 100}%` } })),
          h('span', { className: 'evo-bar-count' }, count))))
    }

    function HistoryList({ items }) {
      if (!items?.length) return h(Empty, null, '暂无精炼记录')
      return h('div', { className: 'evo-list' }, items.map((record, index) => h('div', {
        key: record.id || `${record.committedAt}-${index}`,
        className: 'evo-rec',
      },
        h('div', { className: 'evo-row between' },
          h('strong', null, record.summary || record.id || '未命名精炼'),
          h('span', { className: 'evo-meta' }, fmtTime(record.committedAt))),
        h('div', { className: 'evo-meta' },
          h(Badge, { kind: 'ok' }, record.scope === 'global' ? '全局' : '会话'),
          record.rollbackOf ? h(Badge, { kind: 'warn' }, `回滚 ${shortId(record.rollbackOf)}`) : null,
          record.id ? h('span', { className: 'evo-mono' }, record.id) : null),
        (record.edits ?? []).length ? h('div', { className: 'evo-meta' }, record.edits.map((edit, editIndex) => h(Badge, {
          key: `${edit.kind}:${edit.id}:${editIndex}`,
          kind: edit.applied ? 'ok' : 'bad',
        }, `${edit.action} ${edit.kind}/${edit.id}`))) : null,
        (record.edits ?? []).filter(edit => edit.error).map((edit, editIndex) => h('p', {
          key: `error-${editIndex}`,
          className: 'evo-hint',
        }, `${edit.id}：${edit.error}`)))))
    }

    function ReviewsList({ items }) {
      if (!items?.length) return h(Empty, null, '暂无复审记录')
      return h('div', { className: 'evo-list' }, items.map((record, index) => h('div', {
        key: `${record.timestamp}-${index}`,
        className: 'evo-rec',
      },
        h('div', { className: 'evo-row between' },
          h('strong', null, `复审 · ${record.trigger ?? 'manual'}`),
          h(Badge, { kind: outcomeTone(record.outcome) }, record.outcome ?? 'unknown')),
        h('div', { className: 'evo-meta' },
          h('span', null, fmtTime(record.timestamp)),
          record.sessionId ? h('span', { className: 'evo-mono' }, shortId(record.sessionId)) : null,
          record.turnsSinceLastReview !== undefined ? h('span', null, `${record.turnsSinceLastReview} 轮`) : null,
          record.refinementId ? h('span', { className: 'evo-mono' }, shortId(record.refinementId)) : null),
        record.rationale ? h('p', { className: 'evo-text' }, record.rationale) : null,
        (record.rejectedEdits ?? []).map((edit, editIndex) => h('p', {
          key: `rejected-${editIndex}`,
          className: 'evo-hint',
        }, `${edit.kind}/${edit.id}：${edit.error}`)))))
    }

    function OverviewTab({ refreshKey, refreshStatus }) {
      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const load = useCallback(async signal => {
        setError('')
        try {
          const result = await request('/overview', undefined, signal)
          if (!signal?.aborted) setData(result.snapshot)
        } catch (failure) {
          if (!signal?.aborted) setError(failure.message)
        }
      }, [])
      useEffect(() => {
        const controller = new AbortController()
        void load(controller.signal)
        return () => controller.abort()
      }, [load, refreshKey])
      const snapshot = data
      return h(React.Fragment, null,
        h(Failure, { error, onRetry: () => { void load() } }),
        !snapshot && !error ? h('p', { className: 'evo-hint' }, '正在读取进化状态…') : null,
        snapshot && snapshot.installed === false ? h('div', { className: 'evo-alert warn block', role: 'status' },
          h('strong', null, '未找到 continual-harness'),
          h('span', null, '运行 npm run setup:components，然后 npm run setup:continual-harness 并重启面板。'),
          h('div', { className: 'evo-row' }, button('重新检查', () => { void refreshStatus() }))) : null,
        snapshot && snapshot.installed && snapshot.active === false ? h('div', { className: 'evo-alert warn block', role: 'status' },
          h('strong', null, 'continual-harness 已安装但未启用'),
          h('span', null, '在侧边栏「插件」页启用该全局插件，或检查 profile 的 cordis.patch.yml。')) : null,
        snapshot?.stateError ? h('div', { className: 'evo-alert danger block', role: 'alert' },
          h('strong', null, '读取进化状态失败'),
          h('span', null, snapshot.stateError)) : null,
        snapshot ? h('div', { className: 'evo-metrics' },
          h(Card, { title: '经验条目' }, h('div', { className: 'evo-metric' }, snapshot.total ?? 0, h('span', { className: 'evo-metric-label' }, '条（四类合计）'))),
          h(Card, { title: '固定条目' }, h('div', { className: 'evo-metric' }, snapshot.pinned ?? 0, h('span', { className: 'evo-metric-label' }, `归档 ${snapshot.archived ?? 0} 条`))),
          h(Card, { title: '精炼记录' }, h('div', { className: 'evo-metric' }, snapshot.historyTotal ?? 0, h('span', { className: 'evo-metric-label' }, '次全局提交'))),
          h(Card, { title: '会话' }, h('div', { className: 'evo-metric' }, snapshot.sessions?.count ?? 0, h('span', { className: 'evo-metric-label' }, '个会话级 store')))) : null,
        snapshot ? h('div', { className: 'evo-grid' },
          h(KindBars, { counts: snapshot.byKind }),
          h(Card, { title: '基准' },
            h('div', { className: 'evo-metrics' },
              h('div', null, h('div', { className: 'evo-metric' }, snapshot.benchmark?.cases ?? 0, h('span', { className: 'evo-metric-label' }, '个用例'))),
              h('div', null, h('div', { className: 'evo-metric' }, snapshot.benchmark?.runs ?? 0, h('span', { className: 'evo-metric-label' }, '次运行')))),
            snapshot.benchmark?.casesError ? h('p', { className: 'evo-hint' }, snapshot.benchmark.casesError) : null,
            h('p', { className: 'evo-hint' }, `冻结用例 ${snapshot.benchmark?.frozen ?? 0} 个；通过 harness_benchmark 工具发起 A/B 验证。`))) : null,
        snapshot ? h(Card, { title: '数据与配置' },
          h('div', { className: 'evo-hint evo-col' },
            h('span', null, `数据根目录：${snapshot.harnessRoot}`),
            h('span', null, `技能目录：${snapshot.skillsDir}`),
            snapshot.documentPath ? h('span', null, `配置写入：${snapshot.documentPath}`) : null),
          h('div', { className: 'evo-meta' },
            Object.entries(snapshot.files ?? {}).filter(([, info]) => info).map(([key, info]) => h(Badge, { key }, `${fileLabel(key)} ${fmtBytes(info.bytes)}`)),
            snapshot.lastActivity ? h(Badge, null, `最近 ${fmtTime(snapshot.lastActivity)}`) : null),
          h('p', { className: 'evo-hint' }, '精炼通过 AutoDream 或手动请求进入普通工单；技能验证通过后启用，人格提案由用户批准。历史版本恢复也需要生成候选并重新验证。')) : null,
        snapshot ? h('div', { className: 'evo-grid' },
          h(Card, { title: '最近精炼' }, h(HistoryList, { items: snapshot.recentHistory })),
          h(Card, { title: '最近复审' }, h(ReviewsList, { items: snapshot.recentReviews }))) : null)
    }

    function EntriesTab({ refreshKey, notify }) {
      const [kind, setKind] = useState('')
      const [q, setQ] = useState('')
      const [items, setItems] = useState(null)
      const [error, setError] = useState('')
      const [expanded, setExpanded] = useState('')
      const [detail, setDetail] = useState(null)
      const [detailError, setDetailError] = useState('')
      const [reload, setReload] = useState(0)
      const load = useCallback(async signal => {
        setError('')
        try {
          const params = new URLSearchParams()
          if (kind) params.set('kind', kind)
          if (q.trim()) params.set('q', q.trim())
          const result = await request(`/entries${params.size ? `?${params}` : ''}`, undefined, signal)
          if (!signal?.aborted) setItems(result.items ?? [])
        } catch (failure) {
          if (!signal?.aborted) setError(failure.message)
        }
      }, [kind, q])
      useEffect(() => {
        const controller = new AbortController()
        void load(controller.signal)
        return () => controller.abort()
      }, [load, refreshKey, reload])
      const toggle = useCallback(async item => {
        const key = `${item.kind}:${item.id}`
        if (expanded === key) {
          setExpanded('')
          setDetail(null)
          setDetailError('')
          return
        }
        setExpanded(key)
        setDetail(null)
        setDetailError('')
        try {
          const result = await request(`/entry?kind=${encodeURIComponent(item.kind)}&id=${encodeURIComponent(item.id)}`)
          setDetail(result.entry)
        } catch (failure) {
          setDetailError(failure.message)
        }
      }, [expanded])
      return h(React.Fragment, null,
        h(Failure, { error, onRetry: () => setReload(value => value + 1) }),
        h(Card, { title: '筛选', actions: button('刷新', () => setReload(value => value + 1), { kind: 'quiet' }) },
          h('div', { className: 'evo-row' },
            h(Field, { label: '类型' }, h('select', { value: kind, 'aria-label': '条目类型', onChange: event => setKind(event.target.value) },
              h('option', { value: '' }, '全部'),
              KINDS.map(item => h('option', { key: item, value: item }, kindLabel(item))))),
            h(Field, { label: '搜索' }, h('input', { value: q, placeholder: 'id / 标题 / 内容', 'aria-label': '搜索条目', onChange: event => setQ(event.target.value) })),
            h('span', { className: 'evo-hint' }, items ? `共 ${items.length} 条` : '读取中…'))),
        !items && !error ? h('p', { className: 'evo-hint' }, '正在读取经验条目…') : null,
        items && items.length === 0 ? h(Empty, null, '还没有经验条目。模型调用 harness_refine 后会出现在这里。') : null,
        items?.length ? h('div', { className: 'evo-list' }, items.map(item => {
          const key = `${item.kind}:${item.id}`
          const open = expanded === key
          return h('div', { key, className: 'evo-rec' },
            h('div', { className: 'evo-row between' },
              h('strong', null, item.title || item.id),
              h('div', { className: 'evo-row' },
                button(open ? '收起' : '查看内容', () => { void toggle(item) }, { kind: 'link' }),
                button('复制 ID', () => { void copyText(item.id, notify) }, { kind: 'link' }))),
            h('div', { className: 'evo-meta' },
              h(Badge, { kind: 'ok' }, kindLabel(item.kind)),
              h('span', { className: 'evo-mono' }, item.id),
              h('span', null, `v${item.version}`),
              h('span', null, fmtTime(item.updatedAt)),
              h('span', null, fmtBytes(item.contentBytes)),
              item.fileCount ? h('span', null, `${item.fileCount} 个附属文件`) : null,
              item.protection ? h(Badge, { kind: item.protection === 'bundled' ? 'warn' : 'ok' }, item.protection) : null,
              item.metadata?.pinned ? h(Badge, { kind: 'ok' }, '固定') : null,
              item.metadata?.lifecycleState === 'archived' ? h(Badge, { kind: 'warn' }, '已归档') : null,
              item.blastRadius ? h(Badge, null, item.blastRadius) : null),
            (item.projects ?? []).length ? h('div', { className: 'evo-meta' }, item.projects.map(project => h(Badge, { key: project }, project))) : null,
            open ? h('div', { className: 'evo-col' },
              detailError ? h('div', { className: 'evo-alert danger', role: 'alert' }, detailError) : null,
              detail ? h(React.Fragment, null,
                h('pre', { className: 'evo-pre' }, detail.content || '（空内容）'),
                detail.description ? h('p', { className: 'evo-hint' }, detail.description) : null,
                detail.files ? h('p', { className: 'evo-hint' }, `附属文件：${Object.keys(detail.files).join('、')}`) : null,
                h('div', { className: 'evo-row' },
                  button('复制内容', () => { void copyText(detail.content ?? '', notify, '已复制条目内容') }, { kind: 'quiet' })))
                : h('p', { className: 'evo-hint' }, '读取中…')) : null)
        })) : null,
        h('p', { className: 'evo-hint' }, '恢复历史技能时，请在手动精炼请求中说明目标版本；恢复内容仍需通过候选、验证与版本冲突检查。'))
    }

    function HistoryTab({ refreshKey }) {
      const [items, setItems] = useState(null)
      const [error, setError] = useState('')
      const [reload, setReload] = useState(0)
      const load = useCallback(async signal => {
        setError('')
        try {
          const result = await request('/history?limit=100', undefined, signal)
          if (!signal?.aborted) setItems(result.items ?? [])
        } catch (failure) {
          if (!signal?.aborted) setError(failure.message)
        }
      }, [])
      useEffect(() => {
        const controller = new AbortController()
        void load(controller.signal)
        return () => controller.abort()
      }, [load, refreshKey, reload])
      return h(React.Fragment, null,
        h(Failure, { error, onRetry: () => setReload(value => value + 1) }),
        h(Card, { title: '全局精炼记录', actions: button('刷新', () => setReload(value => value + 1), { kind: 'quiet' }) },
          !items && !error ? h('p', { className: 'evo-hint' }, '正在读取精炼记录…') : h(HistoryList, { items }),
          h('p', { className: 'evo-hint' }, '记录来自 refinements.jsonl 与全局状态，最近 100 条；内容快照已省略。')))
    }

    const RECORD_GROUPS = [
      ['evidence', '证据', 'evidence'],
      ['proposals', '提案', 'proposal'],
      ['validations', '验证', 'validation'],
      ['publications', '发布', 'publication'],
    ]

    function recordLine(record, kind) {
      const state = record.state || record.verdict
      return h('div', { key: `${kind}:${record.id}:${record.version ?? ''}`, className: 'evo-rec' },
        h('div', { className: 'evo-row between' },
          h('strong', null, record.summary || record.title || record.id),
          state ? h(Badge, null, state) : null),
        h('div', { className: 'evo-meta' },
          h('span', { className: 'evo-mono' }, record.id),
          record.version ? h('span', null, `v${record.version}`) : null,
          record.createdAt ? h('span', null, fmtTime(record.createdAt)) : null))
    }

    function RecordsTab({ refreshKey }) {
      const [ticketId, setTicketId] = useState('')
      const [query, setQuery] = useState('')
      const [kind, setKind] = useState('')
      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const [selected, setSelected] = useState(null)
      const [detail, setDetail] = useState(null)
      const [detailError, setDetailError] = useState('')
      const [reload, setReload] = useState(0)
      useEffect(() => {
        if (!query) { setData(null); return undefined }
        const controller = new AbortController()
        setError('')
        setSelected(null)
        request(`/records?ticket_id=${encodeURIComponent(query)}&limit=200${kind ? `&kind=${kind}` : ''}`, undefined, controller.signal)
          .then(result => { if (!controller.signal.aborted) setData(result) })
          .catch(failure => { if (!controller.signal.aborted) setError(failure.message) })
        return () => controller.abort()
      }, [query, kind, refreshKey, reload])
      useEffect(() => {
        if (!selected) { setDetail(null); setDetailError(''); return undefined }
        const controller = new AbortController()
        setDetail(null)
        setDetailError('')
        request(`/${selected.kind}?id=${encodeURIComponent(selected.id)}&history=1`, undefined, controller.signal)
          .then(result => { if (!controller.signal.aborted) setDetail(result.record) })
          .catch(failure => { if (!controller.signal.aborted) setDetailError(failure.message) })
        return () => controller.abort()
      }, [selected, refreshKey, reload])
      const total = data ? RECORD_GROUPS.reduce((count, [key]) => count + (data[key]?.length ?? 0), 0) : 0
      return h(React.Fragment, null,
        h(Failure, { error, onRetry: () => setReload(value => value + 1) }),
        h(Card, { title: '按工单读取', actions: button('刷新', () => setReload(value => value + 1), { kind: 'quiet' }) },
          h('div', { className: 'evo-row' },
            h(Field, { label: 'Ticket ID' },
              h('input', { value: ticketId, placeholder: 't1', onChange: event => setTicketId(event.target.value) })),
            h(Field, { label: '类型' },
              h('select', { value: kind, onChange: event => setKind(event.target.value) },
                h('option', { value: '' }, '全部'),
                RECORD_GROUPS.map(([, label, value]) => h('option', { key: value, value }, label)))),
            button('读取', () => setQuery(ticketId.trim()), { kind: 'primary' })),
          h('p', { className: 'evo-hint' }, '记录按 Superagent 的 Ticket 归组，只读；提案与发布的版本历史来自 /proposal 与 /publication。')),
        data ? h(Card, { title: `工单 ${data.ticketId}`, actions: button('清除', () => { setTicketId(''); setQuery('') }, { kind: 'quiet' }) },
          total === 0 ? h(Empty, null, '该工单没有进化记录。') : null,
          RECORD_GROUPS.filter(([key]) => data[key]?.length).map(([key, label, value]) =>
            h('div', { key },
              h('h3', { className: 'evo-card-subtitle' }, `${label}（${data[key].length}）`),
              h('div', { className: 'evo-list' }, data[key].map(record => h('div', { key: `${value}:${record.id}` },
                recordLine(record, value),
                value === 'proposal' || value === 'publication'
                  ? h('div', { className: 'evo-row' },
                    button('查看历史', () => setSelected({ kind: value, id: record.id }), { kind: 'quiet' }))
                  : null))))))
          : null,
        selected && (selected.kind === 'proposal' || selected.kind === 'publication')
          ? h(Card, { title: `${selected.kind} ${shortId(selected.id, 12)}`,
            actions: button('关闭', () => setSelected(null), { kind: 'quiet' }) },
            detailError ? h('div', { className: 'evo-alert danger', role: 'alert' }, detailError) : null,
            !detail && !detailError ? h('p', { className: 'evo-hint' }, '正在读取记录…') : null,
            detail ? h(React.Fragment, null,
              h('div', { className: 'evo-rec' }, h('p', null, JSON.stringify(detail.record, null, 2))),
              h('h3', { className: 'evo-card-subtitle' }, '版本历史'),
              (detail.history ?? []).length
                ? h('div', { className: 'evo-list' }, detail.history.map(record => recordLine(record, selected.kind)))
                : h(Empty, null, '没有更多版本')) : null)
          : null)
    }

    function SessionsTab({ refreshKey, notify }) {
      const [items, setItems] = useState(null)
      const [error, setError] = useState('')
      const [selected, setSelected] = useState('')
      const [detail, setDetail] = useState(null)
      const [detailError, setDetailError] = useState('')
      const [reload, setReload] = useState(0)
      useEffect(() => {
        const controller = new AbortController()
        setError('')
        request('/sessions', undefined, controller.signal)
          .then(result => { if (!controller.signal.aborted) setItems(result.items ?? []) })
          .catch(failure => { if (!controller.signal.aborted) setError(failure.message) })
        return () => controller.abort()
      }, [refreshKey, reload])
      useEffect(() => {
        if (!selected) {
          setDetail(null)
          setDetailError('')
          return undefined
        }
        const controller = new AbortController()
        setDetail(null)
        setDetailError('')
        request(`/session?key=${encodeURIComponent(selected)}`, undefined, controller.signal)
          .then(result => { if (!controller.signal.aborted) setDetail(result) })
          .catch(failure => { if (!controller.signal.aborted) setDetailError(failure.message) })
        return () => controller.abort()
      }, [selected, refreshKey, reload])
      return h(React.Fragment, null,
        h(Failure, { error, onRetry: () => setReload(value => value + 1) }),
        h(Card, { title: '会话级 store', actions: button('刷新', () => setReload(value => value + 1), { kind: 'quiet' }) },
          !items && !error ? h('p', { className: 'evo-hint' }, '正在读取会话…') : null,
          items && items.length === 0 ? h(Empty, null, '还没有会话级进化数据。') : null,
          items?.length ? h('div', { className: 'evo-scroll' }, h('table', { className: 'evo-table' },
            h('thead', null, h('tr', null, h('th', null, '会话'), h('th', null, '条目'), h('th', null, '精炼'), h('th', null, '更新时间'))),
            h('tbody', null, items.map(item => h('tr', {
              key: item.key,
              className: `${selected === item.key ? 'on ' : ''}clickable`,
              onClick: () => setSelected(current => current === item.key ? '' : item.key),
            },
              h('td', { className: 'evo-mono' }, item.key),
              h('td', null, item.entries),
              h('td', null, item.refinements),
              h('td', null, fmtTime(item.updatedAt))))))) : null,
          h('p', { className: 'evo-hint' }, '点击一行查看该会话的条目与精炼记录。')),
        selected ? h(Card, {
          title: `会话 ${shortId(selected, 12)}`,
          actions: [button('复制 ID', () => { void copyText(selected, notify) }, { kind: 'link' }), button('关闭', () => setSelected(''), { kind: 'quiet' })],
        },
          detailError ? h('div', { className: 'evo-alert danger', role: 'alert' }, detailError) : null,
          !detail && !detailError ? h('p', { className: 'evo-hint' }, '正在读取会话详情…') : null,
          detail ? h(React.Fragment, null,
            h('div', { className: 'evo-metrics' },
              h('div', null, h('div', { className: 'evo-metric' }, detail.summary?.total ?? 0, h('span', { className: 'evo-metric-label' }, '条会话条目'))),
              h('div', null, h('div', { className: 'evo-metric' }, detail.history?.length ?? 0, h('span', { className: 'evo-metric-label' }, '次精炼')))),
            detail.entries?.length ? h('div', { className: 'evo-list' }, detail.entries.map(entry => h('div', { key: `${entry.kind}:${entry.id}`, className: 'evo-rec' },
              h('div', { className: 'evo-row between' },
                h('strong', null, entry.title || entry.id),
                h(Badge, { kind: 'ok' }, kindLabel(entry.kind))),
              h('div', { className: 'evo-meta' },
                h('span', { className: 'evo-mono' }, entry.id),
                h('span', null, `v${entry.version}`),
                h('span', null, fmtTime(entry.updatedAt)))))) : h(Empty, null, '该会话没有条目'),
            h('h3', { className: 'evo-card-subtitle' }, '精炼记录'),
            h(HistoryList, { items: detail.history })) : null) : null)
    }

    function BenchmarkTab({ refreshKey }) {
      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const [reload, setReload] = useState(0)
      useEffect(() => {
        const controller = new AbortController()
        setError('')
        request('/benchmark?limit=50', undefined, controller.signal)
          .then(result => { if (!controller.signal.aborted) setData(result) })
          .catch(failure => { if (!controller.signal.aborted) setError(failure.message) })
        return () => controller.abort()
      }, [refreshKey, reload])
      const runs = data?.runs ?? []
      const count = status => runs.filter(run => run.status === status).length
      return h(React.Fragment, null,
        h(Failure, { error, onRetry: () => setReload(value => value + 1) }),
        h(Card, { title: '基准概览', actions: button('刷新', () => setReload(value => value + 1), { kind: 'quiet' }) },
          !data && !error ? h('p', { className: 'evo-hint' }, '正在读取基准数据…') : null,
          data ? h('div', { className: 'evo-metrics' },
            h('div', null, h('div', { className: 'evo-metric' }, data.cases?.length ?? 0, h('span', { className: 'evo-metric-label' }, `个用例 · 冻结 ${(data.cases ?? []).filter(item => item.state === 'frozen').length}`))),
            h('div', null, h('div', { className: 'evo-metric' }, runs.length, h('span', { className: 'evo-metric-label' }, '次运行（最近 50）'))),
            h('div', null, h('div', { className: 'evo-metric' }, count('ACCEPTED'), h('span', { className: 'evo-metric-label' }, `通过 · 回归 ${count('REJECTED')}`))),
            h('div', null, h('div', { className: 'evo-metric' }, count('INCONCLUSIVE'), h('span', { className: 'evo-metric-label' }, '不确定')))) : null,
          data?.casesError ? h('div', { className: 'evo-alert warn block' }, data.casesError) : null,
          h('p', { className: 'evo-hint' }, '基准只做报告，不会自动回滚；运行与冻结用例通过 harness_benchmark 工具完成。')),
        data?.cases?.length ? h(Card, { title: '用例' },
          h('div', { className: 'evo-scroll' }, h('table', { className: 'evo-table' },
            h('thead', null, h('tr', null, h('th', null, 'ID'), h('th', null, '标题'), h('th', null, '状态'))),
            h('tbody', null, data.cases.map(item => h('tr', { key: item.id },
              h('td', { className: 'evo-mono' }, item.id),
              h('td', null, item.title),
              h('td', null, h(Badge, { kind: item.state === 'frozen' ? 'ok' : 'warn' }, item.state)))))))) : null,
        data?.runs?.length ? h(Card, { title: '运行记录' },
          h('div', { className: 'evo-scroll' }, h('table', { className: 'evo-table' },
            h('thead', null, h('tr', null, h('th', null, '运行'), h('th', null, '精炼'), h('th', null, '结论'), h('th', null, '参考 / 候选'), h('th', null, '时间'))),
            h('tbody', null, data.runs.map(run => h('tr', { key: run.runId },
              h('td', { className: 'evo-mono' }, shortId(run.runId, 12)),
              h('td', { className: 'evo-mono' }, run.refinementId ? shortId(run.refinementId, 12) : '—'),
              h('td', null, h(Badge, { kind: runTone(run.status) }, run.status)),
              h('td', null, `${run.referenceOverall ?? '—'} / ${run.candidateOverall ?? '—'}`),
              h('td', null, fmtTime(run.createdAt)))))))) : null,
        data?.snapshots?.length ? h(Card, { title: '参考快照' },
          h('div', { className: 'evo-list' }, data.snapshots.map(snapshot => h('div', { key: snapshot.id, className: 'evo-rec' },
            h('div', { className: 'evo-row between' },
              h('span', { className: 'evo-mono' }, snapshot.id),
              h('span', { className: 'evo-meta' }, `${fmtBytes(snapshot.bytes)} · ${fmtTime(snapshot.modifiedAt)}`)))))) : null)
    }

    const DREAM_LABELS = {
      submitted: '请求已提交', accepted: 'Ticket 已接纳', rejected: '已拒绝', deferred: '已延后', paused: '已暂停',
      queued: '等待执行', running: '精炼中', completed: '精炼完成', failed: '失败', blocked: '受阻',
      disabled: '自动精炼已关闭', cooldown: '冷却期内', insufficient_sessions: '新增会话不足',
      insufficient_evidence: '新增一手证据不足', insufficient_primary_events: '新增一手证据不足',
      eligible: '满足启动条件', read: '已读取', used: '已采用', no_durable_value: '无持久价值',
      waiting_retry: '等待重试', published: '已发布', pending: '等待处理',
      filtered: '策略已过滤', submitting: '正在提交 Input', planning: '综合材料中', planned: '候选已生成',
      awaiting_review: '等待人工批准', pending_review: '等待人工批准', staged: '已暂存待审',
      completed_rejected: '精炼完成，候选未获批准',
      request_pending: '已有请求等待处理', startup_failed: '启动检查失败',
    }
    const dreamLabel = value => DREAM_LABELS[value] || value || '—'

    function DreamRun({ run }) {
      return h('details', { className: 'evo-rec' },
        h('summary', null, `${shortId(run.id, 16)} · ${dreamLabel(run.phase)} · ${fmtTime(run.createdAt)}`),
        h('p', { className: 'evo-mono' }, `请求 ${run.requestId || '—'} · Ticket ${run.ticketId || '尚未接纳'}`),
        h('p', { className: 'evo-hint' }, `完成时间：${fmtTime(run.completedAt)}`),
        run.lastError ? h('p', { className: 'evo-text', role: 'alert' }, typeof run.lastError === 'string' ? run.lastError : JSON.stringify(run.lastError)) : null,
        h('h3', { className: 'evo-card-subtitle' }, '证据覆盖与处置'),
        run.coverage?.length ? h('div', { className: 'evo-list' }, run.coverage.map((item, index) => h('div', { key: index, className: 'evo-rec' },
          h('span', null, typeof item === 'string' ? item : `${item.sessionId || item.ref || item.id || index + 1} · ${dreamLabel(item.disposition || item.status)}`),
          h('pre', { className: 'evo-pre' }, JSON.stringify(item, null, 2))))) : h('p', { className: 'evo-hint' }, '尚无覆盖记录'),
        h('h3', { className: 'evo-card-subtitle' }, '候选与发布'),
        run.candidates?.length ? h('div', { className: 'evo-list' }, run.candidates.map((candidate, index) => h('div', { key: candidate.id || index, className: 'evo-rec' },
          h('strong', null, candidate.title || candidate.name || candidate.id || `候选 ${index + 1}`),
          h('p', { className: 'evo-hint' }, `${candidate.kind || candidate.type || '—'} · ${dreamLabel(candidate.status)}`),
          h('pre', { className: 'evo-pre' }, JSON.stringify(candidate, null, 2))))) : h('p', { className: 'evo-hint' }, '尚无候选；完成精炼也可能没有可发布变更。'),
        h('details', null, h('summary', null, '完整运行记录（验证报告、版本与回滚引用）'), h('pre', { className: 'evo-pre' }, JSON.stringify(run, null, 2))))
    }

    /**
     * Human review surface. Staged skill candidates are read and decided here;
     * nothing is published until someone confirms in this tab.
     */
    function ApprovalTab({ refreshKey }) {
      const [items, setItems] = useState(null)
      const [live, setLive] = useState([])
      const [error, setError] = useState('')
      const [busy, setBusy] = useState('')
      const [message, setMessage] = useState('')
      const load = useCallback(async signal => {
        try {
          const result = await harnessRequest('/pending', undefined, signal)
          if (!signal?.aborted) {
            setItems(Array.isArray(result.pending) ? result.pending : [])
            setLive(Array.isArray(result.live) ? result.live : [])
            setError('')
          }
        } catch (failure) { if (!signal?.aborted) setError(failure.message) }
      }, [])
      useEffect(() => {
        const controller = new AbortController()
        void load(controller.signal)
        return () => controller.abort()
      }, [load, refreshKey])
      async function decide(item, decision) {
        if (busy) return
        setBusy(item.candidateId); setError(''); setMessage('')
        try {
          const result = await harnessRequest('/decide', { candidateId: item.candidateId, decision, expectedBundleDigest: item.bundleDigest, confirm: true })
          setMessage(decision === 'approved'
            ? `已批准并发布 ${item.skillId}${result.publication ? ` · v${result.publication.version}` : ''}`
            : `已拒绝 ${item.skillId}`)
          await load()
        } catch (failure) { setError(failure.message) }
        finally { setBusy('') }
      }
      const pendingCard = error
        ? h(Card, { title: '待批技能候选', actions: button('重试', () => { void load() }, { kind: 'quiet' }) }, h('p', { className: 'evo-hint', role: 'alert' }, error))
        : h(Card, { title: items === null ? '待批技能候选' : `待批技能候选（${items.length}）` },
          h('p', { className: 'evo-hint' }, '技能正文会作为模型可见的说明书生效，发布后立即对所有会话可见。请先读完正文，再决定批准或拒绝。人格提案不在这里，见「人格 → 提案」。'),
          items === null ? h('p', { className: 'evo-hint' }, '正在读取技能候选…')
            : items.length === 0 ? h(Empty, null, '暂无待批技能候选。AutoDream 产出的技能候选会出现在这里，确认前不会发布。')
            : h('div', { className: 'evo-list' }, items.map(item => h('div', { key: item.candidateId, className: 'evo-rec' },
              h('div', { className: 'evo-row between' },
                h('strong', null, item.skillId),
                h('span', { className: 'evo-meta' }, fmtTime(item.stagedAt))),
              h('p', { className: 'evo-mono' }, `候选 ${shortId(item.candidateId, 16)} · 摘要 ${shortId(item.bundleDigest, 12)} · 基线 ${item.baselineDigest ? shortId(item.baselineDigest, 12) : '新建'}`),
              item.description ? h('p', null, item.description) : null,
              item.files?.length ? h('p', { className: 'evo-hint' }, `附件：${item.files.join('、')}`) : null,
              h('pre', { className: 'evo-pre' }, item.content),
              h('div', { className: 'evo-row' },
                button(busy === item.candidateId ? '处理中…' : '批准并发布', () => { void decide(item, 'approved') }, { disabled: Boolean(busy), kind: 'primary' }),
                button('拒绝', () => { void decide(item, 'rejected') }, { disabled: Boolean(busy) }))))))
      const liveCard = live.length ? h(Card, { title: '已发布的 harness 技能' },
        h('div', { className: 'evo-list' }, live.map(item => h('div', { key: item.skillId, className: 'evo-rec' },
          h('div', { className: 'evo-row between' }, h('strong', null, item.skillId), h('span', { className: 'evo-chip' }, `v${item.version}`)),
          h('p', { className: 'evo-mono' }, `摘要 ${shortId(item.bundleDigest, 12)} · 决定 ${shortId(item.decisionDigest, 12)}`))))) : null
      return h(React.Fragment, null,
        message ? h('p', { className: 'evo-hint', role: 'status' }, message) : null,
        pendingCard, liveCard)
    }

    function DreamTab({ refreshKey, settingsOnly = false }) {
      const [data, setData] = useState(null)
      const [draft, setDraft] = useState(null)
      const [error, setError] = useState('')
      const [saving, setSaving] = useState(false)
      const [submitting, setSubmitting] = useState(false)
      const [sessionId, setSessionId] = useState('')
      const [crossSession, setCrossSession] = useState(false)
      const [message, setMessage] = useState('')
      const [refreshing, setRefreshing] = useState(false)
      const load = useCallback(async (signal, updateDraft = true) => {
        setRefreshing(true)
        try {
          const result = await request('/dream', undefined, signal)
          if (!signal?.aborted) { setData(result); if (updateDraft) setDraft(clone(result.config)); setError('') }
        } catch (failure) { if (!signal?.aborted) setError(failure.message) }
        finally { if (!signal?.aborted) setRefreshing(false) }
      }, [])
      useEffect(() => {
        const controller = new AbortController()
        void load(controller.signal)
        return () => controller.abort()
      }, [load, refreshKey])
      async function save() {
        if (saving) return
        if (['cooldownHours', 'minSessions', 'minPrimaryEvents'].some(key => !Number.isFinite(draft[key]) || draft[key] < 1 || !Number.isInteger(draft[key]))) {
          setError('冷却时间、会话数和证据数必须为正整数'); return
        }
        setSaving(true); setError(''); setMessage('')
        try {
          await request('/dream/config', draft)
          setMessage('AutoDream 设置已保存；自动检查在下次服务启动时执行。')
          await load(undefined)
        } catch (failure) { setError(failure.message) }
        finally { setSaving(false) }
      }
      async function refine() {
        if (submitting) return
        if (!crossSession && !sessionId.trim()) { setError('请填写精炼会话 ID，或选择跨会话精炼'); return }
        setSubmitting(true); setError(''); setMessage('')
        try {
          const result = await request('/dream/requests', { mode: 'manual', sessionId: sessionId.trim(), crossSession })
          setMessage(`请求已提交：${result.request?.id || result.id || '等待策略评估'}；是否接纳以 Ticket 状态为准。`)
          await load(undefined, false)
        } catch (failure) { setError(failure.message) }
        finally { setSubmitting(false) }
      }
      const configCard = draft ? h(Card, { title: 'AutoDream 设置' },
        h('label', { className: 'evo-check' }, h('input', { type: 'checkbox', checked: draft.enabled === true, disabled: saving, onChange: event => setDraft(current => ({ ...current, enabled: event.target.checked })) }), '启动时自动检查精炼条件'),
        h('div', { className: 'evo-row' }, [['cooldownHours', '冷却时间（小时）'], ['minSessions', '最少新增会话'], ['minPrimaryEvents', '最少新增一手证据']].map(([key, label]) => h(Field, { key, label },
          h('input', { type: 'number', min: 1, step: 1, value: draft[key] ?? '', disabled: saving, onChange: event => setDraft(current => ({ ...current, [key]: event.target.value === '' ? '' : Number(event.target.value) })) })))),
        h('p', { className: 'evo-hint' }, '默认 24 小时、5 个会话、10 条去重一手证据，三项同时满足。完成的自动或手动精炼（含无变更）重新开始冷却；失败不计。'),
        button(saving ? '保存中…' : '保存 AutoDream 设置', save, { disabled: saving, kind: 'primary' })) : null
      return h(React.Fragment, null,
        h(Failure, { error, onRetry: () => { void load(undefined, !draft) } }),
        message ? h('p', { className: 'evo-hint', role: 'status' }, message) : null,
        !data && !error ? h('p', { className: 'evo-hint' }, '正在读取 AutoDream…') : null,
        settingsOnly ? configCard : null,
        data && !settingsOnly ? h(React.Fragment, null,
          h(Card, { title: '启动检查', actions: button(refreshing ? '刷新中…' : '刷新运行状态', () => { void load(undefined, false) }, { disabled: refreshing }) },
            h('p', null, `自动精炼：${data.config?.enabled ? '开启' : '关闭'} · ${dreamLabel(data.lastCheck?.reason)}`),
            h('div', { className: 'evo-meta' }, h('span', null, `新增会话 ${data.lastCheck?.sessionCount ?? 0} / ${data.config?.minSessions ?? 5}`), h('span', null, `去重一手证据 ${data.lastCheck?.primaryEventCount ?? 0} / ${data.config?.minPrimaryEvents ?? 10}`)),
            h('div', { className: 'evo-hint evo-col' },
              h('span', null, `最近检查：${fmtTime(data.lastCheck?.at)}`), h('span', null, `最近尝试：${fmtTime(data.lastAttemptAt)}`),
              h('span', null, `最近完成精炼：${fmtTime(data.lastCompletedAt)}`), h('span', null, `最近发布：${fmtTime(data.lastPublishedAt)}`))),
          h(Card, { title: '手动精炼' },
            h('div', { className: 'evo-row' }, h(Field, { label: '会话 ID' }, h('input', { type: 'text', 'aria-label': '精炼会话 ID', value: sessionId, disabled: submitting || crossSession, onChange: event => setSessionId(event.target.value) }))),
            h('label', { className: 'evo-check' }, h('input', { type: 'checkbox', checked: crossSession, disabled: submitting, onChange: event => setCrossSession(event.target.checked) }), '综合本安装内同一主体的跨会话材料'),
            h('p', { className: 'evo-hint' }, '手动精炼跳过自动时间和数量门槛，仍由普通 Input → 策略评估 → Ticket → 执行器处理。技能候选与人格提案都只在你确认后才生效。'),
            button(submitting ? '正在提交…' : '提交手动精炼', refine, { disabled: submitting, kind: 'primary' })),
          h(Card, { title: '请求与接纳' },
            data.requests?.length ? h('div', { className: 'evo-list' }, data.requests.map(item => h('details', { key: item.id, className: 'evo-rec' },
              h('summary', null, `${item.id} · ${dreamLabel(item.status)} · ${fmtTime(item.createdAt)}`),
              h('p', { className: 'evo-mono' }, `Input ${item.inputId || '尚未提交'} · Ticket ${item.ticketId || '尚未接纳'}`),
              item.reason ? h('p', null, dreamLabel(item.reason)) : null,
              h('pre', { className: 'evo-pre' }, JSON.stringify(item, null, 2))))) : h(Empty, null, '尚无精炼请求。满足门槛不代表已提交或已接纳。')),
          h('p', { className: 'evo-hint' }, '本次精炼产生的技能候选在「审批」标签里等待确认；未确认前不会发布。'),
          h(Card, { title: '精炼运行' }, data.runs?.length ? h('div', { className: 'evo-list' }, data.runs.map(run => h(DreamRun, { key: run.id, run }))) : h(Empty, null, '尚无已开始的精炼运行。'))) : null)
    }

    function SettingsTab({ refreshStatus, notify, refreshKey }) {
      const [config, setConfig] = useState(null)
      const [draft, setDraft] = useState(null)
      const [error, setError] = useState('')
      const [saving, setSaving] = useState(false)
      const [resetArmed, setResetArmed] = useState(false)
      const [reload, setReload] = useState(0)
      const load = useCallback(async signal => {
        setError('')
        try {
          const result = await request('/config', undefined, signal)
          if (!signal?.aborted) setConfig(result)
        } catch (failure) {
          if (!signal?.aborted) setError(failure.message)
        }
      }, [])
      useEffect(() => {
        const controller = new AbortController()
        void load(controller.signal)
        return () => controller.abort()
      }, [load, refreshKey, reload])
      useEffect(() => {
        if (config) setDraft(clone(config.values) ?? {})
      }, [config])
      useEffect(() => {
        if (!resetArmed) return undefined
        const timer = setTimeout(() => setResetArmed(false), 4000)
        return () => clearTimeout(timer)
      }, [resetArmed])
      const fields = config?.fields ?? []
      const groups = []
      for (const field of fields) {
        let group = groups.find(item => item.name === field.group)
        if (!group) {
          group = { name: field.group, fields: [] }
          groups.push(group)
        }
        group.fields.push(field)
      }
      const valueOf = field => readPath(draft, field.path)
      const setField = (field, value) => setDraft(current => writePath(current ?? {}, field.path, value))
      const toggleKind = (field, value) => {
        const current = valueOf(field)
        const next = Array.isArray(current) ? (current.includes(value) ? current.filter(item => item !== value) : [...current, value]) : [value]
        setField(field, next)
      }
      const validate = () => {
        for (const field of fields) {
          const value = valueOf(field)
          if (field.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return `${field.label} 需要填写数字`
          if (field.type === 'switch' && typeof value !== 'boolean') return `${field.label} 状态无效`
          if (field.type === 'select' && !field.options?.some(option => option.value === value)) return `${field.label} 取值无效`
          if (field.type === 'multi' && !Array.isArray(value)) return `${field.label} 取值无效`
        }
        return ''
      }
      async function save() {
        const problem = validate()
        if (problem) {
          setError(problem)
          return
        }
        const patch = diffPatch(config.values, draft)
        if (Object.keys(patch).length === 0) {
          notify('ok', '没有需要保存的更改')
          return
        }
        setSaving(true)
        setError('')
        try {
          await request('/config', { patch })
          notify('ok', '已保存，插件已重新加载')
          setReload(value => value + 1)
          await refreshStatus()
        } catch (failure) {
          setError(failure.message)
        } finally {
          setSaving(false)
        }
      }
      async function reset() {
        if (!resetArmed) {
          setResetArmed(true)
          return
        }
        setResetArmed(false)
        setSaving(true)
        setError('')
        try {
          await request('/config/reset', {})
          notify('ok', '已恢复继承默认')
          setReload(value => value + 1)
          await refreshStatus()
        } catch (failure) {
          setError(failure.message)
        } finally {
          setSaving(false)
        }
      }
      function control(field) {
        const value = valueOf(field)
        if (field.type === 'switch') {
          return h('label', { key: field.path.join('.'), className: 'evo-check' },
            h('input', {
              type: 'checkbox',
              checked: value === true,
              disabled: saving,
              onChange: event => setField(field, event.target.checked),
            }),
            h('span', null, field.label),
            field.hint ? h('span', { className: 'evo-hint' }, field.hint) : null)
        }
        if (field.type === 'number') {
          return h(Field, { key: field.path.join('.'), label: field.label },
            h('input', {
              type: 'number',
              value: value ?? '',
              min: field.min,
              max: field.max,
              step: field.step,
              disabled: saving,
              onChange: event => setField(field, event.target.value === '' ? '' : Number(event.target.value)),
            }),
            field.hint ? h('span', { className: 'evo-hint' }, field.hint) : null)
        }
        if (field.type === 'select') {
          return h(Field, { key: field.path.join('.'), label: field.label },
            h('select', { value: value ?? '', disabled: saving, onChange: event => setField(field, event.target.value) },
              field.options.map(option => h('option', { key: option.value, value: option.value }, option.label))),
            field.hint ? h('span', { className: 'evo-hint' }, field.hint) : null)
        }
        return h('div', { key: field.path.join('.'), className: 'evo-col' },
          h('span', { className: 'evo-hint' }, field.label),
          h('div', { className: 'evo-row' }, field.options.map(option => h('button', {
            key: option.value,
            type: 'button',
            disabled: saving,
            'aria-pressed': Array.isArray(value) && value.includes(option.value),
            className: Array.isArray(value) && value.includes(option.value) ? 'evo-chip ok' : 'evo-chip',
            onClick: () => toggleKind(field, option.value),
          }, option.label))),
          field.hint ? h('span', { className: 'evo-hint' }, field.hint) : null)
      }
      if (!config && !error) return h('p', { className: 'evo-hint' }, '正在读取配置…')
      if (!config) return h(Failure, { error, onRetry: () => setReload(value => value + 1) })
      return h(React.Fragment, null,
        h(Failure, { error, onRetry: () => setReload(value => value + 1) }),
        config.available === false ? h('div', { className: 'evo-alert warn block', role: 'status' },
          h('strong', null, '未找到 continual-harness 配置条目'),
          h('span', null, '运行 npm run setup:components 后重启面板；配置写入依赖 profile 的 cordis.patch.yml。')) : null,
        config.available && config.active === false ? h('div', { className: 'evo-alert warn block', role: 'status' },
          h('strong', null, '插件未启用'), h('span', null, '启用后配置才会生效。')) : null,
        groups.map(group => h(Card, { key: group.name, title: group.name },
          h('div', { className: 'evo-row' }, group.fields.filter(field => field.type !== 'multi').map(control)),
          group.fields.filter(field => field.type === 'multi').map(control))),
        config.available ? h(Card, { title: '保存' },
          h('div', { className: 'evo-row' },
            button(saving ? '保存中…' : '保存', () => { void save() }, { kind: 'primary', disabled: saving }),
            button('重新读取', () => setReload(value => value + 1), { kind: 'quiet', disabled: saving }),
            button(resetArmed ? '确认恢复继承默认' : '恢复继承默认', () => { void reset() }, { kind: 'danger', disabled: saving })),
          h('p', { className: 'evo-hint' }, '保存会通过 profile 配置写入并重新加载 continual-harness；只写入发生变化的字段。恢复继承默认会清除 profile 覆盖。'),
          h('div', { className: 'evo-hint evo-col' },
            h('span', null, `数据根目录：${config.harnessRoot}`),
            h('span', null, `技能目录：${config.skillsDir}`),
            h('span', null, `配置写入：${config.documentPath}`))) : null)
    }

    function EvolutionPanel() {
      const [tab, setTab] = useState('overview')
      const [status, setStatus] = useState(null)
      const [statusError, setStatusError] = useState('')
      const [toast, setToast] = useState(null)
      const [refreshKey, setRefreshKey] = useState(0)
      const bodyRef = useRef(null)
      const notify = useCallback((kind, text) => setToast({ kind, text, at: Date.now() }), [])
      const closeToast = useCallback(() => setToast(null), [])
      const refreshStatus = useCallback(async () => {
        try {
          const data = await request('/status')
          setStatus(data)
          setStatusError('')
          return data
        } catch (failure) {
          setStatusError(failure.message)
          return null
        }
      }, [])
      useEffect(() => { void refreshStatus() }, [refreshStatus])
      useEffect(() => { if (bodyRef.current) bodyRef.current.scrollTop = 0 }, [tab])
      const refresh = useCallback(async () => {
        setRefreshKey(value => value + 1)
        await refreshStatus()
      }, [refreshStatus])
      let content = null
      if (tab === 'overview') content = h(OverviewTab, { refreshKey, refreshStatus })
      else if (tab === 'approval') content = h(ApprovalTab, { refreshKey })
      else if (tab === 'dream') content = h(DreamTab, { refreshKey })
      else if (tab === 'entries') content = h(EntriesTab, { refreshKey, notify })
      else if (tab === 'history') content = h(HistoryTab, { refreshKey })
      else if (tab === 'records') content = h(RecordsTab, { refreshKey })
      else if (tab === 'sessions') content = h(SessionsTab, { refreshKey, notify })
      else if (tab === 'benchmark') content = h(BenchmarkTab, { refreshKey })
      else content = h(React.Fragment, null, h(DreamTab, { refreshKey, settingsOnly: true }), h(SettingsTab, { refreshStatus, notify, refreshKey }))
      const tabItems = TABS.map(([id, label]) => ({ id, label }))
      const onTabKeyDown = (event, index) => {
        if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault()
          const next = event.key === 'Home' ? 0 : tabItems.length - 1
          setTab(tabItems[next].id)
          if (typeof document !== 'undefined') document.getElementById(`evo-tab-${tabItems[next].id}`)?.focus()
          return
        }
        const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
        if (!step) return
        event.preventDefault()
        const next = (index + step + tabItems.length) % tabItems.length
        setTab(tabItems[next].id)
        if (typeof document !== 'undefined') document.getElementById(`evo-tab-${tabItems[next].id}`)?.focus()
      }
      const dots = [
        h('span', { key: 'status', className: `evo-dot ${status?.active ? 'ok' : status ? 'warn' : ''}` },
          status ? (status.active ? '进化运行中' : '未启用') : '正在读取状态'),
        h('span', { key: 'entries', className: 'evo-dot' }, `经验 ${status?.entries ?? 0} 条`),
        h('span', { key: 'readonly', className: 'evo-dot' }, '条目只读'),
        statusError ? h('span', { key: 'error', className: 'evo-dot bad' }, '状态读取失败') : null,
      ].filter(Boolean)
      return h('main', { className: 'evolution-panel' },
        h('style', null, EVO_CSS),
        h('header', { className: 'evo-head' },
          h('div', { className: 'evo-head-main' },
            h('p', { className: 'evo-kicker' }, 'DSH · 持续进化'),
            h('h1', null, '进化'),
            h('p', { className: 'evo-sub' }, '经验条目 · 复审 · 基准回归')),
          h('div', { className: 'evo-head-actions' },
            h('div', { className: 'evo-dots' }, ...dots),
            button('刷新', () => { void refresh() }))),
        h('div', { className: 'evo-alerts' },
          statusError ? h('div', { className: 'evo-alert danger', role: 'alert' },
            h('span', null, statusError),
            button('重试', () => { void refresh() }, { kind: 'quiet' })) : null),
        h('div', { className: 'evo-tabs', role: 'tablist', 'aria-label': '进化导航' },
          tabItems.map((item, index) => h('button', {
            key: item.id,
            id: `evo-tab-${item.id}`,
            type: 'button',
            role: 'tab',
            'aria-selected': tab === item.id,
            'aria-controls': `evo-panel-${item.id}`,
            tabIndex: tab === item.id ? 0 : -1,
            className: tab === item.id ? 'evo-tab on' : 'evo-tab',
            onClick: () => setTab(item.id),
            onKeyDown: event => onTabKeyDown(event, index),
          }, item.label))),
        h('div', { className: 'evo-body', ref: bodyRef },
          h('div', {
            id: `evo-panel-${tab}`,
            role: 'tabpanel',
            'aria-labelledby': `evo-tab-${tab}`,
            tabIndex: 0,
            className: 'evo-stack',
          }, content)),
        h(Toast, { toast, onClose: closeToast }))
    }

    function EvolutionSettingsRow({ openPanel }) {
      const [status, setStatus] = useState(null)
      const [error, setError] = useState('')
      const load = useCallback(async () => {
        try {
          const data = await request('/status')
          setStatus(data)
          setError('')
        } catch (failure) {
          setStatus(null)
          setError(failure.message)
        }
      }, [])
      useEffect(() => { void load() }, [load])
      const chip = !status ? { tone: 'bad', text: '未连接' }
        : status.installed === false ? { tone: 'warn', text: '未安装' }
          : !status.active ? { tone: 'warn', text: '未启用' }
            : { tone: 'ok', text: '运行中' }
      return h('div', { className: 'evo-settings-row' },
        h('div', { className: 'evo-settings-main' },
          h('div', { className: 'evo-settings-title' }, '进化'),
          h('div', { className: 'evo-settings-desc' }, status?.installed === false
            ? '未安装 continual-harness：运行 npm run setup:components 后重启面板。'
            : '持续进化：经验注入、复审与基准（continual-harness）。'),
          error ? h('div', { className: 'evo-settings-error', role: 'alert' }, error) : null),
        h('div', { className: 'evo-settings-right' },
          h('span', { className: `evo-settings-chip ${chip.tone === 'ok' ? 'ok' : chip.tone}` }, chip.text),
          button('管理', () => { openPanel() })))
    }

    function Icon({ size = 20 }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        'aria-hidden': true,
      },
        h('circle', { cx: 12, cy: 12, r: 3.2 }),
        h('path', { d: 'M12 3v4' }),
        h('path', { d: 'M12 17v4' }),
        h('path', { d: 'M4.9 7.5l3.2 2.4' }),
        h('path', { d: 'M15.9 14.1l3.2 2.4' }),
        h('path', { d: 'M4.9 16.5l3.2-2.4' }),
        h('path', { d: 'M15.9 9.9l3.2-2.4' }))
    }

    return {
      inject: ['slots', 'layout'],
      apply(ctx) {
        if (typeof document !== 'undefined') {
          const style = document.createElement('style')
          style.id = 'dsh-evolution-row-css'
          style.textContent = ROW_CSS
          document.head.appendChild(style)
          ctx.effect(() => () => { style.remove() }, 'dsh-evolution: settings row style')
        }
        const openPanel = () => {
          try { ctx.layout.selectPanel('evolution') } catch { /* panel registry not ready */ }
          try {
            const entries = ctx.slots.entriesOfSlot?.('sidebar.settings') ?? []
            const settings = entries[0]?.store?.create?.()
            settings?.actions?.close?.()
          } catch { /* settings shell not mounted */ }
        }
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'evolution', inject: () => ({}) }, EvolutionPanel))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: 'evolution', order: 15, label: () => '进化',
        }, Icon))
        ctx.slots.inject('settings.general.item', () => ctx.slots.register({
          name: 'settings.general.item', id: 'dsh-evolution', order: 92, inject: () => ({ openPanel }),
        }, EvolutionSettingsRow))
      },
    }
  },
})
