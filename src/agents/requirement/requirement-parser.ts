// Requirement 规则解析器：不依赖 LLM 的确定性兜底解析
// 通过关键词/模式匹配提取 feature、capabilities、inputs、requirements、businessRules、dependencies。
// 定位：LLM 不可用 / 返回非法 JSON / 校验失败时使用，保证需求解析链路始终可产出结构化结果。

import { buildRequirement, Requirement } from './requirement-schema.js';

// ── 关键词表（顺序优先） ──

const FEATURE_MAP: Array<[RegExp, string]> = [
  [/文生视频|文转视频|text[-\s]?to[-\s]?video|t2v/i, 'wan3'],
  [/图生视频|图转视频|image[-\s]?to[-\s]?video|i2v/i, 'wan3'],
  [/首尾帧|last[-\s]?frame|first[-\s]?frame/i, 'wan3'],
  [/视频生成|视频|video/i, 'wan3'],
  [/user|用户|账号|登录|login/i, 'user'],
  [/order|订单|下单/i, 'order'],
  [/payment|支付|计费|扣费|积分/i, 'payment'],
];

const CAPABILITY_MAP: Array<[RegExp, string]> = [
  [/文生视频|文转视频|text[-\s]?to[-\s]?video|t2v/i, 'text-to-video'],
  [/图生视频|图转视频|image[-\s]?to[-\s]?video|i2v/i, 'image-to-video'],
  [/首尾帧/i, 'first-last-frame'],
  [/全能参考/i, 'full-reference'],
  [/视频/i, 'video'],
];

const INPUT_MAP: Array<[RegExp, string]> = [
  [/提示词|prompt/i, 'prompt'],
  [/分辨率|清晰度|resolution|\b(?:8k|4k|2k|1080p?|720p?|480p?)\b|高清|标清/i, 'resolution'],
  [/时长|秒|duration/i, 'duration'],
  [/图|参考图|image|reference/i, 'reference'],
  [/模型|model/i, 'model'],
  [/音频|audio/i, 'audio'],
];

const RESOLUTION_VALUES: Array<[RegExp, string]> = [
  [/8k/i, '8K'],
  [/4k/i, '4K'],
  [/2k/i, '2K'],
  [/1080p|1080/i, '1080P'],
  [/720p|720/i, '720P'],
  [/480p|480/i, '480P'],
  [/高清/i, '1080P'],
  [/标清/i, '480P'],
];

/** 时长：匹配 N 秒 / N s / Nseconds / N（秒） */
const DURATION_RE = /(\d{1,3})\s*(?:秒|s\b|seconds|s\))/gi;

const BUSINESS_RULE_MAP: Array<[RegExp, string]> = [
  [/积分扣除|积分.*正确|扣费.*正确|余额.*扣/i, '积分正确扣除'],
  [/扣费/i, '积分正确扣除'],
  [/任务.*提交|提交.*成功/i, '任务提交成功'],
  [/状态.*成功|任务.*成功|最终.*成功/i, '任务状态最终成功'],
  [/并发/i, '并发执行正常'],
  [/超时/i, '超时处理正常'],
  [/重试/i, '重试机制正常'],
  // Phase 20.8 增强：扩展业务规则识别（下载 / 历史 / 取消 / 去重 / 安全 / 鉴权 / 幂等 / 限流 / 错误码等）
  [/余额不足|余额.*不足/i, '余额不足拒绝'],
  [/未登录|未授权/i, '未登录拒绝'],
  [/下载|url|链接/i, '下载链接可用'],
  [/历史|列表|倒序/i, '历史记录查询'],
  [/取消/i, '取消处理正常'],
  [/去重|重复/i, '重复提交去重'],
  [/幂等|request\s?[-_]?id/i, '幂等处理正常'],
  [/鉴权分级|会员|分级/i, '鉴权分级校验'],
  [/阶梯|单价/i, '阶梯单价校验'],
  [/失败.*恢复|重新提交|重提/i, '失败恢复重提'],
  [/一致|详情/i, '数据一致性校验'],
  [/注入|泄露|系统提示/i, '安全注入防护'],
  [/内容安全|涉黄|暴力|仇恨|违规|敏感/i, '内容安全审核'],
  [/参数校验|校验错误|非法参数|无效参数/i, '参数校验严格'],
  [/seed|temperature/i, 'seed 与 temperature 控制'],
  [/复现|hash/i, '结果复现一致'],
  [/错误码|4001|4003/i, '错误码校验'],
  [/伪造|过期.*cookie|cookie/i, '鉴权 Cookie 校验'],
  [/限流|429/i, '限流保护正常'],
  [/超长|413/i, '超长输入处理'],
  [/多语言|中文|英文|混排/i, '多语言兼容'],
  [/时长/i, '时长校验'],
  [/提示词长度|长度/i, '提示词长度边界'],
];

