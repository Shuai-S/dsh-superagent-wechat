/** Pending outbound store for the 24h-window resend path (C6): when a send is
 *  refused because the user's last inbound is older than the safety window,
 *  the text is parked here (FIFO, max 3 per user) and flushed on the user's
 *  next inbound message. Entries carry {messageId, text, at} only — the
 *  context_token is taken fresh at resend time, never stored. */
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { sanitizeSegment } from './util.ts'

export const PENDING_MAX = 3

export interface PendingEntry { messageId: string; text: string; at: string }

function stateBase(baseDir?: string): string {
  return baseDir ?? join(homedir(), '.local', 'state', 'dsh-superagent-wechat')
}

export function pendingFile(accountId: string, userId: string, baseDir?: string): string {
  return join(stateBase(baseDir), 'pending', sanitizeSegment(accountId), sanitizeSegment(userId) + '.json')
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const idx = path.lastIndexOf('/')
  await mkdir(idx > 0 ? path.slice(0, idx) : '.', { recursive: true })
  const tmp = path + '.tmp'
  await writeFile(tmp, content, { mode: 0o600 })
  await rename(tmp, path)
}

async function readAll(accountId: string, userId: string, baseDir?: string): Promise<PendingEntry[]> {
  try {
    const parsed = JSON.parse(await readFile(pendingFile(accountId, userId, baseDir), 'utf8')) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((e): e is PendingEntry =>
      !!e && typeof e === 'object' && typeof (e as PendingEntry).messageId === 'string' && typeof (e as PendingEntry).text === 'string')
  } catch {
    return [] // 无文件或损坏：按空处理
  }
}

async function writeAll(accountId: string, userId: string, entries: PendingEntry[], baseDir?: string): Promise<void> {
  const path = pendingFile(accountId, userId, baseDir)
  if (entries.length === 0) {
    await unlink(path).catch(() => {})
    return
  }
  await writeAtomic(path, JSON.stringify(entries))
}

/** 入队（FIFO 上限 PENDING_MAX，超限丢最旧并 log）；返回入队后的长度。 */
export async function enqueuePending(accountId: string, userId: string, entry: PendingEntry, baseDir?: string): Promise<number> {
  const entries = await readAll(accountId, userId, baseDir)
  entries.push(entry)
  while (entries.length > PENDING_MAX) {
    const dropped = entries.shift()
    console.error('[wechat] pending overflow: dropped oldest for ' + userId + ' (messageId=' + (dropped?.messageId ?? '?') + ')')
  }
  await writeAll(accountId, userId, entries, baseDir)
  return entries.length
}

export async function readPending(accountId: string, userId: string, baseDir?: string): Promise<PendingEntry[]> {
  return await readAll(accountId, userId, baseDir)
}

/** 按条移除（补发逐条成功后调用；数组空则删文件）。 */
export async function dropPending(accountId: string, userId: string, messageId: string, baseDir?: string): Promise<void> {
  const entries = await readAll(accountId, userId, baseDir)
  await writeAll(accountId, userId, entries.filter((e) => e.messageId !== messageId), baseDir)
}

/** 全清（整批补发成功后调用）。 */
export async function clearPending(accountId: string, userId: string, baseDir?: string): Promise<void> {
  await unlink(pendingFile(accountId, userId, baseDir)).catch(() => {})
}
