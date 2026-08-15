// 用例定义辅助：提供类型安全的 TS 用例脚本编写入口
// 用法：export default defineCase({ name: '...', scene: '...', ... })
import type { TaskDef } from '../core/types.js';

/**
 * 声明一个测试用例定义。
 * 返回原对象并附带类型检查，编译期即可发现字段拼写/类型错误。
 */
export function defineCase(def: TaskDef): TaskDef {
  return def;
}

/** 由 defineCase 编写的用例模块标记（供 loader 识别命名导出） */
export const IS_TEST_CASE = true;
