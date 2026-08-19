// 共享安全工具：敏感信息脱敏（Phase 28.3）
// 供 Agent Tool 审计、平台 AuditLog 等跨层模块共用，避免平台层反向依赖 agents 域。

/** 敏感字段名（脱敏掩码：审计/日志不落明文） */
export const SENSITIVE_KEYS = [
  'password', 'passwd', 'token', 'secret', 'authorization', 'cookie',
  'api_key', 'apikey', 'access_key', 'private_key', 'credential', 'auth',
  'session', 'cvv', 'card',
];

/**
 * 递归脱敏：将敏感字段的值掩码为 ***。
 * 用于 Tool 输入/输出写审计日志、入 Memory 前的安全处理。
 */
export function redactSensitive(value: unknown, depth = 0): unknown {
  if (depth > 6) return value !== null && typeof value === 'object' ? '[object]' : value;
  if (Array.isArray(value)) return value.map((v) => redactSensitive(v, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // 28.5：归一化分隔符（下划线/连字符），使 api_key 也能命中 X-Api-Key 等变体
      const key = k.toLowerCase().replace(/-/g, '_');
      out[k] = SENSITIVE_KEYS.some((s) => key.includes(s)) ? '***' : redactSensitive(v, depth + 1);
    }
    return out;
  }
  return value;
}
