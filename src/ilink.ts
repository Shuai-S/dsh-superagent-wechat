/** Minimal iLink (WeChat ClawBot) HTTP client — four wire primitives the
 *  Source needs: getupdates / sendmessage / getuploadurl+CDN upload, plus the
 *  QR login pair and lifecycle notifications.
 *
 *  Contract reference: Tencent official openclaw-weixin 2.4.10 TS source (MIT,
 *  read in full; see docs/ilink-notes.md), cross-checked against
 *  weixin-ilink / @pawastation/ilink-bot-sdk / @zhin.js adapter-weixin-ilink.
 *  The official npm package is NOT used as a runtime dependency: its only
 *  export is the OpenClaw plugin entry (peer-dep "openclaw"), and its internals
 *  import openclaw/plugin-sdk at module load, which does not exist here.
 *
 *  Security: the API/QR base URL is normalized to https://*.weixin.qq.com on
 *  443 only, so the bot token can never leak to another host. */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'
export const DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'
/** 官方包 package.json 顶层 ilink_appid 字段值（2.4.10 实读）。 */
export const ILINK_APP_ID = 'bot'
/** iLink-App-ClientVersion：uint32 = major<<16 | minor<<8 | patch（官方 buildClientVersion 同式）。 */
export const ILINK_APP_CLIENT_VERSION = (2 << 16) | (4 << 8) | 10
/** base_info.channel_version：跟随官方协议版本 2.4.6 格式（官方包版本号即协议版本载体）。 */
export const CHANNEL_VERSION = '2.4.10'
/** base_info.bot_agent：UA 风格自报身份，仅观测用，不参与鉴权/路由。 */
export const BOT_AGENT = 'dsh-superagent-wechat/0.1.0'
export const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000
export const DEFAULT_API_TIMEOUT_MS = 15_000
export const DEFAULT_QR_POLL_TIMEOUT_MS = 35_000
export const DEFAULT_BOT_TYPE = '3'
/** 服务端返回的会话过期码：登录失效，需重新扫码。 */
export const SESSION_EXPIRED_ERRCODE = -14

export const MESSAGE_TYPE = { NONE: 0, USER: 1, BOT: 2 } as const
export const ITEM_TYPE = { NONE: 0, TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 } as const
export const UPLOAD_MEDIA_TYPE = { IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 } as const

export class IlinkError extends Error {
  readonly code: string
  readonly status?: number
  constructor(code: string, message: string, status?: number) {
    super(message)
    this.name = 'IlinkError'
    this.code = code
    this.status = status
  }
}

/** errcode -14：bot_token 失效。上层据此报健康错误并停该账号轮询，等重新扫码。 */
export class IlinkSessionExpiredError extends IlinkError {
  constructor(detail: string) {
    super('session-expired', '登录已过期（errcode -14）：' + detail)
    this.name = 'IlinkSessionExpiredError'
  }
}

export interface BaseInfo { channel_version: string; bot_agent: string }

export interface TextItem { text?: string }
export interface CDNMedia { encrypt_query_param?: string; aes_key?: string; encrypt_type?: number; full_url?: string }
export interface ImageItem { media?: CDNMedia; thumb_media?: CDNMedia; aeskey?: string; url?: string; mid_size?: number }
export interface VoiceItem { media?: CDNMedia; encode_type?: number; playtime?: number; text?: string }
export interface FileItem { media?: CDNMedia; file_name?: string; md5?: string; len?: string }
export interface VideoItem { media?: CDNMedia; video_size?: number; play_length?: number; thumb_media?: CDNMedia }
export interface MessageItem {
  type?: number
  create_time_ms?: number
  msg_id?: string
  text_item?: TextItem
  voice_item?: VoiceItem
  image_item?: ImageItem
  file_item?: FileItem
  video_item?: VideoItem
  ref_msg?: { title?: string; message_item?: MessageItem }
}
/** proto: WeixinMessage。字段在协议里全部可选，消费侧防御式解析。 */
export interface WeixinMessage {
  seq?: number
  message_id?: number
  from_user_id?: string
  to_user_id?: string
  client_id?: string
  session_id?: string
  group_id?: string
  message_type?: number
  message_state?: number
  item_list?: MessageItem[]
  context_token?: string
  create_time_ms?: number
}

export interface GetUpdatesResp {
  ret?: number
  errcode?: number
  errmsg?: string
  msgs?: WeixinMessage[]
  /** 游标：客户端持有并回传，需持久化；重启从断点续传。 */
  get_updates_buf?: string
  /** 服务端建议的下次长轮询超时（ms）。 */
  longpolling_timeout_ms?: number
}

