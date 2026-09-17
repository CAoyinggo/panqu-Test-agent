/**
 * Panqu AI DevTest 企业领域认知层 (Company Domain Knowledge)
 *
 * 核心设计目标：
 * 1. 让 DevTest 真正理解公司业务系统（业务对象、API、Oracle、Task、参数、状态、对象关系、验证规则）。
 * 2. 严格的四级知识可信度边界（CONFIRMED / OBSERVED / INFERRED / UNKNOWN），杜绝幻觉编造。
 * 3. 支撑四大核心流程：
 *    - probe: 识别业务对象、关联 API/Oracle/Task、标识 UNKNOWN 风险项
 *    - plan: 生成包含前置条件、业务操作、API/Task/Oracle 校验及最终产物的全业务链路计划
 *    - execute: 提供领域约束感知与参数前置校验
 *    - verify: 实现业务级判定（Technical Success ≠ Business Success）
 * 4. 沉淀已确认测试经验 (Experience) 与失败模式 (Failure Pattern)。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { MemoryCandidatePayload } from './types.js';

// ============================================================================
// 1. 知识可信度边界定义 (Knowledge Credibility Boundary)
// ============================================================================

export type KnowledgeCredibility =
  | 'CONFIRMED'  // 官方定义 / 线上已验证事实（直接信任并作为强断言基准）
  | 'OBSERVED'   // 真实执行中观察到的现象（作为经验参考，不可作为排他硬断言）
  | 'INFERRED'   // Agent 根据现有事实逻辑推断（必须注明不确定性与推断依据）
  | 'UNKNOWN';   // 当前未知（严禁自行编造，必须明确缺口并要求人工/环境确认）

export interface CredibleFact<T> {
  value: T;
  credibility: KnowledgeCredibility;
  source: string;
  rationale?: string;
  unknownReason?: string;
}

export function createConfirmedFact<T>(value: T, source = 'official_spec'): CredibleFact<T> {
  return { value, credibility: 'CONFIRMED', source };
}

export function createObservedFact<T>(value: T, source = 'runtime_observation'): CredibleFact<T> {
  return { value, credibility: 'OBSERVED', source };
}

export function createInferredFact<T>(value: T, rationale: string, source = 'agent_inference'): CredibleFact<T> {
  return { value, credibility: 'INFERRED', source, rationale };
}

export function createUnknownFact<T = unknown>(itemDescription: string, unknownReason: string): CredibleFact<T | undefined> {
  return {
    value: undefined,
    credibility: 'UNKNOWN',
    source: 'unknown_boundary',
    unknownReason: `[UNKNOWN] ${itemDescription}: ${unknownReason} (禁止模型自动补全)`,
  };
}

// ============================================================================
// 2. 业务实体对象模型 (Domain Business Objects)
// ============================================================================

export interface BusinessEntity {
  name: string;
  code: string;
  description: string;
  idField: string;
  parentEntity?: string;
  childEntities?: string[];
  credibility: KnowledgeCredibility;
  knownFields: string[];
  unknownFields?: string[];
  businessConstraints: string[];
}

export const PANQU_BUSINESS_ENTITIES: Record<string, BusinessEntity> = {
  Project: {
    name: '项目 (Project)',
    code: 'PROJECT',
    description: '媒体创作顶层业务容器，所有 Task、Folder 与 MediaAsset 的所有权归属主体。',
    idField: 'project_id',
    childEntities: ['Folder', 'Task', 'MediaAsset'],
    credibility: 'CONFIRMED',
    knownFields: ['id', 'name', 'user_id', 'createtime', 'updatetime'],
    unknownFields: ['pq_project 团队跨组织共享权限字段细节目前 UNKNOWN'],
    businessConstraints: [
      '所有生成的 Task 必须关联有效的 project_id，不可提交孤儿任务',
      '跨 project_id 访问或引用未公开素材将被服务端鉴权拦截',
    ],
  },
  Folder: {
    name: '素材文件夹 (Folder)',
    code: 'FOLDER',
    description: '项目内部的目录层级容器，用于组织归档产物和素材。',
    idField: 'folder_id',
    parentEntity: 'Project',
    childEntities: ['MediaAsset'],
    credibility: 'CONFIRMED',
    knownFields: ['id', 'project_id', 'name', 'parent_id'],
    unknownFields: ['文件夹最大嵌套深度限制目前 UNKNOWN'],
    businessConstraints: [
      'folder_id 必须归属于当前 task 相同的 project_id，严禁跨项目挂载',
    ],
  },
  Task: {
    name: '异步生成任务 (Task)',
    code: 'TASK',
    description: 'AI 视频/生图/音频处理的异步作业单元，具备完整的状态机生命周期。',
    idField: 'task_id',
    parentEntity: 'Project',
    childEntities: ['MediaAsset', 'BillingLedger'],
    credibility: 'CONFIRMED',
    knownFields: ['id', 'project_id', 'type', 'task_status', 'progress', 'video_url', 'pic_url', 'extra', 'err'],
    unknownFields: ['底层 Go worker 队列分流与重试最大次数目前 UNKNOWN'],
    businessConstraints: [
      'API 成功返回并不代表 Task 成功，必须跟踪至终态 (task_status=2)',
      'Task 状态为 3/4 时，必须触发退款且净扣积分归零',
      'Task 成功终态必须产出有效业务产物并绑定到所属 Project',
    ],
  },
  MediaAsset: {
    name: '媒体资产 (MediaAsset)',
    code: 'MEDIA_ASSET',
    description: 'Task 执行成功后生成的物理文件或在用户媒体库中持久化的实体。',
    idField: 'asset_id',
    parentEntity: 'Project',
    credibility: 'CONFIRMED',
    knownFields: ['id', 'project_id', 'folder_id', 'task_id', 'url', 'format', 'size'],
    unknownFields: ['CDN 缓存刷新生命周期策略目前 UNKNOWN'],
    businessConstraints: [
      '媒体文件不仅需要 HTTP 200，还需要具备合法二进制容器结构 (MP4/PNG)',
      '产物 URL 必须与 Task 建立明确归属绑定证据 (Artifact Ownership)',
    ],
  },
  BillingLedger: {
    name: '账务流水 (BillingLedger)',
    code: 'BILLING_LEDGER',
    description: '用户积分账户变动明细，核验业务扣费真实性与合法性。',
    idField: 'log_id',
    parentEntity: 'Task',
    credibility: 'CONFIRMED',
    knownFields: ['id', 'task_id', 'type', 'score', 'memo', 'createtime'],
    unknownFields: ['月度归档分表归档触发时刻目前 UNKNOWN'],
    businessConstraints: [
      '每个任务最多仅允许 1 笔有效预扣 (antiDoubleBilling)',
      '失败任务必须净扣归零 (netChargeZero)',
      '退款动作必须严格幂等，成功任务严禁出现退款 (refundIdempotency)',
    ],
  },
};

// ============================================================================
// 3. API 领域知识 (API Knowledge)
// ============================================================================

export interface ApiParameterKnowledge {
  name: string;
  type: string;
  meaning: string;
  required: boolean;
  businessEntity?: string;
  constraints?: string;
  credibility: KnowledgeCredibility;
}

export interface ApiKnowledge {
  id: string;
  name: string;
  endpoint: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  parameters: ApiParameterKnowledge[];
  preconditions: string[];
  returnStructure: {
    successCode: number | string;
    codeField: string;
    dataField: string;
    messageField: string;
    credibility: KnowledgeCredibility;
  };
  associatedObjects: string[];
  testCaveats: string[];
  credibility: KnowledgeCredibility;
}

export const PANQU_API_KNOWLEDGE: Record<string, ApiKnowledge> = {
  VIDEO_SUBMIT: {
    id: 'api_video_submit',
    name: '视频生成任务提交接口',
    endpoint: '/aivideo/v2/generate/video',
    method: 'POST',
    parameters: [
      { name: '__token__', type: 'string', meaning: 'CSRF 防护令牌', required: true, credibility: 'CONFIRMED' },
      { name: 'project_id', type: 'number', meaning: '关联的业务项目 ID', required: true, businessEntity: 'Project', credibility: 'CONFIRMED' },
      { name: 'row[name]', type: 'string', meaning: '任务业务名称', required: true, credibility: 'CONFIRMED' },
      { name: 'row[type]', type: 'number', meaning: '视频处理类型 (如 6=通用视频, 105=分流新版)', required: true, credibility: 'CONFIRMED' },
      { name: 'row[selmodelsId]', type: 'number', meaning: '主站模型配置 ID (如 84, 88, 15, 78)', required: true, credibility: 'CONFIRMED' },
      { name: 'row[extra][cueword]', type: 'string', meaning: '生成提示词', required: true, credibility: 'CONFIRMED' },
      { name: 'row[extra][duration]', type: 'number', meaning: '生成时长(秒)', required: true, constraints: '支持 3~5 秒枚举', credibility: 'CONFIRMED' },
      { name: 'row[extra][video_resolution]', type: 'string', meaning: '分辨率规格', required: true, constraints: '480p, 720p, 1080p', credibility: 'CONFIRMED' },
      { name: 'row[extra][video_aspect_ratio]', type: 'string', meaning: '画面比例', required: true, constraints: '16:9, 9:16, 1:1', credibility: 'CONFIRMED' },
    ],
    preconditions: [
      '必须具备有效的 Session Cookie 与 CSRF 令牌',
      '关联的 project_id 必须存在且用户具备写入权限',
      '用户账户可用积分必须 >= 预估扣除积分 (required_points)',
    ],
    returnStructure: {
      successCode: 1,
      codeField: 'code',
      dataField: 'data.id 或 data (number)',
      messageField: 'msg',
      credibility: 'CONFIRMED',
    },
    associatedObjects: ['Project', 'Task', 'BillingLedger'],
    testCaveats: [
      '接口返回 code=1 仅代表排队接收成功，绝不等于视频生成成功！',
      '此时仅产生了预扣冻结流水，必须进一步跟踪 Task 状态与产物',
      '若接口返回 code=0 或 402/10001，多为积分不足或鉴权失败',
    ],
    credibility: 'CONFIRMED',
  },
  IMAGE_SUBMIT: {
    id: 'api_image_submit',
    name: '生图任务提交接口',
    endpoint: '/aivideo/v2/generate/submit_picture_custom_size',
    method: 'POST',
    parameters: [
      { name: '__token__', type: 'string', meaning: 'CSRF 防护令牌', required: true, credibility: 'CONFIRMED' },
      { name: 'project_id', type: 'number', meaning: '关联的业务项目 ID', required: true, businessEntity: 'Project', credibility: 'CONFIRMED' },
      { name: 'row[selmodelsId]', type: 'number', meaning: '模型配置 ID (如 201, 205, 12)', required: true, credibility: 'CONFIRMED' },
      { name: 'row[extra][prompt]', type: 'string', meaning: '生图提示词', required: true, credibility: 'CONFIRMED' },
      { name: 'row[extra][resolution]', type: 'string', meaning: '生图分辨率规格 (如 1k, 2k, 4k)', required: true, credibility: 'CONFIRMED' },
      { name: 'row[extra][serviceline]', type: 'string', meaning: '业务线标识', required: false, credibility: 'CONFIRMED' },
    ],
    preconditions: [
      '有效登录 Session 与 CSRF',
      '账户积分余额充足',
    ],
    returnStructure: {
      successCode: 1,
      codeField: 'code',
      dataField: 'data.id 或 data',
      messageField: 'msg',
      credibility: 'CONFIRMED',
    },
    associatedObjects: ['Project', 'Task', 'BillingLedger'],
    testCaveats: [
      'code=1 仅代表入队，必须轮询终态并校验 PNG/JPG 图像物理格式与尺寸',
    ],
    credibility: 'CONFIRMED',
  },
  TASK_STATUS_POLL: {
    id: 'api_task_status_poll',
    name: '任务状态只读轮询接口',
    endpoint: '/aivideo/v2/task_status/apiGetStatus',
    method: 'POST',
    parameters: [
      { name: 'type', type: 'string', meaning: '媒体大类 (video 或 scene)', required: true, credibility: 'CONFIRMED' },
      { name: 'ids', type: 'string', meaning: '任务 ID (单值或逗号分隔)', required: true, businessEntity: 'Task', credibility: 'CONFIRMED' },
    ],
    preconditions: ['用户已登录，对目标 task 拥有只读查看权限'],
    returnStructure: {
      successCode: 1,
      codeField: 'code',
      dataField: 'data (数组或以 taskId 为键的对象)',
      messageField: 'msg',
      credibility: 'CONFIRMED',
    },
    associatedObjects: ['Task', 'MediaAsset'],
    testCaveats: [
      '此接口为纯只读操作，严禁在轮询中引入修改副作用',
      'task_status: 1=排队中, 2=成功, 3=失败, 4=异常',
      '只有状态到达 2/3/4 时才代表进入终态',
    ],
    credibility: 'CONFIRMED',
  },
  ADMIN_SCORE_QUERY: {
    id: 'api_admin_score_query',
    name: '积分流水审计接口 (AdminScore)',
    endpoint: '/auth/adminscore/index',
    method: 'GET',
    parameters: [
      { name: 'filter', type: 'string', meaning: 'JSON 过滤条件 {"task_id": ...}', required: true, credibility: 'CONFIRMED' },
      { name: 'op', type: 'string', meaning: 'JSON 操作符 {"task_id": "="}', required: true, credibility: 'CONFIRMED' },
    ],
    preconditions: ['管理员权限或拥有 FastAdmin score 查询凭据'],
    returnStructure: {
      successCode: 200,
      codeField: 'status/http',
      dataField: 'rows',
      messageField: 'msg',
      credibility: 'CONFIRMED',
    },
    associatedObjects: ['Task', 'BillingLedger'],
    testCaveats: [
      '必须区分 QUERY_SUCCESS (0条记录) 与 AUTH_FAILED / QUERY_TIMEOUT / PARSE_ERROR',
      '不得 catch 错误后伪造空数组当作无流水',
    ],
    credibility: 'CONFIRMED',
  },
  PERSONAL_BILLING_QUERY: {
    id: 'api_personal_billing_query',
    name: '个人积分流水接口 (apiPersonalRecords)',
    endpoint: '/aivideo/v2/billing/apiPersonalRecords',
    method: 'GET',
    parameters: [
      { name: 'page', type: 'number', meaning: '页码', required: false, credibility: 'CONFIRMED' },
      { name: 'limit', type: 'number', meaning: '分页限制', required: false, credibility: 'CONFIRMED' },
      { name: 'keyword', type: 'string', meaning: '搜索关键字 (通常为 taskId)', required: false, credibility: 'CONFIRMED' },
    ],
    preconditions: ['普通用户已登录 Session'],
    returnStructure: {
      successCode: 1,
      codeField: 'code',
      dataField: 'data.rows',
      messageField: 'msg',
      credibility: 'CONFIRMED',
    },
    associatedObjects: ['Task', 'BillingLedger'],
    testCaveats: [
      '个人端点仅在 task_id 明细或 memo/type_text 包含 taskId 时才建立关联',
    ],
    credibility: 'CONFIRMED',
  },
};

// ============================================================================
// 4. Oracle 领域知识 (Oracle Knowledge)
// ============================================================================

export interface OracleFieldKnowledge {
  name: string;
  type: string;
  meaning: string;
  isStatusField?: boolean;
  credibility: KnowledgeCredibility;
  notes?: string;
}

export interface OracleKnowledge {
  businessObject: string;
  table: string;
  keyFields: string[];
  fields: Record<string, OracleFieldKnowledge>;
  statusField?: {
    name: string;
    meanings: Record<number | string, string>;
    credibility: KnowledgeCredibility;
  };
  apiToDbMapping: Record<string, string>; // apiParam/field -> dbColumn
  commonVerificationRules: string[];
  untrustedFields: Array<{ field: string; reason: string }>;
  credibility: KnowledgeCredibility;
  unknownDetails: string[];
}

export const PANQU_ORACLE_KNOWLEDGE: Record<string, OracleKnowledge> = {
  AI_TASKS: {
    businessObject: 'Task',
    table: 'ai_tasks',
    keyFields: ['id'],
    fields: {
      id: { name: 'id', type: 'int', meaning: '自增主键，对应业务 task_id', credibility: 'CONFIRMED' },
      project_id: { name: 'project_id', type: 'int', meaning: '归属项目 ID', credibility: 'CONFIRMED' },
      type: { name: 'type', type: 'int', meaning: '任务类型 (如 6=视频, 105=新视频模型)', credibility: 'CONFIRMED' },
      task_status: { name: 'task_status', type: 'tinyint', meaning: '任务生命周期状态', isStatusField: true, credibility: 'CONFIRMED' },
      progress: { name: 'progress', type: 'int', meaning: '执行百分比进度 (0~100)', credibility: 'CONFIRMED' },
      video_url: { name: 'video_url', type: 'varchar', meaning: '视频产物直链', credibility: 'CONFIRMED' },
      pic_url: { name: 'pic_url', type: 'varchar', meaning: '图片产物直链', credibility: 'CONFIRMED' },
      extra: { name: 'extra', type: 'text', meaning: '任务参数扩展 JSON，包含分流标记 diversion 等', credibility: 'OBSERVED' },
      err: { name: 'err', type: 'text', meaning: '失败错误描述', credibility: 'CONFIRMED' },
      createtime: { name: 'createtime', type: 'int', meaning: '创建时间戳', credibility: 'CONFIRMED' },
    },
    statusField: {
      name: 'task_status',
      meanings: {
        1: '排队/处理中 (Queued/Processing)',
        2: '成功完成 (Success)',
        3: '业务失败 (Failed)',
        4: '异常故障 (Error)',
      },
      credibility: 'CONFIRMED',
    },
    apiToDbMapping: {
      'row[name]': 'name',
      'row[selmodelsId]': 'selmodels_id',
      'row[type]': 'type',
      'project_id': 'project_id',
      'videoUrl': 'video_url',
      'imageUrl': 'pic_url',
    },
    commonVerificationRules: [
      'task_status=2 时，video_url 或 pic_url 字段必须为非空有效链接',
      'task_status=3 或 4 时，err 字段必须有明确错误原因记录',
      '分流场景下 extra 字段中必须包含明确的 diversion 线路信息',
    ],
    untrustedFields: [
      { field: 'extra', reason: '主站 HTTP 查询 API 不直接暴露 extra 字段，若未获授权执行只读 DB 查询，必须标记为 MANUAL_DB_EVIDENCE_REQUIRED' },
    ],
    credibility: 'CONFIRMED',
    unknownDetails: [
      'ai_tasks 分库分表规则目前 UNKNOWN',
      '底层 Go Consumer 内部心跳更新字段目前 UNKNOWN',
    ],
  },
  PQ_SCORE_LOG: {
    businessObject: 'BillingLedger',
    table: 'pq_score_log',
    keyFields: ['id'],
    fields: {
      id: { name: 'id', type: 'int', meaning: '流水记录唯一自增 ID', credibility: 'CONFIRMED' },
      user_id: { name: 'user_id', type: 'int', meaning: '发生扣费的用户 ID', credibility: 'CONFIRMED' },
      task_id: { name: 'task_id', type: 'int', meaning: '关联的任务 ID', credibility: 'CONFIRMED' },
      type: { name: 'type', type: 'tinyint', meaning: '变动类型: 2=扣费/预扣, 1=充值/退款', isStatusField: true, credibility: 'CONFIRMED' },
      score: { name: 'score', type: 'int', meaning: '积分变动量', credibility: 'CONFIRMED' },
      memo: { name: 'memo', type: 'varchar', meaning: '流水备注 (包含模型名、任务ID等)', credibility: 'CONFIRMED' },
      createtime: { name: 'createtime', type: 'int', meaning: '记录生成时间戳', credibility: 'CONFIRMED' },
    },
    statusField: {
      name: 'type',
      meanings: {
        1: '增加/退款/充值 (Refund / Credit)',
        2: '扣减/预扣 (Deduction / Debit)',
      },
      credibility: 'CONFIRMED',
    },
    apiToDbMapping: {
      'taskId': 'task_id',
      'points': 'score',
    },
    commonVerificationRules: [
      '同一 task_id 对应的 type=2 记录必须只有 1 笔 (防重复扣费)',
      '失败任务 (task_status=3) 必须且只能有 1 笔 type=1 的等额退款 (失败净扣归零)',
      '成功任务严禁出现退款流水 (退款幂等核销)',
    ],
    untrustedFields: [
      { field: 'memo', reason: 'memo 仅作为 task_id 缺失时的辅助字符串比对依据，不可单凭模糊包含确认真实归属' },
    ],
    credibility: 'CONFIRMED',
    unknownDetails: [
      'pq_score_log_archive 分表物理归档的具体时间与迁移规则目前 UNKNOWN',
    ],
  },
  PQ_MEDIA_ASSET: {
    businessObject: 'MediaAsset',
    table: 'pq_media_asset',
    keyFields: ['id'],
    fields: {
      id: { name: 'id', type: 'int', meaning: '资产唯一 ID', credibility: 'CONFIRMED' },
      project_id: { name: 'project_id', type: 'int', meaning: '归属项目 ID', credibility: 'CONFIRMED' },
      folder_id: { name: 'folder_id', type: 'int', meaning: '归属文件夹 ID', credibility: 'CONFIRMED' },
      task_id: { name: 'task_id', type: 'int', meaning: '产生产物的 Task ID', credibility: 'CONFIRMED' },
      url: { name: 'url', type: 'varchar', meaning: '素材物理访问 URL', credibility: 'CONFIRMED' },
      file_size: { name: 'file_size', type: 'bigint', meaning: '文件字节大小', credibility: 'CONFIRMED' },
    },
    apiToDbMapping: {
      'taskId': 'task_id',
      'projectId': 'project_id',
      'folderId': 'folder_id',
    },
    commonVerificationRules: [
      '成功任务生成的素材记录，其 project_id 必须与任务 project_id 严格一致',
      '素材的 task_id 必须与真实执行的 task_id 对应，不得悬挂孤儿素材',
    ],
    untrustedFields: [],
    credibility: 'CONFIRMED',
    unknownDetails: [
      '素材软删除与回收站机制目前 UNKNOWN',
      '底层对象存储 Bucket 跨区同步延迟目前 UNKNOWN',
    ],
  },
};

// ============================================================================
// 5. Task 领域知识 (Task Knowledge)
// ============================================================================

export interface TaskLifecycleStep {
  status: number;
  name: string;
  isTerminal: boolean;
  isSuccess: boolean;
  description: string;
}

export interface TaskKnowledge {
  id: string;
  name: string;
  taskType: string;
  numericType: number;
  creationApi: string;
  parameters: string[];
  lifecycle: TaskLifecycleStep[];
  relations: {
    project: { required: boolean; field: string; meaning: string };
    media: { outputField: string; format: string };
    folder?: { field?: string; meaning?: string; dependencyNote?: string };
  };
  finalResultExpectation: {
    requiredFields: string[];
    credibility: KnowledgeCredibility;
  };
  differenceFromApiResponse: string;
  businessSuccessCriteria: string[];
  credibility: KnowledgeCredibility;
}

export const PANQU_TASK_KNOWLEDGE: Record<string, TaskKnowledge> = {
  VIDEO_TASK: {
    id: 'task_video_gen',
    name: '视频生成任务 (Video Generation Task)',
    taskType: 'VIDEO_GEN',
    numericType: 6,
    creationApi: '/aivideo/v2/generate/video',
    parameters: ['project_id', 'row[name]', 'row[selmodelsId]', 'row[extra][cueword]', 'row[extra][duration]', 'row[extra][video_resolution]'],
    lifecycle: [
      { status: 1, name: 'QUEUED_OR_PROCESSING', isTerminal: false, isSuccess: false, description: '任务排队中或正在渲染中' },
      { status: 2, name: 'SUCCESS', isTerminal: true, isSuccess: true, description: '任务渲染完成且产物就绪' },
      { status: 3, name: 'FAILED', isTerminal: true, isSuccess: false, description: '上游模型调用失败或生成异常' },
      { status: 4, name: 'ERROR', isTerminal: true, isSuccess: false, description: '底层服务故障或超时' },
    ],
    relations: {
      project: { required: true, field: 'project_id', meaning: '必须关联现有项目，决定产物归属' },
      media: { outputField: 'video_url', format: 'mp4' },
      folder: { field: 'folder_id', meaning: '可选归档目录', dependencyNote: '若指定 folder_id，必须确认其属于该 project_id' },
    },
    finalResultExpectation: {
      requiredFields: ['video_url', 'progress'],
      credibility: 'CONFIRMED',
    },
    differenceFromApiResponse:
      '【核心差异】：API 提交响应 code=1 仅表明主站成功写入任务表并发送队列消息（Technical Acceptance）。' +
      '真正的异步处理需要经过 Go Consumer 派发模型提供商、等待推流渲染并写入 OSS。' +
      '若提供商返回限流、提示词违规或超时，Task 状态将由 1 变为 3 (Failed)，而此过程对初始提交 API 响应完全透明。',
    businessSuccessCriteria: [
      '1. 提交 API 返回 code=1 且获取到有效 task_id',
      '2. 轮询 Task 终态确认为 2 (SUCCESS) 且 progress=100',
      '3. Task 产生合法的 video_url，且物理检验通过 (MP4 Box: ftyp, moov, mdat 完整，具备可解码性)',
      '4. 账务流水完成对账：防重复扣费 PASS，扣除额与刊例预期一致',
      '5. 业务产物有效归属于提交时指定的 project_id',
    ],
    credibility: 'CONFIRMED',
  },
  IMAGE_TASK: {
    id: 'task_image_gen',
    name: '生图任务 (Image Generation Task)',
    taskType: 'IMAGE_GEN',
    numericType: 2,
    creationApi: '/aivideo/v2/generate/submit_picture_custom_size',
    parameters: ['project_id', 'row[name]', 'row[selmodelsId]', 'row[extra][prompt]', 'row[extra][resolution]'],
    lifecycle: [
      { status: 1, name: 'QUEUED_OR_PROCESSING', isTerminal: false, isSuccess: false, description: '生图渲染排队' },
      { status: 2, name: 'SUCCESS', isTerminal: true, isSuccess: true, description: '生图完成' },
      { status: 3, name: 'FAILED', isTerminal: true, isSuccess: false, description: '生图失败' },
      { status: 4, name: 'ERROR', isTerminal: true, isSuccess: false, description: '系统异常' },
    ],
    relations: {
      project: { required: true, field: 'project_id', meaning: '所属项目' },
      media: { outputField: 'pic_url', format: 'png/jpg' },
    },
    finalResultExpectation: {
      requiredFields: ['pic_url', 'progress'],
      credibility: 'CONFIRMED',
    },
    differenceFromApiResponse:
      'API 成功仅代表入库排队；若模型服务下线或尺寸不支持，Task 终态会变为 3/4。',
    businessSuccessCriteria: [
      '1. 提交 API 返回 code=1',
      '2. Task 终态为 2 (SUCCESS)',
      '3. 产物图片物理存在，PNG IHDR / JPG 格式完整可解析',
      '4. 积分扣除与分辨率单价一致',
    ],
    credibility: 'CONFIRMED',
  },
};

// ============================================================================
// 6. 已确认测试经验与失败模式 (Experience & Failure Pattern)
// ============================================================================

export interface Experience {
  id: string;
  title: string;
  context: string;
  symptom: string;
  root_cause: string;
  verification: string;
  related_api?: string;
  related_task?: string;
  related_oracle?: string;
  related_model_id?: number;
  related_resolution?: string;
  related_pattern_id?: string;
  confidence: KnowledgeCredibility;
  status?: 'CONFIRMED' | 'PENDING' | 'REJECTED' | 'STALE' | 'ACCEPTED';
  sourceCandidateId?: string;
  promotedAt?: string;
  requiredPlanCheck?: {
    stage: 'PRECONDITION' | 'OPERATION' | 'API_VERIFY' | 'TASK_VERIFY' | 'ORACLE_VERIFY' | 'BUSINESS_RESULT';
    description: string;
    targetObject: string;
    expectedOutcome: string;
    verificationMethod: string;
  };
}

export interface FailurePattern {
  id: string;
  name: string;
  trigger: string;
  symptom: string;
  verification: string;
  related_domain: string[];
  confidence: KnowledgeCredibility;
}

export const PANQU_FAILURE_PATTERNS: Record<string, FailurePattern> = {
  PATTERN_API_SUCCESS_TASK_FAILED: {
    id: 'FP-001',
    name: 'API返回成功但Task实际失败',
    trigger: '异步 Worker 处理超时、上游模型鉴权失效或提示词被敏感词拦截',
    symptom: 'HTTP POST 提交返回 { code: 1, msg: "提交成功" }，但轮询 task_status 最终为 3 (Failed) 或 4 (Error)',
    verification: '绝不能仅凭 API response code=1 就下达 PASS 判定，必须持续轮询到终态，并断言 terminalStatus === 2',
    related_domain: ['Task', 'API_VIDEO_SUBMIT', 'AI_TASKS'],
    confidence: 'CONFIRMED',
  },
  PATTERN_TASK_SUCCESS_NO_ASSET: {
    id: 'FP-002',
    name: 'Task成功但最终业务产物不存在或不可用',
    trigger: '转码上传 OSS 失败、CDN 链接损坏、或回写数据库产物字段丢失',
    symptom: 'Task 状态为 2 (SUCCESS)，但 video_url / pic_url 为空、返回 404 或内容为 0 字节损坏文件',
    verification: '必须物理拉取媒体产物前 64KB，执行 MP4 Box (ftyp/moov/mdat) 或 PNG IHDR 完整性验真，缺失产物标记 FAIL/UNVERIFIED',
    related_domain: ['Task', 'MediaAsset', 'MEDIA_INSPECTOR'],
    confidence: 'CONFIRMED',
  },
  PATTERN_PROJECT_OWNERSHIP_MISMATCH: {
    id: 'FP-003',
    name: '参数隐式所有权关系违背',
    trigger: '提交任务时携带跨项目 project_id 与 folder_id，或操作非本人拥有的项目',
    symptom: '接口可能返回成功但在生成媒体入库时被孤立，或者由于外键权限拦截抛出静默错误',
    verification: '检查 project_id 与 folder_id 的级联归属一致性，测试计划中需覆盖非法 project_id 边界防线',
    related_domain: ['Project', 'Folder', 'Task'],
    confidence: 'CONFIRMED',
  },
  PATTERN_DOUBLE_BILLING: {
    id: 'FP-004',
    name: '任务重复扣费资损缺陷',
    trigger: '前端重试或后端网络超时重试缺乏幂等控制',
    symptom: '同一 task_id 在 pq_score_log 中产生 2 笔或以上 type=2 的扣费记录',
    verification: '严格执行 BillingOracle.antiDoubleBilling 不变量校验，preDeductCount > 1 立即裁决 FAIL',
    related_domain: ['BillingLedger', 'PQ_SCORE_LOG'],
    confidence: 'CONFIRMED',
  },
  PATTERN_FAILED_NO_REFUND: {
    id: 'FP-005',
    name: '失败任务未触发退款资损缺陷',
    trigger: '异步 Worker 在处理异常退出时未捕获异常抛给退款补偿逻辑',
    symptom: 'Task 终态为 3 (Failed)，但 pq_score_log 中无 type=1 退款流水，导致 netDeductedPoints > 0',
    verification: '严格执行 BillingOracle.netChargeZero 不变量校验，失败任务净扣不为 0 立即裁决 FAIL',
    related_domain: ['BillingLedger', 'Task', 'PQ_SCORE_LOG'],
    confidence: 'CONFIRMED',
  },
};

/**
 * 针对历史已确认缺陷模式提供默认标准核验策略后备 (Fallback Helper)
 * 仅用于确保存量/未显式声明 requiredPlanCheck 的条目具备标准核验动作，
 * 核心规划器 core-kernel.ts 统一由 exp.requiredPlanCheck 驱动，不再硬编码特判。
 */
