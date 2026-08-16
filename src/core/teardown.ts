// 执行后核对（teardown）：查询任务最终状态 + 积分净消耗，确认是否已回退
// 不主动调接口回退——平台侧通常自动回退，脚本侧只做核对+告警
import type { RunContext, CheckResult, BillingData, SubmitResult } from './types.js';
import { logger } from '../utils/logger.js';

/**
 * 执行后核对：基于已采集的数据（ctx.submit / billingData）做最终确认。
 * 若任务失败但积分未回退，标 false 提示人工确认。
 */
export function runTeardownCheck(ctx: RunContext, billingData: BillingData): CheckResult[] {
  const checks: CheckResult[] = [];
  const taskId = ctx.taskId;
  const submit: SubmitResult = ctx.submit || {};
  const status = submit.status || '未知';

  if (!taskId) {
    logger.info('[teardown] 无任务 ID，跳过执行后核对');
    return checks;
  }

  logger.step('[teardown] 执行后核对...');

  // 核对 1：任务最终状态（信息性，总是 pass）
  checks.push({
    name: '执行后核对：任务最终状态',
    pass: true,
    detail: `任务 ${taskId} 最终状态=${status}`,
    level: 'P2',
  });

  // 核对 2：积分回退（若任务失败，净消耗应为 0）
  const net = typeof billingData.net === 'number' ? billingData.net : undefined;
  if (net !== undefined) {
    const taskFailed = status === '失败';
    const taskSucceeded = status === '已完成' || status === '成功';

    if (taskFailed && net !== 0) {
      checks.push({
        name: '执行后核对：失败任务积分回退',
        pass: false,
        detail: `任务失败但积分净消耗=${net}（应回退为 0），请人工确认是否需手动回退`,
        level: 'P1',
      });
    } else {
      checks.push({
        name: '执行后核对：积分净消耗',
        pass: true,
        detail: `净消耗=${net}${taskFailed ? '（任务失败，已回退）' : ''}`,
        level: 'P2',
      });
    }
  } else {
    checks.push({
      name: '执行后核对：积分净消耗',
      pass: true,
      detail: '计费数据未采集到，跳过核对',
      level: 'P2',
    });
  }

  return checks;
}
