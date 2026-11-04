# iLink（微信 ClawBot）协议调研笔记

- 调研日期：2026-11-04
- 调研人：dsh-superagent-wechat 实施工程师（wechat-impl）
- 方法：本机直连 github.com / raw.githubusercontent.com / jsdelivr / jina 全部不通（lead 已实测）。
  走 **npm registry**（registry.npmjs.org 可达）下载 tarball 实读源码与 README；npm 包内即含
  协议实现与类型定义，无猜测成分。关键事实均经 **腾讯官方包 @tencent-weixin/openclaw-weixin@2.4.10**
  （MIT，含完整 TS 源码）与至少两个独立第三方 SDK 交叉验证。

## 结论速览（对应最小事实集）

| # | 问题 | 结论 |
|---|------|------|
| ① | 开通与凭证 | 手机微信（最新版）需已获得「微信机器人 / ClawBot」入口（我 → 设置 → 插件；腾讯灰度分批开放，无入口则扫码/连接失败，插件无法绕过）。扫码绑定后得到凭证四元组：`bot_token`（鉴权令牌）、`ilink_bot_id`（机器人账号 id）、`baseurl`（后续 API 基址，可能是就近 IDC）、`ilink_user_id`（扫码者个人 id） |
| ② | 收消息形态 | **HTTP 长轮询** `POST ilink/bot/getupdates`（默认 35s 客户端超时；响应可带 `longpolling_timeout_ms` 建议下次超时）。游标 `get_updates_buf` 由客户端持有并回传，需持久化。无 WS、无回调、**免公网** |
| ③ | 发消息 | `POST ilink/bot/sendmessage`，body `{ msg: WeixinMessage, base_info }`。**必须携带入站消息下发的 `context_token`**；协议不允许 Bot 冷启动（用户从未发过消息就没有 context_token，发不了第一条）；服务端对用户 24h 未互动后的 Bot 消息静默丢弃 |
| ④ | 载荷字段 | 见下文「消息模型」。消息幂等键用 `message_id`（number，缺省回落 `client_id`）；发送者 id 是 `from_user_id`（string）；文本在 `item_list[].text_item.text`；图片在 `item_list[].image_item.media`（CDN 引用 + AES key） |
| ⑤ | 媒体 | CDN 中转 + AES-128-ECB。下载：`GET {cdn}/download?encrypted_query_param=...` → AES-ECB 解密。上传：`getuploadurl` 拿 `upload_param` → `POST {cdn}/upload?encrypted_query_param=...&filekey=...`（octet-stream 密文）→ 响应头 `x-encrypted-param` 即下载参数 → 随 sendmessage 下发 |
| ⑥ | 已知限制 | `errcode -14` = 登录会话过期（停轮询、重扫码）；仅私聊（`group_id` 非空即忽略，无群聊发送能力）；无好友目录/撤回/历史查询 API；出站语音实测服务端 ret=0 但不投递；社区防御值：出站 10 条/分钟滑动窗口 + 串行队列 + 3 次递增重试；单文件上限 100 MiB（图片/音频建议 ≤20 MiB）；长文本 1800~4000 字/条切分；账号风控与可用性由微信侧决定，不能保证永不封号 |

## 端点速查（base = https://ilinkai.weixin.qq.com）