export function resolveDefaultPlanCheck(patternId?: string, topic?: string): Experience['requiredPlanCheck'] | undefined {
  if (patternId === 'FP-004') {
    return {
      stage: 'ORACLE_VERIFY',
      description: `针对 ${topic || 'Wan3.0 双重扣费高发隐患'} 重点防范重试与并发重复扣款 (FP-004)`,
      targetObject: 'BillingLedger',
      expectedOutcome: 'preDeductCount 严格 === 1',
      verificationMethod: 'BillingOracle.reconcileTaskLedger antiDoubleBilling 校验',
    };
  }
  if (patternId === 'FP-005') {
    return {
      stage: 'ORACLE_VERIFY',
      description: `针对 ${topic || '任务失败未退款隐患'} 重点核查异常终态下的退款核销流水与净扣归零 (FP-005)`,
      targetObject: 'BillingLedger',
      expectedOutcome: '若任务非成功终态，必须存在对应退款流水且 netDeducted === 0',
      verificationMethod: 'BillingOracle.reconcileTaskLedger netChargeZero 校验',
    };
  }
  return undefined;
}

/**
 * 动态加载已确认历史经验 (Ingest 阶段)
 * 仅从项目唯一长期知识主源 references/knowledge_candidates.json 读取 ACCEPTED/CONFIRMED 事实，
 * 绝不在运行时直接读取 shared-memory/candidates/inbox.md，避免未审核或未经晋升的候选污染运行时。
 */
