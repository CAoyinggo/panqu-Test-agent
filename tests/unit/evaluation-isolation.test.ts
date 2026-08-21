// Phase 51.1：Multi-Project AI Evaluation 强隔离
import { describe, expect, it } from 'vitest';
import { ProjectAIQualityRegistry } from '../../src/ai-quality/project-service.js';
import { createAIQualityService } from '../../src/ai-quality/service.js';

describe('ProjectAIQualityRegistry（51.1）', () => {
  it('Benchmark / GroundTruth / Evaluation / Knowledge / Audit 按项目独立', () => {
    const registry = new ProjectAIQualityRegistry();
    const projectA = registry.forProject('project-a');
    const projectB = registry.forProject('project-b');

    const candidate = projectA.benchmarkCandidates.add({
      domain: 'RISK',
      caseId: 'risk-001',
      expected: { expectedCategories: ['concurrency', 'dependency'], criticalCategories: ['concurrency'] },
      actual: { expectedCategories: ['concurrency'], criticalCategories: ['concurrency'] },
      errors: ['遗漏 dependency'],
      source: 'EVALUATION',
      feedbackId: 'feedback-a',
    });
    projectA.benchmarkCandidates.approve(candidate.id, 'human-a');
    const merge = projectA.mergeBenchmarkCandidates('human-a', { candidateIds: [candidate.id] });
    expect(merge.merged).toBe(1);

    projectA.runContinuousEval({ schedule: 'NIGHTLY', createdBy: 'human-a' });
    const knowledge = projectA.knowledge.createCandidate({ category: 'RISK', content: 'project-a only', source: 'REAL_RUN', confidence: 1 });
    projectA.knowledge.approveCandidate(knowledge.id, 'human-a');

    expect(projectA.benchmarkRegistry.latest('RISK')?.version).toBe('v2');
    expect(projectB.benchmarkRegistry.latest('RISK')?.version).toBe('v1');
    expect(projectA.groundTruthRegistry.has(candidate.id)).toBe(false); // GT 使用落地 case id，不使用候选 id
    expect(projectA.groundTruthRegistry.size).toBe(projectB.groundTruthRegistry.size + 1);
    expect(projectA.continuousEval.size()).toBe(1);
    expect(projectB.continuousEval.size()).toBe(0);
    expect(projectA.knowledge.listItems()).toHaveLength(1);
    expect(projectB.knowledge.listItems()).toHaveLength(0);
    expect(projectA.audit.list().length).toBeGreaterThan(0);
    expect(projectB.audit.list()).toHaveLength(0);
  });

  it('项目快照往返保持分区；新项目不会复用现有服务引用', () => {
    const registry = new ProjectAIQualityRegistry();
    registry.forProject('project-a').ingest({
      domain: 'RCA', prediction: 'NETWORK', actual: 'MODEL', feedbackType: 'INCORRECT', source: 'HUMAN', channel: 'RCA_VERIFICATION',
    });
    registry.forProject('project-b');

    const restored = ProjectAIQualityRegistry.restore(registry.snapshot());
    expect(restored.projectIds()).toEqual(['project-a', 'project-b']);
    expect(restored.forProject('project-a').feedback.size()).toBe(1);
    expect(restored.forProject('project-b').feedback.size()).toBe(0);
    expect(restored.forProject('project-a')).not.toBe(restored.forProject('project-b'));
  });

  it('非法项目 ID 与覆盖已有分区被拒绝', () => {
    const registry = new ProjectAIQualityRegistry();
    registry.forProject('project-a');
    expect(() => registry.forProject('../escape')).toThrow('projectId 非法');
    expect(() => registry.attach('project-a', createAIQualityService())).toThrow('禁止覆盖');
  });
});
