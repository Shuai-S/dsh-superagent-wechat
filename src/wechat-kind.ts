/** The 'wechat' Source kind: personal WeChat via the official ClawBot (iLink
 *  Bot API) long-poll, replies through sendmessage with the inbound
 *  context_token. Shape mirrors the bundled kinds (docs/008-cookbook.md) and
 *  the dingtalk/mail precedents; the engine duck-types it at runtime.
 *
 *  M2 additions: local conversation history (the only history source — iLink
 *  has none), multi-page threadContext, image inspection via CDN+AES, and the
 *  opt-in pending/resend path for messages refused by the 24h window. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Localized, OutboundMessageLike, SourceKindLike, TriggerLike } from './types.ts'
import { DEFAULT_BASE_URL, normalizeBaseUrl, sendMessage } from './ilink.ts'
import { readContextToken, rememberContextToken } from './context-tokens.ts'
import { withSendSlot } from './rate-limit.ts'
import { downloadMediaBuffer, sniffImageType } from './media.ts'
import { appendHistory, readHistoryPage } from './history.ts'
import { clearPending, dropPending, enqueuePending, readPending } from './pending.ts'

export const HEALTH_ENTRY = 'wechatPoll'

export const WechatConfigSchema = z.object({
  accounts: z.array(z.object({
    id: z.string().min(1),
    botToken: z.string().default(''),
    ilinkBotId: z.string().default(''),
    baseUrl: z.string().default(''),
    ilinkUserId: z.string().default(''),
    name: z.string().default(''),
  })).default([]),
  /** 主动推送安全窗：服务端丢弃用户超 24h 未互动后的 Bot 消息，默认按 20h 拒发。 */
  windowHours: z.number().int().min(1).max(23).default(20),
  /** 超窗补发开关（C6）：开启后超窗被拒的出站文本暂存本地，等该用户下次入站拿到新
   *  context_token 后尽力补发。这只是入站触发的额外尽力，不替代引擎 Outbox 的重试。 */
  resendOnWindowExpired: z.boolean().default(false),
}).strict()
export type AccountConfig = { id: string; botToken: string; ilinkBotId: string; baseUrl: string; ilinkUserId: string; name: string }
export type WechatConfig = { accounts: AccountConfig[]; windowHours: number; resendOnWindowExpired: boolean }

// channel.send reads config through this holder; watch() refreshes it every round.
export const channelConfig: { current?: WechatConfig } = {}

const CHUNK_CHARS = 1800

/** 出站文本切分：优先在换行处断开（且不短于 60% 上限），否则硬切；微信单条上限内再取保守值。 */
export function splitOutboundText(text: string, maxChars = CHUNK_CHARS): string[] {
  const clean = text.replace(/\r\n/g, '\n')
  if (clean.length <= maxChars) return [clean]
  const chunks: string[] = []
  let rest = clean
  while (rest.length > maxChars) {
    let splitAt = rest.lastIndexOf('\n', maxChars)
    if (splitAt < Math.floor(maxChars * 0.6)) splitAt = maxChars
    chunks.push(rest.slice(0, splitAt))
    rest = rest.slice(splitAt).replace(/^\n+/, '')
  }
  if (rest) chunks.push(rest)
  return chunks
}

/** 幂等 client_id：由出站消息 id + 分片序号确定性派生（同 id 重发同值，便于平台侧去重）。 */
export function outboundClientId(idSeed: string, index: number): string {
  return 'dshsa-' + createHash('sha1').update(idSeed + ':' + index).digest('hex').slice(0, 20)
}

const emptyLink = (label: Localized) => ({ url: '', label })

/** 出站文本发送（channel.send 与超窗补发共用）：分片逐条 sendmessage。 */
export async function sendTextChunks(account: AccountConfig, to: string, text: string, idSeed: string, contextToken: string, signal?: AbortSignal): Promise<void> {
  const baseUrl = normalizeBaseUrl(account.baseUrl || DEFAULT_BASE_URL)
  const chunks = splitOutboundText(text)
  for (const [index, chunk] of chunks.entries()) {
    await sendMessage({
      baseUrl,
      token: account.botToken,
      signal,
      msg: {
        from_user_id: '',
        to_user_id: to,
        client_id: outboundClientId(idSeed, index),
        message_type: 2, // BOT
        message_state: 2, // FINISH
        item_list: [{ type: 1, text_item: { text: chunk } }],
        context_token: contextToken,
      },
    })
  }
}

