import { mkdir, readFile, writeFile, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { SOURCES, validateEvent } from '../shared/events.mjs';

export async function createWorker({ serverUrl, key, dataDir, name = 'Windows 采集端' }) {
  const url = new URL(serverUrl);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('采集端只向 HTTPS 或本机开发地址上传');
  if (!key || key.length < 16) throw new Error('未配置有效的采集端密钥');
  const outbox = join(dataDir, 'outbox');
  const imports = join(dataDir, 'imports');
  const rejected = join(dataDir, 'rejected');
  for (const path of [outbox, imports, rejected]) await mkdir(path, { recursive: true });

  const client = async (path, payload) => {
    const response = await fetch(new URL(path, url), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(payload) });
    if (!response.ok) throw new Error(`上传失败 (${response.status})`);
    return response.json();
  };

  async function enqueue(input) {
    const event = validateEvent(input);
    const id = createHash('sha256').update(event.source + '\0' + event.externalId).digest('hex');
    const path = join(outbox, id + '.json');
    // Atomic publication: the uploader only sees complete .json files.
    const tmp = join(outbox, id + '.' + randomBytes(6).toString('hex') + '.tmp');
    await writeFile(tmp, JSON.stringify(event), { mode: 0o600 });
    await rename(tmp, path);
    return event.externalId;
  }

  async function importFiles() {
    for (const file of (await readdir(imports)).filter((name) => name.endsWith('.json')).sort()) {
      try {
        const data = JSON.parse(await readFile(join(imports, file), 'utf8'));
        const events = Array.isArray(data) ? data : [data];
        if (!events.length || events.length > 50) throw new Error('每个文件需含 1–50 条事件');
        const valid = events.map(validateEvent);
        for (const event of valid) await enqueue(event);
        await unlink(join(imports, file));
      } catch (error) {
        // Disk failures leave the import untouched. Invalid input is retained for repair.
        if (error.code) throw error;
        await rename(join(imports, file), join(rejected, Date.now() + '-' + file));
        console.error(`导入格式错误，原文件已保留到 rejected：${file}`);
      }
    }
  }

  async function pending() { return (await readdir(outbox)).filter((file) => /^[a-f0-9]{64}\.json$/.test(file)); }
  async function flush() {
    const files = (await pending()).sort();
    // Bound each cycle so heartbeat is not blocked by a large backlog.
    for (const file of files.slice(0, 20)) {
      const event = validateEvent(JSON.parse(await readFile(join(outbox, file), 'utf8')));
      const result = await client('/api/collector/events', { events: [event] });
      if (!Array.isArray(result.accepted) || !result.accepted.includes(event.externalId)) throw new Error('服务器未确认收到，保留本地待上传事项');
      await unlink(join(outbox, file));
    }
    return (await pending()).length;
  }

  async function heartbeat(reports = {}, additionalQueued = 0) {
    const sources = Object.fromEntries(SOURCES.filter((source) => source !== 'manual').map((source) => [source, reports[source] || { status: 'not_configured', message: '尚未配置采集器' }]));
    return client('/api/collector/heartbeat', { name, queued: (await pending()).length + additionalQueued, sources });
  }

  return { enqueue, importFiles, flush, heartbeat, pending, imports };
}
