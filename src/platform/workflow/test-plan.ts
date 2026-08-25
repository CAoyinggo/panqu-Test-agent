// Test Plan（Phase 39.2）：计划层（Plan → Suite → TestCase）
// 一个 Test Plan 聚合多个 Suite，指定环境 / 运行模式 / 优先级 / 预算 / 发布门禁。

import type { Entity, Repository } from '../storage/repository.js';
import { generateEntityId } from '../storage/repository.js';
import { CodedError, ErrorCode } from '../../core/errors.js';

/** 运行模式 */
export type TestPlanMode = 'MANUAL' | 'REGRESSION' | 'AUTONOMOUS';

export interface TestPlan extends Entity {
  id: string;
  projectId: string;
  name: string;
  suiteIds: string[];
  environment: string;
  mode: TestPlanMode;
  priorityPolicy?: unknown;
  budget?: unknown;
  releaseGate?: unknown;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePlanInput {
  projectId: string;
  name: string;
  suiteIds?: string[];
  environment: string;
  mode: TestPlanMode;
  priorityPolicy?: unknown;
  budget?: unknown;
  releaseGate?: unknown;
  createdBy: string;
  now?: () => string;
}

export class TestPlanService {
  constructor(private readonly repo: Repository<TestPlan>) {}

  async create(input: CreatePlanInput): Promise<TestPlan> {
    const now = input.now ? input.now() : new Date().toISOString();
    const plan: TestPlan = {
      id: generateEntityId('plan'),
      projectId: input.projectId,
      name: input.name,
      suiteIds: [...(input.suiteIds ?? [])],
      environment: input.environment,
      mode: input.mode,
      priorityPolicy: input.priorityPolicy,
      budget: input.budget,
      releaseGate: input.releaseGate,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    await this.repo.create(plan);
    return plan;
  }

  async get(id: string): Promise<TestPlan | null> {
    return this.repo.get(id);
  }

  async list(filter?: Partial<TestPlan>): Promise<TestPlan[]> {
    return this.repo.query(filter ?? {});
  }

  async count(): Promise<number> {
    return this.repo.count();
  }

  async update(
    id: string,
    input: {
      name?: string;
      suiteIds?: string[];
      environment?: string;
      mode?: TestPlanMode;
      priorityPolicy?: unknown;
      budget?: unknown;
      releaseGate?: unknown;
    },
  ): Promise<TestPlan> {
    const plan = await this.repo.get(id);
    if (!plan) throw new CodedError(ErrorCode.NOT_FOUND, `Test Plan 不存在：${id}`);
    const updated: TestPlan = {
      ...plan,
      name: input.name ?? plan.name,
      suiteIds: input.suiteIds ?? plan.suiteIds,
      environment: input.environment ?? plan.environment,
      mode: input.mode ?? plan.mode,
      priorityPolicy: input.priorityPolicy === undefined ? plan.priorityPolicy : input.priorityPolicy,
      budget: input.budget === undefined ? plan.budget : input.budget,
      releaseGate: input.releaseGate === undefined ? plan.releaseGate : input.releaseGate,
      updatedAt: new Date().toISOString(),
    };
    await this.repo.update(id, updated);
    return updated;
  }
}
