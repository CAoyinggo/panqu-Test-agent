import type { Scenario, ScenarioResult } from '../acceptance/scenario-contract.js';
import type { ContractResolution } from '../contracts/types.js';
import type { ChangeDiscoveryResult, DiscoveredOperation, OperationGraph } from '../discovery/types.js';

export interface RequirementRef {
  id?: string;
  ref?: string;
  text?: string;
}

export interface DeveloperSelfTestInput {
  requirement?: RequirementRef;
  changedFiles?: string[];
  commit?: string;
  branch?: string;
  module?: string;
  environment: string;
  entrypoints?: string[];
  explicitScope?: string[];
  accountRef?: string;
  budget?: { maxCost?: number; currency?: string };
}

export type SelfTestExecutionMode = 'DRY_RUN' | 'SAFE' | 'LIVE';
export type FeatureRiskType = 'CRUD' | 'AUTHENTICATION' | 'AUTHORIZATION' | 'FILE_UPLOAD' | 'ASYNC_TASK'
  | 'BILLING' | 'STATE_MACHINE' | 'EXTERNAL_PROVIDER' | 'UI_STATE' | 'DATA_MUTATION';

export interface FeatureRisk {
  type: FeatureRiskType;
  level: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  reasons: string[];
}

export interface FeatureRiskSummary {
  risks: FeatureRisk[];
  overall: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  sideEffects: string[];
}

export interface SelfTestPack {
  featureId: string;
  scenarios: Scenario[];
  riskSummary: FeatureRiskSummary;
  estimatedCost?: number;
  requiredApprovals?: string[];
}

export interface ExecutionRisk {
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  estimatedCost?: number;
  sideEffects: string[];
  rollbackAvailable: boolean;
  requiresApproval: boolean;
}

export interface SelfTestSafetyDecision {
  allowed: boolean;
  mode: SelfTestExecutionMode;
  disposition: 'EXECUTE' | 'NOT_EXECUTED' | 'BLOCKED';
  risk: ExecutionRisk;
  reasons: string[];
  policyVerdict: 'ALLOW' | 'BLOCK' | 'APPROVAL_REQUIRED' | 'NOT_EVALUATED';
}

export type SelfTestFeatureResult = 'READY' | 'PARTIAL' | 'BLOCKED' | 'FAILED';
export type SelfTestUnknownType = 'UNKNOWN_CONTRACT' | 'UNKNOWN_API' | 'UNKNOWN_STATE' | 'UNKNOWN_SIDE_EFFECT'
  | 'UNKNOWN_BILLING' | 'UNKNOWN_AUTH' | 'UNKNOWN_UI_STATE' | 'UNKNOWN_ENVIRONMENT';

export interface SelfTestUnknown {
  type: SelfTestUnknownType;
  reason: string;
  requiredCapability?: string;
  relatedId?: string;
}

export interface SelfTestScenarioResult {
  scenario: Scenario;
  safety: SelfTestSafetyDecision;
  result: ScenarioResult;
}

export interface DeveloperSelfTestReport {
  schemaVersion: string;
  runId: string;
  feature: string;
  requirement?: Pick<RequirementRef, 'id' | 'ref'>;
  commit?: string;
  branch?: string;
  environment: string;
  mode: SelfTestExecutionMode;
  discovery: ChangeDiscoveryResult & { operations: DiscoveredOperation[] };
  graph: OperationGraph;
  contracts: ContractResolution[];
  risk: FeatureRiskSummary;
  pack: { generated: number; executable: number; blocked: number };
  scenarios: SelfTestScenarioResult[];
  evidence: { total: number; kinds: Record<string, number>; completePasses: number };
  result: SelfTestFeatureResult;
  blockedReasons: string[];
  unknowns: SelfTestUnknown[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}
