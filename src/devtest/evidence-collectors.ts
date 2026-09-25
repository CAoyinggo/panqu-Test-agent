/**
 * verify 证据采集组（evidence-collectors）
 * =============================================================================
 * 由 verify-pipeline 物理分解而来（ARCHITECTURE_FREEZE §2.2 Phase 6 授权，2026-09-24）：
 * collectTaskEvidence / collectMediaEvidence / collectBillingEvidence + 私有 fetchFirst64K。
 * 行为等价搬迁，零逻辑改动；共享类型经 `import type` 引自 verify-pipeline（运行时无反向依赖，无环）。
 * verify-pipeline 原样 re-export 本模块以保持公共导出面零变化。
 */
/**
 * Panqu AI DevTest — verify 证据流水线 (Phase 4 物理分解)
 *
 * 本模块依据 docs/ARCHITECTURE_FREEZE.md §2.2「Phase 4 core-kernel 物理分解授权」
 * (2026-09-23 人工明确授权) 从 core-kernel.ts 原样抽出,承载 verify 动作的证据采集与
 * 裁决投影流水线:resolveVerifyContext / collectTaskEvidence / collectMediaEvidence /
 * collectBillingEvidence / computeRegressionDiff / buildDiffItems / computeFinalVerdict。
 * 行为与原实现完全等价,未新增任何裁决语义或中间层。
 *
 * 依赖方向:core-kernel → verify-pipeline → 下层能力模块。严禁反向 import core-kernel。
 * 单一裁决权威仍为 canonical-verdict-engine;本模块只做证据搬运与投影。
 */

import { RoutingOracle, validateTrustedGatewaySnapshot } from './routing.js';
import { BillingOracle, type ScoreLogEntry } from './billing.js';
import { inspectMp4Buffer, inspectImageBuffer } from './media-inspector.js';
import {
  pollTaskStatus,
  queryTaskBillingLogs,
  queryTaskRuntimeDetails,
  type TaskRuntimeDetails,
} from './media-flow.js';

import {
  queryDatabasePhysicalFacts,
  mapDbScoreLogsToScoreLogEntries,
  resolveDatabaseCredentialsPath,
  resolveFrontendTaskRecord,
  type DatabaseRawCollection,
} from './database-evidence-producer.js';

import type {
  EvidenceStatus,
  InvariantDetail,
  TaskEvidence,
  MediaEvidence,
  BillingEvidence,
  InvariantsEvidence,
  VerifyKernelOptions,
  VerifyContext,
  RoutingFacts,
  TaskEvidenceResult,
  MediaEvidenceResult,
  BillingEvidenceResult,
} from './verify-pipeline.js';

