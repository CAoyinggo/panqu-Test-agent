/**
 * Panqu AI DevTest — 数据库只读取证适配器 (Database Evidence Producer)
 *
 * 遵循 docs/ARCHITECTURE_FREEZE.md 与 AGENTS.md 强制数据变更核验红线：
 * 1. 沿现有 EvidenceProducer → Evidence Envelope → Verdict 边界实现，仅收集数据库只读事实，零业务裁决权；
 * 2. 自动加载 db-credentials.json，通过 SSH 隧道模式（跳板机 115.191.19.88:22）安全建立只读连接；
 * 3. 严格执行只读原则 (SELECT ONLY)，绝不向数据库写入任何数据；
 * 4. 严禁打印、记录、提交或暴露明文凭据与私密信息；
 * 5. 连接失败、记录缺失、流水不一致时严格 fail-closed 为 UNVERIFIED / FAIL，绝不凭 HTTP 200 假 PASS。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CanonicalEvidenceEnvelope, EvidenceSourceType } from './canonical-protocol.js';
import type { EvidenceProducer, EvidenceProducerContext } from './execution-ports.js';
import type { ScoreLogEntry } from './billing.js';

const execFileAsync = promisify(execFile);

export interface DatabaseRecordFound {
  pq_aivideo_new?: Record<string, unknown>;
  // 图片任务按模式分四张源表（NON-video）：Goods/Character/Scene/Fusion
  pq_aivideo_goods?: Record<string, unknown>;
  pq_aivideo_character?: Record<string, unknown>;
  pq_aivideo_scene?: Record<string, unknown>;
  pq_aivideo_fusion?: Record<string, unknown>;
  pq_volcengine_ai_task?: Record<string, unknown>;
  pq_score_log?: Array<Record<string, unknown>>;
  user_score_logs?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

/** 图片"前台任务源表"（视频用 pq_aivideo_new）。按 add() 四类生图模式分表。 */
export const IMAGE_FRONTEND_TABLES = [
  'pq_aivideo_goods',
  'pq_aivideo_character',
  'pq_aivideo_scene',
  'pq_aivideo_fusion',
] as const;

/**
 * 解析"前台任务源表"物理记录（媒体无关消费入口）：视频=pq_aivideo_new；
 * 图片=goods/character/scene/fusion 取首个命中。返回记录及其真实表名（用于 provenance）。
 * 注意：各源表 id 空间独立且重叠，取证脚本已按 mediaType 只查正确表，故此处顺序回退即可。
 */
export function resolveFrontendTaskRecord(recordsFound: DatabaseRecordFound | undefined): {
  record?: Record<string, unknown>;
  table?: string;
} {
  if (!recordsFound) return {};
  if (recordsFound.pq_aivideo_new) return { record: recordsFound.pq_aivideo_new, table: 'pq_aivideo_new' };
  for (const t of IMAGE_FRONTEND_TABLES) {
    const rec = recordsFound[t] as Record<string, unknown> | undefined;
    if (rec) return { record: rec, table: t };
  }
  return {};
}

export interface DatabaseRawCollection {
  status: 'VERIFIED' | 'UNVERIFIED';
  taskId?: string | number | null;
  userId?: string | number | null;
  recordsFound: DatabaseRecordFound;
  error?: string;
  reason?: string;
  credPath?: string;
  queriedAt?: string;
}

export interface DatabaseQueryOptions {
  taskId?: string | number | null;
  userId?: string | number | null;
  credPath?: string;
  scriptPath?: string;
  timeoutMs?: number;
  mediaType?: 'video' | 'image';
}

/**
 * 自动定位 db-credentials.json 路径
 */
export function resolveDatabaseCredentialsPath(explicitPath?: string): string | undefined {
  if (explicitPath && existsSync(explicitPath)) return explicitPath;
  if (process.env.DB_CRED_PATH && existsSync(process.env.DB_CRED_PATH)) {
    return process.env.DB_CRED_PATH;
  }

  // 尝试相对当前模块、当前工作目录及标准配置目录
  const currentDir = typeof __dirname !== 'undefined' ? __dirname : fileURLToPath(new URL('.', import.meta.url));
  const candidates = [
    join(process.cwd(), 'db-credentials.json'),
    join(currentDir, '..', '..', 'db-credentials.json'),
    join(currentDir, '..', '..', '..', 'db-credentials.json'),
    '/Users/mac/agents/test-flow/db-credentials.json',
    '/Users/mac/agents/test-Configuration/db-credentials.json',
  ];

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return undefined;
}

