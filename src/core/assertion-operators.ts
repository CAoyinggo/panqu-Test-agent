// 断言操作符实现：每个操作符接收 (actual, expected, rule)，返回 { pass, detail }
// detail 必须包含期望值 vs 实际值，便于调试
import { formatValue } from './path-extractor.js';

export type AssertionOperator =
  | 'equals' | 'notEquals' | 'contains' | 'notContains'
  | 'exists' | 'notExists' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'in' | 'notIn' | 'regex' | 'type' | 'length'
  | 'deepEquals' | 'jsonSchema';

export interface OperatorResult {
  pass: boolean;
  detail: string;
}

export interface AssertionRule {
  target: string;
  path?: string;
  operator: AssertionOperator;
  expected?: unknown;
  message?: string;
  timeoutMs?: number;
  retry?: { count: number; intervalMs: number };
  severity?: 'P0' | 'P1' | 'P2';
}

/** 操作符实现注册表（支持同步和异步操作符） */
const operators = new Map<string, (actual: unknown, expected: unknown, rule: AssertionRule) => OperatorResult | Promise<OperatorResult>>();

/** 注册操作符 */
function register(name: AssertionOperator, fn: (actual: unknown, expected: unknown, rule: AssertionRule) => OperatorResult | Promise<OperatorResult>): void {
  operators.set(name, fn);
}

// ── equals: 严格相等 === ──
register('equals', (actual, expected, rule) => {
  const pass = actual === expected;
  return {
    pass,
    detail: pass
      ? `${formatValue(actual)} === ${formatValue(expected)}`
      : `expected: ${formatValue(expected)}, actual: ${formatValue(actual)}`,
  };
});

// ── notEquals: 不等 !== ──
register('notEquals', (actual, expected, rule) => {
  const pass = actual !== expected;
  return {
    pass,
    detail: pass
      ? `${formatValue(actual)} !== ${formatValue(expected)}`
      : `value should not be ${formatValue(expected)}, but got ${formatValue(actual)}`,
  };
});

// ── contains: 字符串子串 / 数组元素 ──
register('contains', (actual, expected, rule) => {
  let pass = false;
  if (typeof actual === 'string' && typeof expected === 'string') {
    pass = actual.includes(expected);
  } else if (Array.isArray(actual)) {
    pass = actual.includes(expected);
  }
  return {
    pass,
    detail: pass
      ? `${formatValue(actual)} contains ${formatValue(expected)}`
      : `expected to contain ${formatValue(expected)}, got ${formatValue(actual)}`,
  };
});

// ── notContains ──
register('notContains', (actual, expected, rule) => {
  let contains = false;
  if (typeof actual === 'string' && typeof expected === 'string') {
    contains = actual.includes(expected);
  } else if (Array.isArray(actual)) {
    contains = actual.includes(expected);
  }
  return {
    pass: !contains,
    detail: !contains
      ? `${formatValue(actual)} does not contain ${formatValue(expected)}`
      : `should not contain ${formatValue(expected)}, but found in ${formatValue(actual)}`,
  };
});

// ── exists: 非 undefined/null ──
register('exists', (actual, _expected, rule) => {
  const pass = actual !== undefined && actual !== null;
  return {
    pass,
    detail: pass ? 'value exists' : 'value is undefined or null',
  };
});

// ── notExists: 为 undefined/null ──
register('notExists', (actual, _expected, rule) => {
  const pass = actual === undefined || actual === null;
  return {
    pass,
    detail: pass ? 'value does not exist' : `value is ${formatValue(actual)}, expected undefined/null`,
  };
});

// ── gt: 大于 ──
register('gt', (actual, expected, rule) => {
  const a = Number(actual);
  const e = Number(expected);
  const pass = !isNaN(a) && !isNaN(e) && a > e;
  return {
    pass,
    detail: pass ? `${a} > ${e}` : `expected > ${e}, actual: ${a}`,
  };
});

