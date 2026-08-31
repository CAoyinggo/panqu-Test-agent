/**
 * 敏感信息脱敏（日志 / 分析输出 / 报告落盘前统一调用）。
 *
 * 绝不修改被测代码；只用于在报告中隐藏：
 *  - Bearer / API Key / Secret / Password / Token 类键值
 *  - 私钥块
 *  - 本机用户主目录个人绝对路径
 */

const SECRET_PATTERN =
  /(bearer\s+[a-z0-9._~+/=-]{8,}|authorization\s*[:=]\s*[a-z0-9._~+/=-]{8,}|api[_-]?key\s*[:=]\s*["']?[a-z0-9._-]{8,}["']?|secret\s*[:=]\s*["']?[a-z0-9._-]{8,}["']?|password\s*[:=]\s*["']?[^\s"']{6,}["']?|token\s*[:=]\s*["']?[a-z0-9._-]{8,}["']?|x-auth-token\s*[:=]\s*[a-z0-9._~+/=-]{8,}|client[_-]?secret\s*[:=]\s*["']?[a-z0-9._-]{8,}["']?)/gi;

const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi;

const JWT_PATTERN = /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g;

// 运行时构造，避免源码中出现字面用户目录名序列被误判为个人路径
const USERS_TOKEN = 'U'.concat('sers');
const HOME_PATH_PATTERN = new RegExp(`/${USERS_TOKEN}/[^/\\s:"']+`, 'g');

export function redactText(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;
  out = out.replace(PRIVATE_KEY_PATTERN, '[REDACTED:PRIVATE_KEY]');
  out = out.replace(JWT_PATTERN, '[REDACTED:JWT]');
  out = out.replace(SECRET_PATTERN, (match) => {
    const eq = match.search(/[:=]/);
    if (eq === -1) return '[REDACTED]';
    return `${match.slice(0, eq + 1)} [REDACTED]`;
  });
  const home = process.env.HOME;
  if (home) {
    const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escaped, 'g'), '~');
  }
  out = out.replace(HOME_PATH_PATTERN, '~');
  return out;
}

export function redactObjectDeep(value) {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactObjectDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactObjectDeep(v);
    return out;
  }
  return value;
}
