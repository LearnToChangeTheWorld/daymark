'use strict';

const SOURCE_NAMES = { wechat: '微信', qq: 'QQ', chaoxing: '学习通', rainclass: '雨课堂', csu: '中南大学教务', manual: '手动记录' };
const state = { items: [], sources: {}, collector: null, filter: 'all', view: 'tasks', topic: 'all', search: '', lastSync: null, mode: 'local', connected: false, noticeRange: '7', messageRange: '7', messageContext: null, attachmentsOnly: false };
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
let editingId = null;
let promotingToTask = false;
let authenticated = false;
let syncGeneration = 0;
let accountInfo = null;
let accountSubmitting = false;
let accountEditing = false;
let accountRequest = 0;
let activeOperation = null;
let dismissedOperation = null;
let lastResultKey = null;
let bulkMode = false;
let bulkBusy = false;
let bulkScope = '';
let bulkView = state.view;
let bulkResult = null;
const bulkSelected = new Set();
// Remove the legacy shared token; browser sessions now use HttpOnly cookies.
try { sessionStorage.removeItem('student-inbox-token'); } catch {}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function icon(name) {
  if (name === 'check') return '<svg viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></svg>';
  if (name === 'inbox') return '<svg viewBox="0 0 24 24"><path d="M4 4h16l2 12v4H2v-4L4 4Z"/><path d="M2 14h5l2 2h6l2-2h5"/></svg>';
  return '';
}

function dateLabel() {
  const date = new Date();
  const weekday = ['日', '一', '二', '三', '四', '五', '六'][date.getDay()];
  return `${date.getMonth() + 1}月${date.getDate()}日 · 星期${weekday}`;
}

