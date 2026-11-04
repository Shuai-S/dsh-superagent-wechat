# dsh-superagent-wechat

微信个人号 Source 插件（ClawBot / 腾讯 iLink 官方 Bot API）：手机微信私聊给机器人发消息即可给 superagent 引擎派活，回复直接回微信。

- 收消息：`ilink/bot/getupdates` HTTP 长轮询（免公网，无需回调 URL/隧道）
- 发消息：`ilink/bot/sendmessage`，携带入站消息下发的 `context_token`
- 引擎接线：`inject [orchestrator]` 注册 `wechat` SourceKind，走标准 准入→评估→Ticket→执行 链路
- 协议细节与来源：见 [docs/ilink-notes.md](docs/ilink-notes.md)（腾讯官方 openclaw-weixin 2.4.10 源码交叉核验）

## 安装（superagent profile）

```sh
pnpm install && pnpm check
dsh plugin --profile superagent add "link:$PWD"
scripts/dsh-superagent restart   # 在 dsh-superagent-prototype 内
```

## 开通前提（重要）

- **手机微信需已获得「微信机器人 / ClawBot」功能入口**（手机微信 → 我 → 设置 → 插件）。腾讯灰度分批开放；账号没有入口时扫码/连接会失败，插件无法绕过，只能等灰度或换有资格的微信号。
- 使用最新版手机微信扫码。机器人绑定在**个人微信号**上，不是公众号/企业微信。

## 扫码绑定（获取凭据）

```sh
node bin/wechat-qr.mjs     # 或 pnpm exec dsh-superagent-wechat-qr（链接过 lib 后）
```

1. 终端打印二维码 → 手机微信扫码 → 手机上确认（如出现配对数字，输入到终端）
2. CLI 输出一段账户 JSON（`botToken` / `ilinkBotId` / `baseUrl` / `ilinkUserId`）
3. 面板 → 来源 → 微信（ClawBot） → 账户 rows：填入 `id`（自定义短标识，如 `main`）与 `botToken`（其余字段照 CLI 输出填）
4. 保存后插件自动拉起该账号的长轮询（无需重启引擎；配置变更按 hash 重建客户端）

字段名对照（配置字段 ← 协议字段）：`botToken ← bot_token`、`ilinkBotId ← ilink_bot_id`、`baseUrl ← baseurl`、`ilinkUserId ← ilink_user_id`。

## 白名单

- Policy → 来源 → 微信 → 允许派活的微信用户：填 `from_user_id`（扫码只返回 bot 侧 id，**人的 id 要等第一条消息**）。
- 机器人收到某账号**首条消息**时，日志会打印发送者 id：`[wechat] msg in account=main from=wxid_xxx ...`，照抄进白名单即可。
- 白名单之外的消息由引擎按准入表过滤（面板可见），不会派活。

## 运行限制（务必了解）

- **不允许冷启动**：iLink 协议下机器人不能给「从未发过消息」的用户发消息（没有 `context_token`）。回复/通知都依赖该用户最近的入站消息；无缓存或超窗时出站显式抛错（面板可见），不会静默丢。
- **24 小时窗口**：服务端会丢弃用户超 24h 未互动后的 Bot 消息。插件默认按 **20h 安全窗**（`windowHours` 可调 1–23）拒发，等待用户下次发消息后由 Outbox 重试送达。
- **登录过期（errcode -14）**：bot_token 失效后该账号停止轮询，健康状态报「登录过期，请重新扫码绑定」；重新运行 `node bin/wechat-qr.mjs` 并把新 `botToken` 填进配置即恢复。
- **仅私聊**：带 `group_id` 的消息忽略；iLink 无群聊发送能力。
- **出站只发文本**：单条按 1800 字符切分（微信单条上限内取保守值）；防御限速 20 条/分钟（串行 + 3s 间隔 + 60s 窗口硬上限，超限抛错由 Outbox 退避重试）。
- **出站语音明确不做**：实测服务端对机器人语音 `ret=0` 接受但不投递（openclaw 生态同结论）。
- **媒体 M1 占位**：入站图片/文件/视频在文本中以 `[wechat-image]` / `[wechat-file]` / `[wechat-video]` 占位；CDN + AES-128-ECB 下载在 M2 接线（协议细节已备于 docs/ilink-notes.md）。
- 语音入站可用：服务端自带 ASR 转写（`voice_item.text`），直接作为文本进入引擎。

## 凭据安全

- `botToken` 等凭据**只保存进引擎本地配置**（sqlite，仅本机可读），不写入日志、不写入聊天、不进仓库。
- 插件日志只出现发送者 id 与消息摘要，不出现 token；`context_token` 缓存在内存，进程退出即消失。
- 长轮询游标（`get_updates_buf`）持久化在 `~/.local/state/dsh-superagent-wechat/cursors.json`（0600），重启断点续传。
- API 基址强制白名单：仅 `https://*.weixin.qq.com:443`，token 不会发往其他主机。

## 设计与契约来源

- 引擎 Source 契约：`dsh-superagent-prototype/docs/008-cookbook.md`
- 仓库形态与实现先例：`dsh-superagent-dingtalk`（watch/config-hash/Stream 直连）、`dsh-superagent-mail`（多账号 rows 先例）
- iLink 协议：腾讯官方 `@tencent-weixin/openclaw-weixin` 2.4.10（MIT）源码实读 + 多个独立 SDK 交叉验证，详见 [docs/ilink-notes.md](docs/ilink-notes.md)；因官方包导出面绑死 OpenClaw 插件 SDK，本仓库按官方源码自实现最小 HTTP 客户端（`src/ilink.ts`）。

## License

MIT
