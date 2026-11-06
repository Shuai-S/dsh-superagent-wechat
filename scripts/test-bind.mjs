#!/usr/bin/env node
// 绑定页 mock 全状态测试：注入假 qrLoginImpl 推进状态机（waiting/scanned/verify/confirmed、
// expired→refreshing、各错误码、TTL、一次性交付），并起真实 HTTP 服务断言路由与安全闸门
// （token 闸门 / Host 校验 / 404 / no-store）。import 自 ../lib/index.js，跑前先 build。
// 约束：不打印真实形态凭据（用例全部用 FAKE_ 前缀假凭据）。
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { SessionManager, startBindServer, encodeQrSvg, encodeQrMatrix, IlinkError, createPanelHandler, sameOrigin } from '../lib/index.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function httpJson(port, method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let data = null
        try { data = JSON.parse(text) } catch { data = text }
        resolve({ status: res.statusCode, headers: res.headers, text, data })
      })
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

const FAKE_CREDS = { botToken: 'FAKE_TOKEN_AAAA', accountId: 'FAKE_BOT_ID', baseUrl: 'https://ilinkai.weixin.qq.com', userId: 'FAKE_USER_ID' }

// —— 场景 mock（与 src/qr.ts 的回调契约同形）——
function mockHappyVerify() {
  return async (cbs) => {
    cbs.onQrUrl('https://qr.example/one')
    cbs.onStatus?.('waiting')
    await sleep(30)
    cbs.onStatus?.('scanned')
    await sleep(30)
    await cbs.readVerifyCode()
    await sleep(30)
    cbs.onStatus?.('scanned')
    await sleep(120)
    return FAKE_CREDS
  }
}
// 从不要求配对码：验证在非 verify 相位提交被拒（无竞态窗口）。
function mockNoVerify() {
  return async (cbs) => {
    cbs.onQrUrl('https://qr.example/n')
    cbs.onStatus?.('waiting')
    await sleep(2000)
    return FAKE_CREDS
  }
}
function mockRefresh() {
  return async (cbs) => {
    cbs.onQrUrl('https://qr.example/v1')
    cbs.onStatus?.('waiting')
    await sleep(40)
    cbs.onStatus?.('refreshing')
    await sleep(40)
    cbs.onQrUrl('https://qr.example/v2-with-a-longer-url-for-a-different-svg')
    cbs.onStatus?.('waiting')
    await sleep(40)
    cbs.onStatus?.('scanned')
    await sleep(250)
    return FAKE_CREDS
  }
}
function mockInstant() {
  return async (cbs) => {
    cbs.onQrUrl('https://qr.example/t')
    cbs.onStatus?.('waiting')
    await sleep(10)
    return FAKE_CREDS
  }
}
function mockReject(code, message) {
  return async (cbs) => {
    cbs.onQrUrl('https://qr.example/x')
    cbs.onStatus?.('waiting')
    await sleep(20)
    throw new IlinkError(code, message)
  }
}
function mockRejectPlain(message) {
  return async (cbs) => {
    cbs.onQrUrl('https://qr.example/x')
    cbs.onStatus?.('waiting')
    await sleep(20)
    throw new Error(message)
  }
}

// 轮询直到某相位。注意：confirmed/error 是一次性交付——本函数第一次看到即返回，
// 返回值就是交付负载；之后再查必为 404/undefined。
async function waitPhase(statusFn, id, phase, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = statusFn(id)
    if (last && last.phase === phase) return last
    await sleep(15)
  }
  throw new Error('timeout waiting phase ' + phase + ' (last=' + JSON.stringify(last ? last.phase : null) + ')')
}

const checks = []
const check = (name, fn) => checks.push({ name, fn })

