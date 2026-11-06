/** 绑定页 QR 会话状态机：包装 qrLogin，为 loopback 绑定服务提供一次性凭据交付。
 *
 *  语义：单飞（start 替换旧会话）；confirmed/error 仅首次 status 一次性交付后即销毁；
 *  verify 仅在 phase==='verify' 时接受，5 分钟无人提交按 verify-timeout 失败；
 *  TTL 会话创建起 10 分钟硬过期（惰性清扫），过期未交付的 confirmed 凭据直接丢弃；
 *  严禁打印任何凭据（botToken 等），日志只出现状态码与错误码。
 */
import { randomUUID } from 'node:crypto'
import { IlinkError } from './ilink.ts'
import { qrLogin } from './qr.ts'
import type { QrLoginCallbacks, QrCredentials, QrLoginOptions } from './qr.ts'
import { encodeQrSvg } from './bind-qr.ts'

/** qrLogin 凭据 → 绑定页凭据的字段名映射（accountId→ilinkBotId；userId→ilinkUserId）。 */
export interface BindCredentials {
  botToken: string
  ilinkBotId: string
  baseUrl: string
  ilinkUserId: string
}

export type BindPhase = 'waiting' | 'scanned' | 'refreshing' | 'verify' | 'confirmed' | 'error'

export interface BindStatus {
  /** waiting/refreshing/verify 时携带最新 SVG；scanned 不带；confirmed/error 一次性。 */
  phase: BindPhase
  qrSvg?: string
  credentials?: BindCredentials
  error?: { code: string; message: string }
}

export interface SessionManagerOptions {
  /** 测试注入点；缺省用真实 qrLogin。 */
  qrLoginImpl?: typeof qrLogin
  /** 测试注入点；缺省 Date.now。 */
  now?: () => number
}

/** 会话 TTL：创建起 10 分钟硬过期（惰性清扫）。 */
const SESSION_TTL_MS = 10 * 60_000
/** 配对码等待超时：5 分钟无人提交则本会话失败。 */
const VERIFY_TIMEOUT_MS = 5 * 60_000

