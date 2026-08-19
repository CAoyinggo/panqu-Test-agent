// Repository 抽象（Phase 24.2）：统一持久化接口
// 业务层禁止直接操作数据库；仅通过 Repository<T> 访问。
// 实现可替换：Memory（测试/进程内） / JSON（文件） / SQLite（未来按同接口接入）。

import { generateId } from '../../core/id.js';

/** 实体约束：必须具备 id */
export interface Entity {
  id: string;
}

/** 查询条件：浅相等过滤 + 分页 */
export interface Query<T> {
  filter?: Partial<T>;
  limit?: number;
  offset?: number;
}

/** 通用仓库接口（任务书 24.2） */
export interface Repository<T extends Entity> {
  /** 创建实体；input.id 缺省时自动生成 */
  create(input: Omit<T, 'id'> & { id?: string }): Promise<T>;
  get(id: string): Promise<T | null>;
  /** 更新实体（按 id；不修改 id 字段） */
  update(id: string, input: Partial<Omit<T, 'id'>>): Promise<T>;
  delete(id: string): Promise<void>;
  /** 查询：filter 为浅相等匹配（对象值按引用比较） */
  query(filter?: Partial<T>, q?: Pick<Query<T>, 'limit' | 'offset'>): Promise<T[]>;
  count(): Promise<number>;
  clear(): Promise<void>;
}

/** 生成碰撞安全 id（29.3：委托 core/id.ts，消除高吞吐下的随机碰撞） */
export function generateEntityId(prefix: string): string {
  return generateId(prefix);
}
