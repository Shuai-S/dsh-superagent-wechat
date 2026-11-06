/** 绑定页服务：引擎进程内 127.0.0.1 loopback HTTP 服务器 + 5s reconcile 循环。
 *
 *  生命周期仿 wecom callback/watch 先例：配置 hash（bindPageEnabled/bindPort）
 *  变化才重建服务器；EADDRINUSE 每轮重试并报可操作指引；signal abort 收尾。
 *
 *  安全模型（与 README「绑定页安全说明」一致）：
 *  - 只监听 127.0.0.1（显式 host，绝不 0.0.0.0）。
 *  - 全部路由校验 Host 头为 127.0.0.1:<port> / localhost:<port>（防 DNS rebinding）。
 *  - /qr/* 全部要求 x-bind-token 自定义头（跨站请求无法设置自定义头，防 CSRF）；
 *    token 为服务器生命周期内一发的 crypto 随机值，内嵌在页面里。
 *  - JSON 体上限 8KB；凭据经 SessionManager 一次性交付，不落日志。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { SourceContextLike } from './types.ts'
import type { WechatConfig } from './wechat-kind.ts'
import { SessionManager } from './bind-session.ts'
import type { SessionManagerOptions } from './bind-session.ts'
import { BIND_PAGE_HTML, BIND_TOKEN_PLACEHOLDER } from './bind-page.ts'

export const BIND_HEALTH_ENTRY = 'wechatBind'
export const DEFAULT_BIND_PORT = 26678
/** JSON 请求体上限。 */
const MAX_BODY_BYTES = 8 * 1024

export interface BindServerHandle {
  server: Server
  port: number
  token: string
  sessions: SessionManager
}

export interface StartBindServerOptions extends SessionManagerOptions {
  /** 缺省 DEFAULT_BIND_PORT；0 = 随机端口（仅测试用），返回实际端口。 */
  port?: number
  /** 复用既有 SessionManager（面板路由与独立页共享同一会话面）；缺省新建。 */
  sessions?: SessionManager
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.end()
    return
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('bind page: body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** Host 必须是 127.0.0.1:<port> 或 localhost:<port>（防 DNS rebinding）。 */
function hostAllowed(req: IncomingMessage, port: number): boolean {
  const host = String(req.headers.host ?? '').toLowerCase()
  return host === '127.0.0.1:' + port || host === 'localhost:' + port
}

function tokenAllowed(req: IncomingMessage, token: string): boolean {
  return req.headers['x-bind-token'] === token
}

async function handle(req: IncomingMessage, res: ServerResponse, ctx: { port: number; token: string; sessions: SessionManager }): Promise<void> {
  if (!hostAllowed(req, ctx.port)) {
    respondJson(res, 403, { error: 'forbidden: wrong host' })
    return
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const path = url.pathname

  if (path === '/' && req.method === 'GET') {
    const page = BIND_PAGE_HTML.split(BIND_TOKEN_PLACEHOLDER).join(ctx.token)
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
    })
    res.end(page)
    return
  }

  if (path.startsWith('/qr/')) {
    // 防浏览器内跨站 CSRF：跨站请求无法携带自定义头 x-bind-token。
    if (!tokenAllowed(req, ctx.token)) {
      respondJson(res, 401, { error: 'missing or invalid bind token' })
      return
    }
    if (path === '/qr/start' && req.method === 'POST') {
      respondJson(res, 200, { sessionId: ctx.sessions.start() })
      return
    }
    if (path === '/qr/status' && req.method === 'GET') {
      const id = url.searchParams.get('session') ?? ''
      const status = ctx.sessions.status(id)
      if (status === undefined) {
        respondJson(res, 404, { error: 'no session' })
        return
      }
      respondJson(res, 200, status)
      return
    }
    if (path === '/qr/verify' && req.method === 'POST') {
      let body: { session?: unknown; code?: unknown } = {}
      try {
        const raw = await readBody(req)
        if (raw.trim()) body = JSON.parse(raw) as { session?: unknown; code?: unknown }
      } catch {
        respondJson(res, 400, { error: 'invalid JSON body' })
        return
      }
      const id = typeof body.session === 'string' ? body.session : (url.searchParams.get('session') ?? '')
      const code = typeof body.code === 'string' ? body.code : ''
      if (!id) {
        respondJson(res, 400, { error: 'missing session' })
        return
      }
      const result = ctx.sessions.verify(id, code)
      if (!result.ok) {
        respondJson(res, 400, { error: result.error ?? 'verify failed' })
        return
      }
      respondJson(res, 200, { ok: true })
      return
    }
    if (path === '/qr/cancel' && req.method === 'POST') {
      let id = url.searchParams.get('session') ?? ''
      try {
        const raw = await readBody(req)
        if (raw.trim()) {
          const body = JSON.parse(raw) as { session?: unknown }
          if (typeof body.session === 'string') id = body.session
        }
      } catch {
        // 无体或非法体：仍按 query 参数取消（幂等）。
      }
      if (id) ctx.sessions.cancel(id)
      respondJson(res, 200, { ok: true })
      return
    }
    respondJson(res, 404, { error: 'not found' })
    return
  }

  respondJson(res, 404, { error: 'not found' })
}

function closeServer(server: Server | undefined): Promise<void> {
  if (!server) return Promise.resolve()
  // 掐掉 keep-alive 连接，保证 close 回调及时返回（浏览器/undici 会保活）。
  try {
    server.closeAllConnections()
  } catch {
    // 旧版 Node 无此方法：忽略。
  }
  return new Promise((resolve) => server.close(() => resolve()))
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop)
      resolve()
    }, ms)
    const stop = (): void => {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', stop, { once: true })
  })
}

