import { createHmac, timingSafeEqual } from 'node:crypto';
import { classifyMessage } from '../shared/events.mjs';

export function verifySignature(raw, signature, secret) {
  const expected = Buffer.from('sha1=' + createHmac('sha1', secret).update(raw).digest('hex'));
  const actual = Buffer.from(String(signature || ''));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function groupEvent(input, allowedGroups) {
  if (!['message', 'message_sent'].includes(input.post_type) || input.message_type !== 'group') return null;
  if (!allowedGroups.includes(String(input.group_id))) return null;
  if (input.message_id == null || !input.self_id || !Number.isFinite(input.time)) throw new Error('群事件缺少消息 ID 或发送时间');
  const raw = Array.isArray(input.message) ? input.message.map((part) => {
    if (part.type === 'text') return String(part.data?.text || '');
    if (part.type === 'at') return `@${part.data?.qq || '成员'}`;
    if (part.type === 'file') {
      const name = String(part.data?.name || '').replace(/[\[\]\r\n]/g, '').trim().slice(0, 160);
      return name && !/\w+:\/\//.test(name) ? `[文件：${name}]` : '[文件]';
    }
    return ({ image: '[图片]', video: '[视频]', record: '[语音]', reply: '[引用]' }[part.type] || '[附件]');
  }).join('') : typeof input.raw_message === 'string' ? input.raw_message : typeof input.message === 'string' ? input.message : '';
  if (!raw.trim()) return null;
  const text = raw.replace(/\[CQ:[^\]]+\]/g, '').trim();
  return {
    source: 'qq', sourceName: `QQ群 ${input.group_id}`, externalId: `${input.self_id}:${input.group_id}:${input.message_id}`,
    title: (text || '群消息（含附件，请查看原文）').slice(0, 120), body: raw,
    createdAt: new Date(input.time * 1000).toISOString(), publishedAt: new Date(input.time * 1000).toISOString(), kind: 'notification', due: null, ...classifyMessage(text)
  };
}