// ============ HTTP 层（真实服务器，注入 mockHappyVerify）============
check('page: GET / 200 no-store 含 token 与标题', async () => {
  const h = await startBindServer({ port: 0, qrLoginImpl: mockHappyVerify() })
  try {
    const res = await httpJson(h.port, 'GET', '/')
    assert.equal(res.status, 200)
    assert.equal(res.headers['cache-control'], 'no-store')
    assert.ok(res.text.includes('微信 ClawBot 绑定'))
    assert.ok(res.text.includes(h.token), 'page must embed the server token')
    // 页面内嵌 token 可直接用于 /qr/start（证明替换逻辑与闸门自洽）。
    const m = res.text.match(/TOKEN = '([0-9a-f]{32})'/)
    assert.ok(m, 'embedded TOKEN literal present')
    const start = await httpJson(h.port, 'POST', '/qr/start', { headers: { 'x-bind-token': m[1] } })
    assert.equal(start.status, 200)
    assert.ok(typeof start.data.sessionId === 'string' && start.data.sessionId.length > 8)
  } finally { await new Promise((r) => h.server.close(r)) }
})

check('host 校验: 伪造 Host 的 GET / → 403', async () => {
  const h = await startBindServer({ port: 0, qrLoginImpl: mockHappyVerify() })
  try {
    const res = await httpJson(h.port, 'GET', '/', { headers: { host: 'evil.example' } })
    assert.equal(res.status, 403)
  } finally { await new Promise((r) => h.server.close(r)) }
})

check('token 闸门: 无 x-bind-token 的 /qr/* → 401', async () => {
  const h = await startBindServer({ port: 0, qrLoginImpl: mockHappyVerify() })
  try {
    assert.equal((await httpJson(h.port, 'POST', '/qr/start')).status, 401)
    assert.equal((await httpJson(h.port, 'GET', '/qr/status?session=x')).status, 401)
    assert.equal((await httpJson(h.port, 'POST', '/qr/verify', { body: '{}' })).status, 401)
    assert.equal((await httpJson(h.port, 'POST', '/qr/cancel', { body: '{}' })).status, 401)
  } finally { await new Promise((r) => h.server.close(r)) }
})

check('未知路径 → 404；token 错 → 401', async () => {
  const h = await startBindServer({ port: 0, qrLoginImpl: mockHappyVerify() })
  try {
    assert.equal((await httpJson(h.port, 'GET', '/nope')).status, 404)
    assert.equal((await httpJson(h.port, 'POST', '/qr/start', { headers: { 'x-bind-token': 'wrong' } })).status, 401)
  } finally { await new Promise((r) => h.server.close(r)) }
})

check('start→waiting(+qrSvg)→scanned→verify→confirmed，凭据字段名正确且一次性', async () => {
  const h = await startBindServer({ port: 0, qrLoginImpl: mockHappyVerify() })
  try {
    const started = await httpJson(h.port, 'POST', '/qr/start', { headers: { 'x-bind-token': h.token } })
    assert.equal(started.status, 200)
    const id = started.data.sessionId
    const waiting = await waitPhase((sid) => h.sessions.status(sid), id, 'waiting')
    assert.ok(waiting.qrSvg && waiting.qrSvg.includes('<svg'))
    const scanned = await waitPhase((sid) => h.sessions.status(sid), id, 'scanned')
    assert.equal(scanned.qrSvg, undefined, 'scanned must not carry qrSvg')
    // 页面只在 verify 相位显示输入框；测试同样等相位到位再提交。
    await waitPhase((sid) => h.sessions.status(sid), id, 'verify')
    assert.equal((await httpJson(h.port, 'POST', '/qr/verify', { headers: { 'x-bind-token': h.token }, body: JSON.stringify({ session: id, code: ' 0042 ' }) })).status, 200)
    const confirmed = await waitPhase((sid) => h.sessions.status(sid), id, 'confirmed')
    const c = confirmed.credentials
    assert.deepEqual(Object.keys(c).sort(), ['baseUrl', 'botToken', 'ilinkBotId', 'ilinkUserId'])
    assert.equal(c.botToken, FAKE_CREDS.botToken)
    assert.equal(c.ilinkBotId, FAKE_CREDS.accountId)
    assert.equal(c.baseUrl, FAKE_CREDS.baseUrl)
    assert.equal(c.ilinkUserId, FAKE_CREDS.userId)
    const again = await httpJson(h.port, 'GET', '/qr/status?session=' + encodeURIComponent(id), { headers: { 'x-bind-token': h.token } })
    assert.equal(again.status, 404, 'confirmed credentials are delivered once')
  } finally { await new Promise((r) => h.server.close(r)) }
})

