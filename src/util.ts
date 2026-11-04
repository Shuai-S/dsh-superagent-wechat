/** Shared paths and small helpers. */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** 插件本地状态根：游标、历史、暂存都挂在这下面（0600）。 */
export const STATE_DIR = join(homedir(), '.local', 'state', 'dsh-superagent-wechat')
/** 入站文件/视频落盘根（先例：dingtalk ~/.dsh/dingtalk-attachments）。 */
export const MEDIA_ROOT = join(homedir(), '.dsh', 'wechat-attachments')

/** 文件名/目录段净化：只留安全字符，防 userId/文件名注入路径。 */
export function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'unknown'
}
