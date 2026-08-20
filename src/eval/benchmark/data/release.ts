// Release Benchmark（Phase 45 / 42.10）：发布决策评测基准 v1
// 输入：发布决策输入（P0/P1 统计 / 覆盖率 / 严重缺陷 / 风险 / 失败预测 / 环境 / 模型变更等）；
// groundTruth 为独立人工核验的三态决策 PASS / REVIEW / BLOCK。
// 评测器运行确定性发布决策（decideRelease）比对，产出 False Pass / False Block /
// False Review / Critical Release Miss（应 BLOCK 却放行）。
import type { EvaluationCase } from '../../contract.js';
import type { ReleaseDecisionInput } from '../../../release-decision/release-decision-schema.js';

export interface ReleaseGroundTruth {
  decision: 'PASS' | 'REVIEW' | 'BLOCK';
}

export type ReleaseCase = EvaluationCase<ReleaseDecisionInput, ReleaseGroundTruth>;

function RE(
  id: string,
  input: ReleaseDecisionInput,
  decision: 'PASS' | 'REVIEW' | 'BLOCK',
  difficulty = 'normal',
): ReleaseCase {
  return {
    id: `release-${id}`,
    domain: 'RELEASE',
    input,
    groundTruth: { decision },
    metadata: { feature: 'wan3', difficulty, source: 'CURATED' },
  };
}

