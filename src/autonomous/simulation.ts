// Autonomous Simulation：自治模式离线模拟（Phase 22.6 / 二十三）
// 使用 Synthetic Changes / Synthetic Failures / Synthetic History / Synthetic Budget。
// 覆盖 5 个 Scenario：模型变更 / 连续失败 / 测试已充分覆盖 / 发现高风险失败 / 历史问题重新出现。
// 必须完全离线：无 LLM、无外部依赖，确定性可复现。

import { runAutonomousRegression } from './autonomous-regression.js';
import type { AutonomousBudget, AutonomousCase, AutonomousRunOptions, AutonomousRunResult } from './autonomous-schema.js';

const DAY = 86400000;
const BASE = '2026-07-01T00:00:00Z';

/** 构造样本：total 个样本，failIndexes 索引位置失败 */
function history(total: number, failIndexes: number[]): Array<{ passed: boolean; at: string }> {
  const start = new Date(BASE).getTime();
  return Array.from({ length: total }, (_, i) => ({
    passed: !failIndexes.includes(i),
    at: new Date(start + i * DAY).toISOString(),
  }));
}

/** 场景定义 */
export interface AutonomousScenario {
  id: string;
  name: string;
  description: string;
  cases: AutonomousCase[];
  outcomes: Record<string, boolean>;
  budget?: Partial<AutonomousBudget>;
  options?: Partial<AutonomousRunOptions>;
}

/** 5 个完整 Scenario（任务书三十） */
export const AUTONOMOUS_SCENARIOS: AutonomousScenario[] = [
  {
    id: 'scenario-1-model-change',
    name: '模型变更',
    description: 'Model A → Model B：Change Impact → Risk Prediction → Priority Update → Regression',
    // 4 个模型 B 相关用例（高变更 + 历史失败）应优先于 4 个模型 A 用例执行
    cases: [
      ...['mb-1', 'mb-2', 'mb-3', 'mb-4'].map((id): AutonomousCase => ({
        caseId: id, priority: 'P1', changeTags: ['model:modelB'],
        changeImpact: 0.8, executedOnCurrentVersion: false,
        historicalSamples: history(10, [0, 3, 6, 8]),
      })),
      ...['ma-1', 'ma-2', 'ma-3', 'ma-4'].map((id): AutonomousCase => ({
        caseId: id, priority: 'P1', changeTags: ['model:modelA'],
        changeImpact: 0, executedOnCurrentVersion: true,
        historicalSamples: history(10, []),
      })),
    ],
    outcomes: Object.fromEntries(['mb-1', 'mb-2', 'mb-3', 'mb-4', 'ma-1', 'ma-2', 'ma-3', 'ma-4'].map((id) => [id, true])),
  },
  {
    id: 'scenario-2-consecutive-failure',
    name: '连续失败',
    description: '同类 Case 连续失败：Failure Rate ↑ → Risk ↑ → Priority ↑（Knowledge Update 在 22.7）',
    cases: ['q-1', 'q-2', 'q-3', 'q-4', 'q-5', 'q-6'].map((id): AutonomousCase => ({
      caseId: id, priority: 'P2', changeTags: ['queue'], historicalSamples: history(10, []),
    })),
    outcomes: { 'q-1': false, 'q-2': false, 'q-3': true, 'q-4': true, 'q-5': true, 'q-6': true },
    options: { clusterFailureTrigger: 3 }, // 连续 3 次才暂停，验证连续 2 次失败即触发重新规划
  },
  {
    id: 'scenario-3-sufficient-coverage',
    name: '测试已充分覆盖',
    description: 'Coverage ≥ 95% / P0 = 100% / Risk = 100% → Adaptive Stop',
    cases: [
      ...['p0-a', 'p0-b', 'p0-c', 'p0-d'].map((id): AutonomousCase => ({
        caseId: id, priority: 'P0', historicalSamples: history(10, []),
      })),
      ...['p2-e', 'p2-f', 'p2-g', 'p2-h', 'p2-i', 'p2-j'].map((id): AutonomousCase => ({
        caseId: id, priority: 'P2', historicalSamples: history(10, []),
      })),
    ],
    outcomes: Object.fromEntries(['p0-a', 'p0-b', 'p0-c', 'p0-d', 'p2-e', 'p2-f', 'p2-g', 'p2-h', 'p2-i', 'p2-j'].map((id) => [id, true])),
  },
  {
    id: 'scenario-4-p0-failure',
    name: '发现高风险失败',
    description: 'P0 Failure → 停止低优先级测试 → RCA → Release BLOCK',
    cases: [
      { caseId: 'p0-1', priority: 'P0', historicalSamples: history(10, []) },
      { caseId: 'p0-2', priority: 'P0', changeTags: ['billing'], historicalSamples: history(10, [0, 4]) },
      { caseId: 'p0-3', priority: 'P0', historicalSamples: history(10, []) },
      ...['p2-x', 'p2-y', 'p2-z', 'p2-w'].map((id): AutonomousCase => ({
        caseId: id, priority: 'P2', historicalSamples: history(10, []),
      })),
    ],
    outcomes: { 'p0-1': true, 'p0-2': false, 'p0-3': true, 'p2-x': true, 'p2-y': true, 'p2-z': true, 'p2-w': true },
  },
  {
    id: 'scenario-5-known-issue-reappear',
    name: '历史问题重新出现',
    description: 'Failure → Knowledge Retrieval → Known Issue：不重复创建缺陷，提高相关 Case Priority',
    cases: [
      { caseId: 'hist-1', priority: 'P1', changeTags: ['legacy'], knownIssue: true, historicalSamples: history(10, [0, 1, 2]) },
      { caseId: 'legacy-2', priority: 'P1', changeTags: ['legacy'], historicalSamples: history(10, []) },
      { caseId: 'legacy-3', priority: 'P1', changeTags: ['legacy'], historicalSamples: history(10, []) },
      { caseId: 'other-1', priority: 'P1', changeTags: ['other'], historicalSamples: history(10, []) },
    ],
    outcomes: { 'hist-1': false, 'legacy-2': true, 'legacy-3': true, 'other-1': true },
  },
];

/** 运行单个 Scenario */
export function runScenario(id: string, overrides: Partial<AutonomousRunOptions> = {}): AutonomousRunResult {
  const scenario = AUTONOMOUS_SCENARIOS.find((s) => s.id === id);
  if (!scenario) throw new Error(`未知 Scenario：${id}`);
  return runAutonomousRegression({
    cases: scenario.cases,
    outcomes: scenario.outcomes,
    budget: scenario.budget,
    ...scenario.options,
    ...overrides,
  });
}

/** 运行全部 Scenario，返回结果数组 */
export function runAllScenarios(overrides: Partial<AutonomousRunOptions> = {}): AutonomousRunResult[] {
  return AUTONOMOUS_SCENARIOS.map((s) => runScenario(s.id, overrides));
}