/** 起一个绑定页服务器（测试注入点：port 0 = 随机端口）。只监听 127.0.0.1。 */
export async function startBindServer(opts: StartBindServerOptions = {}): Promise<BindServerHandle> {
  const token = randomBytes(16).toString('hex')
  const sessions = opts.sessions ?? new SessionManager({ qrLoginImpl: opts.qrLoginImpl })
  const ctx: { port: number; token: string; sessions: SessionManager } = { port: 0, token, sessions }
  const server = createServer((req, res) => {
    handle(req, res, ctx).catch((error: unknown) => {
      console.error('[wechat-bind] request error: ' + String(error).slice(0, 200))
      respondJson(res, 400, { error: 'bad request' })
    })
  })
  const port = await new Promise<number>((resolve, reject) => {
    let listening = false
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (!listening) reject(error)
    })
    server.listen(opts.port ?? DEFAULT_BIND_PORT, '127.0.0.1', () => {
      listening = true
      server.on('error', (error: NodeJS.ErrnoException) => {
        console.error('[wechat-bind] server error: ' + String(error).slice(0, 200))
      })
      const address = server.address()
      const actual = typeof address === 'object' && address !== null ? address.port : (opts.port ?? DEFAULT_BIND_PORT)
      ctx.port = actual
      resolve(actual)
    })
  })
  return { server, port, token, sessions }
}

/** reconcile 循环：5s 一轮，按 [bindPageEnabled, bindPort] hash 决定是否重建服务器。
 *  sessions 可传入共享的 SessionManager（index.ts 让独立页与面板路由共用一面）。 */
export async function watchBind(source: SourceContextLike, signal: AbortSignal, sessions?: SessionManager): Promise<void> {
  const state: { hash: string; handle?: BindServerHandle } = { hash: '' }
  let lastError = ''
  while (!signal.aborted) {
    let port = DEFAULT_BIND_PORT
    try {
      const config = source.config<WechatConfig>('wechat')
      const enabled = config?.bindPageEnabled ?? true
      port = config?.bindPort ?? DEFAULT_BIND_PORT
      if (!enabled) {
        if (state.handle) {
          await closeServer(state.handle.server)
          state.handle = undefined
          state.hash = ''
        }
        source.report(BIND_HEALTH_ENTRY, { state: 'paused', detail: 'bind page disabled (bindPageEnabled=false); the terminal CLI remains available' })
        lastError = ''
      } else {
        const hash = JSON.stringify([enabled, port])
        if (state.hash !== hash || !state.handle) {
          await closeServer(state.handle?.server)
          state.handle = undefined
          state.hash = ''
          const handle = await startBindServer({ port, sessions })
          state.handle = handle
          state.hash = hash
          lastError = ''
          source.report(BIND_HEALTH_ENTRY, { state: 'ready', detail: 'bind page on http://127.0.0.1:' + handle.port })
        } else if (!state.handle.server.listening) {
          source.report(BIND_HEALTH_ENTRY, { state: 'error', detail: 'bind server stopped listening' })
        }
      }
    } catch (error) {
      let detail = String(error).slice(0, 300)
      if ((error as NodeJS.ErrnoException)?.code === 'EADDRINUSE') {
        detail = '端口 ' + port + ' 被占用（EADDRINUSE），请在来源设置 bindPort 换端口后保存'
      }
      if (detail !== lastError) {
        lastError = detail
        source.report(BIND_HEALTH_ENTRY, { state: 'error', detail })
      }
    }
    await pause(5_000, signal)
  }
  await closeServer(state.handle?.server)
}
