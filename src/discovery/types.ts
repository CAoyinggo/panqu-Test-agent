import type { ContractCandidate, ContractResolution, ContractSourceType } from '../contracts/types.js';

export type DiscoverySourceType = 'ROUTE' | 'CONTROLLER' | 'OPENAPI' | 'FRONTEND' | 'RUNTIME';

export interface DiscoverySource {
  type: DiscoverySourceType;
  ref: string;
  confidence: number;
  observedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface DiscoveredOperation {
  id: string;
  method: string;
  path: string;
  source: DiscoverySource[];
  requestSchema?: unknown;
  responseSchema?: unknown;
  auth?: unknown;
  sideEffects?: string[];
  confidence: number;
  controller?: string;
  safeProbe?: boolean;
  observed?: {
    status: number;
    headers: Record<string, string>;
    responseSchema?: unknown;
    errorSchema?: unknown;
    traceId?: string;
    timingMs: number;
  };
}

export type ChangedArtifactKind = 'API' | 'UI' | 'MODEL' | 'CONFIG' | 'DATABASE' | 'ROUTE' | 'ENUM' | 'OTHER';

export interface ChangedArtifact {
  file: string;
  kind: ChangedArtifactKind;
  symbols: string[];
  requestFields: string[];
  responseFields: string[];
  sideEffects: string[];
  operations: DiscoveredOperation[];
  contentInspected: boolean;
}

export interface ChangeDiscoveryResult {
  files: ChangedArtifact[];
  operations: DiscoveredOperation[];
  warnings: string[];
}

export interface DiscoveryContractCandidate {
  operation: DiscoveredOperation;
  candidate: ContractCandidate;
  sourceType: ContractSourceType;
}

export interface ResolvedDiscoveredOperation {
  operation: DiscoveredOperation;
  candidate: ContractCandidate;
  resolution: ContractResolution<Record<string, unknown>>;
}

export type OperationDependencyKind = 'INPUT' | 'OUTPUT' | 'RESOURCE' | 'AUTHENTICATION' | 'SIDE_EFFECT';

export interface OperationGraphEdge {
  from: string;
  to: string;
  kind: OperationDependencyKind;
  field?: string;
  reason: string;
}

export interface OperationGraph {
  nodes: DiscoveredOperation[];
  edges: OperationGraphEdge[];
  roots: string[];
  warnings: string[];
}
