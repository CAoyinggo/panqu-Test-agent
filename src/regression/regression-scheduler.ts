// Regression Scheduler：回归调度器（Phase 21.3）
// 端到端编排：变更事件 → 影响分析 → 回归计划 → 运行记录 → runId 资产串联。
// 触发源：PR / 发布 / 模型发布 / 配置变化 / 价格变化 / 环境变化 / 人工 / 定时。

import type { BusinessRegistry } from '../business/registry.js';
import type { TestAssetStore } from '../test-assets/asset-store.js';
import { analyzeChangeImpact } from './impact-analyzer.js';
import { planRegression, type RegressionPlanOptions } from './regression-planner.js';
import type { RegressionHistory } from './regression-history.js';
import {
  normalizeChangeEvent,
  type ChangeEvent,
  type RegressionPlan,
  type RegressionRun,
  type RegressionRunStatus,
  type RegressionTriggerType,
} from './regression-schema.js';

/** 回归运行结果输入 */
export interface RegressionOutcome {
  status: RegressionRunStatus;
  passRate: number;
  failures?: Array<{ caseId: string; rcaId?: string; defectId?: string }>;
  taskId?: string;
  durationMs?: number;
}

export class RegressionScheduler {
  constructor(
    private readonly store: TestAssetStore,
    private readonly history: RegressionHistory,
    private readonly registry?: BusinessRegistry,
  ) {}

  /** 触发回归：变更 → 影响分析 → 回归计划（不执行全量 Case） */
  trigger(changeInput: unknown, trigger: RegressionTriggerType, options: RegressionPlanOptions = {}): RegressionPlan {
    const change = normalizeChangeEvent(changeInput);
    const impact = analyzeChangeImpact(change, this.store, this.registry);
    // 候选用例：受影响业务的 test-case（影响为空时不选择任何用例）
    const candidates = this.store.query({ type: 'test-case' });
    return planRegression(impact, candidates, trigger, options);
  }

  /** 完成回归：记录运行历史，并将 runId 串联进测试资产库 */
  completeRun(plan: RegressionPlan, feature: string, outcome: RegressionOutcome): RegressionRun {
    const startedAt = new Date().toISOString();
    const run: RegressionRun = {
      runId: plan.runId,
      taskId: outcome.taskId,
      feature,
      trigger: plan.trigger,
      change: plan.change,
      caseIds: [...plan.selected.p0, ...plan.selected.p1, ...plan.selected.p2],
      status: outcome.status,
      passRate: outcome.passRate,
      failures: outcome.failures ?? [],
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: outcome.durationMs ?? 0,
    };
    this.history.record(run);
    this.linkRunToAssets(run);
    return run;
  }

  /** runId 资产串联：execution 资产（metadata.runId）+ case 关联 + 失败链路 */
  private linkRunToAssets(run: RegressionRun): void {
    let execAsset;
    try {
      execAsset = this.store.create({
        id: `exec-${run.runId}`,
        type: 'execution',
        feature: run.feature,
        tags: ['regression', run.trigger],
        content: { status: run.status, passRate: run.passRate, caseIds: run.caseIds },
        metadata: { runId: run.runId, taskId: run.taskId, trigger: run.trigger },
      });
    } catch {
      execAsset = this.store.get(`exec-${run.runId}`);
    }
    if (!execAsset) return;
    for (const caseId of run.caseIds) {
      if (this.store.has(caseId)) this.store.link(caseId, execAsset.id, 'executes');
    }
    for (const failure of run.failures) {
      if (failure.rcaId && this.store.has(failure.rcaId)) {
        this.store.link(execAsset.id, failure.rcaId, 'failed-as');
        if (failure.defectId && this.store.has(failure.defectId)) {
          this.store.link(failure.rcaId, failure.defectId, 'caused');
        }
      }
    }
  }
}

export function createRegressionScheduler(
  store: TestAssetStore,
  history: RegressionHistory,
  registry?: BusinessRegistry,
): RegressionScheduler {
  return new RegressionScheduler(store, history, registry);
}
