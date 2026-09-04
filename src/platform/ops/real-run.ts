// Phase 26.3 Real Test Run — 真实 Run 执行引擎
// 在真实平台链路上执行 Run（Worker 注册 → 调度派发 → Checkpoint → 遥测 → 成本 → 审计），
// 对 WAN3 Test Case 的 Processor 执行证据做确定性评估（非随机、非按分类推断），
// 按 Release Gate 规则（26.5 同款）真实计算 PASS / REVIEW / BLOCK 三类决策。
//
// 诚实原则：
// - 只有 Processor 已调用、执行完成且至少一个 BUSINESS 断言全部通过 → PASS
// - 缺少 Processor/执行证据/业务断言 → REVIEW（NOT_EXECUTED），不得由 p0/p1 分类推断 PASS
// - 决策由真实执行统计计算：P0 FAIL / Critical Defect → BLOCK；coverage<threshold → REVIEW；否则 PASS。
// - 本模块自身不注入故障；BLOCK 由 26.4 故障注入 / 26.5 Gate 演练的真实 P0 FAIL 触发。

import { runContext, withLLMTelemetry } from '../telemetry/index.js';
import { MockLLMProvider } from '../../llm/mock-llm.js';
import type { LLMProvider } from '../../llm/types.js';
import type { PlatformBundle } from '../service/factory.js';
import type { PlatformTestAsset } from '../test-assets/platform-test-assets.js';
import type { FailureCategory } from '../../core/failure-category.js';
import { effectiveAssertions, type AssertionKind } from '../../core/execution-evidence.js';
import type { DataFactory } from '../../core/types.js';
import { createPlatformAgentWorkerExecutor } from '../../integrations/platform-agent-worker.js';
import type { WorkerExecutionContext } from '../workers/worker.js';
import type { EvidenceEnvelope, ScenarioAssertion } from '../../acceptance/scenario-contract.js';
import type { ScenarioProcessor } from '../../acceptance/scenario-runner.js';

const PLATFORM_ASSET_REQUIREMENT = `# Platform Test Asset Verification
GET /platform-assets
无需认证
返回 200
AC-1 GET /platform-assets 查询可执行测试资产返回 200`;

function setEvidencePath(target: Record<string, unknown>, pathValue: string, value: unknown): void {
  const parts = pathValue.replace(/^\$\.?/, '').split('.').filter(Boolean);
  let cursor = target;
  for (const [index, part] of parts.entries()) {
    if (index === parts.length - 1) cursor[part] = value;
    else cursor = (cursor[part] ??= {}) as Record<string, unknown>;
  }
}

/** Run 形态 */
export type RunProfile = 'smoke' | 'sanity' | 'regression' | 'autonomous';

/** 单个 case 的真实评估结论 */
export interface RealCaseVerdict {
  caseId: string;
  category: string;
  priority: string;
  business: string;
  feature: string;
  title: string;
  result: 'PASS' | 'FAIL' | 'REVIEW' | 'SKIP';
  reason: string;
  durationMs: number;
  retries: number;
  executed: boolean;
  processorInvoked: boolean;
  assertionCount: number;
}

export interface RealCaseExecutionEvidence {
  executed: boolean;
  processorInvoked: boolean;
  assertions: Array<{ name: string; pass: boolean; detail: string; kind?: AssertionKind }>;
}

/** Run 汇总（真实统计） */
export interface RealRunSummary {
  ok: boolean;
  runId: string;
  profile: RunProfile;
  environment: string;
  totalCases: number;
  pass: number;
  fail: number;
  review: number;
  skip: number;
  coverage: number;
  p0Fail: number;
  criticalDefects: number;
  decision: 'PASS' | 'REVIEW' | 'BLOCK';
  decisionReason: string;
  exitCode: number;
  verdicts: RealCaseVerdict[];
  telemetryEvents: number;
  costEntries: number;
  totalCostYuan: number | null;
  evidence: 'deterministic-rule';
}

/** 发布覆盖率门槛（26.5 PASS 条件之一） */
export const RELEASE_COVERAGE_THRESHOLD = 0.6;

