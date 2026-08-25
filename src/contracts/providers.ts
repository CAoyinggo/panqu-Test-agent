import type { ContractCandidate, ContractProvider, ContractQuery } from './types.js';

function matches(candidate: ContractCandidate, query: ContractQuery): boolean {
  return (!query.id || candidate.id === query.id)
    && (!query.kind || candidate.kind === query.kind)
    && (!query.subject || candidate.subject === query.subject)
    && (!query.environment || !candidate.environment || candidate.environment === query.environment);
}

export class StaticContractProvider implements ContractProvider {
  readonly name: string = 'static';
  constructor(private readonly contracts: readonly ContractCandidate[]) {}
  async discover(query: ContractQuery): Promise<ContractCandidate[]> {
    return this.contracts.filter((candidate) => matches(candidate, query)).map((candidate) => ({ ...candidate }));
  }
}

export class FixtureContractProvider extends StaticContractProvider {
  override readonly name = 'fixture';
}

export class LegacyContractProvider extends StaticContractProvider {
  override readonly name = 'legacy';
}
