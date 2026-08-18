// Project / Environment 实体（Phase 24.1）
// 层级：Project → Business → Feature → Environment

/** 环境类型（统一五档） */
export type EnvironmentType = 'dev' | 'test' | 'staging' | 'preprod' | 'production';

/** 环境定义 */
export interface Environment {
  id: string;
  name: string;
  type: EnvironmentType;
  baseUrl?: string;
  enabled: boolean;
  /** 覆盖型安全策略（可选；缺省使用 ENVIRONMENT_ACTION_POLICY 单一策略源） */
  safetyPolicy?: unknown;
}

/** 项目 */
export interface Project {
  id: string;
  name: string;
  businesses: string[];
  environments: Environment[];
  defaultEnvironment: string;
  testPolicy?: unknown;
  releasePolicy?: unknown;
  createdAt: string;
  updatedAt: string;
}

/** 创建项目输入 */
export interface ProjectCreateInput {
  id: string;
  name: string;
  businesses?: string[];
  environments?: Environment[];
  defaultEnvironment?: string;
  testPolicy?: unknown;
  releasePolicy?: unknown;
}

/** 标准五环境工厂（快速初始化 / 测试用） */
export function standardEnvironments(): Environment[] {
  const types: EnvironmentType[] = ['dev', 'test', 'staging', 'preprod', 'production'];
  return types.map((type) => ({
    id: type,
    name: type,
    type,
    enabled: true,
  }));
}

/** 校验环境数组：type 合法、id 唯一、enabled 必填 */
export function validateEnvironments(envs: Environment[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  const validTypes = new Set<EnvironmentType>(['dev', 'test', 'staging', 'preprod', 'production']);
  for (const e of envs) {
    if (!validTypes.has(e.type)) errors.push(`环境 ${e.id} 类型非法：${String(e.type)}`);
    if (seen.has(e.id)) errors.push(`环境 id 重复：${e.id}`);
    seen.add(e.id);
    if (typeof e.enabled !== 'boolean') errors.push(`环境 ${e.id} 缺少 enabled`);
  }
  return errors;
}

/** 查找环境（按 id 或 name） */
export function findEnvironment(project: Project, idOrName: string): Environment | null {
  return (
    project.environments.find((e) => e.id === idOrName || e.name === idOrName) ?? null
  );
}
