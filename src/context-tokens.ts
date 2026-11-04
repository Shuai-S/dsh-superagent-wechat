/** context_token cache: the reply credential each inbound message carries.
 *  iLink forbids bot cold-start — without a recent inbound context_token the
 *  protocol cannot deliver anything to a user, and the server silently drops
 *  bot messages to users idle for more than 24h. We keep the newest token per
 *  (account, user) in memory and refuse sends outside a configurable safety
 *  window (default 20h, see README). Tokens are credentials: never logged. */

export interface ContextTokenEntry { token: string; at: number }

const store = new Map<string, Map<string, ContextTokenEntry>>()

export function rememberContextToken(accountId: string, userId: string | undefined, token: string | undefined): void {
  if (!accountId || !userId || !token || !token.trim()) return
  let perAccount = store.get(accountId)
  if (!perAccount) {
    perAccount = new Map()
    store.set(accountId, perAccount)
  }
  perAccount.set(userId, { token, at: Date.now() })
}

export type ContextTokenLookup =
  | { ok: true; token: string }
  | { ok: false; reason: 'missing' | 'expired'; detail: string }

export function readContextToken(accountId: string, userId: string, windowHours: number): ContextTokenLookup {
  const entry = store.get(accountId)?.get(userId)
  if (!entry) return { ok: false, reason: 'missing', detail: 'no inbound message from this user on this account yet' }
  const ageHours = (Date.now() - entry.at) / 3_600_000
  if (ageHours > windowHours) {
    return { ok: false, reason: 'expired', detail: 'last inbound ' + Math.round(ageHours) + 'h ago (window ' + windowHours + 'h)' }
  }
  return { ok: true, token: entry.token }
}

/** 账号删除/重建时清缓存，避免旧账号 id 捡到旧凭据。 */
export function clearContextTokens(accountId: string): void {
  store.delete(accountId)
}
