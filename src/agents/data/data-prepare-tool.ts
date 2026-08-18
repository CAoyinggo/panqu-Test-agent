// Data Prepare Tool：Agent 访问测试数据准备能力的唯一通道
// 封装现有 core/data-factory.ts 的 DataFactory 注册表（setup/generate），
// 供 Data Agent / Execution Agent 通过 Tool Registry 安全调用，遵循
// 「Agent 必须经 Tool 调用执行能力，禁止直接触碰底层模块」约束。

import type { AgentContext } from '../core/agent-context.js';
import type { AgentTool, ToolPermission } from '../tools/tool.js';
import type { DataContext, DataFactory } from '../../core/types.js';
import { getDataFactory, listDataFactories, isNoop } from '../../core/data-factory.js';

/** 输入：按工厂名 + 参数化信息准备测试数据 */
export interface DataPrepareInput {
  /** 数据工厂名称（须已注册，如 wan3 / default） */
  factoryName: string;
  /** generate() 参数化输入（如 { resolution: ['1080P'], count: 3 }） */
  params?: Record<string, unknown>;
  /** 用例 ID 列表（审计/报告用途） */
  targetCases?: string[];
}

/** Data Prepare Tool 实现 */
export class DataPrepareTool implements AgentTool<DataPrepareInput, DataContext> {
  name = 'data.prepare';
  description = '根据数据工厂准备测试数据（账号/积分/素材/任务），返回 DataContext 快照';
  permission: ToolPermission = 'safe';
  inputSchema = {
    type: 'object',
    required: ['factoryName'],
    properties: {
      factoryName: { type: 'string' },
      params: { type: 'object' },
      targetCases: { type: 'array', items: { type: 'string' } },
    },
  };
  outputSchema = { type: 'object' };
  timeoutMs = 60_000;

  constructor(private factoryResolver: (name: string) => DataFactory = getDataFactory) {}

  async execute(input: DataPrepareInput, context: AgentContext): Promise<DataContext> {
    const factory = this.factoryResolver(input.factoryName);
    if (isNoop(factory)) {
      context.logger.warn(`数据工厂未注册（${input.factoryName}），返回空 DataContext；可用：${listDataFactories().join(', ') || '无'}`);
      return {};
    }
    const params = input.params ?? {};
    const data = await factory.generate(params);
    context.logger.info(
      `数据准备完成：工厂=${input.factoryName}，账号=${data.account?.id ?? '-'}，任务=${data.taskIds?.length ?? 0}，素材=${data.assets?.length ?? 0}`,
    );
    return data;
  }
}

/** 便捷工厂：创建 Data Prepare Tool（可注入自定义解析器便于测试） */
export function createDataPrepareTool(factoryResolver?: (name: string) => DataFactory): DataPrepareTool {
  return new DataPrepareTool(factoryResolver);
}

/** 供自定义注册（测试用）：仅用于无环境依赖的场景 */
export { getDataFactory, listDataFactories };
