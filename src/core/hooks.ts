// 钩子（Hook）机制：7 个标准生命周期钩子点
// 插件与用例脚本可通过 registerHook 注入扩展逻辑
import type { RunContext } from './types.js';
import { logger } from '../utils/logger.js';

export type HookName =
  | 'beforeAll'
  | 'beforeScene'
  | 'beforeStep'
  | 'afterStep'
  | 'afterScene'
  | 'teardown'
  | 'afterAll'
  | 'beforeReport';

export type HookFn = (ctx: RunContext) => Promise<void> | void;

/** 标准 8 钩子点（按执行顺序） */
export const HOOK_ORDER: HookName[] = [
  'beforeAll',
  'beforeScene',
  'beforeStep',
  'afterStep',
  'afterScene',
  'teardown',
  'afterAll',
  'beforeReport',
];

export class HookRegistry {
  private hooks: Partial<Record<HookName, HookFn[]>> = {};

  /** 注册一个钩子（可重复注册，按注册顺序执行） */
  register(name: HookName, fn: HookFn): void {
    if (!this.hooks[name]) this.hooks[name] = [];
    this.hooks[name]!.push(fn);
    logger.debug(`钩子已注册：${name}`);
  }

  /** 顺序执行某钩子点的全部回调 */
  async run(name: HookName, ctx: RunContext): Promise<void> {
    const list = this.hooks[name] || [];
    for (const fn of list) {
      try {
        await fn(ctx);
      } catch (e: any) {
        logger.warn(`钩子 ${name} 执行失败：${e.message}`);
      }
    }
  }

  /** 清空全部钩子（测试用） */
  clear(): void {
    this.hooks = {};
  }

  /** 列出已注册钩子（调试用） */
  list(): HookName[] {
    return (Object.keys(this.hooks) as HookName[]).filter((k) => this.hooks[k]!.length > 0);
  }
}