export interface SendMessageResp { ret?: number; errcode?: number; errmsg?: string }
export interface NotifyResp { ret?: number; errmsg?: string }
export interface GetUploadUrlResp { upload_param?: string; thumb_upload_param?: string; upload_full_url?: string }
export interface QRCodeResp { qrcode?: string; qrcode_img_content?: string }
export interface QRStatusResp {
  status?: 'wait' | 'scaned' | 'expired' | 'confirmed' | 'scaned_but_redirect' | 'need_verifycode' | 'verify_code_blocked' | 'binded_redirect' | string
  bot_token?: string
  ilink_bot_id?: string
  baseurl?: string
  ilink_user_id?: string
  redirect_host?: string
  errmsg?: string
}

export function baseInfo(): BaseInfo {
  return { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT }
}

function isWeixinHost(hostname: string): boolean {
  const normalized = String(hostname).toLowerCase().replace(/\.$/, '')
  return normalized === 'weixin.qq.com' || normalized.endsWith('.weixin.qq.com')
}

/** API 基址白名单：仅 https + weixin.qq.com 子域 + 默认 443 端口；去 userinfo/query/hash，保证尾斜杠。 */
export function normalizeBaseUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new IlinkError('invalid-base-url', 'invalid iLink base url: ' + value)
  }
  if (url.protocol !== 'https:' || !isWeixinHost(url.hostname) || (url.port !== '' && url.port !== '443')) {
    throw new IlinkError('untrusted-base-url', 'refusing to talk to a non-weixin host: ' + value)
  }
  url.username = ''
  url.password = ''
  url.search = ''
  url.hash = ''
  if (url.pathname !== '/' && !url.pathname.endsWith('/')) url.pathname += '/'
  return url.toString()
}

/** 扫码 URL 同样只允许微信官方域。 */
export function normalizeQrUrl(value: string): string {
  const text = value.trim()
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new IlinkError('invalid-qr', 'server returned an unreadable QR url')
  }
  if (url.protocol !== 'https:' || !isWeixinHost(url.hostname)) {
    throw new IlinkError('untrusted-qr', 'refusing a QR url outside weixin.qq.com')
  }
  return url.toString()
}

/** X-WECHAT-UIN：随机 uint32 的十进制字符串再 base64（官方同式）。 */
function randomWechatUin(): string {
  return Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64')
}

function commonHeaders(): Record<string, string> {
  return {
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
  }
}

function authenticatedHeaders(token: string): Record<string, string> {
  return {
    ...commonHeaders(),
    'content-type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    Authorization: 'Bearer ' + token.trim(),
    'X-WECHAT-UIN': randomWechatUin(),
  }
}

interface RequestOptions {
  baseUrl: string
  endpoint: string
  body?: unknown
  token?: string
  timeoutMs?: number
  signal?: AbortSignal
  authenticated?: boolean
}

async function requestJson(opts: RequestOptions): Promise<unknown> {
  const base = normalizeBaseUrl(opts.baseUrl)
  const url = new URL(opts.endpoint, base)
  if (!isWeixinHost(url.hostname)) throw new IlinkError('untrusted-endpoint', 'refusing a non-weixin endpoint: ' + url.hostname)
  const timeoutMs = opts.timeoutMs ?? DEFAULT_API_TIMEOUT_MS
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const signal = opts.signal ? AbortSignal.any([timeoutSignal, opts.signal]) : timeoutSignal
  const headers = opts.authenticated === false ? commonHeaders() : authenticatedHeaders(opts.token ?? '')
  let res: Response
  try {
    res = await fetch(url.toString(), {
      method: opts.body === undefined ? 'GET' : 'POST',
      headers,
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
      signal,
    })
  } catch (error) {
    if (opts.signal?.aborted) throw error
    if ((error as Error)?.name === 'TimeoutError' || (error as Error)?.name === 'AbortError') {
      throw new IlinkError('timeout', 'iLink request timed out: ' + opts.endpoint)
    }
    throw new IlinkError('network-error', 'iLink request failed: ' + String((error as Error)?.message ?? error))
  }
  const raw = await res.text().catch(() => '')
  if (!res.ok) throw new IlinkError('http-error', 'HTTP ' + res.status + ' from ' + opts.endpoint + ': ' + raw.slice(0, 200), res.status)
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new IlinkError('invalid-response', 'unparseable response from ' + opts.endpoint + ': ' + raw.slice(0, 120))
  }
}

