// 数据生成器：从模板/Schema 生成测试数据，支持边界模式、随机种子、占位符引用
// 无外部依赖，纯 Node.js crypto + 自实现 PRNG
import crypto from 'node:crypto';
import { logger } from './logger.js';

// ── PRNG（带种子，Mulberry32 算法，轻量快速） ──

class SeededRandom {
  private state: number;

  constructor(seed?: number) {
    this.state = seed ?? Math.floor(Math.random() * 0xffffffff);
  }

  next(): number {
    this.state |= 0;
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  pick<T>(arr: T[]): T {
    return arr[this.int(0, arr.length - 1)];
  }

  float(min: number, max: number, precision = 2): number {
    const v = this.next() * (max - min) + min;
    return parseFloat(v.toFixed(precision));
  }

  string(length: number, charset?: string): string {
    const cs = charset || 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let s = '';
    for (let i = 0; i < length; i++) s += cs[this.int(0, cs.length - 1)];
    return s;
  }
}

// ── 类型定义 ──

export type GeneratorType =
  | 'string' | 'number' | 'boolean' | 'array' | 'object'
  | 'timestamp' | 'uuid' | 'email' | 'phone' | 'enum'
  | 'boundary';

export interface DataTemplate {
  type: GeneratorType;
  // string
  length?: number;
  charset?: string;
  pattern?: string; // 正则模式（简化版，生成匹配字符串）
  min?: number;
  max?: number;
  // number
  step?: number;
  precision?: number;
  // array
  count?: number;
  items?: DataTemplate;
  // object
  properties?: Record<string, DataTemplate>;
  // enum
  values?: unknown[];
  // timestamp
  format?: 'iso' | 'unix' | 'unixMs';
  // boundary
  boundaryType?: 'min' | 'max' | 'edge' | 'empty' | 'long' | 'special';
  // 通用
  seed?: number;
  optional?: boolean;
}

export interface GenerateOptions {
  seed?: number;
  /** 边界模式：生成多组边界值 */
  boundary?: boolean;
  /** 占位符上下文（用例数据） */
  context?: Record<string, unknown>;
}

// ── 内置字符集 ──
const CHARSETS = {
  alpha: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
  lower: 'abcdefghijklmnopqrstuvwxyz',
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digit: '0123456789',
  alnum: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  hex: '0123456789abcdef',
  special: '!@#$%^&*()_+-=[]{}|;:,.<>?`~',
  unicode: 'こんにちは你好안녕하세요😀🎉',
  whitespace: ' \t\n\r\v\f',
};

// ── 特殊字符集（边界测试用） ──
const SPECIAL_CHARS = [
  '', // 空字符串
  ' ', // 空格
  '\t', // 制表符
  '\n', // 换行
  '\0', // null 字节
  '<script>alert(1)</script>', // XSS
  "'; DROP TABLE--", // SQL 注入
  '${7*7}', // 模板注入
  '../../../etc/passwd', // 路径遍历
  'a'.repeat(10000), // 超长
  '🚀🎉🔥💻', // emoji
  'null', 'undefined', 'NaN', 'true', 'false', // 类型混淆
];

// ── 辅助函数 ──

function generateEmail(rng: SeededRandom): string {
  const domains = ['example.com', 'test.com', 'qa.io', 'dev.org'];
  const user = rng.string(rng.int(4, 10), CHARSETS.lower + CHARSETS.digit);
  return `${user}@${rng.pick(domains)}`;
}

function generatePhone(rng: SeededRandom): string {
  const prefixes = ['138', '139', '150', '151', '188', '199'];
  return rng.pick(prefixes) + rng.string(8, CHARSETS.digit);
}

function generateUuid(): string {
  return crypto.randomUUID();
}

function generateTimestamp(format?: string): string | number {
  const now = Date.now();
  switch (format) {
    case 'unix': return Math.floor(now / 1000);
    case 'unixMs': return now;
    case 'iso':
    default: return new Date(now).toISOString();
  }
}

// ── 边界值生成 ──

function generateBoundaryValues(template: DataTemplate, rng: SeededRandom): unknown[] {
  const results: unknown[] = [];

  switch (template.type) {
    case 'string': {
      const minLen = template.min ?? 0;
      const maxLen = template.max ?? 100;
      // 空字符串
      results.push('');
      // 最小长度
      if (minLen > 0) results.push(rng.string(minLen, template.charset));
      // 最大长度
      results.push(rng.string(maxLen, template.charset));
      // 超长值
      results.push(rng.string(maxLen * 2, template.charset));
      // 特殊字符
      results.push(rng.pick(SPECIAL_CHARS));
      break;
    }
    case 'number': {
      const min = template.min ?? 0;
      const max = template.max ?? 100;
      results.push(min); // 最小值
      results.push(max); // 最大值
      results.push(min - 1); // 下界外
      results.push(max + 1); // 上界外
      results.push(0); // 零值
      results.push(-1); // 负值
      results.push(NaN); // NaN
      results.push(Infinity); // 无穷
      break;
    }
    case 'boolean': {
      results.push(true);
      results.push(false);
      break;
    }
    case 'array': {
      results.push([]); // 空数组
      if (template.items) {
        // 单元素数组
        results.push([generateData(template.items, { seed: rng.int(0, 99999) })]);
      }
      break;
    }
    case 'object': {
      results.push({}); // 空对象
      break;
    }
    case 'email': {
      results.push('');
      results.push('invalid');
      results.push('a@b');
      results.push(generateEmail(rng));
      results.push(rng.string(255, CHARSETS.alnum) + '@example.com'); // 超长
      break;
    }
    case 'phone': {
      results.push('');
      results.push('123');
      results.push(generatePhone(rng));
      results.push('+' + rng.string(20, CHARSETS.digit)); // 国际格式
      break;
    }
    default:
      results.push(null);
      results.push(undefined);
  }

  return results;
}

// ── 核心生成函数 ──

export function generateData(template: DataTemplate, options: GenerateOptions = {}): unknown {
  const rng = new SeededRandom(template.seed ?? options.seed);

  // 边界模式
  if (options.boundary || template.type === 'boundary') {
    return generateBoundaryValues(template, rng);
  }

  switch (template.type) {
    case 'string': {
      const len = template.length ?? rng.int(template.min ?? 1, template.max ?? 20);
      const cs = template.charset ? (CHARSETS[template.charset as keyof typeof CHARSETS] || template.charset) : CHARSETS.alnum;
      return rng.string(len, cs);
    }

    case 'number': {
      const min = template.min ?? 0;
      const max = template.max ?? 100;
      const step = template.step;
      if (step) {
        const steps = Math.floor((max - min) / step) + 1;
        return min + step * rng.int(0, steps - 1);
      }
      return rng.float(min, max, template.precision ?? 2);
    }

    case 'boolean':
      return rng.next() > 0.5;

    case 'array': {
      const count = template.count ?? rng.int(1, 5);
      const items: unknown[] = [];
      for (let i = 0; i < count; i++) {
        if (template.items) {
          items.push(generateData(template.items, { ...options, seed: rng.int(0, 99999) }));
        }
      }
      return items;
    }

    case 'object': {
      const obj: Record<string, unknown> = {};
      if (template.properties) {
        for (const [key, subTemplate] of Object.entries(template.properties)) {
          if (subTemplate.optional && rng.next() > 0.5) continue;
          obj[key] = generateData(subTemplate, { ...options, seed: rng.int(0, 99999) });
        }
      }
      return obj;
    }

    case 'timestamp':
      return generateTimestamp(template.format);

    case 'uuid':
      return generateUuid();

    case 'email':
      return generateEmail(rng);

    case 'phone':
      return generatePhone(rng);

    case 'enum':
      if (template.values && template.values.length > 0) {
        return rng.pick(template.values);
      }
      return undefined;

    default:
      logger.warn(`未知生成器类型: ${template.type}`);
      return null;
  }
}

// ── 占位符解析 ──

/**
 * 解析字符串中的占位符并替换为生成的数据。
 * 支持格式：
 *   {{gen.email}}           → 随机邮箱
 *   {{gen.uuid}}            → UUID
 *   {{gen.phone}}           → 随机手机号
 *   {{gen.timestamp.iso}}   → ISO 时间戳
 *   {{gen.string.length.10}} → 10 字符随机字符串
 *   {{gen.number.range.1.100}} → 1-100 随机数
 *   {{gen.boolean}}         → 随机布尔值
 *   {{gen.boundary.length.0}} → 边界值（空字符串）
 *   {{gen.enum.a.b.c}}      → 从 a/b/c 中随机选一个
 *
 * @param data 原始数据（字符串/对象/数组，递归处理）
 * @param options 生成选项
 */
export function resolvePlaceholders(data: unknown, options: GenerateOptions = {}): unknown {
  if (typeof data === 'string') {
    return resolveStringPlaceholders(data, options);
  }
  if (Array.isArray(data)) {
    return data.map((item) => resolvePlaceholders(item, options));
  }
  if (data && typeof data === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      result[key] = resolvePlaceholders(value, options);
    }
    return result;
  }
  return data;
}