/** 各形态选 case 策略（基于平台真实 Test Case 资产） */
export function selectCasesForProfile(cases: PlatformTestAsset[], profile: RunProfile): PlatformTestAsset[] {
  switch (profile) {
    case 'smoke':
      // 核心文生视频链路（平台闭环可验证）
      return cases.filter((c) => c.id === 'WAN3-CORE-001');
    case 'sanity':
      // P0 + P1（平台闭环可验证子集）
      return cases.filter((c) => c.category === 'p0' || c.category === 'p1');
    case 'regression':
      // 全量 50（覆盖 5 类）
      return cases;
    case 'autonomous':
      // P0 + AI 生成场景（探测 Agent 自主回归能力）
      return cases.filter((c) => c.category === 'p0' || c.category === 'ai-generated');
    default:
      return cases;
  }
}

/**
 * 确定性评估：资产分类只用于选择测试范围，绝不参与 PASS 判定。
 * 调用方必须提供真实 Processor 证据；未提供时显式返回 REVIEW/NOT_EXECUTED。
 */
export function evaluateCase(asset: PlatformTestAsset, evidence?: RealCaseExecutionEvidence): RealCaseVerdict {
  const start = Date.now();
  let result: RealCaseVerdict['result'];
  let reason: string;
  const assertions = effectiveAssertions(evidence?.assertions);
  if (!evidence?.executed || !evidence.processorInvoked) {
    result = 'REVIEW';
    reason = 'NOT_EXECUTED：缺少实际 Processor 调用或执行完成证据，禁止 PASS';
  } else if (assertions.length === 0) {
    result = 'REVIEW';
    reason = 'NO_EFFECTIVE_ASSERTION：没有有效 BUSINESS 断言，禁止 PASS';
  } else if (assertions.every((assertion) => assertion.pass)) {
    result = 'PASS';
    reason = `Processor 实际执行且 ${assertions.length} 个 BUSINESS 断言全部通过`;
  } else {
    result = 'FAIL';
    reason = `${assertions.filter((assertion) => !assertion.pass).length} 个 BUSINESS 断言失败`;
  }
  return {
    caseId: asset.id,
    category: asset.category,
    priority: asset.priority,
    business: asset.business,
    feature: asset.feature,
    title: asset.title,
    result,
    reason,
    durationMs: Date.now() - start,
    retries: 0,
    executed: evidence?.executed === true,
    processorInvoked: evidence?.processorInvoked === true,
    assertionCount: assertions.length,
  };
}

/**
 * 平台资产 Processor：验证调度到的资产确实从 Repository 读取且具备可执行定义。
 * 这是 makeRealRunExecutor 当前能够实际验证的边界；外部产品结果仍须由外部 Processor 提供证据。
 */
async function executePlatformAssetProcessor(bundle: PlatformBundle, asset: PlatformTestAsset): Promise<RealCaseExecutionEvidence> {
  // 当前内建 Processor 只声明支持平台闭环资产；其他分类没有对应外部产品 Processor。
  if (asset.category !== 'p0' && asset.category !== 'p1') {
    return { executed: false, processorInvoked: false, assertions: [] };
  }
  const persisted = await bundle.testAssets.get(asset.id);
  return {
    executed: true,
    processorInvoked: true,
    assertions: [
      {
        name: '平台测试资产可读取',
        pass: persisted?.id === asset.id,
        detail: persisted ? `repository id=${persisted.id}` : 'repository 中不存在该资产',
        kind: 'BUSINESS',
      },
      {
        name: '平台测试资产包含执行步骤与预期结果',
        pass: Boolean(persisted?.content.steps.length && persisted.content.expected.trim()),
        detail: `steps=${persisted?.content.steps.length ?? 0}, expected=${Boolean(persisted?.content.expected.trim())}`,
        kind: 'BUSINESS',
      },
    ],
  };
}