export function loadConfirmedExperiences(options: {
  projectRoot?: string;
  sharedMemoryDir?: string;
  extraExperiences?: Experience[];
} = {}): Experience[] {
  const experiences: Experience[] = [];
  const seenIds = new Set<string>();

  // 1. 读取本地技能库的唯一长期知识主源 (仅取 ACCEPTED/CONFIRMED，跳过 PENDING)
  const root = options.projectRoot || process.cwd();
  const candidatesJsonPath = path.resolve(root, '.agents/skills/self-evolving-tester/references/knowledge_candidates.json');
  if (fs.existsSync(candidatesJsonPath)) {
    try {
      const raw = fs.readFileSync(candidatesJsonPath, 'utf8');
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        for (const item of list) {
          if ((item.status === 'ACCEPTED' || item.status === 'CONFIRMED') && item.confidence === 'CONFIRMED') {
            if (!seenIds.has(item.id)) {
              seenIds.add(item.id);
              if (item.sourceCandidateId) {
                seenIds.add(item.sourceCandidateId);
              }
              const patternMatch = (item.claim || '').match(/\[(FP-\d{3})\]/);
              const modelMatch = (item.claim || '').match(/模型\s*#(\d+)/);
              const patternId = item.related_pattern_id || item.relatedPatternId || (patternMatch ? patternMatch[1] : (item.id.startsWith('KC-') ? undefined : item.id));
              const title = item.title || item.claim || item.id;

              experiences.push({
                id: item.id,
                title,
                context: item.context || item.notes || item.claim || '',
                symptom: item.symptom || item.claim || '',
                root_cause: item.root_cause || (item.evidence && item.evidence[0]?.reason) || '已确认经验证据',
                verification: item.verification || (item.evidence && item.evidence[0]?.location) || '验证规则',
                related_api: item.related_api || item.relatedApi,
                related_task: item.related_task || item.relatedTask,
                related_oracle: item.related_oracle || item.relatedOracle,
                related_resolution: item.related_resolution || item.relatedResolution,
                related_pattern_id: patternId,
                related_model_id: item.related_model_id !== undefined ? Number(item.related_model_id) : (item.relatedModelId !== undefined ? Number(item.relatedModelId) : (modelMatch ? Number(modelMatch[1]) : undefined)),
                confidence: 'CONFIRMED',
                status: 'ACCEPTED',
                sourceCandidateId: item.sourceCandidateId,
                promotedAt: item.promotedAt,
                requiredPlanCheck: item.requiredPlanCheck,
              });
            }
          }
        }
      }
    } catch {
      // 容错忽略格式错误
    }
  }

  // 2. 合并外部显式传入的动态经验集合 (供测试或上层显式入参)
  if (options.extraExperiences && Array.isArray(options.extraExperiences)) {
    for (const exp of options.extraExperiences) {
      if (!seenIds.has(exp.id)) {
        seenIds.add(exp.id);
        experiences.push(exp);
      }
    }
  }

  return experiences;
}

