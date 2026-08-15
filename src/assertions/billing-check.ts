// 计费断言：积分扣费/回退正确性
// 成功任务净消耗应等于期望扣费；失败任务应回退为 0
import type { TaskDef, SubmitResult, BillingData, CheckResult } from '../core/types.js';
import { registerAssertion } from './index.js';

export function billingCheck(taskDef: TaskDef, submit: SubmitResult, billingData: BillingData): CheckResult[] {
  const checks: CheckResult[] = [];
  const net = billingData.net ?? 0;
  if (!net) return checks; // 无消费数据则跳过

  const expected = taskDef.expected_points ?? 0;
  checks.push({
    name: '积分净消耗',
    pass: net === 0 || net === expected,
    detail: `净消耗=${net}（期望 ${expected} 或 0）`,
  });
  checks.push({
    name: '失败回退',
    pass: submit.status === '失败' ? net === 0 : true,
    detail: `任务=${submit.status}，净消耗=${net}（失败应回退为0）`,
  });
  return checks;
}

registerAssertion('billing-check', billingCheck);
