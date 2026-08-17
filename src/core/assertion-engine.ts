// 通用断言引擎：与业务场景无关的声明式断言核心
// 支持声明式 DSL、操作符、JSON Path 提取、组合逻辑（AND/OR/soft）、断言超时/重试
import type { CheckResult } from './types.js';
import type { AssertionOperator, AssertionRule } from './assertion-operators.js';
import { applyOperatorAsync } from './assertion-operators.js';
import { extractPath, formatValue } from './path-extractor.js';
import { logger } from '../utils/logger.js';

// ── 类型定义 ──

export interface AssertionContext {
  response?: { status: number; json: any; headers?: Record<string, string>; durationMs?: number };
  submit?: Record<string, unknown>;
  billing?: Record<string, unknown>;
  headers?: Record<string, string>;
  env?: Record<string, unknown>;
  metrics?: Record<string, number>;
  custom?: Record<string, unknown>;
}

export type AssertionMode = 'all' | 'any' | 'soft';

export interface AssertionGroup {
  mode?: AssertionMode;
  /** 组合器（与 mode 等价，支持 "and"/"or" 别名） */
  combinator?: 'and' | 'or';
  rules: (AssertionRule | AssertionGroup)[];
  message?: string;
}

export type AssertionConfig = AssertionGroup | AssertionRule[];

// ── 断言规则解析 ──

/**
 * 解析断言配置为规则树。
 * 支持两种格式：
 *   1. 数组：[rule1, rule2, ...]（等价于 mode=all）
 *   2. 对象：{ mode: "all" | "any" | "soft", rules: [...] }
 */
export function parseAssertionRules(assertConfig: AssertionConfig): AssertionGroup {
  if (Array.isArray(assertConfig)) {
    return { mode: 'all', rules: assertConfig };
  }
  return assertConfig;
}

// ── 值提取 ──

/**
 * 从断言上下文中按 target + path 提取值。
 */
export function extractValue(context: AssertionContext, target: string, path?: string): unknown {
  let targetObj: unknown;

  switch (target) {
    case 'response':
      targetObj = context.response;
      break;
    case 'submit':
      targetObj = context.submit;
      break;
    case 'billing':
      targetObj = context.billing;
      break;
    case 'headers':
      targetObj = context.headers ?? context.response?.headers;
      break;
    case 'env':
      targetObj = context.env;
      break;
    case 'metrics':
      targetObj = context.metrics;
      break;
    case 'custom':
      targetObj = context.custom;
      break;
    default:
      targetObj = undefined;
  }

  if (targetObj == null) return undefined;
  if (!path) return targetObj;

  // 特殊路径：status → response.status
  if (target === 'response' && path === 'status') {
    return context.response?.status;
  }

  return extractPath(targetObj, path);
}

// ── 核心执行函数 ──

/**
 * 执行通用断言。
 *
 * @param assertConfig 断言配置（数组或 group）
 * @param context 断言上下文
 * @returns CheckResult[] 断言结果列表
 */
export async function runGenericAssertions(
  assertConfig: AssertionConfig,
  context: AssertionContext,
): Promise<CheckResult[]> {
  const group = parseAssertionRules(assertConfig);
  return runGroup(group, context);
}

/** 执行一个断言组（支持组合逻辑） */
async function runGroup(group: AssertionGroup, context: AssertionContext): Promise<CheckResult[]> {
  const mode = normalizeMode(group.mode, group.combinator);
  const results: CheckResult[] = [];
  let passCount = 0;
  let failCount = 0;

  for (const item of group.rules) {
    if (isAssertionGroup(item)) {
      // 嵌套 group
      const subResults = await runGroup(item, context);
      const subPass = subResults.every((r) => r.pass);
      if (subPass) passCount++;
      else failCount++;
      results.push(...subResults);
    } else {
      // 单条规则
      const rule = item as AssertionRule;
      const check = await runRule(rule, context);
      results.push(check);
      if (check.pass) passCount++;
      else failCount++;
    }

    // mode=all/and：任一失败立即返回（但仍返回已执行的结果）
    if (mode === 'all' && failCount > 0) break;
    // mode=any/or：任一成功即可返回
    if (mode === 'any' && passCount > 0) break;
    // mode=soft：执行全部，不中断
  }

  return results;
}

/** 判断对象是否为 AssertionGroup（含 rules 数组） */
function isAssertionGroup(obj: unknown): obj is AssertionGroup {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'rules' in obj &&
    Array.isArray((obj as Record<string, unknown>).rules)
  );
}

/** 规范化模式：支持 mode + combinator，接受别名 and/or */
function normalizeMode(mode?: string, combinator?: string): AssertionMode {
  const raw = mode || combinator || 'all';
  switch (raw) {
    case 'all':
    case 'and':
      return 'all';
    case 'any':
    case 'or':
      return 'any';
    case 'soft':
      return 'soft';
    default:
      return 'all';
  }
}

/** 执行单条断言规则（含超时/重试） */
async function runRule(rule: AssertionRule, context: AssertionContext): Promise<CheckResult> {
  const { target, path, operator, expected, message, severity } = rule;

  // 提取实际值
  const actual = extractValue(context, target, path);

  // 断言名称
  const name = message || `${target}.${path || ''} ${operator}`;

  // 重试逻辑
  const retryCount = rule.retry?.count || 0;
  const retryInterval = rule.retry?.intervalMs || 500;
  const timeoutMs = rule.timeoutMs || 5000;

  for (let attempt = 0; attempt <= retryCount; attempt++) {
    const currentActual = attempt === 0 ? actual : extractValue(context, target, path);

    // 带超时执行
    const result = await raceWithTimeout(
      applyOperatorAsync(operator, currentActual, expected, rule),
      timeoutMs,
      name,
    );

    if (result.pass) {
      return {
        name,
        pass: true,
        detail: result.detail,
        level: severity,
      };
    }

    // 最后一次尝试失败
    if (attempt === retryCount) {
      logger.debug(`  ❌ ${name}: ${result.detail}`);
      return {
        name,
        pass: false,
        detail: `${result.detail}${attempt > 0 ? ` (after ${attempt + 1} attempts)` : ''}`,
        level: severity,
      };
    }

    // 等待重试
    logger.debug(`  ⏳ 断言重试 ${attempt + 1}/${retryCount}: ${name}`);
    await sleep(retryInterval * Math.pow(2, attempt)); // 指数退避
  }

  return { name, pass: false, detail: 'unreachable', level: severity };
}

/** 带超时的 Promise 竞赛 */
async function raceWithTimeout<T>(
  promise: Promise<T>,
  ms: number,
  name: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`断言超时（${ms}ms）: ${name}`)), ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } catch (e: any) {
    return { pass: false, detail: e.message } as T;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── 便捷工厂函数 ──

/** 创建 all 模式断言组 */
export function assertAll(...rules: (AssertionRule | AssertionGroup)[]): AssertionGroup {
  return { mode: 'all', rules };
}

/** 创建 any 模式断言组 */
export function assertAny(...rules: (AssertionRule | AssertionGroup)[]): AssertionGroup {
  return { mode: 'any', rules };
}

/** 创建 soft 模式断言组 */
export function assertSoft(...rules: (AssertionRule | AssertionGroup)[]): AssertionGroup {
  return { mode: 'soft', rules };
}

/** 快速创建单条规则 */
export function rule(
  target: string,
  path: string | undefined,
  operator: AssertionOperator,
  expected?: unknown,
  message?: string,
): AssertionRule {
  return { target, path, operator, expected, message };
}
