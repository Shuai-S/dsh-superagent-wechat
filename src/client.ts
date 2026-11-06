/** 浏览器 client bundle：在 superagent 引擎原生面板（127.0.0.1:3082）注册「微信绑定」页。
 *
 *  形态：scripts/build-client.mjs 把本文件编译成 CJS 并包上
 *  window.__ModuleLoader__.load({ id: 'dsh-superagent-wechat', factory: (require) => {...} })
 *  横幅产 lib/client.js（横幅 id 必须与 package.json 包名一致，与官方 dsh-superagent、
 *  dsh-superagent-console 的 client bundle 同款）。slots/locale 服务由宿主面板提供，
 *  react 从宿主模块表 require，零 npm 依赖。
 *
 *  注册面（与引擎官方 client 完全同构）：
 *  - slots.inject('main')             → 主面板页（扫码状态机 UI）
 *  - slots.inject('sidebar.panellist') → 侧栏入口（图标 + 标签）
 *
 *  数据面：同源 fetch /wechat/api/qr/*（src/bind-panel.ts 注册在引擎 webserver 上，
 *  闸门与引擎管理 API 同款 sameOrigin；凭据一次性交付，不落日志）。
 *  页面 JS 有意不用模板字面量（全部字符串拼接），与 src/bind-page.ts 同纪律。
 */

interface ReactLike {
  createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown
  Component: new (props: Record<string, unknown>) => ComponentLike
  useState<T>(initial: T): [T, (value: T | ((previous: T) => T)) => void]
  useEffect(effect: () => void | (() => void), deps?: unknown[]): void
}

interface ComponentLike {
  props: Record<string, unknown>
  state: Record<string, unknown>
  setState(patch: Record<string, unknown>): void
  render(): unknown
}

/** react 从宿主 ModuleLoader 的模块表 require（baseline external），@types/node 声明全局 require。 */
const React = require('react') as ReactLike

const NS = 'dshSuperagentWechat'
const PANEL_ID = 'dsh-superagent-wechat'
const API_BASE = '/wechat/api/qr'

const zh: Record<string, string> = { panel: '微信绑定' }
const en: Record<string, string> = { panel: 'WeChat Binding' }

interface SlotsRegistryLike {
  inject(key: string, callback: () => () => void): () => void
  register(spec: Record<string, unknown>, component: unknown): () => void
}
interface LocaleFaceLike {
  register(namespace: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }): () => void
  bind(namespace: string): (key: string) => string
}
interface ClientContextLike {
  effect(fn: () => () => void, label: string): void
  slots: SlotsRegistryLike
  locale: LocaleFaceLike
}

export const inject: string[] = ['slots', 'locale']

interface BindCredentialsLike {
  botToken?: string
  ilinkBotId?: string
  baseUrl?: string
  ilinkUserId?: string
}

interface BindStatusLike {
  phase?: string
  qrSvg?: string
  credentials?: BindCredentialsLike
  error?: { code?: string; message?: string }
}

interface ApiResponseLike {
  status: number
  data: Record<string, unknown> | null
}

/** 与引擎管理 API 同款请求头；同源请求，自定义头不触发 CORS 预检。 */
function requestHeaders(json: boolean): Record<string, string> {
  const headers: Record<string, string> = { 'x-orchestrator-request': '1' }
  if (json) headers['content-type'] = 'application/json'
  return headers
}

async function getJson(path: string): Promise<ApiResponseLike> {
  try {
    const res = await fetch(path, { headers: requestHeaders(false) })
    const text = await res.text()
    let data: Record<string, unknown> | null = null
    if (text) {
      try { data = JSON.parse(text) as Record<string, unknown> } catch { data = null }
    }
    return { status: res.status, data }
  } catch {
    return { status: 0, data: null }
  }
}

