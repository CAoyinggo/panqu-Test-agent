// RCA Benchmark（Phase 45 / 42.7）：根因分析评测基准 v1
// 复用 Phase 18 已核验的 30 条失败场景（historical/environment/model），
// 另新增 8 条覆盖 ASSERTION/TIMEOUT/DATA/NETWORK/UNKNOWN 与权限类 → 合计 38 条（≥30）。
// groundTruth 为独立人工核验的根因类别（source=CURATED）。
import type { EvaluationCase } from '../../contract.js';
import { FAILURE_BENCHMARK } from '../../../../tests/evals/benchmark/failures.js';

export interface RcaInput {
  caseId: string;
  name: string;
  error: string;
  timedOut?: boolean;
  checks?: Array<{ name: string; pass: boolean; detail: string }>;
}

export interface RcaGroundTruth {
  category: string;
}

export type RcaCase = EvaluationCase<RcaInput, RcaGroundTruth>;

const LEGACY: RcaCase[] = FAILURE_BENCHMARK.map((b) => ({
  id: `rca-${b.id}`,
  domain: 'RCA',
  input: { caseId: b.caseId, name: b.name, error: b.error, timedOut: b.timedOut, checks: b.checks },
  groundTruth: { category: b.expectedCategory },
  metadata: { feature: 'wan3', difficulty: b.kind, source: 'CURATED' },
}));

const EXTRA: RcaCase[] = [
  { id: 'rca-extra-001', domain: 'RCA', input: { caseId: 'wan3-501', name: '权限拒绝', error: 'HTTP 403 Forbidden', checks: [{ name: '鉴权通过', pass: false, detail: '403 Forbidden' }] }, groundTruth: { category: 'AUTH_ERROR' }, metadata: { feature: 'wan3', difficulty: 'permission', source: 'CURATED' } },
  { id: 'rca-extra-002', domain: 'RCA', input: { caseId: 'wan3-502', name: '配置缺失', error: 'config not found: MODEL_ENDPOINT', checks: [{ name: '配置存在', pass: false, detail: 'MODEL_ENDPOINT undefined' }] }, groundTruth: { category: 'ENVIRONMENT_ERROR' }, metadata: { feature: 'wan3', difficulty: 'config', source: 'CURATED' } },
  { id: 'rca-extra-003', domain: 'RCA', input: { caseId: 'wan3-503', name: '断言字段类型错误', error: '断言 data.result.video.duration 应为数字', checks: [{ name: 'duration 类型', pass: false, detail: 'expected number, got string' }] }, groundTruth: { category: 'ASSERTION' }, metadata: { feature: 'wan3', difficulty: 'assertion', source: 'CURATED' } },
  { id: 'rca-extra-004', domain: 'RCA', input: { caseId: 'wan3-504', name: '依赖服务 5xx', error: 'HTTP 500 from dependency payment service', checks: [{ name: '支付可用', pass: false, detail: '500' }] }, groundTruth: { category: 'DEPENDENCY_ERROR' }, metadata: { feature: 'wan3', difficulty: 'dependency', source: 'CURATED' } },
  { id: 'rca-extra-005', domain: 'RCA', input: { caseId: 'wan3-505', name: '未知崩溃', error: 'Segmentation fault in worker', checks: [{ name: '进程存活', pass: false, detail: 'crashed' }] }, groundTruth: { category: 'UNKNOWN' }, metadata: { feature: 'wan3', difficulty: 'unknown', source: 'CURATED' } },
  { id: 'rca-extra-006', domain: 'RCA', input: { caseId: 'wan3-506', name: '任务状态字段断言', error: '断言 data.task.status 应为 SUCCESS', checks: [{ name: '任务状态', pass: false, detail: 'expected SUCCESS, got PENDING' }] }, groundTruth: { category: 'ASSERTION' }, metadata: { feature: 'wan3', difficulty: 'assertion', source: 'CURATED' } },
  { id: 'rca-extra-007', domain: 'RCA', input: { caseId: 'wan3-507', name: 'DNS 解析失败', error: 'ENOTFOUND model.internal', checks: [{ name: '域名解析', pass: false, detail: 'ENOTFOUND' }] }, groundTruth: { category: 'NETWORK_ERROR' }, metadata: { feature: 'wan3', difficulty: 'network', source: 'CURATED' } },
  { id: 'rca-extra-008', domain: 'RCA', input: { caseId: 'wan3-508', name: '请求体过大', error: 'HTTP 413 Payload Too Large', checks: [{ name: '请求提交', pass: false, detail: '413' }] }, groundTruth: { category: 'DATA_ERROR' }, metadata: { feature: 'wan3', difficulty: 'data', source: 'CURATED' } },
];

export const RCA_CASES: RcaCase[] = [...LEGACY, ...EXTRA];