async function fetchFirst64K(
  url: string,
  timeoutMs = 8000,
): Promise<{ buffer: Buffer; tailBuffer?: Buffer; durationMs: number } | null> {
  const start = Date.now();
  let headBuf: Buffer;
  let tailBuf: Buffer | undefined;
  let totalSize = 0;
  let isFullDownload = false;

  // 阶段一：头部切片探测 (独立超时控制)
  const headCtrl = new AbortController();
  const headTimer = setTimeout(() => headCtrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Range: 'bytes=0-65535', 'User-Agent': 'Mozilla/5.0 PanquDevTestAgent/1.0' },
      signal: headCtrl.signal,
    });
    if (!res.ok && res.status !== 206) return null;
    const arrayBuf = await res.arrayBuffer();
    const buf = Buffer.from(arrayBuf);

    if (res.status === 200) {
      isFullDownload = true;
      if (buf.length > 65536) {
        headBuf = buf.subarray(0, 65536);
        tailBuf = buf.subarray(Math.max(0, buf.length - 65536));
      } else {
        headBuf = buf;
      }
    } else {
      headBuf = buf.subarray(0, 65536);
      if (res.headers && typeof res.headers.get === 'function') {
        const contentRange = res.headers.get('content-range');
        const match = contentRange ? /\/(\d+)$/.exec(contentRange) : null;
        totalSize = match ? parseInt(match[1], 10) : 0;
      }
    }
  } catch {
    return null;
  } finally {
    clearTimeout(headTimer);
  }

  if (isFullDownload) {
    return { buffer: headBuf, tailBuffer: tailBuf, durationMs: Date.now() - start };
  }

  const quickInspection = inspectMp4Buffer(headBuf);
  if (quickInspection.decodable) {
    return { buffer: headBuf, durationMs: Date.now() - start };
  }

  // 阶段二：尾部切片探测 (独立超时控制，分配独立保护预算)
  if (totalSize > headBuf.length) {
    const tailSize = Math.min(65536, totalSize);
    const tailStart = Math.max(0, totalSize - tailSize);
    const tailTimeoutMs = Math.max(4000, timeoutMs);
    const tailCtrl = new AbortController();
    const tailTimer = setTimeout(() => tailCtrl.abort(), tailTimeoutMs);
    try {
      const tailRes = await fetch(url, {
        headers: { Range: `bytes=${tailStart}-${totalSize - 1}`, 'User-Agent': 'Mozilla/5.0 PanquDevTestAgent/1.0' },
        signal: tailCtrl.signal,
      });
      if (tailRes.ok || tailRes.status === 206) {
        tailBuf = Buffer.from(await tailRes.arrayBuffer());
      }
    } catch {
      // 保留 headBuf 继续走既有 fail-closed 校验
    } finally {
      clearTimeout(tailTimer);
    }
  }

  return { buffer: headBuf, tailBuffer: tailBuf, durationMs: Date.now() - start };
}
// ============================================================================
// Helper 2: collectTaskEvidence
// ============================================================================
export async function collectTaskEvidence(
  ctx: VerifyContext,
  options: VerifyKernelOptions,
): Promise<TaskEvidenceResult> {
  const { taskId, session, sessionLoadError, mediaType, modelId } = ctx;
  let artifactBuffer = options.assetBuffer ?? options.artifactBuffer;
  let artifactTailBuffer = options.tailBuffer;
  let probeDurationMs: number | undefined;
  let terminalStatus: 'SUCCESS' | 'FAILED' | 'TIMEOUT' | 'UNKNOWN' | 'PROCESSING';
  let taskEvidence: TaskEvidence;
  let mediaArtifactSource = artifactBuffer ? 'FIXTURE_BUFFER' : 'missing_buffer';
  let artifactOwnership: 'VERIFIED' | 'UNVERIFIED' =
    options.artifactOwnership === 'UNVERIFIED' || options.artifactOwnership === 'UNBOUND' ? 'UNVERIFIED' : 'VERIFIED';

  if (session) {
    const defaultTimeoutSec = mediaType === 'image' ? 60 : 180;
    const pollTimeoutSec = options.pollTimeoutSec ?? defaultTimeoutSec;
    const { finalSnapshot } = await pollTaskStatus(taskId, {
      baseUrl: session.base_url,
      cookies: session.cookie_string,
      mediaType,
      pollTimeoutSec,
      pollIntervalMs: options.pollIntervalMs,
      onProgress: options.onProgress,
    });
    if (finalSnapshot.taskStatus === 1) {
      terminalStatus = 'PROCESSING';
      taskEvidence = {
        status: 'PROCESSING',
        source: 'live_polling',
        terminalStatus: 'UNKNOWN',
        taskStatus: 1,
        progress: finalSnapshot.progress,
      };
    } else if (finalSnapshot.taskStatus === 3 || finalSnapshot.taskStatus === 4) {
      terminalStatus = 'FAILED';
      taskEvidence = {
        status: 'FAIL',
        source: 'live_polling',
        terminalStatus: 'FAILED',
        taskStatus: finalSnapshot.taskStatus,
        error: finalSnapshot.error || '未知服务端错误',
        progress: finalSnapshot.progress,
      };
    } else if (finalSnapshot.taskStatus === 2) {
      terminalStatus = 'SUCCESS';
      taskEvidence = {
        status: 'PASS',
        source: 'live_polling',
        terminalStatus: 'SUCCESS',
        taskStatus: 2,
        progress: finalSnapshot.progress,
        videoUrl: finalSnapshot.videoUrl,
        imageUrl: finalSnapshot.imageUrl,
      };
      const mediaUrl = finalSnapshot.videoUrl || finalSnapshot.imageUrl;
      if (mediaUrl) {
        mediaArtifactSource = 'TASK_SNAPSHOT';
        artifactOwnership = 'VERIFIED';
        if (!artifactBuffer) {
          const probeRes = await fetchFirst64K(mediaUrl);
          if (probeRes) {
            artifactBuffer = probeRes.buffer;
            artifactTailBuffer = probeRes.tailBuffer;
            probeDurationMs = probeRes.durationMs;
          }
        }
      }
    } else {
      terminalStatus = 'UNKNOWN';
      taskEvidence = {
        status: 'UNVERIFIED',
        source: 'task_not_found',
        terminalStatus: 'UNKNOWN',
        taskStatus: 0,
        error: `未能从主站获取到任务 #${taskId} 状态 (任务不存在或超时) [UNVERIFIED]`,
        progress: 0,
      };
      const targetMediaUrl = options.videoUrl || options.imageUrl;
      if (targetMediaUrl && !artifactBuffer) {
        mediaArtifactSource = 'EXTERNAL_URL';
        artifactOwnership = options.artifactOwnership === 'VERIFIED' ? 'VERIFIED' : 'UNVERIFIED';
        const probeRes = await fetchFirst64K(targetMediaUrl);
        if (probeRes) {
          artifactBuffer = probeRes.buffer;
          artifactTailBuffer = probeRes.tailBuffer;
          probeDurationMs = probeRes.durationMs;
        }
      }
    }
  } else if (sessionLoadError) {
    terminalStatus = 'UNKNOWN';
    taskEvidence = {
      status: 'UNVERIFIED',
      source: 'session_error',
      terminalStatus: 'UNKNOWN',
      error: `${sessionLoadError} [UNVERIFIED]`,
    };
    mediaArtifactSource = artifactBuffer ? 'FIXTURE_BUFFER' : 'missing_session';
    if (!artifactBuffer) {
      artifactOwnership = 'UNVERIFIED';
    }
  } else {
    if (options.terminalStatus) {
      if (options.terminalStatus === 'PROCESSING') {
        terminalStatus = 'PROCESSING';
        taskEvidence = {
          status: 'PROCESSING',
          source: 'provided',
          terminalStatus: 'UNKNOWN',
          taskStatus: 1,
          progress: options.progress ?? 50,
        };
      } else {
        terminalStatus = options.terminalStatus;
        taskEvidence = {
          status: terminalStatus === 'FAILED' ? 'FAIL' : terminalStatus === 'SUCCESS' ? 'PASS' : 'UNVERIFIED',
          source: 'provided',
          terminalStatus,
        };
      }
    } else {
      terminalStatus = 'UNKNOWN';
      taskEvidence = {
        status: 'UNVERIFIED',
        source: 'unqueried',
        terminalStatus: 'UNKNOWN',
        error: `未连接真实主站查询且未显式传入终态，任务 #${taskId} 终态未知 [UNVERIFIED]`,
      };
    }

    const targetMediaUrl = options.videoUrl || options.imageUrl;
    if (targetMediaUrl) {
      taskEvidence.videoUrl = options.videoUrl;
      taskEvidence.imageUrl = options.imageUrl;
      mediaArtifactSource = 'EXTERNAL_URL';
      if (options.artifactOwnership !== 'VERIFIED') {
        artifactOwnership = 'UNVERIFIED';
      }
      if (!artifactBuffer) {
        const probeRes = await fetchFirst64K(targetMediaUrl);
        if (probeRes) {
          artifactBuffer = probeRes.buffer;
          artifactTailBuffer = probeRes.tailBuffer;
          probeDurationMs = probeRes.durationMs;
        }
      }
    } else if (artifactBuffer) {
      mediaArtifactSource =
        options.artifactOwnership === 'UNVERIFIED' || options.artifactOwnership === 'UNBOUND'
          ? 'EXTERNAL_BUFFER'
          : 'FIXTURE_BUFFER';
    }
  }

  // 服务端运行时详情查询 (只读)
  let runtimeDetails: TaskRuntimeDetails | undefined;
  if (session && !session.base_url.includes('example.com')) {
    try {
      runtimeDetails = await queryTaskRuntimeDetails(taskId, session, {
        projectId: options.projectId ?? session.project_id,
      });
    } catch {
      /* 容忍只读查询非致命抖动 */
    }
  }

  // 数据库物理事实查询 (只读，按项目规则自动加载 db-credentials.json 并走 SSH 隧道)
  let dbRawCollection: DatabaseRawCollection | undefined = options.dbRawCollection;
  const isRealRun = ctx.executionMode === 'real';
  const isOfflineFixture = ctx.executionMode === 'fixture' || ctx.executionMode === 'offline';

  // 真实数据变更场景强制执行数据库只读取证，不能被 CLI 参数或直接调用库的方式关闭。离线 fixture 与 VITEST 单测环境不触发真实连库。
  const shouldQueryDb =
    !dbRawCollection &&
    ((isRealRun && !process.env.VITEST) ||
      options.dbVerify === true ||
      (options.dbVerify !== false && !process.env.VITEST && !isOfflineFixture));

  if (shouldQueryDb) {
    const credPath = resolveDatabaseCredentialsPath(options.dbCredPath);
    if (credPath) {
      try {
        dbRawCollection = await queryDatabasePhysicalFacts({
          taskId,
          credPath,
          mediaType: ctx.mediaType,
          // DB 取证使用独立短超时，绝不随 --poll-timeout 放大；库不可达时快速 fail-closed 为 UNVERIFIED，避免真实流程长时间卡死
          timeoutMs: options.dbTimeoutMs ?? 10000,
        });
      } catch {
        /* 容忍只读取证非致命异常，失败关闭交给后续判定 */
      }
    } else if (isRealRun) {
      // 真实模式下凭据缺失，不可伪造或忽略，记录明确失败原因供唯一裁决引擎做失败关闭判定
      dbRawCollection = {
        status: 'UNVERIFIED',
        taskId,
        reason: 'MISSING_CREDENTIALS',
        error: '找不到 db-credentials.json 数据库凭据文件，无法通过 SSH 隧道执行物理取证 [UNVERIFIED]',
        recordsFound: {},
      };
    }
  }

  // 若通过数据库物理落库获得了明确终态且此前未知，自动提升终态事实
  const { record: frontendDbRec, table: frontendDbTable } = resolveFrontendTaskRecord(dbRawCollection?.recordsFound);
  if (frontendDbRec) {
    const dbTask = frontendDbRec;
    const dbTaskStatus = Number(dbTask.task_status);
    const dbSource = `DATABASE_PHYSICAL_RECORD:${frontendDbTable ?? 'pq_aivideo_new'}`;
    // 媒体感知解析产物 URL：视频取 video_url(相对补 v.panqu.com.cn)；图片取 image_url/pic
    // (pic 可能是 JSON 数组相对路径，如 ["/character/..png"])。仅采用可直接抓取的绝对 http URL；
    // 图片相对路径缺 CDN 域名时不臆测前缀(fail-closed，交由轮询主路径获取产物)。
    const resolveDbMediaUrl = (): string | undefined => {
      if (ctx.mediaType === 'image') {
        const cand = dbTask.image_url ?? dbTask.pic;
        if (!cand) return undefined;
        let s = String(cand).trim();
        if (s.startsWith('[')) {
          try {
            const arr: unknown = JSON.parse(s);
            s = Array.isArray(arr) && arr.length > 0 ? String(arr[0]) : '';
          } catch {
            s = '';
          }
        }
        return s.startsWith('http') ? s : undefined;
      }
      if (!dbTask.video_url) return undefined;
      const v = String(dbTask.video_url);
      return v.startsWith('http') ? v : `https://v.panqu.com.cn${v}`;
    };
    if (
      terminalStatus === 'UNKNOWN' ||
      taskEvidence.source === 'unqueried' ||
      taskEvidence.source === 'task_not_found'
    ) {
      if (dbTaskStatus === 2) {
        terminalStatus = 'SUCCESS';
        taskEvidence = {
          status: 'PASS',
          source: dbSource,
          terminalStatus: 'SUCCESS',
          taskStatus: 2,
          progress: 100,
          videoUrl: ctx.mediaType === 'video' ? resolveDbMediaUrl() : undefined,
        };
      } else if (dbTaskStatus === 3 || dbTaskStatus === 4) {
        terminalStatus = 'FAILED';
        taskEvidence = {
          status: 'FAIL',
          source: dbSource,
          terminalStatus: 'FAILED',
          taskStatus: dbTaskStatus,
          error: dbTask.err ? String(dbTask.err) : '数据库记录任务已失败 [DATABASE_PHYSICAL_RECORD]',
          progress: -1,
        };
      }
    }
    // 若产物 URL 可从数据库物理记录获取且尚未探测（媒体感知；图片相对路径缺域名时为 undefined，不抓取）
    const dbMediaUrl = taskEvidence.videoUrl || resolveDbMediaUrl();
    if (!artifactBuffer && dbMediaUrl) {
      mediaArtifactSource = dbSource;
      artifactOwnership = 'VERIFIED';
      const probeRes = await fetchFirst64K(dbMediaUrl);
      if (probeRes) {
        artifactBuffer = probeRes.buffer;
        artifactTailBuffer = probeRes.tailBuffer;
        probeDurationMs = probeRes.durationMs;
      }
    }
  }

  // 目标渠道消歧与判定
  const targetDisambiguation =
    options.channelId !== undefined || options.channelName !== undefined || options.targetKind === 'channel'
      ? RoutingOracle.disambiguateTarget({
          targetKind: options.targetKind,
          channelId: options.channelId,
          channelName: options.channelName,
          modelId,
          modelAlias: options.alias,
          projectId: options.projectId,
          mode: options.isSimulated ? 'mock' : session ? 'real' : 'mock',
        })
      : undefined;

  const targetChannelId = targetDisambiguation?.channelId ?? options.channelId;
  const targetChannelName = targetDisambiguation?.channelName ?? options.channelName;

  const rawExceptionalExtra = runtimeDetails?.rawExceptionalTask?.extra as Record<string, unknown> | undefined;
  const optionsExceptionalExtra = options.exceptionalTask?.extra as Record<string, unknown> | undefined;

  // 1. 服务端只读事实提取 (Server Facts)
  const serverActualChannelId =
    runtimeDetails?.actualChannelId ??
    (options.retryLog?.newapi_channel_id ? Number(options.retryLog.newapi_channel_id) : undefined);
  const serverActualChannelName =
    runtimeDetails?.actualChannelName ??
    (options.retryLog?.newapi_provider_name ? String(options.retryLog.newapi_provider_name) : undefined) ??
    (runtimeDetails?.rawExceptionalTask?.line_name ? String(runtimeDetails.rawExceptionalTask.line_name) : undefined);
  const serverFallbackChannel =
    runtimeDetails?.fallbackChannel ??
    (options.retryLog?.fallback_channel ? String(options.retryLog.fallback_channel) : undefined);
  const serverRetryProvider =
    runtimeDetails?.retryProvider ??
    (rawExceptionalExtra?.retry_provider ? String(rawExceptionalExtra.retry_provider) : undefined) ??
    (optionsExceptionalExtra?.retry_provider ? String(optionsExceptionalExtra.retry_provider) : undefined);

  // 2. 调用者入参手填断言 (Asserted Inputs)
  const assertedActualChannelId = options.actualChannelId;
  const assertedActualChannelName = options.actualChannelName;
  const assertedFallbackChannel = options.fallbackChannel;
  const assertedRetryProvider = options.retryProvider;

  // 3. 证据冲突检测 (EVIDENCE_CONFLICT)
  let hasEvidenceConflict = false;
  const conflictReasons: string[] = [];

  // 3.1 运行环境重叠参数冲突校验 (env vs environment vs spec.environment)
  const effectiveEnv = options.environment || options.env;
  if (options.env && options.environment && options.env !== options.environment) {
    hasEvidenceConflict = true;
    conflictReasons.push(
      `运行环境参数冲突 [EVIDENCE_CONFLICT]: 传入 env='${options.env}' 与 environment='${options.environment}' 不一致。`,
    );
  }
  if (options.spec?.environment && effectiveEnv && options.spec.environment !== effectiveEnv) {
    hasEvidenceConflict = true;
    conflictReasons.push(
      `规范与运行环境冲突 [EVIDENCE_CONFLICT]: canonicalSpec.environment='${options.spec.environment}' 与传入环境 '${effectiveEnv}' 不一致。`,
    );
  }

  // 3.2 执行模式互斥冲突校验 (isSimulated vs executionMode)
  const normOptExecutionMode = options.executionMode?.toLowerCase();
  if (options.isSimulated === true && normOptExecutionMode === 'real') {
    hasEvidenceConflict = true;
    conflictReasons.push(
      `执行模式参数冲突 [EVIDENCE_CONFLICT]: isSimulated=true (离线仿真) 与 executionMode='real' (真实执行) 互斥。`,
    );
  }
  if (normOptExecutionMode === 'real' && !ctx.session && !ctx.sessionLoadError) {
    hasEvidenceConflict = true;
    conflictReasons.push(
      `执行模式凭据缺失 [EVIDENCE_CONFLICT]: 声明 executionMode='real' 但未形成有效服务端会话 (缺少有效 session 或完整 baseUrl+cookies)，凭据声明不得等同于鉴权成功。`,
    );
  }
  if (options.cookies && !options.baseUrl && !options.session && !options.sessionFile) {
    hasEvidenceConflict = true;
    conflictReasons.push(`凭据不完整 [EVIDENCE_CONFLICT]: 仅传入 cookies 但缺少 baseUrl，未形成有效服务端会话凭据。`);
  }

  // 3.3 媒体类型与地址错配冲突校验 (mediaType vs videoUrl/imageUrl)
  if (ctx.mediaType === 'image' && options.videoUrl && !options.imageUrl) {
    hasEvidenceConflict = true;
    conflictReasons.push(
      `媒体类型与地址冲突 [EVIDENCE_CONFLICT]: mediaType 为 image 但仅传入 videoUrl (${options.videoUrl})。`,
    );
  } else if (ctx.mediaType === 'video' && options.imageUrl && !options.videoUrl) {
    hasEvidenceConflict = true;
    conflictReasons.push(
      `媒体类型与地址冲突 [EVIDENCE_CONFLICT]: mediaType 为 video 但仅传入 imageUrl (${options.imageUrl})。`,
    );
  }

  // 3.4 计费参数显式冲突校验 (price vs customPoints/pointsPerSecond)
  if (
    ctx.mediaType === 'image' &&
    options.price !== undefined &&
    options.customPoints !== undefined &&
    options.price !== options.customPoints
  ) {
    hasEvidenceConflict = true;
    conflictReasons.push(
      `计费参数冲突 [EVIDENCE_CONFLICT]: image 场景下 price (${options.price}) 与 customPoints (${options.customPoints}) 数值不一致。`,
    );
  } else if (
    ctx.mediaType === 'video' &&
    options.price !== undefined &&
    options.pointsPerSecond !== undefined &&
    options.price !== options.pointsPerSecond
  ) {
    hasEvidenceConflict = true;
    conflictReasons.push(
      `计费参数冲突 [EVIDENCE_CONFLICT]: video 场景下 price (${options.price}) 与 pointsPerSecond (${options.pointsPerSecond}) 数值不一致。`,
    );
  }

  // 3.5 产物 Buffer 冲突校验 (assetBuffer vs artifactBuffer)
  if (options.assetBuffer && options.artifactBuffer && !options.assetBuffer.equals(options.artifactBuffer)) {
    hasEvidenceConflict = true;
    conflictReasons.push(`产物 Buffer 冲突 [EVIDENCE_CONFLICT]: assetBuffer 与 artifactBuffer 二进制内容不一致。`);
  }

  // 3.6 规范目标身份与执行模式冲突校验 (spec.target.taskId / spec.inputs.taskId / spec.executionMode vs verify inputs)
  if (options.spec) {
    const specTargetTaskId = options.spec.target?.taskId;
    const specInputsTaskId = options.spec.inputs?.taskId;
    if (specTargetTaskId !== undefined && Number(specTargetTaskId) !== Number(ctx.taskId)) {
      hasEvidenceConflict = true;
      conflictReasons.push(
        `目标身份冲突 [EVIDENCE_CONFLICT]: 传入 taskId=${ctx.taskId} 与 canonicalSpec.target.taskId=${specTargetTaskId} 不一致，不同任务的证据不得用于当前目标的通过裁决。`,
      );
    }
    if (specInputsTaskId !== undefined && Number(specInputsTaskId) !== Number(ctx.taskId)) {
      hasEvidenceConflict = true;
      conflictReasons.push(
        `目标身份冲突 [EVIDENCE_CONFLICT]: 传入 taskId=${ctx.taskId} 与 canonicalSpec.inputs.taskId=${specInputsTaskId} 不一致，不同任务的证据不得用于当前目标的通过裁决。`,
      );
    }
    if (
      options.spec.target?.modelId !== undefined &&
      ctx.modelId !== undefined &&
      Number(options.spec.target.modelId) !== Number(ctx.modelId)
    ) {
      hasEvidenceConflict = true;
      conflictReasons.push(
        `目标模型冲突 [EVIDENCE_CONFLICT]: 传入 modelId=${ctx.modelId} 与 canonicalSpec.target.modelId=${options.spec.target.modelId} 不一致。`,
      );
    }
    if (options.spec.executionMode && options.spec.executionMode.toLowerCase() !== ctx.executionMode) {
      hasEvidenceConflict = true;
      conflictReasons.push(
        `执行模式冲突 [EVIDENCE_CONFLICT]: canonicalSpec.executionMode='${options.spec.executionMode}' 与实际执行模式 '${ctx.executionMode}' 不一致。`,
      );
    }
  }

  if (
    serverActualChannelId !== undefined &&
    assertedActualChannelId !== undefined &&
    serverActualChannelId !== assertedActualChannelId
  ) {
    hasEvidenceConflict = true;
    conflictReasons.push(
      `实际渠道证据冲突 [EVIDENCE_CONFLICT]: 服务端事实为 Channel #${serverActualChannelId} ('${serverActualChannelName || serverActualChannelId}'), 调用者手填断言为 Channel #${assertedActualChannelId} ('${assertedActualChannelName || assertedActualChannelId}')。必须优先采用服务端事实。`,
    );
  }

  const normServerFallback =
    serverFallbackChannel && serverFallbackChannel !== 'none' ? serverFallbackChannel : undefined;
  const normAssertedFallback =
    assertedFallbackChannel && assertedFallbackChannel !== 'none' ? assertedFallbackChannel : undefined;
  if (normServerFallback !== undefined && assertedFallbackChannel === 'none') {
    hasEvidenceConflict = true;
    conflictReasons.push(
      `兜底渠道证据冲突 [EVIDENCE_CONFLICT]: 服务端事实存在兜底 '${normServerFallback}', 调用者断言为无兜底 (none)。必须优先采用服务端事实。`,
    );
  } else if (
    normServerFallback !== undefined &&
    normAssertedFallback !== undefined &&
    normServerFallback !== normAssertedFallback
  ) {
    hasEvidenceConflict = true;
    conflictReasons.push(
      `兜底渠道证据冲突 [EVIDENCE_CONFLICT]: 服务端事实为 fallback='${normServerFallback}', 调用者断言为 '${normAssertedFallback}'。必须优先采用服务端事实。`,
    );
  }

  const normServerRetry = serverRetryProvider && serverRetryProvider !== 'none' ? serverRetryProvider : undefined;
  const normAssertedRetry =
    assertedRetryProvider && assertedRetryProvider !== 'none' ? assertedRetryProvider : undefined;
  if (normServerRetry !== undefined && assertedRetryProvider === 'none') {
    hasEvidenceConflict = true;
    conflictReasons.push(
      `重试 Provider 证据冲突 [EVIDENCE_CONFLICT]: 服务端事实存在重试 provider '${normServerRetry}', 调用者断言为无重试 (none)。必须优先采用服务端事实。`,
    );
  } else if (
    normServerRetry !== undefined &&
    normAssertedRetry !== undefined &&
    normServerRetry !== normAssertedRetry
  ) {
    hasEvidenceConflict = true;
    conflictReasons.push(
      `重试 Provider 证据冲突 [EVIDENCE_CONFLICT]: 服务端事实为 retryProvider='${normServerRetry}', 调用者断言为 '${normAssertedRetry}'。必须优先采用服务端事实。`,
    );
  }

  // 4. 事实仲裁：服务端只读事实强制优先于手填输入！
  const actualChannelId = serverActualChannelId ?? assertedActualChannelId;
  const actualChannelName =
    (serverActualChannelId !== undefined ? serverActualChannelName : undefined) ??
    assertedActualChannelName ??
    serverActualChannelName;
  const fallbackChannel = serverFallbackChannel ?? assertedFallbackChannel;
  const retryProvider = serverRetryProvider ?? assertedRetryProvider;

  const isActualChannelAssertedOnly =
    Boolean(ctx.session && !options.isSimulated) &&
    serverActualChannelId === undefined &&
    assertedActualChannelId !== undefined;

  // 5. 记录字段精确 Provenance
  let channelProvenance: string;
  if (runtimeDetails?.actualChannelId !== undefined) {
    channelProvenance = 'HTTP_API:retrylog';
  } else if (options.retryLog?.newapi_channel_id !== undefined) {
    channelProvenance = 'SERVER_RETRYLOG_FIXTURE';
  } else if (assertedActualChannelId !== undefined) {
    channelProvenance =
      ctx.session && !options.isSimulated ? 'CLI_ASSERTED_INPUT (UNVERIFIED_FOR_REAL)' : 'FIXTURE_ASSERTED';
  } else {
    channelProvenance = 'UNVERIFIED';
  }

  let fallbackProvenance: string;
  if (runtimeDetails?.fallbackChannel !== undefined) {
    fallbackProvenance = 'HTTP_API:retrylog';
  } else if (options.retryLog?.fallback_channel !== undefined) {
    fallbackProvenance = 'SERVER_RETRYLOG_FIXTURE';
  } else if (assertedFallbackChannel !== undefined) {
    fallbackProvenance =
      ctx.session && !options.isSimulated ? 'CLI_ASSERTED_INPUT (UNVERIFIED_FOR_REAL)' : 'FIXTURE_ASSERTED';
  } else {
    fallbackProvenance = 'UNVERIFIED';
  }

  let retryProvenance: string;
  if (runtimeDetails?.retryProvider !== undefined) {
    retryProvenance = 'HTTP_API:exceptional-task';
  } else if (
    rawExceptionalExtra?.retry_provider !== undefined ||
    optionsExceptionalExtra?.retry_provider !== undefined
  ) {
    retryProvenance = 'SERVER_EXCEPTIONAL_FIXTURE';
  } else if (assertedRetryProvider !== undefined) {
    retryProvenance =
      ctx.session && !options.isSimulated ? 'CLI_ASSERTED_INPUT (UNVERIFIED_FOR_REAL)' : 'FIXTURE_ASSERTED';
  } else {
    retryProvenance = 'UNVERIFIED';
  }

  // 6. extra 对象与来源追踪 (绝不把 exceptional-task 的 extra 冒充为 HTTP_API:getEditData)
  let extraObj: Record<string, unknown> | undefined;
  let extraProvenance: string;

  if (runtimeDetails?.extra && runtimeDetails.extraSource === 'HTTP_API:getEditData') {
    extraObj = runtimeDetails.extra;
    extraProvenance = 'HTTP_API:getEditData';
  } else if (resolveFrontendTaskRecord(dbRawCollection?.recordsFound).record?.extra) {
    const { record: dbFrontendRec, table: dbFrontendTable } = resolveFrontendTaskRecord(
      dbRawCollection?.recordsFound,
    );
    const rawDbExtra = dbFrontendRec!.extra;
    try {
      extraObj = typeof rawDbExtra === 'string' ? JSON.parse(rawDbExtra) : (rawDbExtra as Record<string, unknown>);
    } catch {
      extraObj = undefined;
    }
    extraProvenance = `DATABASE_PHYSICAL_RECORD:${dbFrontendTable ?? 'pq_aivideo_new'}`;
  } else if (runtimeDetails?.extra) {
    extraObj = runtimeDetails.extra;
    extraProvenance = runtimeDetails.extraSource || 'HTTP_API:exceptional-task';
  } else if (runtimeDetails?.rawExceptionalTask?.extra) {
    const rowExtra =
      typeof runtimeDetails.rawExceptionalTask.extra === 'string'
        ? JSON.parse(runtimeDetails.rawExceptionalTask.extra)
        : runtimeDetails.rawExceptionalTask.extra;
    extraObj = rowExtra as Record<string, unknown>;
    extraProvenance = 'HTTP_API:exceptional-task';
  } else if (options.dbExtra) {
    extraObj = options.dbExtra;
    extraProvenance = 'DB_READONLY_QUERY';
  } else if (options.extra) {
    extraObj = options.extra;
    extraProvenance = 'CLI_MANUAL_INPUT';
  } else if (options.exceptionalTask?.extra) {
    extraObj = options.exceptionalTask.extra as Record<string, unknown>;
    extraProvenance = 'FIXTURE:exceptional-task';
  } else if (options.taskDetail?.extra) {
    extraObj = options.taskDetail.extra as Record<string, unknown>;
    extraProvenance = 'TASK_DETAIL';
  } else {
    extraProvenance = 'UNVERIFIED';
  }

  const isDbExtraVerified = Boolean(
    options.dbExtraConfirmed ||
    options.dbExtra ||
    (extraObj &&
      typeof extraObj === 'object' &&
      (extraObj.diversion !== undefined || extraObj.newapi_image !== undefined)),
  );

  let channelMatched: boolean | undefined;
  let isFallbackExecution = false;
  let channelMismatchReason: string | undefined;

  if (targetChannelId !== undefined) {
    if (hasEvidenceConflict) {
      channelMatched = false;
      channelMismatchReason = `渠道或兜底证据存在冲突 [EVIDENCE_CONFLICT]: ${conflictReasons.join('; ')}`;
    } else if (isActualChannelAssertedOnly) {
      channelMatched = undefined;
      channelMismatchReason = `实际渠道仅来自调用者断言 (#${assertedActualChannelId})，缺少服务端只读运行时凭据证实 [UNVERIFIED]`;
    } else if (actualChannelId !== undefined) {
      if (actualChannelId === targetChannelId) {
        channelMatched = true;
      } else {
        channelMatched = false;
        channelMismatchReason = `目标渠道不匹配: 预期渠道 #${targetChannelId} ('${targetChannelName || targetChannelId}'), 服务端实际执行渠道为 #${actualChannelId} ('${actualChannelName || actualChannelId}') [CHANNEL_MISMATCH]`;
      }
    } else {
      channelMismatchReason = `缺少服务端执行渠道证据，无法核验是否由目标渠道 #${targetChannelId} ('${targetChannelName || targetChannelId}') 履约 [UNVERIFIED]`;
    }

    const effectiveFallback =
      fallbackChannel && fallbackChannel !== 'none'
        ? fallbackChannel
        : retryProvider && retryProvider !== 'none'
          ? retryProvider
          : undefined;
    if (effectiveFallback) {
      isFallbackExecution = true;
      const fallbackReason = `目标渠道未产出成片，成片由兜底通道 (${effectiveFallback}) 生成，不得误判为目标渠道合格 [FALLBACK_ARTIFACT_NOT_ACCEPTED]`;
      channelMismatchReason = channelMismatchReason ? `${channelMismatchReason}; ${fallbackReason}` : fallbackReason;
    }
  }

  const isRealMode = Boolean(session && !options.isSimulated);
  const isGatewayChannelRequired = mediaType === 'video' && ctx.contract.routing.value.willDivert;

  const snapshotValidation = options.gatewaySnapshot
    ? validateTrustedGatewaySnapshot(options.gatewaySnapshot, {
        expectedEnv: options.env || (options.environment as 'test' | 'preonline' | undefined),
      })
    : undefined;

  const hasRealGatewaySnapshot = isRealMode
    ? Boolean(snapshotValidation?.valid)
    : Boolean(
        snapshotValidation?.valid ||
        (options.channels &&
          options.channels.length > 0 &&
          options.channels.some((c) => c.sourceMode === 'SOURCE_REAL_GATEWAY')),
      );

  const hasServerActualChannelFact = serverActualChannelId !== undefined && !isActualChannelAssertedOnly;

  // 渠道核验边界澄清 (Requirement 3):
  // 1. 主站 extra.diversion 仅能证明主站分流标记落库，不能证明网关实际履约渠道。
  // 2. 真实模式下，外部断言 (--gateway-channel-confirmed) 严禁作为网关履约事实；必须具备真实的网关可信快照。
  const isGatewayChannelVerified = isRealMode
    ? Boolean(hasRealGatewaySnapshot)
    : Boolean(options.gatewayChannelConfirmed || hasRealGatewaySnapshot || serverActualChannelId !== undefined);

  let gatewayChannelEvidence: string;
  let gatewayChannelProvenance: string;

  if (hasRealGatewaySnapshot) {
    gatewayChannelEvidence = 'SOURCE_REAL_GATEWAY';
    gatewayChannelProvenance = snapshotValidation?.snapshot
      ? `API_READONLY_COLLECTOR (${snapshotValidation.snapshot.sourceEndpoint})`
      : 'SOURCE_REAL_GATEWAY';
  } else if (!isRealMode && hasServerActualChannelFact) {
    gatewayChannelEvidence = 'SERVER_RUN_FACT';
    gatewayChannelProvenance = channelProvenance;
  } else if (options.gatewaySnapshot && !snapshotValidation?.valid) {
    gatewayChannelEvidence = 'INVALID_GATEWAY_SNAPSHOT';
    gatewayChannelProvenance = `FAIL_CLOSED (${snapshotValidation?.reason || 'INVALID_SNAPSHOT'})`;
  } else if (isRealMode && options.channels && options.channels.some((c) => c.sourceMode === 'SOURCE_REAL_GATEWAY')) {
    gatewayChannelEvidence = 'USER_ASSERTION_REJECTED';
    gatewayChannelProvenance =
      'CLI_ASSERTED_INPUT (BLOCKED_MISSING_TRUSTED_COLLECTOR: REAL 模式禁止外部断言作为渠道事实)';
  } else if (options.gatewayChannelConfirmed) {
    gatewayChannelEvidence = isRealMode ? 'USER_ASSERTION_REJECTED' : 'USER_ASSERTION (FIXTURE)';
    gatewayChannelProvenance = isRealMode ? 'CLI_ASSERTED_INPUT (UNVERIFIED_FOR_REAL)' : 'FIXTURE_ASSERTED';
  } else {
    gatewayChannelEvidence = 'MANUAL_REQUIRED';
    gatewayChannelProvenance = 'UNVERIFIED (BLOCKED_MISSING_TRUSTED_COLLECTOR)';
  }

  const targetChannelFailed = targetChannelId !== undefined && (channelMatched === false || isFallbackExecution);
  const targetChannelUnverified = targetChannelId !== undefined && channelMatched === undefined;

  const routingFacts: RoutingFacts = {
    targetChannelId,
    targetChannelName,
    actualChannelId,
    actualChannelName,
    isActualChannelAssertedOnly,
    hasEvidenceConflict,
    conflictReasons,
    isFallbackExecution,
    channelMatched,
    channelProvenance,
    fallbackProvenance,
    retryProvenance,
    extraProvenance,
    gatewayChannelProvenance,
    isDbExtraVerified,
    isGatewayChannelRequired,
    isGatewayChannelVerified,
    targetChannelFailed,
    targetChannelUnverified,
    snapshotValidation,
    hasRealGatewaySnapshot,
    hasServerActualChannelFact,
    serverActualChannelId,
    isRealMode,
    gatewayChannelEvidence,
    extraObj,
    channelMismatchReason,
    fallbackChannel,
    retryProvider,
  };

  return {
    terminalStatus,
    taskEvidence,
    artifactBuffer,
    artifactTailBuffer,
    mediaArtifactSource,
    artifactOwnership,
    probeDurationMs,
    runtimeDetails,
    routingFacts,
    dbEvidence: dbRawCollection,
  };
}

