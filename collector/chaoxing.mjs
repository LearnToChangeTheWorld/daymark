// Protocol reference: https://github.com/DanMo661/Xuexitong-mcp
// Independent Node implementation. Only login and read endpoints are used.
import { createCipheriv, createHash } from 'node:crypto';
import { validDate } from '../shared/events.mjs';

export class PlatformError extends Error {
  constructor(message, code = 'error') { super(message); this.code = code; }
}
export function plain(html = '') {
  return String(html).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, ' ').replace(/&(?:amp|lt|gt|quot|apos|nbsp);|&#(?:x[0-9a-f]+|\d+);/gi, (entity) => {
      const named = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' };
      if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
      const value = entity.slice(2, -1); const number = value[0].toLowerCase() === 'x' ? parseInt(value.slice(1), 16) : Number(value);
      return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : '';
    }).replace(/\s+/g, ' ').trim();
}
const attr = (tag, name) => tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i'))?.[2] || '';
const hidden = (html, name) => Array.from(html.matchAll(/<input\b[^>]*>/gi)).map(([tag]) => tag).find((tag) => attr(tag, 'id') === name || attr(tag, 'name') === name);
const field = (html, name) => attr(hidden(html, name) || '', 'value');
const decode = (value) => plain(value.replaceAll('<', '&lt;').replaceAll('>', '&gt;'));
const endpoint = (path, params = {}) => { const url = new URL(path); url.search = new URLSearchParams(params).toString(); return url.href; };

export function allowedUrl(input) {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !(url.hostname === 'chaoxing.com' || url.hostname.endsWith('.chaoxing.com'))) throw new PlatformError('平台返回了不支持的地址，已停止请求');
  return url;
}

// Scope each cookie to its host/domain and path; never leak it across redirects.
export class CookieJar {
  constructor(cookies = []) { this.cookies = cookies; }
  accept(url, lines) {
    const host = url.hostname;
    for (const line of lines) {
      const [pair, ...parts] = line.split(';'); const split = pair.indexOf('=');
      if (split < 1) continue;
      const item = { name: pair.slice(0, split).trim(), value: pair.slice(split + 1).trim(), domain: host, hostOnly: true,
        path: url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1) || '/', secure: false, expires: null };
      let maxAge;
      for (const part of parts) {
        const [raw, ...rest] = part.trim().split('='); const value = rest.join('=');
        switch (raw.toLowerCase()) {
          case 'domain': item.domain = value.toLowerCase().replace(/^\./, ''); item.hostOnly = false; break;
          case 'path': if (value.startsWith('/')) item.path = value; break;
          case 'secure': item.secure = true; break;
          case 'expires': if (Number.isFinite(Date.parse(value))) item.expires = Date.parse(value); break;
          case 'max-age': if (/^-?\d+$/.test(value)) maxAge = Number(value); break;
        }
      }
      if (!(item.domain === 'chaoxing.com' || item.domain.endsWith('.chaoxing.com')) || !(host === item.domain || host.endsWith('.' + item.domain))) continue;
      if (maxAge !== undefined) item.expires = Date.now() + maxAge * 1000;
      this.cookies = this.cookies.filter((other) => !(other.name === item.name && other.domain === item.domain && other.path === item.path));
      if (item.expires === null || item.expires > Date.now()) this.cookies.push(item);
    }
  }
  header(url) {
    return this.cookies.filter((c) => (c.expires === null || c.expires > Date.now()) && (c.hostOnly ? url.hostname === c.domain : url.hostname === c.domain || url.hostname.endsWith('.' + c.domain))
      && (url.pathname === c.path || url.pathname.startsWith(c.path.endsWith('/') ? c.path : c.path + '/')) && (!c.secure || url.protocol === 'https:'))
      .sort((a, b) => b.path.length - a.path.length).map((c) => `${c.name}=${c.value}`).join('; ');
  }
}

export function encryptLogin(value) {
  const key = Buffer.from('u2oh6Vu^HWe4_AES');
  const cipher = createCipheriv('aes-128-cbc', key, key);
  return Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]).toString('base64');
}

export function platformTime(notice) {
  for (const value of [notice.sendTime, notice.insertTime]) {
    if (typeof value === 'number' && value > 1e9) { const date = new Date(value > 1e12 ? value : value * 1000); if (Number.isFinite(date.getTime())) return date.toISOString(); }
    if (typeof value !== 'string') continue;
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/.test(value) ? value.replace(' ', 'T') + '+08:00' : value;
    if (/^\d{4}-\d{2}-\d{2}T/.test(normalized) && Number.isFinite(Date.parse(normalized))) return new Date(normalized).toISOString();
  }
  return null;
}