/**
 * 确定性历史经验上下文匹配器 (Experience Matching)
 * 严格利用当前真实测试上下文维度，无关经验坚决不污染当前 plan。
 */
export function matchRelevantExperiences(
  experiences: Experience[],
  context: {
    modelId?: number;
    mediaType?: 'video' | 'image';
    resolution?: string;
    flowType?: string;
    requirement?: string;
    apiEndpoint?: string;
    patternId?: string;
  }
): Experience[] {
  return experiences.filter((exp) => {
    // 状态安全阀：未确认的 candidate 绝不能匹配
    if (exp.status === 'PENDING' || exp.status === 'REJECTED' || exp.status === 'STALE') {
      return false;
    }

    // 1. 模型 ID 强隔离检查
    if (exp.related_model_id !== undefined && context.modelId !== undefined) {
      if (exp.related_model_id !== context.modelId) {
        return false;
      }
    } else if (context.modelId !== undefined) {
      // 仅在未显式指定 related_model_id 时从标题与上下文推导特定模型限定
      const text = `${exp.title} ${exp.context}`;
      const modelRegex = /模型\s*(?:ID\s*)?#?(\d+)(?![pkK])|(?:Wan3\.0.*\((\d+)\))|(?:Seedance.*\((\d+)\))/i;
      const m = text.match(modelRegex);
      if (m) {
        const boundModel = Number(m[1] || m[2] || m[3]);
        if (boundModel && boundModel !== context.modelId) {
          return false; // 明确绑定了其他模型，禁止匹配
        }
      }
    }

    // 2. 分辨率规格匹配检查
    if (exp.related_resolution && context.resolution) {
      if (exp.related_resolution.toLowerCase() !== context.resolution.toLowerCase()) {
        return false;
      }
    }

    // 3. API 接口匹配检查
    if (exp.related_api && context.apiEndpoint) {
      if (exp.related_api !== context.apiEndpoint) {
        return false;
      }
    }

    // 4. 任务模态匹配检查
    if (exp.related_task && context.mediaType) {
      if (context.mediaType === 'video' && exp.related_task.includes('IMAGE')) return false;
      if (context.mediaType === 'image' && exp.related_task.includes('VIDEO')) return false;
    }

    // 5. 失败模式指纹匹配检查
    if (context.patternId && exp.related_pattern_id) {
      if (context.patternId !== exp.related_pattern_id) {
        return false;
      }
    }

    return true;
  });
}

