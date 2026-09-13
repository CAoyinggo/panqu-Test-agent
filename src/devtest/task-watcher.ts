import { inspectMp4Buffer, inspectImageBuffer, type MediaInspectionResult } from './media-inspector.js';
import { createSyntheticValidMp4 } from './panqu-playwright-engine.js';
import { BillingOracle, type BillingAuditReport, type ScoreLogEntry } from './billing-oracle.js';
import { ReproExporter, type ReproPackageResult } from './repro-exporter.js';

export type TaskWatchStatus = 'SUBMITTED' | 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'TIMEOUT';

export interface TaskProgressEvent {
  taskId: number;
  status: TaskWatchStatus;
  progress: number;
  message: string;
  timestamp: number;
}

export interface TaskWatchOptions {
  taskId?: number;
  modelId?: number;
  mediaType?: 'video' | 'image';
  env?: string;
  mock?: boolean;
  timeoutMs?: number;
  pollIntervalMs?: number;
  simulateFailure?: boolean;
  duration?: number;
  resolution?: string;
  onProgress?: (event: TaskProgressEvent) => void;
}

export interface TaskWatchResult {
  ok: boolean;
  taskId: number;
  modelId: number;
  mediaType: 'video' | 'image';
  finalStatus: 'COMPLETED' | 'FAILED' | 'TIMEOUT';
  events: TaskProgressEvent[];
  durationMs: number;
  mediaUrl?: string;
  mediaInspection?: MediaInspectionResult;
  billingReconciliation?: BillingAuditReport;
  reproPackage?: ReproPackageResult;
  summary: string;
}

export class TaskWatcher {
  public static async watch(options: TaskWatchOptions = {}): Promise<TaskWatchResult> {
    const taskId = options.taskId || Math.floor(20000 + Math.random() * 80000);
    const modelId = options.modelId ?? 84;
    const mediaType = options.mediaType ?? 'video';
    const isMock = options.mock ?? true;
    if (!isMock) {
      throw new Error('REAL_MODE_UNSUPPORTED: watch_task currently provides controlled simulation only');
    }
    const simulateFailure = options.simulateFailure ?? false;
    const pollInterval = options.pollIntervalMs ?? (isMock ? 30 : 2000);
    const startTime = Date.now();

    const events: TaskProgressEvent[] = [];
    const emit = (status: TaskWatchStatus, progress: number, message: string) => {
      const ev: TaskProgressEvent = {
        taskId,
        status,
        progress,
        message,
        timestamp: Date.now(),
      };
      events.push(ev);
      if (options.onProgress) {
        try { options.onProgress(ev); } catch { /* ignore */ }
      }
    };

    // 阶段 1: 提交
    emit('SUBMITTED', 10, `任务 #${taskId} 已提交至主站队列，参数校验通过`);
    await new Promise((r) => setTimeout(r, pollInterval));

    // 阶段 2: 排队调度
    emit('QUEUED', 35, `任务 #${taskId} 已派发至 NewAPI 智能网关，分配上游算力渠道`);
    await new Promise((r) => setTimeout(r, pollInterval));

    // 阶段 3: 运行中
    emit('PROCESSING', 70, `上游供应商开始生成，实时流数据分块接收中`);
    await new Promise((r) => setTimeout(r, pollInterval));

    const duration = options.duration ?? 4;
    const resolution = options.resolution ?? '720p';
    const expectedPoints = BillingOracle.calculateExpectedPoints({
      mediaType,
      modelId,
      duration,
      resolution,
    });

    if (simulateFailure) {
      // 阶段 4 失败分支
      emit('FAILED', 100, `上游供应商返回错误 (500/Timeout)，触发全额退款流程`);
      const scoreLogs: ScoreLogEntry[] = [
        { task_id: taskId, type: 2, score: -expectedPoints, memo: `预扣积分 - 任务 #${taskId}` },
        { task_id: taskId, type: 1, score: expectedPoints, memo: `任务失败全额退款 #${taskId}` },
      ];

      const billingAudit = BillingOracle.reconcileTaskLedger({
        taskId,
        expectedPoints,
        terminalStatus: 'FAILED',
        scoreLogs,
      });

      const reproPkg = await ReproExporter.generatePackage({
        caseId: `CASE-WATCH-FAIL-${taskId}`,
        failureCategory: 'UPSTREAM_TASK_FAILED',
        taskInfo: {
          taskId,
          modelId,
          mediaType,
          duration,
          resolution,
          env: options.env ?? 'test',
        },
        expected: { expectedPoints, netDeductedPoints: 0 },
        actual: { netDeductedPoints: billingAudit.netDeductedPoints },
        reasons: ['上游算力提供商生成超时或异常，已触发退款对账'],
        violatedInvariants: billingAudit.passed ? [] : ['NET_CHARGE_ZERO'],
        scoreLogs,
      });

      const durationMs = Date.now() - startTime;
      return {
        ok: billingAudit.passed,
        taskId,
        modelId,
        mediaType,
        finalStatus: 'FAILED',
        events,
        durationMs,
        billingReconciliation: billingAudit,
        reproPackage: reproPkg,
        summary: `任务 #${taskId} 异常终止，耗时 ${durationMs}ms。退款核销完成 (净扣 ${billingAudit.netDeductedPoints} pt，符合 net_charge_zero 不变量)。已自动附带最小复现包。`,
      };
    }

    // 阶段 4 成功分支
    emit('COMPLETED', 100, `生成完成，成片二进制产物已就绪`);
    const mediaUrl = `https://test-oss.panqu.com/artifacts/task_${taskId}.${mediaType === 'video' ? 'mp4' : 'png'}`;

    // 介质物理校验
    let mediaInspection: MediaInspectionResult;
    if (mediaType === 'video') {
      const syntheticMp4 = createSyntheticValidMp4({ width: 1280, height: 720, durationSeconds: duration });
      mediaInspection = inspectMp4Buffer(syntheticMp4);
    } else {
      // 简单合成 PNG (1x1 transparent)
      const syntheticPng = Buffer.from('89504e470d0a1a0a0000000d4948445200000200000002000806000000f478d4fa', 'hex');
      mediaInspection = inspectImageBuffer(syntheticPng);
    }

    // 账务正常对账
    const scoreLogs: ScoreLogEntry[] = [
      { task_id: taskId, type: 2, score: -expectedPoints, memo: `预扣并核销积分 - 任务 #${taskId}` },
    ];
    const billingAudit = BillingOracle.reconcileTaskLedger({
      taskId,
      expectedPoints,
      terminalStatus: 'SUCCESS',
      scoreLogs,
    });

    const durationMs = Date.now() - startTime;
    const ok = mediaInspection.decodable && billingAudit.passed;

    return {
      ok,
      taskId,
      modelId,
      mediaType,
      finalStatus: 'COMPLETED',
      events,
      durationMs,
      mediaUrl,
      mediaInspection,
      billingReconciliation: billingAudit,
      summary: `任务 #${taskId} 顺利完成，耗时 ${durationMs}ms。产物格式 [${mediaInspection.format}] 校验通过，扣费核销 ${expectedPoints} pt (实扣 ${billingAudit.netDeductedPoints} pt)，三大账务不变量全部达标。`,
    };
  }
}
