// Test Asset Schema：统一测试资产模型（Phase 21.2 Test Asset Management）
// 目标：将 Requirement / TestCase / TestPlan / Risk / DataPlan / Execution / RCA /
// Defect / HealingPatch / Knowledge 纳入统一资产体系，支持创建 / 查询 / 版本 /
// 归档 / 恢复 / 关联 / 影响分析，形成完整追踪链：
//   Requirement → TestCase → Execution → Failure → RCA → Defect → Fix → Regression

/** 资产类型（10 类） */
export type TestAssetType =
  | 'requirement'
  | 'test-case'
  | 'test-plan'
  | 'risk'
  | 'data-plan'
  | 'execution'
  | 'rca'
  | 'defect'
  | 'healing-patch'
  | 'knowledge';

export const TEST_ASSET_TYPES: readonly TestAssetType[] = [
  'requirement', 'test-case', 'test-plan', 'risk', 'data-plan',
  'execution', 'rca', 'defect', 'healing-patch', 'knowledge',
];

/** 资产状态（自由字符串，推荐值如下） */
export type TestAssetStatus = 'DRAFT' | 'ACTIVE' | 'ARCHIVED';

/** 统一测试资产 */
export interface TestAsset {
  /** 资产唯一标识（跨版本稳定，如 req-wan3-001 / tc-wan3-001） */
  id: string;
  /** 资产类型 */
  type: TestAssetType;
  /** 版本号（v1 / v2 / ...，同一 id 多版本共存） */
  version: string;
  /** 归属 feature（业务 id 或功能模块，如 wan3 / image-generation） */
  feature: string;
  createdAt: string;
  updatedAt: string;
  /** 状态：DRAFT / ACTIVE / ARCHIVED */
  status: string;
  /** 标签（检索与复用匹配用） */
  tags: string[];
  /** 资产内容（对应类型的结构化对象序列化：Requirement / TestCase / RCA 等） */
  content?: unknown;
  /** 扩展元数据 */
  metadata?: Record<string, unknown>;
}

/** 资产关联关系类型（from → to 方向） */
export type AssetRelation =
  | 'derives'      // requirement → test-case / test-plan
  | 'plans'        // test-plan → test-case
  | 'executes'     // test-case → execution
  | 'failed-as'    // execution → rca（失败产生根因）
  | 'caused'       // rca → defect
  | 'fixes'        // defect → execution（修复后的回归验证）
  | 'patches'      // healing-patch → test-case
  | 'mitigates'    // risk → test-case（风险被用例缓解）
  | 'references'   // knowledge → 任意资产
  | 'related';     // 通用关联

export const ASSET_RELATIONS: readonly AssetRelation[] = [
  'derives', 'plans', 'executes', 'failed-as', 'caused',
  'fixes', 'patches', 'mitigates', 'references', 'related',
];

/** 资产间关联边 */
export interface AssetLink {
  from: string;
  to: string;
  relation: AssetRelation;
  createdAt: string;
}

/** 创建资产输入（id 可缺省自动生成） */
export interface CreateAssetInput {
  id?: string;
  type: TestAssetType;
  feature: string;
  version?: string;
  status?: string;
  tags?: string[];
  content?: unknown;
  metadata?: Record<string, unknown>;
}

/** 资产查询条件（AND 组合） */
export interface AssetQuery {
  type?: TestAssetType;
  feature?: string;
  status?: string;
  /** 全部标签需命中 */
  tags?: string[];
  /** 文本匹配：id / tags / JSON(content) 子串（大小写不敏感） */
  text?: string;
  /** 是否包含已归档（默认 false） */
  includeArchived?: boolean;
  limit?: number;
}

/** 生成资产 id（前缀按类型） */
const TYPE_PREFIX: Record<TestAssetType, string> = {
  requirement: 'req',
  'test-case': 'tc',
  'test-plan': 'plan',
  risk: 'risk',
  'data-plan': 'data',
  execution: 'exec',
  rca: 'rca',
  defect: 'def',
  'healing-patch': 'patch',
  knowledge: 'kb',
};

let assetSeq = 0;

/** 自动生成资产 id：<类型前缀>-<feature>-<序号> */
export function generateAssetId(type: TestAssetType, feature: string): string {
  assetSeq += 1;
  const feat = (feature || 'general').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 20);
  return `${TYPE_PREFIX[type]}-${feat}-${String(assetSeq).padStart(4, '0')}`;
}

/** 校验并归一化创建输入：非法抛错 */
export function normalizeCreateAssetInput(input: unknown): CreateAssetInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('TestAsset 创建失败：输入必须为对象');
  }
  const raw = input as Record<string, unknown>;
  if (!raw.type || !TEST_ASSET_TYPES.includes(raw.type as TestAssetType)) {
    throw new Error(`TestAsset 创建失败：type 无效（需为 ${TEST_ASSET_TYPES.join(' / ')}）`);
  }
  if (!raw.feature || typeof raw.feature !== 'string') {
    throw new Error('TestAsset 创建失败：缺少 feature');
  }
  const out: CreateAssetInput = {
    type: raw.type as TestAssetType,
    feature: String(raw.feature).trim(),
    version: typeof raw.version === 'string' && raw.version ? raw.version : 'v1',
    status: typeof raw.status === 'string' && raw.status ? raw.status : 'ACTIVE',
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === 'string') : [],
  };
  if (typeof raw.id === 'string' && raw.id.trim()) out.id = raw.id.trim();
  if (raw.content !== undefined) out.content = raw.content;
  if (typeof raw.metadata === 'object' && raw.metadata !== null) {
    out.metadata = raw.metadata as Record<string, unknown>;
  }
  return out;
}

/** 版本号递增：v1 → v2；非 vN 格式追加 -2 */
export function bumpVersion(version: string): string {
  const m = /^v(\d+)$/.exec(version);
  if (m) return `v${Number(m[1]) + 1}`;
  return `${version}-2`;
}
