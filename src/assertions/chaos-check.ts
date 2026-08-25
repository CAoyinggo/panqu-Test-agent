// 混沌断言：被动观察真实卡点（不主动注入故障）
// 利用 test 环境已有的真实失败，验证：①错误信息明确 ②积分正确回退 ③标记已知卡点
import type { TaskDef, SubmitResult, BillingData, CheckResult } from '../core/types.js';
import { registerAssertion } from './index.js';

export function chaosCheck(taskDef: TaskDef, submit: SubmitResult, billingData: BillingData): CheckResult[] {
  const checks: CheckResult[] = [];
  const status = submit.status || '';

  // 仅在任务有明确终态时执行混沌观察
  const isFailed = status.includes('失败');
  const isCompleted = status.includes('完成');
  if (!isFailed && !isCompleted) return checks;

  // 1. 失败任务错误信息明确性
  if (isFailed) {
    const err = submit.err || '';
    const hasClearMsg = err.length > 0 && err.length < 500;
    checks.push({
      name: '失败错误信息明确性',
      pass: hasClearMsg,
      detail: hasClearMsg
        ? `错误信息清晰（长度=${err.length}）：${err.slice(0, 80)}...`
        : err.length === 0
          ? '⚠ 任务失败但无错误信息'
          : `⚠ 错误信息过长（${err.length}字符），可能包含冗余内容`,
      level: 'P2',
      kind: 'INFORMATIONAL',
    });
  }

  // 2. 失败任务积分回退（被动观察）
  if (isFailed) {
    const actualConsumed = billingData.actualConsumed;
    const net = billingData.net;
    const consumed = actualConsumed ?? net;
    if (consumed === undefined) {
      checks.push({
        name: '失败积分回退（混沌观察）',
        pass: true,
        detail: '缺少快照差值和账单流水，无法证明积分已回退',
        level: 'P1',
        kind: 'SKIPPED',
      });
    } else {
      const reversed = consumed === 0;
      checks.push({
        name: '失败积分回退（混沌观察）',
        pass: reversed,
        detail: reversed
          ? '任务失败后积分已正确回退（净消耗=0）'
          : `⚠ 任务失败但积分未回退（净消耗=${consumed}），标记为已知卡点`,
        level: 'P1',
      });
    }
  }

  // 3. 已知卡点标记（利用真实失败作为混沌验证点）
  if (isFailed) {
    const err = (submit.err || '').toLowerCase();
    const knownPatterns = [
      { pattern: /模型|接入点|权限/, label: '模型/接入点配置问题' },
      { pattern: /积分|余额|不足/, label: '积分不足' },
      { pattern: /参数|必填|缺失/, label: '参数校验问题' },
      { pattern: /超时|timeout/, label: '处理超时' },
    ];
    const matched = knownPatterns.find((k) => k.pattern.test(err));
    checks.push({
      name: '已知卡点标记',
      pass: true, // 信息性，总是 pass
      detail: matched
        ? `已知卡点：${matched.label}（错误信息匹配已知模式）`
        : `未知卡点：错误信息未匹配已知模式，建议人工分析`,
      level: 'P2',
      kind: 'INFORMATIONAL',
    });
  }

  // 4. 成功任务一致性验证（成功时积分应非零且不超过预期）
  if (isCompleted) {
    const actualConsumed = billingData.actualConsumed;
    if (actualConsumed !== undefined) {
      const expected = taskDef.expected_points ?? 0;
      checks.push({
        name: '成功扣费一致性（混沌观察）',
        pass: actualConsumed === expected,
        detail: `成功任务扣费=${actualConsumed}，期望=${expected}`,
        level: 'P2',
      });
    }
  }

  return checks;
}

registerAssertion('chaos-check', chaosCheck);