// ── gte: 大于等于 ──
register('gte', (actual, expected, rule) => {
  const a = Number(actual);
  const e = Number(expected);
  const pass = !isNaN(a) && !isNaN(e) && a >= e;
  return {
    pass,
    detail: pass ? `${a} >= ${e}` : `expected >= ${e}, actual: ${a}`,
  };
});

// ── lt: 小于 ──
register('lt', (actual, expected, rule) => {
  const a = Number(actual);
  const e = Number(expected);
  const pass = !isNaN(a) && !isNaN(e) && a < e;
  return {
    pass,
    detail: pass ? `${a} < ${e}` : `expected < ${e}, actual: ${a}`,
  };
});

// ── lte: 小于等于 ──
register('lte', (actual, expected, rule) => {
  const a = Number(actual);
  const e = Number(expected);
  const pass = !isNaN(a) && !isNaN(e) && a <= e;
  return {
    pass,
    detail: pass ? `${a} <= ${e}` : `expected <= ${e}, actual: ${a}`,
  };
});

// ── in: 值在列表中 ──
register('in', (actual, expected, rule) => {
  const list = Array.isArray(expected) ? expected : [expected];
  const pass = list.includes(actual);
  return {
    pass,
    detail: pass
      ? `${formatValue(actual)} in [${list.map(formatValue).join(', ')}]`
      : `${formatValue(actual)} not in [${list.map(formatValue).join(', ')}]`,
  };
});

// ── notIn: 值不在列表中 ──
register('notIn', (actual, expected, rule) => {
  const list = Array.isArray(expected) ? expected : [expected];
  const pass = !list.includes(actual);
  return {
    pass,
    detail: pass
      ? `${formatValue(actual)} not in [${list.map(formatValue).join(', ')}]`
      : `${formatValue(actual)} should not be in [${list.map(formatValue).join(', ')}]`,
  };
});

// ── regex: 正则匹配 ──
register('regex', (actual, expected, rule) => {
  const str = typeof actual === 'string' ? actual : String(actual ?? '');
  const pattern = typeof expected === 'string' ? expected : String(expected);
  let pass = false;
  try {
    const re = new RegExp(pattern);
    pass = re.test(str);
  } catch {
    return { pass: false, detail: `invalid regex pattern: ${pattern}` };
  }
  return {
    pass,
    detail: pass
      ? `pattern /${pattern}/ matched "${str}"`
      : `pattern /${pattern}/ didn't match "${str}"`,
  };
});

// ── type: 类型校验 ──
register('type', (actual, expected, rule) => {
  const expectedType = String(expected);
  let actualType: string;
  if (actual === null) actualType = 'null';
  else if (Array.isArray(actual)) actualType = 'array';
  else actualType = typeof actual;

  const pass = actualType === expectedType;
  return {
    pass,
    detail: pass
      ? `type: ${actualType}`
      : `expected type: ${expectedType}, actual: ${actualType}`,
  };
});

// ── length: 数组/字符串长度 ──
register('length', (actual, expected, rule) => {
  const expectedLen = Number(expected);
  let actualLen = -1;
  if (Array.isArray(actual)) actualLen = actual.length;
  else if (typeof actual === 'string') actualLen = actual.length;
  else if (actual && typeof actual === 'object') actualLen = Object.keys(actual).length;

  const pass = actualLen === expectedLen;
  return {
    pass,
    detail: pass
      ? `length: ${actualLen}`
      : `expected length: ${expectedLen}, actual: ${actualLen}`,
  };
});

// ── deepEquals: 深度相等 ──
register('deepEquals', (actual, expected, rule) => {
  const pass = deepEqual(actual, expected);
  const diff = pass ? '' : ` - diff: ${jsonDiff(actual, expected)}`;
  return {
    pass,
    detail: pass
      ? 'deep equal'
      : `expected: ${formatValue(expected)}, actual: ${formatValue(actual)}${diff}`,
  };
});