| 方法 | 路径 | 鉴权 | 用途 |
|------|------|------|------|
| POST | `ilink/bot/get_bot_qrcode?bot_type=3` | 无 | 获取登录二维码。body `{ local_token_list?: string[] }`（本机已有 token 最多 10 个，可空）。resp `{ qrcode, qrcode_img_content }`（img_content 为扫码 URL，需白名单校验为 https://*.weixin.qq.com） |
| GET | `ilink/bot/get_qrcode_status?qrcode=...` | 无（带 `iLink-App-ClientVersion` 头） | 长轮询扫码状态（35s）。status ∈ wait / scaned / expired / confirmed / scaned_but_redirect（带 `redirect_host`，改轮询基址）/ need_verifycode（带 verify_code 重轮询）/ verify_code_blocked / binded_redirect。confirmed 时返回 `bot_token, ilink_bot_id, baseurl, ilink_user_id` |
| POST | `ilink/bot/getupdates` | Bearer | 长轮询收消息。body `{ get_updates_buf, base_info }`；resp `{ ret, errcode, errmsg, msgs[], get_updates_buf, longpolling_timeout_ms }`。客户端超时视为正常空轮询 |
| POST | `ilink/bot/sendmessage` | Bearer | 发消息。body `{ msg, base_info }`；resp `{ ret, errmsg }`，`ret!==0` 视为拒发 |
| POST | `ilink/bot/getconfig` | Bearer | body `{ ilink_user_id, context_token, base_info }`；resp 含 `typing_ticket` |
| POST | `ilink/bot/sendtyping` | Bearer | 输入状态。body `{ ilink_user_id, typing_ticket, status }`（1=typing 2=cancel） |
| POST | `ilink/bot/getuploadurl` | Bearer | 媒体预上传。body `{ filekey, media_type, to_user_id, rawsize, rawfilemd5, filesize, thumb_rawsize?, thumb_rawfilemd5?, thumb_filesize?, no_need_thumb, aeskey, base_info }`；resp `{ upload_param, thumb_upload_param?, upload_full_url? }` |
| POST | `ilink/bot/msg/notifystart` | Bearer | 上线通知（连接建立后调一次）。body `{ base_info }` |
| POST | `ilink/bot/msg/notifystop` | Bearer | 下线通知（dispose 时尽力而为） |

CDN 基址：`https://novac2c.cdn.weixin.qq.com/c2c`
- 下载：`{cdn}/download?encrypted_query_param={media.encrypt_query_param}`
- 上传：`{cdn}/upload?encrypted_query_param={upload_param}&filekey={filekey}`，Content-Type: application/octet-stream，body 为 AES-ECB 密文；成功响应头 `x-encrypted-param` = 下载参数

## 请求头（所有需鉴权的 POST）

```
Content-Type: application/json
Authorization: Bearer {bot_token}
AuthorizationType: ilink_bot_token
iLink-App-Id: bot                       // 官方包 package.json 顶层 ilink_appid 字段值
iLink-App-ClientVersion: {uint32}       // major<<16 | minor<<8 | patch；官方 2.4.10 = (2<<16)|(4<<8)|10
X-WECHAT-UIN: {base64}                  // 随机 uint32 的十进制字符串再 base64
Content-Length: ...
```

body 通用附加：`base_info: { channel_version, bot_agent }`。`bot_agent` 为 UA 风格 `Name/1.2.3`
自报身份（仅观测用，不参与鉴权/路由），ASCII、≤256 字节、token 正则 `^[A-Za-z0-9_.\-]{1,32}/[A-Za-z0-9_.+\-]{1,32}$`。
安全白名单：API/二维码基址只接受 https 且 *.weixin.qq.com、443 端口（dsh-im-weixin 同款校验，防 token 外泄）。

## 消息模型（官方 types 逐字段）

