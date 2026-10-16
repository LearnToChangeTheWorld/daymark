import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readFile, writeFile, mkdir, access, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

export const napcatRelease = 'v4.18.38';
export async function freePort() {
  const server = createServer(); await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const port = server.address().port; await new Promise((done) => server.close(done)); return port;
}
export class ChatError extends Error {
  constructor(message, code = 'error') { super(message); this.code = code; this.status = 422; }
}
export class NapcatClient {
  constructor({ dataDir, vendorDir = resolve('vendor/napcat'), fetchImpl = fetch, onEvent = () => {}, onDisconnect = () => {} }) {
    this.dataDir = resolve(dataDir); this.vendorDir = resolve(vendorDir); this.fetch = fetchImpl; this.onEvent = onEvent; this.onDisconnect = onDisconnect;
  }
  async start() {
    if (this.credential) { try { await this.loginStatus(); return; } catch {} }
    const launcher = join(this.vendorDir, 'NapCatWinBootMain.exe');
    try { await access(launcher); } catch { throw new ChatError('QQ 扫码组件尚未安装，请运行 tools/setup-chat.ps1 -Component QQ', 'component_missing'); }
    const candidates = [process.env.STUDENT_INBOX_QQ_PATH, join(process.env.ProgramFiles || 'C:\\Program Files', 'Tencent/QQNT/QQ.exe'), join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Tencent/QQNT/QQ.exe')].filter(Boolean);
    let executable;
    for (const path of candidates) { try { await access(path); executable = path; break; } catch {} }
    if (!executable) throw new ChatError('未找到 Windows QQ，请先安装官方 QQ 客户端', 'client_missing');
    const configDir = join(this.dataDir, 'config'); await mkdir(configDir, { recursive: true });
    await unlink(join(this.dataDir, 'cache/qrcode.png')).catch((e) => { if (e.code !== 'ENOENT') throw e; });
    this.token = randomBytes(32).toString('hex'); this.port = await freePort(); this.obPort = await freePort();
    let prior = {}; try { prior = JSON.parse(await readFile(join(configDir, 'webui.json'), 'utf8')); } catch {}
    await writeFile(join(configDir, 'webui.json'), JSON.stringify({ ...prior, host: '127.0.0.1', port: this.port, token: this.token, loginRate: 20, disableWebUI: false, enable2FA: false, autoLoginAccount: prior.autoLoginAccount || '' }), { mode: 0o600 });
    const hook = join(this.vendorDir, 'NapCatWinBootHook.dll');
    const environment = { ...process.env };
    for (const key of ['NAPCAT_QUICK_ACCOUNT', 'NAPCAT_QUICK_PASSWORD', 'NAPCAT_QUICK_PASSWORD_MD5', 'NAPCAT_WEBUI_SECRET_KEY', 'NAPCAT_WEBUI_PREFERRED_PORT']) delete environment[key];
    this.child = spawn(launcher, [executable, hook], { cwd: this.vendorDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...environment,
      NAPCAT_WORKDIR: this.dataDir, NAPCAT_PATCH_PACKAGE: join(this.vendorDir, 'qqnt.json'), NAPCAT_LOAD_PATH: join(this.vendorDir, 'loadNapCat.js'),
      NAPCAT_INJECT_PATH: hook, NAPCAT_MAIN_PATH: join(this.vendorDir, 'napcat.mjs') } });
    // Native component output may contain QR tokens. Never forward it to the UI or application log.
    this.diagnostic = '';
    const collect = (chunk) => { this.diagnostic = (this.diagnostic + chunk.toString()).slice(-12_000); const pid = this.diagnostic.match(/Main Process ID:\s*(\d+)/); if (pid) this.qqPid = Number(pid[1]); };
    this.child.stdout.on('data', collect); this.child.stderr.on('data', collect);
    let launchFailed = false; this.child.on('error', () => { launchFailed = true; });
    // The native launcher may hand off to QQ and exit before the HTTP service is ready.
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      if (launchFailed) throw new ChatError('QQ 接入组件启动失败，请检查 QQ 版本兼容性和系统安全软件', 'launch_failed');
      try { await this.authenticate(); return; } catch {}
      await new Promise((done) => setTimeout(done, 500));
    }
    throw new ChatError('QQ 扫码服务启动超时，请关闭正在运行的其他 QQ 窗口后重试；也可能是当前 QQ 版本不兼容', 'launch_timeout');
  }
  async post(path, data = {}, credential = this.credential) {
    let response;
    try { response = await this.fetch(`http://127.0.0.1:${this.port}/api${path}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000), headers: { 'content-type': 'application/json', ...(credential ? { authorization: `Bearer ${credential}` } : {}) }, body: JSON.stringify(data) }); }
    catch { throw new ChatError('无法连接 QQ 扫码服务，请重新打开扫码登录', 'offline'); }
    if (!response.ok) throw new ChatError('QQ 接入服务拒绝请求，请重试', 'offline');
    const result = await response.json();
    if (result.code !== 0) throw new ChatError('QQ 接入服务未完成请求，请刷新二维码或重新连接', 'api_error');
    return result.data;
  }
  async authenticate() {
    const result = await this.post('/auth/login', { hash: createHash('sha256').update(this.token + '.napcat').digest('hex') }, null);
    if (!result?.Credential) throw new ChatError('无法验证 QQ 本机接入服务');
    this.credential = result.Credential; this.authenticatedAt = Date.now();
  }
  async call(path, data = {}) { if (!this.credential || Date.now() - this.authenticatedAt > 50 * 60_000) await this.authenticate(); return this.post(path, data); }
  async loginStatus() { return this.call('/QQLogin/CheckLoginStatus'); }
  async qrImage() { try { return await readFile(join(this.dataDir, 'cache/qrcode.png')); } catch { throw new ChatError('二维码尚未生成，请稍候或刷新二维码'); } }
  async refreshQr() { await unlink(join(this.dataDir, 'cache/qrcode.png')).catch((e) => { if (e.code !== 'ENOENT') throw e; }); return this.call('/QQLogin/RefreshQRcode'); }
  async loginInfo() { return this.call('/QQLogin/GetQQLoginInfo'); }
  async remember(uin, enabled) { await this.call('/QQLogin/SetQuickLoginQQ', { uin: enabled ? String(uin) : '' }); }
  async enableEvents() {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    const config = await this.call('/OB11Config/GetConfig');
    const name = 'StudentInbox';
    config.network ||= {};
    config.network.websocketServers = [...(config.network.websocketServers || []).filter((entry) => entry.name !== name), {
      name, enable: true, host: '127.0.0.1', port: this.obPort, reportSelfMessage: true, enableForcePushEvent: true, messagePostFormat: 'array', token: this.token, debug: false, heartInterval: 15000
    }];
    await this.call('/OB11Config/SetConfig', { config: JSON.stringify(config) });
    await new Promise((done) => setTimeout(done, 500));
    const ws = new WebSocket(`ws://127.0.0.1:${this.obPort}/?access_token=${this.token}`); this.ws = ws;
    await new Promise((done, reject) => {
      const timer = setTimeout(() => { ws.close(); reject(new ChatError('QQ 已登录，但群消息通道连接超时，请重试')); }, 8000);
      ws.addEventListener('open', () => { clearTimeout(timer); done(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new ChatError('QQ 已登录，但群消息通道无法连接，请重试')); }, { once: true });
    });
    this.pending = new Map(); this.seq = 0;
    ws.addEventListener('message', ({ data }) => {
      let event; try { event = JSON.parse(data); } catch { return; }
      if (event.echo && this.pending.has(event.echo)) {
        const task = this.pending.get(event.echo); this.pending.delete(event.echo); clearTimeout(task.timer);
        event.status === 'ok' ? task.done(event.data) : task.reject(new ChatError('QQ 群列表读取失败，请重试'));
      } else { Promise.resolve(this.onEvent(event)).catch(() => this.onDisconnect('消息保存失败，请重试；接入状态已标记异常')); }
    });
    ws.addEventListener('close', () => { for (const task of this.pending.values()) { clearTimeout(task.timer); task.reject(new ChatError('QQ 消息通道已断开')); } this.pending.clear(); this.onDisconnect(); });
  }
  action(action, params = {}) {
    if (this.ws?.readyState !== WebSocket.OPEN) return Promise.reject(new ChatError('QQ 消息通道尚未连接'));
    const echo = 'student-' + (++this.seq);
    return new Promise((done, reject) => { const timer = setTimeout(() => { this.pending.delete(echo); reject(new ChatError('QQ 群列表响应超时')); }, 10_000); this.pending.set(echo, { done, reject, timer }); this.ws.send(JSON.stringify({ action, params, echo })); });
  }
  async close() {
    this.ws?.close();
    // Stop only the process tree started for this connector, never a user's other QQ.
    const pid = this.qqPid || (this.child?.exitCode === null ? this.child.pid : null);
    if (pid) {
      await new Promise((done) => { const child = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); child.on('error', done); child.on('exit', done); });
    }
    this.child = null; this.credential = null; this.qqPid = null;
  }
}
