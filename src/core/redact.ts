// 共享安全工具：敏感信息脱敏（Phase 28.3）
// 供 Agent Tool 审计、平台 AuditLog 等跨层模块共用，避免平台层反向依赖 agents 域。

/** 敏感字段名（脱敏掩码：审计/日志不落明文） */
export const SENSITIVE_KEYS = [
  'password', 'passwd', 'token', 'secret', 'authorization', 'cookie',
  'api_key', 'apikey', 'access_key', 'private_key', 'credential', 'auth',
  'session', 'cvv', 'card',
  'account', 'username', 'nickname',
  'email', 'phone', 'mobile',
];

const EXACT_ONLY_SENSITIVE_KEYS = new Set(['auth']);

function sensitiveKey(value: string): boolean {
  const key = value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[-.\s]+/g, '_');
  return SENSITIVE_KEYS.some((candidate) => {
    if (key === candidate) return true;
    if (EXACT_ONLY_SENSITIVE_KEYS.has(candidate)) return false;
    return key.startsWith(`${candidate}_`) || key.endsWith(`_${candidate}`) || key.includes(`_${candidate}_`);
  });
}

const TEXT_REDACTIONS: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  { pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, replacement: '[REDACTED_PRIVATE_KEY]' },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, replacement: 'Bearer ***' },
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, replacement: '***' },
  { pattern: /\bsk-[A-Za-z0-9_-]{12,}\b/g, replacement: '***' },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: '***' },
  { pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, replacement: '***@***' },
  { pattern: /(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g, replacement: '***' },
  { pattern: /([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s/]+(@)/gi, replacement: '$1***$2' },
  {
    pattern: /(["']?(?:password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|token|secret|authorization|cookie|credential|session|account|username|nickname)["']?\s*[:=]\s*)(["'])(?:\\.|(?!\2).)*\2/gi,
    replacement: '$1$2***$2',
  },
  { pattern: /\b(Authorization\s*[:=]\s*)[^\r\n]+/gi, replacement: '$1***' },
  { pattern: /\b(Cookie\s*[:=]\s*)[^\r\n]+/gi, replacement: '$1***' },
  {
    pattern: /\b((?:password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|token|secret|credential|session|account|username|nickname)\s*[:=]\s*)(?!["'])(.*?)(?=\s+[A-Za-z][A-Za-z0-9_.-]*\s*[:=]|[,;}\]]\s*|$)/gim,
    replacement: '$1***',
  },
  {
    pattern: /(["']?(?:password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|token|secret|authorization|cookie|credential|session|account|username|nickname)["']?\s*[:=]\s*["']?)([^"'\s,;}\]]+)/gi,
    replacement: '$1***',
  },
  { pattern: /\b(?:\d[ -]*?){13,19}\b/g, replacement: '***' },
];

/** 对自由文本（API 错误、日志、LLM 输出）中的凭证模式做保形脱敏。 */
export function redactSensitiveText(value: string): string {
  return TEXT_REDACTIONS.reduce(
    (text, { pattern, replacement }) => text.replace(pattern, replacement),
    value,
  );
}

/**
 * 递归脱敏：将敏感字段的值掩码为 ***。
 * 用于 Tool 输入/输出写审计日志、入 Memory 前的安全处理。
 */
export function redactSensitive(value: unknown, depth = 0): unknown {
  // 深层对象宁可丢失诊断细节，也不能在达到递归上限后把原始字符串凭据写入 Artifact。
  if (depth > 6) {
    if (value !== null && typeof value === 'object') return '[object]';
    return typeof value === 'string' ? redactSensitiveText(value) : value;
  }
  if (Array.isArray(value)) return value.map((v) => redactSensitive(v, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sensitiveKey(k) ? '***' : redactSensitive(v, depth + 1);
    }
    return out;
  }
  return typeof value === 'string' ? redactSensitiveText(value) : value;
}