async function postJson(path: string, body: Record<string, unknown>): Promise<ApiResponseLike> {
  try {
    const res = await fetch(path, { method: 'POST', headers: requestHeaders(true), body: JSON.stringify(body) })
    const text = await res.text()
    let data: Record<string, unknown> | null = null
    if (text) {
      try { data = JSON.parse(text) as Record<string, unknown> } catch { data = null }
    }
    return { status: res.status, data }
  } catch {
    return { status: 0, data: null }
  }
}

/** 错误码 → 人话（与 src/bind-page.ts 的映射保持一致）。 */
const ERROR_HINTS: Record<string, string> = {
  'verify-code-blocked': '配对码被服务端拦截（verify_code_blocked），请稍后重新生成二维码再试',
  verify_code_blocked: '配对码被服务端拦截（verify_code_blocked），请稍后重新生成二维码再试',
  'binded-redirect': '该账号已在别处绑定（binded_redirect），请先在手机上解绑后再扫码',
  binded_redirect: '该账号已在别处绑定（binded_redirect），请先在手机上解绑后再扫码',
  'login-timeout': '登录超时（8 分钟），请点击「生成二维码」重新开始',
  'qr-expired': '二维码过期次数过多，请重新生成',
  'verify-timeout': '配对码输入超时（5 分钟），请重新生成二维码',
  aborted: '会话已取消',
}

/** 账户 JSON 与 bin/wechat-qr.mjs 输出完全同构。 */
function credentialsJson(c: BindCredentialsLike): string {
  return JSON.stringify([
    {
      id: 'main',
      botToken: c.botToken || '',
      ilinkBotId: c.ilinkBotId || '',
      baseUrl: c.baseUrl || '',
      ilinkUserId: c.ilinkUserId || '',
      name: '',
    },
  ], null, 2)
}

function copyText(text: string, onDone: (ok: boolean) => void): void {
  const fallback = function (): void {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    let ok = false
    try { ok = document.execCommand('copy') } catch { ok = false }
    document.body.removeChild(ta)
    onDone(ok)
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function () { onDone(true) }, fallback)
  } else {
    fallback()
  }
}

interface ChangeEventLike { target: { value: unknown } }
interface KeyEventLike { key: string }

const PAGE: Record<string, unknown> = { fontFamily: '-apple-system, "PingFang SC", sans-serif', fontSize: 14, lineHeight: 1.6, color: '#1f2328', maxWidth: '560px' }
const SUB: Record<string, string> = { color: '#656d76', fontSize: '13px', margin: '4px 0 12px' }
const QR_BOX: Record<string, string> = { background: '#fff', border: '1px solid #eaeef2', borderRadius: '8px', padding: '12px', width: '264px', margin: '12px 0' }
const BTN: Record<string, unknown> = { fontSize: 14, padding: '7px 16px', borderRadius: 6, border: '1px solid #d0d7de', background: '#f6f8fa', cursor: 'pointer', marginRight: 8 }
const BTN_GHOST: Record<string, unknown> = { fontSize: 14, padding: '7px 16px', borderRadius: 6, border: '1px solid #d0d7de', background: 'transparent', cursor: 'pointer' }
const INPUT: Record<string, unknown> = { fontSize: 14, padding: '7px 10px', borderRadius: 6, border: '1px solid #d0d7de', width: 220 }
const PRE: Record<string, unknown> = { background: '#f6f8fa', border: '1px solid #eaeef2', borderRadius: 8, padding: 12, fontSize: 12, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }
const ERR: Record<string, string> = { color: '#cf222e', fontSize: '13px', margin: '6px 0' }
const HINT: Record<string, string> = { color: '#656d76', fontSize: '12px' }
const BOUNDARY_ERR: Record<string, unknown> = { color: '#cf222e', fontSize: '13px', border: '1px solid #ffd0cc', background: '#fff5f3', borderRadius: 8, padding: 12 }

