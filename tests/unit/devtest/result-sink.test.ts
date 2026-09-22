/**
 * Panqu AI DevTest — Result Sink & Export Mapping 测试套件 (ReportPortal 原生吸收)
 *
 * 核心架构边界验证 (docs/ARCHITECTURE_FREEZE.md):
 * 1. 纯函数映射：CanonicalVerdictResult 到标准导出记录 (ExportableVerdictRecord) 的纯映射；
 * 2. 状态映射不失真：PASS -> PASSED, FAIL -> FAILED, UNVERIFIED + blockers -> INTERRUPTED, UNVERIFIED -> SKIPPED；
 * 3. 递归深冻结不可变性：record 本身及嵌套 attribute、log、blocker、metadata 内部对象全部不可修改；
 * 4. 零副作用保护：不得冻结或修改调用方传入的 CanonicalVerdictResult；
 * 5. 生产与测试隔离：生产模块不含 InMemoryResultSink，仅在测试目录作为测试消费器实现。
 */

import { describe, expect, it } from 'vitest';
import {
  mapVerdictToExportRecord,
  type ExportableVerdictRecord,
  type ResultSink,
} from '../../../src/devtest/result-sink.js';
import type { CanonicalVerdictResult } from '../../../src/devtest/canonical-verdict-engine.js';
import type { CanonicalTestSpec } from '../../../src/devtest/canonical-protocol.js';

const DETERMINISTIC_TIMESTAMP = '2026-09-21T12:00:00.000Z';

/**
 * 仅用于测试验证的内存 ResultSink 实现
 */
class InMemoryResultSink implements ResultSink<ExportableVerdictRecord> {
  readonly sinkName = 'in-memory-result-sink';
  private readonly _records: ExportableVerdictRecord[] = [];

  sink(record: Readonly<ExportableVerdictRecord>): void {
    this._records.push(record);
  }

  getRecords(): readonly ExportableVerdictRecord[] {
    return Object.freeze([...this._records]);
  }

  clear(): void {
    this._records.length = 0;
  }
}

function createMockVerdictResult(overrides?: Partial<CanonicalVerdictResult>): CanonicalVerdictResult {
  return {
    verdict: 'PASS',
    testId: 'test-rp-001',
    requiredEvidenceEvaluation: {
      satisfied: true,
      missingEvidenceKeys: [],
      failedEvidenceKeys: [],
      unverifiedEvidenceKeys: [],
      details: [],
      matchedEnvelopes: {},
    },
    assertionResults: [
      {
        assertion: {
          field: 'status',
          operator: 'EQUALS',
          expectedValue: 'SUCCESS',
          critical: true,
        },
        status: 'PASS',
        actualValue: 'SUCCESS',
        expectedValue: 'SUCCESS',
        matched: true,
      },
    ],
    evidenceIdsUsed: ['ev-001'],
    reasons: ['全部必需证据通过且关键断言通过'],
    warnings: [],
    blockers: [],
    ...overrides,
  };
}

