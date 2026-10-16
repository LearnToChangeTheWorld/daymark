// Local access is the default. Cloud support stays explicitly opt-in for future deployment.
export function runtimeConfig(env = process.env, args = process.argv.slice(2)) {
  const mode = env.STUDENT_INBOX_MODE || 'local';
  if (!['local', 'cloud'].includes(mode)) throw new Error('STUDENT_INBOX_MODE 只能是 local 或 cloud');
  const cloudMode = mode === 'cloud';
  let host = (env.HOST || '127.0.0.1').trim().toLowerCase();
  if (!cloudMode) {
    if (args.includes('--lan')) throw new Error('本地模式已停用 --lan，仅允许这台电脑访问');
    if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
      throw new Error('本地模式仅允许回环地址 127.0.0.1 或 ::1，不能监听局域网或公网地址');
    }
    if (host === 'localhost') host = '127.0.0.1';
  }
  if (host === '[::1]') host = '::1';
  const port = Number(env.PORT || 4317);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT 必须是 0 到 65535 的整数');
  return { mode, cloudMode, host, port };
}

export function isLocalRequest(req) {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return false;
  try {
    const url = new URL('http://' + req.headers.host);
    return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
  } catch { return false; }
}
