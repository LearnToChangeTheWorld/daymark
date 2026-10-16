import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeConfig, isLocalRequest } from '../shared/runtime.mjs';

test('default local mode binds only loopback and normalizes local hostnames', () => {
  assert.deepEqual(runtimeConfig({}, []), { mode: 'local', cloudMode: false, host: '127.0.0.1', port: 4317 });
  assert.equal(runtimeConfig({ HOST: 'localhost' }, []).host, '127.0.0.1');
  assert.equal(runtimeConfig({ HOST: '[::1]', PORT: '0' }, []).host, '::1');
  assert.equal(runtimeConfig({ HOST: '::1', PORT: '0' }, []).port, 0);
});

test('local mode rejects wildcard, LAN, remote hosts and the retired LAN flag', () => {
  for (const host of ['0.0.0.0', '::', '192.168.1.10', 'example.com']) {
    assert.throws(() => runtimeConfig({ HOST: host }, []), /回环/);
  }
  assert.throws(() => runtimeConfig({}, ['--lan']), /已停用 --lan/);
  assert.throws(() => runtimeConfig({ STUDENT_INBOX_MODE: 'typo' }, []), /只能是 local 或 cloud/);
});

test('future cloud configuration remains an explicit opt-in', () => {
  assert.deepEqual(runtimeConfig({ STUDENT_INBOX_MODE: 'cloud', HOST: '0.0.0.0', PORT: '8080' }, []), {
    mode: 'cloud', cloudMode: true, host: '0.0.0.0', port: 8080
  });
});

test('local request guard requires both a local socket and an ordinary loopback Host', () => {
  const req = (remoteAddress, host) => ({ socket: { remoteAddress }, headers: { host } });
  for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    for (const host of ['localhost:4317', '127.0.0.1:4317', '[::1]:4317']) assert.equal(isLocalRequest(req(address, host)), true);
  }
  assert.equal(isLocalRequest(req('192.168.1.20', 'localhost:4317')), false);
  for (const host of [undefined, 'example.test', '127.0.0.1.example.test', 'user@localhost', 'localhost/api/state']) {
    assert.equal(isLocalRequest(req('127.0.0.1', host)), false);
  }
});