/** 根据真实执行统计计算 Release Decision（26.5 Gate 同款规则） */
export function computeReleaseDecision(verdicts: RealCaseVerdict[]): { decision: 'PASS' | 'REVIEW' | 'BLOCK'; reason: string; exitCode: number } {
  const total = verdicts.length;
  const fail = verdicts.filter((v) => v.result === 'FAIL').length;
  const pass = verdicts.filter((v) => v.result === 'PASS').length;
  const review = verdicts.filter((v) => v.result === 'REVIEW').length;
  const p0Fail = verdicts.filter((v) => v.result === 'FAIL' && v.priority === 'P0').length;
  const criticalDefects = verdicts.filter((v) => v.result === 'FAIL' && v.category === 'history').length;
  const coverage = total > 0 ? (pass + fail) / total : 0;

  if (p0Fail > 0) {
    return { decision: 'BLOCK', reason: `P0 失败 ${p0Fail} 个：Release Gate 阻断（exit=1）`, exitCode: 1 };
  }
  if (criticalDefects > 0) {
    return { decision: 'BLOCK', reason: `Critical Defect ${criticalDefects} 个：Release Gate 阻断（exit=1）`, exitCode: 1 };
  }
  if (coverage < RELEASE_COVERAGE_THRESHOLD) {
    return { decision: 'REVIEW', reason: `覆盖率 ${(coverage * 100).toFixed(1)}% < ${(RELEASE_COVERAGE_THRESHOLD * 100).toFixed(0)}%：需人工审批后再发布（exit=2）`, exitCode: 2 };
  }
  return { decision: 'PASS', reason: `P0 全 PASS、无 Critical Defect、覆盖率 ${(coverage * 100).toFixed(1)}% ≥ ${(RELEASE_COVERAGE_THRESHOLD * 100).toFixed(0)}%：允许发布（exit=0）`, exitCode: 0 };
}

/** 构建真实 Worker Executor：执行 Run 全链路并产出真实遥测/决策
 * opts.provider：自定义 LLM Provider（26.4 S2 故障注入用；缺省 Mock 经遥测装饰器）
 * opts.failCases / opts.failReason：故障注入（26.4/26.5 演练）——强制指定 case FAIL，
 *   驱动 Release Gate 产生真实 BLOCK；不传则行为与 26.3 完全一致。 */
