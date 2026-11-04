/** Watch loop: reconcile configured accounts into one long-poll poller each
 *  (config-hash keyed, dingtalk/mail style), feed inbound messages through the
 *  Trigger translation, remember each message's context_token, and persist the
 *  get_updates_buf cursor so restarts resume without gaps. errcode -14 stops
 *  that account's poller and reports the health error until the token changes. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SourceContextLike } from './types.ts'
import { DEFAULT_BASE_URL, DEFAULT_LONG_POLL_TIMEOUT_MS, SESSION_EXPIRED_ERRCODE, getUpdates, normalizeBaseUrl, notifyStart, notifyStop, responseErrcode } from './ilink.ts'
import { clearContextTokens, rememberContextToken } from './context-tokens.ts'
import { InboundMessageSchema, buildTrigger } from './trigger.ts'
import { channelConfig, HEALTH_ENTRY, type AccountConfig, type WechatConfig } from './wechat-kind.ts'

const STATE_DIR = join(homedir(), '.local', 'state', 'dsh-superagent-wechat')
const CURSOR_FILE = join(STATE_DIR, 'cursors.json')

/** 单批消息过多按游标重置防御处理：先推进游标、整批跳过（先例：@pawastation poller）。 */
const MAX_BATCH = 50
/** 陈旧消息保护：游标丢失重放时跳过太老的消息。 */
const STALE_MS = 10 * 60_000

export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return }
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve() }, ms)
    const stop = () => { clearTimeout(timer); resolve() }
    signal.addEventListener('abort', stop, { once: true })
  })
}

async function loadCursors(): Promise<Record<string, string>> {
  try {
    const raw = JSON.parse(await readFile(CURSOR_FILE, 'utf8')) as unknown
    const out: Record<string, string> = {}
    if (raw && typeof raw === 'object') {
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value === 'string') out[key] = value
      }
    }
    return out
  } catch {
    return {} // 首次运行或文件损坏：按无游标处理，trigger id 幂等保证重放安全
  }
}

async function saveCursors(cursors: Record<string, string>): Promise<void> {
  try {
    await mkdir(STATE_DIR, { recursive: true })
    const tmp = CURSOR_FILE + '.tmp'
    await writeFile(tmp, JSON.stringify(cursors), { mode: 0o600 })
    await rename(tmp, CURSOR_FILE)
  } catch (error) {
    console.error('[wechat] cursor persist failed: ' + String(error).slice(0, 160))
  }
}

interface AccountState {
  hash: string
  controller: AbortController
  done: Promise<void>
  cursor: string
  expired: boolean
  failures: number
}

async function pollAccount(source: SourceContextLike, account: AccountConfig, state: AccountState, cursors: Record<string, string>, outerSignal: AbortSignal): Promise<void> {
  const signal = state.controller.signal
  let baseUrl: string
  try {
    baseUrl = normalizeBaseUrl(account.baseUrl || DEFAULT_BASE_URL)
  } catch (error) {
    source.report(HEALTH_ENTRY, { state: 'error', detail: account.id + ': ' + String(error).slice(0, 200) })
    state.expired = true // 不可用基址：等同停轮询，等配置修正后 hash 变化再拉起
    return
  }
  try {
    await notifyStart({ baseUrl, token: account.botToken, signal }).catch((error: unknown) => {
      console.error('[wechat] notifyStart failed (account=' + account.id + '): ' + String(error).slice(0, 200))
    })
    let timeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS
    let unreadable = 0
    while (!signal.aborted && !state.expired) {
      const resp = await getUpdates({ baseUrl, token: account.botToken, getUpdatesBuf: state.cursor, timeoutMs, signal })
      if (resp.longpolling_timeout_ms !== undefined && resp.longpolling_timeout_ms > 0) timeoutMs = resp.longpolling_timeout_ms
      const errcode = responseErrcode(resp)
      if (errcode !== 0) {
        if (errcode === SESSION_EXPIRED_ERRCODE) {
          state.expired = true
          source.report(HEALTH_ENTRY, {
            state: 'error',
            code: 'sessionExpired',
            detail: account.id + ': 登录过期（errcode -14），请重新扫码绑定：运行 dsh-superagent-wechat-qr 后把新 botToken 填进账户配置',
          })
          break
        }
        state.failures += 1
        console.error('[wechat] getUpdates error account=' + account.id + ' errcode=' + errcode + ' errmsg=' + (resp.errmsg ?? ''))
        if (state.failures >= 3) {
          source.report(HEALTH_ENTRY, {
            state: 'error',
            code: 'pollFailures',
            values: { count: String(state.failures) },
            detail: account.id + ': 连续 ' + state.failures + ' 次轮询失败（errcode=' + errcode + ' ' + (resp.errmsg ?? '') + '）',
          })
        }
        await pause(2_000, signal)
        continue
      }
      state.failures = 0
      const msgs = resp.msgs ?? []
      if (msgs.length > MAX_BATCH) {
        if (resp.get_updates_buf) {
          state.cursor = resp.get_updates_buf
          cursors[account.id] = state.cursor
          void saveCursors(cursors)
        }
        console.error('[wechat] batch too large (' + msgs.length + ' > ' + MAX_BATCH + '), skipped; cursor advanced account=' + account.id)
        continue
      }
      let interrupted = false
      for (const raw of msgs) {
        if (signal.aborted) { interrupted = true; break }
        // 先缓存回复凭证再翻译：哪怕后续 scope 过滤，token 也已就位（引擎侧白名单仍生效）。
        rememberContextToken(account.id, raw.from_user_id, raw.context_token)
        const parsed = InboundMessageSchema.safeParse(raw)
        if (!parsed.success) { unreadable += 1; continue }
        const msg = parsed.data
        if (msg.create_time_ms && msg.create_time_ms > 0 && Date.now() - msg.create_time_ms > STALE_MS) continue
        const trigger = buildTrigger(account, msg)
        if (!trigger) continue
        // 首条消息即抄写来源：日志打印发送者 id 供 Policy 白名单填写（id 非凭据）。
        console.error('[wechat] msg in account=' + account.id + ' from=' + (msg.from_user_id ?? '?') + ' id=' + trigger.id + ' text="' + trigger.text.slice(0, 60) + '"')
        await source.receive(trigger)
      }
      if (interrupted) break // 游标不动，重启后重放（trigger id 幂等）
      if (resp.get_updates_buf && resp.get_updates_buf !== state.cursor) {
        state.cursor = resp.get_updates_buf
        cursors[account.id] = state.cursor
        void saveCursors(cursors)
      }
      source.report(HEALTH_ENTRY, {
        state: 'ready',
        at: new Date().toISOString(),
        detail: account.id + ': polling' + (unreadable > 0 ? ' (' + unreadable + ' unreadable)' : ''),
      })
    }
  } finally {
    if (!state.expired) {
      void notifyStop({ baseUrl, token: account.botToken }).catch(() => undefined)
    }
  }
}