describe('Result Sink & Export Mapping 契约测试套件 (ReportPortal 原生吸收)', () => {
  // --------------------------------------------------------------------------
  // 1. PASS 状态映射为 PASSED
  // --------------------------------------------------------------------------
  it('1. CanonicalVerdict = PASS 纯函数映射为 PASSED 导出记录', () => {
    const verdict = createMockVerdictResult({ verdict: 'PASS' });
    const spec: CanonicalTestSpec = {
      testId: 'test-rp-001',
      requirementId: 'REQ-EXPORT-001',
      scenario: 'ROUTING_VERIFICATION',
      environment: 'offline',
      executionMode: 'FIXTURE',
      target: { targetType: 'scenario' },
      inputs: {},
      deterministicAssertions: [],
      costLimit: { maxCostPoints: 0 },
      sideEffectPolicy: 'READ_ONLY',
      requiredEvidence: ['SERVER_API:TASK_STATUS'],
    };

    const record = mapVerdictToExportRecord(verdict, {
      spec,
      exportedAt: DETERMINISTIC_TIMESTAMP,
      recordId: 'rec-test-rp-001',
    });

    expect(record.recordId).toBe('rec-test-rp-001');
    expect(record.testId).toBe('test-rp-001');
    expect(record.status).toBe('PASSED');
    expect(record.originalCanonicalVerdict).toBe('PASS');
    expect(record.exportedAt).toBe(DETERMINISTIC_TIMESTAMP);
    expect(record.requirementId).toBe('REQ-EXPORT-001');
    expect(record.scenario).toBe('ROUTING_VERIFICATION');

    const attrMap = Object.fromEntries(record.attributes.map((a) => [a.key, a.value]));
    expect(attrMap.canonicalVerdict).toBe('PASS');
    expect(attrMap.requirementId).toBe('REQ-EXPORT-001');
    expect(attrMap.executionMode).toBe('FIXTURE');
    expect(attrMap.sideEffectPolicy).toBe('READ_ONLY');
  });

  // --------------------------------------------------------------------------
  // 2. FAIL 状态映射为 FAILED
  // --------------------------------------------------------------------------
  it('2. CanonicalVerdict = FAIL 纯函数映射为 FAILED 导出记录，并记录断言失败日志', () => {
    const verdict = createMockVerdictResult({
      verdict: 'FAIL',
      reasons: ['关键确定性断言明确失败: status (断言失败)'],
      assertionResults: [
        {
          assertion: {
            field: 'status',
            operator: 'EQUALS',
            expectedValue: 'SUCCESS',
            critical: true,
          },
          status: 'FAIL',
          actualValue: 'FAILED',
          expectedValue: 'SUCCESS',
          matched: false,
          reason: '值不匹配',
        },
      ],
    });

    const record = mapVerdictToExportRecord(verdict, {
      exportedAt: DETERMINISTIC_TIMESTAMP,
    });

    expect(record.status).toBe('FAILED');
    expect(record.originalCanonicalVerdict).toBe('FAIL');

    const errorLogs = record.logs.filter((l) => l.level === 'ERROR');
    expect(errorLogs.length).toBeGreaterThanOrEqual(1);
    expect(errorLogs.some((l) => l.message.includes('断言失败 [status]'))).toBe(true);
  });

  // --------------------------------------------------------------------------
  // 3. UNVERIFIED + Blockers 状态映射为 INTERRUPTED
  // --------------------------------------------------------------------------
  it('3. CanonicalVerdict = UNVERIFIED 且带有 blockers 映射为 INTERRUPTED 导出记录', () => {
    const verdict = createMockVerdictResult({
      verdict: 'UNVERIFIED',
      blockers: [
        { code: 'TASK_NOT_TERMINAL', message: '任务未到终态' },
        { code: 'GATEWAY_CHANNEL_BLOCKED', message: '网关渠道未核准' },
      ],
      reasons: ['安全门禁阻断: TASK_NOT_TERMINAL, GATEWAY_CHANNEL_BLOCKED'],
    });

    const record = mapVerdictToExportRecord(verdict, {
      exportedAt: DETERMINISTIC_TIMESTAMP,
    });

    expect(record.status).toBe('INTERRUPTED');
    expect(record.originalCanonicalVerdict).toBe('UNVERIFIED');
    expect(record.blockers).toHaveLength(2);

    const attrMap = Object.fromEntries(record.attributes.map((a) => [a.key, a.value]));
    expect(attrMap.blockerCount).toBe('2');
    expect(attrMap['blocker:TASK_NOT_TERMINAL']).toBe('任务未到终态');
  });

  // --------------------------------------------------------------------------
  // 4. UNVERIFIED (无 blocker) 状态映射为 SKIPPED
  // --------------------------------------------------------------------------
  it('4. CanonicalVerdict = UNVERIFIED 且无 blocker 映射为 SKIPPED 导出记录', () => {
    const verdict = createMockVerdictResult({
      verdict: 'UNVERIFIED',
      blockers: [],
      reasons: ['仅存在主观证据 AI_OBSERVATION，不能单独产生 PASS'],
    });

    const record = mapVerdictToExportRecord(verdict, {
      exportedAt: DETERMINISTIC_TIMESTAMP,
    });

    expect(record.status).toBe('SKIPPED');
    expect(record.originalCanonicalVerdict).toBe('UNVERIFIED');
    expect(record.blockers).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // 5. 递归深冻结：attribute、log、blocker、metadata 内部对象全部不可修改
  // --------------------------------------------------------------------------
  it('5. 导出记录实现真正的递归深冻结，修改内部 attribute、log、blocker、metadata 均报错', () => {
    const verdict = createMockVerdictResult({
      blockers: [{ code: 'PRICING_UNVERIFIED', message: '未核准单价' }],
    });
    const spec: CanonicalTestSpec = {
      testId: 'test-rp-001',
      requirementId: 'REQ-EXPORT-001',
      scenario: 'ROUTING_VERIFICATION',
      environment: 'offline',
      executionMode: 'FIXTURE',
      target: { targetType: 'scenario' },
      inputs: {},
      deterministicAssertions: [],
      costLimit: { maxCostPoints: 0 },
      sideEffectPolicy: 'READ_ONLY',
      requiredEvidence: ['SERVER_API:TASK_STATUS'],
      metadata: { nestedTag: { deepKey: 'val' } },
    };

    const record = mapVerdictToExportRecord(verdict, {
      spec,
      exportedAt: DETERMINISTIC_TIMESTAMP,
    });

    // 1. 顶层对象冻结
    expect(Object.isFrozen(record)).toBe(true);

    // 2. 数组冻结
    expect(Object.isFrozen(record.attributes)).toBe(true);
    expect(Object.isFrozen(record.logs)).toBe(true);
    expect(Object.isFrozen(record.blockers)).toBe(true);

    // 3. 内部元素对象深冻结
    expect(Object.isFrozen(record.attributes[0])).toBe(true);
    expect(Object.isFrozen(record.logs[0])).toBe(true);
    expect(Object.isFrozen(record.blockers[0])).toBe(true);
    expect(Object.isFrozen(record.metadata)).toBe(true);
    expect(Object.isFrozen((record.metadata as any)?.nestedTag)).toBe(true);

    // 4. 尝试修改内部元素应当抛出异常
    expect(() => {
      (record.attributes[0] as any).value = 'MUTATED';
    }).toThrow();
    expect(() => {
      (record.logs[0] as any).message = 'MUTATED';
    }).toThrow();
    expect(() => {
      (record.blockers[0] as any).code = 'MUTATED';
    }).toThrow();
    expect(() => {
      ((record.metadata as any).nestedTag as any).deepKey = 'MUTATED';
    }).toThrow();
  });

  // --------------------------------------------------------------------------
  // 6. 不得冻结或修改调用方传入的 CanonicalVerdictResult
  // --------------------------------------------------------------------------
  it('6. mapVerdictToExportRecord 严格不冻结、不修改调用方传入的原始 CanonicalVerdictResult 及其子对象', () => {
    const rawBlocker = { code: 'RAW_BLOCKER', message: '原始阻断项' };
    const rawVerdict: CanonicalVerdictResult = createMockVerdictResult({
      blockers: [rawBlocker],
    });

    // 调用前入参未被冻结
    expect(Object.isFrozen(rawVerdict)).toBe(false);
    expect(Object.isFrozen(rawBlocker)).toBe(false);

    const record = mapVerdictToExportRecord(rawVerdict, {
      exportedAt: DETERMINISTIC_TIMESTAMP,
    });

    // 调用后入参仍未被冻结，保持原样
    expect(Object.isFrozen(rawVerdict)).toBe(false);
    expect(Object.isFrozen(rawBlocker)).toBe(false);
    expect(Object.isFrozen(rawVerdict.blockers)).toBe(false);

    // 证明入参对象可以正常修改，不受导出深冻结影响
    rawBlocker.message = '调用方后续合法修改';
    expect(rawVerdict.blockers[0].message).toBe('调用方后续合法修改');

    // 而导出的记录保持不可变独立副本
    expect(record.blockers[0].message).toBe('原始阻断项');
    expect(Object.isFrozen(record.blockers[0])).toBe(true);
  });

  // --------------------------------------------------------------------------
  // 7. ResultSink 消费能力验证：单向接收，严格无回写通道
  // --------------------------------------------------------------------------
  it('7. InMemoryResultSink 单向接收导出记录，无任何修改 core-kernel 或 verdict 的方法', async () => {
    const sink: ResultSink<ExportableVerdictRecord> = new InMemoryResultSink();
    expect(sink.sinkName).toBe('in-memory-result-sink');

    const verdict = createMockVerdictResult({ testId: 'test-sink-001' });
    const record = mapVerdictToExportRecord(verdict, {
      exportedAt: DETERMINISTIC_TIMESTAMP,
    });

    await sink.sink(record);

    const memSink = sink as InMemoryResultSink;
    const records = memSink.getRecords();
    expect(records).toHaveLength(1);
    expect(records[0].testId).toBe('test-sink-001');
    expect(Object.isFrozen(records)).toBe(true);
  });
});
