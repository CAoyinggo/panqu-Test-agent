import { describe, expect, it } from 'vitest';
import { createProjectAIQualityRegistry } from '../../src/ai-quality/project-service.js';
import { runConcurrentEvaluations } from '../../src/eval/scale/index.js';

describe('Phase 51 Evaluation scale integration', () => {
  it('三个项目各运行 100 个并发评测且保持项目分区', async () => {
    const registry = createProjectAIQualityRegistry();
    const projects = ['project-a', 'project-b', 'project-c'];
    const jobs = Array.from({ length: 100 }, (_, index) => ({
      id: `multi-${index}`,
      projectId: projects[index % projects.length],
      domains: ['REQUIREMENT', 'RISK', 'RCA', 'RELEASE'] as const,
    }));
    const run = await runConcurrentEvaluations(jobs.map((job) => ({ ...job, domains: [...job.domains] })), {
      concurrency: 100,
      execute: (job) => registry.forProject(job.projectId).evaluationReport(job.domains),
    });

    expect(run.metrics).toMatchObject({ submitted: 100, completed: 100, failed: 0, lost: 0 });
    expect(registry.projectIds()).toEqual(projects);
    for (const project of projects) {
      expect(run.results.filter((result) => result.projectId === project).length).toBeGreaterThan(0);
    }
  }, 30_000);
});
