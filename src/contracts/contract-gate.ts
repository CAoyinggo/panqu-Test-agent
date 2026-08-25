import type { Requirement } from '../agents/requirement/requirement-schema.js';
import type { ApiSpec } from '../acceptance/requirement-ir.js';
import { contractDependency, validateDependencies } from './dependency-index.js';
import type { ContractResolver } from './resolver.js';
import { contractSource } from './source-priority.js';
import type { ContractDependency, ContractResolution, ScenarioContractValidation } from './types.js';

export interface ContractPreflight {
  validation: ScenarioContractValidation;
  resolutions: ContractResolution[];
  dependencies: ContractDependency[];
}

function safeId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

/** 将 Requirement 表达的业务要求注册为 requirement-source Contract，而不是系统实现事实。 */
export function registerRequirementContract(
  requirement: Requirement,
  resolver: ContractResolver,
  ref = 'agent:requirement',
): ContractDependency {
  const contract = resolver.registry.register({
    id: `resource.requirement.${safeId(requirement.feature)}`,
    kind: 'resource',
    subject: `requirement.${requirement.feature}`,
    version: requirement.version ?? 'v1',
    status: requirement.feature === 'unknown' ? 'UNKNOWN' : 'ACTIVE',
    value: {
      feature: requirement.feature,
      capabilities: requirement.capabilities,
      inputs: requirement.inputs,
      requirements: requirement.requirements,
      businessRules: requirement.businessRules,
      constraints: requirement.constraints ?? [],
    },
    sources: [contractSource('requirement', ref, { confidence: requirement.confidence })],
    confidence: requirement.confidence,
    createdAt: new Date().toISOString(),
  });
  return contractDependency(contract);
}

export function acceptanceApiContractId(api: Pick<ApiSpec, 'id'>): string {
  return `api.${safeId(api.id)}`;
}

/** Requirement ApiSpec 仍是 requirement-source Candidate；它不冒充 Runtime/Backend truth。 */
export function registerAcceptanceApiContracts(
  apis: readonly ApiSpec[],
  resolver: ContractResolver,
  ref: string,
): Map<string, ContractDependency> {
  return new Map(apis.map((api) => {
    const contract = resolver.registry.register({
      id: acceptanceApiContractId(api),
      kind: 'api',
      subject: api.operationKey,
      version: 'v1',
      status: 'ACTIVE',
      value: {
        method: api.method,
        path: api.path,
        authPolicy: api.authPolicy,
        headers: api.headers,
        query: api.query,
        pathParams: api.pathParams,
        body: api.body,
        responses: api.responses,
      },
      sources: [contractSource('requirement', `${ref}#${api.operationKey}`, {
        metadata: api.source ? { source: api.source } : undefined,
      })],
      createdAt: new Date().toISOString(),
    });
    return [api.id, contractDependency(contract)];
  }));
}

export function preflightContracts(
  resolver: ContractResolver,
  dependencies: readonly ContractDependency[],
): ContractPreflight {
  const validation = validateDependencies(dependencies, resolver);
  return {
    validation,
    dependencies: [...dependencies],
    resolutions: dependencies.map((dependency) => resolver.resolve({ id: dependency.contractId })),
  };
}
