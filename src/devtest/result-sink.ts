/**
 * Panqu AI DevTest — Result Sink & Export Mapping (ReportPortal Native Absorption)
 *
 * 核心架构约束 (遵循 docs/ARCHITECTURE_FREEZE.md 受控扩展原则):
 * 1. 最小 ResultSink 端口：仅定义单向接收结果的端口，严格禁止具备回写能力或改变核心状态；
 * 2. 纯函数导出映射：实现 CanonicalVerdictResult 到标准导出记录 (ExportableVerdictRecord) 的纯映射；
 * 3. 递归深冻结不可变复制：导出的记录与全部嵌套对象 (attributes, logs, blockers, metadata) 均递归深度冻结；
 * 4. 零副作用保护：严格禁止冻结或修改调用方传入的 CanonicalVerdictResult 及其内部结构；
 * 5. 零测试实现泄漏：生产模块只保留 ResultSink 端口和纯映射器，不包含任何内存或 Fixture 接收器。
 */

import fs from 'node:fs';
import path from 'node:path';
import type {
  CanonicalVerdict,
  CanonicalVerdictResult,
  CanonicalBlocker,
} from './canonical-verdict-engine.js';
import type { CanonicalTestSpec } from './canonical-protocol.js';

// ============================================================================
// 一、标准导出记录类型契约 (ReportPortal-Compatible Canonical Export Record)
// ============================================================================

export type ExportRecordStatus = 'PASSED' | 'FAILED' | 'SKIPPED' | 'INTERRUPTED';

export interface ExportRecordAttribute {
  readonly key: string;
  readonly value: string;
}

export interface ExportRecordLogEntry {
  readonly level: 'INFO' | 'WARN' | 'ERROR';
  readonly message: string;
  readonly timestamp: string;
}

