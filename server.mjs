import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateEvent, SOURCES, cleanItem, itemKind } from './shared/events.mjs';
import { presentItems, autoPromoteChatTasks } from './shared/chat-triage.mjs';
import { runtimeConfig, isLocalRequest } from './shared/runtime.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const publicRoot = join(root, 'public');
const dataRoot = process.env.STUDENT_INBOX_DATA_DIR || join(process.env.LOCALAPPDATA || join(root, 'data'), 'StudentInbox');
const dataFile = join(dataRoot, 'inbox.json');
const { port, host, cloudMode } = runtimeConfig();
const sessionSeconds = 30 * 86400;
const cookieName = 'student_inbox_session';
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml' };
const pairAttempts = new Map();
await mkdir(dataRoot, { recursive: true });

async function readSecret(name, bytes) {
  const path = join(dataRoot, name);
  try {
    const value = (await readFile(path, 'utf8')).trim();
    if (value.length < 16) throw new Error(`${name} is invalid`);
    return value;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const value = randomBytes(bytes).toString('base64url');
    await writeFile(path, value, { mode: 0o600, flag: 'wx' });
    return value;
  }
}

const accessCode = await readSecret('access.token', 18);
const collectorKey = await readSecret('collector.key', 32);
let store = { version: 2, items: [], sources: {}, collector: null, sessions: [] };
try {
  const data = JSON.parse(await readFile(dataFile, 'utf8'));
  if (!Array.isArray(data.items)) throw new Error('Invalid inbox data; refusing to overwrite it');
  store = { ...store, ...data, version: 2 };
} catch (error) { if (error.code !== 'ENOENT') throw error; }
for (const item of store.items) {
  item.kind = itemKind(item);
  if (item.source === 'chaoxing' && String(item.externalId).includes(':notice:') && !item.timestampKind) {
    item.timestampKind = 'collected'; item.publishedAt = null;
    item.body = item.body?.replace(/\n本条时间为首次采集时间。$/, '') || '';
  }
}
let mutationQueue = Promise.resolve();
let localAccounts = null;
let chatAccounts = null;

function canManageAccounts(req) {
  return Boolean(!cloudMode && localAccounts && isLocalRequest(req));
}

// Serialize the whole mutation so a failed disk write cannot change live state.
function transaction(change) {
  const operation = mutationQueue.then(async () => {
    const draft = structuredClone(store);
    const result = change(draft);
    await writeFile(dataFile + '.tmp', JSON.stringify(draft, null, 2), { mode: 0o600 });
    await rename(dataFile + '.tmp', dataFile);
    store = draft;
    return result;
  });
  mutationQueue = operation.catch(() => {});
  return operation;
}

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw Object.assign(new Error('request too large'), { status: 413 });
    chunks.push(chunk);
  }
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw Object.assign(new Error('invalid request'), { status: 400 });
  return data;
}

function equals(a, b) {
  const x = Buffer.from(a || '');
  const y = Buffer.from(b || '');
  return x.length === y.length && timingSafeEqual(x, y);
}
const digest = (value) => createHash('sha256').update(value).digest('hex');
function authorizedCollector(req) { return equals((req.headers.authorization || '').replace(/^Bearer\s+/i, ''), collectorKey); }
function session(req) {
  const raw = (req.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(cookieName + '='));
  const value = raw?.slice(cookieName.length + 1) || '';
  if (!value) return null;
  const hash = digest(value);
  return store.sessions.find((entry) => entry.hash === hash && entry.expiresAt > Date.now());
}

function cookie(res, value, maxAge = sessionSeconds) {
  res.setHeader('Set-Cookie', `${cookieName}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${cloudMode ? '; Secure' : ''}`);
}

function sourceView() {
  const now = Date.now();
  const collectorOnline = Boolean(store.collector?.lastSeen && now - Date.parse(store.collector.lastSeen) < 90_000);
  const sources = Object.fromEntries(Object.entries(store.sources).map(([key, source]) => {
    const fresh = source.lastSeen && now - Date.parse(source.lastSeen) < 90_000;
    return [key, { ...source, status: source.status === 'connected' && (!collectorOnline || !fresh) ? 'offline' : source.status }];
  }));
  const local = localAccounts?.view();
  if (local?.configured || local?.status === 'needs_login' || local?.status === 'error') sources.chaoxing = { status: local.status, message: local.message, lastSync: local.lastSync || null, loginState: local.loginState, syncStatus: local.operation.status, operationId: local.operation.id, busy: local.busy };
  Object.assign(sources, chatAccounts?.sources() || {});
  return { sources, collector: store.collector ? { ...store.collector, online: collectorOnline } : null, localCollection: Boolean(local?.configured || Object.values(chatAccounts?.sources() || {}).some((s) => s.enabled)) };
}

