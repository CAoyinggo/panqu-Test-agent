/**
 * Panqu AI DevTest — Phase 3 无依赖 UI Adapter 契约行为测试
 *
 * 核心架构边界 (严格遵守 docs/ARCHITECTURE_FREEZE.md):
 * 1. 业务模块已全部提取至生产代码 src/devtest/ui-adapters.ts；
 * 2. 本测试文件删除测试内重复实现，仅保留精简、高密度的契约行为验证；
 * 3. 确定性原则：evidenceId 与 capturedAt 严格由调用方提供，零 Date.now() / Math.random()；
 * 4. 视觉辅助结果只能是 AI_OBSERVATION，不能单独产生 PASS，且不可覆盖确定性失败；
 * 5. 适配器无裁决权，全系统唯一裁决权威仍为 CanonicalVerdictEngine。
 */

import { describe, expect, it } from 'vitest';
import type { CanonicalTestSpec, CanonicalEvidenceEnvelope } from '../../../src/devtest/canonical-protocol.js';
import { validateEvidenceEnvelope } from '../../../src/devtest/canonical-protocol.js';
import {
  FORBIDDEN_VERDICT_FIELDS,
  type EvidenceProducer,
  type EvidenceProducerContext,
} from '../../../src/devtest/execution-ports.js';
import { evaluateCanonicalVerdict } from '../../../src/devtest/canonical-verdict-engine.js';
import {
  UIBrowserEvidenceProducer,
  UIVisualAiEvidenceProducer,
  readPngDimensions,
  type DeterministicProducerContext,
} from '../../../src/devtest/ui-adapters.js';
import { UIFixtureExecutionAdapter, type UIFixtureAdapterContext } from '../../helpers/ui-fixture-adapter.js';

// ============================================================================
// 测试辅助常量与工厂
// ============================================================================

const DETERMINISTIC_CAPTURED_AT = '2026-09-21T10:00:00.000Z';

const DETERMINISTIC_EVIDENCE_IDS = {
  'BROWSER:TASK_STATUS_DOM': 'ev-dom-001',
  'BROWSER:NETWORK_RESPONSE': 'ev-net-001',
  'BROWSER:SCREENSHOT_REF': 'ev-screen-001',
  'AI_OBSERVATION:TASK_STATUS_VISUAL': 'ev-ai-001',
  'BROWSER:INJECTED_ASYNC_FACT': 'ev-injected-001',
} as const;

function createUiContext(overrides?: Partial<UIFixtureAdapterContext>): UIFixtureAdapterContext {
  return {
    capturedAt: DETERMINISTIC_CAPTURED_AT,
    evidenceIds: DETERMINISTIC_EVIDENCE_IDS,
    ...overrides,
  };
}

function createHistoryAuditSpec(overrides?: Partial<CanonicalTestSpec>): CanonicalTestSpec {
  const defaultSpec: CanonicalTestSpec = {
    testId: 'test-ui-history-audit-001',
    requirementId: 'REQ-UI-AUDIT-001',
    scenario: 'UI_HISTORY_TASK_STATUS_AUDIT',
    environment: 'offline',
    executionMode: 'FIXTURE',
    target: {
      targetType: 'scenario',
      taskId: 9527,
    },
    inputs: {
      pageUrl: '/console/tasks/history',
      rowSelector: 'tr[data-task-id="9527"]',
      action: 'CLICK_ROW_DETAIL',
      expectedStatusText: 'SUCCESS',
      screenshotPath: 'tests/fixtures/screenshots/task-9527.png',
    },
    deterministicAssertions: [
      {
        field: 'domTaskStatus',
        operator: 'EQUALS',
        expectedValue: 'SUCCESS',
        critical: true,
        evidenceKey: 'BROWSER:TASK_STATUS_DOM',
        actualField: 'taskStatus',
        description: 'DOM 列表行状态徽章文本为 SUCCESS',
      },
      {
        field: 'networkTaskStatus',
        operator: 'EQUALS',
        expectedValue: 'SUCCESS',
        critical: true,
        evidenceKey: 'BROWSER:NETWORK_RESPONSE',
        actualField: 'taskStatus',
        description: '浏览器网络拦截接口返回状态为 SUCCESS',
      },
      {
        field: 'screenshotCaptured',
        operator: 'EQUALS',
        expectedValue: true,
        critical: false,
        evidenceKey: 'BROWSER:SCREENSHOT_REF',
        actualField: 'hasScreenshot',
        description: '捕获到真实存在的页面截图引用',
      },
    ],
    aiAssistedSteps: [
      {
        stepId: 'visual-badge-inspection',
        instruction: '检查历史记录行中任务 9527 的状态徽章视觉样式与高亮显示',
        expectedCriteria: '状态徽章以绿色高亮显示，且包含对勾完成图标，无异常红点',
      },
    ],
    costLimit: {
      maxCostPoints: 0,
      maxCostCny: 0,
      allowZeroCostOnly: true,
    },
    sideEffectPolicy: 'READ_ONLY',
    requiredEvidence: ['BROWSER:TASK_STATUS_DOM', 'BROWSER:NETWORK_RESPONSE', 'BROWSER:SCREENSHOT_REF'],
    metadata: {
      capturedAt: DETERMINISTIC_CAPTURED_AT,
    },
  };

  return {
    ...defaultSpec,
    ...overrides,
  };
}

