// 计费断言：积分扣费/回退正确性
// 优先使用快照差值（actualConsumed）断言净消耗，net 降为参考
import type { TaskDef, SubmitResult, BillingData, CheckResult } from '../core/types.js';
import { registerAssertion } from './index.js';

export function billingCheck(taskDef: TaskDef, submit: SubmitResult, billingData: BillingData): CheckResult[] {
  const checks: CheckResult[] = [];
  const expected = taskDef.expected_points ?? 0;
  const net = billingData.net ?? 0;
  const actualConsumed = billingData.actualConsumed;

  // 无任何消费数据则跳过
  if (actualConsumed === undefined && !net) return checks;

  // 优先使用快照差值，降级使用流水汇总
  const primary = actualConsumed !== undefined ? actualConsumed : net;
  const source = actualConsumed !== undefined ? '快照差值' : '流水汇总';

  // 1. 积分净消耗：成功任务净消耗应等于期望扣费或 0（未消费）
  checks.push({
    name: '积分净消耗',
    pass: primary === 0 || primary === expected,
    detail: `净消耗=${primary}（${source}，期望 ${expected} 或 0）`,
  });

  // 2. 失败回退：失败任务净消耗应为 0
  checks.push({
    name: '失败回退',
    pass: submit.status === '失败' ? primary === 0 : true,
    detail: `任务=${submit.status}，净消耗=${primary}（${source}，失败应回退为0）`,
  });

  // 3. 扣费上限防护：实际消耗不应超过期望值（防止重复扣费/超额扣费）
  if (expected > 0) {
    checks.push({
      name: '扣费上限防护',
      pass: primary <= expected,
      detail: `实际消耗=${primary}（${source}），期望上限=${expected}，${primary <= expected ? '未超限' : '⚠ 超限'}`,
    });
  }

  // 4. 快照差值与流水汇总交叉验证（两者都有时）
  if (actualConsumed !== undefined && net) {
    const diff = Math.abs(actualConsumed - net);
    checks.push({
      name: '扣费数据一致性',
      pass: diff <= Math.max(1, expected * 0.1),
      detail: `快照差值=${actualConsumed}，流水汇总=${net}，偏差=${diff}（容差=${Math.max(1, expected * 0.1)}）`,
    });
  }

  return checks;
}

registerAssertion('billing-check', billingCheck);
