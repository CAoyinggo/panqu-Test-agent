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