/**
 * 自动定位 verify-db-change.py 脚本路径
 */
function resolveScriptPath(): string | undefined {
  const currentDir = typeof __dirname !== 'undefined' ? __dirname : fileURLToPath(new URL('.', import.meta.url));
  const candidates = [
    join(process.cwd(), 'scripts', 'verify-db-change.py'),
    join(currentDir, '..', '..', 'scripts', 'verify-db-change.py'),
    join(currentDir, '..', '..', '..', 'scripts', 'verify-db-change.py'),
    '/Users/mac/agents/test-flow/scripts/verify-db-change.py',
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return undefined;
}

/**
 * 脱敏错误信息，严禁在日志或返回值中泄漏数据库账号或密码
 */
export function sanitizeErrorMessage(msg: string): string {
  if (!msg) return '';
  return msg
    .replace(/(?:password|pwd|secret|key)["']?\s*[:=]\s*["']?[^"'}\s]+/gi, '$1=***REDACTED***')
    .replace(/\/\/[^:]+:[^@]+@/g, '//***:***@');
}

/**
 * 可注入的脚本执行器抽象（默认走真实 execFile 子进程；测试可注入假执行器，
 * 100% 离线覆盖成功解析 / 失败脱敏 / fail-closed 等编排分支，无需真实数据库或 SSH）。
 */
export type DbScriptRunner = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number },
) => Promise<{ stdout: string }>;

/**
 * 执行 Python 取证脚本并获取 JSON 结果 (Strictly Read-Only)
 */
export async function queryDatabasePhysicalFacts(
  options: DatabaseQueryOptions,
  runner: DbScriptRunner = (file, args, opts) => execFileAsync(file, args, opts),
): Promise<DatabaseRawCollection> {
  const credPath = resolveDatabaseCredentialsPath(options.credPath);
  const queriedAt = new Date().toISOString();

  if (!credPath) {
    return {
      status: 'UNVERIFIED',
      taskId: options.taskId,
      userId: options.userId,
      reason: 'MISSING_CREDENTIALS',
      error: '找不到 db-credentials.json 数据库凭据文件，无法通过 SSH 隧道执行物理取证 [UNVERIFIED]',
      recordsFound: {},
      queriedAt,
    };
  }

  const scriptPath = options.scriptPath ?? resolveScriptPath();

  if (!scriptPath || !existsSync(scriptPath)) {
    return {
      status: 'UNVERIFIED',
      taskId: options.taskId,
      userId: options.userId,
      reason: 'SCRIPT_NOT_FOUND',
      error: `取证脚本不存在: ${scriptPath || 'scripts/verify-db-change.py'} [UNVERIFIED]`,
      recordsFound: {},
      credPath,
      queriedAt,
    };
  }

  const args = [scriptPath, '--cred-path', credPath, '--json'];
  if (options.taskId !== undefined && options.taskId !== null && options.taskId !== '') {
    args.push('--task-id', String(options.taskId));
  }
  if (options.userId !== undefined && options.userId !== null && options.userId !== '') {
    args.push('--user-id', String(options.userId));
  }
  if (options.mediaType) {
    args.push('--media-type', options.mediaType);
  }

  const timeoutMs = options.timeoutMs ?? 15000;

  try {
    const { stdout } = await runner('python3', args, {
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });

    const parsed = JSON.parse(stdout.trim()) as DatabaseRawCollection;
    return {
      ...parsed,
      credPath,
      queriedAt,
    };
  } catch (err: unknown) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    const sanitized = sanitizeErrorMessage(rawMsg);
    return {
      status: 'UNVERIFIED',
      taskId: options.taskId,
      userId: options.userId,
      reason: 'DB_QUERY_FAILED',
      error: `数据库 SSH 隧道取证执行失败: ${sanitized} [UNVERIFIED]`,
      recordsFound: {},
      credPath,
      queriedAt,
    };
  }
}

/**
 * 将数据库 pq_score_log 记录映射为 DevTest 账务流水 ScoreLogEntry[]
 * 支持针对重试任务精确隔离最新调度批次的 task_id
 */
