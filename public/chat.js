'use strict';
let chatPlatform = 'qq';
let chatInfo = null;
let chatRequest = 0;
let chatWorking = false;
let chatListed = false;
let chatImageKey = '';
let chatRememberDirty = false;
let chatChecked = new Map();
let chatCheckFeedback = null;
const chatName = () => chatPlatform === 'qq' ? 'QQ' : '微信';
function chatError(message) { $('#chatError').textContent = message; $('#chatError').hidden = !message; }
function chatConnectionReady(info) {
  return info.loginState === 'authenticated' && info.collectionState === 'collecting'
    && info.status === 'connected' && Boolean(info.groups?.length)
    && !info.errors?.length && !info.hasGaps && !info.selection?.error
    && (!info.history || info.history.status === 'completed');
}
function chatNeedsAttention(info) {
  return info.collectionState === 'partial' || info.history?.status === 'partial'
    || Boolean(info.errors?.length || info.hasGaps || info.selection?.error)
    || info.status === 'partial' && info.collectionState === 'collecting' && info.history?.status !== 'running';
}
function chatHeadline(info) {
  const name = chatName();
  if (info.loginState === 'authenticated') {
    if (info.status === 'error' || info.collectionState === 'error') return `${name}采集失败`;
    if (info.status === 'offline' || info.collectionState === 'offline') return `${name}采集已中断`;
    if (info.collectionState === 'unsupported') return `${name}已登录，消息读取不可用`;
    if (chatNeedsAttention(info)) return `${name}已连接，部分内容需处理`;
    if (collectingHistory(info)) return `${name}已连接，正在补读近期消息`;
    if (chatConnectionReady(info)) return `${name}连接成功`;
    if (info.collectionState === 'collecting') return chatPlatform === 'qq' ? 'QQ 已登录，消息通道已连接' : '微信已连接，正在采集';
    if (info.collectionState === 'needs_groups') return `${name}已连接，请选择群聊`;
    if (info.collectionState === 'discovering') return `${name}已连接，正在识别学习群`;
    return info.busy ? '正在检查连接' : `${name}已登录，采集尚未就绪`;
  }
  return ({ starting: '正在启动扫码登录', waiting_scan: chatPlatform === 'qq' ? '等待手机扫码确认' : '等待电脑微信登录', confirming: '正在完成登录', disconnected: '尚未连接', not_running: '微信尚未打开', unreadable: '已检测到微信，消息读取不可用', needs_key: '需要初始化本机消息读取', initializing: '正在初始化，请等待微信进入', setup_failed: '初始化未完成，可重试' })[info.loginState] || (info.busy ? '正在检查连接' : '需要重新登录');
}
function collectingHistory(info) { return info.collectionState === 'collecting' && info.history?.status === 'running'; }
function renderCheckFeedback() {
  const el = $('#chatCheckResult');
  el.hidden = !chatCheckFeedback;
  if (!chatCheckFeedback) return;
  el.textContent = chatCheckFeedback.message;
  el.dataset.status = chatCheckFeedback.status;
}
function renderChat(info) {
  chatInfo = info;
  const login = info.loginState === 'authenticated';
  const local = state.localAccountsEnabled;
  const collecting = info.collectionState === 'collecting';
  const ready = chatConnectionReady(info);
  if (ready && chatCheckFeedback?.connectionProblem) chatCheckFeedback = null;
  const database = info.mode === 'local_database';
  const automatic = info.selection?.mode === 'auto';
  $('#chatLoginStep').classList.toggle('complete', login);
  $('#chatGroupStep').classList.toggle('complete', Boolean(info.groups?.length));
  $('#chatCollectStep').classList.toggle('complete', collecting);
  $('#chatCollectStep').textContent = collecting ? '已开启采集' : '开启采集';
  $('#chatHealth').hidden = !local || !info.enabled;
  $('#chatLastChecked').textContent = info.lastCheckedAt ? formatDate(info.lastCheckedAt, true) : '尚未检查';
  $('#chatLastMessage').textContent = info.lastMessageAt ? formatDate(info.lastMessageAt, true) : '本次运行尚未采集到';
  $('#chatGroupStatus').hidden = !login || !info.groupStatus?.length;
  $('#chatHealthDetails').hidden = !login || !info.groupStatus?.length;
  $('#chatGroupStatus').innerHTML = (info.groupStatus || []).map((g) => `<li data-ready="${Boolean(g.ready)}"><span>${escapeHtml(g.name)}</span><strong>${g.ready ? database ? '消息库可读取' : '窗口可读取' : '读取未完成'}</strong></li>`).join('');
  $('#chatCheck').disabled = chatWorking || info.busy;
  $('#chatHeadline').textContent = chatHeadline(info);
  $('#chatStatus').textContent = local ? (info.account ? `账号：${info.account}。` : '') + (info.message || '') : '请在 Windows 电脑上打开 http://localhost:4317 扫码接入；手机页面用于查看已采集的事项。';
  $('#chatOutcome').dataset.status = ['error', 'offline'].includes(info.status) ? 'failed' : ready ? 'succeeded' : login && !chatNeedsAttention(info) ? 'running' : 'partial';
  $('#chatFinishSection').hidden = !ready;
  $('#chatStart').hidden = login || ['unreadable', 'needs_key', 'initializing', 'setup_failed'].includes(info.loginState);
  $('#chatStart').disabled = !local || info.busy || chatWorking;
  $('#chatStart').textContent = chatPlatform === 'wechat' ? '打开微信登录窗口' : info.enabled ? '重新启动扫码登录' : '生成登录二维码';
  $('#chatRefresh').hidden = login || !info.enabled || ['unreadable', 'needs_key', 'initializing', 'setup_failed'].includes(info.loginState);
  $('#chatRefresh').disabled = !local || info.busy || chatWorking;
  $('#chatDisconnect').hidden = !local || !info.enabled;
  $('#chatGroupsSection').hidden = !login || !local;
  $('#chatSaveGroups').disabled = chatWorking || info.busy;
  $('#chatLoadGroups').disabled = chatWorking || info.busy;
  $('#chatRemember').disabled = !local || chatWorking;
  $('#chatInitializeSection').hidden = chatPlatform !== 'wechat' || !local || !['needs_key', 'setup_failed', 'unreadable'].includes(info.loginState);
  $('#chatInitialize').disabled = chatWorking || info.busy;
  $('#chatManualGroupField').hidden = automatic || chatPlatform !== 'wechat' || database || !login;
  if (chatPlatform === 'wechat' && database) {
    $('#chatIntro').textContent = '登录后自动识别学习相关群，补读近 7 天电脑已缓存的消息，随后持续采集；免打扰群也支持。';
    $('#chatSaveNote').textContent = '登录状态由官方微信保存；本软件用 Windows 加密保存本机读取密钥和选群设置。软件重启后静默恢复读取，无需保持群窗口打开；电脑微信须保持登录，离线和未同步的消息会影响读取范围。';
    if (!chatListed) $('#chatGroupNote').textContent = '仅采集勾选群。免打扰群也能读取；历史限于电脑微信已同步的数据。保存后会显示补读结果。';
  }
  if (!chatRememberDirty) $('#chatRemember').checked = info.remembered !== false;
  $('#chatSaveGroups').hidden = automatic && !chatRememberDirty;
  if (automatic) {
    $('#chatGroupStep').textContent = '自动识别学习群';
    $('#chatGroupStep').classList.toggle('complete', Boolean(info.selection.lastScan));
    $('#chatGroupNote').textContent = '自动采集学习相关群，每 10 分钟重新检查。生活社交群淡化；识别不准时可以在下方纠正。';
    $('#chatSelectionSummary').textContent = `已自动接入 ${info.selection.included} 个群 · ${info.selection.unknown} 个暂未确定${info.selection.pending ? `。另外 ${info.selection.pending} 个群正在后台识别${collecting ? '，不影响已接入群的采集' : ''}。` : ''}`;
    const markup = (info.selection.groups || []).map((g) => `<div class="chat-group"><div><strong>${escapeHtml(g.name)}</strong><span class="badge ${escapeHtml(g.relevance)}">${g.included ? '采集中' : g.relevance === 'unknown' ? '待识别' : '已淡化'}</span><small>${escapeHtml(g.error || g.reason || '')}${g.muted ? ' · 免打扰群' : ''}</small></div><select class="form-select form-select-sm" data-group-decision="${escapeHtml(g.id)}" aria-label="纠正 ${escapeHtml(g.name)} 的识别"><option value="auto" ${g.decision === 'auto' ? 'selected' : ''}>自动判断</option><option value="include" ${g.decision === 'include' ? 'selected' : ''}>应当采集</option><option value="exclude" ${g.decision === 'exclude' ? 'selected' : ''}>不必采集</option></select></div>`).join('') || '<p class="settings-intro">正在发现当前账号的群聊…</p>';
    const list = $('#chatGroupList'); if (list._markup !== markup && !list.contains(document.activeElement)) { list.innerHTML = markup; list._markup = markup; }
  }
  const expired = info.qrExpiresAt && Date.parse(info.qrExpiresAt) <= Date.now();
  $('#chatQr').hidden = !local || !info.qrAvailable || login;
  $('#chatQrImage').hidden = Boolean(expired);
  $('#chatQrNote').textContent = expired ? '二维码已过期，请点击“刷新二维码”。' : chatPlatform === 'wechat' ? '这是官方微信登录窗口。请用手机微信扫描其中的二维码，并在手机确认。' : '请使用手机 QQ 扫码，在手机上确认登录。二维码过期后可刷新。';
  const key = `${chatPlatform}:${info.qrVersion}`;
  if (local && info.qrAvailable && !expired && key !== chatImageKey) { chatImageKey = key; $('#chatQrImage').src = `/api/accounts/${chatPlatform}/qr.png?v=${encodeURIComponent(info.qrVersion)}`; }
  $('#chatWarnings').hidden = !info.errors?.length;
  $('#chatWarnings').innerHTML = info.errors?.length ? '<strong>以下内容未能完整采集</strong><ul>' + info.errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('') + '</ul>' : '';
  $('#chatAcknowledge').hidden = !local || !info.hasGaps;
  $('#chatAcknowledge').disabled = chatWorking || info.busy;
  const history = info.history;
  const connectionResult = $('#chatConnectionResult');
  connectionResult.hidden = !login || !history || !info.groups?.length;
  connectionResult.dataset.status = ['error', 'offline'].includes(info.status) ? 'failed' : history?.status === 'completed' && info.status === 'connected' ? 'succeeded' : 'partial';
  connectionResult.textContent = history ? history.status === 'completed' ? `近期历史补读已结束：${history.completed}/${history.total} 个群，已读取 ${history.kept} 条记录。${collecting ? '持续采集已开启。' : '当前采集状态请查看上方提示。'}` : history.status === 'partial' ? `本轮补读部分失败：${history.completed}/${history.total} 个群结束。请查看下方失败原因，可重新补读。` : `近期历史补读中：${history.completed}/${history.total} 个群结束，已读取 ${history.kept} 条记录。` : '';
  renderCheckFeedback();
  $('#chatHistory').hidden = !(chatPlatform === 'qq' || database) || !login || !info.groups?.length;
  $('#chatReadHistory').disabled = chatWorking || info.busy || history?.status === 'running';
  $('#chatHistorySummary').textContent = history ? `${history.status === 'running' ? '正在读取' : history.status === 'partial' ? '部分群补读失败，可重试' : '本轮补读结束'}：${history.completed}/${history.total} 个群结束，扫描 ${history.scanned} 条，已读取 ${history.kept} 条近 7 天消息。同一条消息重复补读不会重复入库。${database ? '范围限于电脑已同步的缓存，无法保证手机上的全部历史均已读取。' : ''}` : '等待开始补读';
  $('#chatHistoryGroups').innerHTML = (history?.groups || []).map((g) => `<li data-ready="${['completed', 'available'].includes(g.status)}"><span>${escapeHtml(g.name)}</span><strong>${escapeHtml(({ pending: '等待补读', running: '正在读取', completed: '已读至 7 天前', available: database ? '本机缓存补读结束' : '已读至平台可提供范围', partial: '补读未完成' })[g.status])}</strong>${g.message ? `<small>${escapeHtml(g.message)}</small>` : ''}</li>`).join('');
  if (!automatic && login && !chatListed && !info.busy && !chatWorking) void loadChatGroups();
}
async function refreshChat() {
  if (!$('#chatDialog').open || !state.localAccountsEnabled || chatWorking) return;
  const platform = chatPlatform; const request = ++chatRequest;
  try { const info = await api(`/api/accounts/${platform}`); if (request === chatRequest && platform === chatPlatform) renderChat(info); }
  catch (e) { if (request === chatRequest) chatError('无法获取连接状态：' + e.message); }
}
async function openChat(platform) {
  chatPlatform = platform; ++chatRequest; chatWorking = false; chatListed = false; chatInfo = null; chatImageKey = ''; chatRememberDirty = false; chatChecked = new Map(); chatCheckFeedback = null;
  $('#settingsDialog').close(); $('#chatTitle').textContent = `连接${chatName()}`;
  $('#chatIntro').textContent = platform === 'qq' ? '手机扫码登录后自动识别学习群，补读近期消息并持续采集。无需逐个勾选群聊。' : '登录后自动识别学习相关群，补读近 7 天电脑已缓存的消息；免打扰群也支持。';
  $('#chatSaveNote').textContent = platform === 'qq' ? 'QQ 客户端保存登录凭据，本软件保存自动连接及群聊设置。登录凭据有效时自动恢复；过期、被踢下线或平台要求验证时需重新扫码。' : '登录状态由官方微信保存。本软件加密保存本机读取密钥和群聊设置，重启后静默恢复。首次初始化重启一次微信；微信要求手机确认时仍需你确认。';
  $('#chatGroupNote').textContent = platform === 'qq' ? '保存所选群后自动补读近 7 天可获取的历史，保留原发布时间，同时持续接收新消息。' : '仅采集勾选群。免打扰群也能读取，无需打开聊天窗口；历史限于电脑微信已同步的数据。';
  $('#chatManualGroupField').hidden = true; $('#chatManualGroups').value = ''; $('#chatGroupList').replaceChildren(); $('#chatGroupList')._markup = ''; $('#chatSelectionDetails').open = false; $('#chatSaved').textContent = ''; chatError('');
  renderChat({ loginState: 'disconnected', message: '正在读取状态…', groups: [], remembered: true });
  $('#chatDialog').showModal(); await refreshChat();
}
async function loadChatGroups() {
  if (chatWorking || !chatInfo || chatInfo.loginState !== 'authenticated') return;
  const platform = chatPlatform; chatListed = true; chatWorking = true; chatError('');
  $('#chatLoadGroups').disabled = true;
  try {
    const result = await api(`/api/accounts/${platform}/groups`, { signal: AbortSignal.timeout(45000) }); if (platform !== chatPlatform) return;
    const selected = new Map((chatInfo.groups || []).map((g) => [g.id, g]));
    for (const [id, value] of chatChecked) value ? selected.set(id, value) : selected.delete(id);
    const all = new Map([...(chatInfo.groups || []), ...result.groups].map((g) => [g.id, g]));
    $('#chatGroupList').innerHTML = [...all.values()].map((g) => `<label class="chat-group"><input type="checkbox" value="${escapeHtml(g.id)}" data-name="${escapeHtml(g.name)}" ${selected.has(g.id) ? 'checked' : ''}><span>${escapeHtml(g.name)}${platform === 'qq' ? `<small>群号 ${escapeHtml(g.id)}</small>` : g.muted ? '<small>免打扰群 · 支持采集</small>' : ''}</span></label>`).join('') || '<p class="settings-intro">暂未读取到群聊，请确认已登录正确账号并同步了群聊数据。</p>';
    if (result.message) $('#chatGroupNote').textContent = result.message + (platform === 'wechat' && chatInfo.mode !== 'local_database' ? ' 所选群需在微信中双击打开独立聊天窗口并保持打开。' : '');
  } catch (e) { if (platform === chatPlatform) chatError('群列表读取失败：' + e.message); }
  finally { if (platform === chatPlatform) { chatWorking = false; renderChat(chatInfo); } }
}
async function chatAction(work) {
  if (chatWorking) return;
  const platform = chatPlatform; const request = ++chatRequest;
  chatWorking = true; chatError(''); renderChat(chatInfo);
  try { const info = await work(platform); if (request === chatRequest && platform === chatPlatform) { chatInfo = info; void sync(); } }
  catch (e) { if (request === chatRequest && platform === chatPlatform) chatError(e.message); }
  finally { if (request === chatRequest && platform === chatPlatform) { chatWorking = false; renderChat(chatInfo); } }
}
$('#chatStart').addEventListener('click', () => chatAction((p) => api(`/api/accounts/${p}/qr`, { method: 'POST', body: JSON.stringify({ remember: $('#chatRemember').checked }) })));
$('#chatRefresh').addEventListener('click', () => chatAction((p) => api(`/api/accounts/${p}/qr`, { method: 'POST', body: JSON.stringify({ remember: $('#chatRemember').checked, refresh: true }) })));
$('#chatCheck').addEventListener('click', () => chatAction(async (p) => {
  const request = chatRequest;
  chatCheckFeedback = { status: 'running', message: '正在检查采集状态…' }; renderCheckFeedback();
  try {
    const info = await api(`/api/accounts/${p}/check`, { method: 'POST', signal: AbortSignal.timeout(45000), body: '{}' });
    if (p === chatPlatform && request === chatRequest) {
      const result = info.checkResult || { status: info.status === 'connected' ? 'succeeded' : info.status === 'partial' ? 'partial' : 'failed', message: info.message };
      const label = result.status === 'succeeded' ? '检查完成，采集正常' : result.status === 'partial' ? '检查完成，部分内容需处理' : '检查失败';
      chatCheckFeedback = { status: result.status, message: `${label}。${result.message || ''}`, connectionProblem: result.status !== 'succeeded' && !chatConnectionReady(info) }; renderCheckFeedback();
    }
    return info;
  } catch (error) {
    if (p === chatPlatform && request === chatRequest) {
      chatCheckFeedback = { status: 'failed', message: error.name === 'TimeoutError' ? '检查超时，请重试；上方保留的是最近一次连接结果。' : `检查失败：${error.message}` }; renderCheckFeedback();
    }
    throw error;
  }
}));
$('#chatInitialize').addEventListener('click', () => chatAction((p) => api(`/api/accounts/${p}/initialize`, { method: 'POST', body: JSON.stringify({ remember: $('#chatRemember').checked }) })));
$('#chatReadHistory').addEventListener('click', () => chatAction((p) => api(`/api/accounts/${p}/history`, { method: 'POST', body: '{}' })));
$('#chatAcknowledge').addEventListener('click', () => chatAction((p) => api(`/api/accounts/${p}/acknowledge`, { method: 'POST', signal: AbortSignal.timeout(45000), body: '{}' })));
$('#chatLoadGroups').addEventListener('click', () => chatInfo?.selection?.mode === 'auto' ? chatAction((p) => api(`/api/accounts/${p}/selection`, { method: 'PUT', signal: AbortSignal.timeout(45000), body: JSON.stringify({ refresh: true }) })) : loadChatGroups());
$('#chatRemember').addEventListener('change', () => { chatRememberDirty = true; $('#chatSaveGroups').hidden = false; $('#chatSaved').textContent = '连接设置尚未保存，点击保存即可。'; });
$('#chatGroupList').addEventListener('change', (e) => {
  const input = e.target.closest('[data-group-decision]'); if (!input) return;
  void chatAction(async (p) => { const result = await api(`/api/accounts/${p}/selection`, { method: 'PUT', signal: AbortSignal.timeout(45000), body: JSON.stringify({ id: input.dataset.groupDecision, decision: input.value }) }); $('#chatSaved').textContent = '识别纠正已保存，采集范围已更新。'; return result; });
});
$('#chatGroupList').addEventListener('change', (e) => { if (e.target.matches('input[type=checkbox]')) { chatChecked.set(e.target.value, e.target.checked ? { id: e.target.value, name: e.target.dataset.name } : null); $('#chatSaved').textContent = '群聊选择尚未保存。'; } });
$('#chatSaveGroups').addEventListener('click', () => chatAction(async (p) => {
  if (chatInfo?.selection?.mode === 'auto') { const info = await api(`/api/accounts/${p}/selection`, { method: 'PUT', signal: AbortSignal.timeout(45000), body: JSON.stringify({ remember: $('#chatRemember').checked }) }); chatRememberDirty = false; $('#chatSaved').textContent = '连接设置已保存。'; return info; }
  const groups = $$('#chatGroupList input:checked').map((input) => ({ id: input.value, name: input.dataset.name }));
  if (p === 'wechat') for (const name of $('#chatManualGroups').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) if (!groups.some((g) => g.id === name)) groups.push({ id: name, name });
  const info = await api(`/api/accounts/${p}/groups`, { method: 'PUT', signal: AbortSignal.timeout(45000), body: JSON.stringify({ groups, remember: $('#chatRemember').checked }) });
  chatRememberDirty = false; chatChecked.clear(); chatListed = false; $('#chatManualGroups').value = '';
  $('#chatSaved').textContent = info.status === 'connected' ? '设置已保存，正在采集所选群的新消息。' : '设置已保存，请处理上方提示后开始采集。'; return info;
}));
$('#chatDisconnect').addEventListener('click', () => chatAction(async (p) => { const info = await api(`/api/accounts/${p}`, { method: 'DELETE', body: '{}' }); chatListed = false; $('#chatSaved').textContent = ''; return info; }));
$('#chatFinish').addEventListener('click', () => $('#chatDialog').close());
$('#chatQrImage').addEventListener('error', () => { chatImageKey = ''; if ($('#chatDialog').open) chatError('二维码暂时不可用或已过期，请刷新二维码。'); });
$('#chatDialog').addEventListener('close', () => { ++chatRequest; $('#chatQrImage').removeAttribute('src'); });
setInterval(() => { if (authenticated && $('#chatDialog').open) void refreshChat(); }, 1500);
