import { ContractRegistry } from './registry.js';
import { ContractResolver } from './resolver.js';
import { contractSource } from './source-priority.js';
import type { ContractCandidate } from './types.js';

const OBSERVED_AT = '2026-08-24T00:00:00.000Z';
const CREATED_AT = '2026-08-24T00:00:00.000Z';

/**
 * Phase 1 的事实样本。Wan3 当前值来自本阶段任务给出的已观测事实；Kling/H3/API
 * 尚未完成 Discovery，因此只建立 UNKNOWN identity，绝不补猜 method/path/model id。
 */
export const PHASE1_SEED_CONTRACTS: readonly ContractCandidate[] = [
  {
    id: 'model.wan3', kind: 'model', subject: 'wan3', version: 'v1', status: 'STALE',
    value: { modelId: 84, type: 6, task_type: 105, workflow_type: 'qntk' },
    sources: [
      contractSource('json', 'tasks/wan3-wensheng.json', { confidence: 0.4 }),
      contractSource('typescript', 'src/cases/wan3/wensheng.ts', { confidence: 0.4 }),
    ],
    createdAt: CREATED_AT,
    metadata: { historicalTestAsset: true, staleReason: 'Current observation differs from historical TaskDef' },
  },
  {
    id: 'model.wan3', kind: 'model', subject: 'wan3', version: 'v2', status: 'ACTIVE',
    value: { modelId: 84, type: 10, task_type: 'qnck_to_video', workflow_type: 'qnck' },
    sources: [contractSource('runtime', 'phase1-input:wan3-current-observation', {
      observedAt: OBSERVED_AT, confidence: 0.98,
      metadata: { evidence: 'user-supplied current runtime observation' },
    })],
    confidence: 0.98,
    createdAt: CREATED_AT,
    observedAt: OBSERVED_AT,
    validatedAt: OBSERVED_AT,
    environment: 'test',
    supersedes: 'model.wan3@v1',
  },
  {
    id: 'enum.wan3.workflow', kind: 'enum', subject: 'wan3.workflow', version: 'v1', status: 'STALE',
    value: ['qntk', 'swzsp'],
    sources: [contractSource('typescript', 'src/platform/test-assets/wan3-catalog.ts', { confidence: 0.4 })],
    createdAt: CREATED_AT,
    metadata: { historicalTestAsset: true },
  },
  {
    id: 'enum.wan3.workflow', kind: 'enum', subject: 'wan3.workflow', version: 'v2', status: 'ACTIVE',
    value: ['qnck'],
    sources: [contractSource('runtime', 'phase1-input:wan3-current-observation#workflow', {
      observedAt: OBSERVED_AT, confidence: 0.98,
    })],
    confidence: 0.98,
    createdAt: CREATED_AT,
    observedAt: OBSERVED_AT,
    validatedAt: OBSERVED_AT,
    environment: 'test',
    supersedes: 'enum.wan3.workflow@v1',
  },
  ...['kling', 'h3'].map((subject): ContractCandidate => ({
    id: `model.${subject}`, kind: 'model', subject, version: 'v1', status: 'UNKNOWN', value: {},
    sources: [], createdAt: CREATED_AT,
    metadata: { reason: 'Identity requested in Phase 1; Discovery has not supplied verifiable model facts' },
  })),
  ...['submit', 'getRecentTasks'].map((operation): ContractCandidate => ({
    id: `api.videohub.${operation}`, kind: 'api', subject: `videohub.${operation}`, version: 'v1',
    status: 'UNKNOWN', value: {}, sources: [], createdAt: CREATED_AT,
    metadata: { reason: 'Operation identity exists; method/path/schema require later Discovery' },
  })),
];

export function createPhase1ContractRegistry(): ContractRegistry {
  return new ContractRegistry(PHASE1_SEED_CONTRACTS);
}

export function createPhase1ContractResolver(): ContractResolver {
  return new ContractResolver(createPhase1ContractRegistry());
}
