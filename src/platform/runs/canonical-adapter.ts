/**
 * Platform Canonical Adapter
 *
 * 职责：
 * 将 canonical ExecutionStatus 最薄转换为 Platform 层所需的 CompletionExecutionStatus。
 * 纯只读无副作用转换，不重新派生状态或覆盖率。
 */

import type { ExecutionStatus } from '../../contracts/execution-result.js';
import type { CompletionExecutionStatus } from './run-schema.js';

export function toPlatformExecutionStatus(status: ExecutionStatus): CompletionExecutionStatus {
  switch (status) {
    case 'PASS':
      return 'PASSED';
    case 'FAIL':
      return 'FAILED';
    case 'BLOCKED':
      return 'BLOCKED';
    case 'NOT_EXECUTED':
      return 'NOT_EXECUTED';
  }
}