function formatDate(value, withTime = false) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日${withTime ? ` ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}` : ''}`;
}

const isTask = (item) => item.kind === 'task' || (!item.kind && (item.source === 'manual' || item.due || String(item.externalId).includes(':work:')));
const isChat = (item) => ['qq', 'wechat'].includes(item.source);
const isCandidate = (item) => !isTask(item) && item.triage?.kind === 'candidate' && !item.triage?.duplicateOf;
function isRecent(item, range = state.noticeRange) {
  const time = item.publishedAt || (item.timestampKind === 'collected' ? null : item.createdAt);
  return time && Date.parse(time) >= Date.now() - Number(range) * 86400_000;
}

function dateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

const mainRelevant = (item) => item.relevance !== 'other' && !(item.relevance === undefined && item.category === 'life' && !isTask(item));
const itemTime = (item) => item.publishedAt || item.createdAt;
const messageDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
const messageClock = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const messageWeekday = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', weekday: 'long' });
function messageTime(item) {
  // Backfilled messages keep their source date. Import time is never a substitute.
  const time = item.publishedAt || (!['collected', 'observed'].includes(item.timestampKind) ? item.createdAt : null);
  return time && Number.isFinite(Date.parse(time)) ? time : null;
}
function messageDateKey(item) { const time = messageTime(item); return time ? messageDay.format(new Date(time)) : 'unknown'; }
function visibleItems() {
  const query = state.search.trim().toLowerCase();
  return state.items.filter((item) => {
    const task = isTask(item);
    if (state.view !== 'records' && item.archived) return false;
    if (state.view === 'tasks' && (!task || item.done)) return false;
    if (state.view === 'review' && (!isCandidate(item) || !mainRelevant(item))) return false;
    if (state.view === 'notices') {
      if (task || isCandidate(item) || !mainRelevant(item) || (isChat(item) && (item.triage?.kind !== 'notice' || item.triage?.duplicateOf))) return false;
      if (state.noticeRange !== 'all' && !isRecent(item)) return false;
      if (state.topic !== 'all' && item.topic !== state.topic) return false;
    }
    if (state.view === 'records') {
      if (state.filter === 'done' && (!task || !item.done)) return false;
      if (state.filter === 'archived' && !item.archived) return false;
      if (state.filter === 'other' && item.relevance !== 'other' && !(isChat(item) && ['conversation', 'attachment'].includes(item.triage?.kind))) return false;
      if (state.attachmentsOnly && item.triage?.kind !== 'attachment') return false;
      if (state.messageContext) {
        const context = state.messageContext;
        if (item.source !== context.source || item.sourceName !== context.sourceName || Math.abs(Date.parse(itemTime(item)) - context.time) > 15 * 60_000) return false;
      } else if (!['done', 'archived'].includes(state.filter) && state.messageRange !== 'all' && !isRecent(item, state.messageRange)) return false;
    }
    return !query || `${item.title} ${item.body} ${item.sourceName || SOURCE_NAMES[item.source] || ''}`.toLowerCase().includes(query);
  }).sort((a, b) => {
    if (state.view === 'tasks') return (Date.parse(messageTime(b)) || 0) - (Date.parse(messageTime(a)) || 0);
    return String(itemTime(b)).localeCompare(String(itemTime(a)));
  });
}
function shortTime(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return '时间未知';
  const d = new Date(value);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function bulkRestoring() { return state.view === 'records' && state.filter === 'archived'; }
function bulkEligible(item) { return Boolean(item.archived) === bulkRestoring(); }
function selectionMarkup(item) {
  return `<input class="bulk-select-input" type="checkbox" data-select-item="${escapeHtml(item.id)}" aria-label="选择：${escapeHtml(item.title || '未命名事项')}"${bulkSelected.has(item.id) ? ' checked' : ''}${bulkBusy || !bulkEligible(item) ? ' disabled' : ''}>`;
}
function renderBulkControls(items) {
  const scope = JSON.stringify([state.view, state.filter, state.search, state.noticeRange, state.messageRange, state.topic, state.messageContext, state.attachmentsOnly]);
  if (scope !== bulkScope) { bulkSelected.clear(); bulkResult = null; bulkScope = scope; }
  if (bulkView !== state.view) { bulkMode = false; bulkView = state.view; }
  const eligible = items.filter(bulkEligible), ids = new Set(eligible.map(item => item.id));
  for (const id of bulkSelected) if (!ids.has(id)) bulkSelected.delete(id);
  $('#bulkToggle').hidden = !bulkMode && !eligible.length;
  $('#bulkToggle').textContent = bulkMode ? '退出多选' : bulkRestoring() ? '批量恢复' : '批量归档';
  $('#bulkToggle').disabled = bulkBusy;
  $('#bulkToolbar').hidden = !bulkMode;
  $('#bulkSelectAll').checked = eligible.length > 0 && bulkSelected.size === eligible.length;
  $('#bulkSelectAll').indeterminate = bulkSelected.size > 0 && bulkSelected.size < eligible.length;
  $('#bulkSelectAll').disabled = bulkBusy || !eligible.length;
  $('#bulkCount').textContent = `已选 ${bulkSelected.size} 条`;
  $('#bulkApply').disabled = bulkBusy || !bulkSelected.size;
  $('#bulkApply').textContent = bulkBusy ? (bulkRestoring() ? '正在恢复…' : '正在归档…') : (bulkRestoring() ? '恢复所选' : '归档所选');
  $('#bulkResult').hidden = !bulkResult;
  $('#bulkResult').dataset.status = bulkResult?.status || '';
  $('#bulkResultText').textContent = bulkResult?.message || '';
  $('#itemList').classList.toggle('is-selecting', bulkMode);
}
async function applyBulkArchive() {
  if (bulkBusy || !bulkMode) return;
  const ids = visibleItems().filter(item => bulkSelected.has(item.id) && bulkEligible(item)).map(item => item.id);
  if (!ids.length) return;
  const archived = !bulkRestoring();
  bulkBusy = true; bulkResult = null; render();
  try {
    const result = await api('/api/items/archive', { method: 'POST', body: JSON.stringify({ ids, archived }) });
    // Reflect the acknowledged write even if the following refresh loses connection.
    const updated = new Set(result.ids);
    for (const item of state.items) if (updated.has(item.id)) item.archived = archived;
    bulkSelected.clear(); bulkMode = false;
    bulkResult = { status: 'succeeded', message: archived ? `已归档 ${result.count} 条，可在“记录 → 已归档”中查看和恢复。` : `已恢复 ${result.count} 条。` };
    await sync();
  } catch (error) {
    bulkResult = { status: 'failed', message: `批量${archived ? '归档' : '恢复'}失败：${error.message === 'Failed to fetch' ? '无法连接事项服务，请检查连接后重试' : error.message}。` };
  } finally { bulkBusy = false; render(); }
}
function noticeMarkup(item) {
  const source = item.sourceName || SOURCE_NAMES[item.source] || '其他来源';
  const originalTitle = String(item.title || '通知').trim();
  // This legacy collector sentence is metadata, never the notice's content.
  const body = String(item.body || '').replace(/(?:^|\n)本条时间为首次采集时间。\s*$/u, '').trim();
  const fields = '课程名称|任务名称|作业名称|试卷名称|考试名称|考试时间|考试时长|答题时长|考试形式|开始时间|结束时间|互评开始时间|互评结束时间|活动名称|提示';
  const field = (label) => body.match(new RegExp(`(?:^|[\\s，,])${label}[：:]\\s*([\\s\\S]*?)(?=(?:[\\s，,]+)(?:${fields})[：:]|$)`, 'u'))?.[1]?.trim();
  const name = field('任务名称') || field('考试名称') || field('试卷名称') || field('作业名称') || field('活动名称');
  const course = field('课程名称');
  const generic = /^(?:[您你]?有一个学习任务[，,]?请及时查看|考试通知|作业结束提醒|互评开始通知|活动结束提醒|通知)[。！!]?$/u.test(originalTitle);
  const title = generic && name ? [course, name].filter(Boolean).join(' · ') : originalTitle;
  const formatted = body.replace(new RegExp(`[\\s，,]+(?=(?:${fields})[：:])`, 'gu'), '\n');
  const repeatsBody = body && (body === originalTitle || body.startsWith(originalTitle));
  const time = item.publishedAt ? shortTime(item.publishedAt) : item.timestampKind === 'collected' ? '发布时间未知' : `${item.timestampKind === 'observed' ? '检测于 ' : ''}${shortTime(item.createdAt)}`;
  return `<article class="item-row notice-entry${bulkSelected.has(item.id) ? ' is-selected' : ''}" data-item="${escapeHtml(item.id)}">${bulkMode ? selectionMarkup(item) : ''}<div class="notice-content"><div class="notice-meta"><span>${escapeHtml(source)}</span>${!item.read ? '<span class="unread-dot" aria-label="未读"></span>' : ''}<time>${escapeHtml(time)}</time></div>${repeatsBody ? '' : `<h2 class="notice-title">${escapeHtml(title)}</h2>`}<div class="notice-body${body ? '' : ' notice-missing'}">${body ? escapeHtml(formatted) : '尚未读取到通知正文，请到来源平台核对。'}</div><div class="notice-actions"><button type="button" data-action="make-task">加入待办</button>${!item.read ? '<button type="button" data-action="read">标为已读</button>' : ''}<button type="button" data-action="details">更多操作</button></div></div></article>`;
}
function itemMarkup(item) {
  if (state.view === 'notices') return noticeMarkup(item);
  const task = isTask(item), candidate = isCandidate(item);
  const source = item.sourceName || SOURCE_NAMES[item.source] || '其他来源';
  const title = String(item.title || '未命名事项').replace(/\s+/gu, ' ').slice(0, 100);
  const time = task ? item.due ? `${item.due < dateKey() && !item.done ? '逾期 · ' : '截止 '}${item.due}` : '未定日期' : shortTime(itemTime(item));
  const received = messageTime(item);
  const receivedLabel = received ? `${item.source === 'manual' ? '记录' : '收到'} ${messageClock.format(new Date(received))}` : '原消息时间未知';
  const end = task && state.view === 'tasks'
    ? `<time class="row-time message-time"${received ? ` datetime="${escapeHtml(received)}"` : ''}>${escapeHtml(receivedLabel)}</time><span class="row-due${item.due && item.due < dateKey() ? ' overdue' : ''}">${escapeHtml(item.due ? `${item.due < dateKey() ? '逾期 · 截止 ' : '截止 '}${item.due}` : '截止日期待确认')}</span>`
    : `<span class="row-time${task && item.due && item.due < dateKey() && !item.done ? ' overdue' : ''}">${escapeHtml(time)}</span>`;
  return `<article class="item-row${task && !bulkMode ? ' has-completion-action' : ''}${state.view === 'review' ? ' review-entry' : ''}${item.done ? ' is-done' : ''}${item.relevance === 'other' ? ' is-muted' : ''}${bulkSelected.has(item.id) ? ' is-selected' : ''}" data-item="${escapeHtml(item.id)}">
    ${bulkMode ? selectionMarkup(item) : task ? `<button class="task-complete" type="button" data-action="toggle-done" aria-label="${item.done ? '恢复未完成' : '标记完成'}">${item.done ? '恢复未完成' : '已完成'}</button>` : `<span class="record-mark ${candidate ? 'candidate-mark' : ''}" aria-hidden="true">${candidate ? '?' : '·'}</span>`}
    <button class="item-open" type="button" data-action="details"><span class="item-title">${escapeHtml(title)}</span><span class="item-subline"><span>${escapeHtml(source)}</span>${item.archived ? '<span>已归档</span>' : ''}${!task && !item.read ? '<span class="unread-dot" aria-label="未读"></span>' : ''}</span></button>
    <div class="row-end${state.view === 'tasks' ? ' task-dates' : ''}">${end}${candidate && state.view === 'review' && !bulkMode ? '<div class="review-actions"><button class="btn btn-sm btn-outline-secondary" data-action="make-task">确认</button><button class="btn btn-sm btn-outline-secondary" data-action="archive">归档</button></div>' : ''}</div>
  </article>`;
}
function openDetail(item) {
  const task = isTask(item), candidate = isCandidate(item);
  const autoHint = item.autoTask ? `<p class="detail-hint">${escapeHtml(item.triage?.reason || '已按关键词自动加入待办')}。${item.due ? '' : '截止日期待确认。'}识别有误可点“不是待办”。</p>` : '';
  $('#detailContent').innerHTML = `<div data-item="${escapeHtml(item.id)}"><div class="dialog-head"><div><span class="eyebrow">${escapeHtml(item.topic || (task ? '待办事项' : '消息记录'))}</span><h2>${escapeHtml(item.title)}</h2></div><button class="icon-button" data-close aria-label="关闭">×</button></div><p class="detail-meta">${escapeHtml(item.sourceName || SOURCE_NAMES[item.source] || '')}<br>${item.timestampKind === 'observed' ? '检测时间（非发布时间）' : item.timestampKind === 'collected' && !item.publishedAt ? '首次采集时间（发布时间未知）' : '发布时间'}：${escapeHtml(formatDate(itemTime(item), true))}${task ? `<br>截止日期：${escapeHtml(item.due || '待确认')}` : ''}</p><div class="detail-body">${escapeHtml(item.body || item.title)}</div>${candidate ? `<p class="detail-hint">${escapeHtml(item.triage?.reason || '')}。确认后才会进入待办。</p>` : ''}${item.triage?.relatedIds?.length ? `<p class="detail-hint">另有 ${item.triage.relatedIds.length} 条重复消息，已合并展示；原文在记录中保留。</p>` : ''}<div class="detail-actions">${task ? `<button class="btn btn-primary" data-action="toggle-done">${item.done ? '恢复未完成' : '标记完成'}</button>` : '<button class="btn btn-primary" data-action="make-task">加入待办</button>'}${candidate ? '<button class="btn btn-outline-secondary" data-action="dismiss-candidate">不是待办</button>' : ''}<button class="btn btn-outline-secondary" data-action="edit">编辑</button>${!item.read ? '<button class="btn btn-outline-secondary" data-action="read">标为已读</button>' : ''}<button class="btn btn-outline-secondary" data-action="archive">${item.archived ? '取消归档' : '归档'}</button>${isChat(item) ? '<button class="btn btn-ghost-secondary" data-action="context">上下文</button>' : ''}</div></div>`;
  if (autoHint) {
    $('.detail-body', $('#detailContent')).insertAdjacentHTML('afterend', autoHint);
    $('.detail-actions', $('#detailContent')).insertAdjacentHTML('beforeend', '<button class="btn btn-outline-secondary" data-action="dismiss-candidate">不是待办</button>');
  }
  $('#detailDialog').showModal();
}

function sourceStatus(source) {
  const info = state.sources[source] || {};
  const status = info.busy ? '正在同步' : { connected: '采集正常', partial: '部分读取成功', needs_login: '需要登录', offline: '已离线', error: '采集失败' }[info.status] || '尚未接入';
  const synced = info.lastSync ? `最近采集 ${formatDate(info.lastSync, true)}` : '尚无采集记录';
  return `<div class="settings-source"><div><strong>${SOURCE_NAMES[source]}</strong><span>${escapeHtml(synced)}</span>${info.message ? `<span>${escapeHtml(info.message)}</span>` : ''}</div><div class="source-status-actions"><span class="connection-state">${status}</span>${source === 'chaoxing' ? '<button class="secondary-button" type="button" data-connect-chaoxing>连接 / 管理</button>' : ['qq', 'wechat'].includes(source) ? `<button class="secondary-button" type="button" data-connect-chat="${source}">扫码 / 管理</button>` : '<small>账号接入尚未实现</small>'}</div></div>`;
}

function groupedMarkup(items) {
  if (state.view !== 'tasks') return items.map(itemMarkup).join('');
  const groups = new Map();
  for (const item of items) {
    const key = messageDateKey(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const today = messageDay.format(new Date());
  const yesterday = messageDay.format(new Date(Date.now() - 86400_000));
  return [...groups].map(([key, rows]) => {
    const [year, month, day] = key.split('-');
    const label = key === 'unknown' ? '原消息日期未知' : `${year}年${Number(month)}月${Number(day)}日`;
    const weekday = key === 'unknown' ? '' : messageWeekday.format(new Date(key + 'T00:00:00+08:00'));
    const relative = key === today ? '今天' : key === yesterday ? '昨天' : '';
    return `<section class="task-group message-date-group" data-message-date="${key}"><h2 class="message-date-heading">${key === 'unknown' ? `<strong>${label}</strong>` : `<time datetime="${key}">${label}</time>`}<span class="message-weekday">${weekday}</span>${relative ? `<span class="message-relative">${relative}</span>` : ''}<span class="message-group-count">${rows.length} 项</span></h2>${rows.map(itemMarkup).join('')}</section>`;
  }).join('');
}
function render() {
  // Compatibility for saved links and the context action.
  if (['inbox', 'today'].includes(state.view)) state.view = 'tasks';
  if (state.view === 'messages') state.view = 'records';
  $('#dateLabel').textContent = state.view === 'tasks' ? '按收到消息的时间' : dateLabel();
  const tasks = state.items.filter((i) => isTask(i) && !i.done && !i.archived);
  const candidates = state.items.filter((i) => isCandidate(i) && !i.archived && mainRelevant(i));
  $('#pendingCount').textContent = tasks.length || '';
  $('#reviewCount').textContent = candidates.length || '';
  $('#metricPending').textContent = tasks.length;
  $('#metricToday').textContent = tasks.filter((i) => i.due === dateKey()).length;
  $('#metricSources').textContent = Object.values(state.sources).filter((s) => s.status === 'connected').length;
  $('#followupPanel').hidden = true;
  $('#triageNotice').hidden = state.view !== 'tasks' || !candidates.length;
  $('#triageSummary').textContent = `${candidates.length} 条消息可能需要你处理，等待确认。`;
  $('#reviewCandidates').hidden = false; $('#showAttachments').hidden = true;
  $('#serverPulse').classList.toggle('online', state.connected);
  $('#serverLabel').textContent = state.connected ? '本机服务已连接' : '服务连接中断';
  $('#syncStatus').textContent = state.connected ? '已连接' : '连接中断';
  $('#syncStatus').classList.toggle('online', state.connected);
  const issues = Object.entries(state.sources).filter(([, s]) => ['error', 'offline', 'needs_login'].includes(s.status));
  $('#collectorNotice').hidden = state.connected && !issues.length;
  $('#collectorNotice').classList.add('source-issue');
  $('#collectorNotice').innerHTML = !state.connected ? '服务连接中断，当前显示上次获取的记录。' : `<span>${issues.map(([key]) => escapeHtml(SOURCE_NAMES[key] || key)).join('、')}的采集需要处理</span><button class="action-button" type="button" data-open-sources>查看原因 →</button>`;
  const collector = state.collector;
  $('#collectorDetails').textContent = state.localCollection ? '本机采集运行中。连接异常请查看对应平台。' : collector ? `${collector.name} · ${collector.online ? '在线' : '离线'}` : '尚未连接 Windows 采集端';
  $('#serviceMode').textContent = state.mode === 'cloud' ? '云端事项服务' : '仅本机运行';
  $('#serviceDescription').textContent = state.mode === 'cloud' ? '查看已同步事项；账号接入仍在 Windows 本机完成。' : '事项与账号设置保存在这台电脑。可在这里管理平台连接和自动采集，无需服务器或域名。';
  $('#phoneAccessNote').textContent = state.mode === 'cloud' ? '通过当前 HTTPS 网址访问，无需与电脑连接同一个 Wi-Fi。' : '当前版本仅供这台电脑使用，iPhone 暂不能远程访问。网站同步接口已保留，之后可扩展。';
  $('#inboxView').classList.remove('hidden'); $('#tasksView').classList.add('hidden');
  const timed = ['notices', 'records'].includes(state.view);
  $('#timeFilter').hidden = !timed || Boolean(state.messageContext) || ['done', 'archived'].includes(state.filter) && state.view === 'records';
  $('#noticeRange').value = state.view === 'records' ? state.messageRange : state.noticeRange;
  $('#topicFilter').hidden = state.view !== 'notices'; $('#topicFilter').value = state.topic;
  $('.filter-tabs').hidden = state.view !== 'records'; $('#rawMessagesLabel').hidden = true;
  $('#rawContext').hidden = !state.messageContext && !state.attachmentsOnly;
  $('#rawContextLabel').textContent = state.attachmentsOnly ? '仅显示尚未识别内容的图片或附件' : state.messageContext ? `${state.messageContext.sourceName} · 前后 15 分钟的已采集记录` : '';
  $('#noticeRangeNote').textContent = state.view === 'records' ? '保留原文，其他内容在这里查看' : '';
  const titles = { tasks: '待办', review: '待确认', notices: '通知', records: '记录' };
  const descriptions = { tasks: `${tasks.length} 项未完成 · 新消息在前，未完成事项持续保留`, review: '确认是否与你有关，再加入待办。', notices: '直接查看课程、考试和学习事项的完整通知。', records: '已采集的原文、完成事项和其他内容。' };
  $('#pageTitle').textContent = titles[state.view]; $('#pageDescription').textContent = descriptions[state.view];
  $$('.nav-item').forEach((b) => { b.classList.toggle('active', b.dataset.view === state.view); if (b.dataset.view === state.view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  const items = visibleItems();
  renderBulkControls(items);
  $('#resultCount').textContent = `${items.length} 项`;
  $('#listCaption').textContent = { tasks: '按原消息日期分组 · 北京时间', review: '等待你的确认', notices: '最近通知', records: '消息与事项记录' }[state.view];
  const empty = { tasks: ['没有未完成待办', '平台未交作业和你确认的事项会按原消息日期出现在这里。'], review: ['暂无待确认事项', '有具体事项、仍需判断是否与你有关的消息会出现在这里；简短催促和原始消息可在“记录”查看。'], notices: ['当前范围没有通知', '可以调整时间、主题或搜索关键词。'], records: ['当前范围没有记录', '尝试调整时间或筛选条件。'] }[state.view];
  const markup = items.length ? groupedMarkup(items) : `<div class="empty-state"><div class="empty-mark">${icon('check')}</div><strong>${state.search ? '没有找到匹配记录' : empty[0]}</strong><span>${state.search ? '试试其他关键词' : empty[1]}</span></div>`;
  const list = $('#itemList'); if (list._markup !== markup) { list.innerHTML = markup; list._markup = markup; }
  $$('.filter-tab').forEach((b) => b.classList.toggle('active', b.dataset.filter === state.filter));
  $('#settingsSources').innerHTML = ['wechat', 'qq', 'chaoxing', 'rainclass', 'csu'].map(sourceStatus).join('');
  $$('#sourceNav [data-connect-chat], #sourceNav [data-connect-chaoxing]').forEach((b) => { const key = b.dataset.connectChat || 'chaoxing'; const s = state.sources[key]; const label = b.querySelector('span'); if (label) { label.textContent = s?.status === 'connected' ? '已连接' : s?.status === 'partial' ? '需留意' : ['error', 'offline', 'needs_login'].includes(s?.status) ? '需处理' : '未连接'; label.className = s?.status === 'connected' ? 'source-ok' : ''; } });
}

async function api(path, options = {}) {
  const headers = Object.assign({ 'content-type': 'application/json' }, options.headers || {});
  const response = await fetch(path, Object.assign({ credentials: 'same-origin', signal: AbortSignal.timeout(12_000) }, options, { headers }));
  if (response.status === 401) {
    authenticated = false;
    $('#itemDialog').close();
    $('#settingsDialog').close();
    $('#accountDialog').close();
    $('#chatDialog').close();
    $('#detailDialog').close();
    if (!$('#pairDialog').open) $('#pairDialog').showModal();
    throw new Error('需要重新配对');
  }
  const value = await response.json();
    if (!response.ok) throw new Error(value.error || '请求失败');
  return value;
}

async function sync(silent = true) {
  const generation = ++syncGeneration;
  try {
    const data = await api('/api/state');
    if (generation !== syncGeneration) return;
    state.items = data.items || [];
    state.sources = data.sources || {};
    state.collector = data.collector;
    state.mode = data.mode;
    state.localAccountsEnabled = data.localAccountsEnabled;
    state.localCollection = data.localCollection;
    state.connected = true;
    authenticated = true;
    state.lastSync = data.updatedAt;
    render();
    const localSource = state.sources.chaoxing;
    // Do not replay a previous session's successful synchronization on opening.
    if (!activeOperation && localSource?.operationId && !localSource.busy) activeOperation = { id: localSource.operationId, status: 'observed' };
    if (state.localAccountsEnabled && localSource?.operationId && (localSource.operationId !== activeOperation?.id || localSource.busy !== (activeOperation?.status === 'running'))) void refreshAccount();
  } catch (error) {
    if (generation !== syncGeneration) return;
    state.connected = false;
    if (error.message !== '需要重新配对') {
      render();
      if (!silent) toast('无法连接事项服务');
    }
  }
}

function toast(message, duration = 2200) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove('show'), duration);
}

async function pair(code) {
  const response = await fetch('/api/pair', { method: 'POST', credentials: 'same-origin', signal: AbortSignal.timeout(12_000), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
  if (!response.ok) throw new Error(response.status === 429 ? '尝试过于频繁，请一分钟后再试' : '访问码不正确，请重新输入');
  authenticated = true;
  $('#pairDialog').close();
  $('#pairForm').reset();
  await sync(false);
}

async function saveItem(form) {
  const data = new FormData(form);
  const input = { title: data.get('title'), body: data.get('body'), category: data.get('category'), due: data.get('due') };
  if (input.due || promotingToTask) input.kind = 'task';
  if (editingId) { input.confirmed = true; await api(`/api/items/${editingId}`, { method: 'PATCH', body: JSON.stringify(input) }); }
  else { input.source = data.get('source'); await api('/api/items', { method: 'POST', body: JSON.stringify(input) }); }
  form.reset();
  $('#itemDialog').close();
  await sync();
  toast('已记下');
}

function openItem(item = null, { promote = false } = {}) {
  $('#detailDialog').close();
  const form = $('#itemForm');
  form.reset();
  editingId = item?.id || null;
  promotingToTask = promote;
  form.elements.body.readOnly = false;
  form.elements.source.disabled = false;
  for (const key of ['title', 'body', 'category', 'source', 'due']) if (item) form.elements[key].value = item[key] || '';
  form.elements.body.readOnly = Boolean(item?.externalId);
  form.elements.source.disabled = Boolean(item);
  $('#itemFormEyebrow').textContent = item ? '确认事项' : '新事项';
  $('#itemFormTitle').textContent = promote ? '确认需要你处理的事项' : item ? '核对内容和截止日期' : '记下，不要漏掉';
  $('#itemForm [type=submit]').textContent = promote ? '确认加入待办' : '保存事项';
  $('#itemDialog').showModal();
}

async function updateItem(item, patch) {
  await api(`/api/items/${item.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
  await sync();
}

