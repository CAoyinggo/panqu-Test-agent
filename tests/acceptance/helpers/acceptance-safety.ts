import type {
  AcceptanceExecutionSafetyPolicy,
  AcceptanceOperationEffect,
} from '../../../src/acceptance/acceptance-safety-policy.js';

function defaultEffect(operationKey: string): AcceptanceOperationEffect {
  const method = operationKey.split(' ', 1)[0]?.toUpperCase();
  if (method === 'GET' || method === 'HEAD') return 'READ';
  if (method === 'DELETE') return 'DELETE';
  return 'WRITE';
}

/** 仅供隔离的 fake/local Acceptance 测试显式声明执行边界。 */
export function localAcceptanceSafetyPolicy(
  operationKeys: string[],
  options: { allowNoCleanup?: boolean; effects?: Partial<Record<string, AcceptanceOperationEffect>> } = {},
): AcceptanceExecutionSafetyPolicy {
  return {
    environment: 'local',
    operationPolicies: Object.fromEntries(operationKeys.map((operationKey) => [operationKey, {
      effect: options.effects?.[operationKey] ?? defaultEffect(operationKey),
      reason: 'isolated fake/local acceptance test',
    }])),
    allowNoCleanup: options.allowNoCleanup ?? true,
  };
}