/** 超窗补发（C6）：该用户下次入站拿到新 context_token 后逐条补发暂存文本。
 *  逐条成功逐条移除（失败保留剩余，等下次入站再试）；补发文本记入本地历史。 */
export async function tryResendPending(account: AccountConfig, userId: string, windowHours: number): Promise<boolean> {
  const lookup = readContextToken(account.id, userId, windowHours)
  if (!lookup.ok) return false
  const entries = await readPending(account.id, userId)
  if (entries.length === 0) return false
  for (const entry of entries) {
    try {
      await withSendSlot(account.id, () => sendTextChunks(account, userId, entry.text, entry.messageId, lookup.token))
      await dropPending(account.id, userId, entry.messageId)
      await appendHistory(account.id, userId, { id: entry.messageId, from: 'bot', at: new Date().toISOString(), text: entry.text, bot: true }).catch(() => undefined)
      console.error('[wechat] resent pending message to ' + userId + ' (messageId=' + entry.messageId + ')')
    } catch (error) {
      console.error('[wechat] resend failed, keeping pending: ' + String(error).slice(0, 200))
      return false
    }
  }
  await clearPending(account.id, userId)
  return true
}

/** threadContext.images 用的 key 提取：只认本 Source 原文里的标记（防任意注入）。 */
export function wechatImageKeys(text: string): string[] {
  return [...new Set([...text.matchAll(/\[wechat-image:([^\]]+)\]/g)].map((m) => m[1] ?? ''))].filter(Boolean)
}

const IMAGE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

