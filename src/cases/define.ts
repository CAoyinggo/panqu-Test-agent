// 用例定义辅助：提供类型安全的 TS 用例脚本编写入口
// 用法：export default defineCase({ name: '...', scene: '...', ... })
import type { TaskDef, AssertionConfig } from '../core/types.js';
import type { AssertionRule } from '../core/assertion-operators.js';

/**
 * 声明一个测试用例定义。
 * 返回原对象并附带类型检查，编译期即可发现字段拼写/类型错误。
 */
export function defineCase(def: TaskDef): TaskDef {
  return def;
}

/** 由 defineCase 编写的用例模块标记（供 loader 识别命名导出） */
export const IS_TEST_CASE = true;

// ── 断言 DSL 辅助函数 ──

/**
 * 创建断言规则列表（all 模式，所有规则必须通过）。
 * @param rules 断言规则数组
 * @returns AssertionConfig 可直接用于 TaskDef.assert
 */
export function assertRules(rules: AssertionRule[]): AssertionConfig {
  return { mode: 'all', rules };
}

/**
 * 创建 all 模式断言组（AND 逻辑，所有必须通过）。
 */
export function assertAll(...rules: AssertionRule[]): AssertionConfig {
  return { mode: 'all', rules };
}

/**
 * 创建 any 模式断言组（OR 逻辑，任一通过即可）。
 */
export function assertAny(...rules: AssertionRule[]): AssertionConfig {
  return { mode: 'any', rules };
}

/**
 * 创建 soft 模式断言组（收集全部结果，不中断）。
 */
export function assertSoft(...rules: AssertionRule[]): AssertionConfig {
  return { mode: 'soft', rules };
}

/**
 * 快速创建单条断言规则。
 */
export function assert(
  target: AssertionRule['target'],
  path: string | undefined,
  operator: AssertionRule['operator'],
  expected?: unknown,
  message?: string,
): AssertionRule {
  return { target, path, operator, expected, message };
}
