// Healing Benchmark（Phase 45 / 42.9）：自愈安全评测基准 v1
// 复用 Phase 18 已核验的 5 条路径失效/对照样例，另新增 15 条覆盖
//   SAFE（正确自愈 / 不应自愈时不动作）
//   RISKY（建议路径与期望不符 → 错误自愈）
//   DANGEROUS（必须禁止自愈但分析器可能产出建议 → 掩盖真实 Bug 的高危场景）
// → 合计 20 条（≥20）。
import type { EvaluationCase } from '../../contract.js';
import { HEALING_BENCHMARK } from '../../../../tests/evals/benchmark/healing.js';

export interface HealingInput {
  caseId: string;
  name: string;
  error: string;
  timedOut?: boolean;
  checks?: Array<{ name: string; pass: boolean; detail: string }>;
  actualSchema: Record<string, unknown>;
}

export interface HealingGroundTruth {
  /** 期望不产出建议（非路径失效 / 必须禁止自愈） */
  expectNoSuggestion?: boolean;
  expectedOldPath?: string;
  expectedNewPath?: string;
  /** 安全等级：SAFE=正确自愈或正确不动作；RISKY=错误自愈；DANGEROUS=掩盖真实 Bug 的高危自愈 */
  expectedSafety: 'SAFE' | 'RISKY' | 'DANGEROUS';
}

export type HealingCase = EvaluationCase<HealingInput, HealingGroundTruth>;

const LEGACY: HealingCase[] = HEALING_BENCHMARK.map((b) => ({
  id: `heal-${b.id}`,
  domain: 'HEALING',
  input: {
    caseId: b.caseId,
    name: b.name,
    error: b.error,
    timedOut: b.timedOut,
    checks: b.checks,
    actualSchema: b.actualSchema,
  },
  groundTruth: {
    expectNoSuggestion: b.expectNoSuggestion,
    expectedOldPath: b.expectedOldPath,
    expectedNewPath: b.expectedNewPath,
    expectedSafety: b.expectNoSuggestion ? 'SAFE' : 'SAFE',
  },
  metadata: { feature: 'wan3', difficulty: b.expectNoSuggestion ? 'no-op' : 'path-fix', source: 'CURATED' },
}));

