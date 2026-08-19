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
      const { files, passRate, hasBlockingIssue } = await engine.runTask(
        cfg,
        c.def,
        envName,
        feature,
        options.reporter ?? null,
        false,
        undefined,
        options.autoSetup === true,
      );
      reports.push(...files);
      results.push({
        caseId: String(c.def.extra?.agentTestCaseId ?? c.def.name),
        name: c.name,
        feature: c.feature,
        scene: c.def.scene,
        priority: Array.isArray(c.def.tags) ? c.def.tags.find((t) => /^P[0-3]$/.test(t)) : undefined,
        tags: c.def.tags,
        pass: passRate === 100 && !hasBlockingIssue,
        passRate,
        durationMs: Date.now() - t0,
      });
    } catch (e: any) {
      results.push({
        caseId: String(c.def.extra?.agentTestCaseId ?? c.def.name),
        name: c.name,
        feature: c.feature,
        scene: c.def.scene,
        pass: false,
        passRate: 0,
        error: e.message,
        durationMs: Date.now() - t0,
      });
    }
  }

  const outcome = computeOutcome(feature, results, { reports, executed: true });
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