document.addEventListener('click', async (event) => {
  if (event.target.closest('#bulkToggle')) { if (!bulkBusy) { bulkMode = !bulkMode; bulkSelected.clear(); bulkResult = null; render(); } return; }
  if (event.target.closest('#bulkApply')) { await applyBulkArchive(); return; }
  if (event.target.closest('#bulkResultClose')) { bulkResult = null; render(); return; }
  const close = event.target.closest('[data-close]');
  if (close) { close.closest('dialog').close(); return; }
  if (event.target.closest('#addButton') || event.target.closest('[data-empty-add]')) { openItem(); return; }
  if (event.target.closest('[data-connect-chaoxing]')) { await openAccount(); return; }
  const chatButton = event.target.closest('[data-connect-chat]');
  if (chatButton) { await openChat(chatButton.dataset.connectChat); return; }
  if (event.target.closest('#settingsBtn') || event.target.closest('#mobileSettingsBtn') || event.target.closest('#connectSourcesBtn') || event.target.closest('[data-open-sources]')) { $('#settingsDialog').showModal(); return; }
  if (event.target.closest('#followupAll')) { state.view = 'tasks'; render(); return; }
  if (event.target.closest('#reviewCandidates')) { state.view = 'review'; state.filter = 'all'; state.search = ''; $('#searchInput').value = ''; render(); return; }
  if (event.target.closest('#showAttachments')) { state.view = 'records'; state.filter = 'all'; state.attachmentsOnly = true; state.messageContext = null; state.search = ''; $('#searchInput').value = ''; render(); return; }
  if (event.target.closest('#clearRawContext')) { state.messageContext = null; state.attachmentsOnly = false; render(); return; }
  const followup = event.target.closest('[data-followup-item]');
  if (followup) { const item = state.items.find((entry) => entry.id === followup.dataset.followupItem); if (item) openItem(item); return; }
  const view = event.target.closest('[data-view]');
  if (view) { state.view = view.dataset.view; state.filter = 'all'; state.messageContext = null; state.attachmentsOnly = false; state.search = ''; $('#searchInput').value = ''; render(); return; }
  const filter = event.target.closest('[data-filter]');
  if (filter) { state.filter = filter.dataset.filter; $$('.filter-tab').forEach((button) => button.classList.toggle('active', button === filter)); render(); return; }
  const action = event.target.closest('[data-action]');
  if (action) {
    const row = action.closest('[data-item]');
    const item = state.items.find((entry) => entry.id === row?.dataset.item);
    if (!item) return;
    if (action.dataset.action === 'details') {
      if (bulkMode && action.closest('#itemList')) { if (!bulkBusy && bulkEligible(item)) { if (bulkSelected.has(item.id)) bulkSelected.delete(item.id); else bulkSelected.add(item.id); render(); } }
      else openDetail(item);
      return;
    }
    if (action.dataset.action === 'edit') { openItem(item); return; }
    if (action.dataset.action === 'make-task') { openItem(item, { promote: true }); return; }
    if (action.dataset.action === 'context') {
      $('#detailDialog').close();
      state.view = 'records'; state.filter = 'all'; state.attachmentsOnly = false; state.search = ''; $('#searchInput').value = '';
      state.messageContext = { source: item.source, sourceName: item.sourceName, time: Date.parse(item.publishedAt || item.createdAt) };
      render(); return;
    }
    try {
      $('#detailDialog').close();
      if (action.dataset.action === 'toggle-done') {
        const done = !item.done;
        await updateItem(item, { done, read: true });
        toast(done ? '已标记完成，可在“记录 → 已完成”中查看和恢复' : '已恢复为未完成，可在“待办”中继续处理', 5000);
      }
      if (action.dataset.action === 'dismiss-candidate') { await updateItem(item, { ...(item.autoTask ? { kind: 'notification' } : {}), triageDecision: 'dismissed', read: true }); toast('已排除，原文保留在记录中'); }
      if (action.dataset.action === 'read') await updateItem(item, { read: true });
      if (action.dataset.action === 'archive') { const archived = !item.archived; await updateItem(item, { archived }); toast(archived ? '已归档，可在记录中恢复' : '已恢复'); }
    } catch { toast('保存失败，请检查连接'); }
  }
});

