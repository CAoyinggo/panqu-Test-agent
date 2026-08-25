import type { KnowledgeEntry } from '../knowledge/knowledge-schema.js';
import type { Contract } from './types.js';
import type { ContractRegistry } from './registry.js';
import { contractSource } from './source-priority.js';

/**
 * Knowledge != Contract。仅 environment-fact 可显式提升为 resource Contract；风险洞察、
 * failure pattern 等仍留在 KnowledgeStore，不允许成为执行事实。
 */
export function registerKnowledgeFact(entry: KnowledgeEntry, registry: ContractRegistry): Contract | undefined {
  if (entry.type !== 'environment-fact') return undefined;
  return registry.register({
    id: `resource.knowledge.${entry.id}`,
    kind: 'resource',
    subject: entry.feature,
    version: `v${Math.max(1, entry.usageCount + 1)}`,
    status: entry.status,
    value: { title: entry.title, content: entry.content, stats: entry.stats },
    sources: [contractSource('test-fixture', `knowledge:${entry.id}`, { confidence: entry.confidence })],
    confidence: entry.confidence,
    createdAt: entry.createdAt,
    observedAt: entry.lastUsedAt,
    validatedAt: entry.updatedAt,
    metadata: { knowledgeStatus: entry.status, knowledgeType: entry.type },
  });
}