```ts
interface WeixinMessage {
  seq?: number;
  message_id?: number;          // 幂等键（字符串化后用）；缺省回落 client_id
  from_user_id?: string;        // 发送者 id（threads/白名单键）
  to_user_id?: string;
  client_id?: string;           // 客户端去重 id；出站时自造 "ilink-<ts>-<hex>"
  session_id?: string;
  group_id?: string;            // 非空 = 群消息；本通道直接忽略
  message_type?: number;        // 1=USER 2=BOT 0=NONE
  message_state?: number;       // 0=NEW 1=GENERATING 2=FINISH（出站用 FINISH）
  item_list?: MessageItem[];
  context_token?: string;       // 回复凭证：入站缓存、出站必带
  create_time_ms?: number;      // 陈旧消息可按龄丢弃
  run_id?: string;              // sendmessage 可选附加（dsh-im-weixin 用法）
}
interface MessageItem {
  type?: number;                // 1=TEXT 2=IMAGE 3=VOICE 4=FILE 5=VIDEO
  msg_id?: string; create_time_ms?: number; update_time_ms?: number; is_completed?: boolean;
  text_item?:  { text?: string };
  voice_item?: { media?, encode_type?, bits_per_sample?, sample_rate?, playtime?, text? }; // text=服务端 ASR 转写
  image_item?: { media?, thumb_media?, aeskey?, url?, mid_size?, thumb_size?, thumb_height?, thumb_width?, hd_size? };
  file_item?:  { media?, file_name?, md5?, len? };   // len 是 string
  video_item?: { media?, video_size?, play_length?, video_md5?, thumb_media?, thumb_size?, thumb_height?, thumb_width? };
  ref_msg?:    { title?, message_item? };            // 引用消息
}
interface CDNMedia {
  encrypt_query_param?: string; // CDN 下载参数
  aes_key?: string;             // base64；图片=base64(raw16)，文件/语音/视频=base64(hex16)
  encrypt_type?: number;        // 0=只加密 fileid，1=打包缩略图/中图信息
  full_url?: string;            // 服务端直发的完整下载 URL（可省自拼）
}
```

发送（text）组包（官方/第三方一致）：

```ts
{ msg: {
    from_user_id: "",
    to_user_id: fromUserId,
    client_id: "ilink-<Date.now()>-<6字节hex>",
    message_type: 2,            // BOT
    message_state: 2,           // FINISH
    item_list: [{ type: 1, text_item: { text } }],
    context_token,              // 必带
  }, base_info }
```

## 媒体细节

- **AES-128-ECB / PKCS7**，无 IV。密文大小 `Math.ceil((n+1)/16)*16`。
- 入站解密 key：`CDNMedia.aes_key`（base64）双形态——解码后 16 字节即原 key；解码后 32 字节 ASCII hex 则需再 hex-decode。图片另可直接用 `image_item.aeskey`（hex 字符串，优先）。
- 出站上传：本地生成 16 字节 key（`aeskey` 传 hex），filekey=16 字节 hex，rawsize=明文大小，rawfilemd5=明文 MD5 hex，filesize=密文大小；media_type：1=IMAGE 2=VIDEO 3=FILE 4=VOICE；`no_need_thumb: true` 可免缩略图（IMAGE/VIDEO 理论要求缩略图三元组）。
- 上传成功后 sendmessage 的 item：`image_item:{ media:{encrypt_query_param, aes_key: base64(hex), encrypt_type:1}, mid_size: 密文大小 }`；video 同构用 `video_size`；file 用 `file_name` + `len`（明文大小字符串）。
- 语音编码枚举（encode_type）：1=pcm 2=adpcm 3=feature 4=speex 5=amr 6=silk 7=mp3 8=ogg-speex。**出站语音不投递，勿用。**

## 已知限制与防御式处理清单

1. `errcode -14`（ret 同义）：bot_token 失效 → 停轮询、要求重扫码。其他非 0 ret/errcode 显式抛错，不静默丢。
2. 无 `context_token`（用户从未发言）：拒绝发送并显式报错；不尝试冷启动。
3. 24h 服务端窗口：用户 >24h 未互动后 Bot 主动消息被服务端丢弃。社区做法按 20h 安全窗：超窗不发送、暂存摘要、下次入站补发。本插件按同一策略（可配置 windowHours，默认 20）。
4. 频控防御：出站滑动窗口默认 10 条/分钟、串行队列、失败重试 3 次（1s/2s/4s 递增）。
5. 仅私聊：`group_id` 非空的消息忽略（仅记录 debug 日志）。
6. 无群聊、无好友目录、无撤回、无历史查询 API。
7. 单文件上限 100 MiB；图片/音频建议 ≤20 MiB；长文本按 1800~4000 字符/条切分（换行感知切分优于硬切）。
8. 账号前提：手机微信最新版 + 已灰度「微信机器人/ClawBot」入口（我 → 设置 → 插件）。无入口时扫码失败，属平台限制，需用户知悉。
9. 扫码登录附加状态：`scaned_but_redirect`（`redirect_host` 更新基址）、`need_verifycode`（用户输入配对数字后带 `verify_code` 重轮询）、`binded_redirect`、`verify_code_blocked`。
10. 凭证安全：bot_token 只进引擎配置/凭据文件（0600），不落日志；日志与错误信息统一脱敏（token、context_token）；`get_updates_buf` 游标原子落盘可断点续传。

