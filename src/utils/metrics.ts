// 执行度量收集器：各步骤耗时、接口调用次数、重试次数、通过率
export interface StepMetric {
  duration: number;
  calls: number;
}

export class MetricsCollector {
  private steps: Record<string, StepMetric> = {};
  private startTime = 0;
  private apiCalls = 0;
  private apiRetries = 0;
  private passRate = 0;

  /** 开始计时 */
  start(): void {
    this.startTime = Date.now();
  }

  /** 记录步骤耗时 */
  recordStep(name: string, durationMs: number): void {
    if (!this.steps[name]) this.steps[name] = { duration: 0, calls: 0 };
    this.steps[name].duration += durationMs;
    this.steps[name].calls++;
  }

  /** 记录接口调用 */
  recordApiCall(): void {
    this.apiCalls++;
  }

  /** 记录接口重试 */
  recordApiRetry(): void {
    this.apiRetries++;
  }

  /** 设置通过率 */
  setPassRate(rate: number): void {
    this.passRate = rate;
  }

  /** 序列化为 JSON（写入 metrics.json） */
  toJSON(): Record<string, unknown> {
    return {
      totalDuration: this.startTime ? Date.now() - this.startTime : 0,
      steps: this.steps,
      apiCalls: this.apiCalls,
      apiRetries: this.apiRetries,
      passRate: this.passRate,
    };
  }

  /** 重置（每次 main 启动时调用） */
  reset(): void {
    this.steps = {};
    this.startTime = Date.now();
    this.apiCalls = 0;
    this.apiRetries = 0;
    this.passRate = 0;
  }
}

/** 全局单例 */
export const metrics = new MetricsCollector();
