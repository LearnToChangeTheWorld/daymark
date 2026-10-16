import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const rootFiles = new Set([
  '.dockerignore', '.editorconfig', '.env.example', '.gitattributes', '.gitignore',
  'Caddyfile.example', 'CHANGELOG.md', 'collector.config.example.json', 'compose.yaml',
  'CONTRIBUTING.md', 'Dockerfile', 'LICENSE', 'package.json', 'README.md',
  'SECURITY.md', 'server.mjs', 'THIRD_PARTY_NOTICES.md', 'source-manifest.json'
]);
const sourceDirs = new Set(['.github', 'collector', 'docs', 'public', 'shared', 'test', 'tools']);
const privateDirs = /^(?:\.git|data|dev-data|collector-data|StudentInbox|accounts|browser-sessions|artifacts|dist|releases|logs|node_modules|__pycache__|\.venv[^/]*|venv|\.idea|\.vscode)$/i;
const privateFiles = /(?:\.(?:log|token|key|pem|dpapi|db|sqlite|sqlite3)(?:-.*)?|\.py[co]|\.exe|\.dll|\.zip|\.7z|\.tgz|\.whl)$/i;
const textFiles = /(?:\.(?:mjs|js|py|ps1|css|html|svg|json|webmanifest|md|yml|yaml|example)|(?:^|\/)(?:LICENSE|Dockerfile|\.gitignore|\.dockerignore|\.editorconfig|\.gitattributes))$/i;
const required = ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', '.gitignore', 'server.mjs', 'package.json', 'docs/platform-setup.md', 'docs/publishing.md'];

function privatePath(path) {
  const parts = path.split('/');
  return parts.some(part => privateDirs.test(part)) || privateFiles.test(path)
    || /^\.env(?:\.|$)/.test(path) && path !== '.env.example'
    || path === 'collector.config.json' || /^vendor\/(?:napcat|wechat-research)(?:\/|$)/i.test(path);
}

function allowedPath(path) {
  if (path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..') || isAbsolute(path)) return false;
  if (privatePath(path)) return false;
  if (rootFiles.has(path)) return true;
  if (path === 'vendor/README.md' || path === 'vendor/NapCat.LICENSE') return true;
  return sourceDirs.has(path.split('/')[0]) && textFiles.test(path);
}

export function credentialFindings(content) {
  const patterns = [
    ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
    ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g],
    ['api-secret', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/g],
    ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
    ['personal-wechat-id', /\bwxid_[a-zA-Z0-9]{12,}\b/g],
    ['credential-in-url', /https?:\/\/[^\s/@:]+:[^\s/@]+@/g]
  ];
  const findings = [];
  for (const [rule, pattern] of patterns) {
    for (const match of content.matchAll(pattern)) {
      findings.push({ rule, line: content.slice(0, match.index).split('\n').length });
    }
  }
  return findings;
}

async function candidates(root) {
  if (await lstat(join(root, '.git')).catch(() => null)) {
    // Include tracked files even if a later .gitignore would now hide them.
    const output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
    return [...new Set(output.toString('utf8').split('\0').filter(Boolean))].sort();
  }
  const paths = [];
  async function walk(folder, prefix = '') {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = prefix + entry.name;
      // A source ZIP has no Git metadata; installed local components remain excluded.
      if (privatePath(path) || ['.DS_Store', 'Thumbs.db', 'desktop.ini'].includes(entry.name)) continue;
      if (entry.isDirectory()) {
        if (!prefix && !sourceDirs.has(entry.name) && entry.name !== 'vendor') {
          paths.push(path + '/');
        } else await walk(join(folder, entry.name), path + '/');
      } else paths.push(path);
    }
  }
  await walk(root);
  return paths.sort();
}

