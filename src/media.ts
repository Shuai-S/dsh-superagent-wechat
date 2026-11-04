/** Inbound media: an in-memory index from stable keys to CDN references, the
 *  image download+decrypt primitive, and the segmented file/video downloader.
 *
 *  Key derivation (docs/ilink-notes.md): KEY = "<message_id>:<item_index>" —
 *  derived from the original message only, so trigger text can embed
 *  "[wechat-image:<KEY>]" markers and image() can re-fetch the exact item.
 *  The index lives in memory: after a restart the keys expire and image()
 *  reports that explicitly instead of guessing. */
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULT_CDN_BASE_URL, buildCdnDownloadUrl, decryptBuffer, parseAesKey, IlinkError } from './ilink.ts'
import { MEDIA_ROOT, sanitizeSegment } from './util.ts'

export type MediaKind = 'image' | 'file' | 'video'

export interface MediaRef {
  key: string
  kind: MediaKind
  accountId: string
  encryptQueryParam: string
  /** media.aes_key（base64，图片=raw16 / 其他=hex16 双形态） */
  aesKeyBase64: string
  /** image_item.aeskey（hex 16，入站图片优先用它） */
  aesKeyHex?: string
  fullUrl?: string
  fileName?: string
}

const MAX_INDEX = 200
const index = new Map<string, MediaRef>()

function indexKey(accountId: string, key: string): string {
  return accountId + '|' + key
}

export function rememberMedia(ref: MediaRef): void {
  index.set(indexKey(ref.accountId, ref.key), ref)
  if (index.size > MAX_INDEX) {
    const oldest = index.keys().next().value
    if (oldest !== undefined) index.delete(oldest)
  }
}

export function readMedia(accountId: string, key: string): MediaRef | undefined {
  return index.get(indexKey(accountId, key))
}

export function forgetMedia(accountId: string): void {
  for (const k of [...index.keys()]) {
    if (k.startsWith(accountId + '|')) index.delete(k)
  }
}

interface RawCdnMedia { encrypt_query_param?: string; aes_key?: string; full_url?: string }

/** 从 item_list 派生媒体引用并登记索引；返回 itemIndex -> ref。无 CDN 引用的项不派生。 */
export function deriveMediaRefs(accountId: string, messageId: string, items: { type?: number; image_item?: { media?: RawCdnMedia; aeskey?: string }; file_item?: { media?: RawCdnMedia; file_name?: string }; video_item?: { media?: RawCdnMedia } }[] | undefined): Map<number, MediaRef> {
  const out = new Map<number, MediaRef>()
  const list = items ?? []
  for (const [idx, item] of list.entries()) {
    const type = item.type ?? 0
    const kind: MediaKind | undefined = type === 2 ? 'image' : type === 4 ? 'file' : type === 5 ? 'video' : undefined
    if (!kind) continue
    const media = item.image_item?.media ?? item.file_item?.media ?? item.video_item?.media
    const encryptQueryParam = (media?.encrypt_query_param ?? '').trim()
    const fullUrl = (media?.full_url ?? '').trim()
    if (!encryptQueryParam && !fullUrl) continue // 无下载途径：buildTrigger 退化为无 key 占位
    const ref: MediaRef = {
      key: messageId + ':' + idx,
      kind,
      accountId,
      encryptQueryParam,
      aesKeyBase64: (media?.aes_key ?? '').trim(),
      ...(kind === 'image' && item.image_item?.aeskey ? { aesKeyHex: item.image_item.aeskey.trim() } : {}),
      ...(fullUrl ? { fullUrl } : {}),
      ...(kind === 'file' && item.file_item?.file_name ? { fileName: item.file_item.file_name } : {}),
    }
    rememberMedia(ref)
    out.set(idx, ref)
  }
  return out
}

