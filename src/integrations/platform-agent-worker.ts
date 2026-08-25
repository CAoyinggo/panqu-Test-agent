// Platform Worker → Agent Pipeline 适配器。
// Run 只有在 Requirement / Policy Gate / Runner / Deterministic Outcome 全部产生可审计证据后
// 才能进入 COMPLETED；blocked / unexecuted / partial execution 一律 fail-close。

import {
  createAgentContext,
  createDataPrepareTool,
  createExecutionRunTool,
  effectiveCaseAssertions,
  NoopMemory,
  runAgentPipeline,
  ToolRegistry,
  type AgentPipelineInput,
  type ExecutionRunner,
} from '../agents/index.js';
import { ExecutionAbortError } from '../core/abort.js';
import type { DataFactory } from '../core/types.js';
import { MockLLMProvider } from '../llm/mock-llm.js';
import type { LLMProvider } from '../llm/types.js';
import { runContext } from '../platform/telemetry/index.js';
import type { PlatformBundle } from '../platform/service/factory.js';
import type { WorkerExecutor } from '../platform/workers/worker.js';

interface PlatformAgentJob {
  runId: string;
  projectId: string;
  environment: string;
  feature?: string;
  requirementText?: string;
  approvalId?: string;
  trigger?: string;
  change?: { type?: string; target?: string };
}

export interface PlatformAgentExecutorOptions {
  provider?: LLMProvider;
  runner?: ExecutionRunner;
  dataFactoryResolver?: (name: string) => DataFactory;
  pipelineOptions?: AgentPipelineInput['options'];
  now?: () => string;
}

function requirementOf(job: PlatformAgentJob): string {
  if (job.requirementText?.trim()) return job.requirementText.trim();
  const target = job.feature ?? job.change?.target ?? job.projectId;
  return target.toLowerCase() === 'wan3'
    ? '测试 WAN3 文生视频功能，验证任务提交成功和业务结果正确'
    : `测试 ${target} 功能，验证核心业务流程和结果正确`;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new ExecutionAbortError('CANCELLED', 'Platform Worker 已取消，禁止继续写入执行结果');
  }
}

