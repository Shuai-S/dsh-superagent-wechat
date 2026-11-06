/** 面板同源绑定路由：把扫码绑定会话挂到引擎 webserver（superagent 原生面板 127.0.0.1:3082）的 /wechat 前缀下。
 *
 *  seam 选择：引擎自身的管理 API 就是这样注册的（dsh-superagent src/app/http.ts
 *  registerHttp：ctx.webServer.register({ kind: 'prefix', path: '/orchestrator', handler })），
 *  第三方 cordis 插件（inject ['webServer']）用同一 seam 可行且已被官方插件采用。
 *  面板页与这些路由同源（http://127.0.0.1:3082），无 CORS。
 *
 *  安全模型（与 src/bind.ts 的独立绑定页互补，语义对齐）：
 *  - webserver 本身只绑 127.0.0.1（引擎 registerHttp 同款前置断言）。
 *  - 本路由用引擎管理 API 同款 sameOrigin 闸门：Host 必须 127.0.0.1/localhost:<port>（防
 *    DNS rebinding）+ x-orchestrator-request: 1（跨站请求无法携带，防 CSRF；带自定义头
 *    的跨站请求会先发 CORS 预检，本路由不回应 Access-Control-* → 预检即失败）+ Origin
 *    同源校验。这是 seam 拥有者（引擎面板）自己的闸门语义；26678 独立页仍用 x-bind-token
 *    闸门不变。
 *  - 凭据经 SessionManager 一次性交付（confirmed/error 首次 status 即销毁），不落日志。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { SessionManager } from './bind-session.ts'
import type { BindStatus } from './bind-session.ts'

/** @deepseek-ai/dsh-host-webserver 的结构化最小面（不引入包依赖）。 */
export interface WebServerLike {
  readonly port: number
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** JSON 请求体上限（与 bind.ts 一致）。 */
const MAX_BODY_BYTES = 8 * 1024

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
        reject(new Error('bind panel: body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 引擎同款同源闸门（dsh-superagent src/app/http.ts sameOrigin 的镜像实现）：
 *  Host 必须 loopback:<port>，x-orchestrator-request 必须为 '1'，Origin 缺省或同源。 */
export function sameOrigin(req: Pick<IncomingMessage, 'headers'>, port: number): boolean {
  const host = req.headers.host
  if (host !== '127.0.0.1:' + port && host !== 'localhost:' + port) return false
  return req.headers['x-orchestrator-request'] === '1' &&
    (req.headers.origin === undefined || req.headers.origin === 'http://' + host)
}

async function handle(req: IncomingMessage, res: ServerResponse, ctx: { port: number; sessions: SessionManager }): Promise<void> {
  if (!sameOrigin(req, ctx.port)) {
    respondJson(res, 403, { error: 'Same-origin management request required' })
    return
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (!url.pathname.startsWith('/wechat/')) {
    respondJson(res, 404, { error: 'not found' })
    return
  }
  const path = url.pathname.slice('/wechat'.length)

  if (path === '/api/qr/start' && req.method === 'POST') {
    respondJson(res, 200, { sessionId: ctx.sessions.start() })
    return
  }
  if (path === '/api/qr/status' && req.method === 'GET') {
    const id = url.searchParams.get('session') ?? ''
    const status: BindStatus | undefined = ctx.sessions.status(id)
    if (status === undefined) {
      respondJson(res, 404, { error: 'no session' })
      return
    }
    respondJson(res, 200, status)
    return
  }
  if (path === '/api/qr/verify' && req.method === 'POST') {
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
  if (path === '/api/qr/cancel' && req.method === 'POST') {
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
}

/** 面板路由处理器（测试注入点：直接拿 handler 挂在任意 http server 上，url 需带 /wechat 前缀）。 */
export function createPanelHandler(sessions: SessionManager, port: number): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    await handle(req, res, { port, sessions })
  }
}

/** 在引擎 webserver 上注册 /wechat 前缀路由，返回卸载 disposer。 */
export function registerPanelRoutes(webServer: WebServerLike, sessions: SessionManager): () => void {
  const handler = createPanelHandler(sessions, webServer.port)
  return webServer.register({
    kind: 'prefix',
    path: '/wechat',
    handler: (req, res) => {
      handler(req, res).catch((error: unknown) => {
        // 只记错误码级信息，绝不落请求体（可能含配对码）。
        console.error('[wechat-bind-panel] request error: ' + String(error).slice(0, 200))
        respondJson(res, 400, { error: 'bad request' })
      })
    },
  })
}
