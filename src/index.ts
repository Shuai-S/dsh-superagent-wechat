/**
 * dsh-superagent-wechat — WeChat (ClawBot/iLink) Source for dsh-superagent.
 *
 * Registers the 'wechat' Source kind through the same extension seam the
 * bundled watchers use (inject 'orchestrator'), keeps one long-poll connection
 * per configured account alive, and replies via sendmessage with the inbound
 * context_token.
 *
 * @module dsh-superagent-wechat
 */
import type { Context } from '@deepseek-ai/cordis'
import type { OrchestratorLike } from './types.ts'
import { wechatKind, HEALTH_ENTRY } from './wechat-kind.ts'
import { watch } from './watch.ts'
import { watchBind, BIND_HEALTH_ENTRY } from './bind.ts'
import { SessionManager } from './bind-session.ts'
import { registerPanelRoutes, type WebServerLike } from './bind-panel.ts'

export const name: string = 'dsh-superagent-wechat'
// webServer = 引擎面板 webserver（同源绑定路由 seam，与引擎自身管理 API 同款）。
export const inject: string[] = ['orchestrator', 'webServer']

export function apply(ctx: Context): void {
  const orchestrator = (ctx as unknown as { orchestrator: OrchestratorLike }).orchestrator
  ctx.effect(() => orchestrator.sources.register(wechatKind), 'wechat: source kind')
  ctx.effect(() => {
    const source = orchestrator.context(wechatKind)
    const controller = new AbortController()
    const running = watch(source, controller.signal).catch((error: unknown) => {
      source.report(HEALTH_ENTRY, { state: 'error', detail: String(error).slice(0, 300) })
    })
    return async () => { controller.abort(); await running }
  })
  // 扫码绑定：一个 SessionManager 供两个前端共用——26678 独立页（token 闸门）
  // 与面板同源路由（sameOrigin 闸门）；单飞/一次性交付语义在管理器层面天然共享。
  const sessions = new SessionManager()
  // 26678 独立绑定页：同款生命周期，独立健康位 wechatBind。
  ctx.effect(() => {
    const source = orchestrator.context(wechatKind)
    const controller = new AbortController()
    const running = watchBind(source, controller.signal, sessions).catch((error: unknown) => {
      source.report(BIND_HEALTH_ENTRY, { state: 'error', detail: String(error).slice(0, 300) })
    })
    return async () => { controller.abort(); await running }
  }, 'wechat: bind page')
  // 引擎面板（3082）同源绑定路由：client bundle（lib/client.js）的「微信绑定」页走这里。
  const webServer = (ctx as unknown as { webServer?: WebServerLike }).webServer
  if (webServer) {
    ctx.effect(() => registerPanelRoutes(webServer, sessions), 'wechat: panel bind routes')
  }
}
export { wechatKind, WechatConfigSchema, HEALTH_ENTRY, splitOutboundText, outboundClientId, sendTextChunks, tryResendPending, wechatImageKeys } from './wechat-kind.ts'
// 面板扫码绑定页（QR 编码器 / 会话状态机 / loopback 服务器）
export { watchBind, startBindServer, BIND_HEALTH_ENTRY } from './bind.ts'
export { SessionManager } from './bind-session.ts'
// 引擎面板同源绑定路由（webServer seam）
export { registerPanelRoutes, createPanelHandler, sameOrigin, type WebServerLike } from './bind-panel.ts'
export { encodeQrSvg, encodeQrMatrix } from './bind-qr.ts'
export { buildTrigger, inboundMessageKey } from './trigger.ts'
export { rememberContextToken, readContextToken, clearContextTokens } from './context-tokens.ts'
export { normalizeBaseUrl, responseErrcode, IlinkError, IlinkSessionExpiredError } from './ilink.ts'
// 媒体原语与下载（C4）
export { encryptBuffer, decryptBuffer, aesEcbPaddedSize, parseAesKey, uploadToCdn, buildCdnDownloadUrl } from './ilink.ts'
export { deriveMediaRefs, downloadMediaBuffer, downloadIlinkMediaToFile, sniffImageType, resolveMediaAesKey, readMedia, forgetMedia } from './media.ts'
export type { MediaRef, MediaKind, DownloadedNote } from './media.ts'
// 本地历史与暂存补发（C5/C6）
export { appendHistory, readHistoryPage, HISTORY_LIMIT } from './history.ts'
export { enqueuePending, readPending, dropPending, clearPending, PENDING_MAX } from './pending.ts'