export function mapDbScoreLogsToScoreLogEntries(
  dbLogs: Array<Record<string, unknown>>,
  targetTaskId?: number,
  backendTaskId?: number,
): ScoreLogEntry[] {
  if (!Array.isArray(dbLogs) || dbLogs.length === 0) {
    return [];
  }

  // 1. 若指定了最新后台调度任务编号 (pq_volcengine_ai_task.id)，优先匹配该次调度的流水
  let filteredLogs = dbLogs;
  if (backendTaskId !== undefined) {
    const matchedBackend = dbLogs.filter((r) => r.task_id !== undefined && Number(r.task_id) === Number(backendTaskId));
    if (matchedBackend.length > 0) {
      filteredLogs = matchedBackend;
    }
  }

  // 2. 映射字段
  return filteredLogs.map((r) => {
    const isSourceIdMatch =
      targetTaskId !== undefined && r.source_id !== undefined && Number(r.source_id) === targetTaskId;
    const memoStr = String(r.remark || r.source_name || r.memo || '');
    const parsedTaskId = isSourceIdMatch
      ? targetTaskId
      : targetTaskId !== undefined && r.task_id !== undefined && Number(r.task_id) === targetTaskId
        ? targetTaskId
        : targetTaskId !== undefined && memoStr.includes(String(targetTaskId))
          ? targetTaskId
          : (targetTaskId ?? (r.source_id !== undefined ? Number(r.source_id) : Number(r.task_id)));

    return {
      id: r.id !== undefined ? String(r.id) : undefined,
      task_id: parsedTaskId,
      type: Number(r.type),
      score: Number(r.score || 0),
      memo: memoStr || `task_id=${r.task_id} source_id=${r.source_id}`,
      createtime: r.createtime ? String(r.createtime) : undefined,
    };
  });
}

/**
 * DatabaseEvidenceProducer (只读取证适配器)
 * 实现 EvidenceProducer 最小标准端口，采集数据库物理落库与积分流水证据信封
 */
export class DatabaseEvidenceProducer implements EvidenceProducer {
  readonly producerName = 'database-evidence-producer';
  readonly sourceType: EvidenceSourceType = 'SERVER_API';

