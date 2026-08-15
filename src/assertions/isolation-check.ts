// 隔离断言：模型趋势归属统计（仅本次有任务时核验）
import type { TaskDef, SubmitResult, BillingData, CheckResult } from '../core/types.js';
import { registerAssertion } from './index.js';

export function isolationCheck(taskDef: TaskDef, submit: SubmitResult, billingData: BillingData): CheckResult[] {
  const checks: CheckResult[] = [];
  const hasTask = !!(
    submit &&
    (submit.taskId || submit.detail || (submit.taskId !== undefined && submit.taskId !== null))
  );
  if (!hasTask || !billingData.modelTrend) return checks;

  checks.push({
    name: '模型趋势统计',
    pass: billingData.modelTrend.found,
    detail: billingData.modelTrend.found
      ? `${billingData.modelTrend.modelName || '本次模型'} 出现在模型趋势中（最新值=${billingData.modelTrend.lastValue}）`
      : '模型趋势中未找到本次模型',
  });
  return checks;
}

registerAssertion('isolation-check', isolationCheck);