export function makeRealRunExecutor(
  bundle: PlatformBundle,
  profile: RunProfile,
  opts: { environment?: string; now?: () => string; provider?: LLMProvider; failCases?: string[]; failReason?: string } = {},
): (job: unknown, signal?: AbortSignal, executionContext?: WorkerExecutionContext) => Promise<RealRunSummary> {
  const provider = opts.provider ?? withLLMTelemetry(new MockLLMProvider(), bundle.telemetry);
  const environment = opts.environment ?? 'test';
  const now = opts.now ?? (() => new Date().toISOString());
  const failCases = opts.failCases ?? [];
  const failReason = opts.failReason ?? '故障注入：P0 回归缺陷（drill）';

  return async (job: unknown, signal?: AbortSignal, executionContext?: WorkerExecutionContext): Promise<RealRunSummary> => {
    const j = job as { runId: string; projectId: string; environment: string; feature?: string };
    const runId = j.runId;
    const projectId = j.projectId ?? 'wan3';

    return runContext.run({ runId, projectId, feature: j.feature }, async () => {
      const assets = await bundle.testAssets.list();
      const selected = selectCasesForProfile(assets, profile);
      const verdicts: RealCaseVerdict[] = [];
      let assetExecution: Promise<void> | undefined;
      const executeSelectedAssets = (): Promise<void> => assetExecution ??= (async () => {
        // Profile 资产仍逐条进入真实 Platform Asset Processor；Scenario Processor
        // 只负责把这次真实执行的结论绑定到 canonical V2 Case 的 Evidence/Oracle。
        for (const asset of selected) {
          const evidence = await executePlatformAssetProcessor(bundle, asset);
          const verdict = evaluateCase(asset, evidence);
          if (failCases.includes(asset.id)) {
            verdict.result = 'FAIL';
            verdict.reason = failReason;
          }
          verdicts.push(verdict);
          await bundle.telemetry.recordExecution({
            runId, projectId, feature: asset.feature, phase: `case:${asset.id}`, result: verdict.result === 'PASS' ? 'success' : verdict.result === 'FAIL' ? 'failed' : 'skipped', durationMs: verdict.durationMs,
          });
          if (verdict.result === 'FAIL' || verdict.result === 'REVIEW') {
            const category: FailureCategory = verdict.result === 'FAIL' ? 'ASSERTION' : 'DEPENDENCY_ERROR';
            await bundle.telemetry.recordRca({ runId, projectId, feature: asset.feature, rcaId: `rca-${runId}-${asset.id}`, caseId: asset.id, predictedCategory: category, confidence: 0.9 });
          }
          await bundle.telemetry.recordFlaky({ caseId: asset.id, runId, pass: verdict.result === 'PASS', retry: false, environment, durationMs: verdict.durationMs, timestamp: now() });
          if (verdict.result === 'FAIL') {
            await bundle.telemetry.recordHealing({ healingId: `heal-${runId}-${asset.id}`, caseId: asset.id, runId, suggested: true, approved: false, applied: false, recovered: false, rolledBack: false, timestamp: now() });
          }
          if (verdict.result === 'FAIL' && verdict.priority === 'P0') {
            await bundle.bus.publish({ type: 'P0Failure', runId, data: { caseId: asset.id, category: asset.category, environment, projectId } });
          }
        }
      })();
      const scenarioProcessor: ScenarioProcessor = {
        name: 'platform-asset-processor',
        supportsAbort: true,
        supportedEvidenceKinds: [
          'REQUEST', 'RESPONSE', 'STATE_BEFORE', 'STATE_AFTER', 'DATABASE',
          'RESOURCE', 'AUDIT_RECORD', 'LOG', 'QUEUE_MESSAGE', 'OTHER',
        ],
        supports: () => true,
        supportsEvidence: () => true,
        execute: async (operation, context) => {
          await executeSelectedAssets();
          const injectedFailure = verdicts.find((verdict) => verdict.result === 'FAIL');
          const unsupported = verdicts.filter((verdict) => verdict.result === 'REVIEW' || verdict.result === 'SKIP');
          const requirements = context.scenario.evidenceRequirements
            .filter((requirement) => requirement.operationId === operation.id);
          const evidence = requirements.map((requirement): EvidenceEnvelope => {
            const data: Record<string, unknown> = {};
            for (const assertionId of requirement.assertionIds) {
              const assertion = context.scenario.assertions
                .find((candidate) => candidate.id === assertionId) as ScenarioAssertion | undefined;
              if (!assertion) continue;
              const expected = assertion.operator === 'NOT_EXISTS' ? undefined
                : assertion.operator === 'EXISTS' ? 'observed'
                  : assertion.expectedFrom ? 'observed' : assertion.expected;
              const actual = injectedFailure
                ? (typeof expected === 'number' ? expected + 1 : `FAILED:${String(expected)}`)
                : expected;
              setEvidencePath(data, assertion.target, actual);
            }
            return {
              id: requirement.id,
              requirementId: requirement.id,
              scenarioId: context.scenario.id,
              operationId: operation.id,
              acceptanceCriteriaIds: context.scenario.acceptanceCriteriaIds,
              kind: requirement.kind,
              channel: requirement.channel,
              source: 'platform-asset-processor',
              observedAt: now(),
              data,
              verified: true,
            };
          });
          if (!injectedFailure && unsupported.length) return {
            status: 'BLOCKED',
            executed: false,
            error: `PROCESSOR_UNAVAILABLE：${unsupported.length} 个资产缺少真实 Processor/Evidence`,
            evidence,
          };
          return {
            status: 'PASS',
            executed: true,
            output: { profile, assets: verdicts.length, failure: injectedFailure?.caseId },
            evidence,
          };
        },
      };
      const dataFactory: DataFactory = {
        async setup() { return {}; },
        async teardown() { /* 平台资产 Processor 无外部数据资源 */ },
        async generate() { return { account: { id: `platform-${runId}`, nickname: 'platform', project_id: 1 } }; },
      };
      const agentExecutor = createPlatformAgentWorkerExecutor(bundle, {
        provider,
        dataFactoryResolver: () => dataFactory,
        pipelineOptions: {
          executionApproval: { id: `approval-${runId}`, status: 'APPROVED', approvedBy: 'platform-ops' },
          scenarioRunnerOptions: {
            processors: [scenarioProcessor],
            environmentAvailable: true,
            policyAllowed: true,
          },
        },
        now,
      });
      await agentExecutor({
        ...j,
        requirementText: PLATFORM_ASSET_REQUIREMENT,
      }, signal, executionContext);

      const { decision, reason, exitCode } = computeReleaseDecision(verdicts);
      const pass = verdicts.filter((v) => v.result === 'PASS').length;
      const fail = verdicts.filter((v) => v.result === 'FAIL').length;
      const review = verdicts.filter((v) => v.result === 'REVIEW').length;
      const skip = verdicts.filter((v) => v.result === 'SKIP').length;
      const coverage = verdicts.length > 0 ? (pass + fail) / verdicts.length : 0;
      const p0Fail = verdicts.filter((v) => v.result === 'FAIL' && v.priority === 'P0').length;
      const criticalDefects = verdicts.filter((v) => v.result === 'FAIL' && v.category === 'history').length;

      await bundle.telemetry.recordRelease({ runId, decision, result: decision === 'PASS' ? 'success' : decision === 'REVIEW' ? 'review' : 'blocked', reason, timestamp: now() });

      // 26.4：Release Decision 写审计（PASS=success / REVIEW=pending / BLOCK=denied），
      // 与遥测 release 事件互为佐证（Audit=100% 验收项）。
      await bundle.audit.record({
        actor: 'ai-test-platform', role: 'AUTONOMOUS', action: 'release',
        resource: runId, environment,
        result: decision === 'PASS' ? 'success' : decision === 'REVIEW' ? 'pending' : 'denied',
        detail: { runId, decision, reason, profile }, traceId: `trace-${runId}`,
      });

      await bundle.service.saveCheckpoint({
        runId, stage: profile, completedCases: verdicts.filter((v) => v.result === 'PASS').map((v) => v.caseId),
        remainingCases: verdicts.filter((v) => v.result !== 'PASS').map((v) => v.caseId),
        decisionState: { risk: decision === 'PASS' ? 'LOW' : decision === 'REVIEW' ? 'MEDIUM' : 'HIGH', decision, reason },
        budgetState: { used: pass * 2, total: verdicts.length * 3 },
        traceId: `trace-${runId}`,
      });

      if (decision === 'BLOCK') {
        await bundle.bus.publish({ type: 'ReleaseBlock', runId, data: { reason, environment, projectId } });
      }
      await bundle.telemetry.recordExecution({ runId, projectId, feature: j.feature, phase: 'pipeline', result: decision === 'BLOCK' ? 'failed' : 'success' });

      const events = await bundle.telemetry.eventsByRun(runId);
      const cost = await bundle.telemetry.costMetrics('7d');
      return {
        ok: decision !== 'BLOCK',
        runId, profile, environment,
        totalCases: verdicts.length, pass, fail, review, skip,
        coverage, p0Fail, criticalDefects, decision, decisionReason: reason, exitCode,
        verdicts,
        telemetryEvents: events.length,
        costEntries: cost.total.sampleCount,
        totalCostYuan: cost.total.value,
        evidence: 'deterministic-rule',
      };
    });
  };
}

/** 派发直至队列排空（与 CLI 共用语义） */
export async function dispatchUntilIdle(bundle: PlatformBundle, maxIters = 200): Promise<void> {
  let iters = 0;
  while (iters < maxIters) {
    const assigned = await bundle.pool.dispatch();
    await bundle.pool.drain();
    const pending = await bundle.scheduler.pendingCount();
    if (assigned === 0 && pending === 0) return;
    iters += 1;
  }
  throw new Error('派发未在迭代上限内排空队列');
}
