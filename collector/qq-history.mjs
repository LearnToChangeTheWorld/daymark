import { groupEvent } from './onebot.mjs';

const week = 7 * 86400_000;
export function historySummary(groups, history = {}) {
  const rows = groups.map((g) => ({ id: g.id, name: g.name, ...(history[g.id] || { status: 'pending' }) }));
  return {
    status: !rows.length ? 'idle' : rows.some((g) => ['pending', 'running'].includes(g.status)) ? 'running' : rows.some((g) => g.status === 'partial') ? 'partial' : 'completed',
    groups: rows.map(({ id, name, status, scanned = 0, kept = 0, oldestAt, message }) => ({ id, name, status, scanned, kept, oldestAt, message })),
    completed: rows.filter((g) => ['completed', 'available'].includes(g.status)).length,
    total: rows.length,
    scanned: rows.reduce((sum, g) => sum + (g.scanned || 0), 0),
    kept: rows.reduce((sum, g) => sum + (g.kept || 0), 0)
  };
}

// One bounded page per poll keeps progress visible and permits normal live
// collection, cancellation and group changes between requests.
export async function readHistoryPage({ client, accountId, groups, history, deliver, now = Date.now(), pageSize = 50, maxPages = 200 }) {
  for (const group of groups) if (!history[group.id]) history[group.id] = { status: 'pending', since: now - week, scanned: 0, kept: 0, pages: 0, seen: [] };
  const group = groups.filter((g) => ['pending', 'running'].includes(history[g.id].status)).sort((a, b) => (history[a.id].checkedAt || 0) - (history[b.id].checkedAt || 0))[0];
  if (!group) return;
  const state = history[group.id]; state.status = 'running'; state.checkedAt = now;
  try {
    const result = await client.action('get_group_msg_history', { group_id: group.id, count: pageSize, ...(state.cursor ? { message_seq: state.cursor } : {}), reverse_order: false, disable_get_url: true, parse_mult_msg: false });
    if (!Array.isArray(result?.messages)) throw new Error('invalid history response');
    const page = result.messages.filter((m) => String(m.self_id) === accountId && String(m.group_id) === group.id && m.message_type === 'group' && Number.isFinite(m.time));
    if (result.messages.length && !page.length) throw new Error('history account/group identity mismatch');
    const seen = new Set(state.seen || []);
    const ordered = page.toSorted((a, b) => a.time - b.time);
    let unseen = 0;
    for (const message of ordered) {
      const id = String(message.message_id);
      if (seen.has(id)) continue;
      unseen++;
      if (message.time * 1000 >= state.since && message.time * 1000 <= now + 60_000) {
        const event = groupEvent(message, [group.id]);
        if (event) { event.sourceName = 'QQ · ' + group.name; await deliver(event); state.kept++; }
      }
      seen.add(id); state.scanned++; state.seen = [...seen];
    }
    state.seen = [...seen]; state.pages++;
    if (ordered.length) state.oldestAt = new Date(ordered[0].time * 1000).toISOString();
    if (!ordered.length) { state.status = 'available'; state.message = '平台未返回更早记录，已保存目前可读取的近期消息；无法确认历史完整。'; }
    else if (ordered[0].time * 1000 <= state.since) { state.status = 'completed'; state.message = '已读取至 7 天前。'; }
    else if (!unseen) { state.status = 'available'; state.message = '平台翻页不再返回更早消息，已保存可读取记录；无法确认历史完整。'; }
    else if (state.pages >= maxPages) { state.status = 'partial'; state.message = '本轮已达到读取上限，近 7 天历史尚未读完，请再次补读并检查范围。'; }
    else {
      const cursor = ordered[0].message_seq ?? ordered[0].message_id;
      if (cursor == null) throw new Error('history cursor missing');
      state.cursor = String(cursor);
    }
  } catch {
    state.status = 'partial'; state.message = '历史读取失败或返回格式不正确，已保留读取进度；请点击补读重试。';
  }
}
