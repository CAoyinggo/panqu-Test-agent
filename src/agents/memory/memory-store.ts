// 记忆层：TestMemory 接口与数据结构
// 保存历史执行结果、失败、根因、环境变化、模型/接口变化、Flaky Case、测试数据、测试设计、人工确认、缺陷、覆盖缺口等。
// 第一阶段用 JSON / SQLite 持久化，接口可替换（后续可升级为向量库，无需改动 Agent）。
export type MemoryRecordType =
  | 'execution'
  | 'failure'
  | 'root-cause'
  | 'environment-change'
  | 'model-change'
  | 'api-change'
  | 'flaky'
  | 'test-data'
  | 'test-design'
  | 'manual-confirmation'
  | 'defect'
  | 'coverage-gap';

/** 记忆记录 */
export interface MemoryRecord {
  id: string;
  type: MemoryRecordType;
  createdAt: string;
  data: Record<string, unknown>;
  tags?: string[];
}

/** 记忆查询条件 */
export interface MemoryQuery {
  type?: MemoryRecordType | string;
  tags?: string[];
  from?: string;
  to?: string;
  limit?: number;
}

/** 失败记录（供 getSimilarFailures 检索相似历史） */
export interface FailureRecord {
  caseId: string;
  category?: string;
  message?: string;
  evidence?: string[];
  tags?: string[];
}

/** TestMemory 接口：可替换实现（JSON / SQLite / 向量库） */
export interface TestMemory {
  save(record: MemoryRecord): Promise<void>;
  query(query: MemoryQuery): Promise<MemoryRecord[]>;
  getSimilarFailures(failure: FailureRecord): Promise<MemoryRecord[]>;
  /** 检索某用例的全部历史记录（执行/失败/根因/flaky） */
  querySimilarCase(caseId: string, limit?: number): Promise<MemoryRecord[]>;
  /** 检索某功能的历史风险（失败/根因/flaky 记录） */
  queryHistoricalRisk(feature: string, limit?: number): Promise<MemoryRecord[]>;
  /** 检索已知问题（缺陷/根因记录） */
  queryKnownIssue(feature?: string, limit?: number): Promise<MemoryRecord[]>;
  /** 检索测试覆盖缺口（coverage-gap 记录） */
  queryCoverageGap(feature?: string, limit?: number): Promise<MemoryRecord[]>;
}

/** 生成记忆记录 ID（时间戳 + 随机） */
export function generateMemoryId(prefix = 'mem'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 空实现（Memory 不可用时的兜底，保证 Agent 流程不中断） */
export class NoopMemory implements TestMemory {
  async save(_record: MemoryRecord): Promise<void> {
    // no-op
  }
  async query(): Promise<MemoryRecord[]> {
    return [];
  }
  async getSimilarFailures(): Promise<MemoryRecord[]> {
    return [];
  }
  async querySimilarCase(_caseId: string, _limit?: number): Promise<MemoryRecord[]> {
    return [];
  }
  async queryHistoricalRisk(_feature: string, _limit?: number): Promise<MemoryRecord[]> {
    return [];
  }
  async queryKnownIssue(_feature?: string, _limit?: number): Promise<MemoryRecord[]> {
    return [];
  }
  async queryCoverageGap(_feature?: string, _limit?: number): Promise<MemoryRecord[]> {
    return [];
  }
}