// ============================================================================
// Phase 3 契约验证测试套件 (精简生产模块引用版)
// ============================================================================

describe('Phase 3 无依赖 UI Adapter 契约测试套件 (Playwright & Midscene 原生吸收)', () => {
  const adapter = new UIFixtureExecutionAdapter();

  // --------------------------------------------------------------------------
  // 1. 架构职责隔离：UI 适配器严禁输出 SERVER_API，自身证据仅限 BROWSER/AI_OBSERVATION
  // --------------------------------------------------------------------------
  it('1. UI 适配器职责严格受限，仅输出 BROWSER 与 AI_OBSERVATION，严禁跨界产出 SERVER_API', async () => {
    const spec = createHistoryAuditSpec();
    const result = await adapter.execute(
      spec,
      createUiContext({
        rawBrowser: {
          pageUrl: '/console/tasks/history',
          rowSelector: 'tr[data-task-id="9527"]',
          rowFound: true,
          domTaskStatus: 'SUCCESS',
          networkTaskStatus: 'SUCCESS',
          networkHttpStatus: 200,
          screenshotPath: 'tests/fixtures/screenshots/task-9527.png',
        },
        rawVisualAi: {
          visualInference: 'CONFIRMED',
        },
      }),
    );

    expect(result.status).toBe('COMPLETED');
    expect(result.evidence.length).toBeGreaterThanOrEqual(3);

    for (const env of result.evidence) {
      expect(env.sourceType).not.toBe('SERVER_API');
      expect(env.evidenceKey.startsWith('SERVER_API:')).toBe(false);
      expect(['BROWSER', 'AI_OBSERVATION']).toContain(env.sourceType);
    }
  });

  // --------------------------------------------------------------------------
  // 2. 纯 UI 确定性自动化：DOM + 网络 + 真实物理截图全部显式采集成功 -> PASS
  // --------------------------------------------------------------------------
  it('2. UI 确定性步骤 (DOM/网络/真实截图) 显式输入成功事实时，纯 UI 场景裁决为 PASS', async () => {
    const spec = createHistoryAuditSpec();
    const result = await adapter.execute(
      spec,
      createUiContext({
        rawBrowser: {
          pageUrl: '/console/tasks/history',
          rowSelector: 'tr[data-task-id="9527"]',
          rowFound: true,
          domTaskStatus: 'SUCCESS',
          networkTaskStatus: 'SUCCESS',
          networkHttpStatus: 200,
          screenshotPath: 'tests/fixtures/screenshots/task-9527.png',
        },
        rawVisualAi: {
          visualInference: 'CONFIRMED',
        },
      }),
    );

    const verdictResult = evaluateCanonicalVerdict(spec, result.evidence);
    expect(verdictResult.verdict).toBe('PASS');
    expect(verdictResult.blockers).toHaveLength(0);
    expect(verdictResult.requiredEvidenceEvaluation.satisfied).toBe(true);
    expect(verdictResult.reasons).toContain('全部必需证据通过且所有关键确定性断言验证成功');
  });

  // --------------------------------------------------------------------------
  // 3. 服务端终态硬门禁：当场景要求 SERVER_API 时，缺少服务端事实严格阻断为 UNVERIFIED
  // --------------------------------------------------------------------------
  it('3. 终态必须由服务端确认：当场景要求 SERVER_API 证据时，离线 UI 绝不伪造，严格阻断为 UNVERIFIED 并附带 TASK_NOT_TERMINAL', async () => {
    const specWithServerApi = createHistoryAuditSpec({
      requiredEvidence: ['BROWSER:TASK_STATUS_DOM', 'BROWSER:NETWORK_RESPONSE', 'SERVER_API:TASK_STATUS'],
      deterministicAssertions: [
        {
          field: 'domTaskStatus',
          operator: 'EQUALS',
          expectedValue: 'SUCCESS',
          critical: true,
          evidenceKey: 'BROWSER:TASK_STATUS_DOM',
          actualField: 'taskStatus',
        },
      ],
    });

    const uiResult = await adapter.execute(
      specWithServerApi,
      createUiContext({
        rawBrowser: {
          rowFound: true,
          domTaskStatus: 'SUCCESS',
          networkTaskStatus: 'SUCCESS',
          screenshotPath: 'tests/fixtures/screenshots/task-9527.png',
        },
        rawVisualAi: {
          visualInference: 'CONFIRMED',
        },
      }),
    );

    const verdictResult = evaluateCanonicalVerdict(specWithServerApi, uiResult.evidence);
    expect(verdictResult.verdict).toBe('UNVERIFIED');
    expect(verdictResult.requiredEvidenceEvaluation.missingEvidenceKeys).toContain('SERVER_API:TASK_STATUS');
    expect(verdictResult.blockers.some((b) => b.code === 'TASK_NOT_TERMINAL')).toBe(true);
  });

  // --------------------------------------------------------------------------
  // 4. Midscene 视觉辅助边界：AI_OBSERVATION 绝对不能单独产生 PASS
  // --------------------------------------------------------------------------
  it('4. 仅有 AI_OBSERVATION 视觉辅助观察时，裁决结果必须为 UNVERIFIED，绝对不能单独产生 PASS', async () => {
    const visualOnlySpec = createHistoryAuditSpec({
      requiredEvidence: ['AI_OBSERVATION:TASK_STATUS_VISUAL'],
      deterministicAssertions: [],
    });

    const visualProducer = new UIVisualAiEvidenceProducer();
    const aiEnvs = await visualProducer.produce({ visualInference: 'CONFIRMED' }, {
      testId: visualOnlySpec.testId,
      environment: visualOnlySpec.environment,
      subjectType: 'task',
      subjectId: 9527,
      capturedAt: DETERMINISTIC_CAPTURED_AT,
      evidenceIds: DETERMINISTIC_EVIDENCE_IDS,
    } as DeterministicProducerContext);

    const verdictResult = evaluateCanonicalVerdict(visualOnlySpec, aiEnvs);
    expect(verdictResult.verdict).toBe('UNVERIFIED');
    expect(verdictResult.reasons.some((r) => r.includes('AI_OBSERVATION') && r.includes('不能单独产生 PASS'))).toBe(
      true,
    );
  });

  // --------------------------------------------------------------------------
  // 5. 确定性事实失败检测：DOM 明确失败时裁决为 FAIL，视觉 PASS 无法覆盖
  // --------------------------------------------------------------------------
  it('5. 确定性 DOM 事实明确失败 (FAILED) 时，关键断言失败且裁决结果为 FAIL，视觉 PASS 无法覆盖', async () => {
    const spec = createHistoryAuditSpec();
    const result = await adapter.execute(
      spec,
      createUiContext({
        rawBrowser: {
          rowFound: true,
          domTaskStatus: 'FAILED',
          networkTaskStatus: 'SUCCESS',
          screenshotPath: 'tests/fixtures/screenshots/task-9527.png',
        },
        rawVisualAi: {
          visualInference: 'CONFIRMED', // 视觉假阳性
        },
      }),
    );

    const verdictResult = evaluateCanonicalVerdict(spec, result.evidence);
    expect(verdictResult.verdict).toBe('FAIL');
    expect(verdictResult.requiredEvidenceEvaluation.failedEvidenceKeys).toContain('BROWSER:TASK_STATUS_DOM');
  });

  // --------------------------------------------------------------------------
  // 6. 确定性事实失败检测：网络接口明确失败时裁决为 FAIL，视觉 PASS 无法覆盖
  // --------------------------------------------------------------------------
  it('6. 确定性网络事实明确失败 (FAILED) 时，关键断言失败且裁决结果为 FAIL，视觉 PASS 无法覆盖', async () => {
    const spec = createHistoryAuditSpec();
    const result = await adapter.execute(
      spec,
      createUiContext({
        rawBrowser: {
          rowFound: true,
          domTaskStatus: 'SUCCESS',
          networkTaskStatus: 'FAILED',
          screenshotPath: 'tests/fixtures/screenshots/task-9527.png',
        },
        rawVisualAi: {
          visualInference: 'CONFIRMED',
        },
      }),
    );

    const verdictResult = evaluateCanonicalVerdict(spec, result.evidence);
    expect(verdictResult.verdict).toBe('FAIL');
    expect(verdictResult.requiredEvidenceEvaluation.failedEvidenceKeys).toContain('BROWSER:NETWORK_RESPONSE');
  });

  // --------------------------------------------------------------------------
  // 7. 防伪防冒充：离线 FIXTURE 严禁冒充 SERVER_API (sourceType=FIXTURE)
  // --------------------------------------------------------------------------
  it('7. 离线 Fixture 试图将自身声明为 SERVER_API (sourceType=FIXTURE) 时，协议校验拒绝并被裁决引擎拦截', () => {
    const forgedEnv: CanonicalEvidenceEnvelope = {
      evidenceId: 'ev-forged-01',
      testId: 'test-ui-history-audit-001',
      sourceTool: 'offline-fixture',
      sourceType: 'FIXTURE',
      evidenceKey: 'SERVER_API:TASK_STATUS',
      observationStatus: 'PASS',
      capturedAt: DETERMINISTIC_CAPTURED_AT,
      environment: 'offline',
      subjectType: 'task',
      subjectId: 9527,
      normalizedFields: { taskStatus: 'SUCCESS' },
      provenance: 'FIXTURE (offline-mock)',
      confidence: 1.0,
      immutable: true,
      redacted: true,
      collectionStatus: 'SUCCESS',
    };

    const validation = validateEvidenceEnvelope(forgedEnv);
    expect(validation.valid).toBe(false);
    expect(validation.errors.some((e) => e.code === 'SERVER_API_IMPERSONATION_FORBIDDEN')).toBe(true);
    expect(validation.errors.some((e) => e.code === 'SOURCE_TYPE_KEY_MISMATCH')).toBe(true);

    const spec = createHistoryAuditSpec();
    const verdictResult = evaluateCanonicalVerdict(spec, [forgedEnv]);
    expect(verdictResult.verdict).toBe('UNVERIFIED');
    expect(verdictResult.blockers.some((b) => b.code === 'UNTRUSTED_EVIDENCE_SOURCE')).toBe(true);
  });

  // --------------------------------------------------------------------------
  // 8. 防伪防冒充：SERVER_API provenance 混入 FIXTURE 被严厉拦截
  // --------------------------------------------------------------------------
  it('8. 试图在 SERVER_API 的 provenance 中混入 FIXTURE 伪造时，协议校验拒绝 (UNTRUSTED_PROVENANCE_FOR_SERVER_API)', () => {
    const forgedProvenanceEnv: CanonicalEvidenceEnvelope = {
      evidenceId: 'ev-forged-prov-01',
      testId: 'test-ui-history-audit-001',
      sourceTool: 'offline-fixture',
      sourceType: 'SERVER_API',
      evidenceKey: 'SERVER_API:TASK_STATUS',
      observationStatus: 'PASS',
      capturedAt: DETERMINISTIC_CAPTURED_AT,
      environment: 'offline',
      subjectType: 'task',
      subjectId: 9527,
      normalizedFields: { taskStatus: 'SUCCESS' },
      provenance: 'SERVER_API (FIXTURE mock generator)',
      confidence: 1.0,
      immutable: true,
      redacted: true,
      collectionStatus: 'SUCCESS',
    };

    const validation = validateEvidenceEnvelope(forgedProvenanceEnv);
    expect(validation.valid).toBe(false);
    expect(validation.errors.some((e) => e.code === 'UNTRUSTED_PROVENANCE_FOR_SERVER_API')).toBe(true);
  });

  // --------------------------------------------------------------------------
  // 9. Fail-Closed 事实保真：未提供显式 rawBrowser 事实时，严禁从 TestSpec 借用期望值
  // --------------------------------------------------------------------------
  it('9. Fail-Closed 事实保真：未提供显式 rawBrowser 事实时，适配器与采集器严禁从 TestSpec 借用期望值，严格返回 COLLECTION_FAILED', async () => {
    const spec = createHistoryAuditSpec();
    const result = await adapter.execute(spec, createUiContext());

    const domEnv = result.evidence.find((e) => e.evidenceKey === 'BROWSER:TASK_STATUS_DOM');
    expect(domEnv).toBeDefined();
    expect(domEnv?.collectionStatus).toBe('COLLECTION_FAILED');
    expect(domEnv?.observationStatus).toBe('UNVERIFIED');
    expect(domEnv?.error?.code).toBe('DOM_FACT_MISSING');

    const netEnv = result.evidence.find((e) => e.evidenceKey === 'BROWSER:NETWORK_RESPONSE');
    expect(netEnv).toBeDefined();
    expect(netEnv?.collectionStatus).toBe('COLLECTION_FAILED');
    expect(netEnv?.error?.code).toBe('NETWORK_FACT_MISSING');

    const verdictResult = evaluateCanonicalVerdict(spec, result.evidence);
    expect(verdictResult.verdict).toBe('UNVERIFIED');
    expect(verdictResult.requiredEvidenceEvaluation.missingEvidenceKeys).toContain('BROWSER:TASK_STATUS_DOM');
  });

  // --------------------------------------------------------------------------
  // 10. Fail-Closed 事实保真：未提供显式视觉推断输入时，严格返回 COLLECTION_FAILED
  // --------------------------------------------------------------------------
  it('10. Fail-Closed 事实保真：未提供显式视觉推断输入时，视觉采集器严格返回 COLLECTION_FAILED / UNVERIFIED', async () => {
    const spec = createHistoryAuditSpec();
    const result = await adapter.execute(
      spec,
      createUiContext({
        rawBrowser: {
          rowFound: true,
          domTaskStatus: 'SUCCESS',
          networkTaskStatus: 'SUCCESS',
          screenshotPath: 'tests/fixtures/screenshots/task-9527.png',
        },
      }),
    );

    const aiEnv = result.evidence.find((e) => e.evidenceKey === 'AI_OBSERVATION:TASK_STATUS_VISUAL');
    expect(aiEnv).toBeDefined();
    expect(aiEnv?.collectionStatus).toBe('COLLECTION_FAILED');
    expect(aiEnv?.observationStatus).toBe('UNVERIFIED');
    expect(aiEnv?.error?.code).toBe('VISUAL_INFERENCE_MISSING');
  });

  // --------------------------------------------------------------------------
  // 11. Fail-Closed 事实保真：声明的截图物理文件不存在时，采集器返回 SCREENSHOT_FILE_NOT_FOUND
  // --------------------------------------------------------------------------
  it('11. Fail-Closed 事实保真：声明的截图物理文件不存在时，采集器返回 SCREENSHOT_FILE_NOT_FOUND / COLLECTION_FAILED', async () => {
    const spec = createHistoryAuditSpec();
    const result = await adapter.execute(
      spec,
      createUiContext({
        rawBrowser: {
          domTaskStatus: 'SUCCESS',
          networkTaskStatus: 'SUCCESS',
          screenshotPath: 'tests/fixtures/screenshots/ghost-image-not-exist.png',
        },
      }),
    );

    const screenEnv = result.evidence.find((e) => e.evidenceKey === 'BROWSER:SCREENSHOT_REF');
    expect(screenEnv).toBeDefined();
    expect(screenEnv?.collectionStatus).toBe('COLLECTION_FAILED');
    expect(screenEnv?.error?.code).toBe('SCREENSHOT_FILE_NOT_FOUND');
    expect(screenEnv?.normalizedFields.hasScreenshot).toBe(false);
  });

  // --------------------------------------------------------------------------
  // 12. 真实截图物理文件尺寸解析一致性验证
  // --------------------------------------------------------------------------
  it('12. 真实截图物理文件与 IHDR 尺寸解析完全一致 (1x1 真实物理 PNG 文件)', async () => {
    const spec = createHistoryAuditSpec();
    const result = await adapter.execute(
      spec,
      createUiContext({
        rawBrowser: {
          domTaskStatus: 'SUCCESS',
          networkTaskStatus: 'SUCCESS',
          screenshotPath: 'tests/fixtures/screenshots/task-9527.png',
        },
      }),
    );

    const screenEnv = result.evidence.find((e) => e.evidenceKey === 'BROWSER:SCREENSHOT_REF');
    expect(screenEnv?.collectionStatus).toBe('SUCCESS');
    expect(screenEnv?.observationStatus).toBe('PASS');
    expect(screenEnv?.normalizedFields.width).toBe(1);
    expect(screenEnv?.normalizedFields.height).toBe(1);
    expect(screenEnv?.normalizedFields.fileSizeBytes).toBe(67);

    // 直接验证 readPngDimensions
    const dims = readPngDimensions('tests/fixtures/screenshots/task-9527.png');
    expect(dims.width).toBe(1);
    expect(dims.height).toBe(1);
  });

  // --------------------------------------------------------------------------
  // 13. Fail-Closed 事实保真：DOM 定位失败时返回 COLLECTION_FAILED 并阻断为 UNVERIFIED
  // --------------------------------------------------------------------------
  it('13. Fail-Closed 事实保真：DOM 定位未找到目标行 (rowFound=false) 时返回 COLLECTION_FAILED，断言无法计算阻断为 UNVERIFIED', async () => {
    const spec = createHistoryAuditSpec();
    const result = await adapter.execute(
      spec,
      createUiContext({
        rawBrowser: {
          rowFound: false,
          networkTaskStatus: 'SUCCESS',
          screenshotPath: 'tests/fixtures/screenshots/task-9527.png',
        },
      }),
    );

    const domEnv = result.evidence.find((e) => e.evidenceKey === 'BROWSER:TASK_STATUS_DOM');
    expect(domEnv?.collectionStatus).toBe('COLLECTION_FAILED');
    expect(domEnv?.error?.code).toBe('DOM_ROW_NOT_FOUND');

    const verdictResult = evaluateCanonicalVerdict(spec, result.evidence);
    expect(verdictResult.verdict).toBe('UNVERIFIED');
    expect(verdictResult.requiredEvidenceEvaluation.missingEvidenceKeys).toContain('BROWSER:TASK_STATUS_DOM');
  });

  // --------------------------------------------------------------------------
  // 14. Fail-Closed 事实保真：网络拦截 HTTP 500 时返回 COLLECTION_FAILED 并阻断为 UNVERIFIED
  // --------------------------------------------------------------------------
  it('14. Fail-Closed 事实保真：网络拦截返回 HTTP 500 时返回 COLLECTION_FAILED，必需证据缺失阻断为 UNVERIFIED', async () => {
    const spec = createHistoryAuditSpec();
    const result = await adapter.execute(
      spec,
      createUiContext({
        rawBrowser: {
          domTaskStatus: 'SUCCESS',
          networkHttpStatus: 500,
          screenshotPath: 'tests/fixtures/screenshots/task-9527.png',
        },
      }),
    );

    const netEnv = result.evidence.find((e) => e.evidenceKey === 'BROWSER:NETWORK_RESPONSE');
    expect(netEnv?.collectionStatus).toBe('COLLECTION_FAILED');
    expect(netEnv?.error?.code).toBe('NETWORK_HTTP_ERROR');

    const verdictResult = evaluateCanonicalVerdict(spec, result.evidence);
    expect(verdictResult.verdict).toBe('UNVERIFIED');
    expect(verdictResult.requiredEvidenceEvaluation.missingEvidenceKeys).toContain('BROWSER:NETWORK_RESPONSE');
  });

  // --------------------------------------------------------------------------
  // 15. 写操作防护：输入中包含写操作指令时，适配器严格 fail-closed 返回 BLOCKED
  // --------------------------------------------------------------------------
  it('15. 写操作防护：输入中包含写操作指令 (SUBMIT/DELETE/UPDATE 等) 时，适配器严格 fail-closed 返回 BLOCKED', async () => {
    const writeSpec = createHistoryAuditSpec({
      inputs: {
        action: 'SUBMIT_TASK_MUTATION',
        pageUrl: '/console/tasks/history',
      },
    });
    const writeResult = await adapter.execute(writeSpec, createUiContext());
    expect(writeResult.status).toBe('BLOCKED');
    expect(writeResult.error?.code).toBe('SIDE_EFFECT_POLICY_VIOLATION');
  });

  // --------------------------------------------------------------------------
  // 16. 写操作防护：sideEffectPolicy 非 READ_ONLY 时，适配器严格 fail-closed 返回 BLOCKED
  // --------------------------------------------------------------------------
  it('16. 写操作防护：sideEffectPolicy 非 READ_ONLY 时，适配器严格 fail-closed 返回 BLOCKED', async () => {
    const allowSubmitSpec = createHistoryAuditSpec({
      sideEffectPolicy: 'ALLOW_SUBMIT',
    });
    const allowSubmitResult = await adapter.execute(allowSubmitSpec, createUiContext());
    expect(allowSubmitResult.status).toBe('BLOCKED');
    expect(allowSubmitResult.error?.code).toBe('SIDE_EFFECT_POLICY_VIOLATION');
  });

  // --------------------------------------------------------------------------
  // 17. 成本预算防护：maxCostPoints > 0 或 maxCostCny > 0 时，适配器严格 fail-closed 返回 BLOCKED
  // --------------------------------------------------------------------------
  it('17. 成本预算防护：maxCostPoints > 0 或 maxCostCny > 0 时，适配器严格 fail-closed 返回 BLOCKED', async () => {
    const costPointsSpec = createHistoryAuditSpec({
      costLimit: { maxCostPoints: 50 },
    });
    const pointsResult = await adapter.execute(costPointsSpec, createUiContext());
    expect(pointsResult.status).toBe('BLOCKED');
    expect(pointsResult.error?.code).toBe('INVALID_TEST_SPEC');

    const costCnySpec = createHistoryAuditSpec({
      costLimit: { maxCostPoints: 0, maxCostCny: 10, allowZeroCostOnly: true },
    });
    const cnyResult = await adapter.execute(costCnySpec, createUiContext());
    expect(cnyResult.status).toBe('BLOCKED');
    expect(cnyResult.error?.code).toBe('BUDGET_LIMIT_EXCEEDED');

    const validZeroSpec = createHistoryAuditSpec();
    const paidCtxResult = await adapter.execute(validZeroSpec, createUiContext({ paidRequired: true }));
    expect(paidCtxResult.status).toBe('BLOCKED');
    expect(paidCtxResult.error?.code).toBe('BUDGET_LIMIT_EXCEEDED');
  });

  // --------------------------------------------------------------------------
  // 18. 非法 TestSpec 防护：缺少必填字段时，适配器 fail-closed 返回 BLOCKED (INVALID_TEST_SPEC)
  // --------------------------------------------------------------------------
  it('18. 非法 TestSpec 防护：缺少必填字段时，适配器 fail-closed 返回 BLOCKED (INVALID_TEST_SPEC)', async () => {
    const invalidSpec = {
      scenario: 'UI_HISTORY_TASK_STATUS_AUDIT',
      executionMode: 'FIXTURE',
    } as unknown as CanonicalTestSpec;

    const result = await adapter.execute(invalidSpec, createUiContext());
    expect(result.status).toBe('BLOCKED');
    expect(result.error?.code).toBe('INVALID_TEST_SPEC');
    expect(result.evidence).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // 19. 异步 Producer 原生支持：通过 ExecutionAdapter 注入并执行 MockAsyncProducer
  // --------------------------------------------------------------------------
  it('19. 异步 Producer 原生支持：通过 ExecutionAdapter 注入并执行 MockAsyncProducer，验证异步 Promise 承载', async () => {
    class MockInjectedAsyncProducer implements EvidenceProducer {
      readonly producerName = 'mock-injected-async-producer';
      readonly sourceType = 'BROWSER' as const;

      async produce(rawCollection: unknown, context: EvidenceProducerContext): Promise<CanonicalEvidenceEnvelope[]> {
        const ctx = context as DeterministicProducerContext;
        return [
          {
            evidenceId: ctx.evidenceIds?.['BROWSER:INJECTED_ASYNC_FACT'] || 'ev-injected-001',
            testId: context.testId,
            sourceTool: this.producerName,
            sourceType: this.sourceType,
            evidenceKey: 'BROWSER:INJECTED_ASYNC_FACT',
            observationStatus: 'PASS',
            capturedAt: ctx.capturedAt,
            environment: context.environment,
            subjectType: context.subjectType,
            subjectId: context.subjectId,
            normalizedFields: { injectedAsyncExecuted: true },
            provenance: 'BROWSER (mock-injected-async-producer:offline)',
            confidence: 1.0,
            immutable: true,
            redacted: true,
            collectionStatus: 'SUCCESS',
          },
        ];
      }
    }

    const mockAsync = new MockInjectedAsyncProducer();
    const adapterWithInjection = new UIFixtureExecutionAdapter({
      extraProducers: [mockAsync],
    });

    const spec = createHistoryAuditSpec();
    const execResult = await adapterWithInjection.execute(
      spec,
      createUiContext({
        rawBrowser: {
          rowFound: true,
          domTaskStatus: 'SUCCESS',
          networkTaskStatus: 'SUCCESS',
          screenshotPath: 'tests/fixtures/screenshots/task-9527.png',
        },
        rawVisualAi: {
          visualInference: 'CONFIRMED',
        },
      }),
    );

    expect(execResult.status).toBe('COMPLETED');
    const injectedEnv = execResult.evidence.find((e) => e.evidenceKey === 'BROWSER:INJECTED_ASYNC_FACT');
    expect(injectedEnv).toBeDefined();
    expect(injectedEnv?.normalizedFields.injectedAsyncExecuted).toBe(true);
    expect(injectedEnv?.sourceTool).toBe('mock-injected-async-producer');
  });

  // --------------------------------------------------------------------------
  // 20. 媒体与账单按需证据规则：非必须场景不强制要求 MEDIA_BINARY 与 BILLING_LEDGER
  // --------------------------------------------------------------------------
  it('20. 媒体与账单按需证据规则：只读核对场景不要求 MEDIA_BINARY 与 BILLING_LEDGER 时，无需媒体与账单即可 PASS', async () => {
    const spec = createHistoryAuditSpec();
    const uiResult = await adapter.execute(
      spec,
      createUiContext({
        rawBrowser: {
          rowFound: true,
          domTaskStatus: 'SUCCESS',
          networkTaskStatus: 'SUCCESS',
          screenshotPath: 'tests/fixtures/screenshots/task-9527.png',
        },
        rawVisualAi: {
          visualInference: 'CONFIRMED',
        },
      }),
    );

    const verdictResult = evaluateCanonicalVerdict(spec, uiResult.evidence);
    expect(verdictResult.verdict).toBe('PASS');

    expect(verdictResult.evidenceIdsUsed.length).toBeGreaterThan(0);
    const usedEnvs = uiResult.evidence.filter((e) => verdictResult.evidenceIdsUsed.includes(e.evidenceId));
    expect(usedEnvs.every((e) => e.sourceType !== 'MEDIA_BINARY' && e.sourceType !== 'BILLING_LEDGER')).toBe(true);
  });

  // --------------------------------------------------------------------------
  // 21. ExecutionAdapter 边界测试：严禁第二套裁决，执行严格保持 TestSpec 不可变
  // --------------------------------------------------------------------------
  it('21. ExecutionAdapter 边界：输出严禁包含 FORBIDDEN_VERDICT_FIELDS，执行保持 TestSpec 对象不可变性', async () => {
    const spec = createHistoryAuditSpec();
    Object.freeze(spec);
    Object.freeze(spec.target);
    Object.freeze(spec.inputs);
    Object.freeze(spec.costLimit);

    const snapshot = JSON.stringify(spec);
    const execResult = await adapter.execute(
      spec,
      createUiContext({
        rawBrowser: {
          rowFound: true,
          domTaskStatus: 'SUCCESS',
          networkTaskStatus: 'SUCCESS',
          screenshotPath: 'tests/fixtures/screenshots/task-9527.png',
        },
        rawVisualAi: {
          visualInference: 'CONFIRMED',
        },
      }),
    );

    for (const field of FORBIDDEN_VERDICT_FIELDS) {
      expect(field in execResult).toBe(false);
      expect((execResult as unknown as Record<string, unknown>)[field]).toBeUndefined();
    }

    const validExecutionStatuses = ['SUBMITTED', 'COMPLETED', 'FAILED', 'BLOCKED'];
    expect(validExecutionStatuses).toContain(execResult.status);
    expect(JSON.stringify(spec)).toBe(snapshot);
  });

  // --------------------------------------------------------------------------
  // 22. 确定性纪律测试：调用方缺失 capturedAt 时 fail-closed 阻断
  // --------------------------------------------------------------------------
  it('22. 确定性纪律测试：调用方未显式提供 capturedAt 时，适配器严格 fail-closed 阻断为 BLOCKED', async () => {
    const specWithoutMetadataCapturedAt = createHistoryAuditSpec({
      metadata: {},
    });

    const result = await adapter.execute(specWithoutMetadataCapturedAt, {
      rawBrowser: { rowFound: true },
    });

    expect(result.status).toBe('BLOCKED');
    expect(result.error?.code).toBe('CAPTURED_AT_REQUIRED');
  });

  // --------------------------------------------------------------------------
  // 23. 确定性纪律测试：调用方缺失 evidenceId 时，Producer 返回 COLLECTION_FAILED
  // --------------------------------------------------------------------------
  it('23. 确定性纪律测试：调用方未显式提供 evidenceId 时，Producer 拒绝伪造并返回 EVIDENCE_ID_REQUIRED', async () => {
    const producer = new UIBrowserEvidenceProducer();
    const envelopes = await producer.produce({ domTaskStatus: 'SUCCESS' }, {
      testId: 'test-no-ev-id',
      environment: 'offline',
      subjectType: 'task',
      subjectId: 100,
      capturedAt: DETERMINISTIC_CAPTURED_AT,
      // 故意不传 evidenceId 或 evidenceIds
    } as DeterministicProducerContext);

    const domEnv = envelopes.find((e) => e.evidenceKey === 'BROWSER:TASK_STATUS_DOM');
    expect(domEnv?.collectionStatus).toBe('COLLECTION_FAILED');
    expect(domEnv?.error?.code).toBe('EVIDENCE_ID_REQUIRED');
  });
});