/** 构造真正进入 runAgentPipeline 的 Platform Worker。 */
export function createPlatformAgentWorkerExecutor(
  bundle: PlatformBundle,
  options: PlatformAgentExecutorOptions = {},
): WorkerExecutor {
  const provider = options.provider ?? new MockLLMProvider();
  const now = options.now ?? (() => new Date().toISOString());

  return async (payload, signal) => {
    const job = payload as PlatformAgentJob;
    if (!job?.runId || !job.projectId || !job.environment) {
      throw new Error('Platform Agent Worker payload 缺少 runId/projectId/environment');
    }
    throwIfAborted(signal);

    return runContext.run({ runId: job.runId, projectId: job.projectId, feature: job.feature }, async () => {
      await bundle.service.startRun(job.runId);
      let executionStarted = false;
      const tools = new ToolRegistry({ environment: job.environment });
      tools.register(createDataPrepareTool(options.dataFactoryResolver));
      tools.register(createExecutionRunTool(options.runner));
      const context = createAgentContext({
        taskId: job.runId,
        feature: job.feature ?? job.projectId,
        environment: job.environment,
        tools,
        memory: new NoopMemory(),
        llm: provider,
        metadata: { platformRunId: job.runId, platformApprovalId: job.approvalId },
      });

      try {
        const pipeline = await runAgentPipeline({
          requirementText: requirementOf(job),
          environment: job.environment,
          options: {
            ...options.pipelineOptions,
            signal,
            lifecycle: {
              onPolicyGateEvaluated: async (gate) => {
                if (gate.allowed) await bundle.service.markRunGated(job.runId);
                await options.pipelineOptions?.lifecycle?.onPolicyGateEvaluated?.(gate);
              },
              onExecutionStarting: async () => {
                await bundle.service.beginRunExecution(job.runId);
                executionStarted = true;
                await options.pipelineOptions?.lifecycle?.onExecutionStarting?.();
              },
            },
          },
        }, context);
        throwIfAborted(signal);

        const timestamp = now();
        const evidence = pipeline.outcome.results.map((result) => {
          const assertions = effectiveCaseAssertions(result);
          return {
            evidenceId: `${pipeline.runId}:${result.caseId}:evidence`,
            runId: job.runId,
            caseId: result.caseId,
            executed: result.executed === true,
            processor: result.processor ?? result.scene,
            processorInvoked: result.processorInvoked ?? result.executed === true,
            requestId: result.requestId,
            executionStatus: result.status,
            effectiveAssertions: assertions.length,
            assertionResults: assertions.map((item) => ({
              name: item.name,
              pass: item.pass,
              kind: item.kind,
            })),
            timestamp: result.timestamp ?? timestamp,
          };
        });
        const hasBlockedCase = pipeline.outcome.results.some((result) => (
          result.executed !== true
          || result.status === 'NOT_EXECUTED'
          || result.status === 'BLOCKED'
          || result.status === 'TIMEOUT'
          || result.status === 'CANCELLED'
        ));
        const result = !pipeline.policyGate.allowed
          ? 'BLOCKED'
          : !pipeline.outcome.executed || pipeline.outcome.total === 0
            ? 'NOT_EXECUTED'
            : hasBlockedCase
              ? 'BLOCKED'
              : pipeline.outcome.failed > 0 || pipeline.outcome.timedOut > 0
                ? 'FAIL'
                : 'PASS';
        const executedCount = evidence.filter((item) => (
          item.executed && item.processorInvoked && item.effectiveAssertions > 0
        )).length;
        const executionStatus = result === 'PASS'
          ? 'PASSED'
          : result === 'FAIL'
            ? 'FAILED'
            : pipeline.outcome.timedOut > 0
              ? 'TIMEOUT'
              : result;
        const record = {
          executionMode: 'VERIFIED_AGENT',
          requirementEvidence: {
            exists: true,
            requirementId: pipeline.requirementsHash,
            value: pipeline.requirement,
          },
          policyGate: {
            status: pipeline.policyGate.allowed ? 'ALLOW' : 'BLOCKED',
            value: pipeline.policyGate,
          },
          execution: {
            executionId: pipeline.runId,
            started: executionStarted,
            finished: executionStarted && pipeline.stages.execution === true,
            plan: pipeline.executionPlan,
          },
          evidence,
          outcome: {
            exists: true,
            outcomeId: `${pipeline.runId}:outcome`,
            executionStatus,
            executedCount,
            value: pipeline.outcome,
          },
          result,
          recordedAt: timestamp,
        } as const;

        throwIfAborted(signal);
        await bundle.service.recordRunExecution(job.runId, record);
        await bundle.service.saveCheckpoint({
          runId: job.runId,
          stage: 'agent-pipeline',
          completedCases: pipeline.outcome.results.filter((item) => item.status === 'PASS').map((item) => item.caseId),
          remainingCases: pipeline.outcome.results.filter((item) => item.status !== 'PASS').map((item) => item.caseId),
          decisionState: { result, policyVerdict: pipeline.policyGate.verdict },
          knowledgeState: { requirement: pipeline.requirement, evidence, outcome: pipeline.outcome },
          budgetState: pipeline.budgetStatus ?? {},
          traceId: pipeline.runId,
        });
        throwIfAborted(signal);

        await bundle.telemetry.recordExecution({
          runId: job.runId,
          projectId: job.projectId,
          feature: pipeline.requirement.feature,
          phase: 'agent-pipeline',
          result: result === 'PASS' ? 'success' : result === 'FAIL' ? 'failed' : 'skipped',
          durationMs: pipeline.durationMs,
        });
        if (result === 'BLOCKED' || result === 'NOT_EXECUTED') {
          if (executionStatus === 'TIMEOUT') {
            await bundle.service.timeoutRun(job.runId, 'TIMEOUT：Agent Pipeline 未形成可完成执行证据');
          } else {
            await bundle.service.blockRun(job.runId, `${result}：Agent Pipeline 未形成完整实际执行证据`);
          }
        } else {
          await bundle.service.completeRun(job.runId);
        }
        return pipeline;
      } catch (error) {
        if (!signal?.aborted) {
          const run = await bundle.service.getRun(job.runId);
          if (run && ['PLANNING', 'GATED', 'RUNNING', 'EVIDENCE_READY'].includes(run.status)) {
            await bundle.service.failRun(job.runId, (error as Error).message);
          }
        }
        throw error;
      }
    });
  };
}
