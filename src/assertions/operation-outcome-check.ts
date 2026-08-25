// Operation Outcome 断言：旧 TaskDef 未声明自定义 Assertion 时，Processor 的失败终态
// 必须成为业务失败，不能被账号说明、跳过检查或计费 0 等弱证据稀释成 PASS。
import type { BillingData, CheckResult, SubmitResult, TaskDef } from '../core/types.js';
import { registerAssertion } from './index.js';

export function operationOutcomeCheck(taskDef: TaskDef, submit: SubmitResult, _billing: BillingData): CheckResult[] {
  // 新 DSL 已显式声明 Oracle 时，由 Assertion Engine 决定预期成功/拒绝语义。
  if (taskDef.assert) return [];
  const status = String(submit.status ?? '');
  if (status.includes('失败')) return [{
    name: 'Processor 业务终态',
    pass: false,
    detail: `Processor 返回失败终态 ${status}；Legacy TaskDef 未声明失败为预期结果的确定性 Assertion`,
    kind: 'BUSINESS',
    level: 'P0',
  }];
  if (status.includes('完成')) return [{
    name: 'Processor 业务终态',
    pass: true,
    detail: `Processor 已到达成功终态 ${status}`,
    kind: 'BUSINESS',
    level: 'P0',
  }];
  return [];
}

registerAssertion('operation-outcome-check', operationOutcomeCheck);
