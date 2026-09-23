/**
 * Panqu AI DevTest — Canonical Regression Test Suite
 * Phase 1.5B 表驱动 Canonical 回归测试 (对齐冻结的 Golden Expectations)
 *
 * 核心架构边界 (遵守 docs/ARCHITECTURE_FREEZE.md 受控扩展原则):
 * 1. 本对比套件仅存在于测试目录，严禁在 core-kernel、CLI、MCP 或任何生产调用链中执行；
 * 2. 严禁重新引入旧版 verify 源码，历史基准值明确为冻结的 golden expectations；
 * 3. 运行全程严禁网络请求：通过 vi.stubGlobal('fetch', ...) 阻断，一旦发生网络调用立即失败；
 * 4. 严格归一化比较状态为 PASS / FAIL / UNVERIFIED；
 * 5. 严格验证六类差异分类与迁移安全门槛：
 *    - EXPECTED_STRICTER 必须具备白名单原因码且显式标记 expectedStricter=true，未标记的强制归入 NEEDS_REVIEW；
 *    - REGRESSION_RISK 必须严格为 0 (严禁新引擎比历史黄金预期更宽松冒进)；
 *    - MAPPING_GAP 必须严格为 0 (任一 MAPPING_FAILED 均阻断门禁)；
 *    - evidenceIds 必须全部来自 mapper 实际生成的 Envelope，严禁预填；
 *    - P0 假 PASS 场景通过 tags: ['P0_FALSE_PASS'] 识别，不依赖固定编号。
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { CanonicalTestSpec } from '../../../src/devtest/canonical-protocol.js';
import * as coreKernel from '../../../src/devtest/core-kernel.js';
import { createSyntheticValidMp4 } from '../../../src/devtest/media-inspector.js';
import {
  classifyShadowDifference,
  runSingleShadowComparison,
  buildShadowSummary,
  ALLOWED_EXPECTED_STRICTER_REASONS,
  type ShadowTestCase,
  type ShadowComparisonRecord,
} from './helpers/canonical-shadow-helper.js';

describe('Phase 1.5B 表驱动 Canonical 回归测试 (对齐冻结的 Golden Expectations)', () => {
  const FIXED_TIME = '2026-09-21T12:00:00.000Z';

  // 阻断全局 fetch，确保离线运行严格零网络请求
  beforeEach(() => {
    vi.stubGlobal('fetch', () => {
      throw new Error('NETWORK_ACCESS_FORBIDDEN: fetch must never be called during offline shadow comparison!');
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // 离线媒体二进制 Fixture
  const validMp4 = createSyntheticValidMp4({ width: 1280, height: 720, durationSeconds: 4 });
  const corruptBuffer = Buffer.from('NOT_A_VALID_MP4_CORRUPTED_HEADER_DATA');

  // 基础 Canonical TestSpec 模板
  const createBaseSpec = (
    testId: string,
    expectedPoints = 70,
    expectedChannelId = 2,
    overrides?: Partial<CanonicalTestSpec>,
  ): CanonicalTestSpec => {
    const isReal = overrides?.executionMode === 'REAL';
    const taskKey = isReal ? 'SERVER_API:TASK_STATUS' : 'FIXTURE:TASK_STATUS';
    const routingKey = isReal ? 'SERVER_API:ROUTING_CHANNEL' : 'FIXTURE:ROUTING_CHANNEL';

    return {
      testId,
      requirementId: 'REQ-SHADOW-01',
      scenario: 'VIDEO_GENERATION_ACCEPTANCE',
      environment: 'test',
      executionMode: isReal ? 'REAL' : 'FIXTURE',
      target: {
        targetType: 'model',
        modelId: 84,
        expectedChannelId,
      },
      inputs: { prompt: 'A robotic horse running' },
      deterministicAssertions: [
        {
          field: 'billing.actualCharge',
          operator: 'EQUALS',
          expectedValue: expectedPoints,
          critical: true,
          evidenceKey: 'BILLING_LEDGER:TASK_RECORDS',
          actualField: 'actualCharge',
        },
        {
          field: 'routing.expectedChannelId',
          operator: 'EQUALS',
          expectedValue: expectedChannelId,
          critical: true,
          evidenceKey: routingKey,
          actualField: 'actualValue',
        },
      ],
      costLimit: { maxCostPoints: expectedPoints },
      sideEffectPolicy: 'ALLOW_PAID',
      requiredEvidence: [taskKey, 'MEDIA_BINARY:CONTAINER_CHECK', 'BILLING_LEDGER:TASK_RECORDS', routingKey],
      ...overrides,
    };
  };

  // ==========================================================================
  // 定义 20 个表驱动 Canonical 回归测试场景 (对照冻结的 Golden Expectations)
  // ==========================================================================
  const shadowTestCases: ShadowTestCase[] = [
    // 场景 1: 任务、媒体、账单全部通过
    {
      index: 1,
      name: '任务、媒体、账单全部通过',
      testId: 'shadow-sc-01',
      capturedAt: FIXED_TIME,
      goldenExpectation: 'PASS',
      verifyOptions: {
        taskId: 1001,
        modelId: 84,
        mediaType: 'video',
        duration: 4,
        resolution: '720p',
        expectedPoints: 70,
        terminalStatus: 'SUCCESS',
        artifactBuffer: validMp4,
        scoreLogs: [{ task_id: 1001, type: 2, score: -70, memo: '预扣' }],
        channelId: 2,
        retryLog: { newapi_channel_id: 2 },
        dbExtraConfirmed: true,
        dbExtra: { diversion: 10 },
        extra: { diversion: 10 },
      },
      spec: createBaseSpec('shadow-sc-01', 70, 2),
      reasonCode: 'FULL_PASS_MATCH',
      notes: '基准正向场景，实际执行判定 PASS，与冻结黄金预期一致',
    },

    // 场景 2: 任务终态失败
    {
      index: 2,
      name: '任务终态失败',
      testId: 'shadow-sc-02',
      capturedAt: FIXED_TIME,
      goldenExpectation: 'FAIL',
      verifyOptions: {
        taskId: 1002,
        modelId: 84,
        mediaType: 'video',
        duration: 4,
        resolution: '720p',
        expectedPoints: 70,
        terminalStatus: 'FAILED',
        scoreLogs: [
          { task_id: 1002, type: 2, score: -70, memo: '预扣' },
          { task_id: 1002, type: 2, score: 70, memo: '退款' },
        ],
        channelId: 2,
        retryLog: { newapi_channel_id: 2 },
        dbExtraConfirmed: true,
      },
      spec: createBaseSpec('shadow-sc-02', 70, 2),
      reasonCode: 'TASK_TERMINAL_FAILED',
      notes: '任务终态为 FAILED，实际执行判定 FAIL，与冻结黄金预期一致',
    },

    // 场景 3: 任务仍为 SUBMITTED/PROCESSING
    {
      index: 3,
      name: '任务仍为 SUBMITTED/PROCESSING',
      testId: 'shadow-sc-03',
      capturedAt: FIXED_TIME,
      goldenExpectation: 'UNVERIFIED',
      verifyOptions: {
        taskId: 1003,
        modelId: 84,
        mediaType: 'video',
        duration: 4,
        resolution: '720p',
        expectedPoints: 70,
        terminalStatus: 'PROCESSING',
        channelId: 2,
        retryLog: { newapi_channel_id: 2 },
        dbExtraConfirmed: true,
      },
      spec: createBaseSpec('shadow-sc-03', 70, 2),
      reasonCode: 'TASK_STILL_PROCESSING',
      notes: '任务异步处理中，实际执行判定 PROCESSING，归一化与冻结黄金预期 UNVERIFIED 一致',
    },

    // 场景 4: 媒体二进制失败
    {
      index: 4,
      name: '媒体二进制失败',
      testId: 'shadow-sc-04',
      capturedAt: FIXED_TIME,
      goldenExpectation: 'FAIL',
      verifyOptions: {
        taskId: 1004,
        modelId: 84,
        mediaType: 'video',
        duration: 4,
        resolution: '720p',
        expectedPoints: 70,
        terminalStatus: 'SUCCESS',
        artifactBuffer: corruptBuffer,
        scoreLogs: [{ task_id: 1004, type: 2, score: -70, memo: '预扣' }],
        channelId: 2,
        retryLog: { newapi_channel_id: 2 },
        dbExtraConfirmed: true,
      },
      spec: createBaseSpec('shadow-sc-04', 70, 2),
      reasonCode: 'MEDIA_BINARY_CORRUPTED',
      notes: '产物二进制不可解码，实际执行拦截为 FAIL，与冻结黄金预期一致',
    },

    // 场景 5: 媒体证据缺失
    {
      index: 5,
      name: '媒体证据缺失',
      testId: 'shadow-sc-05',
      capturedAt: FIXED_TIME,
      goldenExpectation: 'UNVERIFIED',
      verifyOptions: {
        taskId: 1005,
        modelId: 84,
        mediaType: 'video',
        duration: 4,
        resolution: '720p',
        expectedPoints: 70,
        terminalStatus: 'SUCCESS',
        scoreLogs: [{ task_id: 1005, type: 2, score: -70, memo: '预扣' }],
        channelId: 2,
        retryLog: { newapi_channel_id: 2 },
        dbExtraConfirmed: true,
      },
      spec: createBaseSpec('shadow-sc-05', 70, 2),
      reasonCode: 'MEDIA_EVIDENCE_MISSING',
      notes: '缺少产物 Buffer，实际执行判定 UNVERIFIED，与冻结黄金预期一致',
    },

    // 场景 6: 账单核验失败
    {
      index: 6,
      name: '账单核验失败',
      testId: 'shadow-sc-06',
      capturedAt: FIXED_TIME,
      goldenExpectation: 'FAIL',
      verifyOptions: {
        taskId: 1006,
        modelId: 84,
        mediaType: 'video',
        duration: 4,
        resolution: '720p',
        expectedPoints: 70,
        terminalStatus: 'SUCCESS',
        artifactBuffer: validMp4,
        scoreLogs: [{ task_id: 1006, type: 2, score: -140, memo: '超额扣费' }],
        channelId: 2,
        retryLog: { newapi_channel_id: 2 },
        dbExtraConfirmed: true,
      },
      spec: createBaseSpec('shadow-sc-06', 70, 2),
      reasonCode: 'BILLING_AUDIT_MISMATCH',
      notes: '扣费 140 与预期 70 不符，实际执行判定 FAIL，与冻结黄金预期一致',
    },

    // 场景 7: 账单证据缺失
    {
      index: 7,
      name: '账单证据缺失',
      testId: 'shadow-sc-07',
      capturedAt: FIXED_TIME,
      goldenExpectation: 'UNVERIFIED',
      verifyOptions: {
        taskId: 1007,
        modelId: 84,
        mediaType: 'video',
        duration: 4,
        resolution: '720p',
        expectedPoints: 70,
        terminalStatus: 'SUCCESS',
        artifactBuffer: validMp4,
        channelId: 2,
        retryLog: { newapi_channel_id: 2 },
        dbExtraConfirmed: true,
      },
      spec: createBaseSpec('shadow-sc-07', 70, 2),
      reasonCode: 'BILLING_LEDGER_MISSING',
      notes: '缺少账单流水，实际执行判定 UNVERIFIED，与冻结黄金预期一致',
    },

    // 场景 8: actualChannel 仅来自用户声明 (P0 假 PASS 收紧场景)
    {
      index: 8,
      name: 'actualChannel 仅来自用户声明',
      testId: 'shadow-sc-08',
      capturedAt: FIXED_TIME,
      goldenExpectation: 'PASS',
      tags: ['P0_FALSE_PASS'],
      expectedStricter: true,
      reasonCode: 'USER_ASSERTION_ONLY_TIGHTENED',
      verifyOptions: {
        taskId: 1008,
        modelId: 84,
        mediaType: 'video',
        duration: 4,
        resolution: '720p',
        expectedPoints: 70,
        terminalStatus: 'SUCCESS',
        artifactBuffer: validMp4,
        scoreLogs: [{ task_id: 1008, type: 2, score: -70, memo: '预扣' }],
        channelId: 2,
        actualChannelId: 2, // 仅由入参手填断言，无 retryLog 证实
        gatewayChannelConfirmed: true,
        dbExtraConfirmed: true,
      },
      spec: createBaseSpec('shadow-sc-08', 70, 2, {
        executionMode: 'REAL',
        requiredEvidence: [
          'SERVER_API:TASK_STATUS',
          'MEDIA_BINARY:CONTAINER_CHECK',
          'BILLING_LEDGER:TASK_RECORDS',
          'SERVER_API:ROUTING_CHANNEL',
        ],
      }),
      notes:
        '历史基准对离线手填渠道放行 PASS；新引擎强制隔离声明为 USER_ASSERTION，收紧为 UNVERIFIED (EXPECTED_STRICTER)',
    },

    // 场景 9: 服务端实际渠道与目标渠道不一致
    {
      index: 9,
      name: '服务端实际渠道与目标渠道不一致',
      testId: 'shadow-sc-09',
      capturedAt: FIXED_TIME,
      goldenExpectation: 'FAIL',
      verifyOptions: {
        taskId: 1009,
        modelId: 84,
        mediaType: 'video',
        duration: 4,
        resolution: '720p',
        expectedPoints: 70,
        terminalStatus: 'SUCCESS',
        artifactBuffer: validMp4,
        scoreLogs: [{ task_id: 1009, type: 2, score: -70, memo: '预扣' }],
        channelId: 2,
        retryLog: { newapi_channel_id: 54 }, // 实际为 54，与目标 2 不符
        dbExtraConfirmed: true,
      },
      spec: createBaseSpec('shadow-sc-09', 70, 2),
      reasonCode: 'CHANNEL_MISMATCH',
      notes: '服务端实际渠道 54 与目标 2 不一致，实际执行判定 FAIL，与冻结黄金预期一致',
    },

    // 场景 10: 发生 fallback
    {
      index: 10,
      name: '发生 fallback',
      testId: 'shadow-sc-10',
      capturedAt: FIXED_TIME,
      goldenExpectation: 'FAIL',
      verifyOptions: {
        taskId: 1010,
        modelId: 84,
        mediaType: 'video',
        duration: 4,
        resolution: '720p',
        expectedPoints: 70,
        terminalStatus: 'SUCCESS',
        artifactBuffer: validMp4,
        scoreLogs: [{ task_id: 1010, type: 2, score: -70, memo: '预扣' }],
        channelId: 2,
        retryLog: { newapi_channel_id: 2, fallback_channel: 'aliyun-wan-fallback' },
        dbExtraConfirmed: true,
      },
      spec: createBaseSpec('shadow-sc-10', 70, 2),
      reasonCode: 'FALLBACK_EXECUTION_REJECTED',
      notes: '目标通道未完成而由兜底生成，实际执行拒收判定 FAIL，与冻结黄金预期一致',
    },

    // 场景 11: 用户声明与服务端渠道冲突
    {
      index: 11,
      name: '用户声明与服务端渠道冲突',
      testId: 'shadow-sc-11',
      capturedAt: FIXED_TIME,
      goldenExpectation: 'FAIL',
      verifyOptions: {
        taskId: 1011,
        modelId: 84,
        mediaType: 'video',
        duration: 4,
        resolution: '720p',
        expectedPoints: 70,
        terminalStatus: 'SUCCESS',
        artifactBuffer: validMp4,
        scoreLogs: [{ task_id: 1011, type: 2, score: -70, memo: '预扣' }],
        channelId: 2,
        actualChannelId: 2, // 用户声称 2
        retryLog: { newapi_channel_id: 54 }, // 服务端事实为 54
        dbExtraConfirmed: true,
      },
      spec: createBaseSpec('shadow-sc-11', 70, 2),
      reasonCode: 'EVIDENCE_CONFLICT_CHANNEL',
      notes: '服务端渠道事实 54 强制优先且不满足预期 2，同时报冲突，实际执行判定 FAIL，与冻结黄金预期一致',
    },

    // 场景 12: 只有静态网关配置 (P0 假 PASS 收紧场景)
    {
      index: 12,
      name: '只有静态网关配置',
      testId: 'shadow-sc-12',
      capturedAt: FIXED_TIME,
      goldenExpectation: 'PASS',
      tags: ['P0_FALSE_PASS'],
      expectedStricter: true,
      reasonCode: 'STATIC_CONTRACT_UNVERIFIED_FOR_REAL',
      verifyOptions: {
        taskId: 1012,
        modelId: 84,
        mediaType: 'video',
        duration: 4,
        resolution: '720p',
        expectedPoints: 70,
        terminalStatus: 'SUCCESS',
        artifactBuffer: validMp4,
        scoreLogs: [{ task_id: 1012, type: 2, score: -70, memo: '预扣' }],
        gatewayChannelConfirmed: true, // 历史基准仅凭静态契约放行
        dbExtraConfirmed: true,
      },
      spec: createBaseSpec('shadow-sc-12', 70, 2, {
        executionMode: 'REAL',
        requiredEvidence: [
          'SERVER_API:TASK_STATUS',
          'MEDIA_BINARY:CONTAINER_CHECK',
          'BILLING_LEDGER:TASK_RECORDS',
          'SERVER_API:ROUTING_CHANNEL',
        ],
      }),
      notes:
        '历史基准仅凭代码静态配置查表放行 PASS；新引擎在 REAL Spec 下缺少 SERVER_API 渠道证据，收紧为 UNVERIFIED (EXPECTED_STRICTER)',
    },

    // 场景 13: 可信网关快照存在
    {
      index: 13,
      name: '可信网关快照存在',
      testId: 'shadow-sc-13',
      capturedAt: FIXED_TIME,
      goldenExpectation: 'PASS',
      verifyOptions: {
        taskId: 1013,
        modelId: 84,
        mediaType: 'video',
        duration: 4,
        resolution: '720p',
        expectedPoints: 70,
        terminalStatus: 'SUCCESS',
        artifactBuffer: validMp4,
        scoreLogs: [{ task_id: 1013, type: 2, score: -70, memo: '预扣' }],
        channelId: 2,
        retryLog: { newapi_channel_id: 2 },
        gatewaySnapshot: {
          snapshotId: 'gw-snap-01',
          endpoint: '/api/channel/list',
          sourceEndpoint: '/api/channel/list',
          capturedAt: FIXED_TIME,
          environment: 'test',
          status: 'SUCCESS',
          provenance: 'API_READONLY_COLLECTOR',
          channels: [{ id: 2, name: 'kling-v2', models: ['84'], status: 1 }],
        } as any,
        dbExtraConfirmed: true,
      },
      spec: createBaseSpec('shadow-sc-13', 70, 2),
      reasonCode: 'TRUSTED_GATEWAY_SNAPSHOT_PASS',
      notes: '具备可信只读采集快照与服务端事实，实际执行判定 PASS，与冻结黄金预期一致',
    },

    // 场景 14: requiredEvidence 缺失
    {
      index: 14,
      name: 'requiredEvidence 缺失',
      testId: 'shadow-sc-14',
      capturedAt: FIXED_TIME,
      goldenExpectation: 'UNVERIFIED',
      verifyOptions: {
        taskId: 1014,
        modelId: 84,
        mediaType: 'video',
        duration: 4,
        resolution: '720p',
        expectedPoints: 70,
        terminalStatus: 'SUCCESS',
        artifactBuffer: validMp4,
        scoreLogs: [{ task_id: 1014, type: 2, score: -70, memo: '预扣' }],
        channelId: 2,
        dbExtraConfirmed: true,
      },
      spec: createBaseSpec('shadow-sc-14', 70, 2),
      reasonCode: 'REQUIRED_EVIDENCE_MISSING',
      notes: '缺少路由执行事实，实际执行判定 UNVERIFIED，与冻结黄金预期一致',
    },

    // 场景 15: FIXTURE 试图满足 REAL 证据 (P0 假 PASS 收紧场景)
    {
      index: 15,
      name: 'FIXTURE 试图满足 REAL 证据',
      testId: 'shadow-sc-15',
      capturedAt: FIXED_TIME,
      goldenExpectation: 'PASS',
      tags: ['P0_FALSE_PASS'],
      expectedStricter: true,
      reasonCode: 'REJECT_FIXTURE_FOR_REAL_SPEC',
      verifyOptions: {
        taskId: 1015,
        modelId: 84,
        mediaType: 'video',
        duration: 4,
        resolution: '720p',
        expectedPoints: 70,
        terminalStatus: 'SUCCESS',
        artifactBuffer: validMp4,
        scoreLogs: [{ task_id: 1015, type: 2, score: -70, memo: '预扣' }],
        channelId: 2,
        retryLog: { newapi_channel_id: 2 },
        dbExtraConfirmed: true,
        isSimulated: true, // 明确标记为离线仿真/FIXTURE 模式
      },
      spec: createBaseSpec('shadow-sc-15', 70, 2, {
        executionMode: 'REAL',
        requiredEvidence: [
          'SERVER_API:TASK_STATUS',
          'MEDIA_BINARY:CONTAINER_CHECK',
          'BILLING_LEDGER:TASK_RECORDS',
          'SERVER_API:ROUTING_CHANNEL',
        ],
      }),
      notes:
        '历史基准在 fixture 模式放行 PASS；新引擎在 REAL Spec 下拒绝 FIXTURE 冒充，收紧为 UNVERIFIED (EXPECTED_STRICTER)',
    },

    // 场景 16: getEditData/extra 证据缺失
    {
      index: 16,
      name: 'getEditData/extra 证据缺失',
      testId: 'shadow-sc-16',
      capturedAt: FIXED_TIME,
      goldenExpectation: 'UNVERIFIED',
      verifyOptions: {
        taskId: 1016,
        modelId: 84,
        mediaType: 'video',
        duration: 4,
        resolution: '720p',
        expectedPoints: 70,
        terminalStatus: 'SUCCESS',
        artifactBuffer: validMp4,
        scoreLogs: [{ task_id: 1016, type: 2, score: -70, memo: '预扣' }],
        channelId: 2,
        retryLog: { newapi_channel_id: 2 },
        changeType: 'diversion_change',
        spec: createBaseSpec('shadow-sc-16', 70, 2, {
          requiredEvidence: [
            'FIXTURE:TASK_STATUS',
            'MEDIA_BINARY:CONTAINER_CHECK',
            'BILLING_LEDGER:TASK_RECORDS',
            'FIXTURE:ROUTING_CHANNEL',
            'FIXTURE:EXTRA_DIVERSION',
          ],
        }),
        // dbExtraConfirmed is false / omitted
      },
      spec: createBaseSpec('shadow-sc-16', 70, 2, {
        requiredEvidence: [
          'FIXTURE:TASK_STATUS',
          'MEDIA_BINARY:CONTAINER_CHECK',
          'BILLING_LEDGER:TASK_RECORDS',
          'FIXTURE:ROUTING_CHANNEL',
          'FIXTURE:EXTRA_DIVERSION',
        ],
      }),
      reasonCode: 'EXTRA_DIVERSION_EVIDENCE_MISSING',
      notes: '分流 extra 落库证据缺失，实际执行判定 UNVERIFIED，与冻结黄金预期一致',
    },

    // 场景 17: 定价 UNVERIFIED
    {
      index: 17,
      name: '定价 UNVERIFIED',
      testId: 'shadow-sc-17',
      capturedAt: FIXED_TIME,
      goldenExpectation: 'UNVERIFIED',
      verifyOptions: {
        taskId: 1017,
        modelId: 9999, // 未知模型无真实刊例定价
        mediaType: 'video',
        duration: 4,
        resolution: '720p',
        terminalStatus: 'SUCCESS',
        artifactBuffer: validMp4,
      },
      spec: createBaseSpec('shadow-sc-17', 0, 2, {
        costLimit: { maxCostPoints: 0 },
      }),
      reasonCode: 'PRICING_UNVERIFIED_BLOCKS_PASS',
      notes: '未知模型缺少真实刊例定价，实际执行阻断为 UNVERIFIED，与冻结黄金预期一致',
    },

    // 场景 18: 关键断言失败
    {
      index: 18,
      name: '关键断言失败',
      testId: 'shadow-sc-18',
      capturedAt: FIXED_TIME,
      goldenExpectation: 'FAIL',
      verifyOptions: {
        taskId: 1018,
        modelId: 84,
        mediaType: 'video',
        duration: 4,
        resolution: '720p',
        expectedPoints: 70,
        terminalStatus: 'SUCCESS',
        artifactBuffer: validMp4,
        scoreLogs: [{ task_id: 1018, type: 2, score: -999, memo: '错误扣费' }],
        channelId: 2,
        retryLog: { newapi_channel_id: 2 },
        dbExtraConfirmed: true,
      },
      spec: createBaseSpec('shadow-sc-18', 70, 2),
      reasonCode: 'CRITICAL_ASSERTION_FAILED',
      notes: '关键断言扣费金额 70 比对失败（实际 999），实际执行判定 FAIL，与冻结黄金预期一致',
    },

    // 场景 19: 非关键断言失败
    {
      index: 19,
      name: '非关键断言失败',
      testId: 'shadow-sc-19',
      capturedAt: FIXED_TIME,
      goldenExpectation: 'PASS',
      verifyOptions: {
        taskId: 1019,
        modelId: 84,
        mediaType: 'video',
        duration: 4,
        resolution: '720p',
        expectedPoints: 70,
        terminalStatus: 'SUCCESS',
        artifactBuffer: validMp4, // 1280x720
        scoreLogs: [{ task_id: 1019, type: 2, score: -70, memo: '预扣' }],
        channelId: 2,
        retryLog: { newapi_channel_id: 2 },
        dbExtraConfirmed: true,
      },
      spec: createBaseSpec('shadow-sc-19', 70, 2, {
        deterministicAssertions: [
          {
            field: 'billing.actualCharge',
            operator: 'EQUALS',
            expectedValue: 70,
            critical: true,
            evidenceKey: 'BILLING_LEDGER:TASK_RECORDS',
            actualField: 'actualCharge',
          },
          {
            field: 'routing.expectedChannelId',
            operator: 'EQUALS',
            expectedValue: 2,
            critical: true,
            evidenceKey: 'FIXTURE:ROUTING_CHANNEL',
            actualField: 'actualValue',
          },
          {
            field: 'media.width',
            operator: 'EQUALS',
            expectedValue: 1920, // 实际为 1280，断言失败
            critical: false, // 非关键断言
            evidenceKey: 'MEDIA_BINARY:CONTAINER_CHECK',
            actualField: 'width',
          },
        ],
      }),
      reasonCode: 'NON_CRITICAL_ASSERTION_SOFT_FAIL',
      notes: '非关键断言未命中不阻断 PASS 判定，实际执行判定 PASS，与冻结黄金预期一致',
    },

    // 场景 20: 多条同 key 证据发生 PASS/FAIL 冲突
    {
      index: 20,
      name: '多条同 key 证据发生 PASS/FAIL 冲突',
      testId: 'shadow-sc-20',
      capturedAt: FIXED_TIME,
      goldenExpectation: 'FAIL',
      verifyOptions: {
        taskId: 1020,
        modelId: 84,
        mediaType: 'video',
        duration: 4,
        resolution: '720p',
        expectedPoints: 70,
        terminalStatus: 'FAILED',
        scoreLogs: [
          { task_id: 1020, type: 2, score: -70, memo: '预扣' },
          { task_id: 1020, type: 2, score: 70, memo: '退款' },
        ],
        channelId: 2,
        retryLog: { newapi_channel_id: 2 },
        dbExtraConfirmed: true,
      },
      spec: createBaseSpec('shadow-sc-20', 70, 2),
      extraEnvelopes: [
        {
          evidenceId: 'shadow-sc-20-task-pass-conflicting',
          testId: 'shadow-sc-20',
          sourceTool: 'core-kernel.verify',
          sourceType: 'SERVER_API',
          evidenceKey: 'SERVER_API:TASK_STATUS',
          observationStatus: 'PASS',
          capturedAt: FIXED_TIME,
          environment: 'test',
          subjectType: 'task',
          subjectId: 1020,
          normalizedFields: { observedStatus: 'PASS' },
          provenance: 'SERVER_API:conflicting',
          confidence: 1.0,
          immutable: true,
          redacted: true,
          collectionStatus: 'SUCCESS',
        },
      ],
      reasonCode: 'SAME_KEY_EVIDENCE_CONFLICT',
      notes: '同 key 存在 PASS 与 FAIL 冲突，fail-closed 判定 FAIL，与冻结黄金预期一致',
    },
  ];

  // ==========================================================================
  // 测试组 1: 证明 20 个场景真实执行了 Canonical verify() 与冻结黄金预期比对
  // ==========================================================================
  describe('一、执行 Canonical verify 与冻结黄金预期比对验证', () => {
    it('1. 证明表驱动用例实际调用了 Canonical 驱动的 verify()', async () => {
      const verifySpy = vi.spyOn(coreKernel, 'verify');
      const sc1 = shadowTestCases[0];

      const record = await runSingleShadowComparison(sc1);
      expect(verifySpy).toHaveBeenCalled();
      expect(verifySpy).toHaveBeenCalledWith(sc1.verifyOptions);

      // 验证获得了真实的 VerifyKernelResult，绝非手工构造
      expect(record.actualLegacyResult).toBeDefined();
      expect(record.actualLegacyResult?.status).toBe('SUCCESS');
      expect(record.actualLegacyResult?.verdict).toBe('PASS');
      expect(record.goldenExpectation).toBe('PASS');
    });

    it('2. 证明如果 verify() 实际结果变化，比对结果会随之联动变化', async () => {
      // 原本为 SUCCESS
      const baseTc = shadowTestCases[0];
      const record1 = await runSingleShadowComparison(baseTc);
      expect(record1.goldenExpectation).toBe('PASS');
      expect(record1.canonicalVerdict).toBe('PASS');

      // 改变输入入参使实际 verify() 变为 FAILED
      const modifiedTc: ShadowTestCase = {
        ...baseTc,
        testId: 'shadow-sc-01-tampered',
        spec: createBaseSpec('shadow-sc-01-tampered', 70, 2),
        verifyOptions: {
          ...baseTc.verifyOptions,
          terminalStatus: 'FAILED',
          scoreLogs: [
            { task_id: 1001, type: 2, score: -70, memo: '预扣' },
            { task_id: 1001, type: 2, score: 70, memo: '退款' },
          ],
        },
      };

      const record2 = await runSingleShadowComparison(modifiedTc);
      expect(record2.canonicalVerdict).toBe('FAIL');
      expect(record2.rawLegacyVerdict).toBe('FAIL');
    });

    it('2b. 证明：缺少 goldenExpectation 必须直接失败，严禁从 verify 结果推导', async () => {
      const tcWithoutGolden = {
        ...shadowTestCases[0],
        goldenExpectation: undefined as any,
      };
      await expect(runSingleShadowComparison(tcWithoutGolden)).rejects.toThrowError(/缺少必须的 goldenExpectation/);
    });

    for (const tc of shadowTestCases) {
      it(`场景 ${tc.index}: ${tc.name} -> 执行 Canonical 验证并比对冻结黄金预期`, async () => {
        const record = await runSingleShadowComparison(tc);

        // 真实执行证据检查
        expect(record.actualLegacyResult).toBeDefined();
        expect(record.testId).toBe(tc.testId);
        expect(record.mappingSuccess).toBe(true);

        // 证据 ID 必须来自实际生成的信封，严禁为空
        expect(record.evidenceIds.length).toBeGreaterThan(0);
        for (const eid of record.evidenceIds) {
          expect(eid).toContain(tc.testId);
        }

        // 差异分类断言
        if (tc.tags?.includes('P0_FALSE_PASS')) {
          expect(record.category).toBe('EXPECTED_STRICTER');
          expect(record.goldenExpectation).toBe('PASS');
          expect(record.canonicalVerdict).toBe('UNVERIFIED');
        } else {
          expect(record.category).toBe('MATCH');
          expect(record.canonicalVerdict).toBe(record.goldenExpectation);
        }

        expect(record.reasonCode.length).toBeGreaterThan(0);
      });
    }
  });

  // ==========================================================================
  // 测试组 2: 严格门禁逻辑与六大核心证明
  // ==========================================================================
  describe('二、严格门禁逻辑与收紧规则证明', () => {
    it('3. 证明：未标记 expectedStricter 的历史黄金 PASS / 新 UNVERIFIED 强制归入 NEEDS_REVIEW', () => {
      const unapprovedRecord = classifyShadowDifference({
        goldenExpectation: 'PASS',
        canonicalVerdict: 'UNVERIFIED',
        mappingSuccess: true,
        isExpectedStricterScenario: false, // 未标记
        reasonCode: 'USER_ASSERTION_ONLY_TIGHTENED',
      });
      expect(unapprovedRecord).toBe('NEEDS_REVIEW');

      // 即使标记了 expectedStricter=true，但 reasonCode 不在白名单中，也必须归入 NEEDS_REVIEW
      const illegalReasonRecord = classifyShadowDifference({
        goldenExpectation: 'PASS',
        canonicalVerdict: 'UNVERIFIED',
        mappingSuccess: true,
        isExpectedStricterScenario: true,
        reasonCode: 'ILLEGAL_UNAUTHORIZED_REASON',
      });
      expect(illegalReasonRecord).toBe('NEEDS_REVIEW');
    });

    it('4. 证明：显式批准且在白名单中的 P0 收紧归入 EXPECTED_STRICTER', () => {
      for (const allowedReason of ALLOWED_EXPECTED_STRICTER_REASONS) {
        const approved = classifyShadowDifference({
          goldenExpectation: 'PASS',
          canonicalVerdict: 'UNVERIFIED',
          mappingSuccess: true,
          isExpectedStricterScenario: true,
          reasonCode: allowedReason,
        });
        expect(approved).toBe('EXPECTED_STRICTER');
      }
    });

    it('5. 证明：任一 MAPPING_FAILED 必须导致安全门禁失败 (mappingGapCount !== 0)', () => {
      const records: ShadowComparisonRecord[] = [
        {
          scenarioIndex: 1,
          scenarioName: '正常场景',
          testId: 't-1',
          tags: [],
          goldenExpectation: 'PASS',
          rawLegacyVerdict: 'PASS',
          canonicalVerdict: 'PASS',
          category: 'MATCH',
          mappingSuccess: true,
          mappingIssues: [],
          reasonCode: 'MATCH',
          evidenceIds: ['ev-1'],
          notes: '',
        },
        {
          scenarioIndex: 2,
          scenarioName: '映射失败场景',
          testId: 't-2',
          tags: [],
          goldenExpectation: 'FAIL',
          rawLegacyVerdict: 'FAIL',
          canonicalVerdict: 'MAPPING_FAILED',
          category: 'MAPPING_GAP', // 映射失败
          mappingSuccess: false,
          mappingIssues: ['[ERROR] REQUIRED_FIELD_MISSING'],
          reasonCode: 'MAPPING_FAILED',
          evidenceIds: [],
          notes: '',
        },
      ];

      const summary = buildShadowSummary(records);
      expect(summary.mappingGapCount).toBe(1);
      expect(summary.gateCheckDetails.mappingGapZero).toBe(false);
      expect(summary.isSafetyGatePassed).toBe(false); // 必须阻断安全门禁
    });

    it('6. 证明：预填的证据 ID 无法让门禁通过，必须由 mapper 实际生成', async () => {
      // 构造一个没有实际信封生成的非 MATCH 记录
      const invalidNonMatchRecord: ShadowComparisonRecord = {
        scenarioIndex: 8,
        scenarioName: '无实际信封场景',
        testId: 't-empty-env',
        tags: ['P0_FALSE_PASS'],
        goldenExpectation: 'PASS',
        rawLegacyVerdict: 'PASS',
        canonicalVerdict: 'UNVERIFIED',
        category: 'EXPECTED_STRICTER',
        mappingSuccess: true,
        mappingIssues: [],
        reasonCode: 'USER_ASSERTION_ONLY_TIGHTENED',
        evidenceIds: [], // 真实 envelope 为空
        notes: '',
      };

      const summary = buildShadowSummary([invalidNonMatchRecord]);
      expect(summary.gateCheckDetails.allDifferencesHaveReasonAndEvidence).toBe(false);
      expect(summary.isSafetyGatePassed).toBe(false);
    });

    it('7. 证明：P0 场景识别完全基于 tags: [P0_FALSE_PASS]，不依赖编号 8/12/15', () => {
      // 场景编号为 999，但带有 P0 标签
      const customP0Record: ShadowComparisonRecord = {
        scenarioIndex: 999,
        scenarioName: '编号重排后的 P0 场景',
        testId: 't-reordered-p0',
        tags: ['P0_FALSE_PASS'],
        goldenExpectation: 'PASS',
        rawLegacyVerdict: 'PASS',
        canonicalVerdict: 'UNVERIFIED',
        category: 'EXPECTED_STRICTER',
        mappingSuccess: true,
        mappingIssues: [],
        reasonCode: 'USER_ASSERTION_ONLY_TIGHTENED',
        evidenceIds: ['ev-actual-p0-1'],
        notes: '',
      };

      const summary = buildShadowSummary([customP0Record]);
      expect(summary.gateCheckDetails.p0FalsePassTightened).toBe(true);
    });

    it('8. 证明：如果尝试调用 fetch，测试立即因受限而抛错崩溃', async () => {
      expect(() => fetch('http://example.com/api')).toThrowError('NETWORK_ACCESS_FORBIDDEN');
    });

    it('9 & 10. 汇总 20 个表驱动场景，证明满足全部迁移安全门槛 (REGRESSION_RISK=0, MAPPING_GAP=0)', async () => {
      const records: ShadowComparisonRecord[] = [];
      for (const tc of shadowTestCases) {
        records.push(await runSingleShadowComparison(tc));
      }

      const summary = buildShadowSummary(records);

      // 场景数量与六类统计验证
      expect(summary.totalScenarios).toBe(20);
      expect(summary.matchCount).toBe(17);
      expect(summary.expectedStricterCount).toBe(3);
      expect(summary.regressionRiskCount).toBe(0);
      expect(summary.mappingGapCount).toBe(0);
      expect(summary.semanticMismatchCount).toBe(0);
      expect(summary.needsReviewCount).toBe(0);

      // 逐项门禁核查
      expect(summary.gateCheckDetails.p0FalsePassTightened).toBe(true);
      expect(summary.gateCheckDetails.regressionRiskZero).toBe(true);
      expect(summary.gateCheckDetails.mappingGapZero).toBe(true);
      expect(summary.gateCheckDetails.needsReviewZero).toBe(true);
      expect(summary.gateCheckDetails.noWeakerEvidenceLooserVerdict).toBe(true);
      expect(summary.gateCheckDetails.allDifferencesHaveReasonAndEvidence).toBe(true);

      // 总体安全门禁通过
      expect(summary.isSafetyGatePassed).toBe(true);
    });
  });
});
