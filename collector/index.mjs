import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, readdir, rename, unlink } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorker } from './worker.mjs';
import { verifySignature, groupEvent } from './onebot.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const configFile = resolve(process.env.STUDENT_INBOX_COLLECTOR_CONFIG || join(projectRoot, 'collector.config.json'));
let config = {};
try { config = JSON.parse(await readFile(configFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const configDir = dirname(configFile);
const dataDir = resolve(configDir, process.env.STUDENT_INBOX_COLLECTOR_DATA_DIR || config.dataDir || 'collector-data');
const serverUrl = process.env.STUDENT_INBOX_SERVER_URL || config.serverUrl || 'http://localhost:4317';
const keyPath = process.env.STUDENT_INBOX_COLLECTOR_KEY_FILE || config.keyFile;
const key = process.env.STUDENT_INBOX_COLLECTOR_KEY || (keyPath ? (await readFile(resolve(configDir, keyPath), 'utf8')).trim() : '');
const worker = await createWorker({ serverUrl, key, dataDir, name: config.name });
await mkdir(dataDir, { recursive: true });
const webhookQueue = join(dataDir, 'qq-webhook');
const webhookRejected = join(dataDir, 'rejected-qq');
await mkdir(webhookQueue, { recursive: true });
await mkdir(webhookRejected, { recursive: true });
const qq = config.qq || {};
const groups = Array.isArray(qq.groups) ? qq.groups.map(String) : [];
let qqSeen = 0;
let qqOnline = false;
let qqLastMessage = null;
let qqRejected = 0;
qqRejected = (await readdir(webhookRejected)).length;
let stopped = false;

function reports() {
  if (!qq.secret || !groups.length) return {};
  return { qq: { status: qqRejected ? 'error' : Date.now() - qqSeen < 90_000 && qqOnline ? 'connected' : 'offline', lastSync: qqLastMessage,
    message: qqRejected ? `${qqRejected} 条 QQ 原始事件格式异常，已保存在本机 rejected-qq` : qqSeen ? (qqOnline ? '已收到 OneBot 心跳；静音群和历史补齐尚待实测' : 'QQ 上报离线状态') : '等待 OneBot 心跳，尚未验证登录状态' } };
}

async function drainQQWebhook() {
  for (const file of (await readdir(webhookQueue)).filter((name) => name.endsWith('.json')).sort().slice(0, 100)) {
    const path = join(webhookQueue, file);
    try {
      const event = JSON.parse(await readFile(path, 'utf8'));
      const message = groupEvent(event, groups);
      if (message) { await worker.enqueue(message); qqLastMessage = message.createdAt; }
      await unlink(path);
    } catch (error) {
      if (error.code) throw error;
      await rename(path, join(webhookRejected, Date.now() + '-' + file));
      qqRejected = (await readdir(webhookRejected)).length;
      console.error(`QQ 原始事件无法转换，已保存在 rejected-qq：${file}`);
    }
  }
}

async function cycle() {
  await worker.importFiles();
  if (qq.secret && groups.length) await drainQQWebhook();
  // Send heartbeat before a possibly large queue, and again after it drains.
  const webhookQueueCount = (await readdir(webhookQueue)).filter((file) => file.endsWith('.json')).length;
  await worker.heartbeat(reports(), webhookQueueCount);
  const queued = await worker.flush();
  await worker.heartbeat(reports(), webhookQueueCount);
  console.log(`同步完成，剩余 ${queued} 条待上传`);
}

if (process.argv.includes('--once')) {
  await cycle();
} else {
  const bridge = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/onebot') { res.writeHead(404); return res.end(); }
    if (!qq.secret || !groups.length) { res.writeHead(503); return res.end('QQ not configured'); }
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 128_000) { res.writeHead(413); return res.end(); } chunks.push(chunk); }
      const raw = Buffer.concat(chunks);
      if (!verifySignature(raw, req.headers['x-signature'], qq.secret)) { res.writeHead(401); return res.end(); }
      const event = JSON.parse(raw.toString('utf8'));
      if (event.post_type === 'meta_event' && event.meta_event_type === 'heartbeat' && typeof event.status?.online === 'boolean') {
        qqSeen = Date.now();
        qqOnline = event.status.online && event.status.good !== false;
        res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}');
      }
      if (event.post_type === 'message' && event.message_type === 'group' && groups.includes(String(event.group_id))) {
        if (event.message_id == null || !event.self_id || !Number.isFinite(event.time)) throw new Error('群事件缺少消息 ID 或发送时间');
        const id = createHash('sha256').update(String(event.self_id) + ':' + event.group_id + ':' + event.message_id).digest('hex');
        const path = join(webhookQueue, id + '.json');
        try { await readFile(path); }
        catch (error) {
          if (error.code !== 'ENOENT') throw error;
          const tmp = join(webhookQueue, id + '.' + randomBytes(5).toString('hex') + '.tmp');
          await writeFile(tmp, raw, { mode: 0o600 });
          try { await rename(tmp, path); } catch (renameError) { await unlink(tmp).catch(() => {}); if (renameError.code !== 'EEXIST') throw renameError; }
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
    } catch (error) {
      console.error(`QQ 事件未保存：${error.message}`);
      res.writeHead(error.code ? 500 : 400); res.end();
    }
  });
  bridge.requestTimeout = 15_000;
  bridge.headersTimeout = 10_000;
  bridge.listen(qq.port || 4318, '127.0.0.1', () => console.log(`采集端已启动；QQ 上报入口 http://127.0.0.1:${bridge.address().port}/onebot`));
  let retry = 5000;
  let timer;
  async function tick() {
    try { await cycle(); retry = 5000; }
    catch (error) { console.error(`${error.message}；事项保留在本地，稍后重试`); retry = Math.min(retry * 2, 60_000); }
    if (!stopped) timer = setTimeout(tick, retry);
  }
  console.log(`事项服务：${serverUrl}\n手动导入目录：${worker.imports}`);
  tick();
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopped = true; clearTimeout(timer); bridge.close(() => process.exit(0)); bridge.closeIdleConnections(); });
}