function resolveStringPlaceholders(str: string, options: GenerateOptions): unknown {
  // 如果整个字符串就是一个占位符，返回原始类型（不是字符串）
  const fullMatch = str.match(/^\{\{gen\.([^}]+)\}\}$/);
  if (fullMatch) {
    return resolveGenPlaceholder(fullMatch[1], options);
  }

  // 否则替换字符串中的所有占位符
  return str.replace(/\{\{gen\.([^}]+)\}\}/g, (_, expr: string) => {
    const val = resolveGenPlaceholder(expr.trim(), options);
    return String(val ?? '');
  });
}

function resolveGenPlaceholder(expr: string, options: GenerateOptions): unknown {
  const parts = expr.split('.');
  const type = parts[0];
  const rng = new SeededRandom(options.seed);

  switch (type) {
    case 'email':
      return generateEmail(rng);
    case 'uuid':
      return generateUuid();
    case 'phone':
      return generatePhone(rng);
    case 'timestamp':
      return generateTimestamp(parts[1] || 'iso');
    case 'boolean':
      return rng.next() > 0.5;
    case 'string': {
      const len = parts[1] === 'length' ? Number(parts[2]) : 10;
      return rng.string(len || 10, CHARSETS.alnum);
    }
    case 'number': {
      if (parts[1] === 'range') {
        return rng.float(Number(parts[2]) || 0, Number(parts[3]) || 100, 2);
      }
      return rng.int(0, 100);
    }
    case 'boundary': {
      const bType = parts[1] || 'min';
      switch (bType) {
        case 'length':
          return parts[2] === '0' ? '' : 'a'.repeat(Number(parts[2]) || 100);
        case 'empty':
          return '';
        case 'long':
          return 'a'.repeat(10000);
        case 'special':
          return rng.pick(SPECIAL_CHARS);
        case 'min':
          return 0;
        case 'max':
          return 999999;
        default:
          return null;
      }
    }
    case 'enum': {
      const values = parts.slice(1);
      return rng.pick(values);
    }
    default:
      logger.warn(`未知占位符类型: gen.${type}`);
      return null;
  }
}

