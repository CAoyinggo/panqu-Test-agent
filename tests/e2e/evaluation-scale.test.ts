import { describe, expect, it } from 'vitest';
import { createProjectAIQualityRegistry } from '../../src/ai-quality/project-service.js';
import { EvaluationQueue, EvaluationWorkerPool } from '../../src/eval/scale/index.js';

describe('Phase 51 Evaluation scale E2E', () => {
  it('100 Evaluation jobs / 10 workers / 5 projects 使用真实 Benchmark 完成', async () => {
    const projects = ['p1', 'p2', 'p3', 'p4', 'p5'];
    const registry = createProjectAIQualityRegistry();
    const queue = new EvaluationQueue();
    for (let index = 0; index < 100; index++) {
      queue.enqueue({
        id: `e2e-eval-${index}`,
        projectId: projects[index % projects.length],
        domains: ['REQUIREMENT', 'RISK', 'RCA', 'RELEASE'],
      });
    }
    const pool = new EvaluationWorkerPool(queue, 10, (job) => registry.forProject(job.projectId).evaluationReport(job.domains));
    const run = await pool.drain();
    expect(run.metrics).toMatchObject({ submitted: 100, completed: 100, failed: 0, queued: 0, running: 0 });
    expect(run.results.size).toBe(100);
    expect(registry.projectIds()).toEqual(projects);
    expect([...run.results.values()].every((report) => report.critical.p0Miss === 0 && report.critical.falsePass === 0)).toBe(true);
  }, 30_000);

  it('生产规模验收：5 projects / 20 users / 500 real case refs / 100 jobs / 10 workers / 3 rounds', async () => {
    const projects = ['accept-p1', 'accept-p2', 'accept-p3', 'accept-p4', 'accept-p5'];
    const registry = createProjectAIQualityRegistry();
    const assignments: Array<{ projectId: string; userId: string; caseId: string; domain: import('../../src/eval/contract.js').EvaluationDomain }> = [];
    for (const projectId of projects) {
      const definitions = registry.forProject(projectId).benchmarkRegistry.list();
      for (let index = 0; index < 100; index++) {
        const definition = definitions[index % definitions.length];
        const evaluationCase = definition.cases[Math.floor(index / definitions.length) % definition.cases.length];
        assignments.push({ projectId, userId: `${projectId}-user-${(index % 4) + 1}`, caseId: evaluationCase.id, domain: definition.domain });
      }
    }
    expect(assignments).toHaveLength(500);
    expect(new Set(assignments.map((item) => item.userId)).size).toBe(20);
    expect(new Set(assignments.map((item) => item.domain)).size).toBe(8);

    for (let round = 1; round <= 3; round++) {
      const queue = new EvaluationQueue<{ assignments: typeof assignments; userIds: string[] }>();
      for (let index = 0; index < 100; index++) {
        const chunk = assignments.slice(index * 5, index * 5 + 5);
        queue.enqueue({
          id: `accept-r${round}-job-${index}`,
          projectId: chunk[0].projectId,
          domains: [...new Set(chunk.map((item) => item.domain))],
          payload: { assignments: chunk, userIds: [...new Set(chunk.map((item) => item.userId))] },
        });
      }
      const pool = new EvaluationWorkerPool(queue, 10, (job) => {
        const report = registry.forProject(job.projectId).evaluationReport(job.domains);
        return { caseRefs: job.payload!.assignments.map((item) => item.caseId), critical: report.critical };
      });
      const run = await pool.drain();
      expect(run.metrics).toMatchObject({ submitted: 100, completed: 100, failed: 0, queued: 0, running: 0 });
      expect([...run.results.values()].flatMap((result) => result.caseRefs)).toHaveLength(500);
      expect([...run.results.values()].every((result) => result.critical.p0Miss === 0 && result.critical.falsePass === 0 && result.critical.unsafeHealing === 0)).toBe(true);
    }
  }, 30_000);
});
