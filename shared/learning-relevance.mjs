// Local, explainable heuristics. Unknown is a real state, not an exclusion.
const learning = /作业|课后|课程|课堂|教材|习题|实验|论文|考试|考务|补考|选课|学分|教务|成绩|助教|答疑|上课|调课|停课|教室|教学|专业|辅导员|班委|班会|研究生|本科|大学物理|高等数学|线性代数|概率论|离散数学|数据结构|计算机|程序设计|工程图学|近现代史|思想道德|形势与政策|国家安全教育|军事理论|英语|C\+\+|Python|Java(?!script)/iu;
const social = /闲聊|闲扯|聊天|交友|吃喝|吃饭|约饭|拼单|外卖|二手|交易|买卖|游戏|开黑|王者|原神|崩铁|宿舍|寝室|失物|快递|表白|相亲|追星|球友|球赛/iu;
const className = /(?:\d{2,4}级|\d{4}届).{0,14}(?:官方|通知|班|学院|院)|(?:班级|班群|年级|教学班|学习群|学习交流|课程群)|(?:交控|计科|软工|土木|自动化|机械|电气|交通).{0,8}\d{2,4}/u;
const extracurricular = /迎新志愿|志愿者群|社团|运动会|校运会|综合运动会|文艺|晚会|歌唱|舞蹈|球赛|篮球|足球|排球|羽毛球|趣味运动|义工|招新|招募志愿|企业参访|企业走访|团日|团建|智慧学工|健康打卡|晨午晚检|晨检|晚检|晚点名|心理微课|心理健康活动/u;
const normalize = (text) => String(text || '').replace(/[【】\[\]（）()\s·_—-]/gu, '').toLowerCase();

export function classifyGroup(group, { courses = [], messages = [] } = {}) {
  const name = String(group.name || group.id || '');
  const normalized = normalize(name);
  const course = courses.map((row) => typeof row === 'string' ? row : row.name).find((name) => {
    const base = normalize(name).replace(/\d{4}[春夏秋冬]|通识课[a-z]|第?[一二三四五六七八九十\d]+学期/gu, '');
    return base.length >= 3 && normalized.includes(base);
  });
  if (social.test(name) || extracurricular.test(name)) return { relevance: 'other', reason: '群名以生活、社交或课外活动为主' };
  if (course) return { relevance: 'learning', reason: `匹配已接入课程：${course}` };
  if (learning.test(name) || className.test(name)) return { relevance: 'learning', reason: '群名包含课程、班级或考务线索' };
  const signals = messages.filter((text) => learning.test(text));
  if (signals.length >= 2 || signals.some((text) => /(?:作业|实验报告|论文).{0,24}(?:提交|上交|截止)|(?:提交|上交).{0,24}(?:作业|实验报告|论文)|作业[：:]/u.test(text))) {
    return { relevance: 'learning', reason: '近 7 天可读消息包含学习事项' };
  }
  return { relevance: 'unknown', reason: messages.length ? '现有消息不足以判断，暂未自动采集' : '群名不明确，等待检查近期消息' };
}

export function itemRelevance(item) {
  // A user's confirmed tasks always take precedence over automatic relevance.
  if (item.kind === 'task' || item.source === 'manual') return 'learning';
  if (['chaoxing', 'rainclass', 'csu'].includes(item.source)) return 'learning';
  const text = String(item.body || item.title || '');
  if (!/(?:作业|实验报告|论文).{0,24}(?:提交|上交|截止)|(?:提交|上交).{0,24}(?:作业|实验报告|论文)/u.test(text) && extracurricular.test(text)) return 'other';
  if (learning.test(text)) return 'learning';
  if (social.test(text) || item.category === 'life') return 'other';
  if (item.category === 'academic') return 'learning';
  return classifyGroup({ name: item.sourceName }).relevance;
}

export function itemTopic(item) {
  const text = `${item.title || ''} ${item.body || ''}`;
  if (/作业|习题|实验报告|论文|课后练习/u.test(text)) return '作业提交';
  if (/考试|考务|补考|缓考|监考|准考证|考场/u.test(text)) return '考试考务';
  if (/上课|课程|选课|调课|停课|教室|课表|教材/u.test(text)) return '课程安排';
  if (/报名|材料|填报|申请|登记|问卷|表格|信息表/u.test(text)) return '报名材料';
  return '其他';
}
