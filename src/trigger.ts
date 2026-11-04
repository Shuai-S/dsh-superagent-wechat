/** Translate an inbound iLink WeixinMessage into a Trigger.
 *  Mapping (docs/ilink-notes.md): one message = one Trigger; Thread = the
 *  private chat with the sender; Actor = from_user_id; every DM message is an
 *  explicit direct assignment. Meta and text are untrusted data. */
import { z } from 'zod'
import { ITEM_TYPE, MESSAGE_TYPE } from './ilink.ts'
import type { TriggerLike } from './types.ts'
import type { AccountConfig } from './wechat-kind.ts'

/** 入站消息防御式 schema：协议字段全部可选，未知字段透传不校验。 */
export const InboundItemSchema = z.looseObject({
  type: z.number().optional(),
  text_item: z.looseObject({ text: z.string().optional() }).optional(),
  voice_item: z.looseObject({ text: z.string().optional() }).optional(),
})

export const InboundMessageSchema = z.looseObject({
  seq: z.number().optional(),
  message_id: z.number().optional(),
  from_user_id: z.string().optional(),
  to_user_id: z.string().optional(),
  client_id: z.string().optional(),
  session_id: z.string().optional(),
  group_id: z.string().optional(),
  message_type: z.number().optional(),
  message_state: z.number().optional(),
  context_token: z.string().optional(),
  create_time_ms: z.number().optional(),
  item_list: z.array(InboundItemSchema).optional(),
})

export type InboundMessage = z.infer<typeof InboundMessageSchema>

/** M1 媒体占位标记：image/file/video 只在文本里占位，CDN+AES 下载在 M2 接线
 *  （先例：dingtalk threadContext.images + attachments.saveImage）。 */
const MEDIA_MARKERS: Record<number, string> = {
  [ITEM_TYPE.IMAGE]: '[wechat-image]',
  [ITEM_TYPE.VOICE]: '[wechat-voice]',
  [ITEM_TYPE.FILE]: '[wechat-file]',
  [ITEM_TYPE.VIDEO]: '[wechat-video]',
}

/** 文本只取 text_item 与 voice 的服务端 ASR 转写；其余类型按占位标记拼接。 */
export function extractInboundText(items: InboundMessage['item_list']): string {
  const parts: string[] = []
  for (const item of items ?? []) {
    const type = item.type ?? 0
    if (type === ITEM_TYPE.TEXT) {
      const text = item.text_item?.text?.trim()
      if (text) parts.push(text)
    } else if (type === ITEM_TYPE.VOICE) {
      const transcribed = item.voice_item?.text?.trim()
      parts.push(transcribed || '[wechat-voice]')
    } else {
      const marker = MEDIA_MARKERS[type]
      if (marker) parts.push(marker)
    }
  }
  return parts.join('\n').trim()
}

/** 消息幂等键：message_id（数字）优先，缺省回落 client_id；两者皆缺的消息不可用。 */
export function inboundMessageKey(msg: InboundMessage): string {
  if (typeof msg.message_id === 'number') return String(msg.message_id)
  const clientId = (msg.client_id ?? '').trim()
  return clientId
}

/** Trigger 翻译；机器人自己的消息（type=2）、群消息、无发送者/无键/无文本的消息产出 undefined。 */
export function buildTrigger(account: AccountConfig, msg: InboundMessage): TriggerLike | undefined {
  if (msg.message_type === MESSAGE_TYPE.BOT) return undefined
  if (msg.group_id) return undefined // ClawBot 通道仅私聊；带 group_id 的消息忽略
  const from = (msg.from_user_id ?? '').trim()
  if (!from) return undefined
  const idKey = inboundMessageKey(msg)
  if (!idKey) return undefined
  const text = extractInboundText(msg.item_list)
  if (!text) return undefined
  const at = msg.create_time_ms && msg.create_time_ms > 0 ? new Date(msg.create_time_ms).toISOString() : new Date().toISOString()
  const threadId = 'u:' + from
  return {
    id: 'wechat:' + idKey,
    source: 'wechat',
    threads: [{ source: 'wechat', id: threadId }],
    actor: { source: 'wechat', id: from },
    human: true,
    addressed: 'direct',
    at,
    text,
    channel: { source: 'wechat', thread: 'wechat:' + threadId, address: { accountId: account.id, to: from } },
    meta: { accountId: account.id, messageId: idKey, fromUserId: from, accountName: account.name ?? '' },
  }
}

