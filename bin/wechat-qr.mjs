#!/usr/bin/env node
// 扫码绑定 CLI：打印二维码 -> 手机微信扫码确认 -> 输出账户凭据（粘贴进 Source 配置）。
//
// 前提：手机微信（最新版）已获得「微信机器人 / ClawBot」功能入口（我 -> 设置 -> 插件）。
// 腾讯灰度分批开放；账号无入口时扫码/连接会失败，任何插件都无法绕过。取消：Ctrl+C。
import { createRequire } from 'node:module'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { qrLogin } from '../lib/index.js'

const require = createRequire(import.meta.url)
let renderQr
try {
  const qrcodeTerminal = require('qrcode-terminal')
  renderQr = (url) => qrcodeTerminal.generate(url, { small: true }, (qr) => console.log(qr))
} catch {
  renderQr = (url) => console.log('用手机微信扫码打开：' + url)
}

const rl = createInterface({ input: stdin, output: stdout })
process.on('SIGINT', () => {
  console.log('\n已取消。')
  rl.close()
  process.exit(130)
})

try {
  const creds = await qrLogin({
    onQrUrl: (url) => {
      console.log('\n请用手机微信扫码：')
      renderQr(url)
    },
    onStatus: (state) => console.log('登录状态: ' + state),
    readVerifyCode: () => rl.question('请输入手机微信上显示的配对数字: '),
  })
  console.log('\n绑定成功：bot id = ' + creds.accountId)
  console.log('把下面这段填进 面板 -> 来源 -> 微信（ClawBot） -> 账户（可整段粘进 JSON 视图，或逐字段填写）：')
  console.log(JSON.stringify([
    { id: 'main', botToken: creds.botToken, ilinkBotId: creds.accountId, baseUrl: creds.baseUrl, ilinkUserId: creds.userId ?? '', name: '' },
  ], null, 2))
  console.log('\n注意：botToken 等凭据只保存进引擎配置；不要粘贴到日志、聊天或仓库。')
} catch (error) {
  console.error('绑定失败：' + String(error?.message ?? error))
  process.exit(1)
} finally {
  rl.close()
}