export const wechatKind = {
  kind: 'wechat',
  title: { zh: '微信（ClawBot）', en: 'WeChat (ClawBot)' },
  description: {
    zh: '个人微信 ClawBot（iLink 官方 Bot API）长轮询直连：私聊给机器人发消息即可派活，回复直接回微信。需先扫码绑定取凭据。',
    en: 'Personal WeChat ClawBot (official iLink Bot API) long-poll: DM the bot to dispatch; replies go straight back. Bind via QR scan first.',
  },
  schema: WechatConfigSchema,
  fields: [
    { key: 'accounts', type: 'rows', dialog: true, label: { zh: '微信账号', en: 'WeChat accounts' }, columns: [
      { key: 'id', type: 'text', label: { zh: '账号标识', en: 'Account id' }, hint: { zh: '自定义短标识（如 main），用于准入行、游标与回复路由', en: 'Custom short key (e.g. main); keys admission rows, cursors and reply routing' } },
      { key: 'botToken', type: 'text', label: { zh: 'Bot Token（bot_token）', en: 'Bot token' }, hint: { zh: '运行 dsh-superagent-wechat-qr 扫码获得；明文存于引擎配置（本地 sqlite，仅本机可读），不落日志', en: 'From the dsh-superagent-wechat-qr CLI; stored in local engine config, never logged' } },
      { key: 'ilinkBotId', type: 'text', label: { zh: 'Bot ID（ilink_bot_id）', en: 'Bot ID (ilink_bot_id)' }, optional: true, hint: { zh: '扫码返回值，仅作展示对账', en: 'From the QR result; display only' } },
      { key: 'baseUrl', type: 'text', label: { zh: 'API 基址（baseurl）', en: 'API base URL' }, optional: true, hint: { zh: '留空用默认 https://ilinkai.weixin.qq.com；优先填扫码返回的 baseurl（就近 IDC）', en: 'Defaults to https://ilinkai.weixin.qq.com; prefer the baseurl from the QR result' } },
      { key: 'ilinkUserId', type: 'text', label: { zh: '扫码者 ID（ilink_user_id）', en: 'Scanner id (ilink_user_id)' }, optional: true, hint: { zh: '扫码者个人 id，仅作展示对账', en: 'Scanner user id; display only' } },
      { key: 'name', type: 'text', label: { zh: '名称', en: 'Name' }, optional: true, hint: { zh: '仅用于面板显示', en: 'Display only' } },
    ] },
    { key: 'windowHours', type: 'number', advanced: true, min: 1, max: 23, label: { zh: '主动推送安全窗 / 小时', en: 'Proactive window / hours' }, hint: { zh: '服务端丢弃用户超 24h 未互动后的 Bot 消息；默认按 20h 拒发并等下次入站', en: 'The server drops bot messages to users idle over 24h; refuse after 20h by default' } },
    { key: 'resendOnWindowExpired', type: 'switch', label: { zh: '超窗暂存补发', en: 'Resend after window' }, hint: { zh: '开启后超窗被拒的出站文本暂存本地（每用户最多 3 条），该用户下次发消息时尽力补发；不替代 Outbox 重试', en: 'Park window-refused outbound text (max 3 per user) and resend on the next inbound; complements, not replaces, the Outbox' } },
  ],
  health: [HEALTH_ENTRY],
  scope(input: { meta: Record<string, unknown> }, config: WechatConfig) {
    const accountId = String(input.meta.accountId ?? '')
    const account = config.accounts.find((a) => a.id === accountId)
    if (!account) return { listened: false, reason: 'wechat: account not configured: ' + accountId }
    return { listened: true, observed: false, row: account.id }
  },
  channel: {
    async send(_host: unknown, message: OutboundMessageLike): Promise<'sent' | 'gone'> {
      const config = channelConfig.current
      if (!config) throw new Error('wechat: channel not ready (no config yet)')
      const address = message.channel.address as { accountId?: string; to?: string }
      const account = config.accounts.find((a) => a.id === address.accountId)
      if (!account) throw new Error('wechat: account not found: ' + String(address.accountId ?? ''))
      if (!account.botToken) throw new Error('wechat: account has no botToken yet: ' + account.id)
      const to = String(address.to ?? '')
      if (!to) throw new Error('wechat: reply target missing (address.to)')
      const text = message.text
      if (!text || !text.trim()) throw new Error('wechat: refuse to send an empty message')
      const lookup = readContextToken(account.id, to, config.windowHours)
      if (!lookup.ok) {
        if (lookup.reason === 'expired' && config.resendOnWindowExpired) {
          await enqueuePending(account.id, to, { messageId: message.id, text, at: new Date().toISOString() })
          throw new Error('wechat: 距 ' + to + ' 最近一次入站已超 ' + config.windowHours + 'h 安全窗（服务端对超 24h 未互动用户的 Bot 消息直接丢弃），本次不发送；已暂存待补发（resendOnWindowExpired），该用户下次发消息时自动补发')
        }
        throw new Error(lookup.reason === 'missing'
          ? 'wechat: 无 ' + to + ' 的入站 context_token —— iLink 协议不允许 Bot 冷启动（该用户从未给机器人发过消息），消息未发送；请在微信里先给机器人发一句话'
          : 'wechat: 距 ' + to + ' 最近一次入站已超 ' + config.windowHours + 'h 安全窗（服务端对超 24h 未互动用户的 Bot 消息直接丢弃），本次不发送，已留待下次入站后重试')
      }
      return withSendSlot(account.id, async () => {
        await sendTextChunks(account, to, text, message.id, lookup.token)
        await appendHistory(account.id, to, { id: message.id, from: 'bot', at: new Date().toISOString(), text, bot: true }).catch((error: unknown) => {
          console.error('[wechat] history append failed (sent anyway): ' + String(error).slice(0, 160))
        })
        return 'sent' as const
      })
    },
    link(address: Record<string, string>) {
      return emptyLink({ zh: '微信 ' + String(address.accountId ?? ''), en: 'WeChat ' + String(address.accountId ?? '') })
    },
  },
  threadContext: {
    messageId(trigger: TriggerLike): string {
      return String(trigger.meta.messageId ?? '')
    },
    // C4：images 从文本提取本 Source 的标记 key；image() 按 dingtalk 先例经宿主
    // attachments.saveImage 注入会话（下载 + AES 解密在 src/media.ts）。
    images(text: string): string[] {
      return wechatImageKeys(text)
    },
    async image(agent: unknown, _commands: unknown, trigger: TriggerLike, message: { id: string; text: string }, key: string, _stateDir: string, signal: AbortSignal) {
      if (!wechatImageKeys(message.text).includes(key)) throw new Error('Choose an image key from this source message')
      const config = channelConfig.current
      if (!config) throw new Error('wechat: channel not ready (no config yet)')
      const accountId = String(trigger.meta.accountId ?? '')
      const account = config.accounts.find((a) => a.id === accountId)
      if (!account || !account.botToken) throw new Error('wechat: account not available for media download: ' + accountId)
      const host = agent as {
        ctx?: { get?: (name: string) => unknown }
        session?: { requestHeader?: () => { config?: { provider?: string; model?: string } } }
        options?: { provider?: string; model?: string }
      }
      const attachments = host.ctx?.get?.('attachments') as {
        saveImage: (input: { data: Buffer; mediaType: string; name: string }) => Promise<unknown>
        imageLimits?: { maxImageBytes?: number; maxMessageImageBytes?: number }
      } | undefined
      if (!attachments?.saveImage) throw new Error('Image reading is unavailable: no attachment service is mounted')
      const route = host.session?.requestHeader?.()?.config
      const provider = route?.provider ?? host.options?.provider
      const model = route?.model ?? host.options?.model
      const llm = host.ctx?.get?.('llm') as { resolveModelInfo?: (p: string, m: string, s: AbortSignal) => Promise<{ inputModalities?: string[] }> } | undefined
      if (!llm?.resolveModelInfo || !provider || !model) throw new Error('Image reading is unavailable: the current model route is unresolved')
      const info = await llm.resolveModelInfo(provider, model, signal)
      if (!info.inputModalities?.includes('image')) throw new Error('Model ' + model + ' does not support image input; the image has not been inspected')
      signal.throwIfAborted()
      const { data } = await downloadMediaBuffer(accountId, key, signal)
      const sniffed = sniffImageType(data)
      if (!sniffed) throw new Error('解密后的媒体不是已知图片格式（png/jpeg/gif/webp）——多半是 aes_key 形态与协议不符或密文损坏，已放弃注入而非猜测')
      const maxBytes = Math.min(attachments.imageLimits?.maxImageBytes ?? 20 * 1024 * 1024, attachments.imageLimits?.maxMessageImageBytes ?? 20 * 1024 * 1024)
      if (data.length > maxBytes) throw new Error('The image exceeds the ' + maxBytes + ' byte limit')
      const name = 'wechat-' + key.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) + '.' + (IMAGE_EXT[sniffed.mediaType] ?? 'bin')
      const image = await attachments.saveImage({ data, mediaType: sniffed.mediaType, name })
      signal.throwIfAborted()
      return { source_message_id: message.id, image_key: key, image }
    },
    // C5：本地历史即唯一历史源。read 按页向更早读（cursor=文件 offset）；
    // 私聊平铺无父消息，part='parent' 返回空（dingtalk/mail 同款语义）。
    async read(_commands: unknown, trigger: TriggerLike, part: 'thread' | 'root' | 'parent', cursor: string | undefined, _config: WechatConfig) {
      if (part === 'parent') return { messages: [], body: {}, status: undefined }
      const accountId = String(trigger.meta.accountId ?? '')
      const userId = String(trigger.meta.fromUserId ?? trigger.actor.id)
      if (!accountId || !userId) return { messages: [], body: {}, status: undefined }
      const page = await readHistoryPage(accountId, userId, cursor)
      return { messages: page.messages, ...(page.next !== undefined ? { next: page.next } : {}), body: { messages: page.messages }, status: undefined }
    },
  },
  policy: {
    schema: z.object({
      allowed: z.array(z.object({ id: z.string(), name: z.string().optional() })).default([]),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '允许派活的微信用户', en: 'Allowed WeChat users' }, columns: [
        { key: 'id', type: 'text', label: { zh: '用户 ID（from_user_id）', en: 'User id (from_user_id)' }, hint: { zh: '机器人收到首条消息时日志会打印发送者 id，照抄到此处', en: 'The first inbound message logs the sender id; copy it here' } },
        { key: 'name', type: 'text', label: { zh: '名称', en: 'Name' }, optional: true },
      ] },
    ],
    explicit: { zh: '在微信私聊里给机器人发消息', en: 'Direct-messaging the bot in WeChat' },
    rows(config: Record<string, unknown>) {
      const accounts = (Array.isArray(config.accounts) ? config.accounts : []) as AccountConfig[]
      return accounts.map((account) => ({
        id: account.id,
        label: account.name || account.id,
        note: { zh: '私聊消息均为明确指派', en: 'DMs are explicit assignments' },
        cells: { listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: true },
      }))
    },
  },
} as unknown as SourceKindLike
