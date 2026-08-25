// Phase 27.1 生产安全模式（Production Safety Mode）
// 统一解析运行模式并强制生产安全约束：
// - production / staging：必须显式配置非默认 JWT_SECRET（缺失或使用开发默认值 → 拒绝启动）
// - production：强制禁用默认种子口令（allowDefaultCredentials=false）、禁止 X-Actor/X-Role 静态身份伪造
// - development / test：允许开发回退（默认密钥 / 默认口令 / dev-token）
// 纯模块（零依赖），供 factory / api / CLI / preflight 共用，避免安全策略多头定义。
// 架构原则：核心安全约束走确定性规则（Rule），不依赖 LLM。

/** 平台运行模式 */
export type PlatformMode = 'development' | 'test' | 'staging' | 'production';

/** 开发回退 JWT 密钥（生产/预发模式禁止使用） */
export const DEV_FALLBACK_JWT_SECRET = 'dev-secret-change-me';
/** 开发回退静态 API Token（生产模式禁止作为身份来源） */
export const DEV_STATIC_TOKEN = 'dev-token';

const KNOWN_MODES: readonly PlatformMode[] = ['development', 'test', 'staging', 'production'];

/**
 * 解析运行模式（未显式设置 → development；PLATFORM_MODE 优先，兼容旧 PLATFORM_ENVIRONMENT；大小写不敏感）。
 * 安全不变量：显式设置的未知值一律启动失败（fail fast），禁止「未知值 → development」静默降级，
 * 否则拼写错误（如 produciton）会让服务以开发回退策略（dev-token / 默认口令）跑在生产环境。
 */
export function resolvePlatformMode(env?: string): PlatformMode {
  const configuredMode = process.env.PLATFORM_MODE?.trim()
    ? process.env.PLATFORM_MODE
    : process.env.PLATFORM_ENVIRONMENT;
  const rawEnv = env ?? configuredMode;
  if (rawEnv === undefined) return 'development';
  const raw = rawEnv.trim().toLowerCase();
  if (!raw) return 'development';
  if (raw === 'prod') return 'production';
  if ((KNOWN_MODES as readonly string[]).includes(raw)) return raw as PlatformMode;
  throw new Error(
    `[security] 未知 PLATFORM_MODE：${JSON.stringify(rawEnv)}（合法值：${KNOWN_MODES.join(' / ')}；别名 prod→production）。拒绝启动，禁止静默回退 development`,
  );
}

/** staging 与 production 一律按生产安全约束执行（staging 是真实生产演练环境，策略不得偏开发） */
export function isProductionLike(mode: PlatformMode): boolean {
  return mode === 'production' || mode === 'staging';
}

/** 是否为已知不安全（缺失 / 开发回退）的 JWT 密钥（类型守卫：非不安全即收窄为 string） */
export function isKnownInsecureJwtSecret(secret: string | undefined): secret is undefined {
  return !secret || secret === DEV_FALLBACK_JWT_SECRET;
}

/**
 * 生产安全模式：JWT_SECRET 必须显式配置且非默认值，否则拒绝装配（fail fast）。
 * 非生产模式：缺失时返回开发回退密钥（仅开发/测试）。
 */
export function requireSecureJwtSecret(mode: PlatformMode, secret: string | undefined): string {
  if (isProductionLike(mode) && isKnownInsecureJwtSecret(secret)) {
    throw new Error(`[security] 运行模式 ${mode} 必须显式配置非默认 JWT_SECRET（当前缺失或使用开发默认值 ${DEV_FALLBACK_JWT_SECRET}）`);
  }
  return secret ?? DEV_FALLBACK_JWT_SECRET;
}

/** staging/production 强制禁用默认种子口令；其余模式保持显式传入值（默认 true，供开发/测试） */
export function resolveAllowDefaultCredentials(mode: PlatformMode, explicit?: boolean): boolean {
  if (isProductionLike(mode)) return false;
  return explicit ?? true;
}

/** X-Actor/X-Role 静态头身份是否允许（staging/production 一律禁止，防身份伪造） */
export function allowHeaderIdentity(mode: PlatformMode): boolean {
  return !isProductionLike(mode);
}

/** 静态 Bearer Token（含 dev-token）是否可作为身份来源（仅 development/test；staging/production 强制 JWT） */
export function allowStaticToken(mode: PlatformMode): boolean {
  return !isProductionLike(mode);
}

/**
 * 静态身份来源统一解析（Phase 36，DEBT-12 已解决）：
 * 守卫 + 解析收敛到 security 模块（防新 API 入口绕过生产关闭）：
 * - staging/production：返回 null（身份伪造已关闭，调用方不得回退静态身份）；
 * - 其余模式：从 X-Actor / X-Role 头解析（数组取首项；无 actor 默认 'api'，无 role 默认 'VIEWER'）。
 * 注：返回 role 为 string，调用方需按自身 Role 联合类型收窄。
 */
export function resolveStaticIdentity(
  mode: PlatformMode,
  headers: { 'x-actor'?: unknown; 'x-role'?: unknown; [key: string]: unknown },
): { actor: string; role: string } | null {
  if (!allowHeaderIdentity(mode)) return null;
  const first = (v: unknown): string | undefined =>
    Array.isArray(v) ? (v.length ? String(v[0]) : undefined) : v == null ? undefined : String(v);
  return {
    actor: first(headers['x-actor']) || 'api',
    role: first(headers['x-role']) || 'VIEWER',
  };
}

/** 安全策略清单（供 Preflight 展示；返回检查项，由调用方决定 PASS/WARN/BLOCK 级别） */
export interface SecurityCheckResult {
  name: string;
  level: 'PASS' | 'WARN' | 'BLOCK';
  detail: string;
}

/** 生产安全预检项：运行模式 / JWT 密钥 / 默认口令 / 静态身份来源 */
export function securityChecks(mode: PlatformMode, opts: { jwtSecret?: string; allowDefaultCredentials?: boolean } = {}): SecurityCheckResult[] {
  const secret = opts.jwtSecret ?? process.env.JWT_SECRET;
  const allowDefault = opts.allowDefaultCredentials ?? resolveAllowDefaultCredentials(mode);
  const productionLike = isProductionLike(mode);
  const secureSecret = !isKnownInsecureJwtSecret(secret);

  const items: SecurityCheckResult[] = [
    {
      name: '运行模式',
      level: 'PASS',
      detail: `PLATFORM_MODE=${mode}${productionLike ? '（生产安全约束已生效）' : '（开发模式，允许回退）'}`,
    },
    {
      name: 'JWT 密钥',
      level: productionLike ? (secureSecret ? 'PASS' : 'BLOCK') : secureSecret ? 'PASS' : 'WARN',
      detail: productionLike
        ? (secureSecret ? '已配置非默认 JWT_SECRET' : '必须显式配置非默认 JWT_SECRET（禁止 dev-secret-change-me）')
        : (secureSecret ? '已配置 JWT_SECRET' : '未配置 JWT_SECRET（开发回退密钥，仅限开发/测试）'),
    },
    {
      name: '默认口令',
      level: productionLike && allowDefault ? 'BLOCK' : 'PASS',
      detail: allowDefault ? '允许默认种子口令登录（staging/production 禁止）' : '默认种子口令已禁用（需运维显式配置用户）',
    },
    {
      name: '静态身份来源',
      level: productionLike ? 'PASS' : 'WARN',
      detail: productionLike ? 'dev-token 与 X-Actor/X-Role 静态身份已关闭（强制 JWT）' : `dev-token / X-Actor/X-Role 静态身份可用（${mode} 模式；staging/production 关闭）`,
    },
  ];
  return items;
}
