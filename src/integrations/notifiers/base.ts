// 通知器接口：执行结束后推送结果摘要
import type { ExecutionSummary } from '../../utils/exit-code.js';

export interface Notifier {
  /** 推送执行结果摘要 */
  notify(summary: ExecutionSummary): Promise<void>;
}
