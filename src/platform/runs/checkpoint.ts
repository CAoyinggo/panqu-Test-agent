// Run Checkpoint（Phase 24.3）：Pause / Resume 的恢复依据
// Resume 必须从 checkpoint 恢复，不允许重新生成整个 Test Plan。

import type { Entity, Repository } from '../storage/repository.js';

/** 检查点（任务书 24.3） */
export interface RunCheckpoint extends Entity {
  runId: string;
  stage: string;
  completedCases: string[];
  remainingCases: string[];
  decisionState: unknown;
  knowledgeState?: unknown;
  budgetState: unknown;
  traceId: string;
  createdAt: string;
}

/** 创建检查点输入 */
export interface CheckpointInput {
  runId: string;
  stage: string;
  completedCases: string[];
  remainingCases: string[];
  decisionState: unknown;
  knowledgeState?: unknown;
  budgetState: unknown;
  traceId: string;
}

export class CheckpointStore {
  constructor(private readonly repo: Repository<RunCheckpoint>) {}

  async save(input: CheckpointInput): Promise<RunCheckpoint> {
    const existing = await this.findByRun(input.runId);
    if (existing) {
      return this.repo.update(existing.id, { ...input, createdAt: new Date().toISOString() });
    }
    return this.repo.create({
      id: `ckpt-${input.runId}`,
      ...input,
      createdAt: new Date().toISOString(),
    });
  }

  async findByRun(runId: string): Promise<RunCheckpoint | null> {
    const rows = await this.repo.query({ runId });
    return rows[0] ?? null;
  }

  /** 恢复：completed 与 remaining 必须一致，禁止重新生成 Test Plan */
  async load(runId: string): Promise<RunCheckpoint | null> {
    return this.findByRun(runId);
  }

  async delete(runId: string): Promise<void> {
    const c = await this.findByRun(runId);
    if (c) await this.repo.delete(c.id);
  }

  async clear(): Promise<void> {
    await this.repo.clear();
  }
}