// ============================================================================
// Helper 3: collectMediaEvidence
// ============================================================================
export function collectMediaEvidence(taskResult: TaskEvidenceResult, ctx: VerifyContext): MediaEvidenceResult {
  const { artifactBuffer, artifactTailBuffer, terminalStatus, mediaArtifactSource, artifactOwnership } = taskResult;
  const { mediaType, taskId } = ctx;

  const artifact = artifactBuffer
    ? mediaType === 'video'
      ? inspectMp4Buffer(artifactBuffer, artifactTailBuffer)
      : inspectImageBuffer(artifactBuffer)
    : undefined;
  let mediaEvidence: MediaEvidence;
  if (terminalStatus === 'FAILED' && !artifactBuffer) {
    mediaEvidence = {
      status: 'UNVERIFIED',
      source: 'task_failed',
      ownership: 'UNVERIFIED',
      reason: '任务执行失败，无媒体产物',
    };
  } else if (artifact) {
    if (artifactOwnership === 'UNVERIFIED') {
      mediaEvidence = {
        status: 'UNVERIFIED',
        source: mediaArtifactSource,
        ownership: 'UNVERIFIED',
        format: artifact.format,
        dimensions: artifact.dimensions,
        durationSeconds: artifact.durationSeconds,
        hasMdat: artifact.hasMdat,
        decodable: artifact.decodable,
        reason: `媒体容器物理结构有效 (${(artifact.format || 'mp4').toUpperCase()} container structure PASS)，但缺少与 Task #${taskId} 的归属绑定证据 [UNVERIFIED]`,
      };
    } else if (artifact.decodable) {
      mediaEvidence = {
        status: 'PASS',
        source: mediaArtifactSource,
        ownership: 'VERIFIED',
        format: artifact.format,
        dimensions: artifact.dimensions,
        durationSeconds: artifact.durationSeconds,
        hasMdat: artifact.hasMdat,
        decodable: artifact.decodable,
      };
    } else {
      mediaEvidence = {
        status: 'FAIL',
        source: mediaArtifactSource,
        ownership: 'VERIFIED',
        format: artifact.format,
        dimensions: artifact.dimensions,
        durationSeconds: artifact.durationSeconds,
        hasMdat: artifact.hasMdat,
        decodable: false,
        reason: artifact.reasons.join(', ') || '产物物理完整性校验失败',
      };
    }
  } else {
    mediaEvidence = {
      status: 'UNVERIFIED',
      source: 'missing_buffer',
      ownership: 'UNVERIFIED',
      reason: '缺失真实媒体产物（未提供 assetBuffer 且未获取到有效的产物下载 URL），物理结构未验真 [UNVERIFIED]',
    };
  }

  return { artifact, mediaEvidence };
}

