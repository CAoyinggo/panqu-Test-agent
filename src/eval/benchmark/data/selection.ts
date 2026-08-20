// Selection Benchmark（Phase 45 / 42.6）：用例选择评测基准 v1
// 输入：需求文本 + 用例集 + 风险命中 + 历史失败/flaky + 预算；
// groundTruth 为独立人工核验的 mustRun / shouldSkip / criticalCaseIds。
// 评测器运行确定性选择（selectTestCases）比对，产出 Critical Selection Recall /
// Recall@TopK / Precision@TopK / Skipped Critical Case Rate。
import type { EvaluationCase } from '../../contract.js';
import type { TestCase } from '../../../agents/test-design/testcase-schema.js';
import type { RiskAssessment, RiskCategory } from '../../../agents/risk/risk-schema.js';

export interface SelectionInput {
  text: string;
  testCases: TestCase[];
  riskAssessment?: RiskAssessment;
  history?: { failedCaseIds?: string[]; flakyCaseIds?: string[] };
  options?: { maxCases?: number };
}

export interface SelectionGroundTruth {
  mustRun: string[];
  shouldSkip: string[];
  criticalCaseIds: string[];
}

export type SelectionCase = EvaluationCase<SelectionInput, SelectionGroundTruth>;

/** 构造带步骤输入值（供参数覆盖抽样）的用例 */
function tc(id: string, priority: string, tags: string[], stepInput?: Record<string, unknown>, assertions: string[] = []): TestCase {
  return {
    id,
    feature: 'wan3',
    name: id,
    priority: priority as TestCase['priority'],
    tags,
    steps: stepInput ? [{ action: 'submit', input: stepInput }] : [{ action: 'submit' }],
    assertions: assertions.map((target) => ({ name: `校验 ${target}`, target, operator: 'exists' })),
  };
}

/** 构造最小风险评估（仅承载 affectedCases 与高风险类别） */
function riskWith(affected: string[], categories: string[] = ['concurrency', 'billing', 'security']): RiskAssessment {
  return {
    feature: 'wan3',
    risks: categories.map((category, i) => ({
      id: `risk-e${i}`,
      category: category as RiskCategory,
      level: 'high',
      title: `${category} 风险`,
      desc: `评测构造 ${category} 高风险`,
      affectedCases: affected,
      mitigation: '人工复核',
      confidence: 0.9,
    })),
    summary: { high: categories.length, medium: 0, low: 0, overall: 'high', recommendedSkip: true },
    issues: [],
    source: 'eval',
  };
}

interface SelSpec {
  id: string;
  text: string;
  cases: Array<[string, string, string[], Record<string, unknown>?, string[]?]>;
  riskAffected?: string[];
  failed?: string[];
  flaky?: string[];
  maxCases?: number;
  mustRun: string[];
  shouldSkip: string[];
  critical: string[];
  difficulty?: string;
}

function build(spec: SelSpec): SelectionCase {
  const testCases = spec.cases.map(([id, priority, tags, input, assertions]) => tc(id, priority, tags, input, assertions));
  const riskAssessment = spec.riskAffected ? riskWith(spec.riskAffected) : undefined;
  return {
    id: `sel-${spec.id}`,
    domain: 'SELECTION',
    input: {
      text: spec.text,
      testCases,
      riskAssessment,
      history: {
        failedCaseIds: spec.failed,
        flakyCaseIds: spec.flaky,
      },
      options: spec.maxCases !== undefined ? { maxCases: spec.maxCases } : undefined,
    },
    groundTruth: { mustRun: spec.mustRun, shouldSkip: spec.shouldSkip, criticalCaseIds: spec.critical },
    metadata: { feature: 'wan3', difficulty: spec.difficulty ?? 'normal', source: 'CURATED' },
  };
}

