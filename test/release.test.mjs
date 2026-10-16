import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { auditRelease, exportRelease } from '../tools/release-check.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'daymark-publication-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'docs'));
  for (const path of ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'server.mjs', 'docs/platform-setup.md', 'docs/publishing.md']) {
    await writeFile(join(root, path), 'Synthetic publication fixture\n');
  }
  await writeFile(join(root, 'package.json'), '{"name":"daymark","version":"0.1.0"}\n');
  await writeFile(join(root, '.gitignore'), 'data/\nartifacts/\n.venv-wechat/\nvendor/napcat/\n');
  return root;
}

test('clean export keeps dotfiles and source, excludes private runtime data without deleting it', async t => {
  const root = await fixture(t);
  for (const directory of ['data', 'artifacts', '.venv-wechat', 'vendor/napcat']) {
    await mkdir(join(root, directory), { recursive: true });
    await writeFile(join(root, directory, 'private.json'), '{"synthetic":"private fixture"}');
  }
  await mkdir(join(root, '.github'));
  await writeFile(join(root, '.github', 'example.yml'), 'name: synthetic\n');
  const result = await exportRelease(root);
  assert.match(await readFile(join(result.output, '.gitignore'), 'utf8'), /data\//);
  assert.match(await readFile(join(result.output, '.github/example.yml'), 'utf8'), /synthetic/);
  const files = (await auditRelease(result.output)).files.map(file => file.path);
  assert(!files.some(path => /private\.json/.test(path)));
  assert.equal((await readdir(join(result.output))).includes('data'), false);
  assert.match(await readFile(join(root, 'data/private.json'), 'utf8'), /private fixture/);
  assert.equal((await auditRelease(result.output)).ok, true);
});

test('already tracked private files are rejected even when .gitignore excludes their directory', async t => {
  const root = await fixture(t);
  execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'pipe' });
  await mkdir(join(root, 'data'));
  await writeFile(join(root, 'data/access.token'), 'synthetic local secret');
  execFileSync('git', ['add', '--force', 'data/access.token'], { cwd: root, stdio: 'pipe' });
  const report = await auditRelease(root);
  assert.equal(report.ok, false);
  assert(report.findings.some(finding => finding.path === 'data/access.token'));
  await assert.rejects(exportRelease(root), /checks failed/);
});

test('credentials and missing document links fail publication with locations but no secret values', async t => {
  const root = await fixture(t);
  const secret = 'ghp_' + 'S'.repeat(40);
  await writeFile(join(root, 'server.mjs'), `// synthetic secret\nconst token = '${secret}';\n`);
  await writeFile(join(root, 'README.md'), '[Missing instructions](docs/missing.md)\n');
  const report = await auditRelease(root);
  assert.deepEqual(report.findings.find(finding => finding.rule === 'github-token'), { path: 'server.mjs', rule: 'github-token', line: 2 });
  assert(report.findings.some(finding => finding.rule === 'missing-local-link-target'));
  assert.equal(JSON.stringify(report.findings).includes(secret), false);
  await assert.rejects(exportRelease(root), /checks failed/);
});

test('linked directories cannot pull outside files into the release', async t => {
  const root = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), 'daymark-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'first.mjs'), '// synthetic\n');
  await writeFile(join(outside, 'second.mjs'), '// synthetic\n');
  await mkdir(join(root, 'collector'));
  try { await symlink(outside, join(root, 'collector/linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') return t.skip('Symlink creation unavailable'); throw error; }
  const report = await auditRelease(root);
  assert.equal(report.ok, false);
  assert(report.findings.some(finding => finding.path.startsWith('collector/linked')));
  await assert.rejects(exportRelease(root), /checks failed/);
});
