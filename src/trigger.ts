/** Translate an inbound iLink WeixinMessage into a Trigger.
 *  Mapping (docs/ilink-notes.md): one message = one Trigger; Thread = the
 *  private chat with the sender; Actor = from_user_id; every DM message is an
 *  explicit direct assignment. Meta and text are untrusted data.
 *
 *  Media (C4): image/file/video items derive a KEY "<message_id>:<item_index>"
 *  from the original message; trigger.text embeds "[wechat-image:KEY]"-style
 *  markers so threadContext.images()/image() can re-fetch exactly that item
 *  (keys only ever come from the original text — never parsed from elsewhere).
 *  File/video are pre-downloaded by the poller; their path hints ride along. */
import { z } from 'zod'
import { ITEM_TYPE, MESSAGE_TYPE } from './ilink.ts'
import type { TriggerLike } from './types.ts'
import type { AccountConfig } from './wechat-kind.ts'
import { deriveMediaRefs, type DownloadedNote, type MediaRef } from './media.ts'

/** 入站消息防御式 schema：协议字段全部可选，未知字段透传不校验。 */
export const InboundItemSchema = z.looseObject({
  type: z.number().optional(),
  text_item: z.looseObject({ text: z.string().optional() }).optional(),
  voice_item: z.looseObject({ text: z.string().optional() }).optional(),
  image_item: z.looseObject({
    media: z.looseObject({ encrypt_query_param: z.string().optional(), aes_key: z.string().optional(), full_url: z.string().optional() }).optional(),
    aeskey: z.string().optional(),
  }).optional(),
  file_item: z.looseObject({
    media: z.looseObject({ encrypt_query_param: z.string().optional(), aes_key: z.string().optional(), full_url: z.string().optional() }).optional(),
    file_name: z.string().optional(),
  }).optional(),
  video_item: z.looseObject({
    media: z.looseObject({ encrypt_query_param: z.string().optional(), aes_key: z.string().optional(), full_url: z.string().optional() }).optional(),
  }).optional(),
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

/** 消息幂等键：message_id（数字）优先，缺省回落 client_id；两者皆缺的消息不可用。 */
export function inboundMessageKey(msg: InboundMessage): string {
  if (typeof msg.message_id === 'number') return String(msg.message_id)
  return (msg.client_id ?? '').trim()
}

function mediaMarker(kind: 'image' | 'file' | 'video', ref: MediaRef | undefined): string {
  return ref ? '[wechat-' + kind + ':' + ref.key + ']' : '[wechat-' + kind + ']'
}

/** Trigger 翻译；机器人自己的消息（type=2）、群消息、无发送者/无键/无文本的消息产出 undefined。 */
export function buildTrigger(account: AccountConfig, msg: InboundMessage, downloaded: DownloadedNote[] = []): TriggerLike | undefined {
  if (msg.message_type === MESSAGE_TYPE.BOT) return undefined
  if (msg.group_id) return undefined // ClawBot 通道仅私聊；带 group_id 的消息忽略
  const from = (msg.from_user_id ?? '').trim()
  if (!from) return undefined
  const idKey = inboundMessageKey(msg)
  if (!idKey) return undefined
  // 媒体引用先派生并登记索引（幂等：同 key 重复登记无害），再组文本。
  const refs = deriveMediaRefs(account.id, idKey, msg.item_list)
  const parts: string[] = []
  for (const [index, item] of (msg.item_list ?? []).entries()) {
    const type = item.type ?? 0
    if (type === ITEM_TYPE.TEXT) {
      const text = item.text_item?.text?.trim()
      if (text) parts.push(text)
    } else if (type === ITEM_TYPE.VOICE) {
      parts.push(item.voice_item?.text?.trim() || '[wechat-voice]')
    } else if (type === ITEM_TYPE.IMAGE) {
      parts.push(mediaMarker('image', refs.get(index)))
    } else if (type === ITEM_TYPE.FILE) {
      parts.push(mediaMarker('file', refs.get(index)))
    } else if (type === ITEM_TYPE.VIDEO) {
      parts.push(mediaMarker('video', refs.get(index)))
    }
  }
  let text = parts.join('\n').trim()
  if (!text) return undefined
  // 文件/视频已由 poller 预落盘：路径注入文本供 agent 的 read/bash 工具消化；失败降级说明。
  if (downloaded.length > 0) {
    const notes = downloaded.map((note) => {
      const label = note.kind === 'video' ? '视频' : '文件'
      if (note.path) {
        const hint = note.kind === 'video' ? '如需理解内容，可用 ffmpeg 抽帧后用 read_image 查看' : '用 read/bash 工具查看内容'
        return '[' + label + '已保存: ' + note.path + (note.name ? '（原名: ' + note.name + '）' : '') + ' —— ' + hint + ']'
      }
      return '[微信' + label + '下载失败' + (note.error ? ': ' + note.error : '') + ']'
    })
    text = text + '\n' + notes.join('\n')
  }
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