// ── 批量生成 ──

/**
 * 批量生成测试数据。
 * @param template 数据模板
 * @param count 生成数量
 * @param options 生成选项
 */
export function generateBatch(template: DataTemplate, count: number, options: GenerateOptions = {}): unknown[] {
  const results: unknown[] = [];
  for (let i = 0; i < count; i++) {
    results.push(generateData(template, { ...options, seed: options.seed ? options.seed + i : undefined }));
  }
  return results;
}

/**
 * 从 JSON Schema 生成数据（简化版，支持 type/properties/items/minimum/maximum/minLength/maxLength/enum）。
 */
export function generateFromSchema(schema: Record<string, unknown>, options: GenerateOptions = {}): unknown {
  const template = schemaToTemplate(schema);
  return generateData(template, options);
}

/** 将 JSON Schema 转为 DataTemplate（递归） */
function schemaToTemplate(schema: Record<string, unknown>): DataTemplate {
  const type = schema.type as string;
  const template: DataTemplate = { type: type as GeneratorType };

  if (schema.minimum !== undefined) template.min = schema.minimum as number;
  if (schema.maximum !== undefined) template.max = schema.maximum as number;
  if (schema.minLength !== undefined) template.min = schema.minLength as number;
  if (schema.maxLength !== undefined) template.max = schema.maxLength as number;
  if (schema.enum !== undefined) {
    template.type = 'enum';
    template.values = schema.enum as unknown[];
  }

  if (type === 'object' && schema.properties) {
    template.type = 'object';
    template.properties = {};
    for (const [key, subSchema] of Object.entries(schema.properties as Record<string, unknown>)) {
      template.properties[key] = schemaToTemplate(subSchema as Record<string, unknown>);
    }
  }

  if (type === 'array' && schema.items) {
    template.type = 'array';
    template.items = schemaToTemplate(schema.items as Record<string, unknown>);
    template.count = 3;
  }

  return template;
}
