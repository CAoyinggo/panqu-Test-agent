/**
 * DiversionEligibilityProducer — 把 NewAPI 分流「运行时资格」判定接入 verify 流水线
 * =============================================================================
 * 可测性提升：`newapi-route-eligibility.ts` 是纯判定模块；本 producer 作为标准
 * EvidenceProducer 端口，把「预测分流决策(模型×分辨率×画面比例×启用)」与
 * 「数据库实际落库的分流标记(extra.diversion / newapi_image / volcengine_ai_task.line)」
 * 对照，产出可裁决的 `SERVER_API:DIVERSION_ELIGIBILITY` 证据信封。
 *
 * opt-in：仅当 verify 传入 `diversionEligibility` 时挂载，不影响既有用例。
 * 纯逻辑 + 只读入参，零 I/O、零网络（规则 JSON 与 observed 均由调用方注入）。
 */
import type { CanonicalEvidenceEnvelope, EvidenceSourceType } from './canonical-protocol.js';
import type { EvidenceProducer, EvidenceProducerContext } from './execution-ports.js';
import type { DatabaseRawCollection } from './database-evidence-producer.js';
import {
  evaluateVideoDiversion,
  evaluateImageDiversion,
  type VideoDiversionInput,
  type ImageDiversionInput,
} from './newapi-route-eligibility.js';

/** verify 传入的分流资格断言输入（video 或 image 二选一）。 */
export interface DiversionEligibilityInput {
  mediaType: 'video' | 'image';
  video?: VideoDiversionInput;
  image?: ImageDiversionInput;
}

/** 从数据库落库记录中提取「实际是否分流」。 */
function extractObserved(db: DatabaseRawCollection | undefined): {
  hasObserved: boolean;
  observedLine?: number;
  observedDiverted?: boolean;
} {
  const rec = db?.recordsFound;
  if (!rec || db?.status !== 'VERIFIED') return { hasObserved: false };
  // 源表 extra 可能挂在 video 或各 image 源表
  const src =
    rec.pq_aivideo_new ??
    rec.pq_aivideo_goods ??
    rec.pq_aivideo_character ??
    rec.pq_aivideo_scene ??
    rec.pq_aivideo_fusion;
  let extra: Record<string, unknown> | undefined;
  const rawExtra = (src as Record<string, unknown> | undefined)?.extra;
  if (typeof rawExtra === 'string') {
    try {
      extra = JSON.parse(rawExtra);
    } catch {
      extra = undefined;
    }
  } else if (rawExtra && typeof rawExtra === 'object') {
    extra = rawExtra as Record<string, unknown>;
  }
  const task = rec.pq_volcengine_ai_task as Record<string, unknown> | undefined;
  const line = task?.line !== undefined ? Number(task.line) : undefined;
  const diversionTag = extra?.diversion !== undefined ? Number(extra.diversion) : undefined;
  const newapiImage = extra?.newapi_image !== undefined ? Number(extra.newapi_image) : undefined;
  if (line === undefined && diversionTag === undefined && newapiImage === undefined) {
    return { hasObserved: false };
  }
  const observedDiverted = line === 10 || diversionTag === 10 || newapiImage === 1;
  return { hasObserved: true, observedLine: line ?? diversionTag, observedDiverted };
}

// APPEND_PRODUCER

export class DiversionEligibilityProducer implements EvidenceProducer {
  readonly producerName = 'diversion-eligibility-producer';
  readonly sourceType: EvidenceSourceType = 'SERVER_API';

  constructor(
    private readonly input?: DiversionEligibilityInput,
    private readonly observedDb?: DatabaseRawCollection,
  ) {}

  produce(rawCollection: unknown, context: EvidenceProducerContext): CanonicalEvidenceEnvelope[] {
    const raw = (rawCollection ?? {}) as Record<string, unknown>;
    const input = this.input ?? (raw.diversionEligibility as DiversionEligibilityInput | undefined);
    if (!input || (!input.video && !input.image)) return []; // opt-in：无输入不产证据

    const db = this.observedDb ?? (raw.dbRawCollection as DatabaseRawCollection | undefined);
    const testId = context.testId;
    const capturedAt = (context.capturedAt as string) || new Date().toISOString();
    const environment = context.environment;
    const subjectId = context.subjectId;

    // 预测分流决策
    const predicted =
      input.mediaType === 'image' && input.image
        ? (() => {
            const r = evaluateImageDiversion(input.image!);
            return { line: r.diverted ? 10 : 0, diverted: r.diverted, decision: r.decision, reason: r.reason, hardError: r.hardError };
          })()
        : input.video
          ? (() => {
              const r = evaluateVideoDiversion(input.video!);
              return { line: r.line, diverted: r.line === 10, decision: r.decision, reason: r.reason, hardError: r.hardError };
            })()
          : { line: 0, diverted: false, decision: 'NO_INPUT', reason: '缺少 video/image 输入', hardError: false };

    const observed = extractObserved(db);

    let observationStatus: 'PASS' | 'FAIL' | 'UNVERIFIED';
    let matched: boolean | undefined;
    if (!observed.hasObserved) {
      observationStatus = 'UNVERIFIED'; // 只有预测、无落库对照
    } else {
      matched = predicted.diverted === observed.observedDiverted;
      observationStatus = matched ? 'PASS' : 'FAIL';
    }

    return [
      {
        evidenceId: `${testId}-diversion-eligibility`,
        testId,
        sourceTool: this.producerName,
        sourceType: 'SERVER_API',
        evidenceKey: 'SERVER_API:DIVERSION_ELIGIBILITY',
        observationStatus,
        capturedAt,
        environment,
        subjectType: 'task',
        subjectId,
        normalizedFields: {
          mediaType: input.mediaType,
          predictedLine: predicted.line,
          predictedDiverted: predicted.diverted,
          predictedDecision: predicted.decision,
          predictedReason: predicted.reason,
          predictedHardError: Boolean(predicted.hardError),
          hasObserved: observed.hasObserved,
          observedLine: observed.observedLine,
          observedDiverted: observed.observedDiverted,
          matched,
        },
        provenance: 'DIVERSION_ELIGIBILITY:newapi_route_rules_gate(model×resolution×aspect×enabled)',
        confidence: observed.hasObserved ? 1.0 : 0.0,
        immutable: true,
        redacted: false,
        collectionStatus: observed.hasObserved ? 'SUCCESS' : 'MISSING',
      },
    ];
  }
}

