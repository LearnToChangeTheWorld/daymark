import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorker } from '../collector/worker.mjs';

test('worker retains events through network failure and removes them only after acknowledgement', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'student-inbox-worker-'));
  let online = false;
  let acknowledge = true;
  const accepted = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    if (!online) { res.writeHead(503); return res.end('{}'); }
    if (req.url === '/api/collector/events') accepted.push(...payload.events.map((entry) => entry.externalId));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url.endsWith('heartbeat') ? { ok: true } : { accepted: acknowledge ? payload.events.map((entry) => entry.externalId) : [] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const worker = await createWorker({ serverUrl: `http://127.0.0.1:${address.port}`, key: '0123456789abcdef0123456789abcdef', dataDir: dir });
  const event = { source: 'qq', externalId: '7:42:9', title: '提交报告', body: '周五提交实验报告', category: 'academic', createdAt: '2026-10-15T10:00:00.000Z' };
  try {
    await worker.enqueue(event);
    await assert.rejects(worker.flush(), /503/);
    assert.equal((await worker.pending()).length, 1);
    const restarted = await createWorker({ serverUrl: `http://127.0.0.1:${address.port}`, key: '0123456789abcdef0123456789abcdef', dataDir: dir });
    assert.equal((await restarted.pending()).length, 1);
    online = true;
    acknowledge = false;
    await assert.rejects(restarted.flush(), /未确认收到/);
    assert.equal((await restarted.pending()).length, 1);
    acknowledge = true;
    await worker.flush();
    assert.equal((await worker.pending()).length, 0);
    assert.deepEqual(accepted, ['7:42:9', '7:42:9']);
    const importPath = join(worker.imports, 'bad.json');
    await writeFile(importPath, '{not json');
    await worker.importFiles();
    assert.equal((await readdir(worker.imports)).length, 0);
    assert.equal((await readdir(join(dir, 'rejected'))).length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('collector refuses non-HTTPS remote endpoints', async () => {
  await assert.rejects(createWorker({ serverUrl: 'http://example.test', key: '0123456789abcdef', dataDir: tmpdir() }), /HTTPS/);
});