/** 把响应里的 ret/errcode 归一成单一错误码：两者都缺视为 0（成功）。 */
export function responseErrcode(resp: { ret?: number; errcode?: number }): number {
  if (resp.errcode !== undefined && resp.errcode !== null) return resp.errcode
  if (resp.ret !== undefined && resp.ret !== null) return resp.ret
  return 0
}

export interface GetUpdatesOptions {
  baseUrl: string
  token: string
  getUpdatesBuf?: string
  timeoutMs?: number
  signal?: AbortSignal
}

/** 长轮询收消息。客户端超时/外部中止都返回空结果（不是错误），调用方自查 signal。 */
export async function getUpdates(opts: GetUpdatesOptions): Promise<GetUpdatesResp> {
  try {
    const resp = await requestJson({
      baseUrl: opts.baseUrl,
      endpoint: 'ilink/bot/getupdates',
      body: { get_updates_buf: opts.getUpdatesBuf ?? '', base_info: baseInfo() },
      token: opts.token,
      timeoutMs: opts.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS,
      signal: opts.signal,
    }) as GetUpdatesResp
    return resp
  } catch (error) {
    if (error instanceof IlinkError && error.code === 'timeout') {
      return { ret: 0, msgs: [], get_updates_buf: opts.getUpdatesBuf }
    }
    throw error
  }
}

export interface SendMessageOptions {
  baseUrl: string
  token: string
  msg: WeixinMessage
  signal?: AbortSignal
}

/** 发消息。resp ret/errcode 非 0 视为拒发并抛错（-14 归一为会话过期错误）。 */
export async function sendMessage(opts: SendMessageOptions): Promise<SendMessageResp> {
  const resp = await requestJson({
    baseUrl: opts.baseUrl,
    endpoint: 'ilink/bot/sendmessage',
    body: { msg: opts.msg, base_info: baseInfo() },
    token: opts.token,
    signal: opts.signal,
  }) as SendMessageResp
  const errcode = responseErrcode(resp)
  if (errcode !== 0) {
    if (errcode === SESSION_EXPIRED_ERRCODE) throw new IlinkSessionExpiredError('sendmessage rejected')
    throw new IlinkError('send-rejected', 'sendmessage rejected: errcode=' + errcode + ' ' + (resp.errmsg ?? ''))
  }
  return resp
}

export interface NotifyOptions { baseUrl: string; token: string; signal?: AbortSignal }

/** 上线通知（连接建立后调一次）。 */
export async function notifyStart(opts: NotifyOptions): Promise<NotifyResp> {
  const resp = await requestJson({
    baseUrl: opts.baseUrl,
    endpoint: 'ilink/bot/msg/notifystart',
    body: { base_info: baseInfo() },
    token: opts.token,
    timeoutMs: 10_000,
    signal: opts.signal,
  }) as NotifyResp
  const errcode = responseErrcode(resp)
  if (errcode !== 0) throw new IlinkError('notify-start-rejected', 'notifystart rejected: errcode=' + errcode + ' ' + (resp.errmsg ?? ''))
  return resp
}

/** 下线通知（dispose 时尽力而为，失败忽略）。 */
export async function notifyStop(opts: NotifyOptions): Promise<NotifyResp> {
  return await requestJson({
    baseUrl: opts.baseUrl,
    endpoint: 'ilink/bot/msg/notifystop',
    body: { base_info: baseInfo() },
    token: opts.token,
    timeoutMs: 10_000,
    signal: opts.signal,
  }) as NotifyResp
}

export interface GetBotQrcodeOptions {
  baseUrl?: string
  botType?: string
  localTokens?: string[]
  signal?: AbortSignal
}

export interface BotQrcode { qrcode: string; qrcodeUrl: string }

/** 获取登录二维码（无鉴权）。qrcode_img_content 是扫码 URL，白名单校验后返回。 */
export async function getBotQrcode(opts: GetBotQrcodeOptions = {}): Promise<BotQrcode> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL
  const tokens = [...new Set((opts.localTokens ?? []).map((t) => t.trim()).filter(Boolean))].slice(-10)
  const resp = await requestJson({
    baseUrl,
    endpoint: 'ilink/bot/get_bot_qrcode?bot_type=' + encodeURIComponent(opts.botType ?? DEFAULT_BOT_TYPE),
    body: { local_token_list: tokens },
    timeoutMs: 10_000,
    signal: opts.signal,
    authenticated: false,
  }) as QRCodeResp
  const qrcode = (resp.qrcode ?? '').trim()
  if (!qrcode) throw new IlinkError('invalid-qr', 'server returned no qrcode token')
  return { qrcode, qrcodeUrl: normalizeQrUrl(resp.qrcode_img_content ?? '') }
}

