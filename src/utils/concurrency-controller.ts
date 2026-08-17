// 动态并发控制器：根据成功率自动调整并发数
// 算法：滑动窗口（默认 10 条）计算通过率，高通过率 → 提升并发，低通过率 → 降低并发
import { logger } from './logger.js';
import { metrics } from './metrics.js';

export interface ConcurrencyConfig {
  /** 初始并发数 */
  initial: number;
  /** 最小并发数（降级下限） */
  min: number;
  /** 最大并发数（升级上限） */
  max: number;
  /** 滑动窗口大小（最近 N 条用例结果） */
  windowSize: number;
  /** 通过率阈值（高于此值可升并发，默认 0.9） */
  passRateThreshold: number;
  /** 失败率阈值（高于此值降并发，默认 0.3 = 1 - 0.7 通过率） */
  failureRateThreshold: number;
  /** 调整间隔（每 N 条用例结果后评估一次） */
  adjustmentInterval: number;
}

export interface WindowEntry {
  pass: boolean;
  timestamp: number;
}

export class DynamicConcurrencyController {
  private config: ConcurrencyConfig;
  private current: number;
  private window: WindowEntry[] = [];
  private resultCount = 0;
  private lastAdjustment = 0;

  constructor(config: ConcurrencyConfig) {
    this.config = config;
    this.current = config.initial;
    logger.info(`动态并发已启用：initial=${config.initial}, min=${config.min}, max=${config.max}, window=${config.windowSize}`);
  }

  /** 获取当前并发数 */
  getConcurrency(): number {
    return this.current;
  }

  /** 记录一条用例结果 */
  recordResult(pass: boolean): void {
    this.window.push({ pass, timestamp: Date.now() });
    if (this.window.length > this.config.windowSize) {
      this.window.shift();
    }
    this.resultCount++;

    // 每 adjustmentInterval 条结果评估一次
    if (this.resultCount - this.lastAdjustment >= this.config.adjustmentInterval) {
      this.evaluate();
      this.lastAdjustment = this.resultCount;
    }
  }

  /** 评估并调整并发数 */
  private evaluate(): void {
    if (this.window.length < Math.min(this.config.windowSize, 5)) {
      return; // 窗口数据不足，不调整
    }

    const passed = this.window.filter((e) => e.pass).length;
    const passRate = passed / this.window.length;
    const failureRate = 1 - passRate;

    const prev = this.current;

    if (failureRate >= this.config.failureRateThreshold && this.current > this.config.min) {
      // 失败率高 → 降级
      this.current = Math.max(this.config.min, Math.floor(this.current / 2));
      logger.warn(`⚠ 动态并发降级：${prev} → ${this.current}（窗口通过率 ${(passRate * 100).toFixed(0)}%，失败率 ${((1 - passRate) * 100).toFixed(0)}%）`);
      metrics.recordConcurrencyChange(prev, this.current, 'high_failure_rate', passRate);
    } else if (passRate >= this.config.passRateThreshold && this.current < this.config.max) {
      // 通过率高 → 升级
      this.current = Math.min(this.config.max, this.current + 1);
      logger.info(`✅ 动态并发升级：${prev} → ${this.current}（窗口通过率 ${(passRate * 100).toFixed(0)}%）`);
      metrics.recordConcurrencyChange(prev, this.current, 'high_pass_rate', passRate);
    }
  }

  /** 获取并发变化历史 */
  getHistory(): Array<{ from: number; to: number; reason: string; passRate: number }> {
    return (metrics.toJSON().concurrencyChanges as any[]) || [];
  }
}

/** 默认配置工厂 */
export function createDefaultConcurrencyConfig(initial: number, max: number): ConcurrencyConfig {
  return {
    initial,
    min: 1,
    max,
    windowSize: 10,
    passRateThreshold: 0.9,
    failureRateThreshold: 0.3,
    adjustmentInterval: 5,
  };
}

// ── 纯函数：adjustConcurrency（可独立单元测试） ──

export interface AdjustConcurrencyOptions {
  /** 最小并发（默认 1） */
  min: number;
  /** 最大并发（默认等于 initial） */
  max: number;
  /** 失败率降级阈值（默认 0.3） */
  failureRateThreshold?: number;
  /** 通过率升级阈值（默认 0.9） */
  passRateThreshold?: number;
}

export interface AdjustResult {
  /** 调整后的并发数 */
  concurrency: number;
  /** 调整前并发数 */
  previous: number;
  /** 调整原因 */
  reason: 'high_failure_rate' | 'high_pass_rate' | 'stable';
  /** 当前窗口通过率 */
  passRate: number;
}

/**
 * 纯函数：根据当前通过率调整并发数。
 *
 * 算法：
 * - 失败率 >= failureRateThreshold → 降级（减半，下限 min）
 * - 通过率 >= passRateThreshold → 升级（+1，上限 max）
 * - 其他 → 保持不变
 *
 * @param current 当前并发数
 * @param successRate 当前窗口通过率（0-1）
 * @param options 调整参数
 * @returns 调整结果
 */
export function adjustConcurrency(
  current: number,
  successRate: number,
  options: AdjustConcurrencyOptions,
): AdjustResult {
  const { min, max } = options;
  const failureRateThreshold = options.failureRateThreshold ?? 0.3;
  const passRateThreshold = options.passRateThreshold ?? 0.9;
  const failureRate = 1 - successRate;

  if (failureRate >= failureRateThreshold && current > min) {
    const newConcurrency = Math.max(min, Math.floor(current / 2));
    return {
      concurrency: newConcurrency,
      previous: current,
      reason: 'high_failure_rate',
      passRate: successRate,
    };
  }

  if (successRate >= passRateThreshold && current < max) {
    const newConcurrency = Math.min(max, current + 1);
    return {
      concurrency: newConcurrency,
      previous: current,
      reason: 'high_pass_rate',
      passRate: successRate,
    };
  }

  return {
    concurrency: current,
    previous: current,
    reason: 'stable',
    passRate: successRate,
  };
}
