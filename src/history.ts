/** Local conversation history: one JSONL file per (account, user) — the only
 *  history source, because iLink has no message-history API. Inbound messages
 *  are appended on receipt, outbound ones after channel.send succeeds.
 *  Entries carry {id, from, at, text, bot} only: no tokens, no credentials.
 *  Reads page backwards through the file with a byte-offset cursor; corrupt
 *  lines are skipped with a log, never fatal. */
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { sanitizeSegment } from './util.ts'

/** 单会话滚动上限：append 超限重写保留最新 500 条，防文件无限膨胀。 */
export const HISTORY_LIMIT = 500

export interface HistoryEntry { id: string; from: string; at: string; text: string; bot: boolean }
export interface HistoryMessage { id: string; from: string; at: string; text: string; bot?: true }

function stateBase(baseDir?: string): string {
  return baseDir ?? join(homedir(), '.local', 'state', 'dsh-superagent-wechat')
}

export function historyFile(accountId: string, userId: string, baseDir?: string): string {
  return join(stateBase(baseDir), 'history', sanitizeSegment(accountId), sanitizeSegment(userId) + '.jsonl')
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirnameSafe(path), { recursive: true })
  const tmp = path + '.tmp'
  await writeFile(tmp, content, { mode: 0o600 })
  await rename(tmp, path)
}

function dirnameSafe(p: string): string {
  const idx = p.lastIndexOf('/')
  return idx > 0 ? p.slice(0, idx) : '.'
}

/** 追加一条（0600 原子写，超 HISTORY_LIMIT 滚动丢弃最旧）。 */
export async function appendHistory(accountId: string, userId: string, entry: HistoryEntry, baseDir?: string): Promise<void> {
  const path = historyFile(accountId, userId, baseDir)
  let lines: string[] = []
  try {
    lines = (await readFile(path, 'utf8')).split('\n').filter((l) => l.trim())
  } catch { /* 首条 */ }
  lines.push(JSON.stringify(entry))
  if (lines.length > HISTORY_LIMIT) lines = lines.slice(lines.length - HISTORY_LIMIT)
  await writeAtomic(path, lines.join('\n') + '\n')
}

export interface HistoryPage { messages: HistoryMessage[]; next?: string }

interface Row { entry: HistoryMessage; start: number }

/** 按页向更早读：cursor = 文件字节 offset（该 offset 之前的最后 pageSize 条为下一窗口）。
 *  首次（无 cursor）取文件最后 pageSize 条；next 为窗口首条的 offset，到文件头则省略。
 *  空文件/损坏行防御式跳过并 log，不抛错。 */
export async function readHistoryPage(accountId: string, userId: string, cursor?: string, opts: { pageSize?: number; baseDir?: string } = {}): Promise<HistoryPage> {
  const path = historyFile(accountId, userId, opts.baseDir)
  let raw = ''
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return { messages: [] } // 空会话不是错误
  }
  const pageSize = opts.pageSize ?? 30
  const lines = raw.split('\n')
  const rows: Row[] = []
  let offset = 0
  let warned = false
  for (const line of lines) {
    const start = offset
    offset += Buffer.byteLength(line, 'utf8') + 1
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as Partial<HistoryEntry>
      if (typeof parsed.id !== 'string' || typeof parsed.text !== 'string') throw new Error('bad shape')
      rows.push({
        entry: { id: parsed.id, from: String(parsed.from ?? ''), at: String(parsed.at ?? ''), text: parsed.text, ...(parsed.bot === true ? { bot: true as const } : {}) },
        start,
      })
    } catch {
      if (!warned) {
        warned = true
        console.error('[wechat] history: skipping corrupt line(s) in ' + path)
      }
    }
  }
  const cursorOffset = cursor !== undefined && cursor !== '' && Number.isFinite(Number(cursor)) ? Number(cursor) : Number.MAX_SAFE_INTEGER
  const usable = rows.filter((r) => r.start < cursorOffset)
  const window = usable.slice(Math.max(0, usable.length - pageSize))
  const messages = window.map((r) => r.entry)
  const firstStart = window.length > 0 ? window[0].start : Number.MAX_SAFE_INTEGER
  const next = window.length > 0 && firstStart > 0 && rows.some((r) => r.start < firstStart) ? String(firstStart) : undefined
  return { messages, ...(next !== undefined ? { next } : {}) }
}
