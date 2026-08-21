// Execution Run Tool：Agent 访问现有 Execution Engine 的唯一通道
// 封装核心引擎（Engine.runTask），供 Execution Agent 通过 Tool Registry 安全调用，
// 遵循「Agent 必须经 Tool 调用执行能力，禁止 AI 直接触碰 engine/pipeline」约束。
// runner 可注入：离线测试传 mock，CLI 模式使用真实引擎。

import type { AgentContext } from '../core/agent-context.js';
import type { AgentTool, ToolPermission } from '../tools/tool.js';
import type { LoadedCase } from '../../cases/loader.js';
import type { AppConfig } from '../../core/types.js';
import { Engine, registerScene } from '../../core/engine.js';
import { loadConfig } from '../../config/config.js';
import { getEnvFromEnv } from '../../config/env-loader.js';
import { autoLoadScenes } from '../../plugins/loader.js';
import { getDataFactory } from '../../core/data-factory.js';
import { logger } from '../../utils/logger.js';
import { computeOutcome, ExecutionOutcome } from './execution-schema.js';
import type { RunTaskResult } from '../../core/engine.js';
import type { LoadedCase as RunnerLoadedCase } from '../../cases/loader.js';

/** 执行选项 */
export interface ExecutionRunOptions {
  env?: string;
  func?: string;
  autoSetup?: boolean;
  dryRun?: boolean;
  concurrency?: number;
  reporter?: string | null;
}

/** 执行器签名（可注入 mock） */
export type ExecutionRunner = (
  cases: LoadedCase[],
  options: ExecutionRunOptions,
) => Promise<ExecutionOutcome>;

/** 将核心引擎结果转为 Agent CaseResult；执行状态采用 fail-closed 语义。 */
export function caseResultFromEngine(
  c: RunnerLoadedCase,
  result: RunTaskResult,
  durationMs: number,
) {
  const pass = result.executed && result.status === 'PASS' && result.passRate === 100 && !result.hasBlockingIssue;
  return {
    caseId: String(c.def.extra?.agentTestCaseId ?? c.def.name),
    name: c.name,
    feature: c.feature,
    scene: c.def.scene,
    priority: Array.isArray(c.def.tags) ? c.def.tags.find((t) => /^P[0-3]$/.test(t)) : undefined,
    tags: c.def.tags,
    executed: result.executed,
    status: result.status,
    pass,
    passRate: pass ? result.passRate : 0,
    error: pass ? undefined : result.status === 'NOT_EXECUTED'
      ? 'NOT_EXECUTED：未完成真实 Processor 执行'
      : result.status === 'BLOCKED'
        ? 'BLOCKED：执行未完成或没有有效断言'
        : result.status === 'FAIL'
          ? 'FAIL：断言未通过'
          : undefined,
    checks: result.checks.map((check) => ({ name: check.name, pass: check.pass, detail: check.detail, level: check.level })),
    durationMs,
  };
}

/** 真实执行器：调用现有 Engine 逐条执行用例并聚合结果 */
export const realEngineRunner: ExecutionRunner = async (cases, options) => {
  const envName = options.env || getEnvFromEnv() || 'test';
  let cfg: AppConfig;
  try {
    cfg = loadConfig(envName);
  } catch (e) {
    throw new Error(`配置加载失败：${(e as Error).message}`);
  }

  // 自动扫描加载场景处理器
  const loadedScenes = await autoLoadScenes();
  for (const [name, handler] of Object.entries(loadedScenes)) {
    registerScene(name, handler);
  }

  const engine = new Engine();
  const feature = options.func || cases[0]?.feature || 'default';
  const results = [];
  const reports: string[] = [];

  for (const c of cases) {
    const t0 = Date.now();
    try {
      const engineResult = await engine.runTask(
        cfg,
        c.def,
        envName,
        feature,
        options.reporter ?? null,
        false,
        undefined,
        options.autoSetup === true,
      );
      reports.push(...engineResult.files);
      results.push(caseResultFromEngine(c, engineResult, Date.now() - t0));
    } catch (e: any) {
      results.push({
        caseId: String(c.def.extra?.agentTestCaseId ?? c.def.name),
        name: c.name,
        feature: c.feature,
        scene: c.def.scene,
        executed: false,
        status: 'BLOCKED' as const,
        pass: false,
        passRate: 0,
        error: e.message,
        durationMs: Date.now() - t0,
      });
    }
  }

  const allExecuted = results.length > 0 && results.every((result) => result.executed !== false && result.status !== 'NOT_EXECUTED');
  const outcome = computeOutcome(feature, results, { reports, executed: allExecuted });
  logger.info(`执行引擎完成：${outcome.summary}`);
  return outcome;
};

/** Execution Run Tool 实现 */
export class ExecutionRunTool implements AgentTool<{ cases: LoadedCase[]; options?: ExecutionRunOptions }, ExecutionOutcome> {
  name = 'execution.run';
  description = '通过现有执行引擎执行测试用例，返回结构化执行结果';
  permission: ToolPermission = 'safe';
  inputSchema = {
    type: 'object',
    required: ['cases'],
    properties: {
      cases: { type: 'array' },
      options: { type: 'object' },
    },
  };
  outputSchema = { type: 'object' };
  timeoutMs = 600_000;

  constructor(private runner: ExecutionRunner = realEngineRunner) {}

  async execute(input: { cases: LoadedCase[]; options?: ExecutionRunOptions }, context: AgentContext): Promise<ExecutionOutcome> {
    if (!input?.cases?.length) {
      context.logger.warn('execution.run 无输入用例，返回空结果');
      return computeOutcome('default', [], { executed: false });
    }
    const outcome = await this.runner(input.cases, input.options ?? {});
    context.logger.info(`execution.run 完成：${outcome.summary}`);
    return outcome;
  }
}

/** 便捷工厂：创建 Execution Run Tool（可注入自定义执行器便于测试） */
export function createExecutionRunTool(runner?: ExecutionRunner): ExecutionRunTool {
  return new ExecutionRunTool(runner);
}

/** 内部工具：注册的数据工厂解析（供 --auto-setup 透传） */
export { getDataFactory };
