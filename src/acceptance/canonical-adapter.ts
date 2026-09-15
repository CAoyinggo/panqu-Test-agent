/**
 * Acceptance Canonical Adapter
 *
 * 职责：
 * 将 canonical CoverageResult 最薄映射为 AcceptanceTypeStatistics。
 * 纯只读投影，直接复用 canonical 统计事实，严禁重新遍历用例。
 */

import type { CoverageResult } from '../contracts/execution-result.js';
import type { AcceptanceTypeStatistics } from './acceptance-report.js';

export function toAcceptanceTypeStatistics(coverage: CoverageResult): AcceptanceTypeStatistics {
  return {
    total: coverage.total,
    executable: coverage.total,
    designedOnly: 0,
    passed: coverage.passed,
    failed: coverage.failed,
    blocked: coverage.blocked,
    notExecuted: coverage.not_executed,
    timedOut: 0,
    cancelled: 0,
  };
}