check('verify 在非 verify 相位 → 400；未知会话 status → 404', async () => {
  const h = await startBindServer({ port: 0, qrLoginImpl: mockNoVerify() })
  try {
    const id = (await httpJson(h.port, 'POST', '/qr/start', { headers: { 'x-bind-token': h.token } })).data.sessionId
    await waitPhase((sid) => h.sessions.status(sid), id, 'waiting')
    const early = await httpJson(h.port, 'POST', '/qr/verify', { headers: { 'x-bind-token': h.token }, body: JSON.stringify({ session: id, code: '1' }) })
    assert.equal(early.status, 400)
    assert.ok(early.data.error)
    assert.equal((await httpJson(h.port, 'GET', '/qr/status?session=unknown', { headers: { 'x-bind-token': h.token } })).status, 404)
  } finally { await new Promise((r) => h.server.close(r)) }
})

check('cancel 后 status 404；旧会话被新 start 替换', async () => {
  const h = await startBindServer({ port: 0, qrLoginImpl: mockHappyVerify() })
  try {
    const s1 = (await httpJson(h.port, 'POST', '/qr/start', { headers: { 'x-bind-token': h.token } })).data.sessionId
    const s2 = (await httpJson(h.port, 'POST', '/qr/start', { headers: { 'x-bind-token': h.token } })).data.sessionId
    assert.notEqual(s1, s2)
    assert.equal(h.sessions.status(s1), undefined, 'old session replaced by new start')
    assert.notEqual(h.sessions.status(s2), undefined)
    const cancelled = await httpJson(h.port, 'POST', '/qr/cancel', { headers: { 'x-bind-token': h.token }, body: JSON.stringify({ session: s2 }) })
    assert.equal(cancelled.status, 200)
    assert.equal((await httpJson(h.port, 'GET', '/qr/status?session=' + encodeURIComponent(s2), { headers: { 'x-bind-token': h.token } })).status, 404)
  } finally { await new Promise((r) => h.server.close(r)) }
})

// ============ 状态机层（直接注入 SessionManager）============
check('refresh 路径: waiting→refreshing→waiting(新SVG)→scanned→confirmed', async () => {
  const m = new SessionManager({ qrLoginImpl: mockRefresh() })
  const id = m.start()
  const first = await waitPhase((sid) => m.status(sid), id, 'waiting')
  const svg1 = first.qrSvg
  assert.ok(svg1 && svg1.includes('<svg'))
  const refreshing = await waitPhase((sid) => m.status(sid), id, 'refreshing')
  assert.ok(refreshing.qrSvg, 'refreshing carries latest qrSvg')
  const second = await waitPhase((sid) => m.status(sid), id, 'waiting')
  assert.notEqual(second.qrSvg, svg1, 'SVG updated after refresh')
  await waitPhase((sid) => m.status(sid), id, 'scanned')
  const confirmed = await waitPhase((sid) => m.status(sid), id, 'confirmed')
  assert.equal(confirmed.credentials.ilinkBotId, FAKE_CREDS.accountId)
})

check('error 路径（IlinkError 保留 code）且一次性交付', async () => {
  for (const code of ['verify-code-blocked', 'binded-redirect', 'login-timeout']) {
    const m = new SessionManager({ qrLoginImpl: mockReject(code, 'boom ' + code) })
    const id = m.start()
    const err = await waitPhase((sid) => m.status(sid), id, 'error')
    assert.equal(err.error.code, code)
    assert.ok(err.error.message.includes('boom'))
    assert.equal(m.status(id), undefined, 'error delivered once')
  }
})

