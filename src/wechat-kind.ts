/** The 'wechat' Source kind: personal WeChat via the official ClawBot (iLink
 *  Bot API) long-poll, replies through sendmessage with the inbound
 *  context_token. Shape mirrors the bundled kinds (docs/008-cookbook.md) and
 *  the dingtalk/mail precedents; the engine duck-types it at runtime. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Localized, OutboundMessageLike, SourceKindLike, TriggerLike } from './types.ts'
import { DEFAULT_BASE_URL, normalizeBaseUrl, sendMessage } from './ilink.ts'
import { readContextToken } from './context-tokens.ts'
import { withSendSlot } from './rate-limit.ts'

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
}).strict()
export type AccountConfig = { id: string; botToken: string; ilinkBotId: string; baseUrl: string; ilinkUserId: string; name: string }
export type WechatConfig = { accounts: AccountConfig[]; windowHours: number }

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

const emptyLink = (label: Localized) => ({ url: '', label })

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
        throw new Error(lookup.reason === 'missing'
          ? 'wechat: 无 ' + to + ' 的入站 context_token —— iLink 协议不允许 Bot 冷启动（该用户从未给机器人发过消息），消息未发送；请在微信里先给机器人发一句话'
          : 'wechat: 距 ' + to + ' 最近一次入站已超 ' + config.windowHours + 'h 安全窗（服务端对超 24h 未互动用户的 Bot 消息直接丢弃），本次不发送，已留待下次入站后重试')
      }
      const baseUrl = normalizeBaseUrl(account.baseUrl || DEFAULT_BASE_URL)
      return withSendSlot(account.id, async () => {
        const chunks = splitOutboundText(text)
        for (const [index, chunk] of chunks.entries()) {
          // client_id 由出站消息 id + 分片序号确定：重试重发时同值，若平台按 client_id 去重则天然幂等。
          const clientId = 'dshsa-' + createHash('sha1').update(message.id + ':' + index).digest('hex').slice(0, 20)
          await sendMessage({
            baseUrl,
            token: account.botToken,
            msg: {
              from_user_id: '',
              to_user_id: to,
              client_id: clientId,
              message_type: 2, // BOT
              message_state: 2, // FINISH
              item_list: [{ type: 1, text_item: { text: chunk } }],
              context_token: lookup.token,
            },
          })
        }
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
    // v1: the assessment reads the trigger's own message; iLink has no
    // history API, so broader context needs local storage (M2+).
    async read(_commands: unknown, trigger: TriggerLike, part: 'thread' | 'root' | 'parent', _cursor: string | undefined, _config: WechatConfig) {
      const own = { id: String(trigger.meta.messageId ?? trigger.id), from: String(trigger.meta.fromUserId ?? trigger.actor.id), at: trigger.at, text: trigger.text }
      return { messages: part === 'parent' ? [] : [own], body: {}, status: undefined }
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
