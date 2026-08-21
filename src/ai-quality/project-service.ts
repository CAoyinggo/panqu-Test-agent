// Project-scoped AI Evaluation Registry（Phase 51.1）
// 每个 Project 拥有独立 AIQualityService，从物理状态边界上隔离：
// Benchmark / Ground Truth / Evaluation History / Feedback / Knowledge / Audit。

import fs from 'node:fs';
import path from 'node:path';
import { AIQualityService, createAIQualityService, type AiQualitySnapshot } from './service.js';

export interface ProjectAIQualitySnapshot {
  schemaVersion: 1;
  projects: Record<string, AiQualitySnapshot>;
}

export interface ProjectAIQualityRegistryOptions {
  create?: (projectId: string) => AIQualityService;
  initial?: Record<string, AIQualityService>;
}

/** Project ID 是所有 AI Evaluation 读写的强制分区键。 */
export class ProjectAIQualityRegistry {
  private readonly services = new Map<string, AIQualityService>();
  private readonly create: (projectId: string) => AIQualityService;

  constructor(opts: ProjectAIQualityRegistryOptions = {}) {
    this.create = opts.create ?? (() => createAIQualityService());
    for (const [projectId, service] of Object.entries(opts.initial ?? {})) this.attach(projectId, service);
  }

  /** 不存在时创建全新默认 Benchmark/Ground Truth，绝不共享可变引用。 */
  forProject(projectId: string): AIQualityService {
    const id = normalizeProjectId(projectId);
    let service = this.services.get(id);
    if (!service) {
      service = this.create(id);
      this.services.set(id, service);
    }
    return service;
  }

  /** 注入已有服务（兼容 Phase 46-50 ApiServerOptions.aiQuality）。 */
  attach(projectId: string, service: AIQualityService): this {
    const id = normalizeProjectId(projectId);
    if (this.services.has(id) && this.services.get(id) !== service) {
      throw new Error(`项目 ${id} 已存在 AI Quality 分区，禁止覆盖`);
    }
    this.services.set(id, service);
    return this;
  }

  has(projectId: string): boolean {
    return this.services.has(normalizeProjectId(projectId));
  }

  projectIds(): string[] {
    return [...this.services.keys()].sort();
  }

  snapshot(): ProjectAIQualitySnapshot {
    const projects: Record<string, AiQualitySnapshot> = {};
    for (const [projectId, service] of this.services) projects[projectId] = service.snapshot();
    return { schemaVersion: 1, projects };
  }

  static restore(snapshot: ProjectAIQualitySnapshot): ProjectAIQualityRegistry {
    if (!snapshot || snapshot.schemaVersion !== 1 || !snapshot.projects) throw new Error('Project AI Quality 快照格式无效');
    const initial: Record<string, AIQualityService> = {};
    for (const [projectId, serviceSnapshot] of Object.entries(snapshot.projects)) {
      initial[projectId] = AIQualityService.restore(serviceSnapshot);
    }
    return new ProjectAIQualityRegistry({ initial });
  }

  /** 原子持久化全部项目分区。 */
  persistToFile(filePath: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.snapshot(), null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
  }

  static loadFromFile(filePath: string): ProjectAIQualityRegistry {
    if (!fs.existsSync(filePath)) return new ProjectAIQualityRegistry();
    return ProjectAIQualityRegistry.restore(JSON.parse(fs.readFileSync(filePath, 'utf8')) as ProjectAIQualitySnapshot);
  }
}

function normalizeProjectId(projectId: string): string {
  const id = String(projectId ?? '').trim();
  if (!id) throw new Error('AI Evaluation 必须指定 projectId');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)) throw new Error(`projectId 非法：${id}`);
  return id;
}

export function createProjectAIQualityRegistry(opts: ProjectAIQualityRegistryOptions = {}): ProjectAIQualityRegistry {
  return new ProjectAIQualityRegistry(opts);
}
