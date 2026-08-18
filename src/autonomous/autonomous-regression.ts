// Autonomous Regression Controller：自治回归控制器（Phase 22.6）
// 闭环：Select(失败预测排序) → Prioritize(优先级+集群提升) → Execute → Observe →
//       Re-Plan(同标签失败提升/暂停低优先级) → Stop(自适应停止/预算上限)。
// 全部确定性，无 LLM 参与数值决策；LLM 仅用于解释（本模块只产出可解释 evidence）。

import { predictFailureBatch, type FailurePrediction } from '../failure-prediction/index.js';
import { evaluateStopping, DEFAULT_STOPPING_RULES } from '../stopping/index.js';
import {
  DEFAULT_AUTONOMOUS_BUDGET,
  type AutonomousCase,
  type AutonomousDecision,
  type AutonomousMode,
  type AutonomousRunOptions,
  type AutonomousRunResult,
  type ReplanEvent,
} from './autonomous-schema.js';
import { checkAutonomousBudget, BUDGET_LIMIT_NAMES, type AutonomousBudgetUsage } from './autonomous-budget.js';

const PRIORITY_RANK: Record<AutonomousCase['priority'], number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

/** 运行自治回归（同步、确定性、可离线模拟） */
export function runAutonomousRegression(options: AutonomousRunOptions): AutonomousRunResult {
  const mode: AutonomousMode = options.mode ?? 'autonomous';
  const budget = { ...DEFAULT_AUTONOMOUS_BUDGET, ...(options.budget ?? {}) };
  const outcomes = options.outcomes ?? {};
  const clusterTrigger = options.clusterFailureTrigger ?? 2;
  const llmCallsPerStep = options.llmCallsPerStep ?? 0;
  const approve = options.approve ?? (() => true);
  const nowMs = options.now === undefined ? Date.now() : typeof options.now === 'number' ? options.now : new Date(options.now).getTime();
  const nowIso = new Date(nowMs).toISOString();
  const runId = `autonomous-${nowMs}`;
  const evidence: string[] = [];

  const priorityOf = (c: AutonomousCase): number => PRIORITY_RANK[c.priority];
  const tagsOf = (c: AutonomousCase): string[] => c.changeTags ?? [];

  // Phase SELECT：失败预测（高失败概率 → 提前优先执行）
  const predictions: FailurePrediction[] = predictFailureBatch(
    options.cases.map((c) => ({
      caseId: c.caseId,
      historicalSamples: c.historicalSamples,
      changeImpact: c.changeImpact,
      modelRisk: c.modelRisk,
      environmentRisk: c.environmentRisk,
      riskScore: c.riskScore,
      flakyRate: c.flakyRate,
      defectDensity: c.defectDensity,
      executedOnCurrentVersion: c.executedOnCurrentVersion,
    })),
    {},
    nowMs,
  );
  const predictionById = new Map(predictions.map((p) => [p.caseId, p]));

  const boosted = new Set<string>();
  const clusterFailures = new Map<string, number>();

  // 初始执行队列：优先级 → 提升标记 → 失败概率降序 → caseId 字典序
  const buildQueue = (): string[] => {
    return [...options.cases]
      .sort((a, b) => {
        const pa = priorityOf(a) - priorityOf(b);
        if (pa !== 0) return pa;
        const ba = boosted.has(a.caseId) ? 0 : 1;
        const bb = boosted.has(b.caseId) ? 0 : 1;
        if (ba !== bb) return ba - bb;
        const fa = predictionById.get(a.caseId)?.failureProbability ?? 0;
        const fb = predictionById.get(b.caseId)?.failureProbability ?? 0;
        if (fb !== fa) return fb - fa;
        return a.caseId.localeCompare(b.caseId);
      })
      .map((c) => c.caseId);
  };

  const executed: Array<{ caseId: string; passed: boolean }> = [];
  const knownIssueReappeared: string[] = [];
  const replans: ReplanEvent[] = [];
  const used: AutonomousBudgetUsage = { cases: 0, cost: 0, replans: 0, durationMs: 0, llmCalls: 0, consecutiveReplans: 0, decisionDepth: 0 };
  let releaseBlocked = false;
  let stopping = null as AutonomousRunResult['stopping'];
  let decision: AutonomousDecision = 'COMPLETED';
  let exceededLimit: string | undefined;

  // ===== manual 模式：仅分析规划，不执行 =====
  if (mode === 'manual') {
    const initialOrder = buildQueue();
    const remaining = initialOrder;
    evidence.push(`manual 模式：仅分析规划，不执行。执行顺序建议：${remaining.join(' → ')}`);
    for (const p of predictions) {
      evidence.push(`预测 ${p.caseId}：失败概率 ${(p.failureProbability * 100).toFixed(0)}%，类别 ${p.predictedCategory}${p.evidence.length ? `（${p.evidence.join('；')}）` : ''}`);
    }
    return {
      runId,
      mode,
      decision: 'PLANNED',
      reason: 'manual 模式：AI 只分析，不自动执行（--autonomous 默认 false）',
      predictions,
      initialOrder,
      executed: [],
      remaining,
      replans: [],
      stopping: null,
      knownIssueReappeared: [],
      budgetUsed: used,
      releaseBlocked: false,
      requiresApproval: [],
      evidence,
    };
  }

  // ===== assisted / autonomous：执行闭环 =====
  const initialOrder = buildQueue();
  let queue = [...initialOrder];
  const skipped: string[] = [];
  const requiresApproval: string[] = [];
  const p0Total = options.cases.filter((c) => c.priority === 'P0').length;

  const coverageOf = (): number => (options.cases.length ? executed.length / options.cases.length : 0);
  const p0Executed = (): number => executed.filter((e) => options.cases.find((c) => c.caseId === e.caseId)?.priority === 'P0').length;
  const riskTotal = (): number =>
    predictions.reduce((s, p) => s + p.failureProbability, 0);
  const riskCoverageOf = (): number => {
    const total = riskTotal();
    if (total <= 0) return 1;
    const covered = executed.reduce((s, e) => s + (predictionById.get(e.caseId)?.failureProbability ?? 0), 0);
    return covered / total;
  };
  const infoGainOf = (): number => {
    if (queue.length === 0) return 0;
    return queue.reduce((s, id) => s + (predictionById.get(id)?.failureProbability ?? 0), 0) / queue.length;
  };

  while (queue.length > 0) {
    // 1) 预算检查 → AUTONOMOUS STOP
    const check = checkAutonomousBudget(used, budget);
    if (!check.ok) {
      decision = 'BUDGET_EXHAUSTED';
      exceededLimit = check.exceeded;
      evidence.push(`AUTONOMOUS STOP：${BUDGET_LIMIT_NAMES[check.exceeded as keyof typeof BUDGET_LIMIT_NAMES]} 达到上限`);
      break;
    }

    // 2) 自适应停止判定
    // 覆盖门禁：只有覆盖率达标（或已 BLOCK）才评估安全停止条件（coverage-met/risk-covered/low-info-gain），
    // 避免零风险场景下"风险覆盖/低信息增益"过早停止。强制停止（Release BLOCK/预算/环境异常）不受门禁限制。
    const coverageGate = coverageOf() >= DEFAULT_STOPPING_RULES.minCoverage || releaseBlocked;
    const stopInput = {
      coverage: coverageOf(),
      riskCoverage: coverageGate ? riskCoverageOf() : 0,
      p0Coverage: p0Total > 0 ? p0Executed() / p0Total : 1,
      remainingCases: queue,
      infoGain: coverageGate ? infoGainOf() : 1,
      p0Failed: releaseBlocked,
      criticalDefect: releaseBlocked,
      executedCases: executed.length,
      budgetUsedRatio: budget.maxAutonomousCases > 0 ? used.cases / budget.maxAutonomousCases : 0,
    };
    stopping = evaluateStopping(stopInput);
    if (stopping.stop) {
      decision = 'STOPPED';
      evidence.push(`停止：${stopping.reason}`);
      break;
    }

    // 3) 取下一个用例（assisted 需逐用例确认）
    const caseId = queue[0];
    const candidate = options.cases.find((c) => c.caseId === caseId)!;
    queue = queue.slice(1);

    if (mode === 'assisted' && !approve(caseId)) {
      skipped.push(caseId);
      evidence.push(`跳过 ${caseId}：assisted 模式未获人工确认`);
      continue;
    }

    const passed = outcomes[caseId] ?? true;
    executed.push({ caseId, passed });
    used.cases += 1;
    used.cost += candidate.estimatedCost ?? 0;
    used.durationMs += candidate.estimatedDurationMs ?? 0;
    used.llmCalls += llmCallsPerStep;
    const prob = predictionById.get(caseId)?.failureProbability ?? 0;
    // 决策深度：每次执行代表一层决策节点（防无限决策链）
    used.decisionDepth = (used.decisionDepth ?? 0) + 1;

    // 4) Observe：失败处理
    if (!passed) {
      if (candidate.knownIssue) {
        knownIssueReappeared.push(caseId);
        evidence.push(`已知问题 ${caseId} 复现：不重复创建缺陷（关联历史记录）`);
      }
      if (candidate.priority === 'P0') {
        releaseBlocked = true;
        evidence.push(`P0 用例 ${caseId} 失败 → Release BLOCK；暂停低优先级测试，转 RCA`);
        requiresApproval.push('release-decision (BLOCK)');
      }
      // 集群失败计数（按相关性标签）
      const tags = tagsOf(candidate);
      let clusterHit = false;
      for (const t of tags) {
        const n = (clusterFailures.get(t) ?? 0) + 1;
        clusterFailures.set(t, n);
        if (n >= clusterTrigger) clusterHit = true;
      }

      // 5) Re-Plan：同标签失败 → 提升剩余相关用例；集群/ P0 失败 → 暂停低优先级
      if (queue.length > 0) {
        const related = queue.filter((id) => {
          const cc = options.cases.find((c) => c.caseId === id);
          return cc && tagsOf(cc).some((t) => tags.includes(t));
        });
        let action = '无';
        if (related.length > 0) {
          related.forEach((id) => boosted.add(id));
          action = `提升 ${related.length} 个相关用例优先级（${related.join('、')}）`;
          evidence.push(`重新规划：${caseId} 失败（标签 ${tags.join('、')}）→ ${action}`);
        }
        if (releaseBlocked || clusterHit) {
          const before = queue.length;
          queue = queue.filter((id) => {
            const cc = options.cases.find((c) => c.caseId === id);
            return cc?.priority === 'P0';
          });
          const paused = before - queue.length;
          if (paused > 0) {
            action += `${action === '无' ? '' : '；'}暂停 ${paused} 个低优先级用例，仅执行 P0`;
            evidence.push(`暂停低优先级用例 ${paused} 个：${releaseBlocked ? 'P0 失败' : `集群失败 ${clusterTrigger} 次`}`);
          }
        }
        replans.push({ at: nowIso, failedCase: caseId, cause: tags.length ? `标签 ${tags.join('、')} 关联失败` : '失败信号', boostedCases: [...related], action });
        used.replans += 1;
        used.consecutiveReplans = (used.consecutiveReplans ?? 0) + 1;
        evidence.push(`执行 ${caseId} → FAIL（预测 ${(prob * 100).toFixed(0)}%）`);
      }
    } else {
      // 成功重置连续重规划计数
      used.consecutiveReplans = 0;
      evidence.push(`执行 ${caseId} → PASS（预测 ${(prob * 100).toFixed(0)}%）`);
    }

    // 集群/Release 触发后队列重新排序
    if (boosted.size > 0 || releaseBlocked) {
      const remainingSet = new Set(queue);
      queue = buildQueue().filter((id) => remainingSet.has(id));
    }

    // P0 失败 → Release BLOCK 是权威信号，立即停止（不受 minExecutedCases 防过早保护影响）
    if (releaseBlocked) {
      decision = 'BLOCKED';
      evidence.push('P0 失败为权威信号：立即停止，转 RCA 与 Release BLOCK 判定');
      break;
    }
  }

  // ===== 收尾决策 =====
  // 优先级：预算超限 > Release BLOCK（P0 失败）> 自适应停止 > 正常完成
  if (decision === 'BUDGET_EXHAUSTED') {
    // 保持 BUDGET_EXHAUSTED
  } else if (releaseBlocked) {
    decision = 'BLOCKED';
  } else if (decision !== 'STOPPED') {
    decision = 'COMPLETED';
  }

  const reason =
    decision === 'BUDGET_EXHAUSTED'
      ? `AUTONOMOUS STOP：${BUDGET_LIMIT_NAMES[exceededLimit as keyof typeof BUDGET_LIMIT_NAMES]} 达到上限`
      : decision === 'BLOCKED'
        ? 'Release BLOCK：P0 失败，已暂停低优先级测试'
        : decision === 'STOPPED'
          ? `自适应停止：${stopping?.reason ?? '停止条件满足'}`
          : `完成：执行 ${executed.length}/${options.cases.length} 个用例，通过 ${executed.filter((e) => e.passed).length} 个`;

  return {
    runId,
    mode,
    decision,
    reason,
    predictions,
    initialOrder,
    executed,
    remaining: queue,
    replans,
    stopping,
    knownIssueReappeared,
    budgetUsed: used,
    exceededLimit,
    releaseBlocked,
    requiresApproval,
    evidence,
  };
}