export const SELECTION_CASES: SelectionCase[] = [
  // 1. 纯 P0/P1 全量；P2/P3 无风险无覆盖缺口 → 跳过
  build({
    id: '001',
    text: '验证视频生成 1080P 与 10 秒场景',
    cases: [
      ['smoke', 'P0', []],
      ['core-10s', 'P1', [], { duration: 10 }],
      ['core-1080p', 'P1', [], { resolution: '1080P' }],
      ['p2-720p', 'P2', [], { resolution: '720P' }],
      ['p3-480p', 'P3', [], { resolution: '480P' }],
    ],
    mustRun: ['smoke', 'core-10s', 'core-1080p'],
    shouldSkip: ['p2-720p', 'p3-480p'],
    critical: ['smoke', 'core-10s', 'core-1080p'],
  }),
  // 2. 风险命中 P2 → 必须选
  build({
    id: '002',
    text: '验证视频生成并发场景',
    cases: [
      ['smoke', 'P0', []],
      ['core', 'P1', []],
      ['conc-p2', 'P2', ['concurrency']],
      ['low-p3', 'P3', []],
    ],
    riskAffected: ['conc-p2'],
    mustRun: ['smoke', 'core', 'conc-p2'],
    shouldSkip: ['low-p3'],
    critical: ['smoke', 'core', 'conc-p2'],
  }),
  // 3. 历史失败 P2 → 必须选并回归
  build({
    id: '003',
    text: '验证视频生成 1080P',
    cases: [
      ['smoke', 'P0', []],
      ['failed-p2', 'P2', [], { resolution: '1080P' }],
      ['stable-p3', 'P3', []],
    ],
    failed: ['failed-p2'],
    mustRun: ['smoke', 'failed-p2'],
    shouldSkip: ['stable-p3'],
    critical: ['smoke'],
  }),
  // 4. flaky P2 → 纳入（includeFlaky 默认 true）
  build({
    id: '004',
    text: '验证视频生成 720P',
    cases: [
      ['smoke', 'P0', []],
      ['flaky-p2', 'P2', [], { resolution: '720P' }],
      ['plain-p3', 'P3', []],
    ],
    flaky: ['flaky-p2'],
    mustRun: ['smoke', 'flaky-p2'],
    shouldSkip: ['plain-p3'],
    critical: ['smoke'],
  }),
  // 5. 预算裁剪：maxCases=2 → 裁剪非风险 P3（smoke/core 保）
  build({
    id: '005',
    text: '验证视频生成基础功能',
    cases: [
      ['smoke', 'P0', []],
      ['core', 'P1', []],
      ['p2-a', 'P2', [], { duration: 5 }],
      ['p3-b', 'P3', []],
      ['p3-c', 'P3', []],
    ],
    maxCases: 2,
    mustRun: ['smoke', 'core'],
    shouldSkip: ['p2-a', 'p3-b', 'p3-c'],
    critical: ['smoke', 'core'],
    difficulty: 'budget',
  }),
  // 6. 覆盖缺口：需求要求 4K，仅 P3 用例覆盖 → 抽样选中
  build({
    id: '006',
    text: '验证视频生成 4K 与 8K 分辨率',
    cases: [
      ['smoke', 'P0', []],
      ['p2-4k', 'P2', [], { resolution: '4K' }],
      ['p3-8k', 'P3', [], { resolution: '8K' }],
    ],
    mustRun: ['smoke', 'p2-4k', 'p3-8k'],
    shouldSkip: [],
    critical: ['smoke'],
    difficulty: 'coverage-gap',
  }),
  // 7. 计费断言用例（P2）命中 billing → 风险选中
  build({
    id: '007',
    text: '验证视频生成计费',
    cases: [
      ['smoke', 'P0', []],
      ['billing-p2', 'P2', [], { duration: 10 }, ['billing']],
      ['plain-p3', 'P3', []],
    ],
    riskAffected: ['billing-p2'],
    mustRun: ['smoke', 'billing-p2'],
    shouldSkip: ['plain-p3'],
    critical: ['smoke', 'billing-p2'],
  }),
  // 8. 安全用例（P3）但 critical → 必须选
  build({
    id: '008',
    text: '验证视频生成权限隔离',
    cases: [
      ['smoke', 'P0', []],
      ['sec-p3', 'P3', ['security']],
      ['plain-p3', 'P3', []],
    ],
    riskAffected: ['sec-p3'],
    mustRun: ['smoke', 'sec-p3'],
    shouldSkip: ['plain-p3'],
    critical: ['smoke', 'sec-p3'],
  }),
  // 9. 无需求输入值 → P2/P3 全部跳过（无覆盖缺口）
  build({
    id: '009',
    text: '验证视频生成功能',
    cases: [
      ['smoke', 'P0', []],
      ['p2-a', 'P2', []],
      ['p3-b', 'P3', []],
    ],
    mustRun: ['smoke'],
    shouldSkip: ['p2-a', 'p3-b'],
    critical: ['smoke'],
  }),
  // 10. 全部 P0/P1 大集 + 大量 P3 → 仅核心
  build({
    id: '010',
    text: '验证视频生成全链路',
    cases: [
      ['smoke', 'P0', []],
      ['core-a', 'P1', []],
      ['core-b', 'P1', []],
      ['p3-x', 'P3', []],
      ['p3-y', 'P3', []],
      ['p3-z', 'P3', []],
    ],
    mustRun: ['smoke', 'core-a', 'core-b'],
    shouldSkip: ['p3-x', 'p3-y', 'p3-z'],
    critical: ['smoke', 'core-a', 'core-b'],
  }),
  // 11. 预算裁剪保风险：maxCases=2，风险 P3 必须保
  build({
    id: '011',
    text: '验证视频生成',
    cases: [
      ['smoke', 'P0', []],
      ['risk-p3', 'P3', ['concurrency']],
      ['plain-p3', 'P3', []],
    ],
    riskAffected: ['risk-p3'],
    maxCases: 2,
    mustRun: ['smoke', 'risk-p3'],
    shouldSkip: ['plain-p3'],
    critical: ['smoke', 'risk-p3'],
    difficulty: 'budget-risk',
  }),
  // 12. 历史失败提优：failed P2 应在优先级前列
  build({
    id: '012',
    text: '验证视频生成 1080P',
    cases: [
      ['smoke', 'P0', []],
      ['hist-fail', 'P2', [], { resolution: '1080P' }],
    ],
    failed: ['hist-fail'],
    mustRun: ['smoke', 'hist-fail'],
    shouldSkip: [],
    critical: ['smoke'],
  }),
  // 13. 多风险叠加
  build({
    id: '013',
    text: '验证视频生成计费与并发',
    cases: [
      ['smoke', 'P0', []],
      ['conc-p2', 'P2', ['concurrency'], {}, ['billing']],
      ['sec-p3', 'P3', ['security']],
      ['plain-p3', 'P3', []],
    ],
    riskAffected: ['conc-p2', 'sec-p3'],
    mustRun: ['smoke', 'conc-p2', 'sec-p3'],
    shouldSkip: ['plain-p3'],
    critical: ['smoke', 'conc-p2', 'sec-p3'],
  }),
  // 14. 需求含 4K 但 P0/P1 已覆盖 → 无抽样新增
  build({
    id: '014',
    text: '验证视频生成 4K 分辨率',
    cases: [
      ['smoke', 'P0', [], { resolution: '4K' }],
      ['p2-extra', 'P2', [], { duration: 30 }],
    ],
    mustRun: ['smoke'],
    shouldSkip: ['p2-extra'],
    critical: ['smoke'],
  }),
  // 15. 需求含 5s 与 10s，P1 只覆盖 10s → P2 补 5s
  build({
    id: '015',
    text: '验证视频生成 5 秒与 10 秒时长',
    cases: [
      ['smoke', 'P0', []],
      ['core-10s', 'P1', [], { duration: 10 }],
      ['p2-5s', 'P2', [], { duration: 5 }],
      ['p3-30s', 'P3', [], { duration: 30 }],
    ],
    mustRun: ['smoke', 'core-10s', 'p2-5s'],
    shouldSkip: ['p3-30s'],
    critical: ['smoke', 'core-10s'],
    difficulty: 'coverage-gap',
  }),
  // 16. 空用例集边界 → 全空
  build({
    id: '016',
    text: '验证视频生成',
    cases: [],
    mustRun: [],
    shouldSkip: [],
    critical: [],
    difficulty: 'empty',
  }),
  // 17. 全部 P2/P3 无风险 → 全跳过
  build({
    id: '017',
    text: '验证视频生成基础功能',
    cases: [
      ['p2-a', 'P2', []],
      ['p3-b', 'P3', []],
    ],
    mustRun: [],
    shouldSkip: ['p2-a', 'p3-b'],
    critical: [],
  }),
  // 18. P0 风险命中（critical）+ P1 + P2
  build({
    id: '018',
    text: '验证视频生成支付安全',
    cases: [
      ['pay-p0', 'P0', ['security'], {}, ['billing']],
      ['core-p1', 'P1', []],
      ['p2-b', 'P2', []],
    ],
    riskAffected: ['pay-p0'],
    mustRun: ['pay-p0', 'core-p1'],
    shouldSkip: ['p2-b'],
    critical: ['pay-p0', 'core-p1'],
  }),
  // 19. 历史 flaky P3 与风险 P2 混入
  build({
    id: '019',
    text: '验证视频生成 1080P',
    cases: [
      ['smoke', 'P0', []],
      ['risk-p2', 'P2', ['concurrency']],
      ['flaky-p3', 'P3', []],
    ],
    riskAffected: ['risk-p2'],
    flaky: ['flaky-p3'],
    mustRun: ['smoke', 'risk-p2', 'flaky-p3'],
    shouldSkip: [],
    critical: ['smoke'],
  }),
  // 20. 需求 8K+120 秒，仅 P3 覆盖 → 抽样
  build({
    id: '020',
    text: '验证视频生成 8K 分辨率 120 秒',
    cases: [
      ['smoke', 'P0', []],
      ['p3-8k', 'P3', [], { resolution: '8K' }],
      ['p3-120s', 'P3', [], { duration: 120 }],
      ['p3-720p', 'P3', [], { resolution: '720P' }],
    ],
    mustRun: ['smoke', 'p3-8k', 'p3-120s'],
    shouldSkip: ['p3-720p'],
    critical: ['smoke'],
    difficulty: 'coverage-gap',
  }),
  // 21. 计费 P0 失败历史 + 计费用例
  build({
    id: '021',
    text: '验证视频生成计费正确',
    cases: [
      ['billing-p0', 'P0', [], {}, ['billing']],
      ['core-p1', 'P1', []],
      ['p2-a', 'P2', []],
    ],
    failed: ['billing-p0'],
    mustRun: ['billing-p0', 'core-p1'],
    shouldSkip: ['p2-a'],
    critical: ['billing-p0', 'core-p1'],
  }),
  // 22. 无风险小集
  build({
    id: '022',
    text: '验证视频生成 720P',
    cases: [
      ['smoke', 'P0', []],
      ['core', 'P1', []],
    ],
    mustRun: ['smoke', 'core'],
    shouldSkip: [],
    critical: ['smoke', 'core'],
  }),
  // 23. 需求无输入值但有风险用例
  build({
    id: '023',
    text: '验证视频生成功能稳定性',
    cases: [
      ['smoke', 'P0', []],
      ['sec-p2', 'P2', ['security']],
    ],
    riskAffected: ['sec-p2'],
    mustRun: ['smoke', 'sec-p2'],
    shouldSkip: [],
    critical: ['smoke', 'sec-p2'],
  }),
  // 24. 预算裁剪至 1 → 仅 P0
  build({
    id: '024',
    text: '验证视频生成',
    cases: [
      ['smoke', 'P0', []],
      ['core-p1', 'P1', []],
      ['p2-a', 'P2', []],
      ['p3-b', 'P3', []],
    ],
    maxCases: 1,
    mustRun: ['smoke'],
    shouldSkip: ['core-p1', 'p2-a', 'p3-b'],
    critical: ['smoke'],
    difficulty: 'budget',
  }),
  // 25. 全 P1 大集
  build({
    id: '025',
    text: '验证视频生成完整链路',
    cases: [
      ['c1', 'P1', []],
      ['c2', 'P1', []],
      ['c3', 'P1', []],
    ],
    mustRun: ['c1', 'c2', 'c3'],
    shouldSkip: [],
    critical: ['c1', 'c2', 'c3'],
  }),
  // 26. 需求含 1080P，P1 覆盖，P2 额外覆盖 720P → 跳过
  build({
    id: '026',
    text: '验证视频生成 1080P',
    cases: [
      ['core-p1', 'P1', [], { resolution: '1080P' }],
      ['p2-720p', 'P2', [], { resolution: '720P' }],
    ],
    mustRun: ['core-p1'],
    shouldSkip: ['p2-720p'],
    critical: ['core-p1'],
  }),
  // 27. 风险 P3（并发）+ 需求 8K 覆盖
  build({
    id: '027',
    text: '验证视频生成 8K 与并发',
    cases: [
      ['smoke', 'P0', []],
      ['conc-p3', 'P3', ['concurrency']],
      ['p3-8k', 'P3', [], { resolution: '8K' }],
    ],
    riskAffected: ['conc-p3'],
    mustRun: ['smoke', 'conc-p3', 'p3-8k'],
    shouldSkip: [],
    critical: ['smoke', 'conc-p3'],
    difficulty: 'coverage-gap',
  }),
  // 28. 双失败历史
  build({
    id: '028',
    text: '验证视频生成 4K',
    cases: [
      ['smoke', 'P0', []],
      ['f1-p2', 'P2', [], { resolution: '4K' }],
      ['f2-p3', 'P3', []],
    ],
    failed: ['f1-p2', 'f2-p3'],
    mustRun: ['smoke', 'f1-p2', 'f2-p3'],
    shouldSkip: [],
    critical: ['smoke'],
  }),
  // 29. 预算 3：P0+P1+风险 P3 保
  build({
    id: '029',
    text: '验证视频生成',
    cases: [
      ['smoke', 'P0', []],
      ['core', 'P1', []],
      ['risk-p3', 'P3', ['security']],
      ['p3-x', 'P3', []],
      ['p3-y', 'P3', []],
    ],
    riskAffected: ['risk-p3'],
    maxCases: 3,
    mustRun: ['smoke', 'core', 'risk-p3'],
    shouldSkip: ['p3-x', 'p3-y'],
    critical: ['smoke', 'core', 'risk-p3'],
    difficulty: 'budget-risk',
  }),
  // 30. 混合：失败 + flaky + 风险 + 覆盖
  build({
    id: '030',
    text: '验证视频生成 4K 与 30 秒',
    cases: [
      ['smoke', 'P0', []],
      ['f-p2', 'P2', [], { resolution: '4K' }],
      ['flaky-p3', 'P3', [], { duration: 30 }],
      ['risk-p2', 'P2', ['billing'], {}, ['billing']],
      ['p3-idle', 'P3', []],
    ],
    failed: ['f-p2'],
    flaky: ['flaky-p3'],
    riskAffected: ['risk-p2'],
    mustRun: ['smoke', 'f-p2', 'flaky-p3', 'risk-p2'],
    shouldSkip: ['p3-idle'],
    critical: ['smoke', 'risk-p2'],
    difficulty: 'mixed',
  }),
];
