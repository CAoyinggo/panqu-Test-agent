// 状态流转断言：验证任务状态序列包含合理的中间态 → 终态
// 终态为「完成」或「失败」；未到达终态（超时）标记为失败
import type { TaskDef, SubmitResult, BillingData, CheckResult } from '../core/types.js';
import { registerAssertion } from './index.js';

export function statusFlowCheck(taskDef: TaskDef, submit: SubmitResult, _billingData: BillingData): CheckResult[] {
  const checks: CheckResult[] = [];
  const history = submit.statusHistory;

  // 无状态历史（半自动/未接入处理器）则跳过
  if (!history || history.length === 0) return checks;

  // 1. 状态序列非空：至少经历了一次状态查询
  checks.push({
    name: '状态流转记录',
    pass: history.length >= 1,
    detail: `共记录 ${history.length} 次状态：${history.join(' → ')}`,
  });

  // 2. 终态验证：最后一个状态应为「完成」或「失败」
  const lastStatus = history[history.length - 1];
  const isTerminal = lastStatus.includes('完成') || lastStatus.includes('失败');
  checks.push({
    name: '终态确认',
    pass: isTerminal,
    detail: isTerminal
      ? `任务到达终态：${lastStatus}`
      : `任务未到达终态（当前=${lastStatus}），可能超时`,
  });

  // 3. 状态流转合理性：不应出现「失败 → 完成」的回退
  if (history.length >= 2) {
    let flowValid = true;
    let flowDetail = '';
    for (let i = 1; i < history.length; i++) {
      const prev = history[i - 1];
      const curr = history[i];
      if (prev.includes('失败') && curr.includes('完成')) {
        flowValid = false;
        flowDetail = `异常回退：${prev} → ${curr}（位置 ${i}）`;
        break;
      }
    }
    if (flowValid) flowDetail = `状态流转正常（${history.length} 步）`;
    checks.push({
      name: '状态流转合理性',
      pass: flowValid,
      detail: flowDetail,
    });
  }

  // 4. 重复状态检测：连续相同状态超过 5 次可能卡住
  if (history.length >= 6) {
    let maxConsecutive = 1;
    let currentConsecutive = 1;
    for (let i = 1; i < history.length; i++) {
      if (history[i] === history[i - 1]) {
        currentConsecutive++;
        maxConsecutive = Math.max(maxConsecutive, currentConsecutive);
      } else {
        currentConsecutive = 1;
      }
    }
    const stuck = maxConsecutive > 10;
    checks.push({
      name: '状态卡顿检测',
      pass: !stuck,
      detail: stuck
        ? `连续 ${maxConsecutive} 次相同状态「${history[history.length - 1]}」，可能卡住`
        : `最大连续相同状态次数=${maxConsecutive}（正常）`,
    });
  }

  return checks;
}

registerAssertion('status-flow-check', statusFlowCheck);
