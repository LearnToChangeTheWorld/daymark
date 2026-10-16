import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ChatError } from './napcat.mjs';

export class WechatClient {
  constructor({ dataDir } = {}) { this.pending = new Map(); this.seq = 0; this.dataDir = dataDir; }
  async open() {
    if (this.child?.exitCode === null) return;
    const python = process.env.STUDENT_INBOX_PYTHON_PATH || fileURLToPath(new URL('../.venv-wechat/Scripts/python.exe', import.meta.url));
    try { await access(python); } catch { throw new ChatError('微信读取组件尚未安装，请运行 tools/setup-chat.ps1', 'component_missing'); }
    this.child = spawn(python, [fileURLToPath(new URL('./wechat_bridge.py', import.meta.url)), ...(this.dataDir ? ['--data-dir', this.dataDir] : [])], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    this.child.stderr.on('data', () => {});
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      let response; try { response = JSON.parse(line); } catch { return; }
      const task = this.pending.get(response.id); if (!task) return;
      clearTimeout(task.timer); this.pending.delete(response.id);
      response.result?.error ? task.reject(new ChatError(response.result.error)) : task.done(response.result);
    });
    const stopped = () => { for (const task of this.pending.values()) { clearTimeout(task.timer); task.reject(new ChatError('微信读取组件已停止，请重新连接')); } this.pending.clear(); };
    this.child.on('error', stopped); this.child.on('exit', stopped);
  }
  async call(action, options = {}) {
    await this.open(); const id = ++this.seq;
    return new Promise((done, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new ChatError('微信读取超时，请检查本机客户端状态后重试')); this.child?.kill(); }, 30_000);
      this.pending.set(id, { done, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, action, ...options }) + '\n', (error) => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(new ChatError('微信读取组件无法启动')); } });
    });
  }
  start() { return this.call('start'); }
  loginStatus() { return this.call('status'); }
  refreshQr() { return this.call('refresh'); }
  initialize() { return this.call('initialize'); }
  groups() { return this.call('groups'); }
  preview(groups) { return this.call('read', { groups, preview: true }); }
  read(groups, cursors = {}) { return this.call('read', { groups, cursors }); }
  async close() { if (this.child?.exitCode === null) { try { await this.call('close'); } catch {} } this.child?.stdin.end(); this.child?.kill(); this.child = null; }
}
