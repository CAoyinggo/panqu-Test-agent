// JSON Path 提取器：从嵌套对象中按路径提取值
// 支持点路径 + 数组索引 + 通配符
// 纯函数实现，无外部依赖，最大递归深度 10 层
//
// 支持的路径格式：
//   body.data.id              → obj.body.data.id
//   body.data[0].id           → obj.body.data[0].id
//   body.data[*].name          → 所有元素的 name（返回数组）
//   headers.content-type       → obj.headers['content-type']
//   status                     → obj.status
//   metrics.durationMs         → obj.metrics.durationMs

const MAX_DEPTH = 10;

/**
 * 从对象中按路径提取值。
 *
 * @param obj 目标对象
 * @param path 点路径，如 `body.data[0].id` 或 `headers.content-type`
 * @returns 提取的值；路径不存在时返回 undefined
 */
export function extractPath(obj: unknown, path: string): unknown {
  if (obj == null || !path) return undefined;

  // 解析路径为 token 序列
  const tokens = parsePath(path);
  if (tokens.length === 0) return undefined;
  if (tokens.length > MAX_DEPTH) {
    return undefined; // 超过最大深度
  }

  return traverse(obj, tokens, 0);
}

/** 解析路径字符串为 token 序列 */
function parsePath(path: string): PathToken[] {
  const tokens: PathToken[] = [];

  // 按点分割，但处理带连字符的 key（如 content-type）
  // 先将 [N] 形式的索引提取出来
  const normalized = path
    .replace(/\[(\d+)\]/g, '.$1')     // [0] → .0
    .replace(/\[\*\]/g, '.*')           // [*] → .*
    .replace(/\[(['"]?)([^'"\]]+)\1\]/g, '.$2'); // ["key"] → .key

  const parts = normalized.split('.');

  for (const part of parts) {
    if (part === '*') {
      tokens.push({ type: 'wildcard' });
    } else if (/^\d+$/.test(part)) {
      tokens.push({ type: 'index', value: parseInt(part, 10) });
    } else {
      tokens.push({ type: 'key', value: part });
    }
  }

  return tokens;
}

interface PathToken {
  type: 'key' | 'index' | 'wildcard';
  value?: string | number;
}

/** 递归遍历对象 */
function traverse(obj: unknown, tokens: PathToken[], depth: number): unknown {
  if (depth >= MAX_DEPTH) return undefined;
  if (tokens.length === 0) return obj;
  if (obj == null) return undefined;

  const [token, ...rest] = tokens;

  switch (token.type) {
    case 'key': {
      if (typeof obj !== 'object') return undefined;
      const val = (obj as Record<string, unknown>)[token.value as string];
      return traverse(val, rest, depth + 1);
    }

    case 'index': {
      if (!Array.isArray(obj)) return undefined;
      const idx = token.value as number;
      if (idx < 0 || idx >= obj.length) return undefined;
      return traverse(obj[idx], rest, depth + 1);
    }

    case 'wildcard': {
      if (!Array.isArray(obj)) return undefined;
      // 通配符：对每个元素递归，收集结果
      const results: unknown[] = [];
      for (const item of obj) {
        const val = traverse(item, rest, depth + 1);
        if (val !== undefined) results.push(val);
      }
      return results;
    }

    default:
      return undefined;
  }
}

/**
 * 检查路径是否存在。
 * @returns true 如果路径可以提取到非 undefined 的值
 */
export function pathExists(obj: unknown, path: string): boolean {
  return extractPath(obj, path) !== undefined;
}

/**
 * 格式化值用于错误信息展示。
 */
export function formatValue(val: unknown): string {
  if (val === undefined) return 'undefined';
  if (val === null) return 'null';
  if (typeof val === 'string') return `"${val}"`;
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  try {
    return JSON.stringify(val);
  } catch {
    return String(val);
  }
}

// ── 增强提取：返回元信息 ──

export interface PathMeta {
  /** 提取到的值 */
  value: unknown;
  /** 路径是否匹配成功（值非 undefined/null） */
  matched: boolean;
  /** 原始路径字符串 */
  path: string;
  /** 父级对象（值所在的容器） */
  parent?: unknown;
  /** 路径中最后一段 key（如 `data[0].id` 中的 `id`） */
  lastKey?: string;
}

/**
 * 增强版路径提取：返回值 + 匹配状态 + 父级对象 + 最后 key。
 *
 * 用于断言失败时提供上下文快照（parent 值）。
 *
 * @param obj 目标对象
 * @param path 点路径
 * @returns PathMeta 元信息
 */
export function extractPathWithMeta(obj: unknown, path: string): PathMeta {
  if (obj == null || !path) {
    return { value: undefined, matched: false, path };
  }

  const tokens = parsePath(path);
  if (tokens.length === 0 || tokens.length > MAX_DEPTH) {
    return { value: undefined, matched: false, path };
  }

  // 逐层遍历，记录 parent 和 lastKey
  let current: unknown = obj;
  let parent: unknown = undefined;
  let lastKey: string | undefined = undefined;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    parent = current;
    lastKey = token.value != null ? String(token.value) : '*';

    if (current == null) {
      return { value: undefined, matched: false, path, parent, lastKey };
    }

    switch (token.type) {
      case 'key': {
        if (typeof current !== 'object' || Array.isArray(current)) {
          return { value: undefined, matched: false, path, parent, lastKey };
        }
        current = (current as Record<string, unknown>)[token.value as string];
        break;
      }
      case 'index': {
        if (!Array.isArray(current)) {
          return { value: undefined, matched: false, path, parent, lastKey };
        }
        const idx = token.value as number;
        if (idx < 0 || idx >= current.length) {
          return { value: undefined, matched: false, path, parent, lastKey };
        }
        current = current[idx];
        break;
      }
      case 'wildcard': {
        if (!Array.isArray(current)) {
          return { value: undefined, matched: false, path, parent, lastKey };
        }
        // 通配符：对剩余路径逐元素提取
        const restTokens = tokens.slice(i + 1);
        const results: unknown[] = [];
        for (const item of current) {
          const val = restTokens.length === 0 ? item : traverse(item, restTokens, 0);
          if (val !== undefined) results.push(val);
        }
        return {
          value: results,
          matched: results.length > 0,
          path,
          parent: current,
          lastKey: '*',
        };
      }
    }
  }

  return {
    value: current,
    matched: current !== undefined && current !== null,
    path,
    parent,
    lastKey,
  };
}
