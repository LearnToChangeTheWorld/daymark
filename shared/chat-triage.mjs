import { itemRelevance, itemTopic } from './learning-relevance.mjs';
const chatSources = new Set(['qq', 'wechat']);
const attachment = /\[(?:图片|文件|附件|视频|语音|分享|转发)(?:[：:][^\]]*)?\]/u;
const subject = /作业|报告|论文|练习|题目|习题|第.{1,8}题|问卷|表格|统计表|信息表|登记表|申请|材料|名单|费用|水电费|学费|报名|考试|补考|选课|体检|会议|班会|讲座|活动|签到|快递|报修|预约|教材|实验|证件|照片|打卡|课程/u;
const action = /提交|上交|交齐|补交|交(?:作业|报告|论文|材料)|完成|填写|填报|报名|签到|缴(?:费|纳)|支付|领取|取(?:件|快递)|参加|集合|选课|报修|预约|上传|下载|打印|带上|携带|确认|登记|打卡|做(?:完|好|第|题|练习)/u;
const cancel = /(?:不用|无需|不必|不需要|暂不|暂停|取消|不要|勿).{0,8}(?:提交|上交|交|作业|考试|报名|缴费|签到|参加|完成|填写|打印|上传)|(?:作业|报告|考试|课程|活动|会议).{0,8}(?:取消|暂停|不用交|无需交|不必交|不需要交)/u;
const question = /[?？]$|请问|有没有|怎么|如何|哪里|哪个|谁知道|能不能|可不可以|做完了吗|交了吗|写完了吗|(?:作业|报告|题).{0,8}(?:吗|么|没)$/u;
const personal = /^(?:我|俺|本人|我们)(?!校|院|班).{0,12}(?:提交|交了|完成|写完|写好|做完|上传|报名|缴费)/u;
const finished = /(?:我|本人|刚刚|已经|已).{0,6}(?:提交了?|完成了?|交了|写完|上传了?|报名了?|缴费了?)(?!的同学)/u;
const concreteWork = /作业|报告|实验项目|预习册|预习手册|习题|练习|论文|课程设计|问卷|统计表|信息表|登记表|申请表|汇总表|表格|材料|证件|照片/u;
const directive = /请|务必|必须|需要|须|应该|记得|别忘|麻烦|通知|要求/u;
// A keyword cannot establish that the reader belongs to a named/conditional
// audience, or that an optional invitation is their commitment.
const uncertainAudience = /有.{0,8}意向|有意愿|愿意|自愿|感兴趣|想要报名|可(?:以)?参加|可(?:以)?报名|招募|招新|入选|报名方式|如需|如果|假如|假设|例如|比如|若|仅限|针对|请假|重修|补做|每次|每周|每节|每堂|各位(?:学委|班委|班长|团支书)|(?:申请|报名|选修|未提交|未交|没交|未完成|已完成|未填写|已经报名).{0,18}的同学/u;
const namedMention = /(?<![\w.%+-])@(?!all\b|everyone\b|here\b|全体成员|所有人)[^\s@，,。！？!?：:]+|\[CQ:at,qq=\d+/iu;
// Actions such as "check in", "sign up" or "fill it in" do not name a task.
// Review needs an object or a destination that makes the instruction useful;
// message length and the presence of an @mention cannot provide that context.
const reviewObject = /作业|报告|论文|练习|习题|题目|第.{1,8}题|预习册|预习手册|问卷|表格|统计表|信息表|登记表|申请表|汇总表|材料|名单|费用|水电费|学费|考试|补考|选课|体检|会议|班会|讲座|活动|快递|报修|预约|教材|实验|证件|照片|证明/u;
const reviewDestination = /学习通|雨课堂|教务系统|超星|第[一二三四五六七八九十百\d]+(?:章|节|单元)|(?:到|在).{0,15}(?:教室|教学楼|实验室|[一二三四五六七八九十\d]+楼)|https?:\/\/\S+/u;

// High confidence requires a concrete object and a directive/deadline, or an
// explicit assignment. Other actionable text still needs review. Neither path
// infers attachment contents or invents a deadline from the collection time.
export function triageChat(item) {
  if (!chatSources.has(item.source)) return null;
  if (item.kind === 'task') return { kind: 'task', reason: item.autoTask ? `根据关键词自动加入：${item.autoTask.reason}` : '已加入待办' };
  if (item.triageDecision === 'dismissed') return { kind: 'conversation', reason: '你已确认这条不是待办' };
  const original = String(item.body || item.title || '');
  const text = original.replace(/\[CQ:[^\]]*\]/gu, '').replace(/\[(?:图片|文件|附件|视频|语音|分享|转发|引用)(?:[：:][^\]]*)?\]/gu, '').replace(/@\d+/gu, '').trim();
  const clauses = text.split(/(?<=[。！？!?；;\n])|[，,]/u).map((part) => part.trim()).filter(Boolean);
  const needsAudienceCheck = uncertainAudience.test(text) || namedMention.test(original) || cancel.test(text);
  let candidate = null;
  let cancelled = false;
  let missingContext = false;
  for (const clause of clauses) {
    if (cancel.test(clause)) { cancelled = true; continue; }
    if (question.test(clause) || personal.test(clause) || finished.test(clause)) continue;
    const assignment = /(?:本周|这周|今日|今天|本次|课后)?作业\s*[：:]\s*\S|(?:作业|练习|习题).{0,15}(?:第.{1,10}题|教材|课本|习题册)/u.test(clause);
    const deadline = subject.test(clause) && /截止|截至|最[迟晚]|(?:周[一二三四五六日天]|\d{1,2}[月日号]|明天|今天|今晚|本周).{0,10}(?:前|交|提交|完成)/u.test(clause);
    const instruction = action.test(clause) && (subject.test(clause) || /(?:请|务必|必须|记得|提醒|大家|同学们).{0,20}(?:提交|填写|登记|签到|参加|集合)/u.test(clause));
    if (assignment || deadline || instruction) {
      // Do not send vague reminders to review merely because they use an
      // imperative verb. Source messages remain available in Records.
      const context = clause.replace(/\[CQ:[^\]]*\]/gu, '').replace(/@(?:全体成员|所有人|all\b|everyone\b|here\b)/giu, '').replace(/(?<![\w.%+-])@[^\s@，,。！？!?：:]+/gu, (mention) => {
        // Some clients omit the space after a mention. Keep the instruction
        // after its verb, while words in the nickname do not name a task.
        const start = mention.search(/请|务必|必须|需要|记得|别忘|麻烦|提交|上交|补交|完成|填写|打卡|签到|报名/u);
        return start < 0 ? '' : mention.slice(start);
      });
      if (!assignment && !reviewObject.test(context) && !reviewDestination.test(context)) { missingContext = true; continue; }
      const definite = !needsAudienceCheck && (assignment || (concreteWork.test(clause) && (deadline || (action.test(clause) && directive.test(clause)))));
      const next = { kind: 'candidate', confidence: definite ? 'high' : 'low', rule: assignment ? 'assignment' : deadline ? 'deadline' : 'instruction', reason: definite ? assignment ? '文字明确布置了具体作业' : deadline ? '具体事项包含明确的时间要求' : '具体事项包含明确的行动要求' : needsAudienceCheck ? '涉及指定人员、适用条件或自愿参加，请确认是否与你有关' : '文字包含行动要求，请确认具体事项和适用对象' };
      if (definite) return next;
      candidate ||= next;
    }
  }
  if (candidate) return candidate;
  if (cancelled || /(?:停课|调课|改课|换教室|调整.{0,8}(?:上课|考试|教室|时间)|(?:上课|考试|会议).{0,12}(?:改为|改到|推迟|提前)|(?:通知|提醒)[：:])/u.test(text)) return { kind: 'notice', reason: '事项变动或通知，未自动创建待办' };
  if (attachment.test(original) || /\[CQ:(?:image|file|video|record|forward)/u.test(original)) return { kind: 'attachment', reason: '图片或附件内容尚未识别，不能据此判断是否有作业' };
  if (missingContext) return { kind: 'conversation', rule: 'insufficient_context', reason: '只有催促或打卡等行动词，缺少具体事项或必要上下文，保留在原始消息中' };
  return { kind: 'conversation', reason: '未识别到明确行动要求，保留在原始消息中' };
}

