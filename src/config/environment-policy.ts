// 生产环境安全策略（Phase 20.8）
// 三档环境：test（测试） / preonline（预发布） / production（生产）
// 安全约束（与 approval-policy 协同，Deterministic First）：
//   - production 不在默认配置中，必须显式 TESTFLOW_ALLOW_PRODUCTION=true 才可启用
//   - preonline / production 均禁止危险动作（真实扣费/支付/删数据/改库/真实并发压测）
//   - 其余动作交给分级审批策略判定（环境 × 严重度 × 操作）
// 目标：真实环境可关闭（默认），危险动作有守卫，生产环境有显式开关。

/** 环境档位 */
export type EnvironmentTier = 'test' | 'preonline' | 'production';

/** 危险动作清单（生产/预发布环境禁止） */
export const PRODUCTION_FORBIDDEN_ACTIONS = [
  'real-billing', // 真实扣费
  'payment',      // 真实支付
  'delete-data',  // 删除数据
  'db-modify',    // 直接修改数据库
  'run-production', // 生产环境直接执行
  'stress-test',  // 真实并发压测
] as const;

/** 守卫结果 */
export interface GuardResult {
  allowed: boolean;
  reason: string;
}

/** 环境名 → 档位（大小写不敏感，兼容 prod/production/staging/pre/preprod 别名） */
export function resolveEnvironmentTier(env: string | undefined): EnvironmentTier {
  const e = (env ?? '').trim().toLowerCase();
  if (e === 'prod' || e === 'production') return 'production';
  if (e === 'preonline' || e === 'pre' || e === 'staging' || e === 'preprod') return 'preonline';
  return 'test';
}

/** 是否为生产档位 */
export function isProductionTier(env: string | undefined): boolean {
  return resolveEnvironmentTier(env) === 'production';
}

/** production 显式开关：TESTFLOW_ALLOW_PRODUCTION=true */
export function productionAllowed(): boolean {
  return (process.env.TESTFLOW_ALLOW_PRODUCTION ?? 'false').toLowerCase() === 'true';
}

/**
 * 环境动作守卫：判定某环境是否允许执行某动作。
 * - test：放行（审批策略负责后续分级）
 * - preonline：危险动作拒绝；其余放行
 * - production：必须显式 TESTFLOW_ALLOW_PRODUCTION=true；危险动作永远拒绝
 */
export function guardProductionAction(env: string | undefined, action: string): GuardResult {
  const tier = resolveEnvironmentTier(env);
  const forbidden = PRODUCTION_FORBIDDEN_ACTIONS.includes(action as (typeof PRODUCTION_FORBIDDEN_ACTIONS)[number]);

  if (tier === 'test') {
    return { allowed: true, reason: '测试环境，无额外守卫（审批策略继续分级）' };
  }
  if (tier === 'preonline') {
    if (forbidden) return { allowed: false, reason: `preonline 环境禁止危险动作 ${action}（需人工审批）` };
    return { allowed: true, reason: 'preonline 环境非危险动作放行（审批策略继续分级）' };
  }
  // production
  if (!productionAllowed()) {
    return { allowed: false, reason: 'production 环境需显式 TESTFLOW_ALLOW_PRODUCTION=true 才可启用' };
  }
  if (forbidden) {
    return { allowed: false, reason: `production 环境禁止危险动作 ${action}` };
  }
  return { allowed: true, reason: 'production 环境已显式启用且非危险动作' };
}

/** 环境策略摘要（供 preflight / health / dashboard 使用） */
export function describeEnvironmentPolicy(): { tiers: EnvironmentTier[]; forbidden: string[]; productionEnabled: boolean } {
  return {
    tiers: ['test', 'preonline', 'production'],
    forbidden: [...PRODUCTION_FORBIDDEN_ACTIONS],
    productionEnabled: productionAllowed(),
  };
}