// ============================================================================
// Helper 4: collectBillingEvidence
// ============================================================================
export async function collectBillingEvidence(
  ctx: VerifyContext,
  taskResult: TaskEvidenceResult,
  options: VerifyKernelOptions,
): Promise<BillingEvidenceResult> {
  const { taskId, session, sessionLoadError, expectedPoints, expectedChargeSource, contract } = ctx;
  const { terminalStatus } = taskResult;

  let scoreLogsToReconcile: ScoreLogEntry[] | undefined = options.scoreLogs;
  let billingSource = options.scoreLogs ? 'score_logs' : 'missing_logs';
  let billingQueryError: string | undefined;

  // 优先采用数据库物理落库流水 (Physical Database Records from pq_score_log)
  if (!scoreLogsToReconcile && taskResult.dbEvidence?.recordsFound?.pq_score_log) {
    const dbLogs = taskResult.dbEvidence.recordsFound.pq_score_log;
    const backendId =
      taskResult.dbEvidence.recordsFound.pq_volcengine_ai_task?.id !== undefined
        ? Number(taskResult.dbEvidence.recordsFound.pq_volcengine_ai_task.id)
        : undefined;
    const mapped = mapDbScoreLogsToScoreLogEntries(dbLogs, taskId, backendId);
    if (mapped.length > 0) {
      scoreLogsToReconcile = mapped;
      billingSource = 'DATABASE_PHYSICAL_RECORD:pq_score_log';
      billingQueryError = undefined;
    }
  }

  // 兜底回退：当无数据库流水且存在 session 时，调用 FastAdmin HTTP 接口查询
  if (!scoreLogsToReconcile && session) {
    const queryRes = await queryTaskBillingLogs(taskId, session);
    if (queryRes.status === 'QUERY_SUCCESS') {
      scoreLogsToReconcile = queryRes.scoreLogs;
      billingSource = queryRes.source;
    } else {
      billingQueryError = queryRes.error || `账单查询异常 [${queryRes.status}]`;
      billingSource = queryRes.source;
    }
  }

  const hasScoreLogs = Array.isArray(scoreLogsToReconcile);
  const billingTerminalStatus = terminalStatus === 'PROCESSING' ? 'UNKNOWN' : terminalStatus;
  const billing = hasScoreLogs
    ? BillingOracle.reconcileTaskLedger({
        taskId,
        terminalStatus: billingTerminalStatus,
        expectedPoints,
        expectedChargeSource,
        scoreLogs: scoreLogsToReconcile!,
      })
    : undefined;

  let billingEvidence: BillingEvidence;
  let invariantsEvidence: InvariantsEvidence;
  let invariants: { antiDoubleBilling: boolean; netChargeZero: boolean; refundIdempotency: boolean } | undefined;

  if (billing) {
    const hasBillingViolations = Boolean(
      billing.duplicateCharged ||
      billing.duplicateRefunded ||
      billing.missingRefund ||
      billing.underCharged ||
      billing.overCharged ||
      billing.antiDoubleBilling === false ||
      billing.netChargeZero === false ||
      billing.refundIdempotency === false,
    );
    const billingStatus: EvidenceStatus = hasBillingViolations ? 'FAIL' : billing.passed ? 'PASS' : 'UNVERIFIED';

    const isSuccessEmpty = scoreLogsToReconcile && scoreLogsToReconcile.length === 0;
    const reason = !billing.passed
      ? isSuccessEmpty
        ? '真实数据源明确确认该任务在查询范围内无流水记录 [QUERY_SUCCESS + 0 records]'
        : billing.reasons.join(', ')
      : undefined;

    billingEvidence = {
      status: billingStatus,
      source: billingSource,
      expectedPoints,
      expectedChargeSource,
      preDeductedPoints: billing.preDeductedPoints,
      settledPoints: billing.settledPoints,
      refundedPoints: billing.refundedPoints,
      netDeductedPoints: billing.netDeductedPoints,
      reason,
    };

    const antiDouble = billing.antiDoubleBilling;
    const netZero = billing.netChargeZero;
    const refundIdem = billing.refundIdempotency;

    const antiDoubleItem: InvariantDetail =
      antiDouble === true
        ? { status: 'PASS', evidence: { preDeductCount: billing.preDeductCount } }
        : antiDouble === false
          ? { status: 'FAIL', reason: '违背防重复扣费不变量: 存在多笔扣费或重复扣款' }
          : { status: 'UNVERIFIED', reason: '缺少有效预扣流水，防重复扣费不变量未核验 [UNVERIFIED]' };

    const netZeroItem: InvariantDetail =
      netZero === true
        ? { status: 'PASS', evidence: { netDeductedPoints: billing.netDeductedPoints } }
        : netZero === false
          ? {
              status: 'FAIL',
              reason:
                terminalStatus === 'FAILED'
                  ? '违背失败净扣归零不变量: 失败任务净扣不为 0 或少/超额退款'
                  : '计费不匹配预期扣费',
            }
          : { status: 'UNVERIFIED', reason: '任务终态未知或缺少有效账务记录，失败净扣归零不变量未核验 [UNVERIFIED]' };

    const refundIdemItem: InvariantDetail =
      refundIdem === true
        ? { status: 'PASS', evidence: { refundCount: billing.refundCount } }
        : refundIdem === false
          ? { status: 'FAIL', reason: '违背退款幂等核销不变量: 存在重复退款、异常退款或失败未退款' }
          : { status: 'UNVERIFIED', reason: '缺少有效预扣或退款流水，退款幂等核销不变量未核验 [UNVERIFIED]' };

    const anyInvFailed =
      antiDoubleItem.status === 'FAIL' || netZeroItem.status === 'FAIL' || refundIdemItem.status === 'FAIL';
    const allInvPassed =
      antiDoubleItem.status === 'PASS' && netZeroItem.status === 'PASS' && refundIdemItem.status === 'PASS';
    const invStatus: EvidenceStatus = anyInvFailed ? 'FAIL' : allInvPassed ? 'PASS' : 'UNVERIFIED';

    invariantsEvidence = {
      status: invStatus,
      antiDoubleBilling: antiDouble,
      netChargeZero: netZero,
      refundIdempotency: refundIdem,
      details: {
        antiDoubleBilling: antiDoubleItem,
        netChargeZero: netZeroItem,
        refundIdempotency: refundIdemItem,
      },
      reason: anyInvFailed
        ? [antiDoubleItem.reason, netZeroItem.reason, refundIdemItem.reason].filter(Boolean).join('; ')
        : undefined,
    };

    invariants = billing
      ? {
          antiDoubleBilling: antiDouble === true,
          netChargeZero: netZero === true,
          refundIdempotency: refundIdem === true,
        }
      : undefined;
  } else {
    const skipReason = sessionLoadError
      ? `凭据加载失败 (${sessionLoadError})，缺少真实账务证据 [UNVERIFIED]`
      : billingQueryError
        ? `账单流水查询异常 (${billingQueryError})，缺少真实账务证据 [UNVERIFIED]`
        : terminalStatus === 'FAILED'
          ? '未提供账单流水，无法核验失败退款净扣归零，缺少真实账务证据获取能力 [SKIPPED_NO_LOGS]'
          : '未提供账单流水，缺少真实账务证据获取能力 [SKIPPED_NO_LOGS]';
    billingEvidence = {
      status: 'UNVERIFIED',
      source: billingSource,
      expectedPoints,
      expectedChargeSource,
      reason: skipReason,
    };
    invariantsEvidence = {
      status: 'UNVERIFIED',
      details: {
        antiDoubleBilling: { status: 'UNVERIFIED', reason: skipReason },
        netChargeZero: { status: 'UNVERIFIED', reason: skipReason },
        refundIdempotency: { status: 'UNVERIFIED', reason: skipReason },
      },
      reason: skipReason,
    };
  }

  if (!contract.pricing.allowPass) {
    billingEvidence = {
      ...billingEvidence,
      status: 'UNVERIFIED',
      reason: `真实刊例定价未确定 (${contract.pricing.source})，不可用于生产 PASS 验收 [BLOCKED_FALLBACK_PRICING]`,
    };
  }

  return {
    billing,
    billingEvidence,
    invariantsEvidence,
    invariants,
    billingSource,
    scoreLogsToReconcile,
  };
}
