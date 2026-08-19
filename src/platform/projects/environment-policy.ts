// 环境安全策略单一策略源（Phase 24.1）
// 禁止把环境策略写死在 Agent 中：所有平台组件经 resolveEnvironmentDecision 解析。
// 策略：dev/test 允许 risky（dangerous 需审批）；staging/preprod/production 拒绝 dangerous（risky 需审批）。

import type { Environment, EnvironmentType } from './project-schema.js';

/** 工具动作分级（与现有 ToolPermission 对齐：read/safe/risky/dangerous） */
export type ToolActionLevel = 'read' | 'safe' | 'risky' | 'dangerous';

/** 策略决策 */
export type PolicyDecision = 'allow' | 'approval' | 'deny';

/** 单一策略源（任务书 24.1 环境安全策略） */
export const ENVIRONMENT_ACTION_POLICY: Record<
  EnvironmentType,
  Record<ToolActionLevel, PolicyDecision>
> = {
  dev: { read: 'allow', safe: 'allow', risky: 'allow', dangerous: 'approval' },
  test: { read: 'allow', safe: 'allow', risky: 'allow', dangerous: 'approval' },
  staging: { read: 'allow', safe: 'allow', risky: 'approval', dangerous: 'deny' },
  preprod: { read: 'allow', safe: 'allow', risky: 'approval', dangerous: 'deny' },
  production: { read: 'allow', safe: 'allow', risky: 'approval', dangerous: 'deny' },
};

/** 覆盖型安全策略（Environment.safetyPolicy 结构） */
export interface EnvironmentSafetyPolicy {
  actions?: Partial<Record<ToolActionLevel, PolicyDecision>>;
}

/** 生产类环境（dangerous 永远 deny 的档位） */
export function isProductionLike(type: EnvironmentType): boolean {
  return type === 'staging' || type === 'preprod' || type === 'production';
}

/** 解析环境对指定动作的决策：优先 Environment.safetyPolicy 覆盖，其次单一策略源 */
export function resolveEnvironmentDecision(
  env: Pick<Environment, 'type' | 'safetyPolicy'>,
  action: ToolActionLevel,
): PolicyDecision {
  const custom = (env.safetyPolicy as EnvironmentSafetyPolicy | undefined)?.actions?.[action];
  if (custom) return custom;
  return ENVIRONMENT_ACTION_POLICY[env.type][action];
}

/** 决策中文描述（报告/日志用） */
export function describeDecision(d: PolicyDecision): string {
  switch (d) {
    case 'allow':
      return '允许';
    case 'approval':
      return '需审批';
    case 'deny':
      return '拒绝';
  }
}

// ── 跨层一致性契约（DEBT-01）────────────────────────────────────────────
// 本文件为「平台层动作分级」唯一策略源；src/config/environment-policy.ts 为
// 「agent 层执行启用守卫」，src/platform/security/index.ts 为「平台运行模式加固」。
// 三者职责不同（分级 / 启用 / 加固），经下述映射建立互操作契约，供跨层一致性
// 校验（tests/unit/environment-policy-coherence.test.ts）防漂移。
// 详见 docs/environment-policy-boundaries.md。

/** agent 层环境档位（跨层互操作契约，与 config 层 EnvironmentTier 语义一致） */
export type GuardTier = 'test' | 'preonline' | 'production';

/** 平台运行模式（跨层互操作契约，与 security 层 PlatformMode 语义一致） */
export type GuardMode = 'development' | 'test' | 'staging' | 'production';

/**
 * 平台环境类型 → agent 层守卫档位（跨层一致性契约）。
 * dev/test → test（无守卫，交由审批分级）；staging/preprod → preonline（危险动作拒绝）；
 * production → production（需显式 TESTFLOW_ALLOW_PRODUCTION 启用）。
 */
export function environmentTypeToTier(type: EnvironmentType): GuardTier {
  switch (type) {
    case 'dev':
    case 'test':
      return 'test';
    case 'staging':
    case 'preprod':
      return 'preonline';
    case 'production':
      return 'production';
  }
}

/**
 * 平台环境类型 → 平台运行模式（跨层一致性契约）。
 * dev → development；test → test；staging/preprod → staging（生产安全约束，演练环境）；
 * production → production（生产安全约束最强）。
 */
export function environmentTypeToMode(type: EnvironmentType): GuardMode {
  switch (type) {
    case 'dev':
      return 'development';
    case 'test':
      return 'test';
    case 'staging':
    case 'preprod':
      return 'staging';
    case 'production':
      return 'production';
  }
}

/**
 * 生产类环境档位（dangerous 永远 deny 的环境在 agent 守卫中的档位集合）。
 * 供跨层校验：平台 isProductionLike(type) 为 true 的类型，其 agent 守卫档位必须
 * 落在该集合（preonline / production 均拒绝危险动作）。
 */
export const PRODUCTION_LIKE_GUARD_TIERS: readonly GuardTier[] = ['preonline', 'production'];
