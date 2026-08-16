// 数据工厂：注册表 + 默认实现 + 自动加载
// - 注册自定义 DataFactory：registerDataFactory(name, factory)
// - 默认 NoopDataFactory：setup 返回空 DataContext，teardown 不做任何操作
// - 按 TaskDef.dataFactory 选择对应工厂（未指定则用 Noop）
import type { RunContext, DataContext, DataFactory, TaskDef } from './types.js';
import { logger } from '../utils/logger.js';

// ── 默认空实现（不准备/不清理任何数据，向后兼容） ──
export class NoopDataFactory implements DataFactory {
  async setup(_ctx: RunContext): Promise<DataContext> {
    return {};
  }
  async teardown(_ctx: RunContext, _data: DataContext): Promise<void> {
    // no-op
  }
  async generate(_params: Record<string, unknown>): Promise<DataContext> {
    return {};
  }
}

// ── 注册表 ──
const registry = new Map<string, DataFactory>();
const noop = new NoopDataFactory();

/** 注册一个数据工厂 */
export function registerDataFactory(name: string, factory: DataFactory): void {
  registry.set(name, factory);
  logger.debug(`数据工厂已注册：${name}`);
}

/** 获取数据工厂（未注册则返回 Noop） */
export function getDataFactory(name?: string): DataFactory {
  if (!name) return noop;
  return registry.get(name) || noop;
}

/** 列出已注册的数据工厂 */
export function listDataFactories(): string[] {
  return Array.from(registry.keys());
}

/** 判断是否为 Noop（未注册的自定义工厂） */
export function isNoop(factory: DataFactory): boolean {
  return factory === noop;
}

/**
 * 根据用例定义解析数据工厂。
 * 优先级：TaskDef.dataFactory > TaskDef.setup（旧字段兼容） > Noop
 */
export function resolveDataFactory(taskDef: TaskDef): { factory: DataFactory; name: string } {
  const name = (taskDef.dataFactory as string) || (taskDef.setup as string) || '';
  return { factory: getDataFactory(name), name: name || 'noop' };
}