function limited(req) {
  const ip = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  for (const [key, attempts] of pairAttempts) if (!attempts.some((time) => now - time < 60_000)) pairAttempts.delete(key);
  const attempts = (pairAttempts.get(ip) || []).filter((time) => now - time < 60_000);
  if (attempts.length >= 5) return true;
  attempts.push(now);
  pairAttempts.set(ip, attempts);
  return false;
}

function ingest(draft, payload) {
  if (!Array.isArray(payload.events) || payload.events.length > 50) throw Object.assign(new Error('events must be an array of at most 50 entries'), { status: 400 });
  const events = payload.events.map(validateEvent);
  const accepted = [];
  for (const event of events) {
    const existing = draft.items.find((item) => item.source === event.source && item.externalId === event.externalId);
    if (!existing) draft.items.unshift({ ...event, id: randomBytes(10).toString('hex'), receivedAt: new Date().toISOString(), read: false, done: false, archived: false });
    else if (event.publishedAt) {
      // Correct source timestamps without touching the user's edits/completion.
      existing.publishedAt = event.publishedAt; existing.createdAt = event.publishedAt; existing.timestampKind = 'published';
    }
    // A retry must not undo the user's completion state or corrections.
    accepted.push(event.externalId);
  }
  autoPromoteChatTasks(draft.items);
  return { accepted };
}

