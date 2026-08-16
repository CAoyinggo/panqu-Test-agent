// 退出码规范：0 全通过 / 1 用例失败 / 2 配置或环境错误 / 3 超时中断
export const EXIT_CODE = {
  SUCCESS: 0,
  CASE_FAILED: 1,
  CONFIG_ERROR: 2,
  TIMEOUT: 3,
} as const;

export type ExitCode = (typeof EXIT_CODE)[keyof typeof EXIT_CODE];

/** 单条用例执行结果 */
export interface CaseResult {
  name: string;
  feature?: string;
  pass: boolean;
  timedOut: boolean;
  pending: boolean;
  passRate: number;
}

/** 执行结果汇总 */
export interface ExecutionSummary {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  timedOut: number;
  exitCode: ExitCode;
  reports: string[];
}

/** 执行结果追踪器：逐条记录用例结果，最终汇总为退出码 */
export class ResultTracker {
  private results: CaseResult[] = [];
  private hasTimeout = false;
  reports: string[] = [];

  /** 记录一条用例执行结果 */
  addResult(r: Omit<CaseResult, 'timedOut'>): void {
    this.results.push({ ...r, timedOut: false });
  }

  /** 记录一条超时未完成的用例 */
  addTimeout(name: string, feature?: string): void {
    this.results.push({ name, feature, pass: false, timedOut: true, pending: false, passRate: 0 });
    this.hasTimeout = true;
  }

  /** 记录报告文件路径 */
  addReport(file: string): void {
    this.reports.push(file);
  }

  /** 获取执行汇总 */
  getSummary(): ExecutionSummary {
    const total = this.results.length;
    const passed = this.results.filter((r) => r.pass).length;
    const failed = this.results.filter((r) => !r.pass && !r.timedOut && !r.pending).length;
    const pending = this.results.filter((r) => r.pending).length;
    const timedOut = this.results.filter((r) => r.timedOut).length;

    let exitCode: ExitCode = EXIT_CODE.SUCCESS;
    if (this.hasTimeout) exitCode = EXIT_CODE.TIMEOUT;
    else if (failed > 0) exitCode = EXIT_CODE.CASE_FAILED;

    return { total, passed, failed, pending, timedOut, exitCode, reports: this.reports };
  }

  /** 格式化一行摘要（CI 模式用） */
  static formatSummary(s: ExecutionSummary): string {
    return `结果：${s.passed} 通过 ${s.failed} 失 ${s.pending} 待人工${s.timedOut ? ` ${s.timedOut} 超时` : ''}，退出码 ${s.exitCode}`;
  }
}