export interface ExportableVerdictRecord {
  readonly recordId: string;
  readonly testId: string;
  readonly scenario?: string;
  readonly requirementId?: string;
  readonly status: ExportRecordStatus;
  readonly originalCanonicalVerdict: CanonicalVerdict;
  readonly exportedAt: string;
  readonly attributes: readonly ExportRecordAttribute[];
  readonly logs: readonly ExportRecordLogEntry[];
  readonly blockers: readonly CanonicalBlocker[];
  readonly reasons: readonly string[];
  readonly warnings: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

// ============================================================================
// 二、最小只读 ResultSink 端口契约 (One-Way Read-Only Sink)
// ============================================================================

/**
 * 最小 ResultSink 接口
 * 核心不变量：ResultSink 只能接收结果，绝对不能回写或改变核心状态
 */
export interface ResultSink<T = ExportableVerdictRecord> {
  readonly sinkName: string;
  sink(record: Readonly<T>): Promise<void> | void;
}

// ============================================================================
// 三、纯深冻结克隆辅助函数
// ============================================================================

function deepCloneAndFreeze<T>(val: T): T {
  if (val === null || typeof val !== 'object') {
    return val;
  }
  if (Array.isArray(val)) {
    const clonedArr = val.map((item) => deepCloneAndFreeze(item));
    return Object.freeze(clonedArr) as unknown as T;
  }
  const clonedObj: Record<string, unknown> = {};
  for (const key of Object.keys(val as Record<string, unknown>)) {
    clonedObj[key] = deepCloneAndFreeze((val as Record<string, unknown>)[key]);
  }
  return Object.freeze(clonedObj) as T;
}

// ============================================================================
// 四、纯函数导出映射器 (Pure Export Mapper)
// ============================================================================

export interface MapVerdictExportOptions {
  readonly recordId?: string;
  readonly exportedAt?: string; // 必须由调用方显式提供或使用确定性基准
  readonly spec?: Readonly<CanonicalTestSpec>;
  readonly extraAttributes?: readonly ExportRecordAttribute[];
}

/**
 * 将 CanonicalVerdictResult 纯函数映射为标准化导出记录
 * 严格保护入参：绝不冻结或修改调用方传入的 verdictResult
 */
export function mapVerdictToExportRecord(
  verdictResult: Readonly<CanonicalVerdictResult>,
  options?: Readonly<MapVerdictExportOptions>
): Readonly<ExportableVerdictRecord> {
  if (!verdictResult || typeof verdictResult !== 'object') {
    throw new Error('mapVerdictToExportRecord: verdictResult 必须为有效的 CanonicalVerdictResult 对象');
  }

  const spec = options?.spec;
  const exportedAt = options?.exportedAt || '1970-01-01T00:00:00.000Z';
  const recordId = options?.recordId || `rec-${verdictResult.testId || 'unknown'}`;

  // 1. 状态映射：严格映射，绝无状态篡改
  let status: ExportRecordStatus;
  if (verdictResult.verdict === 'PASS') {
    status = 'PASSED';
  } else if (verdictResult.verdict === 'FAIL') {
    status = 'FAILED';
  } else {
    // UNVERIFIED
    if (verdictResult.blockers && verdictResult.blockers.length > 0) {
      status = 'INTERRUPTED';
    } else {
      status = 'SKIPPED';
    }
  }

  // 2. 属性映射 (全新独立对象构造，不引用原对象指针)
  const attributes: ExportRecordAttribute[] = [
    { key: 'testId', value: verdictResult.testId || 'unknown' },
    { key: 'canonicalVerdict', value: verdictResult.verdict },
  ];

  if (spec) {
    if (spec.requirementId) {
      attributes.push({ key: 'requirementId', value: spec.requirementId });
    }
    if (spec.scenario) {
      attributes.push({ key: 'scenario', value: spec.scenario });
    }
    if (spec.executionMode) {
      attributes.push({ key: 'executionMode', value: spec.executionMode });
    }
    if (spec.sideEffectPolicy) {
      attributes.push({ key: 'sideEffectPolicy', value: spec.sideEffectPolicy });
    }
    if (spec.environment) {
      attributes.push({ key: 'environment', value: spec.environment });
    }
  }

  if (verdictResult.blockers && verdictResult.blockers.length > 0) {
    attributes.push({ key: 'blockerCount', value: String(verdictResult.blockers.length) });
    for (const blocker of verdictResult.blockers) {
      attributes.push({ key: `blocker:${blocker.code}`, value: blocker.message });
    }
  }

  if (options?.extraAttributes) {
    for (const ea of options.extraAttributes) {
      attributes.push({ key: ea.key, value: ea.value });
    }
  }

  // 3. 日志映射 (全新独立对象构造)
  const logs: ExportRecordLogEntry[] = [];

  for (const reason of verdictResult.reasons || []) {
    logs.push({
      level: verdictResult.verdict === 'FAIL' ? 'ERROR' : verdictResult.verdict === 'UNVERIFIED' ? 'WARN' : 'INFO',
      message: reason,
      timestamp: exportedAt,
    });
  }

  for (const warning of verdictResult.warnings || []) {
    logs.push({
      level: 'WARN',
      message: warning,
      timestamp: exportedAt,
    });
  }

  for (const a of verdictResult.assertionResults || []) {
    if (a.status === 'FAIL') {
      logs.push({
        level: 'ERROR',
        message: `断言失败 [${a.assertion.field}]: ${a.reason || '未达预期'}`,
        timestamp: exportedAt,
      });
    }
  }

  // 4. Blockers 独立深拷贝克隆 (绝不直接引用或冻结入参内部对象)
  const clonedBlockers: CanonicalBlocker[] = (verdictResult.blockers || []).map((b) => ({
    code: b.code,
    message: b.message,
    evidenceKey: b.evidenceKey,
  }));

  // 5. Metadata 独立克隆
  let clonedMetadata: Record<string, unknown> | undefined;
  if (spec?.metadata && typeof spec.metadata === 'object') {
    clonedMetadata = JSON.parse(JSON.stringify(spec.metadata));
  }

  // 6. 构造整体记录并执行真正的递归深冻结
  const rawRecord = {
    recordId,
    testId: verdictResult.testId,
    scenario: spec?.scenario,
    requirementId: spec?.requirementId,
    status,
    originalCanonicalVerdict: verdictResult.verdict,
    exportedAt,
    attributes,
    logs,
    blockers: clonedBlockers,
    reasons: [...(verdictResult.reasons || [])],
    warnings: [...(verdictResult.warnings || [])],
    metadata: clonedMetadata,
  };

  return deepCloneAndFreeze(rawRecord);
}

// ============================================================================
// 五、本地 NDJSON 单向结果追加导出器 (ReportPortal Native Absorption)
// ============================================================================

export interface NdjsonResultSinkOptions {
  readonly filePath?: string;
  readonly enabled?: boolean;
  readonly redactSensitive?: boolean;
  readonly writeFn?: (line: string) => void;
}

/**
 * 本地 NDJSON 单向结果追加导出器
 * 核心不变量：
 * 1. 严格只写不读，单向追加，绝不向 core-kernel 或裁决引擎回写任何状态；
 * 2. 默认脱敏敏感字段；
 * 3. 确定性序列化；
 * 4. 可配置关闭 (enabled: false)。
 */
export class NdjsonResultSink implements ResultSink<ExportableVerdictRecord> {
  readonly sinkName = 'ndjson-result-sink';
  private readonly filePath?: string;
  private readonly enabled: boolean;
  private readonly redactSensitive: boolean;
  private readonly writeFn?: (line: string) => void;

  constructor(options?: NdjsonResultSinkOptions) {
    this.filePath = options?.filePath;
    this.enabled = options?.enabled ?? true;
    this.redactSensitive = options?.redactSensitive ?? true;
    this.writeFn = options?.writeFn;
  }

  sink(record: Readonly<ExportableVerdictRecord>): void {
    if (!this.enabled) {
      return;
    }

    const sanitized = this.redactSensitive ? this.sanitizeRecord(record) : record;
    const line = JSON.stringify(sanitized) + '\n';

    if (this.writeFn) {
      this.writeFn(line);
      return;
    }

    if (this.filePath) {
      const resolved = path.resolve(process.cwd(), this.filePath);
      const dir = path.dirname(resolved);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.appendFileSync(resolved, line, 'utf-8');
    }
  }

  private sanitizeRecord(record: Readonly<ExportableVerdictRecord>): Record<string, unknown> {
    const raw = JSON.parse(JSON.stringify(record));
    const mask = (obj: any) => {
      if (!obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) {
        for (const item of obj) mask(item);
        return;
      }
      if (typeof obj.key === 'string' && typeof obj.value === 'string') {
        if (/token|secret|password|credential|authorization|auth/i.test(obj.key)) {
          obj.value = '***REDACTED***';
        }
      }
      for (const k of Object.keys(obj)) {
        if (/token|secret|password|credential|authorization|auth/i.test(k) && typeof obj[k] === 'string') {
          obj[k] = '***REDACTED***';
        } else if (typeof obj[k] === 'object') {
          mask(obj[k]);
        }
      }
    };
    mask(raw);
    return raw;
  }
}
