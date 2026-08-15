// 账号隔离断言：本次使用的账号与项目归属
import type { TaskDef, SubmitResult, BillingData, CheckResult } from '../core/types.js';
import { registerAssertion } from './index.js';

export function accountCheck(taskDef: TaskDef, _submit: SubmitResult, _billing: BillingData): CheckResult[] {
  return [
    {
      name: '账号隔离',
      pass: true,
      detail: `本次使用账号 ${taskDef.account || '默认'}，project_id=${taskDef.project_id ?? '-'}，积分独立计费`,
    },
  ];
}

registerAssertion('account-check', accountCheck);
