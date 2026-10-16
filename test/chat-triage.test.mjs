import test from 'node:test';
import assert from 'node:assert/strict';
import { triageChat, presentItems, autoPromoteChatTasks } from '../shared/chat-triage.mjs';

const item = (body, extra = {}) => ({ source: 'qq', sourceName: '班级群', kind: 'notification', title: body.slice(0, 120), body, createdAt: '2026-10-15T10:00:00Z', ...extra });

test('conversation and subject keywords alone never become work candidates', () => {
  for (const body of ['谢谢', '得大改。。。', '老师说在维修@1659443587', '火狐用不了', '作业太难了', '作业写完了吗？', '请问实验报告怎么提交？', '我已经提交了实验报告', '我明天完成作业', '周五的考试太难了']) {
    assert.equal(triageChat(item(body)).kind, 'conversation', body);
  }
  for (const body of ['[附件]', '[文件：本周作业.pdf]', '[图片]', '[CQ:image,file=ignored]']) assert.equal(triageChat(item(body)).kind, 'attachment', body);
});

test('text with actionable requirements is nominated without inventing task state or deadlines', () => {
  for (const body of ['请同学们周五前提交实验报告', '请大家填写问卷', '本周作业：课本第3章1—5题', '实验报告周五截止', '请于明天下午九点到教室集合', '周五前交报告', '请同学们务必完成实验项目']) {
    const input = item(body); const result = triageChat(input);
    assert.equal(result.kind, 'candidate', body);
    assert.equal(input.kind, 'notification'); assert.equal(input.due, undefined);
  }
  assert.equal(triageChat(item('不用交作业了')).kind, 'notice');
  assert.equal(triageChat(item('明天停课')).kind, 'notice');
  assert.equal(triageChat(item('明天不用交作业了，周五前交实验报告')).kind, 'candidate');
  assert.equal(triageChat(item('请问作业怎么交？请大家于周五前提交报告。')).kind, 'candidate');
  assert.equal(triageChat(item('请提交报告', { triageDecision: 'dismissed' })).kind, 'conversation');
  assert.equal(triageChat(item('谢谢', { kind: 'task' })).kind, 'task', 'explicit user tasks are preserved');
  assert.equal(triageChat(item('通知', { source: 'chaoxing' })), null);
});

test('review filters vague reminders while retaining actionable check-ins and original messages', () => {
  const vague = ['@王浩然\u2005@林兆瑞\u2005记得打卡', '@陆凯敬 记得打卡', '@HMY\u2005@陈文轩\u2005@黄晨鑫记得打卡', '@12345 记得打卡', '[CQ:at,qq=12345]记得打卡', '@全体成员 记得打卡', '@作业课代表 记得打卡', '记得打卡', '今天22点前打卡', '请大家签到', '请抓紧时间填写', '@张三 @李四 请抓紧时间填写', '愿意报名的请告之我！', '请大家报名'];
  for (const source of ['qq', 'wechat']) for (const [index, body] of vague.entries()) {
    const input = item(body, { source, id: String(index), triage: { kind: 'candidate' } });
    const before = JSON.stringify(input);
    const result = triageChat(input);
    assert.equal(result.kind, 'conversation', body);
    assert.equal(result.rule, 'insufficient_context', body);
    assert.deepEqual(autoPromoteChatTasks([input]), [], body);
    assert.equal(JSON.stringify(input), before, 'filtering does not change messages or saved user decisions');
    assert.equal(presentItems([input])[0].triage.kind, 'conversation', 're-evaluate previously imported candidates');
  }
  for (const body of ['请大家今天22点前在学习通完成英语口语打卡', '请在雨课堂完成第三章签到', '请于明天下午九点到教室集合', '@张三 请周五前交作业', '@张三 请填写实验报告', '@张三请填写实验报告', '@全体成员请提交实验报告', '请大家填写问卷']) {
    assert.equal(triageChat(item(body)).kind, 'candidate', body);
  }
  assert.equal(triageChat(item('记得打卡', { kind: 'task' })).kind, 'task', 'explicit user tasks are preserved');
});

