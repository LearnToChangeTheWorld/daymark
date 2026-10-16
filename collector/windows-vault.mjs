import { spawn } from 'node:child_process';
import { join } from 'node:path';

// DPAPI CurrentUser: ciphertext can only be opened by the same Windows account.
// Secrets travel over stdin, never in arguments, environment variables or logs.
export function windowsVault(mode, value) {
  if (process.platform !== 'win32') throw new Error('保存账号功能目前仅支持 Windows；可取消勾选后仅在本次运行使用');
  const script = `Add-Type -AssemblyName System.Security
$ErrorActionPreference = 'Stop'
$raw = [Console]::In.ReadToEnd()
$bytes = [Convert]::FromBase64String($raw)
$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
$result = [System.Security.Cryptography.ProtectedData]::${mode === 'protect' ? 'Protect' : 'Unprotect'}($bytes, $null, $scope)
[Console]::Out.Write([Convert]::ToBase64String($result))`;
  return new Promise((resolve, reject) => {
    const child = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; const timeout = setTimeout(() => { child.kill(); reject(new Error('Windows 账号加密操作超时')); }, 12_000);
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.resume();
    child.on('error', () => { clearTimeout(timeout); reject(new Error('无法启动 Windows 账号加密组件')); });
    child.stdin.on('error', () => {});
    child.on('close', (code) => { clearTimeout(timeout); if (code !== 0 || !/^[A-Za-z0-9+/=]+$/.test(output)) reject(new Error('无法读取本机加密凭据，请断开连接后重新登录')); else resolve(mode === 'protect' ? output : Buffer.from(output, 'base64').toString('utf8')); });
    child.stdin.end(mode === 'protect' ? Buffer.from(value, 'utf8').toString('base64') : value);
  });
}