check('error 路径（非 IlinkError → internal）', async () => {
  const m = new SessionManager({ qrLoginImpl: mockRejectPlain('plain boom') })
  const id = m.start()
  const err = await waitPhase((sid) => m.status(sid), id, 'error')
  assert.equal(err.error.code, 'internal')
  assert.ok(err.error.message.includes('plain boom'))
  assert.equal(m.status(id), undefined)
})

check('verify: 空白码拒绝；trim 后提交可继续到 confirmed；cancel 中止', async () => {
  const m = new SessionManager({ qrLoginImpl: mockHappyVerify() })
  const id = m.start()
  await waitPhase((sid) => m.status(sid), id, 'verify')
  const blank = m.verify(id, '   ')
  assert.equal(blank.ok, false)
  const ok = m.verify(id, ' 0042 ')
  assert.equal(ok.ok, true)
  await waitPhase((sid) => m.status(sid), id, 'confirmed')
  // cancel：另一会话在 verify 相位取消后 404。
  const m2 = new SessionManager({ qrLoginImpl: mockHappyVerify() })
  const id2 = m2.start()
  await waitPhase((sid) => m2.status(sid), id2, 'verify')
  m2.cancel(id2)
  assert.equal(m2.status(id2), undefined)
})

check('TTL: 过期会话直接丢弃（confirmed 凭据宁可不交付也不滞留）', async () => {
  let now = 1_000_000
  const m = new SessionManager({ qrLoginImpl: mockInstant(), now: () => now })
  const id = m.start()
  await sleep(30)
  now += 9 * 60_000
  const alive = m.status(id)
  assert.notEqual(alive, undefined, 'within TTL still deliverable')
  assert.equal(alive.phase, 'confirmed')
  const m2 = new SessionManager({ qrLoginImpl: mockInstant(), now: () => now })
  const id2 = m2.start()
  await sleep(30)
  now += 10 * 60_000 + 1
  assert.equal(m2.status(id2), undefined, 'expired before delivery: dropped')
})

check('encodeQrSvg: 确定性、定位图案、rect 计数、border 选项', () => {
  const url = 'https://weixin.qq.com/r/bind-test-1234567890'
  const a = encodeQrSvg(url)
  assert.equal(a, encodeQrSvg(url))
  const matrix = encodeQrMatrix(url)
  const size = matrix.length
  let dark = 0
  for (const row of matrix) for (const c of row) if (c) dark++
  const rects = (a.match(/<rect/g) || []).length
  assert.equal(rects, dark + 1, 'one white background rect + one rect per dark module')
  assert.ok(a.includes('viewBox="0 0 ' + (size + 8) + ' ' + (size + 8) + '"'), 'default border 4')
  const finderDark = (cx, cy) => {
    let n = 0
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== 2 && matrix[cy + dy][cx + dx]) n++
    }
    return n
  }
  assert.equal(finderDark(3, 3), 33)
  assert.equal(finderDark(size - 4, 3), 33)
  assert.equal(finderDark(3, size - 4), 33)
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) === 2) assert.equal(matrix[cy + dy][cx + dx], false, 'finder separator ring light')
    }
  }
  for (let i = 8; i < size - 8; i++) {
    assert.equal(matrix[6][i], i % 2 === 0, 'timing row')
    assert.equal(matrix[i][6], i % 2 === 0, 'timing column')
  }
  const tight = encodeQrSvg(url, { border: 2 })
  assert.ok(tight.includes('viewBox="0 0 ' + (size + 4) + ' ' + (size + 4) + '"'), 'border option honored')
})

// ============ 面板同源路由层（webServer seam，同款 SessionManager）============

