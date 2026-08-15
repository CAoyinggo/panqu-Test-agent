// 落库字段断言：核对任务详情中的 model_id / type / task_type 与任务定义一致
// 仅在有任务详情时核验；半自动/未提交显示跳过（不判失败）
import type { TaskDef, SubmitResult, BillingData, CheckResult } from '../core/types.js';
import { registerAssertion } from './index.js';

export function dbCheck(taskDef: TaskDef, submit: SubmitResult, _billing: BillingData): CheckResult[] {
  const checks: CheckResult[] = [];
  const detail = (submit && submit.detail) || {};
  const extra = detail.extra || {};
  const hasDetail = !!submit.detail && Object.keys(detail).length > 0;

  if (!hasDetail) {
    checks.push({
      name: '落库核对',
      pass: true,
      detail: '无任务详情可核对（半自动/复用任务或未提交），跳过落库字段检查',
    });
    return checks;
  }

  const expectModel = String(taskDef.model_id ?? '');
  checks.push({
    name: '模型落库',
    pass: expectModel ? String(detail.model_id) === expectModel : !!detail.model_id,
    detail: `期望 model_id=${expectModel || '(任意)'}，实际=${detail.model_id}`,
  });
  checks.push({
    name: '任务类型',
    pass: !!detail.type,
    detail: `type=${detail.type}（PanquAI视频=6）`,
  });
  if (taskDef.task_type) {
    checks.push({
      name: '任务子类型',
      pass: String(extra.task_type) === String(taskDef.task_type),
      detail: `期望 task_type=${taskDef.task_type}，实际=${extra.task_type}`,
    });
  }
  return checks;
}

registerAssertion('db-check', dbCheck);
