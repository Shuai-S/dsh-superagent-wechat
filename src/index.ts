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
export { wechatKind, WechatConfigSchema, HEALTH_ENTRY, splitOutboundText, outboundClientId, sendTextChunks, tryResendPending, wechatImageKeys } from './wechat-kind.ts'
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
