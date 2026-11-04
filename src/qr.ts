/** QR login: get_bot_qrcode -> poll get_qrcode_status until confirmed.
 *  Statuses beyond the basic four (need_verifycode / scaned_but_redirect /
 *  binded_redirect / verify_code_blocked) are surfaced explicitly instead of
 *  being guessed away; see docs/ilink-notes.md for the wire contract. */
import { DEFAULT_BASE_URL, getBotQrcode, getQrcodeStatus, IlinkError } from './ilink.ts'

export interface QrLoginCallbacks {
  /** QR url ready for display (called again when the code refreshes). */
  onQrUrl: (url: string) => void
  /** Optional progress: waiting / scanned / refreshing / ... */
  onStatus?: (status: string) => void
  /** Server asked for a pairing code; prompt the human and resolve it. */
  readVerifyCode?: () => Promise<string>
}

export interface QrCredentials {
  /** bot_token —— 填进 Source 配置 accounts[].botToken */
  botToken: string
  /** ilink_bot_id —— accounts[].ilinkBotId */
  accountId: string
  /** baseurl —— accounts[].baseUrl（就近 IDC，优先于默认基址） */
  baseUrl: string
  /** ilink_user_id —— 扫码者个人 id */
  userId?: string
}

export interface QrLoginOptions {
  baseUrl?: string
  signal?: AbortSignal
}

const LOGIN_TIMEOUT_MS = 480_000
const MAX_QR_REFRESH = 3
const POLL_GAP_MS = 1_000

export async function qrLogin(callbacks: QrLoginCallbacks, opts: QrLoginOptions = {}): Promise<QrCredentials> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL
  const deadline = Date.now() + LOGIN_TIMEOUT_MS
  let refreshes = 0
  let qr = await getBotQrcode({ baseUrl, signal: opts.signal })
  callbacks.onQrUrl(qr.qrcodeUrl)
  callbacks.onStatus?.('waiting')
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new IlinkError('aborted', 'QR login aborted')
    const status = await getQrcodeStatus({ baseUrl, qrcode: qr.qrcode, signal: opts.signal })
    const state = status.status ?? 'wait'
    if (state === 'confirmed') {
      if (!status.bot_token || !status.ilink_bot_id) throw new IlinkError('login-incomplete', 'server returned no bot_token/ilink_bot_id on confirmed')
      return { botToken: status.bot_token, accountId: status.ilink_bot_id, baseUrl: status.baseurl || baseUrl, userId: status.ilink_user_id }
    }
    if (state === 'scaned') {
      callbacks.onStatus?.('scanned')
    } else if (state === 'expired') {
      refreshes += 1
      if (refreshes > MAX_QR_REFRESH) throw new IlinkError('qr-expired', 'QR code expired too many times')
      callbacks.onStatus?.('refreshing')
      qr = await getBotQrcode({ baseUrl, signal: opts.signal })
      callbacks.onQrUrl(qr.qrcodeUrl)
      callbacks.onStatus?.('waiting')
    } else if (state === 'need_verifycode') {
      if (!callbacks.readVerifyCode) throw new IlinkError('verify-code-required', 'server asked for a pairing code but no readVerifyCode callback was provided')
      const verifyCode = (await callbacks.readVerifyCode()).trim()
      const retry = await getQrcodeStatus({ baseUrl, qrcode: qr.qrcode, verifyCode, signal: opts.signal })
      if (retry.status === 'confirmed' && retry.bot_token && retry.ilink_bot_id) {
        return { botToken: retry.bot_token, accountId: retry.ilink_bot_id, baseUrl: retry.baseurl || baseUrl, userId: retry.ilink_user_id }
      }
      callbacks.onStatus?.('after-verify-code: ' + (retry.status ?? 'unknown'))
    } else if (state === 'verify_code_blocked') {
      throw new IlinkError('verify-code-blocked', 'pairing code blocked by the server; retry from a fresh QR')
    } else if (state === 'binded_redirect') {
      throw new IlinkError('binded-redirect', 'this account is already bound elsewhere (binded_redirect); unbind on the phone first')
    } else {
      // wait / scaned_but_redirect / unknown: keep polling on the fixed QR base.
      callbacks.onStatus?.(state)
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_GAP_MS))
  }
  throw new IlinkError('login-timeout', 'QR login timed out after 8 minutes')
}