export const RELEASE_CASES: ReleaseCase[] = [
  RE('001', { p0: { total: 5, passed: 5 }, p1: { total: 20, passed: 20 }, coverage: 0.95, criticalDefects: 0, riskLevel: 'LOW' }, 'PASS'),
  RE('002', { p0: { total: 5, passed: 4 }, p1: { total: 20, passed: 20 }, coverage: 0.95, criticalDefects: 0 }, 'BLOCK', 'p0'),
  RE('003', { p0: { total: 5, passed: 5 }, p1: { total: 20, passed: 20 }, coverage: 0.95, criticalDefects: 1 }, 'BLOCK', 'critical'),
  RE('004', { p0: { total: 5, passed: 5 }, p1: { total: 20, passed: 20 }, coverage: 0.95, criticalDefects: 0, environmentAbnormal: true }, 'BLOCK', 'environment'),
  RE('005', { p0: { total: 5, passed: 5 }, p1: { total: 20, passed: 19 }, coverage: 0.95, criticalDefects: 0 }, 'REVIEW', 'p1-rate'),
  RE('006', { p0: { total: 5, passed: 5 }, p1: { total: 20, passed: 20 }, coverage: 0.85, criticalDefects: 0 }, 'REVIEW', 'coverage'),
  RE('007', { p0: { total: 5, passed: 5 }, p1: { total: 20, passed: 20 }, coverage: 0.95, criticalDefects: 0, flakyCount: 2 }, 'REVIEW', 'flaky'),
  RE('008', { p0: { total: 5, passed: 5 }, p1: { total: 20, passed: 20 }, coverage: 0.95, criticalDefects: 0, knownIssues: 1 }, 'REVIEW', 'known-issue'),
  RE('009', { p0: { total: 5, passed: 5 }, p1: { total: 20, passed: 20 }, coverage: 0.95, criticalDefects: 0, riskLevel: 'HIGH' }, 'REVIEW', 'risk'),
  RE('010', { p0: { total: 5, passed: 5 }, p1: { total: 20, passed: 20 }, coverage: 0.95, criticalDefects: 0, failurePrediction: 0.6 }, 'REVIEW', 'prediction'),
  RE('011', { p0: { total: 5, passed: 5 }, p1: { total: 20, passed: 20 }, coverage: 0.95, criticalDefects: 0, historicalFailureRate: 0.4 }, 'REVIEW', 'history'),
  RE('012', { p0: { total: 5, passed: 5 }, p1: { total: 20, passed: 20 }, coverage: 0.95, criticalDefects: 0, modelChange: true }, 'REVIEW', 'model-change'),
  RE('013', { p0: { total: 3, passed: 3 }, p1: { total: 10, passed: 10 }, coverage: 0.91, criticalDefects: 0, riskLevel: 'LOW', flakyCount: 0 }, 'PASS'),
  RE('014', { p0: { total: 5, passed: 5 }, p1: { total: 20, passed: 17 }, coverage: 0.95, criticalDefects: 0 }, 'REVIEW', 'p1-rate'),
  RE('015', { p0: { total: 5, passed: 5 }, p1: { total: 20, passed: 19 }, coverage: 0.95, criticalDefects: 1 }, 'BLOCK', 'critical'),
  RE('016', { p0: { total: 5, passed: 5 }, p1: { total: 20, passed: 20 }, coverage: 0.95, criticalDefects: 0, environmentAbnormal: true, flakyCount: 3 }, 'BLOCK', 'environment'),
  RE('017', { p0: { total: 5, passed: 5 }, p1: { total: 20, passed: 19 }, coverage: 0.85, criticalDefects: 0, knownIssues: 1, riskLevel: 'MEDIUM' }, 'REVIEW', 'multi-soft'),
  RE('018', { p0: { total: 10, passed: 10 }, p1: { total: 50, passed: 50 }, coverage: 0.99, criticalDefects: 0, riskLevel: 'LOW', failurePrediction: 0.1, historicalFailureRate: 0.05 }, 'PASS'),
  RE('019', { p0: { total: 5, passed: 4 }, p1: { total: 20, passed: 20 }, coverage: 0.95, criticalDefects: 2 }, 'BLOCK', 'p0-critical'),
  RE('020', { p0: { total: 5, passed: 5 }, p1: { total: 20, passed: 20 }, coverage: 0.95, criticalDefects: 0, environmentAbnormal: true, knownIssues: 2 }, 'BLOCK', 'environment'),
  RE('021', { p0: { total: 5, passed: 5 }, p1: { total: 20, passed: 18 }, coverage: 0.88, criticalDefects: 0, riskLevel: 'HIGH', flakyCount: 3, knownIssues: 2 }, 'BLOCK', 'accumulated-risk'),
  RE('022', { p0: { total: 0, passed: 0 }, p1: { total: 0, passed: 0 }, coverage: 1, criticalDefects: 0 }, 'PASS', 'empty'),
  RE('023', { p0: { total: 5, passed: 5 }, p1: { total: 20, passed: 20 }, coverage: 0.95, criticalDefects: 0, failurePrediction: 0.9, historicalFailureRate: 0.7, riskLevel: 'HIGH' }, 'BLOCK', 'accumulated-risk'),
  RE('024', { p0: { total: 2, passed: 1 }, p1: { total: 10, passed: 10 }, coverage: 0.9, criticalDefects: 0 }, 'BLOCK', 'p0'),
  RE('025', { p0: { total: 5, passed: 5 }, p1: { total: 20, passed: 20 }, coverage: 0.92, criticalDefects: 0, riskLevel: 'LOW', modelChange: false }, 'PASS'),
  RE('026', { p0: { total: 5, passed: 5 }, p1: { total: 20, passed: 20 }, coverage: 0.95, criticalDefects: 0, flakyCount: 5 }, 'REVIEW', 'flaky'),
  RE('027', { p0: { total: 5, passed: 5 }, p1: { total: 20, passed: 20 }, coverage: 0.95, criticalDefects: 0, environmentAbnormal: true }, 'BLOCK', 'environment'),
  RE('028', { p0: { total: 5, passed: 5 }, p1: { total: 20, passed: 20 }, coverage: 0.95, criticalDefects: 0, riskLevel: 'LOW', modelChange: false, knownIssues: 0, flakyCount: 0 }, 'PASS'),
  RE('029', { p0: { total: 5, passed: 5 }, p1: { total: 20, passed: 20 }, coverage: 0.95, criticalDefects: 0, historicalFailureRate: 0.45 }, 'REVIEW', 'history'),
  RE('030', { p0: { total: 5, passed: 5 }, p1: { total: 20, passed: 19 }, coverage: 0.82, criticalDefects: 0, flakyCount: 2 }, 'REVIEW', 'multi-soft'),
];
