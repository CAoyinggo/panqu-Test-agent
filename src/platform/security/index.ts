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

/** 解析运行模式（默认 development；经 PLATFORM_MODE 环境变量显式设置；大小写不敏感） */
export function resolvePlatformMode(env?: string): PlatformMode {
  const raw = (env ?? process.env.PLATFORM_MODE ?? 'development').trim().toLowerCase();
  if (raw === 'prod') return 'production';
  return (KNOWN_MODES as readonly string[]).includes(raw) ? (raw as PlatformMode) : 'development';
}

/** 生产安全模式：production 与 staging 一律按生产安全约束执行（staging 为真实生产演练环境） */
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

/** 生产模式强制禁用默认种子口令；其余模式保持显式传入值（默认 true，供开发/测试/演练） */
export function resolveAllowDefaultCredentials(mode: PlatformMode, explicit?: boolean): boolean {
  if (mode === 'production') return false;
  return explicit ?? true;
}

/** 静态 Bearer Token + X-Actor/X-Role 作为身份来源是否允许（生产模式禁止，防身份伪造） */
export function allowHeaderIdentity(mode: PlatformMode): boolean {
  return mode !== 'production';
}

/**
 * 静态身份来源统一解析（Phase 36，DEBT-12 已解决）：
 * 守卫 + 解析收敛到 security 模块（防新 API 入口绕过生产关闭）：
 * - production：返回 null（身份伪造已关闭，调用方不得回退静态身份）；
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
      detail: allowDefault ? '允许默认种子口令登录（生产模式必须禁用）' : '默认种子口令已禁用（需运维显式配置用户）',
    },
    {
      name: '静态身份来源',
      level: mode === 'production' ? 'PASS' : 'WARN',
      detail: mode === 'production' ? 'X-Actor/X-Role 身份伪造已关闭' : `X-Actor/X-Role 静态身份可用（${mode} 模式；生产模式关闭）`,
    },
  ];
  return items;
}