test('roll-call updates and exact repeated assignments share a card while originals and decisions remain intact', () => {
  const rows = [
    item('#接龙\n明天下午参加活动\n截止时间：10月18日18点\n\n1.张三', { id: 'a1' }),
    item('#接龙\n明天下午参加活动\n截止时间：10月18日18点\n\n1.张三\n2.李四', { id: 'a2', createdAt: '2026-10-15T11:00:00Z' }),
    item('请大家周五前提交实验报告', { id: 'b1' }),
    item('请大家周五前提交实验报告', { id: 'b2', createdAt: '2026-10-15T11:00:00Z' }),
    item('请大家周五前提交实验报告', { id: 'b3', sourceName: '另一门课' }),
    item('请大家周五前提交实验报告', { id: 'b4', createdAt: '2026-10-22T11:00:00Z' })
  ];
  const before = JSON.stringify(rows); const cards = presentItems(rows);
  assert.equal(JSON.stringify(rows), before, 'presentation must not rewrite source data');
  assert.equal(cards.length, 6); assert.deepEqual(cards[0].triage.relatedIds, ['a2']);
  assert.equal(cards[1].triage.duplicateOf, 'a1'); assert.deepEqual(cards[2].triage.relatedIds, ['b2']);
  assert.equal(cards[4].triage.duplicateOf, undefined); assert.equal(cards[5].triage.duplicateOf, undefined);
  rows[3].kind = 'task'; const confirmed = presentItems(rows);
  assert.equal(confirmed[2].triage.duplicateOf, 'b2', 'a confirmed copy suppresses other candidates');
  rows[3].kind = 'notification'; rows[3].triageDecision = 'dismissed';
  const dismissed = presentItems(rows); assert.equal(dismissed[2].triage.duplicateOf, 'b2');
  assert.equal(dismissed[3].triage.kind, 'conversation');
});

test('clear assignments and concrete action requirements qualify for automatic tasks', () => {
  const bodies = ['请同学们周五前提交实验报告', '本周作业：课本第3章1—5题', '实验报告周五截止', '请大家填写问卷', '同学们别忘了，下周二交作业：练习二十五和练习二十六', '之前的统计表不完善，麻烦同学们再填写一遍统计表，谢谢', '@全体成员 请完成课后练习', '[CQ:at,qq=all]请提交报告', '请大家上传申请材料'];
  for (const [index, body] of bodies.entries()) {
    const input = item(body, { id: String(index), read: true, due: null });
    assert.equal(triageChat(input).confidence, 'high', body);
    assert.deepEqual(autoPromoteChatTasks([input]), [input.id], body);
    assert.equal(input.kind, 'task'); assert.equal(input.due, null); assert.equal(input.read, true);
    assert.equal(input.body, body); assert.ok(input.autoTask.reason);
  }
});

test('conditions, specific recipients, optional invitations, ambiguity and negation never auto-create tasks', () => {
  for (const body of ['愿意报名的请告之我！', '请有意向的同学周五前填写申请表', '请未提交的同学补交作业', '请各位学委转发问卷，并请同学们填写', '@张三 请周五前交作业', '@12345 请提交报告', '[CQ:at,qq=12345]请大家填写问卷', '重修同学需要提交材料', '每次实验结束后，所有同学应该在一周内完成实验报告', '请于明天下午九点到教室集合', '请抓紧时间填写', '本周作业：第3题，不需要交', '请不要提交实验报告', '不用交作业了', '作业太难了', '作业写完了吗？', '我已经提交了实验报告', '[文件：本周作业.pdf]']) {
    const input = item(body, { id: 'a', due: null });
    assert.deepEqual(autoPromoteChatTasks([input]), [], body);
    assert.equal(input.kind, 'notification', body);
  }
});

test('automatic tasks persist once per duplicate group and respect prior user decisions', () => {
  const original = item('请大家周五前提交实验报告', { id: 'first', due: null });
  const rows = [original, { ...original, id: 'copy' }];
  assert.deepEqual(autoPromoteChatTasks(rows), ['copy']);
  // IDs break exact-time ties; a confirmed copy continues to anchor the group.
  assert.deepEqual(autoPromoteChatTasks(rows), []);
  const saved = JSON.parse(JSON.stringify(rows));
  assert.deepEqual(autoPromoteChatTasks(saved), []);
  saved.find((row) => row.kind === 'task').done = true;
  assert.deepEqual(autoPromoteChatTasks(saved), [], 'completion never resurfaces duplicates');
  for (const decision of [{ triageDecision: 'dismissed' }, { archived: true }, { done: true }]) {
    const decided = [{ ...original, id: 'a', ...decision, kind: 'notification' }, { ...original, id: 'b', kind: 'notification' }];
    assert.deepEqual(autoPromoteChatTasks(decided), [], JSON.stringify(decision));
  }
  const other = item('请大家填写问卷，报名参加运动会', { id: 'life' });
  assert.deepEqual(autoPromoteChatTasks([other]), [], 'lower priority activities stay out of tasks');
});
