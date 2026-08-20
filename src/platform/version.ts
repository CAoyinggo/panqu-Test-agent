// 平台版本信息（Phase 26.1）：构建溯源
// version / commit / buildTime / environment 由构建或部署时经环境变量注入，
// 缺省取代码常量，保证任何环境下都能回答"当前运行的是哪个版本"。
// 环境变量命名（部署侧写入）：
//   PLATFORM_VERSION   版本号（默认 PLATFORM_VERSION 常量）
//   PLATFORM_COMMIT    Git commit 短哈希（CI 构建时注入）
//   PLATFORM_BUILD_TIME ISO 时间（CI 构建时注入）
//   PLATFORM_ENVIRONMENT 运行环境（development/test/staging/production；默认 development）

export const PLATFORM_VERSION = '4.21.0';

export interface BuildInfo {
  version: string;
  commit: string;
  buildTime: string;
  environment: string;
}

/** 读取构建/部署注入的版本信息（未注入时返回代码常量默认值） */
export function buildVersionInfo(overrides?: Partial<BuildInfo>): BuildInfo {
  const env = process.env;
  return {
    version: overrides?.version ?? env.PLATFORM_VERSION ?? PLATFORM_VERSION,
    commit: overrides?.commit ?? env.PLATFORM_COMMIT ?? '',
    buildTime: overrides?.buildTime ?? env.PLATFORM_BUILD_TIME ?? '',
    environment: overrides?.environment ?? (env.PLATFORM_ENVIRONMENT ?? 'development').toLowerCase(),
  };
}

/** 版本兼容性：主版本相同、次版本差 ≤ 1 视为兼容（用于回滚演练 API 兼容断言） */
export function isVersionCompatible(a: string, b: string, maxMinorGap = 1): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  if (pa.length < 2 || pb.length < 2) return false;
  if (pa[0] !== pb[0]) return false;
  return Math.abs(pa[1] - pb[1]) <= maxMinorGap;
}