export async function auditRelease(root = projectRoot) {
  root = resolve(root);
  const paths = await candidates(root);
  const findings = [];
  const files = [];
  const checkedDirs = new Set();
  for (const path of paths) {
    if (!allowedPath(path)) {
      findings.push({ path, rule: 'unexpected-or-private-file' });
      continue;
    }
    const absolute = resolve(root, path);
    if (!absolute.startsWith(root + sep)) {
      findings.push({ path, rule: 'path-outside-project' });
      continue;
    }
    let unsafeParent = false;
    let directory = dirname(absolute);
    const pendingDirs = [];
    while (directory !== root) {
      if (checkedDirs.has(directory)) break;
      const info = await lstat(directory).catch(() => null);
      if (!info?.isDirectory() || info.isSymbolicLink()) { unsafeParent = true; break; }
      pendingDirs.push(directory);
      directory = dirname(directory);
    }
    if (!unsafeParent) for (const directory of pendingDirs) checkedDirs.add(directory);
    const info = await lstat(absolute).catch(() => null);
    if (unsafeParent || !info?.isFile() || info.isSymbolicLink()) {
      findings.push({ path, rule: 'missing-file-or-symlink' });
      continue;
    }
    if (info.size > 5 * 1024 * 1024) {
      findings.push({ path, rule: 'oversized-source-file' });
      continue;
    }
    const bytes = await readFile(absolute);
    const content = bytes.toString('utf8');
    for (const finding of credentialFindings(content)) findings.push({ path, ...finding });
    files.push({ path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const byPath = new Map(files.map(file => [file.path, file]));
  for (const path of required) if (!byPath.has(path)) findings.push({ path, rule: 'required-file-missing' });
  const sourcePath = 'public/vendor/tabler/SOURCE.json';
  if (byPath.has(sourcePath)) {
    try {
      const source = JSON.parse(await readFile(join(root, sourcePath), 'utf8'));
      for (const [path, expected] of [['public/vendor/tabler/tabler.min.css', source.cssSha256], ['public/vendor/tabler/LICENSE', source.licenseSha256]]) {
        if (!expected || byPath.get(path)?.sha256 !== expected) findings.push({ path, rule: 'vendor-checksum-mismatch' });
      }
    } catch { findings.push({ path: sourcePath, rule: 'invalid-vendor-metadata' }); }
  }
  // Only inspect Markdown links whose targets are local source files.
  for (const file of files.filter(file => file.path.endsWith('.md'))) {
    const content = await readFile(join(root, file.path), 'utf8');
    for (const match of content.matchAll(/\]\(([^\s)]+)\)/g)) {
      const target = match[1].split('#')[0];
      if (!target || /^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(target)) continue;
      const path = relative(root, resolve(root, dirname(file.path), target)).replaceAll('\\', '/');
      if (!byPath.has(path)) findings.push({ path: file.path, rule: 'missing-local-link-target', target: path });
    }
  }
  return { ok: !findings.length, files, totalBytes: files.reduce((sum, file) => sum + file.size, 0), findings };
}

export async function exportRelease(root = projectRoot) {
  root = resolve(root);
  const report = await auditRelease(root);
  if (!report.ok) throw new Error('Publication checks failed; no source package created.');
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw new Error('Invalid release version.');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const output = join(root, 'artifacts', 'releases', `daymark-${version}-source-${stamp}`);
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output); // Never overwrite a previous release.
  for (const file of report.files.filter(file => file.path !== 'source-manifest.json')) {
    const bytes = await readFile(join(root, file.path));
    if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error(`File changed during export: ${file.path}`);
    const destination = join(output, file.path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { flag: 'wx' });
  }
  const manifest = { name: 'daymark', version, generatedAt: new Date().toISOString(), files: report.files.filter(file => file.path !== 'source-manifest.json') };
  await writeFile(join(output, 'source-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return { output, fileCount: manifest.files.length, totalBytes: report.totalBytes, version };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    if (process.argv.includes('--export')) {
      textOutput(await exportRelease());
    } else {
      const report = await auditRelease();
      textOutput({ ok: report.ok, fileCount: report.files.length, totalBytes: report.totalBytes, findings: report.findings });
      if (!report.ok) process.exitCode = 1;
    }
  } catch (error) {
    textOutput({ ok: false, error: error.message });
    process.exitCode = 1;
  }
}

function textOutput(value) { process.stdout.write(JSON.stringify(value, null, 2) + '\n'); }