// ============================================================================
// 7. 领域上下文解析引擎 (Domain Context Resolver)
// ============================================================================

export interface DomainProbeAnalysis {
  targetDomain: string;
  identifiedObjects: BusinessEntity[];
  applicableApis: ApiKnowledge[];
  applicableOracles: OracleKnowledge[];
  applicableTasks: TaskKnowledge[];
  matchedFailurePatterns: FailurePattern[];
  relevantExperiences: Experience[];
  unknowns: Array<{ area: string; item: string; reason: string }>;
  riskWarnings: string[];
}

export function resolveDomainContext(input: {
  requirement?: string;
  modelId?: number;
  mediaType?: 'video' | 'image';
  taskId?: number;
  flowType?: string;
  extraExperiences?: Experience[];
  projectRoot?: string;
}): DomainProbeAnalysis {
  const req = (input.requirement || '').toLowerCase();
  const mediaType = input.mediaType || (req.includes('图') || req.includes('image') ? 'image' : 'video');
  const targetDomain = mediaType === 'image' ? 'Panqu AI 生图业务域' : 'Panqu AI 视频创作业务域';

  // 1. 识别关联业务实体
  const identifiedObjects: BusinessEntity[] = [
    PANQU_BUSINESS_ENTITIES.Project,
    PANQU_BUSINESS_ENTITIES.Task,
    PANQU_BUSINESS_ENTITIES.MediaAsset,
    PANQU_BUSINESS_ENTITIES.BillingLedger,
  ];
  if (req.includes('文件夹') || req.includes('目录') || req.includes('folder')) {
    identifiedObjects.push(PANQU_BUSINESS_ENTITIES.Folder);
  }

  // 2. 匹配可用 API 契约
  const applicableApis: ApiKnowledge[] = [];
  if (mediaType === 'video') {
    applicableApis.push(PANQU_API_KNOWLEDGE.VIDEO_SUBMIT);
  } else {
    applicableApis.push(PANQU_API_KNOWLEDGE.IMAGE_SUBMIT);
  }
  applicableApis.push(PANQU_API_KNOWLEDGE.TASK_STATUS_POLL);
  applicableApis.push(PANQU_API_KNOWLEDGE.ADMIN_SCORE_QUERY);
  applicableApis.push(PANQU_API_KNOWLEDGE.PERSONAL_BILLING_QUERY);

  // 3. 关联 Oracle 知识
  const applicableOracles: OracleKnowledge[] = [
    PANQU_ORACLE_KNOWLEDGE.AI_TASKS,
    PANQU_ORACLE_KNOWLEDGE.PQ_SCORE_LOG,
    PANQU_ORACLE_KNOWLEDGE.PQ_MEDIA_ASSET,
  ];

  // 4. 关联 Task 知识
  const applicableTasks: TaskKnowledge[] = [
    mediaType === 'video' ? PANQU_TASK_KNOWLEDGE.VIDEO_TASK : PANQU_TASK_KNOWLEDGE.IMAGE_TASK,
  ];

  // 5. 动态加载经验并按真实上下文过滤匹配
  const allExperiences = loadConfirmedExperiences({
    projectRoot: input.projectRoot,
    extraExperiences: input.extraExperiences,
  });
  const relevantExperiences = matchRelevantExperiences(allExperiences, {
    modelId: input.modelId,
    mediaType,
    flowType: input.flowType,
    requirement: input.requirement,
  });

  const matchedFailurePatterns: FailurePattern[] = Object.values(PANQU_FAILURE_PATTERNS);

  // 6. 提取与声明明确的 UNKNOWN 风险项
  const unknowns: Array<{ area: string; item: string; reason: string }> = [
    {
      area: 'Oracle - ai_tasks',
      item: 'extra 字段在 HTTP API 的可见性',
      reason: 'HTTP API 不返回 extra 内部字段，属于已知可见性缺口，必须由只读 DB 验真或标记 MANUAL_DB_EVIDENCE_REQUIRED',
    },
    {
      area: 'Infrastructure',
      item: '底层 Go Consumer 队列重试最大次数与分流消费延迟',
      reason: '未开放只读探针或配置字典，不可假设固定延时',
    },
  ];

  const riskWarnings: string[] = [
    '【高风险排查】：谨防 API 返回成功 (code=1) 但 Task 实际在异步阶段失败 (FP-001)',
    '【产物完整性】：Task 成功必须进一步校验物理媒体文件容器结构，防止空文件假成功 (FP-002)',
    '【账务审计】：必须执行三大计费不变量对账，严禁仅看扣除数字而忽略退款流水 (FP-004 / FP-005)',
  ];

  for (const exp of relevantExperiences) {
    if (!riskWarnings.some((w) => w.includes(exp.title))) {
      riskWarnings.push(`【历史经验告警】针对模型 #${input.modelId ?? '通用'}: ${exp.title} (${exp.symptom})`);
    }
  }

  return {
    targetDomain,
    identifiedObjects,
    applicableApis,
    applicableOracles,
    applicableTasks,
    matchedFailurePatterns,
    relevantExperiences,
    unknowns,
    riskWarnings,
  };
}