async function api(req, res, path) {
  if (path === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true });
  if (path === '/api/pair' && req.method === 'POST') {
    if (limited(req)) return json(res, 429, { error: '尝试过于频繁，请一分钟后再试' });
    const payload = await body(req);
    if (!equals(String(payload.code || ''), accessCode)) return json(res, 401, { error: '访问码不正确' });
    const value = randomBytes(32).toString('base64url');
    await transaction((draft) => {
      draft.sessions = draft.sessions.filter((entry) => entry.expiresAt > Date.now()).slice(-49);
      draft.sessions.push({ hash: digest(value), expiresAt: Date.now() + sessionSeconds * 1000 });
    });
    cookie(res, value);
    return json(res, 200, { ok: true });
  }
  if (path.startsWith('/api/collector/')) {
    if (!authorizedCollector(req)) return json(res, 401, { error: 'invalid collector key' });
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
    const payload = await body(req);
    if (path === '/api/collector/events') return json(res, 200, await transaction((draft) => ingest(draft, payload)));
    if (path === '/api/collector/heartbeat') {
      const now = new Date().toISOString();
      const reports = payload.sources || {};
      if (!reports || typeof reports !== 'object' || Array.isArray(reports)) throw Object.assign(new Error('invalid sources'), { status: 400 });
      const sources = {};
      for (const [key, report] of Object.entries(reports)) {
        if (!SOURCES.includes(key) || key === 'manual' || !report || !['connected', 'partial', 'needs_login', 'error', 'not_configured', 'offline'].includes(report.status)) throw Object.assign(new Error('invalid source report'), { status: 400 });
        sources[key] = { status: report.status, lastSeen: now, message: String(report.message || '').slice(0, 240), lastSync: typeof report.lastSync === 'string' && Number.isFinite(Date.parse(report.lastSync)) ? new Date(report.lastSync).toISOString() : null };
      }
      const queued = Number.isSafeInteger(payload.queued) && payload.queued >= 0 ? payload.queued : 0;
      await transaction((draft) => {
        draft.collector = { name: String(payload.name || 'Windows 采集端').slice(0, 60), lastSeen: now, queued };
        draft.sources = sources;
      });
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'not found' });
  }
  const currentSession = session(req);
  if (!currentSession) return json(res, 401, { error: '请先输入访问码' });
  if (path === '/api/logout' && req.method === 'POST') {
    await transaction((draft) => { draft.sessions = draft.sessions.filter((entry) => entry.hash !== currentSession.hash); });
    cookie(res, '', 0);
    return json(res, 200, { ok: true });
  }
  if (path === '/api/state' && req.method === 'GET') return json(res, 200, { items: presentItems(store.items), ...sourceView(), updatedAt: new Date().toISOString(), mode: cloudMode ? 'cloud' : 'local', remindersEnabled: false, localAccountsEnabled: canManageAccounts(req) });
  if (path.startsWith('/api/accounts/')) {
    if (!canManageAccounts(req)) return json(res, 403, { error: '请在 Windows 电脑上打开 http://localhost:4317 管理账号；云端及局域网入口不接收平台密码' });
    const chat = path.match(/^\/api\/accounts\/(qq|wechat)(?:\/(qr|qr\.png|groups|selection|check|history|initialize|acknowledge))?$/);
    if (chat && chatAccounts) {
      const [, source, action] = chat;
      if (req.method === 'GET' && !action) return json(res, 200, chatAccounts.view(source));
      if (req.method === 'GET' && action === 'qr.png') { const image = chatAccounts.image(source); res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store', 'content-length': image.length }); return res.end(image); }
      if (req.method === 'GET' && action === 'groups') return json(res, 200, await chatAccounts.groups(source));
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: '需要 JSON 请求' });
      if (req.method === 'POST' && action === 'qr') { const input = await body(req); return json(res, 202, chatAccounts.connect(source, input)); }
      if (req.method === 'PUT' && action === 'selection') return json(res, 200, await chatAccounts.selection(source, await body(req)));
      if (req.method === 'POST' && action === 'check') { await body(req); return json(res, 200, await chatAccounts.check(source)); }
      if (req.method === 'POST' && action === 'history') { await body(req); return json(res, 202, await chatAccounts.history(source)); }
      if (req.method === 'POST' && action === 'initialize') { const input = await body(req); return json(res, 202, chatAccounts.initialize(source, input)); }
      if (req.method === 'POST' && action === 'acknowledge') { await body(req); return json(res, 200, await chatAccounts.acknowledge(source)); }
      if (req.method === 'PUT' && action === 'groups') return json(res, 200, await chatAccounts.configure(source, await body(req)));
      if (req.method === 'DELETE' && !action) { await body(req); return json(res, 200, await chatAccounts.disconnect(source)); }
      return json(res, 405, { error: 'method not allowed' });
    }
    if (!['/api/accounts/chaoxing', '/api/accounts/chaoxing/sync', '/api/accounts/chaoxing/verification'].includes(path)) return json(res, 404, { error: '该平台尚未实现账号连接' });
    if (req.method === 'GET' && path === '/api/accounts/chaoxing') return json(res, 200, localAccounts.view());
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: '需要 JSON 请求' });
    if (req.method === 'POST' && path === '/api/accounts/chaoxing') return json(res, 200, await localAccounts.connect(await body(req)));
    if (req.method === 'DELETE' && path === '/api/accounts/chaoxing') { await localAccounts.disconnect(); return json(res, 200, localAccounts.view()); }
    if (req.method === 'POST' && path === '/api/accounts/chaoxing/verification') { await body(req); return json(res, 200, await localAccounts.openVerification()); }
    if (req.method === 'POST' && path === '/api/accounts/chaoxing/sync') {
      if (!localAccounts.view().configured) return json(res, 409, { error: '请先连接学习通账号' });
      void localAccounts.sync(); return json(res, 202, localAccounts.view());
    }
    return json(res, 405, { error: 'method not allowed' });
  }
  if (path === '/api/items' && req.method === 'POST') {
    const input = cleanItem(await body(req));
    input.kind = 'task';
    const item = { ...input, id: randomBytes(10).toString('hex'), createdAt: new Date().toISOString(), read: false, done: false, archived: false };
    await transaction((draft) => draft.items.unshift(item));
    return json(res, 201, item);
  }
  if (path === '/api/items/archive' && req.method === 'POST') {
    const input = await body(req);
    if (!Array.isArray(input.ids) || !input.ids.length || input.ids.length > 10_000 || input.ids.some(id => typeof id !== 'string' || !/^[a-f0-9]{1,64}$/.test(id)) || typeof input.archived !== 'boolean') {
      return json(res, 400, { error: '请选择 1—10000 条记录，并指定归档或恢复操作' });
    }
    const ids = [...new Set(input.ids)];
    const result = await transaction((draft) => {
      const byId = new Map(draft.items.map(item => [item.id, item]));
      if (ids.some(id => !byId.has(id))) throw Object.assign(new Error('部分记录已不存在，请刷新后重新选择；本次未修改任何记录'), { status: 404 });
      for (const id of ids) byId.get(id).archived = input.archived;
      return { ok: true, ids, count: ids.length, archived: input.archived };
    });
    return json(res, 200, result);
  }
  const match = path.match(/^\/api\/items\/([a-f0-9]+)$/);
  if (match && ['PATCH', 'DELETE'].includes(req.method)) {
    const patch = req.method === 'PATCH' ? await body(req) : null;
    const result = await transaction((draft) => {
      const item = draft.items.find((entry) => entry.id === match[1]);
      if (!item) return false;
      if (!patch) draft.items = draft.items.filter((entry) => entry.id !== item.id);
      else {
        if ('triageDecision' in patch) {
          if (patch.triageDecision !== 'dismissed' && patch.triageDecision !== null) throw Object.assign(new Error('待办判断不正确'), { status: 400 });
          item.triageDecision = patch.triageDecision;
          if (patch.triageDecision === 'dismissed' && item.autoTask) {
            item.kind = 'notification';
            delete item.autoTask;
          }
        }
        for (const key of ['read', 'done', 'archived']) if (typeof patch[key] === 'boolean') item[key] = patch[key];
        if (patch.confirmed === true) item.confidence = 'high';
        if ('due' in patch || 'category' in patch || 'title' in patch || 'body' in patch || 'kind' in patch) {
          const next = cleanItem({ ...item, ...patch });
          for (const key of ['due', 'category', 'title', 'body', 'kind']) item[key] = next[key];
          if ('kind' in patch) {
            delete item.autoTask;
            if (patch.kind === 'task') item.triageDecision = null;
          }
        }
      }
      return true;
    });
    return json(res, result ? 200 : 404, { ok: result });
  }
  return json(res, 404, { error: 'not found' });
}

