import { readFile, writeFile, mkdir, rename, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { NapcatClient, ChatError } from './napcat.mjs';
import { WechatClient } from './wechat.mjs';
import { groupEvent } from './onebot.mjs';
import { classifyMessage, validateEvent } from '../shared/events.mjs';
import { readHistoryPage, historySummary } from './qq-history.mjs';
import { classifyGroup } from '../shared/learning-relevance.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const emptyConfig = () => ({ enabled: false, remember: true, accountId: '', groups: [], snapshots: {}, gaps: {}, history: {} });

// Repeated messages are compared as an ordered suffix, not a set: two identical
// consecutive posts must remain two posts. A missing overlap is a visible gap.
export function snapshotDelta(previous, current) {
  if (!previous) return { added: [], gap: false, baseline: true };
  if (!previous.length) return { added: current, start: 0, gap: false };
  if (!current.length) return { added: [], gap: false };
  for (let count = Math.min(previous.length, current.length); count > 0; count--) {
    const suffix = previous.slice(-count);
    for (let start = 0; start <= current.length - count; start++) {
      if (suffix.every((value, i) => value === current[start + i])) return { added: current.slice(start + count), start: start + count, gap: false };
    }
  }
  return { added: [], gap: true };
}

export async function createChatAccounts({ dataDir, deliver, qqFactory, wechatFactory, pollMs = 4000, autoRestore = true, autoSelectGroups = true, courseHints = () => [] }) {
  await mkdir(dataDir, { recursive: true });
  const file = join(dataDir, 'chats.json'); const outbox = join(dataDir, 'chat-outbox'); await mkdir(outbox, { recursive: true });
  let saved = { qq: emptyConfig(), wechat: emptyConfig() };
  try { const data = JSON.parse(await readFile(file, 'utf8')); for (const key of ['qq', 'wechat']) saved[key] = { ...saved[key], ...data[key] }; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const reports = Object.fromEntries(['qq', 'wechat'].map((source) => [source, { source, status: 'not_configured', loginState: 'disconnected', collectionState: 'stopped', message: '请扫码登录并选择群聊', groups: [], busy: false, qrVersion: 0, qrAvailable: false }]));
  const clients = {}; const images = {}; const operations = {}; let closed = false;
  let writes = Promise.resolve(); let messages = Promise.resolve(); let flushing = Promise.resolve(); let enqueues = Promise.resolve();
  const persist = () => { const data = JSON.stringify(saved); const task = writes.then(async () => { await writeFile(file + '.tmp', data, { mode: 0o600 }); await rename(file + '.tmp', file); }); writes = task.catch(() => {}); return task; };
  function view(source) {
    const r = reports[source]; if (!r) throw new ChatError('未知平台');
    const { qrFingerprint, ...publicReport } = r; const cfg = saved[source];
    const discovery = cfg.discovery;
    const selection = autoSelectGroups ? { mode: 'auto', groups: (discovery?.groups || []).map((g) => ({ ...g, decision: discovery.overrides?.[g.id] || 'auto', included: cfg.groups.some((s) => s.id === g.id) })), lastScan: discovery?.lastScan || null, pending: (discovery?.groups || []).filter((g) => g.pending).length, error: discovery?.error || '', included: cfg.groups.length, unknown: (discovery?.groups || []).filter((g) => g.relevance === 'unknown').length } : { mode: 'manual' };
    return { ...publicReport, busy: Boolean(r.busy && (!r.backgroundChecking || r.loginState !== 'authenticated')), selection, errors: [...new Set([...(r.errors || []), ...Object.values(cfg.gaps), ...(discovery?.error ? [discovery.error] : [])])], hasGaps: Object.keys(cfg.gaps).length > 0, history: source === 'qq' || r.mode === 'local_database' ? historySummary(cfg.groups, cfg.history) : null, groups: cfg.groups, enabled: cfg.enabled, remembered: cfg.remember, accountId: cfg.accountId, qrExpiresAt: r.qrExpiresAt || null };
  }
  async function discover(source, c) {
    if (!autoSelectGroups) return;
    const cfg = saved[source];
    const d = cfg.discovery ||= { groups: [], overrides: {}, lastScan: null };
    const courses = courseHints(); const signature = hash(JSON.stringify(['learning-rules-2026-10-15.2', courses]));
    const now = Date.now();
    if (!d.lastScan || now - Date.parse(d.lastScan) >= 600_000 || d.courseSignature !== signature) {
      try {
        let available;
        if (source === 'qq') {
          const result = await c.action('get_group_list');
          if (!Array.isArray(result)) throw new Error('invalid group list');
          available = result.map((g) => ({ id: String(g.group_id), name: String(g.group_name || g.group_id) }));
        } else {
          const result = await c.groups();
          if (!result.readable || !Array.isArray(result.groups)) throw new Error('unreadable');
          available = result.groups;
        }
        d.groups = available.map((g) => {
          const result = classifyGroup(g, { courses });
          const prior = d.groups.find((old) => old.id === g.id && old.name === g.name);
          // Keep positive message evidence while refreshing it in the background.
          return { ...g, ...(result.relevance === 'unknown' && prior?.relevance === 'learning' ? { relevance: prior.relevance, reason: prior.reason } : result), pending: result.relevance === 'unknown' };
        });
        d.lastScan = new Date(now).toISOString(); d.courseSignature = signature; d.error = '';
        const ids = new Set(available.map((g) => g.id));
        for (const id of Object.keys(d.overrides || {})) if (!ids.has(id)) delete d.overrides[id];
      } catch { d.error = '自动识别群聊失败，已保留上次有效采集范围，将自动重试。'; await persist(); return; }
    }
    // One small preview per tick; social groups are never sampled or persisted.
    const next = d.groups.find((g) => g.pending && (!g.retryAt || g.retryAt <= now));
    if (next) {
      try {
        let texts = [];
        if (source === 'qq') {
          const result = await c.action('get_group_msg_history', { group_id: next.id, count: 12, reverse_order: false, disable_get_url: true, parse_mult_msg: false });
          if (!Array.isArray(result?.messages)) throw new Error('invalid history');
          for (const m of result.messages) {
            if (String(m.self_id) !== cfg.accountId || String(m.group_id) !== next.id || m.message_type !== 'group' || !Number.isFinite(m.time)) throw new Error('identity mismatch');
            if (m.time * 1000 < now - 7 * 86400_000 || m.time * 1000 > now + 60_000) continue;
            const event = groupEvent(m, [next.id]); if (event) texts.push(event.body);
          }
        } else if (c.preview) {
          const result = await c.preview([next.id]);
          if (result.errors?.length || !result.readable || result.accountId !== cfg.accountId) throw new Error('preview failed');
          texts = (result.chats || []).find((g) => g.id === next.id)?.messages.map((m) => m.text) || [];
        }
        Object.assign(next, classifyGroup(next, { courses, messages: texts }), { pending: false, checkedAt: new Date(now).toISOString(), error: '' });
      } catch { next.error = '近期消息暂时无法检查，将重试'; next.retryAt = now + 60_000; }
    }
    cfg.groups = d.groups.filter((g) => d.overrides?.[g.id] === 'include' || (d.overrides?.[g.id] !== 'exclude' && g.relevance === 'learning')).map(({ id, name, muted }) => ({ id, name, ...(muted === undefined ? {} : { muted }) }));
    await persist();
  }
  async function selection(source, input = {}) {
    if (!autoSelectGroups) throw new ChatError('自动识别未启用');
    if (operations[source]) await operations[source];
    if (reports[source].loginState !== 'authenticated') throw new ChatError('请先完成登录');
    const d = saved[source].discovery ||= { groups: [], overrides: {}, lastScan: null };
    if (input.id !== undefined) {
      if (!d.groups.some((g) => g.id === input.id) || !['auto', 'include', 'exclude'].includes(input.decision)) throw new ChatError('群聊纠正信息不正确');
      d.overrides ||= {};
      if (input.decision === 'auto') delete d.overrides[input.id]; else d.overrides[input.id] = input.decision;
    }
    if (input.refresh === true) d.lastScan = null;
    if (input.remember !== undefined) {
      if (typeof input.remember !== 'boolean') throw new ChatError('保存选项不正确');
      saved[source].remember = input.remember;
    }
    await persist(); await run(source, () => update(source)); return view(source);
  }
  function flush() { const task = flushing.then(async () => { for (const name of (await readdir(outbox)).filter((n) => /^[a-f0-9]{64}\.json$/.test(n))) { const event = validateEvent(JSON.parse(await readFile(join(outbox, name), 'utf8'))); await deliver(event); await unlink(join(outbox, name)); } }); flushing = task.catch(() => {}); return task; }
  function enqueue(event) {
    // History and the live stream can deliver the same message together. Keep
    // their durable queue writes ordered so neither renames the other's temp file.
    const valid = validateEvent(event);
    const task = enqueues.then(async () => {
      const path = join(outbox, hash(valid.source + ':' + valid.externalId) + '.json');
      await writeFile(path + '.tmp', JSON.stringify(valid), { mode: 0o600 }); await rename(path + '.tmp', path); await flush();
    });
    enqueues = task.catch(() => {}); return task;
  }
  function failed(source, error) { Object.assign(reports[source], { status: 'error', collectionState: 'error', message: error instanceof ChatError ? error.message : '本机保存或采集失败，消息将在下次连接时重试', busy: false }); }
  function dispatchQQ(input) {
    const task = messages.then(async () => {
      if (!saved.qq.enabled || reports.qq.loginState !== 'authenticated' || String(input.self_id) !== saved.qq.accountId) return;
      const event = groupEvent(input, saved.qq.groups.map((g) => g.id)); if (!event) return;
      event.sourceName = 'QQ · ' + (saved.qq.groups.find((g) => g.id === String(input.group_id))?.name || input.group_id);
      await enqueue(event); reports.qq.lastMessageAt = new Date().toISOString();
    }); messages = task.catch((error) => failed('qq', error)); return messages;
  }
  function client(source) {
    if (clients[source]) return clients[source];
    clients[source] = source === 'qq' ? (qqFactory || ((options) => new NapcatClient(options)))({ dataDir: join(dataDir, 'qq'), onEvent: dispatchQQ, onDisconnect: () => { if (!closed && saved.qq.enabled) Object.assign(reports.qq, { status: 'offline', collectionState: 'offline', message: 'QQ 消息通道已断开，正在尝试恢复' }); } }) : (wechatFactory || (() => new WechatClient({ dataDir: join(dataDir, 'wechat') })))();
    return clients[source];
  }
  function setQr(source, image) { images[source] = image; reports[source].qrVersion++; reports[source].qrAvailable = true; reports[source].qrExpiresAt = new Date(Date.now() + 240_000).toISOString(); }
  async function update(source) {
    const c = client(source); const r = reports[source]; const cfg = saved[source];
    if (source === 'qq') {
      const s = await c.loginStatus();
      if (!s.isLogin) {
        Object.assign(r, { loginState: s.qrLoginAccepted ? 'confirming' : 'waiting_scan', status: s.isOffline ? 'offline' : 'needs_login', collectionState: 'stopped', message: s.qrLoginAccepted ? '手机已确认，正在建立 QQ 连接…' : s.isOffline ? 'QQ 已离线，正在等待恢复；如未恢复请重新扫码' : '请使用手机 QQ 扫码，并在手机上确认登录' });
        if (s.qrcodeurl && s.qrcodeurl !== r.qrFingerprint) { try { setQr(source, await c.qrImage()); r.qrFingerprint = s.qrcodeurl; } catch {} }
        return;
      }
      const info = await c.loginInfo(); const id = String(info.uin || '');
      if (!id) throw new ChatError('QQ 已登录但账号信息尚未就绪，请稍候');
      if (cfg.accountId && cfg.accountId !== id) { cfg.groups = []; cfg.snapshots = {}; cfg.gaps = {}; cfg.history = {}; delete cfg.discovery; delete r.lastMessageAt; }
      if (r.loginState !== 'authenticated' || r.collectionState === 'offline') {
        // A completed pass belongs to the previous connection. Recheck the
        // recent window after restarting/reconnecting to catch offline messages.
        for (const [groupId, progress] of Object.entries(cfg.history)) if (['completed', 'available'].includes(progress.status)) delete cfg.history[groupId];
      }
      if (cfg.accountId !== id) { cfg.accountId = id; await persist(); }
      // Mark authenticated before opening the event stream; only this account's
      // whitelisted messages can be accepted while initialization completes.
      Object.assign(r, { loginState: 'authenticated', account: String(info.nick || id), qrAvailable: false }); delete images[source];
      await c.remember(id, cfg.remember); await c.enableEvents();
      await discover(source, c);
      await readHistoryPage({ client: c, accountId: id, groups: cfg.groups, history: cfg.history, deliver: enqueue });
      await persist(); const history = historySummary(cfg.groups, cfg.history);
      Object.assign(r, { status: cfg.groups.length && history.status === 'completed' && !cfg.discovery?.error ? 'connected' : 'partial', collectionState: cfg.groups.length ? 'collecting' : autoSelectGroups ? 'discovering' : 'needs_groups', message: cfg.groups.length ? history.status === 'running' ? `QQ 已连接，正在补读近 7 天历史（${history.completed}/${history.total} 个群结束）` : history.status === 'partial' ? 'QQ 新消息已连接，但部分群历史补读失败，可查看详情并重试' : `正在采集 ${cfg.groups.length} 个${autoSelectGroups ? '学习相关' : '指定'}群的新消息` : autoSelectGroups ? 'QQ 已登录，正在自动识别学习群；暂未确认的群可在识别结果中查看。' : 'QQ 扫码登录成功，请选择需要采集的群聊', lastSync: new Date().toISOString() });
    } else {
      const s = await c.loginStatus();
      const currentId = s.mode === 'local_database' ? s.accountId : hash(s.account || 'unknown').slice(0, 24);
      const changedAccount = Boolean(cfg.accountId && currentId && cfg.accountId !== currentId);
      // Keep the last completed read visible while a routine read is in flight.
      // Login failures and account changes invalidate that result immediately.
      Object.assign(r, { loginState: s.loginState, account: s.account || '', readable: s.readable, mode: s.mode || 'uia', supportsHistory: s.supportsHistory || false });
      if (s.loginState !== 'authenticated' || !s.readable || changedAccount || !r.lastSync) {
        Object.assign(r, { message: s.message, groupStatus: [] });
        if (changedAccount) Object.assign(r, { status: 'partial', collectionState: autoSelectGroups ? 'discovering' : 'needs_groups' });
      }
      if (s.mode === 'local_database') { await updateWechatDatabase(c, s); return; }
      if (s.loginState !== 'authenticated') { Object.assign(r, { status: s.loginState === 'unreadable' ? 'error' : 'needs_login', collectionState: s.loginState === 'unreadable' ? 'unsupported' : 'stopped' }); if (s.loginState !== 'waiting_scan') { r.qrAvailable = false; delete images[source]; } return; }
      r.qrAvailable = false; delete images[source];
      if (!s.readable) { Object.assign(r, { status: 'error', collectionState: 'unsupported', message: '微信已登录，但此版本未开放界面读取，群消息采集不可用。请勿把登录成功当作接入完成。' }); return; }
      const id = hash(s.account || 'unknown').slice(0, 24);
      if (cfg.accountId && cfg.accountId !== id) { cfg.groups = []; cfg.snapshots = {}; cfg.gaps = {}; delete r.lastMessageAt; }
      if (cfg.accountId !== id) { cfg.accountId = id; await persist(); }
      if (!cfg.groups.length) { Object.assign(r, { status: 'partial', collectionState: 'needs_groups', message: '微信已登录，请选择群聊，并在微信中双击该群打开独立聊天窗口' }); return; }
      const result = await c.read(cfg.groups.map((g) => g.id)); const errors = [...(result.errors || [])];
      if (result.loginState !== 'authenticated' || !result.readable) throw new ChatError(result.message || '微信消息读取已中断');
      r.groupStatus = cfg.groups.map((g) => {
        const ready = (result.chats || []).some((chat) => chat.id === g.id);
        if (!ready && !errors.some((e) => e.startsWith(g.id + '：'))) errors.push(g.id + '：未读取到该群窗口，请确认独立聊天窗口已打开且可读取');
        return { id: g.id, name: g.name, ready };
      });
      for (const chat of result.chats || []) {
        if (!cfg.groups.some((g) => g.id === chat.id)) continue;
        const texts = chat.messages.map((m) => hash(m.text)); const previous = cfg.snapshots[chat.id];
        // An emptied accessibility tree is not proof that chat history vanished.
        // Keep the previous anchor so returning old messages are not imported anew.
        if (previous?.texts.length && !texts.length) {
          errors.push(chat.id + '：消息列表暂时为空，已保留上次采集起点，请检查窗口是否可读取');
          r.groupStatus.find((g) => g.id === chat.id).ready = false;
          continue;
        }
        const delta = snapshotDelta(previous?.texts, texts); let sequence = previous?.sequence || 0;
        if (delta.gap) cfg.gaps[chat.id] = chat.id + '：消息窗口内容与上次无法衔接，已重新建立起点；期间消息可能漏读，请在微信核对';
        if (!delta.baseline && !delta.gap) {
          for (const m of chat.messages.slice(delta.start)) {
            const now = new Date().toISOString();
            await enqueue({ source: 'wechat', sourceName: '微信 · ' + chat.id, externalId: `${id}:${hash(chat.id).slice(0, 20)}:${++sequence}`, title: m.text.slice(0, 120), body: m.text, createdAt: now, timestampKind: 'observed', kind: 'notification', ...classifyMessage(m.text) });
            r.lastMessageAt = now;
            // Queue/delivery precedes checkpoint persistence so a failed write is
            // retried with the same external ID after restart.
          }
        }
        cfg.snapshots[chat.id] = { texts, sequence };
      }
      await persist();
      const issues = errors.length + Object.keys(cfg.gaps).length;
      Object.assign(r, { errors, status: issues ? 'partial' : 'connected', collectionState: issues ? 'partial' : 'collecting', lastSync: new Date().toISOString(), message: issues ? `微信已登录，但 ${issues} 处消息读取需要处理或核对` : `正在读取 ${cfg.groups.length} 个已打开的群窗口；首次画面仅建立起点，不导入旧消息` });
    }
  }
  async function updateWechatDatabase(c, state) {
    const r = reports.wechat; const cfg = saved.wechat;
    if (state.loginState !== 'authenticated' || !state.readable) {
      Object.assign(r, { status: ['needs_key', 'unreadable', 'setup_failed'].includes(state.loginState) ? 'error' : 'needs_login', collectionState: state.loginState === 'initializing' ? 'initializing' : 'stopped' });
      if (state.loginState !== 'waiting_scan') { r.qrAvailable = false; delete images.wechat; }
      return;
    }
    const id = state.accountId;
    if (!id) throw new ChatError('微信消息库未返回可核对的账号 ID');
    if (cfg.accountId && cfg.accountId !== id) { cfg.groups = []; cfg.snapshots = {}; cfg.gaps = {}; cfg.history = {}; delete cfg.discovery; delete r.lastMessageAt; }
    cfg.accountId = id; r.qrAvailable = false; delete images.wechat;
    await discover('wechat', c);
    if (!cfg.groups.length) { await persist(); Object.assign(r, { status: 'partial', collectionState: autoSelectGroups ? 'discovering' : 'needs_groups', message: autoSelectGroups ? '微信已连接，正在自动识别学习群；暂未确认的群可在识别结果中查看。' : '本机微信消息库已连接，请勾选需要采集的群；保存后补读近 7 天本机缓存消息。' }); return; }
    const offset = (r.readOffset || 0) % cfg.groups.length;
    const batch = cfg.groups.slice(offset, offset + 12); r.readOffset = offset + batch.length;
    const result = await c.read(batch.map((g) => g.id), Object.fromEntries(batch.map((g) => [g.id, cfg.history[g.id]?.cursors || {}])));
    if (result.loginState !== 'authenticated' || !result.readable) throw new ChatError(result.message || '微信消息库读取已中断');
    const errors = [...(result.errors || [])];
    for (const group of batch) {
      const chat = result.chats?.find((row) => row.id === group.id);
      if (!chat) { errors.push(group.name + '：未读取到所选群，请刷新群列表'); continue; }
      const prior = cfg.history[group.id] || { scanned: 0, kept: 0 };
      // Deliver before saving positions. If delivery fails, stable source IDs
      // make retry safe, including history/live overlap and server restarts.
      for (const message of chat.messages || []) {
        if (!message.id || !message.publishedAt) throw new ChatError('微信返回消息缺少稳定 ID 或原发布时间，未推进采集位置');
        const now = new Date().toISOString();
        await enqueue({ source: 'wechat', sourceName: '微信 · ' + group.name, externalId: `${id}:${group.id}:${message.id}`, title: message.text.slice(0, 120), body: message.text, createdAt: now, publishedAt: message.publishedAt, kind: 'notification', ...classifyMessage(message.text) });
        r.lastMessageAt = now;
      }
      cfg.history[group.id] = { ...prior, cursors: chat.cursors, status: errors.length ? 'partial' : chat.more ? 'running' : 'available', scanned: prior.scanned + chat.messages.length, kept: prior.kept + chat.messages.length, message: chat.more ? '继续读取本机缓存消息…' : '已读完近 7 天本机缓存；电脑未同步的记录无法确认。' };
    }
    await persist(); const summary = historySummary(cfg.groups, cfg.history);
    Object.assign(r, { errors, status: errors.length || cfg.discovery?.error ? 'partial' : 'connected', collectionState: errors.length ? 'partial' : 'collecting', groupStatus: cfg.groups.map((g) => ({ ...g, ready: ['available', 'completed'].includes(cfg.history[g.id]?.status) })), lastSync: new Date().toISOString(), message: errors.length ? '部分本机微信消息读取失败，已保留位置并会自动重试；请查看下方原因。' : summary.status === 'running' ? '正在补读近 7 天本机缓存，同时检查新消息。' : `正在采集 ${cfg.groups.length} 个${autoSelectGroups ? '学习相关' : '指定'}群；免打扰群也可读取。` });
  }
  function run(source, work, { background = false } = {}) {
    if (operations[source]) return operations[source];
    reports[source].busy = true;
    reports[source].backgroundChecking = background;
    const task = Promise.resolve().then(work).catch((error) => failed(source, error)).finally(() => { reports[source].busy = false; reports[source].backgroundChecking = false; reports[source].lastCheckedAt = new Date().toISOString(); delete operations[source]; });
    operations[source] = task; return task;
  }
  function connect(source, { remember = true, refresh = false } = {}) {
    if (typeof remember !== 'boolean') throw new ChatError('保存登录选项不正确');
    if (!reports[source]) throw new ChatError('未知平台');
    if (operations[source]) return view(source);
    const r = reports[source];
    Object.assign(r, { loginState: 'starting', collectionState: 'stopped', status: 'needs_login', message: refresh ? '正在刷新真实登录二维码…' : '正在启动扫码登录…', errors: [], qrAvailable: false }); delete images[source]; delete r.qrFingerprint;
    void run(source, async () => {
      saved[source].enabled = true; saved[source].remember = remember; await persist();
      const c = client(source);
      if (source === 'qq') { await c.start(); if (refresh) { const s = await c.loginStatus(); if (!s.isLogin) await c.refreshQr(); } }
      else { const s = refresh ? await c.refreshQr() : await c.start(); if (s.qrImage) setQr(source, Buffer.from(s.qrImage, 'base64')); }
      await update(source);
    });
    return view(source);
  }
  async function groups(source) {
    if (reports[source].loginState !== 'authenticated') throw new ChatError('请先扫码并在手机上确认登录');
    if (operations[source]) await operations[source];
    if (source === 'qq') { await client(source).enableEvents(); const list = await client(source).action('get_group_list'); return { groups: list.map((g) => ({ id: String(g.group_id), name: String(g.group_name || g.group_id) })), message: '仅采集勾选群。保存后补读近 7 天可获取的历史，并持续接收新消息；平台未提供的历史会明确提示。' }; }
    return client(source).groups();
  }
  async function configure(source, input) {
    if (operations[source]) await operations[source];
    if (reports[source].loginState !== 'authenticated') throw new ChatError('请先完成扫码登录');
    if (!Array.isArray(input.groups) || input.groups.length > 30) throw new ChatError('最多选择 30 个群聊');
    const chosen = input.groups.map((g) => ({ id: String(g.id || '').trim(), name: String(g.name || g.id || '').trim().slice(0, 100) }));
    if (chosen.some((g) => !g.id || g.id.length > 100 || (source === 'qq' && !/^\d+$/.test(g.id))) || new Set(chosen.map((g) => g.id)).size !== chosen.length) throw new ChatError('群聊信息不正确');
    if (source === 'qq') { const available = await groups(source); if (chosen.some((g) => !available.groups.some((a) => a.id === g.id))) throw new ChatError('选中的群已不可用，请刷新群列表'); for (const g of chosen) g.name = available.groups.find((a) => a.id === g.id).name; }
    if (source === 'wechat' && reports.wechat.mode === 'local_database') { const available = await groups(source); if (chosen.some((g) => !available.groups.some((a) => a.id === g.id))) throw new ChatError('选中的微信群已不可用，请刷新群列表'); for (const g of chosen) g.name = available.groups.find((a) => a.id === g.id).name; }
    if (typeof input.remember !== 'boolean') throw new ChatError('保存登录选项不正确');
    saved[source].groups = chosen; saved[source].remember = input.remember;
    if (source === 'qq') for (const key of Object.keys(saved.qq.history)) if (!chosen.some((g) => g.id === key)) delete saved.qq.history[key];
    if (source === 'wechat') for (const records of [saved[source].snapshots, saved[source].gaps, saved[source].history]) for (const key of Object.keys(records)) if (!chosen.some((g) => g.id === key)) delete records[key];
    await persist(); await run(source, () => update(source)); return view(source);
  }
  async function check(source) {
    if (!saved[source]?.enabled) throw new ChatError('请先点击扫码接入');
    // A current poll already performs the same work; do not start a second
    // complete pass after waiting for it, doubling the user's response time.
    if (operations[source]) await operations[source];
    else await run(source, async () => { await flush(); await update(source); });
    const result = view(source);
    reports[source].checkResult = { status: result.status === 'connected' ? 'succeeded' : result.status === 'partial' ? 'partial' : 'failed', finishedAt: new Date().toISOString(), message: result.message || '当前采集未就绪，请查看连接状态' };
    return view(source);
  }
  async function history(source) {
    if (source === 'wechat' && reports.wechat.mode === 'local_database') {
      if (operations[source]) await operations[source];
      if (reports.wechat.loginState !== 'authenticated' || !saved.wechat.groups.length) throw new ChatError('请先连接微信并保存需要采集的群');
      saved.wechat.history = {}; await persist(); await run(source, () => update(source)); return view(source);
    }
    if (source !== 'qq') throw new ChatError('当前微信界面读取方式不支持按日期补读历史');
    if (operations[source]) await operations[source];
    if (reports.qq.loginState !== 'authenticated' || !saved.qq.groups.length) throw new ChatError('请先登录并保存需要采集的群');
    for (const [id, state] of Object.entries(saved.qq.history)) {
      if (state.status === 'partial') { state.status = 'running'; state.pages = 0; }
      else delete saved.qq.history[id];
    }
    await persist(); return view('qq');
  }
  function initialize(source, { remember = true } = {}) {
    if (source !== 'wechat') throw new ChatError('此平台不需要初始化本机读取');
    if (typeof remember !== 'boolean') throw new ChatError('保存登录选项不正确');
    if (operations[source]) return view(source);
    saved.wechat.enabled = true; saved.wechat.remember = remember;
    Object.assign(reports.wechat, { loginState: 'initializing', status: 'needs_login', collectionState: 'initializing', message: '正在初始化本机微信消息读取，电脑微信将重启一次。', qrAvailable: false });
    void run(source, async () => { await persist(); await client(source).initialize(); await update(source); });
    return view(source);
  }
  async function acknowledge(source) {
    if (source !== 'wechat') throw new ChatError('该平台没有待核对的窗口漏读提醒');
    if (operations[source]) await operations[source];
    saved[source].gaps = {}; await persist();
    return check(source);
  }
  async function disconnect(source) {
    if (operations[source]) await operations[source];
    saved[source].enabled = false; saved[source].remember = false; saved[source].groups = []; saved[source].snapshots = {}; saved[source].gaps = {}; saved[source].history = {}; delete saved[source].discovery; await persist();
    if (source === 'qq' && clients[source]) { try { await clients[source].remember('', false); } catch {} }
    await clients[source]?.close(); delete clients[source]; delete images[source];
    Object.assign(reports[source], { status: 'not_configured', loginState: 'disconnected', collectionState: 'stopped', message: '已停止本软件采集及自动连接；官方客户端保存的登录请在客户端中管理', qrAvailable: false, errors: [], groupStatus: [] }); return view(source);
  }
  const timer = setInterval(() => { if (closed) return; for (const source of ['qq', 'wechat']) if (saved[source].enabled && clients[source] && !operations[source]) void run(source, async () => { await flush(); await update(source); }, { background: true }); }, pollMs); timer.unref();
  await flush().catch(() => {});
  if (autoRestore) for (const source of ['qq', 'wechat']) if (saved[source].enabled && saved[source].remember) {
    // Restoring collection must never open or foreground the official WeChat
    // client. Only an explicit QR action may invoke its interactive login UI.
    if (source === 'wechat') void run(source, () => update(source));
    else connect(source, { remember: true });
  }
  return {
    view, connect, groups, configure, selection, check, history, initialize, acknowledge, disconnect,
    sources: () => Object.fromEntries(['qq', 'wechat'].filter((s) => saved[s].enabled || reports[s].loginState !== 'disconnected').map((s) => { const { qrFingerprint, ...r } = view(s); return [s, r]; })),
    image: (source) => { const r = reports[source]; if (!images[source] || r.loginState === 'authenticated' || Date.parse(r.qrExpiresAt) <= Date.now()) throw new ChatError('二维码已失效，请刷新'); return images[source]; },
    tick: async (source) => run(source, () => update(source)),
    async close() { closed = true; clearInterval(timer); await Promise.allSettled(Object.values(operations)); await messages; await Promise.allSettled(Object.values(clients).map((c) => c.close())); await writes; }
  };
}
