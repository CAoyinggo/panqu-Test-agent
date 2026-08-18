// Project Service（Phase 24.1）：API / CLI / Scheduler 共用的业务层
// 仅做参数归一化与委托 Registry，不直接操作存储（Service Layer 统一规则）。

import {
  ProjectRegistry,
  type ProjectRegistryOptions,
} from './project-registry.js';
import {
  resolveEnvironmentDecision,
  isProductionLike,
  type EnvironmentSafetyPolicy,
  type PolicyDecision,
  type ToolActionLevel,
} from './environment-policy.js';
import {
  findEnvironment,
  type Environment,
  type EnvironmentType,
  type Project,
  type ProjectCreateInput,
} from './project-schema.js';

export interface EnvironmentCheckResult {
  environment: string;
  type: EnvironmentType;
  productionLike: boolean;
  decision: PolicyDecision;
  describe: string;
}

export class ProjectService {
  readonly registry: ProjectRegistry;

  constructor(opts?: ProjectRegistryOptions) {
    this.registry = new ProjectRegistry(opts);
  }

  createProject(input: ProjectCreateInput): Project {
    return this.registry.create(input);
  }

  getProject(id: string): Project | null {
    return this.registry.get(id);
  }

  listProjects(): Project[] {
    return this.registry.list();
  }

  getEnvironment(projectId: string, envIdOrName: string): Environment | null {
    return this.registry.getEnvironment(projectId, envIdOrName);
  }

  /** 环境动作决策：Environment.safetyPolicy 覆盖 → 单一策略源 */
  checkAction(projectId: string, envIdOrName: string, action: ToolActionLevel): EnvironmentCheckResult {
    const env = this.registry.getEnvironment(projectId, envIdOrName);
    if (!env) throw new Error(`Project ${projectId} 下无环境 ${envIdOrName}`);
    const decision = resolveEnvironmentDecision(env, action);
    return {
      environment: env.id,
      type: env.type,
      productionLike: isProductionLike(env.type),
      decision,
      describe: decision === 'allow' ? '允许' : decision === 'approval' ? '需审批' : '拒绝',
    };
  }

  /** 覆盖策略输入（供 create 时设置 Environment.safetyPolicy） */
  static safetyPolicy(actions: Partial<Record<ToolActionLevel, PolicyDecision>>): EnvironmentSafetyPolicy {
    return { actions };
  }

  static findEnvironment(project: Project, idOrName: string): Environment | null {
    return findEnvironment(project, idOrName);
  }
}
