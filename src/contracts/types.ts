export const CONTRACT_KINDS = [
  'api', 'model', 'enum', 'ui', 'billing', 'state-machine', 'permission', 'resource',
] as const;

export type ContractKind = typeof CONTRACT_KINDS[number];
export type ContractStatus = 'ACTIVE' | 'STALE' | 'CONFLICT' | 'UNKNOWN' | 'EXPIRED';

export const CONTRACT_SOURCE_TYPES = [
  'requirement', 'markdown', 'json', 'typescript', 'openapi', 'backend', 'frontend',
  'runtime', 'database', 'test-fixture',
] as const;

export type ContractSourceType = typeof CONTRACT_SOURCE_TYPES[number];

export interface ContractSource {
  type: ContractSourceType;
  /** 可定位的文件、URL、operation 或 observation 标识。 */
  ref: string;
  version?: string;
  observedAt?: string;
  confidence?: number;
  priority: number;
  metadata?: Record<string, unknown>;
}

export interface Contract<T = unknown> {
  id: string;
  kind: ContractKind;
  subject: string;
  version: string;
  status: ContractStatus;
  value: T;
  sources: ContractSource[];
  confidence?: number;
  createdAt: string;
  observedAt?: string;
  validatedAt?: string;
  environment?: string;
  supersedes?: string;
  fingerprint: string;
  metadata?: Record<string, unknown>;
}

export interface ContractQuery {
  id?: string;
  kind?: ContractKind;
  subject?: string;
  version?: string;
  environment?: string;
}

export type ContractFilter = ContractQuery & { status?: ContractStatus | ContractStatus[] };
export type ContractResolutionStatus = 'RESOLVED' | 'CONFLICT' | 'UNKNOWN' | 'STALE' | 'INVALID';

export interface ContractConflictValue {
  value: unknown;
  fingerprint: string;
  contractIds: string[];
  versions: string[];
  sources: ContractSource[];
}

export interface ContractConflict {
  field: string;
  values: ContractConflictValue[];
  status: 'CONFLICT';
  reason: string;
}

export interface ContractResolution<T = unknown> {
  status: ContractResolutionStatus;
  query: ContractQuery;
  contract?: Contract<T>;
  candidates: Contract[];
  conflicts: ContractConflict[];
  sources: ContractSource[];
  reason?: string;
}

export interface ContractDependency {
  contractId: string;
  version: string;
  fingerprint?: string;
  sources?: ContractSource[];
  observedAt?: string;
  required?: boolean;
}

export type ScenarioContractStatus = 'VALID' | 'STALE' | 'CONTRACT_DRIFT' | 'BLOCKED';

export interface ScenarioContractValidation {
  status: ScenarioContractStatus;
  dependencies: Array<{
    dependency: ContractDependency;
    resolution: ContractResolution;
    reason?: string;
  }>;
  reasons: string[];
}

export type DriftStatus = 'NO_DRIFT' | 'DRIFT' | 'CONFLICT' | 'UNKNOWN';
export type DriftClassification =
  | 'ADDED'
  | 'REMOVED'
  | 'CHANGED'
  | 'TYPE_CHANGED'
  | 'ENUM_CHANGED'
  | 'SCHEMA_CHANGED'
  | 'BEHAVIOR_CHANGED';
export type DriftSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface DriftField {
  path: string;
  classification: DriftClassification;
  before?: unknown;
  after?: unknown;
  severity: DriftSeverity;
  impact: string;
}

export interface DriftResult {
  status: DriftStatus;
  contractId: string;
  expectedVersion?: string;
  observedVersion?: string;
  changedFields: DriftField[];
  severity: DriftSeverity;
  expectedFingerprint?: string;
  observedFingerprint?: string;
  reason?: string;
}

export interface ContractCandidate<T = unknown> extends Omit<Contract<T>, 'fingerprint'> {
  fingerprint?: string;
}

export interface ContractProvider {
  name: string;
  discover(query: ContractQuery): Promise<ContractCandidate[]>;
}

export type LegacyAssetStatus = 'ACTIVE' | 'LEGACY' | 'STALE' | 'CONFLICT' | 'UNKNOWN';
export type LegacyAssetType = 'TaskDef' | 'TypeScript Case' | 'Catalog' | 'Template' | 'Hardcoded Generator';

export interface LegacyAssetRecord {
  asset: string;
  type: LegacyAssetType;
  status: LegacyAssetStatus;
  contracts: ContractDependency[];
  reasons: string[];
  metadata?: Record<string, unknown>;
}

export interface LegacyMigrationIndexData {
  schemaVersion: string;
  generatedAt: string;
  assets: LegacyAssetRecord[];
}