// ============================================================================
// 8. 领域驱动测试计划构建器 (Domain Test Plan Builder)
// ============================================================================

export interface DomainExecutionStep {
  stage: 'PRECONDITION' | 'OPERATION' | 'API_VERIFY' | 'TASK_VERIFY' | 'ORACLE_VERIFY' | 'BUSINESS_RESULT';
  description: string;
  targetObject: string;
  expectedOutcome: string;
  credibility: KnowledgeCredibility;
  verificationMethod: string;
}

export interface DomainExecutionPlan {
  summary: string;
  businessGoal: string;
  steps: DomainExecutionStep[];
  confidenceLevel: KnowledgeCredibility;
  caveats: string[];
  relevantExperiences?: Experience[];
}

export function generateDomainExecutionPlan(input: {
  modelId: number;
  mediaType: 'video' | 'image';
  resolution?: string;
  duration?: number;
  flowType?: string;
  requirement?: string;
  expectedPoints: number;
  extraExperiences?: Experience[];
  projectRoot?: string;
}): DomainExecutionPlan {
  const { modelId, mediaType, expectedPoints } = input;
  const isVideo = mediaType === 'video';

  const steps: DomainExecutionStep[] = [
    {
      stage: 'PRECONDITION',
      description: '核验测试环境会话凭据、可用积分余额与归属 project_id 有效性',
      targetObject: 'Project',
      expectedOutcome: `具备有效 Cookie/CSRF，且账户积分 >= ${expectedPoints} pt`,
      credibility: 'CONFIRMED',
      verificationMethod: 'probe() 环境连通性与凭据探测',
    },
    {
      stage: 'OPERATION',
      description: `调用 ${isVideo ? '视频' : '生图'} 提交接口，传入合法模型规格与业务项目参数`,
      targetObject: 'Task',
      expectedOutcome: '向主站发起 HTTP POST，携带 project_id 与 prompt',
      credibility: 'CONFIRMED',
      verificationMethod: 'execute() 任务提交',
    },
    {
      stage: 'API_VERIFY',
      description: '校验任务提交 API 响应结果',
      targetObject: 'API',
      expectedOutcome: 'HTTP 200，code === 1，成功获得非空业务 taskId',
      credibility: 'CONFIRMED',
      verificationMethod: '断言 res.ok === true && res.taskId > 0',
    },
    {
      stage: 'TASK_VERIFY',
      description: '轮询 /aivideo/v2/task_status/apiGetStatus 跟踪异步任务生命周期',
      targetObject: 'Task',
      expectedOutcome: 'Task 状态由 1 (排队/处理中) 演进并最终确认为 2 (SUCCESS)，progress === 100',
      credibility: 'CONFIRMED',
      verificationMethod: 'pollTaskStatus() 跟踪，断言 terminalStatus === "SUCCESS"',
    },
    {
      stage: 'ORACLE_VERIFY',
      description: '审计积分流水账本，核验防重复扣款、退款幂等及扣费数额',
      targetObject: 'BillingLedger',
      expectedOutcome: `产生且仅产生 1 笔预扣流水，预扣积分与刊例相符 (${expectedPoints} pt)`,
      credibility: 'CONFIRMED',
      verificationMethod: 'BillingOracle.reconcileTaskLedger() 三大不变量断言',
    },
    {
      stage: 'BUSINESS_RESULT',
      description: `物理拉取媒体产物直链，核验二进制文件容器完整性及与 Task 的真实归属`,
      targetObject: 'MediaAsset',
      expectedOutcome: `${isVideo ? 'MP4 容器结构解析通过 (ftyp/moov/mdat)' : '图片容器结构解析通过 (IHDR)'}，ownership === VERIFIED`,
      credibility: 'CONFIRMED',
      verificationMethod: 'media-inspector 二进制深度检测与 TaskSnapshot 绑定核验',
    },
  ];

  const caveats: string[] = [
    '严禁以 API code=1 直接判定整个测试 PASS',
    'Task 失败时必须触发失败退款验证（净扣必须归零）',
  ];

  // 动态加载并匹配相关经验，真正改变 plan 计划步骤
  const allExperiences = loadConfirmedExperiences({
    projectRoot: input.projectRoot,
    extraExperiences: input.extraExperiences,
  });
  const relevant = matchRelevantExperiences(allExperiences, {
    modelId,
    mediaType,
    resolution: input.resolution,
    flowType: input.flowType,
    requirement: input.requirement,
  });

  for (const exp of relevant) {
    if (exp.requiredPlanCheck) {
      steps.push({
        stage: exp.requiredPlanCheck.stage,
        description: `[历史经验核验] ${exp.requiredPlanCheck.description}`,
        targetObject: exp.requiredPlanCheck.targetObject,
        expectedOutcome: exp.requiredPlanCheck.expectedOutcome,
        credibility: 'CONFIRMED',
        verificationMethod: exp.requiredPlanCheck.verificationMethod,
      });
    }

    caveats.push(`[历史经验告警]: ${exp.title} - ${exp.symptom}`);
  }

  return {
    summary: `Panqu 业务全链路测试方案: 模型 #${modelId} (${mediaType})`,
    businessGoal: `验证模型 #${modelId} 在 Panqu 真实业务场景下的从前置准备、接口提交、异步消费到产物入库与计费对账闭环`,
    steps,
    confidenceLevel: 'CONFIRMED',
    caveats,
    relevantExperiences: relevant,
  };
}

/**
 * 结构化格式化 Memory Candidate 提案 (Record 阶段)
 * 仅用于产生数据结构，保持 verify 只读无任何写磁盘副作用
 */