/** 起一个临时 http server 挂面板 handler（url 带 /wechat 前缀，模拟 webServer prefix 分发）。
 *  先监听拿实际端口（port=0 时 OS 分配），再用实际端口建 handler——Host 校验按端口匹配。 */
async function startPanelServer(sessions, port) {
  let handler = null
  const server = createServer((req, res) => { if (handler) void handler(req, res) })
  const actual = await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server.address().port))
  })
  handler = createPanelHandler(sessions, actual)
  return { server, port: actual }
}

check('panel: sameOrigin 闸门——缺头/错 Host/跨源 Origin 都 403，同源 GET 通行', async () => {
  const m = new SessionManager({ qrLoginImpl: mockHappyVerify() })
  const { server, port } = await startPanelServer(m, 0)
  try {
    const okHeaders = { host: '127.0.0.1:' + port, 'x-orchestrator-request': '1' }
    assert.equal((await httpJson(port, 'GET', '/wechat/api/qr/status?session=x', { headers: okHeaders })).status, 404, 'gated request passes and 404s on unknown session')
    assert.equal((await httpJson(port, 'GET', '/wechat/api/qr/status?session=x', { headers: { host: '127.0.0.1:' + port } })).status, 403, 'missing x-orchestrator-request rejected')
    assert.equal((await httpJson(port, 'GET', '/wechat/api/qr/status?session=x', { headers: { host: 'evil.example', 'x-orchestrator-request': '1' } })).status, 403, 'wrong host rejected')
    const cross = { host: '127.0.0.1:' + port, 'x-orchestrator-request': '1', origin: 'http://evil.example' }
    assert.equal((await httpJson(port, 'GET', '/wechat/api/qr/status?session=x', { headers: cross })).status, 403, 'cross-origin Origin rejected')
    const same = { host: '127.0.0.1:' + port, 'x-orchestrator-request': '1', origin: 'http://127.0.0.1:' + port }
    assert.equal((await httpJson(port, 'GET', '/wechat/api/qr/status?session=x', { headers: same })).status, 404, 'same-origin Origin accepted')
    assert.equal(sameOrigin({ headers: { host: 'localhost:' + port, 'x-orchestrator-request': '1' } }, port), true, 'localhost host accepted')
  } finally { await new Promise((r) => server.close(r)) }
})

check('panel: start→waiting→scanned→verify→confirmed 全链路 + 一次性交付 + no-store', async () => {
  const m = new SessionManager({ qrLoginImpl: mockHappyVerify() })
  const { server, port } = await startPanelServer(m, 0)
  try {
    const headers = { host: '127.0.0.1:' + port, 'x-orchestrator-request': '1' }
    const started = await httpJson(port, 'POST', '/wechat/api/qr/start', { headers, body: '{}' })
    assert.equal(started.status, 200)
    assert.ok(typeof started.data.sessionId === 'string' && started.data.sessionId.length > 8)
    const id = started.data.sessionId
    assert.equal(started.headers['cache-control'], 'no-store')
    const waiting = await waitPhase((sid) => m.status(sid), id, 'waiting')
    assert.ok(waiting.qrSvg && waiting.qrSvg.includes('<svg'), 'status carries qrSvg')
    const viaHttp = await httpJson(port, 'GET', '/wechat/api/qr/status?session=' + encodeURIComponent(id), { headers })
    assert.equal(viaHttp.status, 200)
    assert.equal(viaHttp.data.phase, 'waiting')
    assert.ok(viaHttp.data.qrSvg.includes('<svg'))
    await waitPhase((sid) => m.status(sid), id, 'verify')
    const verified = await httpJson(port, 'POST', '/wechat/api/qr/verify', { headers, body: JSON.stringify({ session: id, code: ' 0042 ' }) })
    assert.equal(verified.status, 200)
    // confirmed 是一次性交付：必须走 HTTP 轮询等相位（直查 manager 会把凭据消费掉）。
    const deadline = Date.now() + 4000
    let delivered = null
    while (Date.now() < deadline) {
      const r = await httpJson(port, 'GET', '/wechat/api/qr/status?session=' + encodeURIComponent(id), { headers })
      if (r.status === 200 && r.data && r.data.phase === 'confirmed') { delivered = r; break }
      if (r.status === 404) break
      await sleep(15)
    }
    assert.notEqual(delivered, null, 'confirmed delivered via panel route')
    assert.deepEqual(Object.keys(delivered.data.credentials).sort(), ['baseUrl', 'botToken', 'ilinkBotId', 'ilinkUserId'])
    assert.equal(delivered.data.credentials.botToken, FAKE_CREDS.botToken)
    const again = await httpJson(port, 'GET', '/wechat/api/qr/status?session=' + encodeURIComponent(id), { headers })
    assert.equal(again.status, 404, 'panel delivery is one-shot too')
  } finally { await new Promise((r) => server.close(r)) }
})

