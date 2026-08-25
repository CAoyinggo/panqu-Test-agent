// 用例注册表：集中登记用例定义（TS 脚本或 JSON 均可注册），支持按名查询与枚举
import type { TaskDef } from '../core/types.js';
import { redactSensitiveText } from '../core/redact.js';

const caseMap = new Map<string, TaskDef>();

/** 注册一个用例（name 冲突时覆盖并告警） */
export function registerCase(name: string, def: TaskDef): void {
  if (caseMap.has(name)) {
    console.warn(`[cases] 用例已存在，覆盖注册：${redactSensitiveText(name)}`);
  }
  caseMap.set(name, def);
}

/** 按用例名查询 */
export function getCase(name: string): TaskDef | undefined {
  return caseMap.get(name);
}

/** 枚举所有已注册用例名 */
export function listCases(): string[] {
  return [...caseMap.keys()];
}

/** 清空注册表（测试用） */
export function clearCases(): void {
  caseMap.clear();
}