/** 错误边界：页面崩溃时显示一行诊断文字而不是让整个面板白屏（细节进浏览器控制台）。 */
class BindErrorBoundary extends React.Component {
  constructor(props: Record<string, unknown>) {
    super(props)
    this.state = { error: '' }
  }
  static getDerivedStateFromError(error: unknown): Record<string, unknown> {
    const message = error instanceof Error ? error.message : String(error)
    return { error: message.slice(0, 300) }
  }
  render(): unknown {
    const error = String(this.state.error || '')
    if (error) {
      return React.createElement('div', { style: BOUNDARY_ERR }, '微信绑定页崩溃：' + error + '（详情见浏览器控制台）')
    }
    return this.props.children !== undefined ? this.props.children : null
  }
}

/** 扫码状态机：waiting（SVG）→ scanned → verify（配对码）→ confirmed（JSON + 一键复制）。 */
function BindPage(): unknown {
  const sessionIdState = React.useState('')
  const sessionId = sessionIdState[0]
  const setSessionId = sessionIdState[1]
  const phaseState = React.useState('idle')
  const phase = phaseState[0]
  const setPhase = phaseState[1]
  const qrSvgState = React.useState('')
  const qrSvg = qrSvgState[0]
  const setQrSvg = qrSvgState[1]
  const statusTextState = React.useState('正在打开绑定会话…')
  const statusText = statusTextState[0]
  const setStatusText = statusTextState[1]
  const verifyCodeState = React.useState('')
  const verifyCode = verifyCodeState[0]
  const setVerifyCode = verifyCodeState[1]
  const verifyErrState = React.useState('')
  const verifyErr = verifyErrState[0]
  const setVerifyErr = verifyErrState[1]
  const credJsonState = React.useState('')
  const credJson = credJsonState[0]
  const setCredJson = credJsonState[1]
  const copyHintState = React.useState('')
  const copyHint = copyHintState[0]
  const setCopyHint = copyHintState[1]
  const errCodeState = React.useState('')
  const errCode = errCodeState[0]
  const setErrCode = errCodeState[1]
  const errMsgState = React.useState('')
  const errMsg = errMsgState[0]
  const setErrMsg = errMsgState[1]
  const errHintState = React.useState('')
  const errHint = errHintState[0]
  const setErrHint = errHintState[1]

  function resetError(): void {
    setErrCode(''); setErrMsg(''); setErrHint('')
    setVerifyErr(''); setCopyHint('')
  }

  function showError(err: { code?: string; message?: string }): void {
    setQrSvg('')
    const code = err && err.code ? err.code : 'unknown'
    setErrCode('错误码：' + code)
    setErrMsg(err && err.message ? err.message : '')
    setErrHint(ERROR_HINTS[code] || '请点击「生成二维码」重试；若持续失败，改用终端 CLI（见 README）')
    setPhase('error')
    setStatusText('绑定失败')
  }

  function startQr(): void {
    resetError()
    setQrSvg('')
    setCredJson('')
    setVerifyCode('')
    setPhase('starting')
    setStatusText('正在生成二维码…')
    void postJson(API_BASE + '/start', {}).then(function (r: ApiResponseLike) {
      const id = r.data && typeof r.data.sessionId === 'string' ? r.data.sessionId : ''
      if (r.status === 200 && id) {
        setSessionId(id)
      } else {
        setPhase('idle')
        const detail = r.data && typeof r.data.error === 'string' ? r.data.error : 'HTTP ' + r.status
        setStatusText('生成失败：' + detail)
      }
    })
  }

  function cancelQr(): void {
    if (sessionId) void postJson(API_BASE + '/cancel', { session: sessionId })
    setSessionId('')
    setQrSvg('')
    setCredJson('')
    resetError()
    setPhase('idle')
    setStatusText('已取消。点击「生成二维码」重新开始')
  }

  function submitVerify(): void {
    const code = verifyCode.trim()
    if (!code) {
      setVerifyErr('请输入手机上显示的配对数字')
      return
    }
    void postJson(API_BASE + '/verify', { session: sessionId, code }).then(function (r: ApiResponseLike) {
      if (r.status === 200) {
        setVerifyErr('')
        setPhase('scanned')
        setStatusText('已提交配对码，等待确认…')
      } else {
        const detail = r.data && typeof r.data.error === 'string' ? r.data.error : 'HTTP ' + r.status
        setVerifyErr('提交失败：' + detail)
      }
    })
  }

  function copyJson(): void {
    copyText(credJson, function (ok) {
      setCopyHint(ok ? '已复制' : '复制失败，请手动全选复制')
    })
  }

  // 轮询循环：sessionId 变化即重启；confirmed/error 是一次性交付，收到即停。
  React.useEffect(function (): () => void {
    if (!sessionId) return function (): void {}
    let stopped = false
    let timer: number | null = null
    const tick = function (): void {
      void getJson(API_BASE + '/status?session=' + encodeURIComponent(sessionId)).then(function (r: ApiResponseLike) {
        if (stopped) return
        const d = r.data as BindStatusLike | null
        if (r.status === 404) {
          setQrSvg('')
          setPhase('idle')
          setStatusText('会话已失效，请点击「生成二维码」重试')
          return
        }
        if (r.status !== 200 || !d || !d.phase) {
          timer = window.setTimeout(tick, 1500)
          return
        }
        if (d.phase === 'waiting') {
          if (d.qrSvg) setQrSvg(d.qrSvg)
          setPhase('waiting')
          setStatusText('请用手机微信扫码')
          timer = window.setTimeout(tick, 1500)
          return
        }
        if (d.phase === 'refreshing') {
          if (d.qrSvg) setQrSvg(d.qrSvg)
          setPhase('waiting')
          setStatusText('二维码已过期，正在刷新…')
          timer = window.setTimeout(tick, 1500)
          return
        }
        if (d.phase === 'scanned') {
          setPhase('scanned')
          setStatusText('已扫描，请在手机上确认')
          timer = window.setTimeout(tick, 1500)
          return
        }
        if (d.phase === 'verify') {
          if (d.qrSvg) setQrSvg(d.qrSvg)
          setPhase('verify')
          setStatusText('需要配对码：请输入手机微信上显示的配对数字')
          timer = window.setTimeout(tick, 1500)
          return
        }
        if (d.phase === 'confirmed') {
          setCredJson(credentialsJson(d.credentials || {}))
          setQrSvg('')
          setPhase('confirmed')
          setStatusText('绑定成功！复制下面的账户 JSON，粘贴到面板')
          return
        }
        if (d.phase === 'error') {
          showError(d.error || {})
          return
        }
        timer = window.setTimeout(tick, 1500)
      }).catch(function () {
        if (!stopped) timer = window.setTimeout(tick, 1500)
      })
    }
    tick()
    return function (): void {
      stopped = true
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [sessionId])

  // 打开页面即自动起会话（与 26678 页同 UX；单飞语义保证旧会话被替换）。
  React.useEffect(function (): () => void {
    startQr()
    return function (): void {}
  }, [])

  const children: unknown[] = []
  children.push(React.createElement('h3', { key: 'title', style: { marginTop: 0, marginBottom: 8 } }, '微信 ClawBot 绑定'))
  children.push(React.createElement('p', { key: 'sub', style: SUB }, '用手机微信扫码把机器人绑定到本引擎。凭据只在本机内存中流转、一次性显示，不写入日志。'))
  children.push(React.createElement('div', { key: 'actions' },
    React.createElement('button', { style: BTN, type: 'button', onClick: function () { startQr() } }, '生成二维码'),
    React.createElement('button', { style: BTN_GHOST, type: 'button', onClick: function () { cancelQr() } }, '取消'),
  ))
  if (qrSvg) {
    children.push(React.createElement('div', { key: 'qr', style: QR_BOX, dangerouslySetInnerHTML: { __html: qrSvg } }))
  }
  if (statusText) {
    children.push(React.createElement('p', { key: 'status' }, statusText))
  }
  if (phase === 'verify') {
    children.push(React.createElement('div', { key: 'verify' },
      React.createElement('label', { htmlFor: 'dsh-wechat-verify-input' }, '配对码'),
      React.createElement('div', { style: { margin: '8px 0' } },
        React.createElement('input', {
          id: 'dsh-wechat-verify-input',
          style: INPUT,
          inputMode: 'numeric',
          autoComplete: 'one-time-code',
          placeholder: '手机微信上显示的数字',
          value: verifyCode,
          onChange: function (e: ChangeEventLike) { setVerifyCode(String(e.target.value)) },
          onKeyDown: function (e: KeyEventLike) { if (e.key === 'Enter') submitVerify() },
        }),
        React.createElement('button', { style: BTN, type: 'button', onClick: function () { submitVerify() } }, '提交'),
      ),
      verifyErr ? React.createElement('p', { style: ERR }, verifyErr) : null,
    ))
  }
  if (phase === 'confirmed' && credJson) {
    children.push(React.createElement('div', { key: 'result' },
      React.createElement('p', null, '复制下面的账户 JSON，粘贴到 ', React.createElement('b', null, '面板 → 来源 → 微信（ClawBot）→ 账户'), '（可整段粘进 JSON 视图，或逐字段填写），保存后自动拉起长轮询：'),
      React.createElement('pre', { style: PRE }, credJson),
      React.createElement('div', { style: { margin: '8px 0' } },
        React.createElement('button', { style: BTN, type: 'button', onClick: function () { copyJson() } }, '一键复制'),
        React.createElement('span', { style: HINT }, copyHint),
      ),
      React.createElement('p', { style: HINT }, '注意：botToken 等凭据只保存进引擎配置；不要粘贴到日志、聊天或仓库。'),
    ))
  }
  if (phase === 'error' && errCode) {
    children.push(React.createElement('div', { key: 'error' },
      React.createElement('p', { style: ERR }, errCode),
      errMsg ? React.createElement('p', null, errMsg) : null,
      errHint ? React.createElement('p', { style: HINT }, errHint) : null,
    ))
  }
  children.push(React.createElement('p', { key: 'foot', style: HINT }, '终端 CLI（dsh-superagent-wechat-qr）与独立绑定页（127.0.0.1:26678）仍是备选方案。'))
  return React.createElement('div', { style: PAGE }, children)
}

/** 侧栏图标：聊天气泡 + 双点（WeChat 意象），props.size 由宿主传入。 */
function WechatIcon(props: Record<string, unknown>): unknown {
  const size = typeof props.size === 'number' ? props.size : 16
  return React.createElement('svg', {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  },
    React.createElement('path', { d: 'M21 11.6c0 3.6-3.9 6.5-8.7 6.5-1 0-2-.13-2.9-.37L5.9 20l.7-3.2C4.8 15.6 3.6 13.7 3.6 11.6 3.6 8 7.5 5.1 12.3 5.1S21 8 21 11.6z' }),
    React.createElement('circle', { cx: 9.4, cy: 11.4, r: 0.95, fill: 'currentColor', stroke: 'none' }),
    React.createElement('circle', { cx: 14.6, cy: 11.4, r: 0.95, fill: 'currentColor', stroke: 'none' }),
  )
}

export function apply(ctx: ClientContextLike): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-superagent-wechat: dictionaries')
  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register(
    { name: 'main', key: PANEL_ID, locale: NS, inject: () => ({}) },
    () => React.createElement(BindErrorBoundary, null, React.createElement(BindPage, null)),
  )), 'dsh-superagent-wechat: main panel')
  ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
    { name: 'sidebar.panellist', id: PANEL_ID, order: 10, label: () => t('panel'), locale: NS },
    WechatIcon,
  )), 'dsh-superagent-wechat: sidebar entry')
}
