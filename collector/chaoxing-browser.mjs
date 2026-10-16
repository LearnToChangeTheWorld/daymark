import { spawn } from 'node:child_process';
import { access, readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { allowedUrl, PlatformError } from './chaoxing.mjs';

const pause = (ms) => new Promise((done) => setTimeout(done, ms));
// A separate, temporary Edge profile: never attach to the user's everyday browser.
export async function openChaoxingBrowser({ dataDir, cookies, headless = false }) {
  const candidates = [process.env.STUDENT_INBOX_EDGE_PATH,
    join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
    join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft/Edge/Application/msedge.exe'),
    join(process.env.LOCALAPPDATA || '', 'Microsoft/Edge/Application/msedge.exe')].filter(Boolean);
  let executable;
  for (const candidate of candidates) { try { await access(candidate); executable = candidate; break; } catch {} }
  if (!executable) throw new PlatformError('未找到 Microsoft Edge，请安装 Edge 后再打开验证窗口');
  const parent = resolve(dataDir, 'browser-sessions'); await mkdir(parent, { recursive: true });
  const profile = await mkdtemp(join(parent, 'chaoxing-'));
  const child = spawn(executable, ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-features=msEdgeSigninIntercept,msEdgeSigninRampUp', ...(headless ? ['--headless=new'] : []), 'about:blank'], { windowsHide: headless, stdio: 'ignore' });
  let launchError = false; child.on('error', () => { launchError = true; });
  let socket; let closed = false; let sequence = 0; const pending = new Map();
  function command(method, params = {}, sessionId) {
    if (closed || socket?.readyState !== WebSocket.OPEN) return Promise.reject(new PlatformError('验证窗口已关闭，请重新打开'));
    const id = ++sequence;
    return new Promise((done, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new PlatformError('学习通页面响应超时，请检查验证窗口后重试')); }, 35_000);
      pending.set(id, { done, reject, timer, method }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async function close() {
    if (closed) return;
    if (socket?.readyState === WebSocket.OPEN) { try { await command('Browser.close'); } catch {} }
    closed = true; socket?.close(); child.kill();
    // Only remove the exact temporary directory created above, inside this account's directory.
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
  try {
    let address;
    for (let i = 0; i < 80; i++) {
      if (launchError || child.exitCode !== null) throw new PlatformError('Edge 无法启动，请检查是否被学校或系统策略禁用');
      try {
        const [port, path] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/);
        if (/^\d+$/.test(port) && path?.startsWith('/devtools/browser/')) { address = `ws://127.0.0.1:${Number(port)}${path}`; break; }
      } catch {}
      await pause(150);
    }
    if (!address) throw new PlatformError('无法连接 Edge 验证窗口，请检查浏览器调试功能是否被系统策略禁用');
    socket = new WebSocket(address);
    await new Promise((done, reject) => {
      const timer = setTimeout(() => reject(new PlatformError('连接 Edge 超时')), 10_000);
      socket.addEventListener('open', () => { clearTimeout(timer); done(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new PlatformError('无法连接 Edge 验证窗口')); }, { once: true });
    });
    socket.addEventListener('message', ({ data }) => {
      const result = JSON.parse(data); const request = pending.get(result.id); if (!request) return;
      clearTimeout(request.timer); pending.delete(result.id);
      if (result.error) {
        const error = new PlatformError(`浏览器操作失败（${request.method}），请保持验证窗口打开后重试`);
        error.transient = /context.*destroyed|Cannot find context/i.test(result.error.message || ''); request.reject(error);
      } else request.done(result.result);
    });
    socket.addEventListener('close', () => {
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new PlatformError(`验证窗口已关闭（${request.method}），请重新打开`)); } pending.clear();
    });
    const { targetId } = await command('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await command('Target.attachToTarget', { targetId, flatten: true });
    await command('Page.enable', {}, sessionId);
    const validCookies = cookies.filter((c) => (c.expires === null || c.expires > Date.now()) && (c.domain === 'chaoxing.com' || c.domain.endsWith('.chaoxing.com')));
    if (validCookies.length) await command('Network.setCookies', { cookies: validCookies.map((c) => ({ name: c.name, value: c.value, path: c.path, secure: c.secure,
      ...(c.hostOnly ? { url: `https://${c.domain}${c.path}` } : { domain: '.' + c.domain }), ...(c.expires !== null ? { expires: c.expires / 1000 } : {}) })) }, sessionId);
    async function read(input) {
      const url = allowedUrl(input);
      if (url.hostname !== 'mooc1.chaoxing.com') throw new PlatformError('验证浏览器仅用于读取课程作业页面');
      const nav = await command('Page.navigate', { url: url.href }, sessionId);
      if (nav.errorText) throw new PlatformError('Edge 无法打开学习通，请检查网络或完成校园网认证');
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline) {
        await pause(250);
        let result;
        try { result = await command('Runtime.evaluate', { expression: '({ready:document.readyState,url:location.href,html:document.documentElement.outerHTML})', returnByValue: true }, sessionId); } catch (error) { if (!error.transient) throw error; continue; }
        const page = result.result?.value;
        if (!page || page.url === 'about:blank' || (page.ready !== 'complete' && !(page.ready === 'interactive' && /workEnc|goTask\s*\(|暂无作业|没有作业|processVerifyPng\.ac/.test(page.html)))) continue;
        allowedUrl(page.url);
        const jar = await command('Network.getAllCookies', {}, sessionId);
        const freshCookies = jar.cookies.filter((c) => c.domain.replace(/^\./, '') === 'chaoxing.com' || c.domain.endsWith('.chaoxing.com')).map((c) => ({ name: c.name, value: c.value, domain: c.domain.replace(/^\./, ''), hostOnly: !c.domain.startsWith('.'), path: c.path, secure: c.secure, expires: c.expires > 0 ? c.expires * 1000 : null }));
        return { text: page.html, url: page.url, cookies: freshCookies };
      }
      throw new PlatformError('学习通页面加载超时，请检查验证窗口后重试');
    }
    return { read, close, get alive() { return !closed && socket.readyState === WebSocket.OPEN; } };
  } catch (error) { await close(); throw error; }
}