export function parseCourses(html) {
  const source = html.replaceAll('&amp;', '&'); const courses = new Map();
  for (const match of source.matchAll(/stucoursemiddle\?([^\s"'<>]+)/g)) {
    const params = new URLSearchParams(match[1]);
    const courseid = params.get('courseid'); const clazzid = params.get('clazzid'); const cpi = params.get('cpi');
    if (![courseid, clazzid, cpi].every((v) => /^\d+$/.test(v || ''))) continue;
    const fragment = source.slice(match.index, match.index + 1800);
    const tag = fragment.match(/<[^>]*class=["'][^"']*course-name[^"']*["'][^>]*>/i)?.[0];
    const name = decode(attr(tag || '', 'title')) || '未识别课程名称';
    courses.set(`${courseid}:${clazzid}:${cpi}`, { courseid, clazzid, cpi, name });
  }
  return [...courses.values()];
}

export function parseHomework(html) {
  const items = [];
  for (const [block] of html.matchAll(/<li\b[^>]*>[\s\S]*?<\/li>/gi)) {
    const tag = block.slice(0, block.indexOf('>') + 1);
    if (!/goTask\s*\(/.test(attr(tag, 'onclick'))) continue;
    const paragraphs = [...block.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi)];
    const title = paragraphs.find((m) => /overHidden2/.test(attr('<p ' + m[1] + '>', 'class')));
    const status = paragraphs.find((m) => /\bstatus\b/.test(attr('<p ' + m[1] + '>', 'class')));
    let url = decode(attr(tag, 'data'));
    try { url = decodeURIComponent(url); } catch {}
    if (!title) throw new PlatformError('作业列表格式变化，无法读取标题');
    items.push({ title: plain(title[2]), status: plain(status?.[2]), url });
  }
  // A missing parser match is different from a confirmed empty list.
  if (!items.length && !/暂无作业|没有作业|无作业|0\s*\/\s*0/.test(plain(html))) throw new PlatformError('无法确认作业列表为空，可能是页面格式变化');
  return items;
}

export function deadlineInfo(html) {
  const text = plain(html);
  const raw = text.match(/作答时间\s*[:：]\s*(.+?)\s*至\s*((?:\d{4}[-/年])?\d{1,2}[-/月]\d{1,2}日?\s+\d{1,2}:\d{2})/)?.[2] || '';
  const exact = raw.match(/^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/);
  const date = exact ? `${exact[1]}-${exact[2].padStart(2, '0')}-${exact[3].padStart(2, '0')}` : null;
  return { raw, due: date && validDate(date) ? date : null };
}

export function homeworkEvent(course, item, detail, accountId, now) {
  let workId;
  try { const u = allowedUrl(item.url); workId = ['workId', 'workid', 'taskId', 'taskid', 'id'].map((k) => u.searchParams.get(k)).find(Boolean); } catch {}
  if (!workId) throw new PlatformError(`“${item.title}”缺少稳定作业编号，已保留错误提示而未猜测编号`);
  const deadline = deadlineInfo(detail);
  return { source: 'chaoxing', sourceName: `学习通 · ${course.name}`.slice(0, 100), externalId: `${accountId}:work:${course.courseid}:${course.clazzid}:${workId}`,
    title: item.title, kind: 'task', timestampKind: 'collected', category: 'academic', due: deadline.due, confidence: deadline.due ? 'high' : 'low', createdAt: now,
    body: `课程：${course.name}\n作业：${item.title}\n平台状态：${item.status || '未识别'}\n${deadline.raw ? `平台截止时间：${deadline.raw}${deadline.due ? '' : '（缺少年份，请确认）'}` : '未能读取截止时间，请到学习通核对。'}\n本条时间为首次采集时间；请在学习通完成提交。` };
}

export class ChaoxingClient {
  constructor({ cookies = [], fetchImpl = fetch } = {}) { this.jar = new CookieJar(cookies); this.fetchImpl = fetchImpl; }
  async openVerification(dataDir) {
    const target = this.verificationUrl || this.courseUrl;
    if (!target) throw new PlatformError('尚未取得课程入口，请先执行一次同步');
    if (!this.browser?.alive) {
      await this.browser?.close();
      const { openChaoxingBrowser } = await import('./chaoxing-browser.mjs');
      this.browser = await openChaoxingBrowser({ dataDir, cookies: this.jar.cookies });
    }
    const page = await this.browser.read(target);
    this.jar.cookies = page.cookies;
    return '已打开 Edge。请完成页面上的验证码；如果要求登录，请在此窗口登录，然后回软件点击“已完成验证，继续同步”。';
  }
  async close() { await this.browser?.close(); this.browser = null; }
  checkedText(text, url) {
    if (/processVerifyPng\.ac|\/html\/processVerify\.ac/.test(text)) {
      this.verificationUrl = url.href;
      throw new PlatformError('学习通要求安全验证码，请打开验证窗口完成验证后继续同步', 'needs_verification');
    }
    // Signed-in course pages also contain a login link in their shared header.
    // Detect an actual login page, rather than any reference to the login URL.
    if (/\/(?:login|login3|login4)(?:\/|$)/.test(url.pathname) || /<title[^>]*>[^<]*(?:用户登录|登录|login)/i.test(text)
      || /^用户登录$/.test(plain(text)) || /<form\b[^>]*action=["'][^"']*fanyalogin/i.test(text)) throw new PlatformError('学习通登录已失效，请重新登录', 'needs_login');
    return text;
  }
  async request(input, form) {
    let url = allowedUrl(input); let method = form ? 'POST' : 'GET'; let body = form ? new URLSearchParams(form).toString() : undefined;
    if (this.browser && url.hostname === 'mooc1.chaoxing.com' && !form) {
      if (!this.browser.alive) throw new PlatformError('验证窗口已关闭，请重新打开验证窗口后继续同步', 'needs_verification');
      const page = await this.browser.read(url.href); this.jar.cookies = page.cookies;
      return this.checkedText(page.text, allowedUrl(page.url));
    }
    for (let redirects = 0; redirects < 8; redirects++) {
      let response;
      try {
        response = await this.fetchImpl(url.href, { method, body, redirect: 'manual', signal: AbortSignal.timeout(20_000), headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
          cookie: this.jar.header(url), ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) } });
      } catch { throw new PlatformError('无法连接学习通，请检查校园网是否已认证，以及能否打开学习通官网'); }
      this.jar.accept(url, response.headers.getSetCookie());
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location'); if (!location) throw new PlatformError('平台重定向地址为空');
        await response.body?.cancel();
        const next = new URL(location, url);
        // Some Chaoxing redirects still advertise HTTP. Upgrade before making
        // any request; never send account cookies over an insecure connection.
        if (next.protocol === 'http:' && !next.port && (next.hostname === 'chaoxing.com' || next.hostname.endsWith('.chaoxing.com'))) next.protocol = 'https:';
        url = allowedUrl(next.href);
        if ([301, 302, 303].includes(response.status)) { method = 'GET'; body = undefined; }
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new PlatformError(`学习通返回 HTTP ${response.status}，请稍后重试`); }
      const reader = response.body?.getReader(); const chunks = []; let size = 0;
      if (reader) for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 8_000_000) { await reader.cancel(); throw new PlatformError('学习通响应过大，已停止读取'); } chunks.push(Buffer.from(value)); }
      const text = Buffer.concat(chunks).toString('utf8');
      return this.checkedText(text, url);
    }
    throw new PlatformError('学习通重定向次数过多');
  }
  async login(phone, password) {
    const raw = await this.request('https://passport2.chaoxing.com/fanyalogin', { fid: '-1', uname: encryptLogin(phone), password: encryptLogin(password), refer: 'https%3A%2F%2Fi.chaoxing.com', t: 'true', forbidotherlogin: '0', validate: '', doubleFactorLogin: '0', independentId: '0' });
    let data; try { data = JSON.parse(raw); } catch { throw new PlatformError('学习通登录响应格式变化，请稍后重试', 'needs_login'); }
    if (data.status !== true) throw new PlatformError((plain(data.msg2 || data.msg || '登录未成功，请核对账号密码；若需要验证码，请先在学习通官网完成验证。')).slice(0, 240), 'needs_login');
  }
  async collect(accountId, emit) {
    const now = new Date().toISOString(); const warnings = []; let count = 0;
    const stats = { coursesTotal: 0, coursesRead: 0, tasksRead: 0, noticesRead: 0, skippedOld: 0, unknownDates: 0, noticesDays: 7, verificationRequired: false, noticesComplete: false };
    const base = await this.request('https://i.chaoxing.com/base');
    const fid = base.match(/["']?fid["']?\s*[:=]\s*["']?(\d+)/)?.[1];
    if (!fid) throw new PlatformError('未能读取学校编号，请重新登录；不会默认使用其他学校', 'needs_login');
    const html = await this.request(endpoint('https://mooc2-ans.chaoxing.com/mooc2-ans/visit/courselistdata', { courseType: 1, courseFid: fid, courseTeacherid: 0, courseOrderBy: 0 }));
    const courses = parseCourses(html);
    stats.coursesTotal = courses.length;
    if (!courses.length && !/暂无课程|没有课程|还没有课程/.test(plain(html))) throw new PlatformError('未能识别课程列表，不能确认账号没有课程');
    for (const course of courses) {
      try {
        this.courseUrl = endpoint('https://mooc1.chaoxing.com/visit/stucoursemiddle', { courseid: course.courseid, clazzid: course.clazzid, cpi: course.cpi, ismooc2: 1, v: 2 });
        const page = await this.request(this.courseUrl);
        const enc = field(page, 'workEnc');
        if (!enc) { warnings.push(`${course.name}：未找到作业入口`); continue; }
        const list = await this.request(endpoint('https://mooc1.chaoxing.com/mooc2/work/list', { courseId: course.courseid, classId: course.clazzid, cpi: course.cpi, ut: 's', openc: field(page, 'openc'), enc, stuenc: field(page, 'enc'), isdisplaytable: 2, t: Date.now() }));
        if (/没有此页面访问权限/.test(list)) throw new PlatformError('作业访问签名无效');
        const homework = parseHomework(list); stats.coursesRead++;
        for (const item of homework) {
          if (/已完成|已提交|待批阅|已批阅|已批改|已互评|已评分|已互阅/.test(item.status)) continue;
          if (!/未交|未提交|待提交|未完成|待完成|未做|待做/.test(item.status)) { warnings.push(`${course.name} · ${item.title}：作业状态“${item.status || '未知'}”无法确认是否需要提交，未加入待办`); continue; }
          let detail = '';
          try { detail = await this.request(allowedUrl(item.url).href); }
          catch (error) { if (['needs_login', 'needs_verification'].includes(error.code)) throw error; warnings.push(`${course.name} · ${item.title}：详情读取失败`); }
          await emit(homeworkEvent(course, item, detail, accountId, now)); count++; stats.tasksRead++;
        }
      } catch (error) {
        if (error.code === 'needs_login' || !(error instanceof PlatformError)) throw error;
        if (error.code === 'needs_verification') { stats.verificationRequired = true; warnings.push(error.message); break; }
        warnings.push(`${course.name}：${error.message}`);
      }
    }
    // The list endpoint is read-only and does not mark notices read.
    try {
      let lastValue = ''; const seen = new Set();
      const cutoff = Date.now() - stats.noticesDays * 86400_000;
      for (let page = 0; page < 5; page++) {
        const raw = await this.request('https://notice.chaoxing.com/pc/notice/getNoticeList', { type: 0, notice_type: 0, lastValue, sort: 0, folderUUID: '', kw: '', startTime: '', endTime: '', gKw: '', gName: '', year: '', tag: '', fidsCode: '', filterSenderPuids: '', filterTags: '' });
        let result; try { result = JSON.parse(raw); } catch { throw new PlatformError('通知列表不是有效 JSON'); }
        if (!result.status || !Array.isArray(result.notices?.list)) throw new PlatformError('未能识别通知列表');
        let foundOlderThanCutoff = false;
        for (const notice of result.notices.list) {
          if (!notice.id && !notice.uuid) { warnings.push('一条通知缺少稳定编号，未导入'); continue; }
          const publishedAt = platformTime(notice);
          if (!publishedAt) stats.unknownDates++;
          if (publishedAt && Date.parse(publishedAt) < cutoff) { stats.skippedOld++; foundOlderThanCutoff = true; continue; }
          await emit({ source: 'chaoxing', sourceName: '学习通 · 通知中心', externalId: `${accountId}:notice:${notice.id || notice.uuid}`, title: plain(notice.title) || '学习通通知', body: plain(notice.content).slice(0, 12000), kind: 'notification', category: 'academic', confidence: 'high', due: null, publishedAt, timestampKind: publishedAt ? 'published' : 'collected', createdAt: publishedAt || now }); count++; stats.noticesRead++;
        }
        const next = result.notices.lastGetId;
        if (result.notices.lastPage || !result.notices.list.length || foundOlderThanCutoff) { stats.noticesComplete = true; break; }
        if (!next || seen.has(next)) { warnings.push('通知翻页游标异常，可能还有未读取的通知'); break; }
        seen.add(next); lastValue = next;
        if (page === 4 && !stats.noticesComplete) warnings.push('通知读取已达 5 页上限，近 7 天通知可能尚未读全');
      }
    } catch (error) { if (error.code === 'needs_login' || !(error instanceof PlatformError)) throw error; warnings.push(`通知中心：${error.message}`); }
    if (stats.unknownDates) warnings.push(`${stats.unknownDates} 条通知缺少发布时间，已放入历史记录，不标记为近期新消息`);
    return { courses: courses.map(({ name, courseid, clazzid }) => ({ name, courseid, clazzid })), count, warnings, stats };
  }
}

export const accountHash = (phone) => createHash('sha256').update(phone).digest('hex').slice(0, 20);
