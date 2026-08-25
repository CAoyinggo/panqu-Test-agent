import type {
  Contract,
  ContractCandidate,
  ContractDependency,
  ContractFilter,
  ContractQuery,
  ContractResolution,
} from './types.js';
import { createContract } from './versioning.js';
import { resolveContractCandidates } from './resolver.js';

function matches(contract: Contract, query: ContractQuery): boolean {
  if (query.id && contract.id !== query.id) return false;
  if (query.kind && contract.kind !== query.kind) return false;
  if (query.subject && contract.subject !== query.subject) return false;
  if (query.environment && contract.environment && contract.environment !== query.environment) return false;
  return true;
}

function versionNumber(version: string): number | undefined {
  const match = /^v(\d+)$/.exec(version);
  return match ? Number(match[1]) : undefined;
}

export class ContractRegistry {
  private contracts: Contract[] = [];
  private readonly dependencyMap = new Map<string, ContractDependency[]>();

  constructor(initial: readonly ContractCandidate[] = []) {
    initial.forEach((contract) => this.register(contract));
  }

  get(id: string): Contract | undefined {
    const resolution = this.resolve({ id });
    return resolution.status === 'RESOLVED' ? resolution.contract : undefined;
  }

  candidates(query: ContractQuery): Contract[] {
    return this.contracts.filter((contract) => matches(contract, query)).map((contract) => ({
      ...contract, sources: contract.sources.map((source) => ({ ...source })),
    }));
  }

  resolve<T = unknown>(query: ContractQuery): ContractResolution<T> {
    return resolveContractCandidates<T>(query, this.candidates(query));
  }

  register<T>(input: ContractCandidate<T> | Contract<T>): Contract<T> {
    const contract = createContract(input);
    const equivalent = this.contracts.find((item) => item.id === contract.id
      && item.version === contract.version && item.fingerprint === contract.fingerprint
      && item.environment === contract.environment && item.status === contract.status);
    if (equivalent) {
      equivalent.sources = [...equivalent.sources, ...contract.sources]
        .filter((source, index, all) => all.findIndex((item) => item.type === source.type && item.ref === source.ref) === index);
      return equivalent as Contract<T>;
    }
    if (contract.status === 'ACTIVE') {
      const next = versionNumber(contract.version);
      if (next !== undefined) {
        this.contracts = this.contracts.map((existing) => {
          const previous = versionNumber(existing.version);
          return existing.id === contract.id && existing.status === 'ACTIVE'
            && existing.environment === contract.environment && previous !== undefined && previous < next
            ? { ...existing, status: 'STALE', metadata: { ...(existing.metadata ?? {}), supersededBy: `${contract.id}@${contract.version}` } }
            : existing;
        });
      }
    }
    this.contracts.push(contract);
    return contract;
  }

  update<T>(input: ContractCandidate<T> | Contract<T>): Contract<T> {
    const contract = createContract(input);
    this.contracts = this.contracts.filter((item) => !(item.id === contract.id
      && item.version === contract.version && item.environment === contract.environment));
    this.contracts.push(contract);
    return contract;
  }

  list(filter: ContractFilter = {}): Contract[] {
    const statuses = filter.status === undefined ? undefined : Array.isArray(filter.status) ? filter.status : [filter.status];
    return this.candidates(filter).filter((contract) => !statuses || statuses.includes(contract.status));
  }

  dependencies(contractId: string): ContractDependency[] {
    return (this.dependencyMap.get(contractId) ?? []).map((dependency) => ({ ...dependency }));
  }

  recordDependencies(ownerId: string, dependencies: readonly ContractDependency[]): void {
    this.dependencyMap.set(ownerId, dependencies.map((dependency) => ({ ...dependency })));
  }

  invalidate(contractId: string, reason: string): void {
    this.contracts = this.contracts.map((contract) => contract.id !== contractId || contract.status !== 'ACTIVE'
      ? contract
      : { ...contract, status: 'STALE', metadata: { ...(contract.metadata ?? {}), invalidatedReason: reason } });
  }

  clone(): ContractRegistry {
    const clone = new ContractRegistry(this.contracts);
    for (const [ownerId, dependencies] of this.dependencyMap) clone.recordDependencies(ownerId, dependencies);
    return clone;
  }
}