$('#itemForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try { await saveItem(event.currentTarget); }
  catch (error) { toast(error.message || '保存失败，请检查连接'); }
});

$('#pairForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#pairError').hidden = true;
  try { await pair(new FormData(event.currentTarget).get('code').trim()); }
  catch (error) { $('#pairError').textContent = error.message === 'Failed to fetch' ? '无法连接事项服务，请检查网络' : error.message; $('#pairError').hidden = false; }
});

$('#searchInput').addEventListener('input', (event) => { state.search = event.target.value; render(); });
document.addEventListener('change', (event) => {
  if (!bulkMode || bulkBusy) return;
  if (event.target.id === 'bulkSelectAll') {
    const checked = event.target.checked;
    bulkSelected.clear();
    if (checked) for (const item of visibleItems().filter(bulkEligible)) bulkSelected.add(item.id);
    render();
  } else if (event.target.matches('[data-select-item]')) {
    const id = event.target.dataset.selectItem;
    if (visibleItems().some(item => item.id === id && bulkEligible(item))) {
      if (event.target.checked) bulkSelected.add(id); else bulkSelected.delete(id);
      render();
    }
  }
});

function showAccountError(message) { $('#accountError').textContent = message; $('#accountError').hidden = false; }
const operationTitles = { running: '正在同步学习通', succeeded: '同步完成', partial: '同步完成，部分内容未读取', verification_required: '需要学习通安全验证', failed: '同步失败' };
function showOperation(operation, fromOpening = false) {
  if (!operation?.id || operation.status === 'idle') return;
  activeOperation = operation;
  const key = `${operation.id}:${operation.status}`;
  if (dismissedOperation === key) return;
  $('#operationNotice').hidden = false;
  $('#operationNotice').dataset.status = operation.status;
  $('#operationTitle').textContent = operationTitles[operation.status] || '同步结果';
  $('#operationDescription').textContent = operation.message;
  if (!fromOpening && lastResultKey !== key && operation.status !== 'running') toast(operationTitles[operation.status] || '同步已结束');
  lastResultKey = key;
}
function renderAccount() {
  if (!accountInfo) return;
  const info = accountInfo;
  const operation = info.operation || { status: 'idle' };
  $('#accountTitle').textContent = info.configured ? '学习通连接详情' : '连接学习通';
  $('#accountIntro').hidden = info.configured;
  $('#accountStatus').textContent = `${info.account ? info.account + ' · ' : ''}${({ authenticated: '账号已登录', checking: '正在检查登录状态', expired: '登录已失效' }[info.loginState]) || (info.configured ? '已配置账号' : '尚未连接账号')}`;
  $('#accountStatus').dataset.state = info.loginState || 'disconnected';
  $('#accountOutcome').hidden = operation.status === 'idle';
  $('#accountOutcome').dataset.status = operation.status;
  $('#accountOutcomeTitle').textContent = operationTitles[operation.status] || '';
  $('#accountOutcomeMessage').textContent = operation.message || '';
  $('#accountOutcomeTime').textContent = operation.finishedAt ? `本轮结束于 ${formatDate(operation.finishedAt, true)}` : operation.startedAt ? `开始于 ${formatDate(operation.startedAt, true)}` : '';
  const stats = operation.stats;
  $('#accountMetrics').hidden = !stats;
  if (stats) $('#accountMetrics').innerHTML = `<div><strong>${stats.tasksRead}</strong><span>读取的未交作业</span></div><div><strong>${stats.noticesRead}</strong><span>近 ${stats.noticesDays} 天通知</span></div><div><strong>${stats.coursesRead}/${stats.coursesTotal}</strong><span>作业读取成功的课程</span></div>`;
  $('#accountForm').hidden = !state.localAccountsEnabled || (info.configured && !accountEditing);
  $('#accountActions').hidden = !info.configured || !state.localAccountsEnabled;
  $('#accountForm [name=remember]').disabled = !info.canRemember;
  $('#accountLoginBtn').disabled = accountSubmitting || info.busy;
  $('#accountSyncBtn').disabled = info.busy || accountSubmitting;
  $('#accountSyncBtn').textContent = info.busy ? '正在同步…' : info.verificationWindowOpen && operation.status !== 'succeeded' ? '已完成验证，继续同步' : operation.status === 'verification_required' ? '重新尝试同步' : '立即同步';
  $('#accountVerification').hidden = !(info.verificationAvailable || info.browserAvailable) || !state.localAccountsEnabled || operation.status === 'succeeded';
  $('#verificationTitle').textContent = operation.status === 'verification_required' ? '作业读取需要安全验证' : '通过浏览器读取作业';
  $('#accountVerifyBtn').disabled = info.busy || accountSubmitting;
  $('#accountVerifyBtn').textContent = info.verificationWindowOpen ? '重新打开验证页面' : '打开学习通验证窗口';
  $('#accountDisconnectBtn').disabled = info.busy || accountSubmitting;
  $('#accountReconnectBtn').disabled = info.busy || accountSubmitting;
  $('#accountSaveNote').textContent = info.configured ? operation.status === 'verification_required' ? '自动重试已暂停。请使用上方的验证窗口完成验证，再继续同步；普通浏览器窗口的验证状态不会自动传给软件。' : info.verificationWindowOpen ? '作业通过验证窗口读取，请保持该窗口打开。运行期间每 5 分钟自动同步。' : '运行期间每 5 分钟自动同步。通知仅作信息记录，需要处理的可手动加入待办。' : '';
  $('#accountSettings').hidden = !info.configured;
  $('#accountSettingsNote').textContent = info.remembered ? '账号已由 Windows 加密保存，重启本机服务后自动恢复。' : '账号仅在本次运行有效，关闭本机服务后需要重新登录。';
  const resultMarkup = `${info.warnings?.length ? `<details class="account-warnings" data-detail-key="warnings"><summary>查看未读取内容及原因（${info.warnings.length}）</summary><ul>${info.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul></details>` : ''}${info.courses?.length ? `<details class="account-course-details" data-detail-key="courses"><summary>查看已识别的 ${info.courses.length} 门课程</summary><ul class="account-courses">${info.courses.map((c) => `<li>${escapeHtml(c.name)}</li>`).join('')}</ul></details>` : ''}${stats?.skippedOld ? `<p class="history-note">本轮已跳过 ${stats.skippedOld} 条超过 7 天的历史通知。</p>` : ''}`;
  const results = $('#accountResults');
  if (results._markup !== resultMarkup) {
    const expanded = new Set($$('details[open]', results).map((el) => el.dataset.detailKey));
    results.innerHTML = resultMarkup; results._markup = resultMarkup;
    $$('details', results).forEach((el) => { el.open = expanded.has(el.dataset.detailKey); });
  }
  showOperation(operation, true);
}
async function refreshAccount() {
  if (!state.localAccountsEnabled || accountSubmitting) return;
  const request = ++accountRequest;
  try { const info = await api('/api/accounts/chaoxing'); if (request !== accountRequest || accountSubmitting) return; accountInfo = info; showOperation(info.operation); renderAccount(); }
  catch (error) { if ($('#accountDialog').open) showAccountError('无法获取同步结果：' + error.message); }
}
async function openAccount() {
  $('#settingsDialog').close();
  $('#accountError').hidden = true;
  $('#accountForm').reset(); accountEditing = false; $('#disconnectConfirm').hidden = true; $('#accountSettings').open = false;
  $('#accountDialog').showModal();
  $('#accountLocalNote').hidden = Boolean(state.localAccountsEnabled);
  $('#accountForm').hidden = !state.localAccountsEnabled;
  if (state.localAccountsEnabled) await refreshAccount();
  else { $('#accountStatus').textContent = '当前入口仅能查看事项，请前往 Windows 本机连接账号。'; $('#accountActions').hidden = true; $('#accountResults').textContent = ''; $('#accountSaveNote').textContent = ''; }
}
$('#accountForm').addEventListener('submit', async (event) => {
  event.preventDefault(); if (accountSubmitting) return;
  const form = event.currentTarget; const data = new FormData(form);
  accountSubmitting = true; $('#accountError').hidden = true; $('#accountLoginBtn').disabled = true;
  accountRequest++;
  const connectedBefore = Boolean(accountInfo?.configured);
  $('#accountStatus').textContent = '正在登录学习通，请稍候…';
  try {
    accountInfo = await api('/api/accounts/chaoxing', { method: 'POST', signal: AbortSignal.timeout(60_000), body: JSON.stringify({ phone: data.get('phone'), password: data.get('password'), remember: data.get('remember') === 'on' }) });
    form.reset(); accountEditing = false; toast('登录成功，开始同步'); showOperation(accountInfo.operation); await sync();
  } catch (error) { form.elements.password.value = ''; showAccountError(error.name === 'TimeoutError' ? '登录请求超时，正在重新查询连接状态；请勿重复提交。' : `登录失败：${error.message}${connectedBefore ? '。原账号连接仍保留。' : ''}`); }
  finally { accountSubmitting = false; await refreshAccount(); }
});
$('#accountSyncBtn').addEventListener('click', async () => {
  $('#accountError').hidden = true;
  $('#accountSyncBtn').disabled = true;
  try { accountInfo = await api('/api/accounts/chaoxing/sync', { method: 'POST', body: '{}' }); showOperation(accountInfo.operation); renderAccount(); }
  catch (error) { showAccountError('无法开始同步：' + error.message); $('#accountSyncBtn').disabled = false; }
});
$('#accountVerifyBtn').addEventListener('click', async () => {
  if (accountSubmitting) return;
  accountSubmitting = true; accountRequest++; $('#accountError').hidden = true;
  $('#accountVerifyBtn').disabled = true; $('#verificationMessage').textContent = '正在打开 Edge，请稍候…';
  try {
    accountInfo = await api('/api/accounts/chaoxing/verification', { method: 'POST', signal: AbortSignal.timeout(60_000), body: '{}' });
    $('#verificationMessage').textContent = accountInfo.verificationMessage; toast('验证窗口已打开，请在 Edge 中完成验证');
  } catch (error) { $('#verificationMessage').textContent = ''; showAccountError('无法打开验证窗口：' + error.message); }
  finally { accountSubmitting = false; await refreshAccount(); }
});
$('#accountReconnectBtn').addEventListener('click', () => { accountEditing = !accountEditing; renderAccount(); if (accountEditing) $('#accountForm [name=phone]').focus(); });
$('#accountDisconnectBtn').addEventListener('click', () => { $('#disconnectConfirm').hidden = false; });
$('#cancelDisconnectBtn').addEventListener('click', () => { $('#disconnectConfirm').hidden = true; });
$('#confirmDisconnectBtn').addEventListener('click', async () => {
  try { accountInfo = await api('/api/accounts/chaoxing', { method: 'DELETE', body: '{}' }); accountEditing = false; activeOperation = null; $('#operationNotice').hidden = true; $('#accountForm').reset(); $('#disconnectConfirm').hidden = true; renderAccount(); await sync(); toast('已断开学习通，已采集内容保留'); }
  catch (error) { showAccountError(error.message); }
});
$('#dismissOperation').addEventListener('click', () => { dismissedOperation = activeOperation ? `${activeOperation.id}:${activeOperation.status}` : null; $('#operationNotice').hidden = true; });
$('#noticeRange').addEventListener('change', (event) => { if (state.view === 'records') state.messageRange = event.target.value; else state.noticeRange = event.target.value; render(); });
$('#accountDialog').addEventListener('close', () => { $('#accountForm [name=password]').value = ''; });
setInterval(() => { if (authenticated && state.localAccountsEnabled && ($('#accountDialog').open || activeOperation?.status === 'running')) { void refreshAccount(); void sync(); } }, 1500);

$('#pairDialog').addEventListener('cancel', (event) => event.preventDefault());
$('#logoutButton').addEventListener('click', async () => {
  try {
    await api('/api/logout', { method: 'POST' });
    authenticated = false;
    state.items = []; state.sources = {}; state.collector = null; state.connected = false;
    render();
    $('#settingsDialog').close(); $('#pairDialog').showModal();
  } catch { toast('退出失败，请重试'); }
});
sync(false);
setInterval(() => { if (authenticated) sync(); }, 15_000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });

$('#topicFilter').addEventListener('change', (event) => { state.topic = event.target.value; render(); });
// Tabler components use the existing native dialogs and event handlers.
$$('.add-button').forEach((el) => el.classList.add('btn', 'btn-primary'));
$$('.secondary-button').forEach((el) => el.classList.add('btn', 'btn-outline-secondary'));
$$('.form-field input:not([type=checkbox]), .form-field textarea').forEach((el) => el.classList.add('form-control'));
$$('.form-field select').forEach((el) => el.classList.add('form-select'));