export function presentItem(item) {
  const triage = triageChat(item);
  return { ...item, relevance: itemRelevance(item), topic: itemTopic(item), ...(triage ? { triage } : {}) };
}

export function presentItems(items) {
  const presented = items.map(presentItem);
  const groups = new Map();
  for (const item of presented) {
    if (!chatSources.has(item.source)) continue;
    // Include confirmed/dismissed originals so their repeated copies do not
    // return as new candidates after a user has made a decision.
    if (triageChat({ ...item, kind: 'notification', triageDecision: null })?.kind !== 'candidate') continue;
    let body = String(item.body || item.title).trim();
    if (/^#接龙\s/u.test(body)) body = body.split(/\n\s*1[.、．]/u)[0].trim();
    const time = item.publishedAt || item.createdAt;
    const day = Number.isFinite(Date.parse(time)) ? new Date(Date.parse(time) + 8 * 3600_000).toISOString().slice(0, 10) : item.id;
    const key = JSON.stringify([item.source, item.sourceName, day, body.replace(/\s+/gu, ' ')]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  for (const rows of groups.values()) {
    if (rows.length < 2) continue;
    rows.sort((a, b) => {
      const decided = (row) => row.kind === 'task' || row.triageDecision === 'dismissed' || row.archived || row.done ? 0 : 1;
      return decided(a) - decided(b) || String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id);
    });
    const [first, ...copies] = rows;
    first.triage.relatedIds = copies.map((row) => row.id);
    for (const copy of copies) copy.triage.duplicateOf = first.id;
  }
  return presented;
}

// Mutate only inside the server's atomic transaction. Existing tasks and user
// decisions win over repeated messages, including during startup migration.
export function autoPromoteChatTasks(items, { now = new Date().toISOString() } = {}) {
  const promoted = [];
  for (const item of presentItems(items)) {
    if (item.kind === 'task' || item.done || item.archived || item.triageDecision === 'dismissed' || item.relevance === 'other') continue;
    if (item.triage?.kind !== 'candidate' || item.triage.confidence !== 'high' || item.triage.duplicateOf) continue;
    const stored = items.find((row) => row.id === item.id);
    stored.kind = 'task';
    stored.autoTask = { version: 1, rule: item.triage.rule, reason: item.triage.reason, createdAt: now };
    promoted.push(stored.id);
  }
  return promoted;
}