interface VerifyWaiter {
  promise: Promise<string>
  resolve: (code: string) => void
  reject: (error: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

interface Session {
  id: string
  createdAt: number
  controller: AbortController
  phase: BindPhase
  qrSvg?: string
  credentials?: BindCredentials
  error?: { code: string; message: string }
  waiter?: VerifyWaiter
  lastLoggedStatus?: string
}

export class SessionManager {
  private readonly qrLoginFn: typeof qrLogin
  private readonly nowFn: () => number
  private readonly sessions = new Map<string, Session>()

  constructor(options: SessionManagerOptions = {}) {
    this.qrLoginFn = options.qrLoginImpl ?? qrLogin
    this.nowFn = options.now ?? (() => Date.now())
  }

  /** 发起新会话（替换旧会话）。返回 sessionId。 */
  start(): string {
    this.sweep()
    // 单飞：旧会话（若有）先 abort 并丢弃。
    for (const old of [...this.sessions.values()]) this.destroy(old)
    const id = randomUUID()
    const session: Session = { id, createdAt: this.nowFn(), controller: new AbortController(), phase: 'waiting' }
    this.sessions.set(id, session)
    const callbacks: QrLoginCallbacks = {
      onQrUrl: (url: string) => {
        if (!this.alive(session)) return
        session.qrSvg = encodeQrSvg(url)
        // 刷新后回到 waiting 时 SVG 更新；verify 挂起期间只换图不改相位。
        if (session.phase === 'waiting' || session.phase === 'scanned' || session.phase === 'refreshing') {
          session.phase = 'waiting'
        }
      },
      onStatus: (status: string) => {
        if (!this.alive(session)) return
        if (status === 'scanned') {
          session.phase = 'scanned'
          return
        }
        if (session.phase === 'verify') return // 挂起等配对码期间不外显其它状态
        if (status === 'refreshing') session.phase = 'refreshing'
        else if (status === 'waiting') session.phase = 'waiting'
        // 其余状态只作日志（去重防刷屏），不外显。
        if (session.lastLoggedStatus !== status) {
          session.lastLoggedStatus = status
          console.error('[wechat-bind] qr status: ' + status)
        }
      },
      readVerifyCode: () => this.beginVerify(session),
    }
    const opts: QrLoginOptions = { signal: session.controller.signal }
    void this.qrLoginFn(callbacks, opts).then((credentials: QrCredentials) => {
      if (!this.alive(session)) return
      session.phase = 'confirmed'
      session.credentials = {
        botToken: credentials.botToken,
        ilinkBotId: credentials.accountId,
        baseUrl: credentials.baseUrl,
        ilinkUserId: credentials.userId ?? '',
      }
    }).catch((error: unknown) => {
      if (!this.alive(session)) return
      session.phase = 'error'
      session.error = error instanceof IlinkError
        ? { code: error.code, message: String(error.message).slice(0, 300) }
        : { code: 'internal', message: String(error).slice(0, 300) }
      console.error('[wechat-bind] qr login failed: ' + session.error.code)
    })
    return id
  }

  /** 提交配对码。仅 phase==='verify' 时有效；resolve 后相位回到 scanned。 */
  verify(sessionId: string, code: string): { ok: boolean; error?: string } {
    this.sweep()
    const session = this.sessions.get(sessionId)
    if (!session || session.phase !== 'verify' || !session.waiter) {
      return { ok: false, error: 'not awaiting a pairing code' }
    }
    const trimmed = code.trim()
    if (!trimmed) return { ok: false, error: 'pairing code is empty' }
    clearTimeout(session.waiter.timer)
    const waiter = session.waiter
    session.waiter = undefined
    session.phase = 'scanned'
    waiter.resolve(trimmed)
    return { ok: true }
  }

  /** 查询状态。confirmed/error 只在第一次调用返回（随后销毁），之后 undefined（404 语义）。 */
  status(sessionId: string): BindStatus | undefined {
    this.sweep()
    const session = this.sessions.get(sessionId)
    if (!session) return undefined
    if (session.phase === 'confirmed') {
      const payload: BindStatus = { phase: 'confirmed', credentials: session.credentials }
      this.destroy(session) // 凭据一次性交付，立即销毁不滞留
      return payload
    }
    if (session.phase === 'error') {
      const payload: BindStatus = { phase: 'error', error: session.error }
      this.destroy(session) // 错误同样一次性交付
      return payload
    }
    const out: BindStatus = { phase: session.phase }
    if (session.phase === 'waiting' || session.phase === 'refreshing' || session.phase === 'verify') {
      if (session.qrSvg !== undefined) out.qrSvg = session.qrSvg
    }
    return out
  }

  /** 取消并销毁会话。 */
  cancel(sessionId: string): void {
    this.sweep()
    const session = this.sessions.get(sessionId)
    if (session) this.destroy(session)
  }

  private alive(session: Session): boolean {
    return this.sessions.get(session.id) === session
  }

  /** qrLogin 要求配对码：挂起 promise 等 POST /qr/verify；5 分钟超时按 verify-timeout 失败。 */
  private beginVerify(session: Session): Promise<string> {
    session.phase = 'verify'
    let resolveFn!: (code: string) => void
    let rejectFn!: (error: unknown) => void
    const promise = new Promise<string>((resolve, reject) => {
      resolveFn = resolve
      rejectFn = reject
    })
    const timer = setTimeout(() => {
      if (session.waiter?.promise !== promise) return
      session.waiter = undefined
      rejectFn(new IlinkError('verify-timeout', '配对码输入超时（5 分钟），请重新生成二维码'))
    }, VERIFY_TIMEOUT_MS)
    if (typeof timer.unref === 'function') timer.unref() // 不为计时器保活引擎进程
    session.waiter = { promise, resolve: resolveFn, reject: rejectFn, timer }
    return promise
  }

  private destroy(session: Session): void {
    this.sessions.delete(session.id)
    session.controller.abort()
    const waiter = session.waiter
    session.waiter = undefined
    if (waiter) {
      clearTimeout(waiter.timer)
      waiter.promise.catch(() => undefined) // 兜底：qrLogin 已中止时防 unhandledRejection
      waiter.reject(new IlinkError('aborted', 'session closed'))
    }
  }

  /** 惰性 TTL 清扫：过期会话（含未交付的 confirmed 凭据）直接丢弃。 */
  private sweep(): void {
    const now = this.nowFn()
    for (const session of [...this.sessions.values()]) {
      if (now - session.createdAt >= SESSION_TTL_MS) this.destroy(session)
    }
  }
}