check('panel: 未知路径 404；非 /wechat 前缀 404；verify 相位校验与 26678 一致', async () => {
  const m = new SessionManager({ qrLoginImpl: mockHappyVerify() })
  const { server, port } = await startPanelServer(m, 0)
  try {
    const headers = { host: '127.0.0.1:' + port, 'x-orchestrator-request': '1' }
    assert.equal((await httpJson(port, 'GET', '/wechat/nope', { headers })).status, 404)
    assert.equal((await httpJson(port, 'GET', '/other/path', { headers })).status, 404)
    const early = await httpJson(port, 'POST', '/wechat/api/qr/verify', { headers, body: JSON.stringify({ session: 'unknown', code: '1' }) })
    assert.equal(early.status, 400)
    assert.ok(early.data.error)
    const cancelled = await httpJson(port, 'POST', '/wechat/api/qr/cancel', { headers, body: JSON.stringify({ session: 'whatever' }) })
    assert.equal(cancelled.status, 200)
    assert.equal(cancelled.data.ok, true)
  } finally { await new Promise((r) => server.close(r)) }
})

check('panel: 26678 页与面板共享 SessionManager——面板起会话，独立页/token 面行为不变', async () => {
  const shared = new SessionManager({ qrLoginImpl: mockHappyVerify() })
  const { server, port } = await startPanelServer(shared, 0)
  const h = await startBindServer({ port: 0, sessions: shared })
  try {
    // 面板起会话
    const panelHeaders = { host: '127.0.0.1:' + port, 'x-orchestrator-request': '1' }
    const panelStart = await httpJson(port, 'POST', '/wechat/api/qr/start', { headers: panelHeaders, body: '{}' })
    const panelId = panelStart.data.sessionId
    // 独立页的新 start 替换面板会话（单飞语义跨面共享）
    const pageStart = await httpJson(h.port, 'POST', '/qr/start', { headers: { 'x-bind-token': h.token } })
    assert.equal(pageStart.status, 200)
    assert.equal(shared.status(panelId), undefined, 'single-flight across surfaces')
    assert.notEqual(shared.status(pageStart.data.sessionId), undefined)
    // 26678 token 闸门不变：错 token 仍 401
    assert.equal((await httpJson(h.port, 'GET', '/qr/status?session=x', { headers: { 'x-bind-token': 'wrong' } })).status, 401)
    // watchBind 复用传入 manager：服务器重建不掉会话
    assert.equal(h.sessions, shared)
  } finally {
    await new Promise((r) => server.close(r))
    await new Promise((r) => h.server.close(r))
  }
})

// ============ 汇总 ============
let passed = 0
const failed = []
for (const c of checks) {
  try {
    await c.fn()
    passed++
    console.log('ok - ' + c.name)
  } catch (error) {
    failed.push(c.name)
    console.log('FAIL - ' + c.name + ': ' + String(error && error.message ? error.message : error).slice(0, 300))
  }
}
console.log('bind tests: ' + passed + '/' + checks.length + ' passed')
if (failed.length > 0) process.exit(1)