export async function watch(source: SourceContextLike, signal: AbortSignal): Promise<void> {
  const cursors = await loadCursors()
  const states = new Map<string, AccountState>()
  while (!signal.aborted) {
    try {
      const config = source.config<WechatConfig>('wechat')
      channelConfig.current = config
      const accounts = config?.accounts ?? []
      if (!config || accounts.length === 0) {
        for (const state of states.values()) state.controller.abort()
        states.clear()
        source.report(HEALTH_ENTRY, { state: 'paused', detail: 'waiting for wechat accounts in settings' })
      } else {
        const wanted = new Map(accounts.map((a) => [a.id, a]))
        for (const [id, state] of [...states]) {
          if (!wanted.has(id)) {
            state.controller.abort()
            states.delete(id)
            clearContextTokens(id)
          }
        }
        let live = 0
        let missingToken = 0
        let expiredCount = 0
        for (const account of accounts) {
          if (!account.botToken) {
            missingToken += 1
            console.error('[wechat] account "' + account.id + '" has no botToken yet; run dsh-superagent-wechat-qr')
            continue
          }
          const hash = JSON.stringify([account.botToken, account.baseUrl])
          const existing = states.get(account.id)
          if (existing && existing.hash === hash) {
            if (existing.expired) expiredCount += 1
            else live += 1
            continue
          }
          if (existing) {
            existing.controller.abort()
            states.delete(account.id)
          }
          const controller = new AbortController()
          const state: AccountState = { hash, controller, done: Promise.resolve(), cursor: cursors[account.id] ?? '', expired: false, failures: 0 }
          state.done = pollAccount(source, account, state, cursors, signal).catch((error: unknown) => {
            if (!signal.aborted && !state.expired) {
              source.report(HEALTH_ENTRY, { state: 'error', detail: account.id + ': poller crashed: ' + String(error).slice(0, 200) })
            }
          })
          states.set(account.id, state)
          live += 1
        }
        if (states.size === 0) {
          source.report(HEALTH_ENTRY, { state: 'paused', detail: missingToken > 0 ? 'waiting for botToken in account rows (run dsh-superagent-wechat-qr)' : 'no polling account' })
        } else if (expiredCount > 0 && live === 0) {
          // 全部账号过期：保持 pollAccount 报出的 sessionExpired 错误，不覆盖。
        }
      }
    } catch (error) {
      source.report(HEALTH_ENTRY, { state: 'error', detail: String(error).slice(0, 300) })
    }
    await pause(5_000, signal)
  }
  for (const state of states.values()) state.controller.abort()
  await Promise.allSettled([...states.values()].map((state) => state.done))
}

