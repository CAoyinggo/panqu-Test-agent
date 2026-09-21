/**
 * Panqu AI DevTest — Core Kernel Canonical Verdict Engine Switch Safety Proofs
 * Phase 1 生产环境唯一裁决引擎切换安全证明测试套件（10 大核心反证测试）
 *
 * 核心架构边界 (遵守 docs/ARCHITECTURE_FREEZE.md):
 * 1. 缺少真实网关快照时，即使调用者声明确认，也只能得到 UNVERIFIED + blocker，legacy acceptance=BLOCKED；
 * 2. 缺少 extra.diversion 真实证据时不能 PASS；
 * 3. 静态渠道或 USER_ASSERTION 不能满足 SERVER_API requiredEvidence；
 * 4. 定价未知时不能 PASS；
 * 5. PROCESSING 生命周期不能让业务裁决 PASS，也不能覆盖明确 FAIL；
 * 6. 核心证据 FAIL 时，FAIL 优先于所有 UNVERIFIED；
 * 7. 所有必需证据真实通过时才能 PASS/ACCEPTED；
 * 8. 投影层只修改展示状态，不能重新计算业务结论；
 * 9. expectedPoints > 0 时 verify 的 sideEffectPolicy 仍为 READ_ONLY；
 * 10. 仓库中不存在旧 verify 裁决实现副本。
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { verify } from '../../../src/devtest/core-kernel.js';
import * as canonicalVerdictEngine from '../../../src/devtest/canonical-verdict-engine.js';
import * as mediaFlow from '../../../src/devtest/media-flow.js';
import { createSyntheticValidMp4 } from '../../../src/devtest/media-inspector.js';
import { DevTestMcpService } from '../../../src/devtest/mcp-service.js';
import type { CanonicalTestSpec, CanonicalEvidenceEnvelope } from '../../../src/devtest/canonical-protocol.js';
import {
  projectCanonicalVerdictToLegacy,
  type LegacyLifecycleDisplayContext,
} from '../../../src/devtest/legacy-protocol-mappers.js';

describe('Canonical Verdict Engine 唯一收口与反证安全测试 (10 大反证门禁)', () => {
  const validMp4 = createSyntheticValidMp4({ width: 1280, height: 720, durationSeconds: 4 });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('反证测试 1: 缺少真实网关快照时，即使调用者声明确认，也只能得到 UNVERIFIED + blocker，legacy acceptance=BLOCKED', async () => {
    const pollSpy = vi.spyOn(mediaFlow, 'pollTaskStatus').mockResolvedValueOnce({
      finalSnapshot: {
        taskId: 99101,
        taskStatus: 2,
        statusLabel: '成功',
        videoUrl: 'https://test-main.example.com/output.mp4',
        progress: 100,
        pollCount: 1,
        durationMs: 10,
      },
      totalPolls: 1,
      timeline: [],
    });

    // REAL 模式，分流模型 84，调用者传入 gatewayChannelConfirmed: true 但无 gatewaySnapshot
    const res = await verify({
      taskId: 99101,
      modelId: 84,
      mediaType: 'video',
      baseUrl: 'https://test-main.example.com',
      cookies: 'PHPSESSID=mock_session_proof1',
      gatewayChannelConfirmed: true, // 仅调用者声明确认
      expectedPoints: 70,
      terminalStatus: 'SUCCESS',
      artifactBuffer: validMp4,
      scoreLogs: [{ task_id: 99101, type: 2, score: -70 }],
      dbExtraConfirmed: true,
      executionMode: 'real',
    } as any);

    pollSpy.mockRestore();

    expect(res.canonicalVerdict).toBeDefined();
    expect(res.canonicalVerdict?.verdict).toBe('UNVERIFIED');
    expect(res.canonicalVerdict?.blockers.some((b) => b.code.includes('GATEWAY'))).toBe(true);
    expect(res.acceptance).toBe('BLOCKED');
    expect(res.passed).toBe(false);
  });

  it('反证测试 2: 缺少 extra.diversion 真实证据时不能 PASS', async () => {
    const pngBuffer = Buffer.concat([
      Buffer.from('89504e470d0a1a0a0000000d4948445200000400000004000806000000', 'hex'),
      Buffer.alloc(32),
    ]);

    // 模型 201（非 global 分流模型），未提供 dbExtraConfirmed 与 dbExtra
    const res = await verify({
      taskId: 99102,
      modelId: 201,
      mediaType: 'image',
      artifactBuffer: pngBuffer,
      terminalStatus: 'SUCCESS',
      expectedPoints: 10,
      scoreLogs: [{ task_id: 99102, type: 2, score: -10 }],
      // 未传 dbExtraConfirmed 与 dbExtra
    });

    expect(res.passed).toBe(false);
    expect(res.verdict).toBe('UNVERIFIED');
    expect(res.canonicalVerdict?.verdict).toBe('UNVERIFIED');
    expect(res.acceptance).toBe('UNVERIFIED');
  });

  it('反证测试 3: 静态渠道或 USER_ASSERTION 不能满足 SERVER_API requiredEvidence', () => {
    const spec: CanonicalTestSpec = {
      testId: 'test-untrusted-assertion-proof',
      requirementId: 'REQ-PROOF-03',
      scenario: 'ROUTING_ACCEPTANCE',
      environment: 'test',
      executionMode: 'REAL',
      target: { targetType: 'channel', expectedChannelId: 2 },
      inputs: { taskId: 99103 },
      deterministicAssertions: [],
      costLimit: { maxCostPoints: 0, allowZeroCostOnly: true },
      sideEffectPolicy: 'READ_ONLY',
      requiredEvidence: ['SERVER_API:ROUTING_CHANNEL'],
    };

    const userAssertionEnv: CanonicalEvidenceEnvelope = {
      evidenceId: 'env-user-assertion-1',
      testId: 'test-untrusted-assertion-proof',
      sourceTool: 'caller',
      sourceType: 'USER_ASSERTION',
      evidenceKey: 'SERVER_API:ROUTING_CHANNEL',
      observationStatus: 'PASS',
      capturedAt: new Date().toISOString(),
      environment: 'test',
      subjectType: 'routing',
      subjectId: 99103,
      normalizedFields: { actualValue: 2 },
      provenance: 'USER_DECLARED',
      confidence: 0.5,
      immutable: true,
      redacted: true,
      collectionStatus: 'SUCCESS',
    };

    const canonicalRes = canonicalVerdictEngine.evaluateCanonicalVerdict(spec, [userAssertionEnv]);
    expect(canonicalRes.verdict).toBe('UNVERIFIED');
    expect(canonicalRes.requiredEvidenceEvaluation.satisfied).toBe(false);
    expect(canonicalRes.blockers.some((b) => b.code === 'UNTRUSTED_EVIDENCE_SOURCE')).toBe(true);

    const legacyPresentation = projectCanonicalVerdictToLegacy(canonicalRes);
    expect(legacyPresentation.acceptance).toBe('BLOCKED');
    expect(legacyPresentation.passed).toBe(false);
  });

  it('反证测试 4: 定价未知时不能 PASS', async () => {
    // 未知模型 99999（刊例未收录，定价未确定）
    const res = await verify({
      taskId: 99104,
      modelId: 99999,
      mediaType: 'video',
      terminalStatus: 'SUCCESS',
      artifactBuffer: validMp4,
      dbExtraConfirmed: true,
    });

    expect(res.contract?.pricing.allowPass).toBe(false);
    expect(res.passed).toBe(false);
    expect(res.verdict).toBe('UNVERIFIED');
    expect(res.canonicalVerdict?.verdict).toBe('UNVERIFIED');
    expect(res.canonicalVerdict?.blockers.some((b) => b.code === 'PRICING_UNVERIFIED')).toBe(true);
    expect(res.acceptance).toBe('BLOCKED');
  });

  it('反证测试 5: PROCESSING 生命周期不能让业务裁决 PASS，也不能覆盖明确 FAIL', async () => {
    // 5a. PROCESSING 不能让业务裁决 PASS
    const resProcessing = await verify({
      taskId: 99105,
      modelId: 84,
      mediaType: 'video',
      terminalStatus: 'PROCESSING',
    });
    expect(resProcessing.passed).toBe(false);
    expect(resProcessing.status).toBe('PROCESSING');
    expect(resProcessing.verdict).toBe('PROCESSING');
    expect(resProcessing.canonicalVerdict?.verdict).toBe('UNVERIFIED');
    expect(resProcessing.canonicalVerdict?.blockers.some((b) => b.code === 'TASK_NOT_TERMINAL')).toBe(true);
    expect(resProcessing.acceptance).toBe('BLOCKED');

    // 5b. PROCESSING 不能覆盖明确 FAIL
    const resFailedWithProcessing = await verify({
      taskId: 99106,
      modelId: 84,
      mediaType: 'video',
      terminalStatus: 'FAILED',
      isProcessing: true,
    } as any);
    expect(resFailedWithProcessing.passed).toBe(false);
    expect(resFailedWithProcessing.verdict).toBe('FAIL');
    expect(resFailedWithProcessing.canonicalVerdict?.verdict).toBe('FAIL');
    expect(resFailedWithProcessing.acceptance).toBe('REJECTED');
  });

  it('反证测试 6: 核心证据 FAIL 时，FAIL 优先于所有 UNVERIFIED', async () => {
    // 任务明确失败 (FAIL)，同时账单流水缺失 (UNVERIFIED)
    const res = await verify({
      taskId: 99107,
      modelId: 84,
      mediaType: 'video',
      terminalStatus: 'FAILED',
    });

    expect(res.evidence.task.status).toBe('FAIL');
    expect(res.evidence.billing.status).toBe('UNVERIFIED');
    expect(res.canonicalVerdict?.verdict).toBe('FAIL');
    expect(res.verdict).toBe('FAIL');
    expect(res.acceptance).toBe('REJECTED');
    expect(res.passed).toBe(false);
  });

  it('反证测试 7: 所有必需证据真实通过时才能 PASS/ACCEPTED', async () => {
    const res = await verify({
      taskId: 99108,
      modelId: 84,
      mediaType: 'video',
      terminalStatus: 'SUCCESS',
      artifactBuffer: validMp4,
      expectedPoints: 70,
      scoreLogs: [{ task_id: 99108, type: 2, score: -70 }],
      dbExtraConfirmed: true,
      channels: [
        {
          id: 2,
          name: 'NewAPI-Video-2',
          group: 'default',
          models: ['84'],
          status: 1,
          weight: 10,
          dailyQuotaLimit: 100000,
          usedQuota: 0,
        },
      ],
      gatewaySnapshot: {
        capturedAt: new Date().toISOString(),
        environment: 'test',
        channels: [
          {
            id: 2,
            name: 'NewAPI-Video-2',
            group: 'default',
            models: ['84'],
            status: 1,
            weight: 10,
            dailyQuotaLimit: 100000,
            usedQuota: 0,
          },
        ],
        sourceEndpoint: '/aivideo/channel/index',
        collectionStatus: 'SUCCESS',
        provenance: 'API_READONLY_COLLECTOR',
      },
      channelId: 2,
      retryLog: { newapi_channel_id: 2 },
    });

    expect(res.canonicalVerdict?.verdict).toBe('PASS');
    expect(res.canonicalVerdict?.blockers.length).toBe(0);
    expect(res.verdict).toBe('PASS');
    expect(res.acceptance).toBe('ACCEPTED');
    expect(res.passed).toBe(true);

    // 检查 MCP 服务通过同一调用获得兼容一致结构
    const mcpService = new DevTestMcpService();
    const mcpRes = await mcpService.call({
      action: 'verify',
      task_id: 99108,
      model_id: 84,
      media_type: 'video',
      terminalStatus: 'SUCCESS',
      artifact_buffer: validMp4,
      expected_points: 70,
      score_logs: [{ task_id: 99108, type: 2, score: -70 }],
      db_extra_confirmed: true,
    });
    expect(mcpRes.ok).toBe(true);
    expect(mcpRes.data.passed).toBe(true);
    expect(mcpRes.data.verdict).toBe('PASS');
    expect(mcpRes.data.acceptance).toBe('ACCEPTED');
  });

  it('反证测试 8: 投影层只修改展示状态，不能重新计算业务结论', () => {
    const fixedCanonicalResult: canonicalVerdictEngine.CanonicalVerdictResult = {
      verdict: 'PASS',
      testId: 'test-projection-invariants',
      requiredEvidenceEvaluation: {
        satisfied: true,
        missingEvidenceKeys: [],
        failedEvidenceKeys: [],
        unverifiedEvidenceKeys: [],
        matchedEnvelopes: {},
        details: [],
      },
      assertionResults: [],
      evidenceIdsUsed: ['env-1'],
      reasons: ['全部必需证据通过'],
      warnings: [],
      blockers: [],
    };

    // 无论 displayContext 传入什么生命周期状态，业务裁决与 acceptance 绝对不变
    const p1 = projectCanonicalVerdictToLegacy(fixedCanonicalResult, { terminalStatus: 'PROCESSING', isProcessing: true });
    expect(p1.passed).toBe(true);
    expect(p1.acceptance).toBe('ACCEPTED');
    expect(p1.status).toBe('PROCESSING'); // 仅展示状态变化
    expect(p1.verdict).toBe('PROCESSING'); // 仅兼容展示字段

    const p2 = projectCanonicalVerdictToLegacy(fixedCanonicalResult, { terminalStatus: 'SUCCESS', isProcessing: false });
    expect(p2.passed).toBe(true);
    expect(p2.acceptance).toBe('ACCEPTED');
    expect(p2.status).toBe('SUCCESS');
    expect(p2.verdict).toBe('PASS');

    // 证明投影函数参数类型不再接收 pricing, gateway, dbExtra 等业务事实
    const displayCtx: LegacyLifecycleDisplayContext = { terminalStatus: 'SUCCESS' };
    // @ts-expect-error - 确保编译期禁止传入业务事实字段
    displayCtx.isDbExtraVerified = true;
    // @ts-expect-error - 确保编译期禁止传入业务事实字段
    displayCtx.pricingDetermined = true;
  });

  it('反证测试 9: expectedPoints > 0 时 verify 的 sideEffectPolicy 仍为 READ_ONLY', async () => {
    const res = await verify({
      taskId: 99109,
      modelId: 84,
      mediaType: 'video',
      terminalStatus: 'SUCCESS',
      artifactBuffer: validMp4,
      expectedPoints: 70, // 费用大于 0
      scoreLogs: [{ task_id: 99109, type: 2, score: -70 }],
      dbExtraConfirmed: true,
    });

    expect(res.canonicalSpec).toBeDefined();
    expect(res.canonicalSpec?.inputs.expectedPoints).toBe(70);
    expect(res.canonicalSpec?.costLimit.maxCostPoints).toBe(0);
    expect(res.canonicalSpec?.costLimit.allowZeroCostOnly).toBe(true);
    // 核心断言：verify 是只读动作，任何费用数值都不能推导出 sideEffectPolicy 为 ALLOW_PAID
    expect(res.canonicalSpec?.sideEffectPolicy).toBe('READ_ONLY');
  });

  it('反证测试 10: 仓库中不存在旧 verify 裁决实现副本', () => {
    const legacyHelperPath = resolve(__dirname, 'helpers/legacy-verify-kernel.ts');
    expect(existsSync(legacyHelperPath)).toBe(false);

    // 扫描 helpers 目录，确认旧版 verify 副本文件已彻底移除
    const helperDir = resolve(__dirname, 'helpers');
    const helperFiles = readdirSync(helperDir);
    expect(helperFiles.includes('legacy-verify-kernel.ts')).toBe(false);

    // 扫描核心源文件，确认不存在 legacyVerify 函数定义
    const coreKernelSource = readFileSync(resolve(__dirname, '../../../src/devtest/core-kernel.ts'), 'utf-8');
    expect(coreKernelSource).not.toMatch(/function\s+legacyVerify\b/);
  });
});
