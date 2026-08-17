// wan3.0 业务适配器：将现有 wan3.0 专用断言模块桥接到通用断言架构
// 现有 src/assertions/*.ts 模块保持不变，本文件提供适配层入口
import type { TaskDef, SubmitResult, BillingData, CheckResult } from '../../core/types.js';
import { runDefaultAssertions } from '../index.js';
import { logger } from '../../utils/logger.js';

export interface Wan3AdapterContext {
  taskDef: TaskDef;
  submit: SubmitResult;
  billingData: BillingData;
}

/**
 * wan3.0 适配器：运行 wan3.0 专用断言集。
 *
 * 内部调用现有 `runDefaultAssertions()`，完全复用 7 个已注册断言模块：
 *   - db-check（落库核对）
 *   - billing-check（计费积分）
 *   - status-flow-check（状态流转）
 *   - isolation-check（数据隔离）
 *   - account-check（账号一致性）
 *   - security-check（安全探针）
 *   - chaos-check（混沌模式匹配）
 *
 * @returns CheckResult[] 断言结果列表
 */
export function runWan3Adapter(ctx: Wan3AdapterContext): CheckResult[] {
  const { taskDef, submit, billingData } = ctx;
  const verifyDef = {
    ...taskDef,
    account: (taskDef.extra as Record<string, unknown>)?.account || '',
    project_id: (taskDef.extra as Record<string, unknown>)?.project_id || '',
  };

  logger.debug('  ▶ 运行 wan3.0 适配器断言...');
  const checks = runDefaultAssertions(verifyDef, submit, billingData);
  logger.debug(`  ✔ wan3.0 适配器完成：${checks.length} 条断言`);
  return checks;
}

/**
 * 通用适配器入口：根据 adapter 名称选择对应的适配器。
 * @param adapterName 适配器名称（'wan3' | 'default'）
 * @param ctx 适配器上下文
 */
export function runAdapterAssertions(
  adapterName: string,
  ctx: Wan3AdapterContext,
): CheckResult[] {
  switch (adapterName) {
    case 'wan3':
      return runWan3Adapter(ctx);
    case 'default':
      return []; // default 适配器仅运行通用断言，不追加业务断言
    default:
      logger.warn(`未知适配器: ${adapterName}，跳过业务断言`);
      return [];
  }
}