  async produce(rawCollection: unknown, context: EvidenceProducerContext): Promise<CanonicalEvidenceEnvelope[]> {
    const envelopes: CanonicalEvidenceEnvelope[] = [];
    const testId = context.testId || `db-evidence-${Date.now()}`;
    const environment = context.environment || 'test';
    const taskIdNum =
      typeof context.taskId === 'number'
        ? context.taskId
        : typeof context.taskId === 'string' && !isNaN(Number(context.taskId))
          ? Number(context.taskId)
          : undefined;
    const subjectId: string | number =
      taskIdNum ??
      (typeof context.subjectId === 'string' || typeof context.subjectId === 'number' ? context.subjectId : 0);
    const capturedAt = (typeof context.capturedAt === 'string' && context.capturedAt) || new Date().toISOString();

    // 1. 解析已有原始数据，或按需执行真实取证
    let raw: DatabaseRawCollection;
    if (
      rawCollection &&
      typeof rawCollection === 'object' &&
      'recordsFound' in (rawCollection as Record<string, unknown>)
    ) {
      raw = rawCollection as DatabaseRawCollection;
    } else if (taskIdNum !== undefined) {
      const ctxMediaType = (context as { mediaType?: 'video' | 'image' }).mediaType;
      raw = await queryDatabasePhysicalFacts({ taskId: taskIdNum, mediaType: ctxMediaType });
    } else {
      raw = {
        status: 'UNVERIFIED',
        taskId: taskIdNum,
        reason: 'NO_RAW_DATA_OR_TASK_ID',
        error: '未提供 rawCollection 且缺少 taskId，无法执行数据库取证',
        recordsFound: {},
        queriedAt: capturedAt,
      };
    }

    const { recordsFound } = raw;
    // 媒体无关地解析前台任务源表记录（视频=pq_aivideo_new；图片=goods/character/scene/fusion）
    const { record: aivideoRec, table: frontendTable } = resolveFrontendTaskRecord(recordsFound);
    const volcengineRec = recordsFound.pq_volcengine_ai_task;
    const scoreLogs = recordsFound.pq_score_log;

    // ------------------------------------------------------------------------
    // 信封 1: SERVER_API:DB_TASK_RECORD (前后台任务物理落库事实)
    // ------------------------------------------------------------------------
    const hasTaskRecord = Boolean(aivideoRec || volcengineRec);
    let extraObj: Record<string, unknown> | undefined;
    if (aivideoRec?.extra) {
      try {
        extraObj =
          typeof aivideoRec.extra === 'string'
            ? JSON.parse(aivideoRec.extra)
            : (aivideoRec.extra as Record<string, unknown>);
      } catch {
        extraObj = undefined;
      }
    }

    const taskObservationStatus = raw.status === 'VERIFIED' && hasTaskRecord ? 'PASS' : 'UNVERIFIED';

    envelopes.push({
      evidenceId: `${testId}-db-task-record`,
      testId,
      sourceTool: this.producerName,
      sourceType: 'SERVER_API',
      evidenceKey: 'SERVER_API:DB_TASK_RECORD',
      observationStatus: taskObservationStatus,
      capturedAt,
      environment,
      subjectType: 'task',
      subjectId,
      normalizedFields: {
        taskFound: Boolean(aivideoRec),
        backendTaskFound: Boolean(volcengineRec),
        frontendId: aivideoRec?.id,
        frontendStatus: aivideoRec?.task_status,
        frontendError: aivideoRec?.err,
        backendId: volcengineRec?.id,
        backendStatus: volcengineRec?.status,
        volcanoTaskId: volcengineRec?.task_id,
        videoUrl: aivideoRec?.video_url,
        extra: extraObj,
        diversion: extraObj?.diversion,
        points: extraObj?.points,
        deductPoints: extraObj?.deduct_points,
      },
      provenance: `DATABASE_PHYSICAL_RECORD:${frontendTable ?? 'pq_aivideo_new'}+pq_volcengine_ai_task`,
      confidence: hasTaskRecord ? 1.0 : 0.0,
      immutable: true,
      redacted: true,
      collectionStatus: hasTaskRecord ? 'SUCCESS' : raw.status === 'UNVERIFIED' ? 'COLLECTION_FAILED' : 'MISSING',
      error: !hasTaskRecord
        ? {
            code: raw.reason || 'NO_PHYSICAL_TASK_FOUND',
            message: raw.error || '数据库中未查询到对应的任务物理落库记录',
          }
        : undefined,
    });

    // ------------------------------------------------------------------------
    // 信封 2: BILLING_LEDGER:DB_SCORE_LOGS (真实积分流水落库事实)
    // ------------------------------------------------------------------------
    const hasScoreLogs = Array.isArray(scoreLogs) && scoreLogs.length > 0;
    const backendTaskId = volcengineRec?.id ? Number(volcengineRec.id) : undefined;
    const targetTaskId = context.taskId !== undefined ? Number(context.taskId) : undefined;
    const mappedLogs = hasScoreLogs ? mapDbScoreLogsToScoreLogEntries(scoreLogs!, targetTaskId, backendTaskId) : [];

    let totalPreDeduct = 0;
    let totalRefund = 0;
    for (const l of mappedLogs) {
      if (l.type === 2) totalPreDeduct += Math.abs(l.score);
      if (l.type === 1) totalRefund += Math.abs(l.score);
    }
    const netPoints = totalPreDeduct - totalRefund;

    const billingObservationStatus = raw.status === 'VERIFIED' && hasScoreLogs ? 'PASS' : 'UNVERIFIED';

    envelopes.push({
      evidenceId: `${testId}-db-score-logs`,
      testId,
      sourceTool: this.producerName,
      sourceType: 'BILLING_LEDGER',
      evidenceKey: 'BILLING_LEDGER:DB_SCORE_LOGS',
      observationStatus: billingObservationStatus,
      capturedAt,
      environment,
      subjectType: 'billing_ledger',
      subjectId,
      normalizedFields: {
        logCount: mappedLogs.length,
        totalPreDeduct,
        totalRefund,
        netPoints,
        entries: mappedLogs.map((m) => ({
          id: m.id,
          type: m.type === 2 ? 'PRE_DEDUCT' : m.type === 1 ? 'REFUND' : String(m.type),
          score: m.score,
          memo: m.memo,
          createtime: m.createtime,
        })),
      },
      provenance: 'DATABASE_PHYSICAL_RECORD:pq_score_log',
      confidence: hasScoreLogs ? 1.0 : 0.0,
      immutable: true,
      redacted: true,
      collectionStatus: hasScoreLogs ? 'SUCCESS' : 'MISSING',
      error: !hasScoreLogs
        ? {
            code: 'NO_SCORE_LOG_FOUND',
            message: raw.error || '数据库中未查询到关联的积分扣费或退款流水记录',
          }
        : undefined,
    });

    return envelopes;
  }
}
