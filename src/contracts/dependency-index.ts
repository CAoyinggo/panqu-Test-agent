import type {
  Contract,
  ContractDependency,
  ScenarioContractValidation,
} from './types.js';
import type { ContractResolverLike } from './resolver.js';

export function contractDependency(contract: Contract): ContractDependency {
  return {
    contractId: contract.id,
    version: contract.version,
    fingerprint: contract.fingerprint,
    sources: contract.sources.map((source) => ({ ...source })),
    observedAt: contract.observedAt,
    required: true,
  };
}

export function validateDependencies(
  dependencies: readonly ContractDependency[],
  resolver: ContractResolverLike,
): ScenarioContractValidation {
  if (!dependencies.length) return {
    status: 'BLOCKED', dependencies: [], reasons: ['MISSING_CONTRACT_DEPENDENCY：Scenario/Asset 未声明任何 Contract 依赖'],
  };
  const checked = dependencies.map((dependency) => {
    const resolution = resolver.resolve({ id: dependency.contractId });
    let reason: string | undefined;
    if (resolution.status !== 'RESOLVED') reason = `${dependency.contractId}=${resolution.status}`;
    else if (resolution.contract?.version !== dependency.version) reason = `${dependency.contractId} version ${dependency.version} → ${resolution.contract?.version}`;
    else if (dependency.fingerprint && resolution.contract.fingerprint !== dependency.fingerprint) reason = `${dependency.contractId} fingerprint changed`;
    return { dependency, resolution, reason };
  });
  const reasons = checked.flatMap((item) => item.reason ? [item.reason] : []);
  if (checked.some((item) => item.resolution.status === 'STALE')) return { status: 'STALE', dependencies: checked, reasons };
  if (checked.some((item) => item.resolution.status !== 'RESOLVED')) return { status: 'BLOCKED', dependencies: checked, reasons };
  if (checked.some((item) => item.reason)) return { status: 'CONTRACT_DRIFT', dependencies: checked, reasons };
  return { status: 'VALID', dependencies: checked, reasons: [] };
}
