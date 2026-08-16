// 断言库注册表：统一注册/执行领域断言
// 新增断言：实现 AssertionFn 并 register，用例/引擎按名称调用
import type { TaskDef, SubmitResult, BillingData, CheckResult } from '../core/types.js';

export type AssertionFn = (taskDef: TaskDef, submit: SubmitResult, billingData: BillingData) => CheckResult[];

type AssertionRegistry = Record<string, AssertionFn>;

const registry: AssertionRegistry = {};

/** 注册一个断言（按名称索引） */
export function registerAssertion(name: string, fn: AssertionFn): void {
  registry[name] = fn;
}

/** 注册一批断言 */
export function registerAssertions(map: AssertionRegistry): void {
  Object.assign(registry, map);
}

/** 是否存在某断言 */
export function hasAssertion(name: string): boolean {
  return !!registry[name];
}

/** 执行指定断言 */
export function runAssertion(name: string, taskDef: TaskDef, submit: SubmitResult, billingData: BillingData): CheckResult[] {
  const fn = registry[name];
  if (!fn) throw new Error(`未注册的断言：${name}`);
  return fn(taskDef, submit, billingData);
}

/** 执行默认断言集（落库/计费/状态流转/隔离/账号/安全/混沌），供引擎使用 */
export function runDefaultAssertions(taskDef: TaskDef, submit: SubmitResult, billingData: BillingData): CheckResult[] {
  const checks: CheckResult[] = [];
  for (const name of ['db-check', 'billing-check', 'status-flow-check', 'isolation-check', 'account-check', 'security-check', 'chaos-check']) {
    if (registry[name]) checks.push(...registry[name](taskDef, submit, billingData));
  }
  return checks;
}

/** 列出已注册断言（调试/报告用） */
export function listAssertions(): string[] {
  return Object.keys(registry);
}
