// 人工 vs Agent 对照实验基准（Phase 20.8）
// 30 条真实需求（10 普通 + 10 复杂 + 10 AI 需求），每条附带人工核验的期望覆盖点（coverageTags）。
// 对照逻辑：对每条需求运行 Agent（离线确定性，MockLLM + 确定性回退）生成测试用例，
//          统计 Agent 生成的用例对「人工期望覆盖点」的覆盖率，按档位聚合对比。
// 意义：衡量 Agent 测试设计在普通/复杂/AI 需求三档上的覆盖能力，与人工基线对照。

export type RequirementTier = 'normal' | 'complex' | 'ai';

export interface HvARequirement {
  id: string;
  tier: RequirementTier;
  text: string;
  feature: string;
  /** 人工核验的期望覆盖点（关键词，命中即算覆盖） */
  coverageTags: string[];
}

export const HVA_TIER_LABEL: Record<RequirementTier, string> = {
  normal: '普通需求',
  complex: '复杂需求',
  ai: 'AI 需求',
};

/** 10 条普通需求 */
const NORMAL: HvARequirement[] = [
  { id: 'n-01', tier: 'normal', feature: 'wan3', text: '测试 WAN3 文生视频：提交一段 prompt 生成 720P 视频，验证任务提交成功且返回任务 ID', coverageTags: ['提交', '720', '任务', 'prompt'] },
  { id: 'n-02', tier: 'normal', feature: 'wan3', text: '测试 WAN3 文生视频：选择 1080P 分辨率，验证生成任务状态最终为 SUCCESS', coverageTags: ['1080', '状态', 'SUCCESS'] },
  { id: 'n-03', tier: 'normal', feature: 'wan3', text: '测试 WAN3 文生视频：生成 5 秒视频，验证视频时长字段为 5s', coverageTags: ['时长', '5'] },
  { id: 'n-04', tier: 'normal', feature: 'wan3', text: '测试 WAN3 文生视频：提交后校验积分扣减与账户余额正确', coverageTags: ['积分', '余额', '扣'] },
  { id: 'n-05', tier: 'normal', feature: 'wan3', text: '测试 WAN3 文生视频：生成完成后可查询视频下载 URL 且可访问', coverageTags: ['下载', 'URL'] },
  { id: 'n-06', tier: 'normal', feature: 'wan3', text: '测试 WAN3 文生视频：未登录用户提交任务应返回未授权错误', coverageTags: ['登录', '未授权', '错误'] },
  { id: 'n-07', tier: 'normal', feature: 'wan3', text: '测试 WAN3 文生视频：空 prompt 提交应被拒绝并提示必填', coverageTags: ['空', '拒绝', '必填'] },
  { id: 'n-08', tier: 'normal', feature: 'wan3', text: '测试 WAN3 文生视频：查看生成历史列表，验证按时间倒序', coverageTags: ['历史', '列表', '倒序'] },
  { id: 'n-09', tier: 'normal', feature: 'wan3', text: '测试 WAN3 文生视频：取消正在生成的任务，验证状态变为取消', coverageTags: ['取消', '状态'] },
  { id: 'n-10', tier: 'normal', feature: 'wan3', text: '测试 WAN3 文生视频：重复提交同一 prompt 不产生重复任务', coverageTags: ['重复', '去重'] },
];

/** 10 条复杂需求 */
const COMPLEX: HvARequirement[] = [
  { id: 'c-01', tier: 'complex', feature: 'wan3', text: '测试 WAN3 文生视频组合场景：1080P + 10 秒 + 高清模式同时设置，验证参数组合生效且生成成功', coverageTags: ['1080', '10', '组合', '高清'] },
  { id: 'c-02', tier: 'complex', feature: 'wan3', text: '测试 WAN3 文生视频边界：prompt 长度 0/1/2000/5000 字符的接受与拒绝边界', coverageTags: ['边界', '长度', '拒绝'] },
  { id: 'c-03', tier: 'complex', feature: 'wan3', text: '测试 WAN3 文生视频数据一致性：提交后立即查询任务详情，再等完成后查询，两次积分扣减与任务 ID 一致', coverageTags: ['一致', '详情', '积分'] },
  { id: 'c-04', tier: 'complex', feature: 'wan3', text: '测试 WAN3 文生视频并发：10 个任务同时提交，验证互不干扰且各自扣费正确', coverageTags: ['并发', '互不干扰', '扣费'] },
  { id: 'c-05', tier: 'complex', feature: 'wan3', text: '测试 WAN3 文生视频超时链路：任务提交后 30 秒内未完成按超时处理，验证状态与重试提示', coverageTags: ['超时', '状态', '重试'] },
  { id: 'c-06', tier: 'complex', feature: 'wan3', text: '测试 WAN3 文生视频余额不足：提交 4K 高单价任务时余额不足，验证拒绝并返回明确错误码', coverageTags: ['余额不足', '拒绝', '错误码'] },
  { id: 'c-07', tier: 'complex', feature: 'wan3', text: '测试 WAN3 文生视频幂等：相同 requestId 重复提交两次，第二次应返回同一任务且只扣一次费', coverageTags: ['幂等', 'requestId', '扣费'] },
  { id: 'c-08', tier: 'complex', feature: 'wan3', text: '测试 WAN3 文生视频鉴权分级：普通用户与会员用户对 4K 生成的权限差异', coverageTags: ['鉴权', '会员', '权限'] },
  { id: 'c-09', tier: 'complex', feature: 'wan3', text: '测试 WAN3 文生视频失败恢复：生成中途模型失败，任务可重新提交且历史保留失败记录', coverageTags: ['失败', '恢复', '重提', '历史'] },
  { id: 'c-10', tier: 'complex', feature: 'wan3', text: '测试 WAN3 文生视频计费阶梯：不同分辨率（480/720/1080/4K）对应不同积分单价，验证扣减准确', coverageTags: ['计费', '阶梯', '积分'] },
];

