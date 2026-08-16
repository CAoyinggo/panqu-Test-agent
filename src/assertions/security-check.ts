// 安全断言：跨账号只读越权检测 + 错误信息泄露检查
// 范围限定在「跨账号只读越权」——不测试 SQL 注入/XSS
import type { TaskDef, SubmitResult, BillingData, CheckResult } from '../core/types.js';
import { registerAssertion } from './index.js';

// 敏感信息特征（错误信息中不应出现）
const SENSITIVE_PATTERNS = [
  { pattern: /SQLSTATE|mysql|postgres|sqlite|mongodb/i, label: '数据库错误' },
  { pattern: /\/(var|home|usr|opt|etc)\//i, label: '服务器文件路径' },
  { pattern: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, label: '内网 IP 地址' },
  { pattern: /password|secret|token|api[_-]?key/i, label: '敏感凭证' },
  { pattern: /at\s+[\w.]+\s*\(/i, label: '堆栈跟踪' },
];

export function securityCheck(taskDef: TaskDef, submit: SubmitResult, billingData: BillingData): CheckResult[] {
  const checks: CheckResult[] = [];

  // 1. 跨账号只读越权检测（基于 pipeline 安全探针结果）
  const probe = billingData.securityProbe;
  if (probe && probe.attempted) {
    checks.push({
      name: '跨账号越权防护',
      pass: probe.rejected,
      detail: probe.detail,
      level: 'P1',
    });
  }

  // 2. 错误信息泄露检查（提交/任务失败时的错误信息不应包含敏感内容）
  const errMsg = submit.err || '';
  if (errMsg) {
    const leaked = SENSITIVE_PATTERNS.find((s) => s.pattern.test(errMsg));
    checks.push({
      name: '错误信息安全性',
      pass: !leaked,
      detail: leaked
        ? `⚠ 错误信息中包含${leaked.label}，存在信息泄露风险`
        : `错误信息未包含敏感内容（长度=${errMsg.length}）`,
      level: 'P1',
    });
  }

  // 3. 任务详情归属验证（detail 中的 project_id 应与当前一致）
  if (submit.detail && submit.detail.project_id !== undefined) {
    const detailPid = Number(submit.detail.project_id);
    const expectedPid = Number(taskDef.project_id);
    checks.push({
      name: '任务归属验证',
      pass: detailPid === expectedPid,
      detail: detailPid === expectedPid
        ? `任务 project_id=${detailPid}，与当前会话一致`
        : `⚠ 任务 project_id=${detailPid}，与会话 project_id=${expectedPid} 不一致`,
      level: 'P1',
    });
  }

  return checks;
}

registerAssertion('security-check', securityCheck);
