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

export const name: string = 'dsh-superagent-wechat'
export const inject: string[] = ['orchestrator']

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
}
export { wechatKind, WechatConfigSchema, HEALTH_ENTRY } from './wechat-kind.ts'
export { splitOutboundText } from './wechat-kind.ts'
export { buildTrigger, extractInboundText } from './trigger.ts'
export { rememberContextToken, readContextToken, clearContextTokens } from './context-tokens.ts'
export { normalizeBaseUrl, responseErrcode, IlinkError, IlinkSessionExpiredError } from './ilink.ts'
// 媒体原语（M1 仅导出契约面，M2 接线消费；自检/测试也走这里）
export { encryptBuffer, decryptBuffer, aesEcbPaddedSize, parseAesKey, uploadToCdn, buildCdnDownloadUrl } from './ilink.ts'
export { qrLogin } from './qr.ts'
export type { QrCredentials, QrLoginCallbacks } from './qr.ts'