/** 出站/入站一致的媒体 AES key 解析：hex 优先（image_item.aeskey），否则 base64 双形态。 */
export function resolveMediaAesKey(ref: MediaRef): Buffer {
  if (ref.aesKeyHex) return Buffer.from(ref.aesKeyHex, 'hex')
  return parseAesKey(ref.aesKeyBase64)
}

const IMAGE_MAGIC: { type: string; ext: string; test: (b: Buffer) => boolean }[] = [
  { type: 'image/png', ext: 'png', test: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { type: 'image/jpeg', ext: 'jpg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'image/gif', ext: 'gif', test: (b) => b.length > 6 && b.toString('ascii', 0, 3) === 'GIF' },
  { type: 'image/webp', ext: 'webp', test: (b) => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
]

/** 图片格式魔数判定（CDN 下发的是加密流，content-type 不可信）。 */
export function sniffImageType(data: Buffer): { mediaType: string; ext: string } | undefined {
  const hit = IMAGE_MAGIC.find((m) => m.test(data))
  return hit ? { mediaType: hit.type, ext: hit.ext } : undefined
}

/** 下载 CDN 密文并 AES-128-ECB 解密；任何一步失败都显式报错，不静默吞。 */
export async function downloadMediaBuffer(accountId: string, key: string, signal?: AbortSignal): Promise<{ data: Buffer; ref: MediaRef }> {
  const ref = readMedia(accountId, key)
  if (!ref) throw new IlinkError('media-gone', 'media index has no entry for ' + key + '（进程重启后索引失效）：请让对方重发这张图')
  const url = ref.fullUrl || buildCdnDownloadUrl(DEFAULT_CDN_BASE_URL, ref.encryptQueryParam)
  const res = await fetch(url, { signal: signal ?? AbortSignal.timeout(60_000) })
  if (!res.ok) throw new IlinkError('cdn-http', 'CDN download failed: HTTP ' + res.status + ' for ' + key)
  const ciphertext = Buffer.from(await res.arrayBuffer())
  if (ciphertext.length === 0) throw new IlinkError('cdn-empty', 'CDN download returned 0 bytes for ' + key)
  let plain: Buffer
  try {
    plain = decryptBuffer(ciphertext, resolveMediaAesKey(ref))
  } catch (error) {
    throw new IlinkError('media-decrypt', 'AES-128-ECB decrypt failed for ' + key + '（aes_key 形态与数据不匹配或密文损坏）: ' + String((error as Error)?.message ?? error))
  }
  return { data: plain, ref }
}

export interface DownloadedNote { kind: 'file' | 'video'; name?: string; path?: string; error?: string }

export interface MediaToFileOptions {
  maxBytes?: number
  budgetMs?: number
  segmentBytes?: number
  attempts?: number
  signal?: AbortSignal
}

/** file/video 落盘：Range 分段下载密文到 .part（断点续传），完成后整体解密写最终文件。
 *  上限默认 100MiB（iLink 公开媒体上限）；失败保留 .part 供同 key 重试续传。 */
export async function downloadIlinkMediaToFile(accountId: string, ref: MediaRef, opts: MediaToFileOptions = {}): Promise<{ bytes: number; path: string; name: string }> {
  const maxBytes = opts.maxBytes ?? 100 * 1024 * 1024
  const deadline = Date.now() + (opts.budgetMs ?? 15 * 60_000)
  const segment = opts.segmentBytes ?? 8 * 1024 * 1024
  const maxAttempts = opts.attempts ?? 4
  const signal = opts.signal
  const url = ref.fullUrl || buildCdnDownloadUrl(DEFAULT_CDN_BASE_URL, ref.encryptQueryParam)
  const messageId = sanitizeSegment(ref.key.split(':')[0] ?? 'msg')
  const baseName = sanitizeSegment(ref.fileName?.replace(/\.[^.\\/]*$/, '') || (ref.kind === 'video' ? 'video' : 'file'))
  const ext = ref.kind === 'video'
    ? (/\.[a-z0-9]{1,5}$/i.exec(ref.fileName ?? '')?.[0] ?? '.mp4')
    : (/\.[a-z0-9]{1,6}$/i.exec(ref.fileName ?? '')?.[0] ?? '')
  const dir = join(MEDIA_ROOT, accountId, messageId)
  const finalPath = join(dir, baseName + ext)
  const partPath = finalPath + '.part.enc'
  await mkdir(dir, { recursive: true })
  let cipherOffset = 0
  try { cipherOffset = (await stat(partPath)).size } catch { /* first run */ }
  if (cipherOffset > maxBytes) {
    await unlink(partPath).catch(() => {})
    throw new IlinkError('media-too-large', 'media exceeds the ' + maxBytes + ' byte limit: ' + ref.key)
  }
  let attempt = 0
  let lastError = 'unknown'
  while (Date.now() <= deadline) {
    try {
      for (;;) {
        if (signal?.aborted) throw new IlinkError('aborted', 'media download aborted')
        if (cipherOffset > maxBytes) {
          await unlink(partPath).catch(() => {})
          throw new IlinkError('media-too-large', 'media exceeds the ' + maxBytes + ' byte limit: ' + ref.key)
        }
        const res = await fetch(url, {
          headers: { Range: 'bytes=' + cipherOffset + '-' + (cipherOffset + segment - 1) },
          signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]),
        })
        if (res.status === 206) {
          const buf = Buffer.from(await res.arrayBuffer())
          if (buf.length === 0) throw new IlinkError('cdn-empty', 'empty range response for ' + ref.key)
          const handle = await open(partPath, 'a')
          try { await handle.write(buf) } finally { await handle.close() }
          cipherOffset += buf.length
          const total = Number(/\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1] ?? -1)
          if (total >= 0 && cipherOffset >= total) break
          if (total < 0 && buf.length < segment) break
          continue
        }
        if (res.status === 200) {
          // CDN 不支持 Range：全量流式写密文（已有 .part 进度作废重来）。
          if (cipherOffset > 0) { cipherOffset = 0; await unlink(partPath).catch(() => {}) }
          const handle = await open(partPath, 'w')
          try {
            for await (const chunk of res.body ?? []) {
              const buf = Buffer.from(chunk as Uint8Array)
              await handle.write(buf)
              cipherOffset += buf.length
              if (cipherOffset > maxBytes) throw new IlinkError('media-too-large', 'media exceeds the ' + maxBytes + ' byte limit: ' + ref.key)
            }
          } finally { await handle.close() }
          break
        }
        throw new IlinkError('cdn-http', 'CDN download HTTP ' + res.status + ' for ' + ref.key)
      }
      // 解密落盘（显式报错，不静默吞）。
      const ciphertext = await readFile(partPath)
      let plain: Buffer
      try {
        plain = decryptBuffer(ciphertext, resolveMediaAesKey(ref))
      } catch (error) {
        throw new IlinkError('media-decrypt', 'AES-128-ECB decrypt failed for ' + ref.key + '（aes_key 形态不匹配或密文损坏）: ' + String((error as Error)?.message ?? error))
      }
      await writeFile(finalPath, plain, { mode: 0o600 })
      await unlink(partPath).catch(() => {})
      return { bytes: plain.length, path: finalPath, name: baseName + ext }
    } catch (error) {
      lastError = String((error as Error)?.message ?? error)
      if (lastError.includes('byte limit') || lastError.includes('decrypt failed')) throw error
      attempt += 1
      if (attempt >= maxAttempts || Date.now() > deadline || signal?.aborted) break
      await new Promise((resolve) => setTimeout(resolve, Math.min(500 * 2 ** (attempt - 1), 8_000)))
    }
  }
  throw new IlinkError('media-download-failed', 'media download failed after ' + attempt + ' attempts at ' + cipherOffset + ' bytes: ' + lastError)
}