async function serveStatic(req, res, pathname) {
  if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'method not allowed' });
  const file = resolve(publicRoot, '.' + decodeURIComponent(pathname === '/' ? '/index.html' : pathname).replaceAll('\\', '/'));
  if (!file.startsWith(resolve(publicRoot) + sep)) return json(res, 403, { error: 'forbidden' });
  let info;
  try { info = await stat(file); } catch (error) { if (error.code === 'ENOENT') return json(res, 404, { error: 'not found' }); throw error; }
  if (!info.isFile()) return json(res, 404, { error: 'not found' });
  res.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache', 'content-length': info.size });
  if (req.method === 'HEAD') return res.end();
  const stream = createReadStream(file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

// Re-evaluate the existing review backlog as well as newly collected messages.
await transaction((draft) => autoPromoteChatTasks(draft.items));

if (!cloudMode) {
  const { createAccounts } = await import('./collector/accounts.mjs');
  localAccounts = await createAccounts({ dataDir: join(dataRoot, 'accounts'), deliver: (event) => transaction((draft) => ingest(draft, { events: [event] })) });
  const { createChatAccounts } = await import('./collector/chat-accounts.mjs');
  chatAccounts = await createChatAccounts({ dataDir: join(dataRoot, 'accounts'), courseHints: () => localAccounts?.view().courses || [], deliver: (event) => transaction((draft) => ingest(draft, { events: [event] })) });
}

const app = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
    if (!cloudMode && !isLocalRequest(req)) return json(res, 403, { error: '本地模式仅允许通过这台电脑的 localhost 或回环地址访问' });
    const url = new URL(req.url, 'http://localhost');
    if (cloudMode && req.headers['x-forwarded-proto'] !== 'https') return json(res, 426, { error: '云端模式需要通过 HTTPS 访问' });
    if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin) {
      const expected = `${cloudMode ? 'https' : 'http'}://${req.headers.host}`;
      if (req.headers.origin !== expected) return json(res, 403, { error: 'origin rejected' });
    }
    if (url.pathname.startsWith('/api/')) return await api(req, res, url.pathname);
    return await serveStatic(req, res, url.pathname);
  } catch (error) {
    const inputError = error instanceof SyntaxError || error.name === 'ValidationError';
    if (!inputError && !error.status) console.error('Request failed:', error.message);
    if (!res.headersSent) json(res, error.status || (inputError ? 400 : 500), { error: inputError ? error.message : error.status ? error.message : '保存或读取失败，请稍后重试' });
    else res.destroy();
  }
});
app.requestTimeout = 30_000;
app.headersTimeout = 15_000;
app.listen(port, host, () => {
  console.log(`Student Inbox running at http://${host.includes(':') ? '[' + host + ']' : host}:${app.address().port}`);
  console.log(cloudMode ? '运行模式：云端预留模式（需要 HTTPS 网关）' : '运行模式：仅本机运行，局域网和公网访问已关闭');
  console.log(`Access code: ${accessCode}`);
  console.log(`Collector key file: ${join(dataRoot, 'collector.key')}`);
});
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  if (shuttingDown) return; shuttingDown = true;
  const stopped = new Promise((done) => app.close(done)); app.closeIdleConnections();
  await Promise.allSettled([stopped, localAccounts?.close(), chatAccounts?.close()]); process.exit(0);
});
