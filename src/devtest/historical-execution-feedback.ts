/**
 * 历史执行反馈与脆弱链路画像（Historical Execution Feedback）
 *
 * 作用：
 * 记录与推演历史测试执行中的高脆弱度链路（如特定模型与 task_type 组合易超时、某上游渠道高峰期 503 频发）。
 * 在新一轮测试规划时，自主调高对应组合的执行优先级、强制开启容错/重试逆向用例，并预警风险。
 */

export interface FragilityProfile {
  patternKey: string;
  modelId: number;
  taskType?: number;
  channel?: string;
  historicalFailureRate: number;
  fragilityScore: number; // 0 ~ 100
  riskDescription: string;
  recommendedMitigations: string[];
}

/**
 * 盼趣历史已知高风险/脆弱链路画像库
 */
const KNOWN_FRAGILITY_PROFILES: FragilityProfile[] = [
  {
    patternKey: 'wan3-task105-direct',
    modelId: 84,
    taskType: 105,
    channel: 'MAIN_SITE',
    historicalFailureRate: 0.32,
    fragilityScore: 85,
    riskDescription: 'Wan 3.0 直连任务 (task_type=105) 历史并发下锁竞争与轮询超时率达 32%',
    recommendedMitigations: [
      '优先推荐切至 NewAPI 分流 (task_type=28)',
      '强制包含长轮询超时逆向测试',
      '提高执行优先级并保留现场快照',
    ],
  },
  {
    patternKey: 'seedance-newapi-503-fallback',
    modelId: 15,
    taskType: 28,
    channel: 'NEWAPI',
    historicalFailureRate: 0.18,
    fragilityScore: 75,
    riskDescription: 'Seedance 2.0 在 NewAPI TD 渠道上游偶发 503 (历史发生率 ~18%)，需依赖火山引擎兜底',
    recommendedMitigations: [
      '强制验证 503 触发 Fallback 至 Volcengine 链路',
      '核验 pq_aivideo_diversion_retrylog 重试流水记录与成本累加',
    ],
  },
  {
    patternKey: 'runninghub-peak-ratelimit',
    modelId: 201,
    taskType: 1,
    channel: 'NEWAPI',
    historicalFailureRate: 0.12,
    fragilityScore: 65,
    riskDescription: 'RunningHub nano banana 2 场景生图高峰期可能遭遇上游 429 限流',
    recommendedMitigations: [
      '验证任务提交限流重试机制',
      '确保限流失败时不发生积分空扣',
    ],
  },
];

export interface FragilityAssessment {
  isFragile: boolean;
  fragilityScore: number;
  riskNotes: string[];
  priorityBoost: boolean;
  requireFallbackVerification: boolean;
  recommendedMitigations: string[];
}

/**
 * 评估指定业务参数组合的历史脆弱度
 */
export function assessHistoricalFragility(input: {
  modelId: number;
  taskType?: number;
  channel?: string;
}): FragilityAssessment {
  const matches = KNOWN_FRAGILITY_PROFILES.filter((profile) => {
    if (profile.modelId !== input.modelId) return false;
    if (input.taskType !== undefined && profile.taskType !== undefined && profile.taskType !== input.taskType) {
      return false;
    }
    if (input.channel !== undefined && profile.channel !== undefined && profile.channel !== input.channel) {
      return false;
    }
    return true;
  });

  if (!matches.length) {
    return {
      isFragile: false,
      fragilityScore: 0,
      riskNotes: [],
      priorityBoost: false,
      requireFallbackVerification: false,
      recommendedMitigations: [],
    };
  }

  const maxScore = Math.max(...matches.map((m) => m.fragilityScore));
  const riskNotes = matches.map((m) => m.riskDescription);
  const mitigations = matches.flatMap((m) => m.recommendedMitigations);

  return {
    isFragile: maxScore >= 60,
    fragilityScore: maxScore,
    riskNotes,
    priorityBoost: maxScore >= 70,
    requireFallbackVerification: matches.some((m) => m.channel === 'NEWAPI' && m.modelId === 15),
    recommendedMitigations: [...new Set(mitigations)],
  };
}
