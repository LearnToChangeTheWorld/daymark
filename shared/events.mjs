export const SOURCES = ['wechat', 'qq', 'chaoxing', 'rainclass', 'csu', 'manual'];

export function itemKind(input) {
  if (['task', 'notification'].includes(input.kind)) return input.kind;
  if (String(input.externalId || '').includes(':notice:')) return 'notification';
  if (String(input.externalId || '').includes(':work:')) return 'task';
  return !input.source || input.source === 'manual' || input.due || input.done ? 'task' : 'notification';
}

function invalid(message) { const error = new Error(message); error.name = 'ValidationError'; throw error; }
function text(value, max) { return String(value ?? '').trim().slice(0, max); }
export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + 'T00:00:00Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function cleanItem(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('事项格式不正确');
  const title = text(input.title, 160);
  if (!title) invalid('请填写事项标题');
  if (input.due && !validDate(input.due)) invalid('截止日期不正确');
  if (input.category && !['academic', 'life', 'unclassified'].includes(input.category)) invalid('分类不正确');
  if (input.source && !SOURCES.includes(input.source)) invalid('来源不正确');
  const category = input.category || 'unclassified';
  if (input.kind && !['task', 'notification'].includes(input.kind)) invalid('事项类型不正确');
  return { title, body: text(input.body, 12000), kind: itemKind(input), category, source: input.source || 'manual', sourceName: text(input.sourceName, 100), due: input.due || null, confidence: category === 'unclassified' || input.confidence === 'low' ? 'low' : 'high' };
}

export function validateEvent(input) {
  const item = cleanItem(input);
  const externalId = text(input.externalId, 240);
  if (!externalId || String(input.externalId).length > 240) invalid('事件必须包含不超过 240 字符的稳定 externalId');
  if (!input.source || !SOURCES.includes(input.source)) invalid('事件必须包含 source');
  if (typeof input.createdAt !== 'string' || !Number.isFinite(Date.parse(input.createdAt))) invalid('事件必须包含有效 createdAt');
  if (typeof input.body === 'string' && input.body.length > 12000) invalid('原文超过 12000 字符，请拆分后导入');
  const publishedAt = typeof input.publishedAt === 'string' && Number.isFinite(Date.parse(input.publishedAt)) ? new Date(input.publishedAt).toISOString() : null;
  return { ...item, externalId, createdAt: new Date(input.createdAt).toISOString(), publishedAt, timestampKind: publishedAt ? 'published' : ['collected', 'observed'].includes(input.timestampKind) ? input.timestampKind : 'source' };
}

// An unmatched message stays visible instead of being discarded.
export function classifyMessage(message) {
  const academic = /作业|考试|课表|实验报告|选课|学分|上课|补考|教务|学习通|雨课堂|答辩|论文|课程|交报告|提交报告/.test(message);
  const life = /取快递|快递|缴费|水电费|宿舍|报修|体检|预约|聚餐|买菜|生活费/.test(message);
  const category = academic && !life ? 'academic' : life && !academic ? 'life' : 'unclassified';
  return { category, confidence: category === 'unclassified' ? 'low' : 'high' };
}
