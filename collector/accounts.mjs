import { readFile, writeFile, mkdir, rename, readdir, unlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { ChaoxingClient, PlatformError, accountHash } from './chaoxing.mjs';
import { windowsVault } from './windows-vault.mjs';
import { validateEvent } from '../shared/events.mjs';

export async function createAccounts({ dataDir, deliver, clientFactory = (options) => new ChaoxingClient(options), vault = windowsVault }) {
  await mkdir(dataDir, { recursive: true });
  const vaultFile = join(dataDir, 'chaoxing.dpapi');
  const outbox = join(dataDir, 'chaoxing-outbox'); await mkdir(outbox, { recursive: true });
  let credentials = null; let client = null; let remembered = false; let busy = false; let syncing = null;
  let report = { status: 'not_configured', message: '请连接学习通账号' }; let courses = []; let warnings = [];
  let loginState = 'disconnected';
  let operation = { id: null, status: 'idle', message: '尚未同步', stats: null };
  const safeError = (error) => error instanceof PlatformError ? error.message : '本机保存或同步失败，请重试；已采集的事项保留在队列中';
  async function persist() {
    if (!remembered) return;
    const sealed = await vault('protect', JSON.stringify({ ...credentials, cookies: client.jar.cookies }));
    const temporary = vaultFile + '.' + randomBytes(4).toString('hex') + '.tmp';
    await writeFile(temporary, sealed, { mode: 0o600 }); await rename(temporary, vaultFile);
  }
  async function flush() {
    for (const name of (await readdir(outbox)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).sort()) {
      const event = validateEvent(JSON.parse(await readFile(join(outbox, name), 'utf8')));
      await deliver(event); await unlink(join(outbox, name));
    }
  }
  async function enqueue(event) {
    const valid = validateEvent(event); const id = createHash('sha256').update(valid.source + '\0' + valid.externalId).digest('hex');
    const path = join(outbox, id + '.json');
    // Do not replace a queued first-seen event with a later polling timestamp.
    try { await readFile(path); return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temp = path + '.tmp'; await writeFile(temp, JSON.stringify(valid), { mode: 0o600 }); await rename(temp, path);
  }
  async function runSync() {
    if (client) operation = { id: randomBytes(8).toString('hex'), status: 'running', startedAt: new Date().toISOString(), finishedAt: null, message: '正在读取课程、作业和近 7 天通知…', stats: null };
    try {
      await flush();
      if (!client) return;
      let result;
      try { result = await client.collect(accountHash(credentials.phone), enqueue); }
      catch (error) {
        if (error.code !== 'needs_login' || report.status === 'needs_login') throw error;
        await client.login(credentials.phone, credentials.password);
        result = await client.collect(accountHash(credentials.phone), enqueue);
      }
      courses = result.courses; warnings = result.warnings.slice(0, 200);
      await persist(); await flush();
      loginState = 'authenticated';
      const stats = result.stats || { coursesTotal: courses.length, coursesRead: 0, tasksRead: 0, noticesRead: result.count, noticesDays: 7 };
      const status = stats.verificationRequired ? 'verification_required' : warnings.length ? 'partial' : 'succeeded';
      const message = stats.verificationRequired ? `通知读取 ${stats.noticesRead} 条；作业被安全验证码阻止，已读取 ${stats.coursesRead}/${stats.coursesTotal} 门课程` : `${stats.tasksRead} 项未交作业，${stats.noticesRead} 条近期通知；已读取 ${stats.coursesRead}/${stats.coursesTotal} 门课程的作业${warnings.length ? '，部分内容未读取成功' : ''}`;
      operation = { ...operation, status, finishedAt: new Date().toISOString(), stats, message };
      report = { status: status === 'succeeded' ? 'connected' : 'partial', lastSync: operation.finishedAt, message };
    } catch (error) {
      // Still deliver already-read items even if another course loses its session.
      try { await flush(); } catch {}
      if (error.code === 'needs_login') loginState = 'expired';
      operation = { ...operation, status: error.code === 'needs_verification' ? 'verification_required' : 'failed', finishedAt: new Date().toISOString(), message: safeError(error) };
      report = { ...report, status: error.code === 'needs_login' ? 'needs_login' : 'error', message: safeError(error) };
    }
  }
  function sync() {
    if (busy) return syncing;
    busy = true; syncing = runSync().finally(() => { busy = false; }); return syncing;
  }
  async function connect(input) {
    if (busy) throw Object.assign(new Error('正在同步，请稍后再试'), { status: 409 });
    const phone = String(input.phone || '').trim(); const password = String(input.password || '');
    if (!/^\d{11}$/.test(phone) || !password || password.length > 256) throw Object.assign(new Error('请填写 11 位手机号及有效的学习通密码'), { status: 400 });
    busy = true;
    try {
      const candidate = clientFactory({}); await candidate.login(phone, password);
      const nextRemembered = input.remember === true;
      // Verify persistence before replacing the active connection.
      if (nextRemembered) {
        const encrypted = await vault('protect', JSON.stringify({ phone, password, cookies: candidate.jar.cookies }));
        await writeFile(vaultFile + '.tmp', encrypted, { mode: 0o600 }); await rename(vaultFile + '.tmp', vaultFile);
      } else await rm(vaultFile, { force: true });
      await client?.close?.();
      credentials = { phone, password }; client = candidate; remembered = nextRemembered; courses = []; warnings = [];
      loginState = 'authenticated';
      report = { status: 'connected', message: '登录成功，正在读取课程和事项' };
    } catch (error) {
      if (!client) report = { status: error.code === 'needs_login' ? 'needs_login' : 'error', message: safeError(error) };
      throw Object.assign(new Error(error instanceof PlatformError ? error.message : error.message?.startsWith('保存账号') || error.message?.startsWith('无法') ? error.message : safeError(error)), { status: 422 });
    } finally { busy = false; }
    void sync(); return view();
  }
  async function disconnect() {
    if (busy) throw Object.assign(new Error('正在同步，请等待完成后再断开'), { status: 409 });
    await rm(vaultFile, { force: true });
    await client?.close?.();
    credentials = null; client = null; remembered = false; courses = []; warnings = [];
    loginState = 'disconnected'; operation = { id: null, status: 'idle', message: '尚未同步', stats: null };
    report = { status: 'not_configured', message: '已断开并删除本机保存的账号；已采集事项保留' };
  }
  async function openVerification() {
    if (!client || !(client.verificationUrl || client.courseUrl)) throw Object.assign(new Error('尚未取得课程入口，请先同步'), { status: 409 });
    if (busy) throw Object.assign(new Error('正在同步，请等待结束再打开验证窗口'), { status: 409 });
    busy = true;
    try {
      const message = await client.openVerification(dataDir);
      await persist();
      return { ...view(), busy: false, verificationMessage: message };
    } catch (error) { throw Object.assign(new Error(safeError(error)), { status: 422 }); }
    finally { busy = false; }
  }
  function view() { return { ...report, loginState, operation, configured: Boolean(client), busy, remembered, browserAvailable: Boolean(client?.courseUrl), verificationAvailable: Boolean(client?.verificationUrl), verificationWindowOpen: Boolean(client?.browser?.alive), account: credentials ? credentials.phone.slice(0, 3) + '****' + credentials.phone.slice(-4) : '', courses, warnings, canRemember: process.platform === 'win32' }; }
  try {
    const encrypted = await readFile(vaultFile, 'utf8');
    const saved = JSON.parse(await vault('unprotect', encrypted));
    if (!/^\d{11}$/.test(saved.phone) || !saved.password || !Array.isArray(saved.cookies)) throw new Error('invalid vault');
    credentials = { phone: saved.phone, password: saved.password }; client = clientFactory({ cookies: saved.cookies }); remembered = true;
    loginState = 'checking';
    report = { status: 'offline', message: '已加载本机保存的账号，正在检查登录状态' };
  } catch (error) { if (error.code !== 'ENOENT') report = { status: 'needs_login', message: '无法读取本机加密账号，请重新登录后保存' }; }
  // Flush a previous crash's queue even if no account is remembered.
  void sync();
  const timer = setInterval(() => { if (client && report.status !== 'needs_login' && operation.status !== 'verification_required') void sync(); }, 5 * 60_000); timer.unref();
  return { view, sync, connect, disconnect, openVerification, close: () => { clearInterval(timer); return client?.close?.(); } };
}
