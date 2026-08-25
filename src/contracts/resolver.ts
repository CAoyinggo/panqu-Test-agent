import { detectContractConflicts } from './conflict-detector.js';
import { highestSourcePriority, sortSources } from './source-priority.js';
import type {
  Contract,
  ContractProvider,
  ContractQuery,
  ContractResolution,
} from './types.js';
import type { ContractRegistry } from './registry.js';

function preferred(contracts: readonly Contract[]): Contract {
  return [...contracts].sort((left, right) => {
    const priority = highestSourcePriority(right.sources) - highestSourcePriority(left.sources);
    if (priority) return priority;
    return right.version.localeCompare(left.version, undefined, { numeric: true });
  })[0];
}

function mergeEquivalent(contracts: readonly Contract[]): Contract {
  const winner = preferred(contracts);
  const sources = sortSources(contracts.flatMap((contract) => contract.sources));
  return { ...winner, sources };
}

export function resolveContractCandidates<T = unknown>(
  query: ContractQuery,
  candidates: readonly Contract[],
): ContractResolution<T> {
  const sources = sortSources(candidates.flatMap((candidate) => candidate.sources));
  if (!candidates.length) return {
    status: 'UNKNOWN', query, candidates: [], conflicts: [], sources: [], reason: '没有匹配的 Contract',
  };
  const scoped = query.version ? candidates.filter((candidate) => candidate.version === query.version) : [...candidates];
  if (!scoped.length) return {
    status: 'STALE', query, candidates: [...candidates], conflicts: [], sources,
    reason: `请求版本 ${query.version} 不存在或已被替代`,
  };
  if (scoped.some((candidate) => candidate.status === 'CONFLICT')) {
    return {
      status: 'CONFLICT', query, candidates: [...scoped], conflicts: detectContractConflicts(scoped), sources,
      reason: 'Contract 已被标记为 CONFLICT',
    };
  }
  const active = scoped.filter((candidate) => candidate.status === 'ACTIVE');
  if (active.length) {
    const currentVersion = query.version ?? [...active].sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0].version;
    const current = active.filter((candidate) => candidate.version === currentVersion);
    const conflicts = detectContractConflicts(current);
    if (conflicts.length) return {
      status: 'CONFLICT', query, candidates: [...scoped], conflicts, sources,
      reason: '当前有效版本存在不同事实，禁止按优先级猜测',
    };
    return {
      status: 'RESOLVED', query, contract: mergeEquivalent(current) as Contract<T>,
      candidates: [...scoped], conflicts: [], sources,
    };
  }
  const stale = scoped.filter((candidate) => candidate.status === 'STALE' || candidate.status === 'EXPIRED');
  if (stale.length) return {
    status: 'STALE', query, contract: preferred(stale) as Contract<T>, candidates: [...scoped], conflicts: [], sources,
    reason: '只存在 STALE/EXPIRED Contract，无法证明当前仍有效',
  };
  if (scoped.every((candidate) => candidate.status === 'UNKNOWN')) return {
    status: 'UNKNOWN', query, candidates: [...scoped], conflicts: [], sources,
    reason: 'Contract 已建立占位，但尚无足够事实',
  };
  return { status: 'INVALID', query, candidates: [...scoped], conflicts: [], sources, reason: 'Contract 状态组合无效' };
}

export interface ContractResolverLike {
  resolve<T = unknown>(query: ContractQuery): ContractResolution<T>;
}

export class ContractResolver implements ContractResolverLike {
  constructor(
    readonly registry: ContractRegistry,
    readonly providers: readonly ContractProvider[] = [],
  ) {}

  resolve<T = unknown>(query: ContractQuery): ContractResolution<T> {
    return resolveContractCandidates<T>(query, this.registry.candidates(query));
  }

  /** Phase 1 只定义/编排 Provider；不在 resolve 中隐式进行网络 Discovery。 */
  async discover(query: ContractQuery): Promise<ContractResolution> {
    for (const provider of this.providers) {
      const candidates = await provider.discover(query);
      for (const candidate of candidates) this.registry.register(candidate);
    }
    return this.resolve(query);
  }
}