/** 10 条 AI 需求 */
const AI: HvARequirement[] = [
  { id: 'a-01', tier: 'ai', feature: 'wan3', text: '测试 WAN3 文生视频 prompt 注入：prompt 内含“忽略系统指令”等注入文本，验证不改变生成行为且不泄露系统提示', coverageTags: ['注入', '泄露', '系统提示'] },
  { id: 'a-02', tier: 'ai', feature: 'wan3', text: '测试 WAN3 文生视频内容安全：涉黄、暴力、仇恨言论 prompt 应被拒绝', coverageTags: ['安全', '拒绝', '违规'] },
  { id: 'a-03', tier: 'ai', feature: 'wan3', text: '测试 WAN3 文生视频参数解析：无效 json 参数（分辨率、时长、模式）返回明确校验错误而非 500', coverageTags: ['参数', '校验', '500'] },
  { id: 'a-04', tier: 'ai', feature: 'wan3', text: '测试 WAN3 文生视频模型参数：seed 固定时多次生成结果一致，temperature 变化结果不同', coverageTags: ['seed', 'temperature', '一致'] },
  { id: 'a-05', tier: 'ai', feature: 'wan3', text: '测试 WAN3 文生视频输入超长：极长 prompt（10000 字符）不导致超时或 413', coverageTags: ['超长', '超时', '413'] },
  { id: 'a-06', tier: 'ai', feature: 'wan3', text: '测试 WAN3 文生视频多语言：中文、英文、中英混排 prompt 均正常生成', coverageTags: ['中文', '英文', '混排'] },
  { id: 'a-07', tier: 'ai', feature: 'wan3', text: '测试 WAN3 文生视频结果一致性：同 prompt 同参数生成结果可复现（hash 一致）', coverageTags: ['复现', 'hash', '一致'] },
  { id: 'a-08', tier: 'ai', feature: 'wan3', text: '测试 WAN3 文生视频错误码：余额不足返回 4001、参数非法返回 4003，校验错误码与业务语义匹配', coverageTags: ['错误码', '4001', '4003'] },
  { id: 'a-09', tier: 'ai', feature: 'wan3', text: '测试 WAN3 文生视频负向用例：伪造鉴权 Cookie、过期 Cookie 请求均被拒绝且不返回业务数据', coverageTags: ['伪造', '过期', '拒绝'] },
  { id: 'a-10', tier: 'ai', feature: 'wan3', text: '测试 WAN3 文生视频限流：高频连续提交触发限流返回 429，且提示稍后重试', coverageTags: ['限流', '429', '重试'] },
];

/** 完整基准：30 条需求 */
export const HUMAN_VS_AGENT_BENCHMARK: HvARequirement[] = [...NORMAL, ...COMPLEX, ...AI];

/** 按档位分组 */
export function hvaByTier(): Record<RequirementTier, HvARequirement[]> {
  const out: Record<RequirementTier, HvARequirement[]> = { normal: [], complex: [], ai: [] };
  for (const r of HUMAN_VS_AGENT_BENCHMARK) out[r.tier].push(r);
  return out;
}

/** 从测试用例文本中提取覆盖命中情况（关键词大小写不敏感） */
export function matchCoverageTags(caseTexts: string[], coverageTags: string[]): string[] {
  return coverageTags.filter((tag) => {
    const key = tag.toLowerCase();
    return caseTexts.some((t) => t.toLowerCase().includes(key));
  });
}
