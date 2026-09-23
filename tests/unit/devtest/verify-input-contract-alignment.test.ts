import { describe, expect, expectTypeOf, it } from 'vitest';
import { verify, type VerifyKernelOptions } from '../../../src/devtest/core-kernel.js';
import type { CanonicalTestSpec } from '../../../src/devtest/canonical-protocol.js';

describe('Verify Input Contract Alignment & Conflict Validation Tests', () => {
  const dummyPng = Buffer.concat([
    Buffer.from('89504e470d0a1a0a0000000d4948445200000020000000200806000000', 'hex'),
    Buffer.alloc(32),
  ]);

  it('[Contract-Alignment-1] VerifyKernelOptions declares all 7 previously undeclared properties with correct types', () => {
    // Type-level assertion
    expectTypeOf<VerifyKernelOptions>().toHaveProperty('progress');
    expectTypeOf<VerifyKernelOptions>().toHaveProperty('capturedAt');
    expectTypeOf<VerifyKernelOptions>().toHaveProperty('testId');
    expectTypeOf<VerifyKernelOptions>().toHaveProperty('environment');
    expectTypeOf<VerifyKernelOptions>().toHaveProperty('executionMode');
    expectTypeOf<VerifyKernelOptions>().toHaveProperty('extraEnvelopes');
    expectTypeOf<VerifyKernelOptions>().toHaveProperty('isProcessing');

    // Runtime type-check: verify options object with all 7 fields compiles without any 'as any'
    const fullOpts: VerifyKernelOptions = {
      taskId: 10001,
      modelId: 201,
      mediaType: 'image',
      terminalStatus: 'SUCCESS',
      progress: 100,
      capturedAt: '2026-09-22T00:00:00.000Z',
      testId: 'test-contract-1',
      environment: 'test',
      executionMode: 'fixture',
      extraEnvelopes: [],
      isProcessing: false,
    };
    expect(fullOpts.progress).toBe(100);
    expect(fullOpts.executionMode).toBe('fixture');
  });

  it('[Conflict-Validation-1] 运行环境冲突: env 与 environment 不一致时标记 EVIDENCE_CONFLICT', async () => {
    const res = await verify({
      taskId: 10002,
      modelId: 201,
      mediaType: 'image',
      env: 'test',
      environment: 'preonline', // 冲突
      terminalStatus: 'SUCCESS',
      artifactBuffer: dummyPng,
    });

    expect(res.hasEvidenceConflict).toBe(true);
    expect(res.conflictReasons?.some((r) => r.includes('运行环境参数冲突'))).toBe(true);
    expect(res.verdict).not.toBe('PASS');
    expect(res.passed).toBe(false);
  });

  it('[Conflict-Validation-2] 规范环境冲突: spec.environment 与传入环境不一致时标记 EVIDENCE_CONFLICT', async () => {
    const spec: CanonicalTestSpec = {
      testId: 'test-spec-env-conflict',
      requirementId: 'REQ-ENV-1',
      scenario: 'IMAGE_NEW_MODEL',
      environment: 'preonline', // 规范声明为 preonline
      executionMode: 'FIXTURE',
      target: { targetType: 'model', modelId: 201 },
      inputs: {},
      deterministicAssertions: [],
      costLimit: { maxCostPoints: 0 },
      sideEffectPolicy: 'READ_ONLY',
      requiredEvidence: ['FIXTURE:TASK_STATUS'],
    };

    const res = await verify({
      taskId: 10003,
      modelId: 201,
      mediaType: 'image',
      env: 'test', // 运行环境传入 test，与 spec 冲突
      spec,
      terminalStatus: 'SUCCESS',
      artifactBuffer: dummyPng,
    });

    expect(res.hasEvidenceConflict).toBe(true);
    expect(res.conflictReasons?.some((r) => r.includes('规范与运行环境冲突'))).toBe(true);
    expect(res.verdict).not.toBe('PASS');
    expect(res.passed).toBe(false);
  });

  it('[Conflict-Validation-3] 执行模式冲突: isSimulated=true 与 executionMode=real 互斥冲突', async () => {
    const res = await verify({
      taskId: 10004,
      modelId: 201,
      mediaType: 'image',
      isSimulated: true,
      executionMode: 'real', // 互斥
      terminalStatus: 'SUCCESS',
      artifactBuffer: dummyPng,
    });

    expect(res.hasEvidenceConflict).toBe(true);
    expect(res.conflictReasons?.some((r) => r.includes('执行模式参数冲突'))).toBe(true);
    expect(res.verdict).not.toBe('PASS');
    expect(res.passed).toBe(false);
  });

  it('[Conflict-Validation-4] 真实模式凭据缺失: 声明 executionMode=real 但无任何会话凭据时严格阻断', async () => {
    const res = await verify({
      taskId: 10005,
      modelId: 201,
      mediaType: 'image',
      executionMode: 'real', // 声明真实执行但未传 session / cookies / sessionFile
      terminalStatus: 'SUCCESS',
      artifactBuffer: dummyPng,
    });

    expect(res.hasEvidenceConflict).toBe(true);
    expect(res.conflictReasons?.some((r) => r.includes('执行模式凭据缺失'))).toBe(true);
    expect(res.verdict).not.toBe('PASS');
    expect(res.passed).toBe(false);
  });

  it('[Conflict-Validation-5] 媒体类型错配: mediaType 为 image 但仅传入 videoUrl', async () => {
    const res = await verify({
      taskId: 10006,
      modelId: 201,
      mediaType: 'image',
      videoUrl: 'https://example.com/fake.mp4', // 错配
      terminalStatus: 'SUCCESS',
    });

    expect(res.hasEvidenceConflict).toBe(true);
    expect(res.conflictReasons?.some((r) => r.includes('媒体类型与地址冲突'))).toBe(true);
    expect(res.verdict).not.toBe('PASS');
    expect(res.passed).toBe(false);
  });

  it('[Conflict-Validation-6] 计费参数冲突: image 场景下 price 与 customPoints 数值不一致', async () => {
    const res = await verify({
      taskId: 10007,
      modelId: 201,
      mediaType: 'image',
      price: 15,
      customPoints: 20, // 冲突
      terminalStatus: 'SUCCESS',
      artifactBuffer: dummyPng,
    });

    expect(res.hasEvidenceConflict).toBe(true);
    expect(res.conflictReasons?.some((r) => r.includes('计费参数冲突'))).toBe(true);
    expect(res.verdict).not.toBe('PASS');
    expect(res.passed).toBe(false);
  });

  it('[Conflict-Validation-7] 产物 Buffer 冲突: assetBuffer 与 artifactBuffer 二进制不一致', async () => {
    const buf1 = Buffer.from('abc');
    const buf2 = Buffer.from('xyz');

    const res = await verify({
      taskId: 10008,
      modelId: 201,
      mediaType: 'image',
      assetBuffer: buf1,
      artifactBuffer: buf2, // 冲突
      terminalStatus: 'SUCCESS',
    });

    expect(res.hasEvidenceConflict).toBe(true);
    expect(res.conflictReasons?.some((r) => r.includes('产物 Buffer 冲突'))).toBe(true);
    expect(res.verdict).not.toBe('PASS');
    expect(res.passed).toBe(false);
  });

  it('[Invariant-Preserved] 合法重叠参数组合与向后兼容性验证', async () => {
    // 仅传入 environment (无 env)
    const resEnv = await verify({
      taskId: 10009,
      modelId: 201,
      mediaType: 'image',
      environment: 'test',
      terminalStatus: 'SUCCESS',
      artifactBuffer: dummyPng,
      scoreLogs: [{ task_id: 10009, type: 2, score: -10 }],
      expectedPoints: 10,
      dbExtraConfirmed: true,
      dbExtra: { diversion: 10 },
      extra: { diversion: 10 },
    });
    expect(resEnv.hasEvidenceConflict).toBeFalsy();

    // 相同内容的 assetBuffer 与 artifactBuffer
    const resBuf = await verify({
      taskId: 10010,
      modelId: 201,
      mediaType: 'image',
      assetBuffer: dummyPng,
      artifactBuffer: dummyPng,
      terminalStatus: 'SUCCESS',
      scoreLogs: [{ task_id: 10010, type: 2, score: -10 }],
      expectedPoints: 10,
      dbExtraConfirmed: true,
      dbExtra: { diversion: 10 },
      extra: { diversion: 10 },
    });
    expect(resBuf.hasEvidenceConflict).toBeFalsy();
  });

  it('[Identity-Conflict-1] 目标身份冲突: taskId 与 spec.target.taskId 不一致时严格阻断', async () => {
    const spec: CanonicalTestSpec = {
      testId: 'test-spec-target-task-conflict',
      requirementId: 'REQ-TASK-1',
      scenario: 'IMAGE_NEW_MODEL',
      environment: 'test',
      executionMode: 'FIXTURE',
      target: { targetType: 'task', taskId: 99999 }, // 目标 taskId 为 99999
      inputs: {},
      deterministicAssertions: [],
      costLimit: { maxCostPoints: 0 },
      sideEffectPolicy: 'READ_ONLY',
      requiredEvidence: ['FIXTURE:TASK_STATUS'],
    };

    const res = await verify({
      taskId: 10011, // 传入 10011 与 spec 不一致
      modelId: 201,
      mediaType: 'image',
      spec,
      terminalStatus: 'SUCCESS',
      artifactBuffer: dummyPng,
    });

    expect(res.hasEvidenceConflict).toBe(true);
    expect(res.conflictReasons?.some((r) => r.includes('目标身份冲突') && r.includes('target.taskId'))).toBe(true);
    expect(res.verdict).not.toBe('PASS');
    expect(res.passed).toBe(false);
  });

  it('[Identity-Conflict-2] 目标身份冲突: taskId 与 spec.inputs.taskId 不一致时严格阻断', async () => {
    const spec: CanonicalTestSpec = {
      testId: 'test-spec-inputs-task-conflict',
      requirementId: 'REQ-TASK-2',
      scenario: 'IMAGE_NEW_MODEL',
      environment: 'test',
      executionMode: 'FIXTURE',
      target: { targetType: 'model', modelId: 201 },
      inputs: { taskId: 88888 }, // inputs 中的 taskId 为 88888
      deterministicAssertions: [],
      costLimit: { maxCostPoints: 0 },
      sideEffectPolicy: 'READ_ONLY',
      requiredEvidence: ['FIXTURE:TASK_STATUS'],
    };

    const res = await verify({
      taskId: 10012, // 传入 10012 与 inputs 不一致
      modelId: 201,
      mediaType: 'image',
      spec,
      terminalStatus: 'SUCCESS',
      artifactBuffer: dummyPng,
    });

    expect(res.hasEvidenceConflict).toBe(true);
    expect(res.conflictReasons?.some((r) => r.includes('目标身份冲突') && r.includes('inputs.taskId'))).toBe(true);
    expect(res.verdict).not.toBe('PASS');
    expect(res.passed).toBe(false);
  });

  it('[Identity-Conflict-3] 目标模型冲突: modelId 与 spec.target.modelId 不一致时标记冲突', async () => {
    const spec: CanonicalTestSpec = {
      testId: 'test-spec-model-conflict',
      requirementId: 'REQ-MODEL-1',
      scenario: 'IMAGE_NEW_MODEL',
      environment: 'test',
      executionMode: 'FIXTURE',
      target: { targetType: 'model', modelId: 999 }, // modelId 为 999
      inputs: {},
      deterministicAssertions: [],
      costLimit: { maxCostPoints: 0 },
      sideEffectPolicy: 'READ_ONLY',
      requiredEvidence: ['FIXTURE:TASK_STATUS'],
    };

    const res = await verify({
      taskId: 10013,
      modelId: 201, // 传入 201 与 spec 不一致
      mediaType: 'image',
      spec,
      terminalStatus: 'SUCCESS',
      artifactBuffer: dummyPng,
    });

    expect(res.hasEvidenceConflict).toBe(true);
    expect(res.conflictReasons?.some((r) => r.includes('目标模型冲突'))).toBe(true);
    expect(res.verdict).not.toBe('PASS');
    expect(res.passed).toBe(false);
  });

  it('[Mode-Alignment-1] isSimulated=true 时生成的 canonicalSpec.executionMode 保持为 OFFLINE，不丢失为 FIXTURE', async () => {
    const res = await verify({
      taskId: 10014,
      modelId: 201,
      mediaType: 'image',
      isSimulated: true,
      terminalStatus: 'SUCCESS',
      artifactBuffer: dummyPng,
    });

    expect(res.executionMode).toBe('offline');
    expect(res.canonicalSpec?.executionMode).toBe('OFFLINE');
  });

  it('[Mode-Alignment-2] executionMode=offline 时回执与 canonicalSpec.executionMode 保持为 OFFLINE', async () => {
    const res = await verify({
      taskId: 10015,
      modelId: 201,
      mediaType: 'image',
      executionMode: 'offline',
      terminalStatus: 'SUCCESS',
      artifactBuffer: dummyPng,
    });

    expect(res.executionMode).toBe('offline');
    expect(res.canonicalSpec?.executionMode).toBe('OFFLINE');
  });

  it('[Mode-Conflict-1] spec.executionMode 与实际执行模式不一致时标记 EVIDENCE_CONFLICT', async () => {
    const spec: CanonicalTestSpec = {
      testId: 'test-spec-mode-conflict',
      requirementId: 'REQ-MODE-1',
      scenario: 'IMAGE_NEW_MODEL',
      environment: 'test',
      executionMode: 'REAL', // spec 声明 REAL
      target: { targetType: 'model', modelId: 201 },
      inputs: {},
      deterministicAssertions: [],
      costLimit: { maxCostPoints: 0 },
      sideEffectPolicy: 'READ_ONLY',
      requiredEvidence: ['FIXTURE:TASK_STATUS'],
    };

    const res = await verify({
      taskId: 10016,
      modelId: 201,
      mediaType: 'image',
      isSimulated: true, // 实际为 offline
      spec,
      terminalStatus: 'SUCCESS',
      artifactBuffer: dummyPng,
    });

    expect(res.hasEvidenceConflict).toBe(true);
    expect(res.conflictReasons?.some((r) => r.includes('执行模式冲突'))).toBe(true);
    expect(res.verdict).not.toBe('PASS');
    expect(res.passed).toBe(false);
  });

  it('[Credential-Conflict-1] 仅传入 cookies 缺少 baseUrl 时标记凭据不完整且不能 PASS', async () => {
    const res = await verify({
      taskId: 10017,
      modelId: 201,
      mediaType: 'image',
      cookies: 'PHPSESSID=orphan_cookie', // 仅 cookies，未传 baseUrl
      terminalStatus: 'SUCCESS',
      artifactBuffer: dummyPng,
    });

    expect(res.hasEvidenceConflict).toBe(true);
    expect(res.conflictReasons?.some((r) => r.includes('凭据不完整'))).toBe(true);
    expect(res.verdict).not.toBe('PASS');
    expect(res.passed).toBe(false);
  });

  it('[Credential-Conflict-2] 声明 executionMode=real 仅传入 cookies 缺少 baseUrl 未形成会话时标记冲突', async () => {
    const res = await verify({
      taskId: 10018,
      modelId: 201,
      mediaType: 'image',
      executionMode: 'real',
      cookies: 'PHPSESSID=orphan_cookie', // 声明 real 但仅 cookies 无 baseUrl
      terminalStatus: 'SUCCESS',
      artifactBuffer: dummyPng,
    });

    expect(res.hasEvidenceConflict).toBe(true);
    expect(res.conflictReasons?.some((r) => r.includes('执行模式凭据缺失'))).toBe(true);
    expect(res.conflictReasons?.some((r) => r.includes('凭据不完整'))).toBe(true);
    expect(res.verdict).not.toBe('PASS');
    expect(res.passed).toBe(false);
  });
});