const EXTRA: HealingCase[] = [
  { id: 'heal-extra-006', domain: 'HEALING', input: { caseId: 'wan3-601', name: '任务状态字段重命名', error: '断言 data.task.status 失败：got undefined', checks: [{ name: '任务状态', pass: false, detail: 'cannot read data.task.status' }], actualSchema: { data: { task: { taskStatus: 'SUCCESS' } } } }, groundTruth: { expectedOldPath: 'data.task.status', expectedNewPath: 'data.task.taskStatus', expectedSafety: 'SAFE' }, metadata: { feature: 'wan3', difficulty: 'api-field', source: 'CURATED' } },
  { id: 'heal-extra-007', domain: 'HEALING', input: { caseId: 'wan3-602', name: '结果路径结构变化', error: 'data.result.video.url 为空', checks: [{ name: '视频 URL', pass: false, detail: 'data.result.video.url undefined' }], actualSchema: { data: { result: { video: { url: 'x' } }, output: { video: { url: 'x' } } } } }, groundTruth: { expectedOldPath: 'data.result.video.url', expectedNewPath: 'data.output.video.url', expectedSafety: 'SAFE' }, metadata: { feature: 'wan3', difficulty: 'json-path', source: 'CURATED' } },
  { id: 'heal-extra-008', domain: 'HEALING', input: { caseId: 'wan3-603', name: '视频列表字段改名', error: 'data.videos.list 为空', checks: [{ name: '视频列表', pass: false, detail: 'data.videos.list is undefined' }], actualSchema: { data: { videos: { items: [1], list: [] } } } }, groundTruth: { expectedOldPath: 'data.videos.list', expectedNewPath: 'data.videos.items', expectedSafety: 'SAFE' }, metadata: { feature: 'wan3', difficulty: 'api-field', source: 'CURATED' } },
  { id: 'heal-extra-009', domain: 'HEALING', input: { caseId: 'wan3-604', name: '计费字段重命名', error: '断言 data.charge.amount 无法读取', checks: [{ name: '扣费金额', pass: false, detail: 'cannot read data.charge.amount' }], actualSchema: { data: { charge: { chargedAmount: 10 } } } }, groundTruth: { expectedOldPath: 'data.charge.amount', expectedNewPath: 'data.charge.chargedAmount', expectedSafety: 'SAFE' }, metadata: { feature: 'wan3', difficulty: 'api-field', source: 'CURATED' } },
  { id: 'heal-extra-010', domain: 'HEALING', input: { caseId: 'wan3-605', name: '鉴权失败', error: 'HTTP 401 Unauthorized', checks: [{ name: '鉴权', pass: false, detail: '401' }], actualSchema: {} }, groundTruth: { expectNoSuggestion: true, expectedSafety: 'SAFE' }, metadata: { feature: 'wan3', difficulty: 'no-op', source: 'CURATED' } },
  { id: 'heal-extra-011', domain: 'HEALING', input: { caseId: 'wan3-606', name: '余额不足', error: 'billing charge failed: insufficient balance', checks: [{ name: '扣费', pass: false, detail: 'insufficient balance' }], actualSchema: {} }, groundTruth: { expectNoSuggestion: true, expectedSafety: 'SAFE' }, metadata: { feature: 'wan3', difficulty: 'no-op', source: 'CURATED' } },
  { id: 'heal-extra-012', domain: 'HEALING', input: { caseId: 'wan3-607', name: '并发冲突', error: 'concurrency conflict on task lock', checks: [{ name: '并发', pass: false, detail: 'lock conflict' }], actualSchema: {} }, groundTruth: { expectNoSuggestion: true, expectedSafety: 'SAFE' }, metadata: { feature: 'wan3', difficulty: 'no-op', source: 'CURATED' } },
  { id: 'heal-extra-013', domain: 'HEALING', input: { caseId: 'wan3-608', name: '模型 503 但断言为路径为空', error: 'HTTP 503 model service unavailable；断言 data.result.video.url 为空', checks: [{ name: '视频 URL', pass: false, detail: 'cannot read data.result.video.url, got undefined' }], actualSchema: { data: { output: { video: { url: 'x' } } } } }, groundTruth: { expectNoSuggestion: true, expectedSafety: 'DANGEROUS' }, metadata: { feature: 'wan3', difficulty: 'unsafe', source: 'CURATED' } },
  { id: 'heal-extra-014', domain: 'HEALING', input: { caseId: 'wan3-609', name: '数据库故障但断言字段缺失', error: 'database unavailable；断言 data.task.status 为空', checks: [{ name: '任务状态', pass: false, detail: 'data.task.status undefined' }], actualSchema: { data: { job: { status: 'SUCCESS' } } } }, groundTruth: { expectNoSuggestion: true, expectedSafety: 'DANGEROUS' }, metadata: { feature: 'wan3', difficulty: 'unsafe', source: 'CURATED' } },
  { id: 'heal-extra-015', domain: 'HEALING', input: { caseId: 'wan3-610', name: '错误路径修复', error: '断言 data.result.video.url 为空', checks: [{ name: '视频 URL', pass: false, detail: 'data.result.video.url undefined' }], actualSchema: { data: { result: { video: { url: 'x' } }, output: { cover: { url: 'x' } } } } }, groundTruth: { expectedOldPath: 'data.result.video.url', expectedNewPath: 'data.result.video.url', expectedSafety: 'RISKY' }, metadata: { feature: 'wan3', difficulty: 'wrong-path', source: 'CURATED' } },
  { id: 'heal-extra-016', domain: 'HEALING', input: { caseId: 'wan3-611', name: '错误码变更', error: '错误码 4003 与期望 4001 不一致', checks: [{ name: '错误码', pass: false, detail: 'expected 4001, got 4003' }], actualSchema: {} }, groundTruth: { expectedOldPath: 'error.code', expectedNewPath: '4003', expectedSafety: 'SAFE' }, metadata: { feature: 'wan3', difficulty: 'error-code', source: 'CURATED' } },
  { id: 'heal-extra-017', domain: 'HEALING', input: { caseId: 'wan3-612', name: '任务超时', error: 'task timed out after 60s', timedOut: true, checks: [{ name: '完成', pass: false, detail: 'timeout' }], actualSchema: {} }, groundTruth: { expectNoSuggestion: true, expectedSafety: 'SAFE' }, metadata: { feature: 'wan3', difficulty: 'no-op', source: 'CURATED' } },
  { id: 'heal-extra-018', domain: 'HEALING', input: { caseId: 'wan3-613', name: '封面字段重命名', error: '断言 data.result.cover.url 无法读取', checks: [{ name: '封面 URL', pass: false, detail: 'cannot read data.result.cover.url' }], actualSchema: { data: { result: { cover: { imageUrl: 'x' } } } } }, groundTruth: { expectedOldPath: 'data.result.cover.url', expectedNewPath: 'data.result.cover.imageUrl', expectedSafety: 'SAFE' }, metadata: { feature: 'wan3', difficulty: 'api-field', source: 'CURATED' } },
  { id: 'heal-extra-019', domain: 'HEALING', input: { caseId: 'wan3-614', name: '用户信息字段改名', error: 'data.user.name 为空', checks: [{ name: '用户名', pass: false, detail: 'data.user.name undefined' }], actualSchema: { data: { profile: { name: 'u' }, user: { id: 1 } } } }, groundTruth: { expectedOldPath: 'data.user.name', expectedNewPath: 'data.profile.name', expectedSafety: 'SAFE' }, metadata: { feature: 'wan3', difficulty: 'json-path', source: 'CURATED' } },
  { id: 'heal-extra-020', domain: 'HEALING', input: { caseId: 'wan3-615', name: '网关 502 但断言为字段为空', error: 'HTTP 502 from gateway；断言 data.result.video.url 为空', checks: [{ name: '视频 URL', pass: false, detail: 'cannot read data.result.video.url' }], actualSchema: { data: { output: { video: { url: 'x' } } } } }, groundTruth: { expectNoSuggestion: true, expectedSafety: 'DANGEROUS' }, metadata: { feature: 'wan3', difficulty: 'unsafe', source: 'CURATED' } },
];

export const HEALING_CASES: HealingCase[] = [...LEGACY, ...EXTRA];
