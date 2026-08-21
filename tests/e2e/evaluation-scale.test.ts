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
});
