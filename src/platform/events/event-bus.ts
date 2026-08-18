// In-Process EventBus（Phase 24.6）：统一事件总线
// 第一阶段使用进程内实现，不引入 Kafka / RabbitMQ。
// 支持按事件类型订阅 / 全局订阅 / 发布（顺序派发）/ 退订。

import type { PlatformEvent, PlatformEventType } from './events.js';

export type EventListener = (event: PlatformEvent) => void | Promise<void>;

export interface EventBusOptions {
  now?: () => string;
}

export class EventBus {
  private listeners = new Map<PlatformEventType, Set<EventListener>>();
  private all = new Set<EventListener>();
  private readonly now: () => string;
  private publishedCount = 0;

  constructor(opts: EventBusOptions = {}) {
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  /** 订阅指定事件；返回退订函数 */
  subscribe(type: PlatformEventType, listener: EventListener): () => void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
    return () => this.listeners.get(type)?.delete(listener);
  }

  /** 订阅全部事件；返回退订函数 */
  subscribeAll(listener: EventListener): () => void {
    this.all.add(listener);
    return () => this.all.delete(listener);
  }

  /** 发布事件（进程内顺序派发；监听器异常不阻断其他监听器） */
  async publish(partial: Omit<PlatformEvent, 'timestamp'> & { timestamp?: string }): Promise<PlatformEvent> {
    const event: PlatformEvent = {
      ...partial,
      timestamp: partial.timestamp ?? this.now(),
    };
    this.publishedCount += 1;
    const targets = [...(this.listeners.get(event.type) ?? []), ...this.all];
    for (const l of targets) {
      try {
        await l(event);
      } catch {
        // 单监听器异常不阻断总线
      }
    }
    return event;
  }

  /** 退订全部（测试 / 停机） */
  clear(): void {
    this.listeners.clear();
    this.all.clear();
  }

  listenerCount(type?: PlatformEventType): number {
    if (type) return this.listeners.get(type)?.size ?? 0;
    let total = this.all.size;
    for (const s of this.listeners.values()) total += s.size;
    return total;
  }

  totalPublished(): number {
    return this.publishedCount;
  }
}