const DEPENDENCY_MAP: Array<[RegExp, string]> = [
  [/模型|model/i, '模型服务'],
  [/积分|余额|billing|计费/i, '积分服务'],
  [/素材|oss|存储/i, '素材服务'],
];

/** 目标提取：匹配「验证/测试…链路/流程/功能/场景」短语 */
const GOAL_RE = /(?:验证|测试|确保)[^。；；\n]{2,40}(?:链路|流程|功能|场景)/i;

/** 约束条件关键词表 */
const CONSTRAINT_MAP: Array<[RegExp, string]> = [
  [/禁止.*真实扣费|禁止.*扣费|不.*真实扣费|禁止.*积分/i, '禁止真实扣费'],
  [/仅.*测试环境|只.*测试环境|测试环境.*(?:执行|进行)/i, '仅限测试环境执行'],
  [/禁止.*删除|不.*删除.*数据|不.*影响.*数据/i, '禁止删除/污染生产数据'],
  [/并发.*上限|并发.*限制|并发.*不超过|最大并发/i, '并发数受限'],
  [/不.*调用.*支付|禁止.*支付|不.*真实支付/i, '禁止真实支付'],
  [/生产.*禁止|禁止.*生产/i, '禁止在生产环境执行'],
];

/** 风险标签关键词表（从文本识别） */
const RISK_MAP: Array<[RegExp, string]> = [
  [/并发/i, 'concurrency'],
  [/超时|timeout/i, 'timeout'],
  [/积分|扣费|billing|计费|余额/i, 'billing'],
  [/异常|失败|错误|error|exception/i, 'exception'],
  [/安全|越权|权限|鉴权|security/i, 'security'],
  [/兼容|flaky|不稳定/i, 'compatibility'],
  [/环境|env/i, 'environment'],
];

function unique(list: string[]): string[] {
  return Array.from(new Set(list));
}

function matchAll(text: string, map: Array<[RegExp, string]>): string[] {
  return unique(map.filter(([re]) => re.test(text)).map(([, v]) => v));
}

/** 提取参数取值（resolution / duration） */
function extractRequirements(text: string): Requirement['requirements'] {
  const items: Requirement['requirements'] = [];
  const resolutions = matchAll(text, RESOLUTION_VALUES);
  if (resolutions.length) items.push({ name: 'resolution', values: resolutions });

  const durations: number[] = [];
  for (const m of text.matchAll(DURATION_RE)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && !durations.includes(n)) durations.push(n);
  }
  if (durations.length) items.push({ name: 'duration', values: durations });
  return items;
}

/**
 * 规则解析自然语言需求 → Requirement。
 * @param text 原始需求文本
 * @param source 可选：记录原始文本
 */
export function parseRequirement(text: string, source?: string): Requirement {
  const t = text.trim();
  if (!t) throw new Error('需求文本为空');

  const capabilities = matchAll(t, CAPABILITY_MAP);
  const inputs = matchAll(t, INPUT_MAP);
  const businessRules = matchAll(t, BUSINESS_RULE_MAP);
  const dependencies = matchAll(t, DEPENDENCY_MAP);

  // feature：优先按明确功能名；兜底取能力映射或默认 wan3
  let feature = matchAll(t, FEATURE_MAP)[0] ?? '';
  if (!feature) feature = capabilities.includes('text-to-video') || capabilities.includes('video') ? 'wan3' : 'wan3';

  // 置信度：按命中维度加权
  const hits = (capabilities.length > 0 ? 1 : 0)
    + (inputs.length > 0 ? 1 : 0)
    + (businessRules.length > 0 ? 1 : 0)
    + (dependencies.length > 0 ? 1 : 0);
  const confidence = Math.min(0.95, 0.35 + hits * 0.12);

  return buildRequirement({
    feature,
    goal: extractGoal(t, feature),
    capabilities,
    inputs,
    requirements: extractRequirements(t),
    businessRules,
    dependencies,
    constraints: matchAll(t, CONSTRAINT_MAP),
    risks: extractRisks(t, dependencies),
    version: 'v1',
    source,
    confidence,
  });
}

/** 提取测试目标：优先原文短语，兜底「验证 {feature} 完整链路」 */
function extractGoal(text: string, feature: string): string {
  const m = text.match(GOAL_RE);
  return m ? m[0] : `验证 ${feature} 完整链路`;
}

/** 提取风险标签：关键词 + 依赖服务映射（billing 依赖 → billing 风险） */
function extractRisks(text: string, dependencies: string[]): string[] {
  const risks = matchAll(text, RISK_MAP);
  if (dependencies.includes('积分服务') && !risks.includes('billing')) risks.push('billing');
  if (dependencies.includes('模型服务') && !risks.includes('exception')) risks.push('exception');
  return unique(risks);
}