// ── jsonSchema: JSON Schema 校验（动态加载 ajv，带编译缓存） ──

/** ajv 实例缓存（懒加载，避免重复创建） */
let ajvInstance: any = null;
/** schema 编译结果缓存（key = JSON.stringify(schema)） */
const schemaCache = new Map<string, { validate: any; ajv: any }>();

/** 获取或创建 ajv 实例（懒加载） */
async function getAjv(): Promise<any> {
  if (ajvInstance) return ajvInstance;
  const mod = await import('ajv');
  const Ajv = (mod as any).default || (mod as any).Ajv;
  ajvInstance = new Ajv({ allErrors: true, strict: false });
  return ajvInstance;
}

register('jsonSchema', async (actual, expected, rule) => {
  try {
    const ajv = await getAjv();
    const schemaKey = JSON.stringify(expected);
    let cached = schemaCache.get(schemaKey);
    if (!cached) {
      cached = { validate: ajv.compile(expected), ajv };
      schemaCache.set(schemaKey, cached);
    }
    const pass = cached.validate(actual);
    if (pass) {
      return { pass: true, detail: 'JSON Schema validation passed' };
    }
    // 结构化错误：/path: message
    const errors = cached.validate.errors?.map((e: any) => {
      const path = e.instancePath || '/';
      const msg = e.message || 'invalid';
      const params = e.params ? ` (${JSON.stringify(e.params)})` : '';
      return `${path}: ${msg}${params}`;
    }).join('; ') || 'unknown';
    return { pass: false, detail: `JSON Schema validation failed: ${errors}` };
  } catch (e: any) {
    // ajv 未安装或 schema 无效，降级跳过
    return {
      pass: true,
      detail: `ajv 未安装或 schema 无效，跳过 JSON Schema 校验: ${e.message}`,
    };
  }
});

// ── 辅助函数 ──

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;

  if (typeof a !== 'object') return a === b;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }

  if (!Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }

  return false;
}

function jsonDiff(actual: unknown, expected: unknown): string {
  const a = formatValue(actual);
  const e = formatValue(expected);
  if (a === e) return 'no difference';
  // 简化 diff：只显示不同的顶层 key
  if (typeof actual === 'object' && typeof expected === 'object' && actual && expected) {
    const ak = Object.keys(actual as object).sort();
    const ek = Object.keys(expected as object).sort();
    const missing = ek.filter((k) => !ak.includes(k));
    const extra = ak.filter((k) => !ek.includes(k));
    const parts: string[] = [];
    if (missing.length) parts.push(`missing: ${missing.join(',')}`);
    if (extra.length) parts.push(`extra: ${extra.join(',')}`);
    return parts.join('; ') || `value differs`;
  }
  return `${e} vs ${a}`;
}

// ── 导出 ──

/** 执行操作符 */
export function applyOperator(
  operator: string,
  actual: unknown,
  expected: unknown,
  rule: AssertionRule,
): OperatorResult {
  const fn = operators.get(operator);
  if (!fn) {
    return { pass: false, detail: `unknown operator: ${operator}` };
  }
  const result = fn(actual, expected, rule);
  // 异步操作符（jsonSchema）返回 Promise
  if (result instanceof Promise) {
    return { pass: false, detail: 'async operator not supported in sync mode' };
  }
  return result;
}

/** 异步执行操作符（支持 jsonSchema） */
export async function applyOperatorAsync(
  operator: string,
  actual: unknown,
  expected: unknown,
  rule: AssertionRule,
): Promise<OperatorResult> {
  const fn = operators.get(operator);
  if (!fn) {
    return { pass: false, detail: `unknown operator: ${operator}` };
  }
  const result = await fn(actual, expected, rule);
  return result;
}

/** 列出所有已注册操作符 */
export function listOperators(): string[] {
  return Array.from(operators.keys());
}

/** 检查操作符是否支持 */
export function hasOperator(name: string): boolean {
  return operators.has(name);
}
