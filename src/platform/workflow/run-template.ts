// Run Template（Phase 39.3）：QA 最常见需求 "这套测试我上次跑过，再跑一次"
// Save as Template → Run Template 直接生成新 Run。
// 只复制 Configuration（环境 / Suite / 模式 / 预算 / 门禁），
// 禁止复制旧 Run 的 Execution Result / RCA / Release Decision。

import type { Entity, Repository } from '../storage/repository.js';
import { generateEntityId } from '../storage/repository.js';
import type { TestPlanMode } from './test-plan.js';

export interface RunTemplate extends Entity {
  id: string;
  projectId: string;
  name: string;
  description?: string;
  environment: string;
  suiteIds: string[];
  mode: TestPlanMode;
  budget?: number;
  releaseGate?: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** 统计复用次数（真实计数） */
  runCount: number;
}

export interface CreateTemplateInput {
  projectId: string;
  name: string;
  description?: string;
  environment: string;
  suiteIds: string[];
  mode: TestPlanMode;
  budget?: number;
  releaseGate?: boolean;
  createdBy: string;
  now?: () => string;
}

/** 从已有 Run 提取可复用配置（禁止携带结果/RCA/门禁决策） */
export interface RunConfigSource {
  projectId: string;
  environment: string;
  suiteIds: string[];
  mode: TestPlanMode;
  budget?: number;
  releaseGate?: boolean;
}

export class RunTemplateService {
  constructor(private readonly repo: Repository<RunTemplate>) {}

  async create(input: CreateTemplateInput): Promise<RunTemplate> {
    const now = input.now ? input.now() : new Date().toISOString();
    const template: RunTemplate = {
      id: generateEntityId('template'),
      projectId: input.projectId,
      name: input.name,
      description: input.description,
      environment: input.environment,
      suiteIds: [...input.suiteIds],
      mode: input.mode,
      budget: input.budget,
      releaseGate: input.releaseGate,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      runCount: 0,
    };
    await this.repo.create(template);
    return template;
  }

  /** 从 Run 配置来源保存模板（只复制 Configuration） */
  async saveFromRun(
    source: RunConfigSource,
    input: { name: string; description?: string; createdBy: string; now?: () => string },
  ): Promise<RunTemplate> {
    return this.create({
      projectId: source.projectId,
      name: input.name,
      description: input.description,
      environment: source.environment,
      suiteIds: source.suiteIds,
      mode: source.mode,
      budget: source.budget,
      releaseGate: source.releaseGate,
      createdBy: input.createdBy,
      now: input.now,
    });
  }

  async get(id: string): Promise<RunTemplate | null> {
    return this.repo.get(id);
  }

  async list(filter?: Partial<RunTemplate>): Promise<RunTemplate[]> {
    return this.repo.query(filter ?? {});
  }

  async count(): Promise<number> {
    return this.repo.count();
  }

  async update(id: string, input: Partial<Pick<RunTemplate, 'name' | 'description' | 'environment' | 'suiteIds' | 'mode' | 'budget' | 'releaseGate'>>): Promise<RunTemplate> {
    const t = await this.repo.get(id);
    if (!t) throw new Error(`Run Template 不存在：${id}`);
    const updated: RunTemplate = { ...t, ...input, id, updatedAt: new Date().toISOString() };
    await this.repo.update(id, updated);
    return updated;
  }

  /** 记录一次复用（Run 成功后由 RunService 调用；真实计数不虚构） */
  async recordRun(id: string): Promise<RunTemplate> {
    const t = await this.repo.get(id);
    if (!t) throw new Error(`Run Template 不存在：${id}`);
    const updated = { ...t, runCount: t.runCount + 1, updatedAt: new Date().toISOString() };
    await this.repo.update(id, updated);
    return updated;
  }

  /** 解析模板为可执行的 Run 配置（仅 Configuration） */
  async resolve(id: string): Promise<RunConfigSource> {
    const t = await this.repo.get(id);
    if (!t) throw new Error(`Run Template 不存在：${id}`);
    return {
      projectId: t.projectId,
      environment: t.environment,
      suiteIds: [...t.suiteIds],
      mode: t.mode,
      budget: t.budget,
      releaseGate: t.releaseGate,
    };
  }
}
