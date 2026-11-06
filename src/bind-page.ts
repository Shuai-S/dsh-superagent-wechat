/** 绑定页单文件 HTML：中文、零外部资源（无 CDN/字体/图标库），内联 CSS/JS。
 *
 *  注意：页面 JS 有意不用模板字面量（全部字符串拼接），避免 TS 模板字符串转义地狱；
 *  服务端会把 BIND_TOKEN_PLACEHOLDER 替换为本次服务器生命周期的随机 token，
 *  页面所有 fetch 都带 x-bind-token 头。
 */

/** 页面内嵌 token 占位符（bind.ts 启动服务器时一次性替换）。 */
export const BIND_TOKEN_PLACEHOLDER = '__DSH_BIND_TOKEN__'

export const BIND_PAGE_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>微信 ClawBot 绑定</title>
<style>
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 16px; font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; color: #1f2328; background: #fafafa; }
main { max-width: 520px; margin: 0 auto; }
h1 { font-size: 20px; margin: 0 0 8px; }
.sub, .hint { color: #656d76; font-size: 13px; line-height: 1.6; }
.row { display: flex; gap: 8px; align-items: center; margin: 12px 0; flex-wrap: wrap; }
button { font-size: 14px; padding: 7px 16px; border-radius: 6px; border: 1px solid #d0d7de; background: #f6f8fa; cursor: pointer; }
button:hover { background: #eef1f4; }
button.ghost { background: transparent; }
input { font-size: 14px; padding: 7px 10px; border-radius: 6px; border: 1px solid #d0d7de; width: 200px; }
.qr { background: #fff; border: 1px solid #eaeef2; border-radius: 8px; padding: 12px; width: 264px; min-height: 200px; margin: 12px 0; }
.qr svg { width: 240px; height: 240px; display: block; }
.status { font-size: 14px; margin: 8px 0; }
pre { background: #f6f8fa; border: 1px solid #eaeef2; border-radius: 8px; padding: 12px; font-size: 12px; overflow: auto; white-space: pre-wrap; word-break: break-all; }
.err { color: #cf222e; font-size: 13px; margin: 6px 0; }
.hidden { display: none; }
</style>
</head>
<body>
<main>
<h1>微信 ClawBot 绑定</h1>
<p class="sub">用手机微信扫码把机器人绑定到本引擎。凭据只在本机内存中流转、一次性显示，不写入日志。</p>
<div class="row">
  <button id="startBtn" type="button">生成二维码</button>
  <button id="cancelBtn" type="button" class="ghost">取消</button>
</div>
<div id="qr" class="qr"></div>
<p id="status" class="status">正在打开绑定会话…</p>
<div id="verifyBox" style="display:none">
  <label for="verifyInput">配对码</label>
  <div class="row">
    <input id="verifyInput" inputmode="numeric" autocomplete="one-time-code" placeholder="手机微信上显示的数字">
    <button id="verifyBtn" type="button">提交</button>
  </div>
  <p id="verifyErr" class="err"></p>
</div>
<div id="resultBox" style="display:none">
  <p>复制下面的账户 JSON，粘贴到 <b>面板 → 来源 → 微信（ClawBot）→ 账户</b>（可整段粘进 JSON 视图，或逐字段填写），保存后自动拉起长轮询：</p>
  <pre id="credJson"></pre>
  <div class="row"><button id="copyBtn" type="button">一键复制</button><span id="copyHint" class="hint"></span></div>
</div>
<div id="errBox" style="display:none">
  <p id="errCode" class="err"></p>
  <p id="errMsg"></p>
  <p id="errHint" class="hint"></p>
</div>
<p class="hint">绑定页只监听 127.0.0.1，凭据一次性显示；刷新页面或关闭标签页即作废。终端 CLI（dsh-superagent-wechat-qr）仍是备选方案。</p>
</main>
<script>
(function () {
  'use strict';
  var TOKEN = '__DSH_BIND_TOKEN__';
  var sessionId = '';
  var pollTimer = null;
  function byId(id) { return document.getElementById(id); }
  function stopPoll() { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } }
  function api(path, opts) {
    opts = opts || {};
    opts.headers = { 'x-bind-token': TOKEN };
    if (opts.body) { opts.headers['content-type'] = 'application/json'; }
    return fetch(path, opts).then(function (res) {
      return res.text().then(function (t) {
        var data = null;
        try { data = JSON.parse(t); } catch (e) { data = null; }
        return { status: res.status, data: data };
      });
    });
  }

  function startQr() {
    stopPoll();
    sessionId = '';
    byId('qr').innerHTML = '';
    byId('status').textContent = '正在生成二维码…';
    byId('verifyBox').style.display = 'none';
    byId('resultBox').style.display = 'none';
    byId('errBox').style.display = 'none';
    byId('verifyErr').textContent = '';
    byId('verifyInput').value = '';
    api('/qr/start', { method: 'POST' }).then(function (r) {
      if (r.status === 200 && r.data && r.data.sessionId) {
        sessionId = r.data.sessionId;
        poll();
      } else {
        byId('status').textContent = '生成失败：' + ((r.data && r.data.error) || ('HTTP ' + r.status));
      }
    }).catch(function (e) { byId('status').textContent = '网络错误：' + e; });
  }
  function poll() {
    if (!sessionId) return;
    api('/qr/status?session=' + encodeURIComponent(sessionId)).then(function (r) {
      if (r.status === 404) {
        byId('status').textContent = '会话已失效，请点击「生成二维码」重试';
        return;
      }
      if (r.status !== 200 || !r.data) { pollTimer = setTimeout(poll, 1500); return; }
      var d = r.data;
      if (d.phase === 'waiting' || d.phase === 'refreshing') {
        if (d.qrSvg) byId('qr').innerHTML = d.qrSvg;
        byId('status').textContent = (d.phase === 'refreshing') ? '二维码已过期，正在刷新…' : '请用手机微信扫码';
        pollTimer = setTimeout(poll, 1500);
      } else if (d.phase === 'scanned') {
        byId('status').textContent = '已扫描，请在手机上确认';
        pollTimer = setTimeout(poll, 1500);
      } else if (d.phase === 'verify') {
        if (d.qrSvg) byId('qr').innerHTML = d.qrSvg;
        byId('status').textContent = '需要配对码：请输入手机微信上显示的配对数字';
        byId('verifyBox').style.display = 'block';
        byId('verifyInput').focus();
        pollTimer = setTimeout(poll, 1500);
      } else if (d.phase === 'confirmed') {
        showCredentials(d.credentials || {});
      } else if (d.phase === 'error') {
        showError(d.error || {});
      } else {
        pollTimer = setTimeout(poll, 1500);
      }
    }).catch(function () { pollTimer = setTimeout(poll, 1500); });
  }
  function submitVerify() {
    var code = byId('verifyInput').value.trim();
    if (!code) { byId('verifyErr').textContent = '请输入手机上显示的配对数字'; return; }
    api('/qr/verify', { method: 'POST', body: JSON.stringify({ session: sessionId, code: code }) }).then(function (r) {
      if (r.status === 200) {
        byId('verifyBox').style.display = 'none';
        byId('status').textContent = '已提交配对码，等待确认…';
      } else {
        byId('verifyErr').textContent = (r.data && r.data.error) || ('提交失败：HTTP ' + r.status);
      }
    }).catch(function (e) { byId('verifyErr').textContent = '网络错误：' + e; });
  }
  function cancelQr() {
    if (sessionId) { api('/qr/cancel', { method: 'POST', body: JSON.stringify({ session: sessionId }) }); }
    stopPoll();
    sessionId = '';
    byId('qr').innerHTML = '';
    byId('status').textContent = '已取消。点击「生成二维码」重新开始';
    byId('verifyBox').style.display = 'none';
    byId('resultBox').style.display = 'none';
    byId('errBox').style.display = 'none';
  }

  function showCredentials(c) {
    stopPoll();
    byId('qr').innerHTML = '';
    byId('verifyBox').style.display = 'none';
    byId('status').textContent = '绑定成功！复制下面的账户 JSON，粘贴到面板';
    var json = JSON.stringify([{ id: 'main', botToken: c.botToken || '', ilinkBotId: c.ilinkBotId || '', baseUrl: c.baseUrl || '', ilinkUserId: c.ilinkUserId || '', name: '' }], null, 2);
    byId('credJson').textContent = json;
    byId('copyHint').textContent = '';
    byId('resultBox').style.display = 'block';
  }
  function copyJson() {
    var text = byId('credJson').textContent;
    var fallback = function () {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      byId('copyHint').textContent = ok ? '已复制' : '复制失败，请手动全选复制';
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { byId('copyHint').textContent = '已复制'; }, fallback);
    } else {
      fallback();
    }
  }
  function showError(err) {
    stopPoll();
    byId('qr').innerHTML = '';
    byId('verifyBox').style.display = 'none';
    byId('status').textContent = '绑定失败';
    var code = (err && err.code) ? err.code : 'unknown';
    byId('errCode').textContent = '错误码：' + code;
    byId('errMsg').textContent = (err && err.message) ? err.message : '';
    var hints = {
      'verify-code-blocked': '配对码被服务端拦截（verify_code_blocked），请稍后重新生成二维码再试',
      'verify_code_blocked': '配对码被服务端拦截（verify_code_blocked），请稍后重新生成二维码再试',
      'binded-redirect': '该账号已在别处绑定（binded_redirect），请先在手机上解绑后再扫码',
      'binded_redirect': '该账号已在别处绑定（binded_redirect），请先在手机上解绑后再扫码',
      'login-timeout': '登录超时（8 分钟），请点击「生成二维码」重新开始',
      'qr-expired': '二维码过期次数过多，请重新生成',
      'verify-timeout': '配对码输入超时（5 分钟），请重新生成二维码',
      'aborted': '会话已取消'
    };
    byId('errHint').textContent = hints[code] || '请点击「生成二维码」重试；若持续失败，改用终端 CLI（见 README）';
    byId('errBox').style.display = 'block';
  }
  byId('startBtn').addEventListener('click', startQr);
  byId('cancelBtn').addEventListener('click', cancelQr);
  byId('verifyBtn').addEventListener('click', submitVerify);
  byId('verifyInput').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') submitVerify(); });
  byId('copyBtn').addEventListener('click', copyJson);
  startQr();
})();
</script>
</body>
</html>
`
;
