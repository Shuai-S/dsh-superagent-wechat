# dsh-superagent-wechat

微信个人号 Source 插件（ClawBot / 腾讯 iLink 官方 Bot API）：手机微信私聊给机器人发消息即可向 superagent 引擎派活，回复直接回微信。

- 收消息：`ilink/bot/getupdates` HTTP 长轮询（免公网，无需回调 URL/隧道）
- 发消息：`ilink/bot/sendmessage`，携带入站消息下发的 `context_token`
- 引擎接线：`inject [orchestrator]` 注册 `wechat` SourceKind，走标准 准入→评估→Ticket→执行 链路
- 协议细节与来源：见 [docs/ilink-notes.md](docs/ilink-notes.md)（基于腾讯官方 openclaw-weixin 2.4.10 源码交叉核验）

## 安装

```sh
# 从 npm 安装
dsh plugin --profile superagent add dsh-superagent-wechat

# 或从本地源码安装（开发场景）
dsh plugin --profile superagent add "link:$PWD"
```

安装后重启引擎生效。

## 开通前提

- **手机微信需已获得「微信机器人 / ClawBot」功能入口**（手机微信 → 我 → 设置 → 插件）。该功能由腾讯灰度分批开放；账号没有入口时扫码/连接会失败，插件无法绕过，只能等待灰度或更换有资格的微信号。
- 使用最新版手机微信扫码。机器人绑定在**个人微信号**上，不是公众号/企业微信。

## 扫码绑定（获取凭据）

两条路径任选其一，输出格式完全相同（一段账户 JSON，粘贴进面板即可）。

### A. 面板绑定页（推荐，无需终端）

引擎运行时插件自动在本机起一个只监听 `127.0.0.1` 的绑定页（默认 <http://127.0.0.1:26678>，可在来源设置 `bindPort` 改端口 / `bindPageEnabled` 关闭）：

1. 浏览器打开 <http://127.0.0.1:26678> → 自动生成二维码
2. 手机微信扫码 → 手机上确认（如出现配对数字，在页面输入并提交）
3. 页面展示与 CLI 同格式的账户 JSON → 点「一键复制」
4. 粘贴到 面板 → 来源 → 微信（ClawBot） → 账户（可整段粘进 JSON 视图，或逐字段填写），保存后自动拉起长轮询

### B. 终端 CLI（备选）

```sh
node bin/wechat-qr.mjs     # 或 pnpm exec dsh-superagent-wechat-qr（链接过 lib 后）
```

1. 终端打印二维码 → 手机微信扫码 → 手机上确认（如出现配对数字，输入到终端）
2. CLI 输出一段账户 JSON（`botToken` / `ilinkBotId` / `baseUrl` / `ilinkUserId`）
3. 面板 → 来源 → 微信（ClawBot） → 账户 rows：填入 `id`（自定义短标识，如 `main`）与 `botToken`（其余字段照输出填）
4. 保存后插件自动拉起该账号的长轮询（无需重启引擎；配置变更按 hash 重建客户端）

字段名对照（配置字段 ← 协议字段）：`botToken ← bot_token`、`ilinkBotId ← ilink_bot_id`、`baseUrl ← baseurl`、`ilinkUserId ← ilink_user_id`。

**登录过期（errcode -14）**：出现「登录过期，请重新扫码绑定」后，同样走 A 或 B 任一路径重扫，把新 `botToken` 填进原账户行即可恢复。

### 绑定页安全说明

- **仅本机回环**：只监听 `127.0.0.1`（显式 host，绝不 `0.0.0.0`），局域网内其他设备不可达。
- **Host 校验**：页面路由校验 Host 头必须是 `127.0.0.1:<port>` 或 `localhost:<port>`（防 DNS rebinding）。
- **token 闸门**：`/qr/*` 接口全部要求页面内嵌的一次性随机 token（自定义头 `x-bind-token`，服务器生命周期内一发）；浏览器内跨站请求无法携带自定义头，天然防 CSRF。
- **凭据一次性交付**：扫码得到的凭据只在内存中保留到第一次查询即销毁（至多交付一次），会话 10 分钟硬过期，过期未领取的凭据直接丢弃；全程不落日志。

## 白名单

- Policy → 来源 → 微信 → 允许派活的微信用户：填 `from_user_id`（扫码只返回 bot 侧 id，**人的 id 要等第一条消息**）。
- 机器人收到某账号**首条消息**时，日志会打印发送者 id：`[wechat] msg in account=main from=wxid_xxx ...`，照抄进白名单即可。
- 白名单之外的消息由引擎按准入表过滤（面板可见），不会派活。

## 运行限制

- **不允许冷启动**：iLink 协议下机器人不能给「从未发过消息」的用户发消息（没有 `context_token`）。回复/通知都依赖该用户最近的入站消息；无缓存或超窗时出站显式抛错（面板可见），不会静默丢弃。
- **24 小时窗口**：服务端会丢弃用户超 24h 未互动后的 Bot 消息。插件默认按 **20h 安全窗**（`windowHours` 可调 1–23）拒发，等待用户下次发消息后由 Outbox 重试送达。
- **登录过期（errcode -14）**：bot_token 失效后该账号停止轮询，健康状态报「登录过期，请重新扫码绑定」；走绑定页（<http://127.0.0.1:26678>）或终端 CLI 任一路径重扫，并将新 `botToken` 填进配置即恢复。
- **仅私聊**：带 `group_id` 的消息忽略；iLink 无群聊发送能力。
- **出站只发文本**：单条按 1800 字符切分（微信单条上限内取保守值）；防御限速 20 条/分钟（串行 + 3s 间隔 + 60s 窗口硬上限，超限抛错由 Outbox 退避重试）。
- **出站语音不支持**：服务端对机器人语音返回 `ret=0` 但不投递。
- **入站媒体**：图片在消息里以 `[wechat-image:KEY]` 标记，评估/会话按需经 CDN + AES-128-ECB 下载解密后注入会话（魔数判定格式，解密失败显式报错不猜测）；文件/视频在收到时自动落盘 `~/.dsh/wechat-attachments/<账号>/<消息id>/`（分段下载 + 100MiB 上限 + 断点续传），路径注入消息文本供 read/bash/ffmpeg 消化；语音由服务端 ASR 直接转写为文本进入引擎。
- **本地会话历史**：每 (账号, 用户) 一份 JSONL（`~/.local/state/dsh-superagent-wechat/history/`，0600，滚动保留 500 条），只存 id/from/at/text/bot，无任何凭据；评估的多轮上下文即来自它（iLink 无历史消息 API）。
- **超窗暂存补发（默认关）**：开启后被 20h 安全窗拒绝的出站文本暂存本地（每用户最多 3 条，FIFO 丢最旧），该用户下次发消息、新 context_token 就位后逐条补发（幂等 client_id，失败保留下次再试）。这是入站触发的额外尽力投递，**不替代**引擎 Outbox 的重试——Outbox 会持续重试，补发只是让文本在窗口恢复后仍能到达。

## 凭据安全

- `botToken` 等凭据**只保存进引擎本地配置**（SQLite，仅本机可读），不写入日志、不写入聊天、不进仓库。
- 插件日志只出现发送者 id 与消息摘要，不出现 token；`context_token` 缓存在内存，进程退出即消失。
- 长轮询游标（`get_updates_buf`）持久化在 `~/.local/state/dsh-superagent-wechat/cursors.json`（0600），重启断点续传。
- API 基址强制白名单：仅 `https://*.weixin.qq.com:443`，token 不会发往其他主机。

## License

MIT