export function formatMemoryCandidate(input: {
  taskId: number;
  modelId: number;
  mediaType: 'video' | 'image';
  matchedFailurePatterns: string[];
  reasons: string[];
  terminalStatus?: string;
}): MemoryCandidatePayload | undefined {
  if (input.matchedFailurePatterns.length === 0 && input.reasons.length === 0) {
    return undefined;
  }
  // 严重级优先级排序：资损 (FP-004, FP-005) > 产物损坏 (FP-002) > 关系违背 (FP-003) > 状态不一致 (FP-001)
  const priorityOrder = ['FP-004', 'FP-005', 'FP-002', 'FP-003', 'FP-001'];
  const patternId = priorityOrder.find((p) => input.matchedFailurePatterns.includes(p)) || input.matchedFailurePatterns[0] || 'FP-UNKNOWN';
  const patternObj = Object.values(PANQU_FAILURE_PATTERNS).find((p) => p.id === patternId);
  const patternName = patternObj ? patternObj.name : patternId;

  return {
    agent: 'trae',
    topic: `[${patternId}] 业务风险模式: ${patternName} (模型 #${input.modelId})`,
    content: `Task #${input.taskId} 终态 ${input.terminalStatus || 'FAILED'}: ${input.reasons.join('; ')}`,
    dest: 'L2-state/active-projects.md',
    patternId,
    modelId: input.modelId,
    taskId: input.taskId,
    confidence: 'CONFIRMED',
    reasons: input.reasons,
  };
}

/**
 * 外层记录 Candidate 到 shared-memory 缓冲池 (含严格内容去重防污染)
 * 仅由外层 MCP/CLI 在 verify 之后按需调用，verify 内核保持 100% 只读。
 */
export function recordCandidateToSharedMemory(
  candidate: MemoryCandidatePayload,
  sharedMemoryDir: string = '/Users/mac/agents/shared-memory'
): { recorded: boolean; reason: string; candidateId?: string } {
  try {
    const inboxPath = path.resolve(sharedMemoryDir, 'candidates', 'inbox.md');
    if (!fs.existsSync(inboxPath)) {
      return { recorded: false, reason: 'SHARED_MEMORY_INBOX_NOT_FOUND' };
    }

    const currentContent = fs.readFileSync(inboxPath, 'utf8');

    // 内容去重 (Deduplication): 检查是否已包含相同模式与模型
    if (
      currentContent.includes(candidate.topic) ||
      (candidate.patternId && candidate.modelId && currentContent.includes(`[${candidate.patternId}]`) && currentContent.includes(`模型 #${candidate.modelId}`))
    ) {
      return { recorded: false, reason: 'DUPLICATE_CANDIDATE_SKIPPED' };
    }

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    const timeStr = now.toTimeString().slice(0, 5).replace(/:/g, '');
    const candId = `CAND-${dateStr}-${timeStr}`;
    const formattedDate = now.toISOString().slice(0, 10);

    const entry = `
- [ ] **[${candId}]** 来源: \`${candidate.agent}\` | 提交日期: ${formattedDate}
  - **主题**: ${candidate.topic}
  - **提议内容**: ${candidate.content}
  - **建议归宿**: ${candidate.dest || 'L2-state/active-projects.md'}
`;

    fs.appendFileSync(inboxPath, entry, 'utf8');
    return { recorded: true, reason: 'CANDIDATE_RECORDED', candidateId: candId };
  } catch (err) {
    return { recorded: false, reason: `WRITE_ERROR: ${(err as Error).message}` };
  }
}

export interface PromoteOptions {
  projectRoot?: string;
  sharedMemoryDir?: string;
  inboxPath?: string;
  candidatesJsonPath?: string;
  dryRun?: boolean;
}

export interface PromotionReportItem {
  candidateId: string;
  status: 'PROMOTED' | 'ALREADY_PROMOTED' | 'DUPLICATE_CONTENT_SKIPPED' | 'INVALID_CANDIDATE_SKIPPED';
  knowledgeId?: string;
  reason: string;
}

export interface PromotionReport {
  totalScanned: number;
  confirmedCount: number;
  promotedCount: number;
  alreadyPromotedCount: number;
  skippedCount: number;
  items: PromotionReportItem[];
}

/**
 * 最小候选晋升机制 (Promotion Pipeline: Confirmed Experience -> Persistent Knowledge)
 * 仅由离线流程、CLI 或 MCP 显式调用。严格只读 inbox.md，仅对经人工审核 (- [x]) 的条目
 * 执行幂等校验与去重后写入 knowledge_candidates.json。
 */