## 与插件实现的映射（dsh-superagent-wechat 设计要点）

- kind: `'wechat'`；health: `'wechatPoll'`（收消息形态 = 长轮询）。
- Config: `accounts` rows，行字段 `{ id, botToken, accountId(ilink_bot_id), baseUrl, allowed: string[] }`。
  botToken 由扫码 CLI（repo 内 bin 脚本，形态同 dsh-im-weixin 的 weixin-qr）获取后粘贴进配置； baseUrl 缺省 https://ilinkai.weixin.qq.com。
- trigger id: `'wechat:' + String(message_id ?? client_id)`（幂等）。
- threads: `'u:' + from_user_id`；addressed: 私聊即 'direct'；policy allowed 白名单：首条消息 log 发送者 from_user_id 供抄写。
- 回复：sendmessage 携带该用户缓存 context_token；文本 2000 字/条切分；-14 显式失败。
- 生命周期：连接后 notifystart；dispose 时 notifystop（尽力而为）；get_updates_buf 持久化在引擎给的状态目录。

## 来源清单（实读）

npm tarball（registry.npmjs.org，均已下载实读源码/README）：

- https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin （2.4.10，腾讯官方 MIT 源码包，协议源头）
- https://www.npmjs.com/package/weixin-ilink （0.1.0，TS 5 端点最小实现）
- https://www.npmjs.com/package/wechat-ilink-client （0.1.0，中文文档、游标/媒体全）
- https://www.npmjs.com/package/@pawastation/ilink-bot-sdk （0.2.0，CDN 上传/下载与 poller 防御实现最全）
- https://www.npmjs.com/package/@wechatbot/wechatbot （2.2.0）
- https://www.npmjs.com/package/@zhin.js/adapter-weixin-ilink （1.1.22，2026-11-04 更新，notifystart/stop 与 base_info 细节）
- https://www.npmjs.com/package/dsh-im-weixin （1.0.5，DSH 插件家族适配器：URL 白名单、扫码 CLI、切分策略）
- https://www.npmjs.com/package/dsh-wechat-channel （0.3.1，README 提供运维事实：24h 窗口、限速、-14 行为）
- https://www.npmjs.com/package/dsh-plugin-weixin （1.5.9，README 提供运维事实：白名单/首条登记、voiceOutbound 不投递、凭证 0600）

GitHub（lead 提供线索 + platform_search 命中；本机直连不通，未逐仓库拉取全文）：

- https://github.com/x1ah/wechat-ilink-demo （协议拆解与实战，线索来源）
- https://github.com/Cp0204/WeClawBot-API （HTTP 推送 API 服务；platform_search 另见 ns-zzj/WeClawBot-API-WebUI）
- https://github.com/SpenserCai/weixin-agent-sdk-rs （Rust protocol-level SDK）
- https://github.com/minibear2021/wechat_clawbot_sdk 、https://github.com/CloudSen/wx-aibot-java-sdk 、https://github.com/RongleCat/hermes-wechat （Python/Java/OpenClaw skill 先例）
- https://github.com/Tencent/openclaw-weixin （官方源仓库；npm 包即其发布物）
- https://github.com/photon-hq/wechat-ilink-client （platform_search 命中的又一独立实现，⭐84）
