import type { ContractCandidate, ContractSourceType } from '../../contracts/types.js';
import { contractSource } from '../../contracts/source-priority.js';
import { nextContractVersion } from '../../contracts/versioning.js';
import type { ContractResolver } from '../../contracts/resolver.js';
import { mergeOperations, type OpenApiDocument, discoverOpenApi } from './source-scanners.js';
import type { DiscoveryContractCandidate, DiscoveredOperation, ResolvedDiscoveredOperation } from '../types.js';

function sourceType(operation: DiscoveredOperation): ContractSourceType {
  const types = new Set(operation.source.map((source) => source.type));
  if (types.has('RUNTIME')) return 'runtime';
  if (types.has('ROUTE') || types.has('CONTROLLER')) return 'backend';
  if (types.has('OPENAPI')) return 'openapi';
  return 'frontend';
}

function canBeActive(operation: DiscoveredOperation, type: ContractSourceType): boolean {
  if (!operation.method || !operation.path) return false;
  return type === 'runtime' || type === 'backend' || type === 'openapi';
}

export function operationToContractCandidate(
  operation: DiscoveredOperation,
  resolver: ContractResolver,
  environment: string,
): DiscoveryContractCandidate {
  const type = sourceType(operation);
  const versions = resolver.registry.candidates({ id: operation.id, environment }).map((item) => item.version);
  const version = versions.length ? nextContractVersion(versions) : 'v1';
  const now = new Date().toISOString();
  const candidate: ContractCandidate = {
    id: operation.id,
    kind: 'api',
    subject: `${operation.method} ${operation.path}`,
    version,
    status: canBeActive(operation, type) ? 'ACTIVE' : 'UNKNOWN',
    value: {
      method: operation.method,
      path: operation.path,
      requestSchema: operation.requestSchema,
      responseSchema: operation.responseSchema,
      auth: operation.auth,
      sideEffects: operation.sideEffects ?? [],
      safeProbe: operation.safeProbe === true,
      observedStatus: operation.observed?.status,
    },
    sources: operation.source.map((item) => contractSource(type, item.ref, {
      confidence: item.confidence, observedAt: item.observedAt, metadata: { discoverySource: item.type, ...(item.metadata ?? {}) },
    })),
    confidence: operation.confidence,
    createdAt: now,
    observedAt: operation.observed ? now : undefined,
    validatedAt: operation.observed ? now : undefined,
    environment,
    metadata: { discoveryCandidate: true },
  };
  return { operation, candidate, sourceType: type };
}

/** Explicit registration step keeps Discovery separate from Contract authority. */
export function resolveDiscoveredOperations(
  operations: readonly DiscoveredOperation[],
  resolver: ContractResolver,
  environment: string,
): ResolvedDiscoveredOperation[] {
  return mergeOperations(operations).map((operation) => {
    const item = operationToContractCandidate(operation, resolver, environment);
    resolver.registry.register(item.candidate);
    return {
      operation,
      candidate: item.candidate,
      resolution: resolver.resolve<Record<string, unknown>>({ id: item.candidate.id, environment }),
    };
  });
}

export function discoverApiFromOpenApi(document: OpenApiDocument, ref: string): DiscoveredOperation[] {
  return discoverOpenApi(document, ref);
}