export function promoteConfirmedExperiences(options: PromoteOptions = {}): PromotionReport {
  const root = options.projectRoot || process.cwd();
  const smDir = options.sharedMemoryDir || '/Users/mac/agents/shared-memory';
  const inboxPath = options.inboxPath || path.resolve(smDir, 'candidates', 'inbox.md');
  const candidatesJsonPath =
    options.candidatesJsonPath ||
    path.resolve(root, '.agents/skills/self-evolving-tester/references/knowledge_candidates.json');

  const report: PromotionReport = {
    totalScanned: 0,
    confirmedCount: 0,
    promotedCount: 0,
    alreadyPromotedCount: 0,
    skippedCount: 0,
    items: [],
  };

  if (!fs.existsSync(inboxPath)) {
    return report;
  }

  // 1. 读取并解析 inbox.md
  const inboxContent = fs.readFileSync(inboxPath, 'utf8');
  const candBlockRegex = /-\s*\[([ xX])\]\s*\*\*\[(CAND-[^\]]+)\]\*\*\s*来源:\s*`?([^`\n]+)`?[^\n]*\n([\s\S]*?)(?=(?:-\s*\[[ xX]\]|$))/g;

  // 2. 读取现有 knowledge_candidates.json
  let knowledgeList: any[] = [];
  if (fs.existsSync(candidatesJsonPath)) {
    try {
      const raw = fs.readFileSync(candidatesJsonPath, 'utf8');
      knowledgeList = JSON.parse(raw);
      if (!Array.isArray(knowledgeList)) {
        knowledgeList = [];
      }
    } catch {
      knowledgeList = [];
    }
  }

  let match;
  let hasNewPromotion = false;

  while ((match = candBlockRegex.exec(inboxContent)) !== null) {
    report.totalScanned++;
    const isChecked = match[1].toLowerCase() === 'x';
    const candId = match[2].trim();
    const agent = match[3].trim();
    const body = match[4].trim();

    // 规则 1: 仅 - [x] 允许进入 promotion，- [ ] 严格拒绝
    if (!isChecked) {
      report.skippedCount++;
      report.items.push({
        candidateId: candId,
        status: 'INVALID_CANDIDATE_SKIPPED',
        reason: 'CANDIDATE_NOT_CONFIRMED (未勾选 - [x])',
      });
      continue;
    }

    report.confirmedCount++;

    // 规则 2: 解析主题、内容、目标归宿
    const topicMatch = body.match(/-\s*\*\*主题\*\*:\s*([^\n]+)/);
    const contentMatch = body.match(/-\s*\*\*提议内容\*\*:\s*([^\n]+)/);

    const topic = topicMatch ? topicMatch[1].trim() : `Candidate ${candId}`;
    const content = contentMatch ? contentMatch[1].trim() : body;

    const patternMatch = topic.match(/\[(FP-\d{3})\]/) || content.match(/\[(FP-\d{3})\]/);
    const modelMatch = topic.match(/模型\s*#(\d+)/) || content.match(/模型\s*#(\d+)/);
    const patternId = patternMatch ? patternMatch[1] : undefined;
    const modelId = modelMatch ? Number(modelMatch[1]) : undefined;

    // 规则 3: 幂等性检查 (同一 Candidate 不得重复晋升)
    const alreadyPromoted = knowledgeList.some((k) => k.sourceCandidateId === candId);
    if (alreadyPromoted) {
      report.alreadyPromotedCount++;
      report.items.push({
        candidateId: candId,
        status: 'ALREADY_PROMOTED',
        reason: 'CANDIDATE_ALREADY_PROMOTED (sourceCandidateId 已存在)',
      });
      continue;
    }

    // 规则 4: 内容去重 (相同 patternId + modelId 或完全相同的 claim 拒绝重复插入)
    const isDuplicateContent = knowledgeList.some((k) => {
      if (k.claim === topic) return true;
      if (
        patternId &&
        modelId !== undefined &&
        (k.related_pattern_id === patternId || k.relatedPatternId === patternId) &&
        (k.related_model_id === modelId || k.relatedModelId === modelId)
      ) {
        return true;
      }
      return false;
    });

    if (isDuplicateContent) {
      report.skippedCount++;
      report.items.push({
        candidateId: candId,
        status: 'DUPLICATE_CONTENT_SKIPPED',
        reason: 'DUPLICATE_PATTERN_AND_MODEL_EXIST (已存在相同模式与模型的知识)',
      });
      continue;
    }

    // 规则 5: 构建符合 schema 的结构化条目
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    const nextSeq = String(knowledgeList.length + 1).padStart(2, '0');
    const newId = `KC-${todayStr}-${nextSeq}`;

    let domain: 'Task' | 'Billing' | 'Media' | 'Routing' = 'Task';
    if (patternId === 'FP-004' || patternId === 'FP-005') domain = 'Billing';
    else if (patternId === 'FP-002') domain = 'Media';
    else if (patternId === 'FP-001' || patternId === 'FP-003') domain = 'Task';

    const newKnowledgeEntry: Record<string, any> = {
      id: newId,
      claim: topic,
      evidence: [
        {
          source: 'shared-memory/candidates/inbox.md',
          location: candId,
          reason: content,
        },
      ],
      confidence: 'CONFIRMED',
      domain,
      status: 'ACCEPTED',
      derived_from: [
        `shared-memory/candidates/inbox.md: ${candId}`,
        `agent: ${agent}`,
      ],
      notes: content,
      sourceCandidateId: candId,
      promotedAt: now.toISOString(),
      related_pattern_id: patternId,
      related_model_id: modelId,
    };

    const defaultCheck = resolveDefaultPlanCheck(patternId, topic);
    if (defaultCheck) {
      newKnowledgeEntry.requiredPlanCheck = defaultCheck;
    }

    knowledgeList.push(newKnowledgeEntry);
    hasNewPromotion = true;
    report.promotedCount++;
    report.items.push({
      candidateId: candId,
      status: 'PROMOTED',
      knowledgeId: newId,
      reason: 'CANDIDATE_SUCCESSFULLY_PROMOTED',
    });
  }

  // 3. 写入知识库 (如非 dryRun 且有新增)
  if (hasNewPromotion && !options.dryRun) {
    const parentDir = path.dirname(candidatesJsonPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
    fs.writeFileSync(candidatesJsonPath, JSON.stringify(knowledgeList, null, 2) + '\n', 'utf8');
  }

  return report;
}

// ============================================================================
// 9. 业务级验真评估器 (Business-level Verification Evaluator)
// ============================================================================

export interface BusinessVerificationInput {
  taskId: number;
  modelId: number;
  mediaType: 'video' | 'image';
  apiResult?: { ok: boolean; code?: number; message?: string };
  taskTerminalStatus: 'SUCCESS' | 'FAILED' | 'TIMEOUT' | 'UNKNOWN';
  mediaEvidence: {
    status: 'PASS' | 'FAIL' | 'UNVERIFIED';
    format?: string;
    decodable?: boolean;
    ownership: 'VERIFIED' | 'UNVERIFIED';
    reason?: string;
  };
  billingEvidence: {
    status: 'PASS' | 'FAIL' | 'UNVERIFIED';
    netDeductedPoints?: number;
    expectedPoints?: number;
    reason?: string;
  };
  invariantsEvidence: {
    status: 'PASS' | 'FAIL' | 'UNVERIFIED';
    antiDoubleBilling?: boolean;
    netChargeZero?: boolean;
    refundIdempotency?: boolean;
    reason?: string;
  };
  paramRelations?: {
    projectId?: number;
    folderId?: number;
    isFolderInProject?: boolean;
  };
}

export interface BusinessVerificationResult {
  status: 'PASS' | 'FAIL' | 'UNVERIFIED';
  technicalSuccess: boolean;
  businessSuccess: boolean;
  verdictDetail: {
    apiVerified: boolean;
    taskStateVerified: boolean;
    artifactBound: boolean;
    oracleConsistent: boolean;
    relationsValid: boolean;
  };
  matchedFailurePatterns: string[];
  reasons: string[];
  credibility: KnowledgeCredibility;
}

/**
 * 业务级验真核心函数：
 * 明确区分 Technical Success (API 200/入队) 与 Business Success (真正业务成功)
 */
export function evaluateBusinessVerification(input: BusinessVerificationInput): BusinessVerificationResult {
  const reasons: string[] = [];
  const matchedPatterns: string[] = [];

  const apiOk = input.apiResult ? input.apiResult.ok && (input.apiResult.code === 1 || input.apiResult.code === 200) : true;
  const taskSuccess = input.taskTerminalStatus === 'SUCCESS';
  const taskFailed = input.taskTerminalStatus === 'FAILED';
  const taskUnknown = input.taskTerminalStatus === 'UNKNOWN' || input.taskTerminalStatus === 'TIMEOUT';

  // 1. 问题 1 识别：API 返回成功，但 Task 实际失败 (Technical Success ≠ Business Success)
  if (apiOk && taskFailed) {
    matchedPatterns.push(PANQU_FAILURE_PATTERNS.PATTERN_API_SUCCESS_TASK_FAILED.id);
    reasons.push(
      `[业务失败 FP-001] API 提交返回成功，但异步 Task #${input.taskId} 终态为 FAILED (Technical Success ≠ Business Success)`
    );
  }

  // 2. 问题 2 识别：Task 标记成功，但业务产物不存在或损坏
  if (taskSuccess) {
    if (input.mediaEvidence.status === 'FAIL') {
      matchedPatterns.push(PANQU_FAILURE_PATTERNS.PATTERN_TASK_SUCCESS_NO_ASSET.id);
      reasons.push(
        `[业务失败 FP-002] Task #${input.taskId} 状态标记为成功，但业务媒体产物损坏无法解码: ${input.mediaEvidence.reason || '文件损坏'}`
      );
    } else if (input.mediaEvidence.status === 'UNVERIFIED') {
      reasons.push(
        `[产物未验真] Task #${input.taskId} 产物缺少有效物理证据或未证明归属绑定 [UNVERIFIED]`
      );
    }
  }

  // 3. 问题 3 识别：参数隐式业务关系违背 (跨项目/文件夹)
  let relationsValid = true;
  if (input.paramRelations) {
    if (input.paramRelations.folderId !== undefined && input.paramRelations.isFolderInProject === false) {
      relationsValid = false;
      matchedPatterns.push(PANQU_FAILURE_PATTERNS.PATTERN_PROJECT_OWNERSHIP_MISMATCH.id);
      reasons.push(
        `[业务关系违背 FP-003] folderId (${input.paramRelations.folderId}) 不属于当前 projectId (${input.paramRelations.projectId})`
      );
    }
  }

  // 4. 账务资损核验
  if (input.billingEvidence.status === 'FAIL') {
    reasons.push(`[账务对账失败] ${input.billingEvidence.reason || '计费扣除与刊例不符'}`);
  }
  if (input.invariantsEvidence.antiDoubleBilling === false) {
    matchedPatterns.push(PANQU_FAILURE_PATTERNS.PATTERN_DOUBLE_BILLING.id);
    reasons.push('[资损告警 FP-004] 存在重复预扣流水，违背防重复扣费不变量');
  }
  if (input.invariantsEvidence.netChargeZero === false) {
    matchedPatterns.push(PANQU_FAILURE_PATTERNS.PATTERN_FAILED_NO_REFUND.id);
    reasons.push('[资损告警 FP-005] 失败任务净扣不为 0 或少/超额退款，违背失败净扣归零不变量');
  }

  // 综合评定
  const technicalSuccess = apiOk;
  const artifactBound = input.mediaEvidence.status === 'PASS' && input.mediaEvidence.ownership === 'VERIFIED';
  const oracleConsistent = input.billingEvidence.status === 'PASS' && input.invariantsEvidence.status === 'PASS';
  const taskStateVerified = taskSuccess;

  const hasAnyFail =
    !apiOk ||
    taskFailed ||
    input.mediaEvidence.status === 'FAIL' ||
    input.billingEvidence.status === 'FAIL' ||
    input.invariantsEvidence.status === 'FAIL' ||
    !relationsValid ||
    matchedPatterns.length > 0;

  const allBusinessPassed =
    apiOk &&
    taskSuccess &&
    artifactBound &&
    oracleConsistent &&
    relationsValid &&
    matchedPatterns.length === 0;

  let status: 'PASS' | 'FAIL' | 'UNVERIFIED';
  let businessSuccess = false;

  if (hasAnyFail) {
    status = 'FAIL';
    businessSuccess = false;
  } else if (allBusinessPassed) {
    status = 'PASS';
    businessSuccess = true;
  } else {
    status = 'UNVERIFIED';
    businessSuccess = false;
  }

  return {
    status,
    technicalSuccess,
    businessSuccess,
    verdictDetail: {
      apiVerified: apiOk,
      taskStateVerified,
      artifactBound,
      oracleConsistent,
      relationsValid,
    },
    matchedFailurePatterns: matchedPatterns,
    reasons,
    credibility: 'CONFIRMED',
  };
}