export interface QrcodeStatusOptions {
  baseUrl?: string
  qrcode: string
  verifyCode?: string
  timeoutMs?: number
  signal?: AbortSignal
}

/** 轮询扫码状态（服务端长轮询，默认 35s）。confirmed 时带全套凭据。 */
export async function getQrcodeStatus(opts: QrcodeStatusOptions): Promise<QRStatusResp> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL
  let endpoint = 'ilink/bot/get_qrcode_status?qrcode=' + encodeURIComponent(opts.qrcode)
  const verifyCode = (opts.verifyCode ?? '').trim()
  if (verifyCode) endpoint += '&verify_code=' + encodeURIComponent(verifyCode)
  return await requestJson({
    baseUrl,
    endpoint,
    timeoutMs: opts.timeoutMs ?? DEFAULT_QR_POLL_TIMEOUT_MS,
    signal: opts.signal,
    authenticated: false,
  }) as QRStatusResp
}

// ===== 媒体原语（M1 仅导出契约实现，插件消费在 M2 接线；与官方 cdn/upload、pic-decrypt 同式） =====

/** AES-128-ECB / PKCS7 密文大小。 */
export function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16
}

export function encryptBuffer(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}
export function decryptBuffer(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

/** CDNMedia.aes_key 双形态：base64(raw 16)（图片）或 base64(hex 16)（文件/语音/视频）。 */
export function parseAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, 'base64')
  if (decoded.length === 16) return decoded
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex')
  }
  throw new IlinkError('bad-aes-key', 'aes_key must decode to 16 raw bytes or a 32-char hex string, got ' + decoded.length + ' bytes')
}

export function buildCdnDownloadUrl(cdnBaseUrl: string, encryptedQueryParam: string): string {
  return cdnBaseUrl.replace(/\/+$/, '') + '/download?encrypted_query_param=' + encodeURIComponent(encryptedQueryParam)
}

export function buildCdnUploadUrl(cdnBaseUrl: string, uploadParam: string, filekey: string): string {
  return cdnBaseUrl.replace(/\/+$/, '') + '/upload?encrypted_query_param=' + encodeURIComponent(uploadParam) + '&filekey=' + encodeURIComponent(filekey)
}

export interface UploadToCdnOptions {
  cdnBaseUrl?: string
  uploadParam: string
  filekey: string
  data: Buffer
  aesKey: Buffer
  attempts?: number
  signal?: AbortSignal
}

/** 上传媒体：AES-ECB 加密后 POST octet-stream 到 CDN，响应头 x-encrypted-param 即下载参数。 */
export async function uploadToCdn(opts: UploadToCdnOptions): Promise<{ downloadParam: string }> {
  const cdnBaseUrl = opts.cdnBaseUrl ?? DEFAULT_CDN_BASE_URL
  const ciphertext = encryptBuffer(opts.data, opts.aesKey)
  const url = buildCdnUploadUrl(cdnBaseUrl, opts.uploadParam, opts.filekey)
  const maxAttempts = opts.attempts ?? 3
  let lastError = 'unknown'
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: new Uint8Array(ciphertext),
        signal: opts.signal ?? AbortSignal.timeout(60_000),
      })
      const errMessage = res.headers.get('x-error-message') ?? ''
      if (res.status >= 400 && res.status < 500) throw new IlinkError('cdn-client-error', 'CDN upload client error ' + res.status + ': ' + errMessage)
      if (res.status !== 200) throw new IlinkError('cdn-server-error', 'CDN upload server error: ' + (errMessage || ('status ' + res.status)))
      const downloadParam = res.headers.get('x-encrypted-param') ?? ''
      if (!downloadParam) throw new IlinkError('cdn-no-param', 'CDN upload response missing x-encrypted-param header')
      return { downloadParam }
    } catch (error) {
      lastError = String((error as Error)?.message ?? error)
      if (error instanceof IlinkError && error.code === 'cdn-client-error') throw error
    }
  }
  throw new IlinkError('cdn-upload-failed', 'CDN upload failed after ' + maxAttempts + ' attempts: ' + lastError)
}
