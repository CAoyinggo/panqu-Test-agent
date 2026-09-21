import { describe, expect, it } from 'vitest';
import {
  identifyChangeScenario,
  discoverModelContract,
  EnvironmentProbe,
  parseChangeIntent,
} from '../../../src/devtest/env-probe.js';
import { plan, execute, verify } from '../../../src/devtest/core-kernel.js';
import { createSyntheticValidMp4 } from '../../../src/devtest/media-inspector.js';

describe('DevTest 动态计划生成与事实探知 (Dynamic Plan & Fact Discovery)', () => {
  describe('1. 场景识别引擎 (identifyChangeScenario)', () => {
    it('识别四种核心业务场景：新图片模型、新视频模型、已有图片模型分流变更、已有视频模型分流变更', () => {
      // 场景 1: 新图片模型直接接入
      const sc1 = identifyChangeScenario('image', 901, { changeType: 'new_model' });
      expect(sc1).toBe('IMAGE_NEW_MODEL');

      // 场景 2: 新视频模型直接接入
      const sc2 = identifyChangeScenario('video', 902, { changeType: 'new_model' });
      expect(sc2).toBe('VIDEO_NEW_MODEL');

      // 场景 3: 已有图片模型新增/变更分流
      const sc3 = identifyChangeScenario('image', 201, { changeType: 'diversion_change' });
      expect(sc3).toBe('IMAGE_DIVERSION_CHANGE');

      // 场景 4: 已有视频模型新增/变更分流
      const sc4 = identifyChangeScenario('video', 84, { changeType: 'diversion_change' });
      expect(sc4).toBe('VIDEO_DIVERSION_CHANGE');
    });

    it('未显式指定 changeType 时自适应识别：静态白名单已知模型默认为分流变更，未知模型默认为新模型', () => {
      expect(identifyChangeScenario('video', 84)).toBe('VIDEO_DIVERSION_CHANGE');
      expect(identifyChangeScenario('image', 201)).toBe('IMAGE_DIVERSION_CHANGE');
      expect(identifyChangeScenario('video', 999)).toBe('VIDEO_NEW_MODEL');
      expect(identifyChangeScenario('image', 998)).toBe('IMAGE_NEW_MODEL');
    });
  });

  describe('2. 事实探知与来源优先级 (discoverModelContract & FactSource)', () => {
    it('遵循优先级：SOURCE_INPUT > SOURCE_STATIC_CONTRACT > SOURCE_DEFAULT_FALLBACK', () => {
      // 1. 未知模型无输入：使用 fallback
      const cUnknown = discoverModelContract(999, 'video');
      expect(cUnknown.alias.source).toBe('SOURCE_DEFAULT_FALLBACK');
      expect(cUnknown.alias.value).toBe('new-video-model-999');

      // 2. 静态已知模型：使用 static contract
      const cStatic = discoverModelContract(84, 'video');
      expect(cStatic.alias.source).toBe('SOURCE_STATIC_CONTRACT');
      expect(cStatic.alias.value).toBe('wan3.0-video');

      // 3. 用户显式输入：覆盖静态契约，标记 SOURCE_INPUT
      const cInput = discoverModelContract(84, 'video', { alias: 'wan3.0-custom-alias' });
      expect(cInput.alias.source).toBe('SOURCE_INPUT');
      expect(cInput.alias.value).toBe('wan3.0-custom-alias');
    });

    it('冲突检测：当输入配置与静态已知契约冲突时记录 CONFIG_MISMATCH', () => {
      const contract = discoverModelContract(84, 'video', {
        alias: 'wan-different-name',
        isGlobal: false,
      });

      expect(contract.conflicts.length).toBeGreaterThan(0);
      const aliasConflict = contract.conflicts.find((c) => c.field === 'alias');
      expect(aliasConflict).toBeDefined();
      expect(aliasConflict?.message).toContain('CONFIG_MISMATCH');
    });

    it('EnvironmentProbe.probe 返回 discoveredContract 与缺少事实排障建议', async () => {
      const report = await EnvironmentProbe.probe({
        env: 'test',
        mock: true,
        modelId: 999,
        mediaType: 'video',
      });

      expect(report.discoveredContract).toBeDefined();
      expect(report.discoveredContract?.modelId).toBe(999);
      // 未知模型缺少刊例价，probe 产生待提供事实建议
      expect(report.recommendations.some((r) => r.includes('真实单价') || r.includes('刊例'))).toBe(true);
    });
  });

  describe('3. 真实事实缺失与 Fail-Closed 阻断 (Missing Facts & Blocked Status)', () => {
    it('未知模型未提供单价时，严禁使用虚假默认值冒充真实事实，标记 BLOCKED', async () => {
      const result = await plan({
        modelId: 999,
        mediaType: 'video',
        flowType: 'diversion',
      });

      expect(result.pricingStatus).toBe('MANUAL_REQUIRED');
      expect(result.contract.pricing.isPricingDetermined).toBe(false);
      expect(result.blocked.length).toBeGreaterThan(0);
      expect(result.blocked.some((b) => b.field === 'pricing')).toBe(true);

      // 账务测试用例必须处于 BLOCKED 状态，拒绝虚假通过
      const billingTest = result.testPlan?.tests.find((t) => t.layer === 'billing');
      expect(billingTest).toBeDefined();
      expect(billingTest?.status).toBe('BLOCKED');
      expect(billingTest?.skipReason).toContain('真实刊例单价缺失');
    });

    it('当人工补充 pointsPerSecond 或 customPoints 后，阻断解除，用例转为 READY', async () => {
      const result = await plan({
        modelId: 999,
        mediaType: 'video',
        flowType: 'diversion',
        pointsPerSecond: 15,
      });

      expect(result.pricingStatus).toBe('DETERMINED');
      expect(result.contract.pricing.isPricingDetermined).toBe(true);
      expect(result.blocked.filter((b) => b.field === 'pricing').length).toBe(0);

      const billingTest = result.testPlan?.tests.find((t) => t.layer === 'billing');
      expect(billingTest?.status).toBe('READY');
    });
  });

  describe('4. 动态测试计划组装与自适应裁剪 (Dynamic TestPlan)', () => {
    it('全量模型 (is_global=1) 生成 routing-global 测试，不生成组织路由组测试', async () => {
      const res = await plan({
        modelId: 84,
        mediaType: 'video',
        flowType: 'diversion',
      });

      const tests = res.testPlan?.tests || [];
      expect(tests.some((t) => t.id === 'routing-global')).toBe(true);
      expect(tests.some((t) => t.id === 'routing-group')).toBe(false);
    });

    it('非全量模型生成 routing-group 组织分流测试', async () => {
      const res = await plan({
        modelId: 201,
        mediaType: 'image',
        flowType: 'diversion',
      });

      const tests = res.testPlan?.tests || [];
      expect(tests.some((t) => t.id === 'routing-group')).toBe(true);
      expect(tests.some((t) => t.id === 'routing-global')).toBe(false);
    });

    it('Seedance 系列模型生成火山重试队列容灾用例，非 Seedance 模型生成直接报错用例', async () => {
      // Seedance 模型 15
      const res15 = await plan({ modelId: 15, mediaType: 'video', flowType: 'diversion' });
      const fallbackTest15 = res15.testPlan?.tests.find((t) => t.layer === 'fallback');
      expect(fallbackTest15?.expected).toEqual({ fallbackAction: 'VOLCENGINE_RETRY_QUEUE', recordRetryLog: true });

      // 非 Seedance 模型 84
      const res84 = await plan({ modelId: 84, mediaType: 'video', flowType: 'diversion' });
      const fallbackTest84 = res84.testPlan?.tests.find((t) => t.layer === 'fallback');
      expect(fallbackTest84?.expected).toEqual({ fallbackAction: 'DIRECT_FAIL_NO_RETRY', recordRetryLog: false });
    });

    it('分辨率能力自适应：支持 720p 的模型生成 720p 测试，支持 1080p 的才生成 1080p 边界测试', async () => {
      // 模型 84 支持 1080p，生成 1080p 边界测试
      const res84 = await plan({ modelId: 84, mediaType: 'video', flowType: 'diversion' });
      expect(res84.testPlan?.tests.some((t) => t.id === 'boundary-1080p')).toBe(true);

      // 自定义模型仅声明 720p，不生成 1080p 边界测试
      const resCustom = await plan({
        modelId: 777,
        mediaType: 'video',
        flowType: 'diversion',
        mainConfig: {
          globalRouteRules: {
            video: {
              777: { resolutions: ['720p'], aspect_ratios: ['16:9'] },
            },
          },
        },
      });
      expect(resCustom.testPlan?.tests.some((t) => t.id === 'boundary-1080p')).toBe(false);
    });
  });

  describe('5. Expected vs Actual 结构化对比与 MANUAL_DB_EVIDENCE_REQUIRED 证据标记', () => {
    it('verify() 输出 expectedVsActual，并明确标记 extra.diversion 需要只读 DB 证据', async () => {
      const res = await verify({
        taskId: 88801,
        modelId: 84,
        mediaType: 'video',
        terminalStatus: 'SUCCESS',
      });

      expect(res.expectedVsActual).toBeDefined();
      const eva = res.expectedVsActual!;
      expect(eva.evidenceStatus.extraSnapshot).toBe('MANUAL_DB_EVIDENCE_REQUIRED');
      expect(eva.manualVerificationGuide).toBeDefined();
      expect(eva.manualVerificationGuide?.extraQuerySql).toContain('SELECT id, extra');
      expect(eva.manualVerificationGuide?.extraQuerySql).toContain('88801');
      expect(eva.manualVerificationGuide?.notice).toContain('不返回 extra 字段');

      // 验证对比项结构
      const diffs = eva.items || eva.diffs;
      expect(diffs.length).toBeGreaterThanOrEqual(4);
      expect(diffs.some((d) => d.field === 'taskStatus')).toBe(true);
      expect(diffs.some((d) => d.field === 'mediaFormat')).toBe(true);
      expect(diffs.some((d) => d.field === 'billingPoints')).toBe(true);
      expect(diffs.some((d) => d.field === 'diversionExtra')).toBe(true);
    });

    it('diffItems 包含明确的 status (PASS/FAIL/BLOCKED/MANUAL_REQUIRED) 与 diff 说明', async () => {
      const res = await verify({
        taskId: 88802,
        modelId: 84,
        mediaType: 'video',
        terminalStatus: 'SUCCESS',
      });
      const diffs = res.expectedVsActual!.diffs;
      const extraDiff = diffs.find((d) => d.field === 'diversionExtra');
      expect(extraDiff).toBeDefined();
      expect(extraDiff?.status).toBe('MANUAL_REQUIRED');
      expect(extraDiff?.diff).toContain('只读权限');
    });
  });

  describe('6. 场景 1: IMAGE_NEW_MODEL 端到端全流程', () => {
    it('完整闭环：识别 → Contract 组装 → Dynamic Plan → Execute → Verify 物理产物与账单', async () => {
      // 1. 场景识别
      const scenario = identifyChangeScenario('image', 950, { changeType: 'new_model' });
      expect(scenario).toBe('IMAGE_NEW_MODEL');

      // 2. 动态 Contract 组装 (含 capabilities, routing, pricing)
      const contract = discoverModelContract(950, 'image', {
        customPoints: 20,
        alias: 'new-flux-model',
        supportedResolutions: ['1k', '2k'],
        supportedAspectRatios: ['1:1', '16:9'],
      });
      expect(contract.pricing.allowPass).toBe(true);
      expect(contract.capabilities.resolutions.value).toEqual(['1k', '2k']);

      // 3. Dynamic Plan 生成
      const planRes = await plan({
        modelId: 950,
        mediaType: 'image',
        changeType: 'new_model',
        customPoints: 20,
        alias: 'new-flux-model',
      });
      expect(planRes.scenario).toBe('IMAGE_NEW_MODEL');
      expect(planRes.testPlan?.tests.some((t) => t.layer === 'artifact')).toBe(true);

      // 4. 执行 (受控仿真)
      const execRes = await execute({
        modelId: 950,
        mediaType: 'image',
        mode: 'mock',
        contract: planRes.contract,
      });
      expect(execRes.ok).toBe(true);
      expect(execRes.taskId).toBeGreaterThan(0);

      // 5. 验真：识别真实 PNG 产物 (IHDR) + 积分对账
      const pngBuffer = Buffer.concat([
        Buffer.from('89504e470d0a1a0a0000000d4948445200000400000004000806000000', 'hex'),
        Buffer.alloc(32),
      ]);
      const verifyRes = await verify({
        taskId: execRes.taskId,
        modelId: 950,
        mediaType: 'image',
        artifactBuffer: pngBuffer,
        terminalStatus: 'SUCCESS',
        expectedPoints: 20,
        contract: planRes.contract,
        scoreLogs: [{ task_id: execRes.taskId, type: 2, score: -20, memo: '任务预扣' }],
      });

      expect(verifyRes.ok).toBe(true);
      expect(verifyRes.passed).toBe(true);
      expect(verifyRes.verdict).toBe('PASS');
      expect(verifyRes.artifact?.decodable).toBe(true);
      expect(verifyRes.artifact?.format).toBe('png');
      expect(verifyRes.billing?.passed).toBe(true);
      expect(verifyRes.expectedVsActual?.evidenceStatus.extraSnapshot).toBe('MANUAL_DB_EVIDENCE_REQUIRED');
      expect(verifyRes.expectedVsActual?.manualVerificationGuide?.extraQuerySql).toContain(`${execRes.taskId}`);
    });
  });

  describe('7. 场景 2: VIDEO_NEW_MODEL 端到端全流程', () => {
    it('完整闭环：识别 → Contract 组装 → Dynamic Plan (MP4 box) → Execute → Verify 物理产物与对账', async () => {
      // 1. 场景识别
      const scenario = identifyChangeScenario('video', 960, { changeType: 'new_model' });
      expect(scenario).toBe('VIDEO_NEW_MODEL');

      // 2. 动态 Contract 组装
      const contract = discoverModelContract(960, 'video', {
        pointsPerSecond: 10,
        alias: 'new-kling-model',
        supportedResolutions: ['720p', '1080p'],
      });
      expect(contract.pricing.allowPass).toBe(true);

      // 3. Dynamic Plan 生成
      const planRes = await plan({
        modelId: 960,
        mediaType: 'video',
        changeType: 'new_model',
        pointsPerSecond: 10,
        duration: 5,
        resolution: '720p',
        alias: 'new-kling-model',
      });
      expect(planRes.scenario).toBe('VIDEO_NEW_MODEL');
      expect(planRes.expectedPoints).toBe(50);
      expect(planRes.testPlan?.tests.some((t) => t.id === 'artifact-mp4')).toBe(true);

      // 4. 执行
      const execRes = await execute({
        modelId: 960,
        mediaType: 'video',
        mode: 'mock',
        duration: 5,
        resolution: '720p',
        contract: planRes.contract,
      });
      expect(execRes.ok).toBe(true);
      expect(execRes.taskId).toBeGreaterThan(0);

      // 5. 验真：合法 MP4 Box 结构 + 计费流水
      const mp4Buffer = createSyntheticValidMp4({ width: 1280, height: 720, durationSeconds: 5 });
      const verifyRes = await verify({
        taskId: execRes.taskId,
        modelId: 960,
        mediaType: 'video',
        artifactBuffer: mp4Buffer,
        terminalStatus: 'SUCCESS',
        expectedPoints: 50,
        contract: planRes.contract,
        scoreLogs: [{ task_id: execRes.taskId, type: 2, score: -50, memo: '任务预扣' }],
      });

      expect(verifyRes.ok).toBe(true);
      expect(verifyRes.passed).toBe(true);
      expect(verifyRes.verdict).toBe('PASS');
      expect(verifyRes.artifact?.decodable).toBe(true);
      expect(verifyRes.artifact?.format).toContain('mp4');
      expect(verifyRes.billing?.passed).toBe(true);
      expect(verifyRes.expectedVsActual?.evidenceStatus.extraSnapshot).toBe('MANUAL_DB_EVIDENCE_REQUIRED');
    });
  });

  describe('8. 场景 3: IMAGE_DIVERSION_CHANGE 分流变更与回归比对', () => {
    it('分流变更对比：含 Baseline、路由组隔离、多分辨率，验证无非预期变更 PASS', async () => {
      // 1. Plan 包含 baseline
      const planRes = await plan({
        modelId: 201,
        mediaType: 'image',
        changeType: 'diversion_change',
        resolution: '1k',
      });
      expect(planRes.scenario).toBe('IMAGE_DIVERSION_CHANGE');
      expect(planRes.testPlan?.baseline).toBeDefined();
      expect(planRes.testPlan?.baseline?.flowType).toBe('direct');
      expect(planRes.testPlan?.tests.some((t) => t.id === 'baseline-direct')).toBe(true);

      // 2. 正常验真：路由发生预期变更，但积分与产物无非预期漂移
      const pngBuffer = Buffer.concat([
        Buffer.from('89504e470d0a1a0a0000000d4948445200000400000004000806000000', 'hex'),
        Buffer.alloc(32),
      ]);
      const verifyRes = await verify({
        taskId: 77701,
        modelId: 201,
        mediaType: 'image',
        artifactBuffer: pngBuffer,
        terminalStatus: 'SUCCESS',
        expectedPoints: planRes.expectedPoints,
        baseline: planRes.testPlan?.baseline,
        scoreLogs: [{ task_id: 77701, type: 2, score: -planRes.expectedPoints, memo: '预扣' }],
        dbExtraConfirmed: true,
      });

      expect(verifyRes.passed).toBe(true);
      expect(verifyRes.expectedVsActual?.regressionDiff).toBeDefined();
      const reg = verifyRes.expectedVsActual!.regressionDiff!;
      expect(reg.isRegression).toBe(false);
      expect(reg.unexpectedChanges.length).toBe(0);
      expect(reg.expectedChanges.some((e) => e.field === 'routing')).toBe(true);
    });
  });

  describe('9. 场景 4: VIDEO_DIVERSION_CHANGE 两级分流与回归阻断', () => {
    it('正常分流变更核验通过：包含 fallback 容灾用例与能力过滤', async () => {
      const planRes = await plan({
        modelId: 84,
        mediaType: 'video',
        changeType: 'diversion_change',
        duration: 5,
        resolution: '720p',
      });
      expect(planRes.scenario).toBe('VIDEO_DIVERSION_CHANGE');
      expect(planRes.testPlan?.baseline).toBeDefined();
      expect(planRes.testPlan?.tests.some((t) => t.layer === 'fallback')).toBe(true);

      const mp4Buffer = createSyntheticValidMp4({ width: 1280, height: 720, durationSeconds: 5 });
      const verifyClean = await verify({
        taskId: 84001,
        modelId: 84,
        mediaType: 'video',
        artifactBuffer: mp4Buffer,
        terminalStatus: 'SUCCESS',
        expectedPoints: 70,
        baseline: planRes.testPlan?.baseline,
        scoreLogs: [{ task_id: 84001, type: 2, score: -70, memo: '预扣' }],
      });
      expect(verifyClean.passed).toBe(true);
      expect(verifyClean.expectedVsActual?.regressionDiff?.isRegression).toBe(false);
    });

    it('回归阻断 1：变更后积分发生非预期漂移，准确报警并阻断 PASS', async () => {
      const planRes = await plan({ modelId: 84, mediaType: 'video', changeType: 'diversion_change', duration: 5, resolution: '720p' });
      const mp4Buffer = createSyntheticValidMp4({ width: 1280, height: 720, durationSeconds: 5 });

      const verifyDrift = await verify({
        taskId: 84002,
        modelId: 84,
        mediaType: 'video',
        artifactBuffer: mp4Buffer,
        terminalStatus: 'SUCCESS',
        expectedPoints: 95, // 非预期漂移：基线为 70，实际扣费 95
        baseline: planRes.testPlan?.baseline,
        scoreLogs: [{ task_id: 84002, type: 2, score: -95, memo: '预扣' }],
      });

      expect(verifyDrift.passed).toBe(false);
      expect(verifyDrift.verdict).toBe('FAIL');
      const reg = verifyDrift.expectedVsActual?.regressionDiff;
      expect(reg?.isRegression).toBe(true);
      expect(reg?.unexpectedChanges.some((u) => u.field === 'billingPoints')).toBe(true);
      expect(verifyDrift.reasons.some((r) => r.includes('非预期漂移') || r.includes('回归'))).toBe(true);
    });

    it('回归阻断 2：变更后产物损坏不可解码，准确报警并阻断 PASS', async () => {
      const planRes = await plan({ modelId: 84, mediaType: 'video', changeType: 'diversion_change', duration: 5, resolution: '720p' });
      const corruptBuffer = Buffer.from('NOT_A_VALID_MP4_HEADER_GARBAGE');

      const verifyCorrupt = await verify({
        taskId: 84003,
        modelId: 84,
        mediaType: 'video',
        artifactBuffer: corruptBuffer,
        terminalStatus: 'SUCCESS',
        expectedPoints: 70,
        baseline: planRes.testPlan?.baseline,
        scoreLogs: [{ task_id: 84003, type: 2, score: -70, memo: '预扣' }],
      });

      expect(verifyCorrupt.passed).toBe(false);
      expect(verifyCorrupt.verdict).toBe('FAIL');
      const reg = verifyCorrupt.expectedVsActual?.regressionDiff;
      expect(reg?.isRegression).toBe(true);
      expect(reg?.unexpectedChanges.some((u) => u.field === 'artifactDecodability')).toBe(true);
    });

    it('回归阻断 3：模型别名发生非预期漂移导致请求未命中既有业务，准确报警并阻断 PASS', async () => {
      const planRes = await plan({ modelId: 84, mediaType: 'video', changeType: 'diversion_change', duration: 5, resolution: '720p' });
      const mp4Buffer = createSyntheticValidMp4({ width: 1280, height: 720, durationSeconds: 5 });
      const mutatedContract = discoverModelContract(84, 'video', { alias: 'wan3.0-mutated-alias' });

      const verifyAlias = await verify({
        taskId: 84004,
        modelId: 84,
        mediaType: 'video',
        artifactBuffer: mp4Buffer,
        terminalStatus: 'SUCCESS',
        expectedPoints: 70,
        contract: mutatedContract,
        baseline: planRes.testPlan?.baseline,
        scoreLogs: [{ task_id: 84004, type: 2, score: -70, memo: '预扣' }],
      });

      expect(verifyAlias.passed).toBe(false);
      expect(verifyAlias.verdict).toBe('FAIL');
      const reg = verifyAlias.expectedVsActual?.regressionDiff;
      expect(reg?.isRegression).toBe(true);
      expect(reg?.unexpectedChanges.some((u) => u.field === 'alias')).toBe(true);
    });
  });

  describe('10. 核心事实边界与 Fail-Closed 原则全景测试', () => {
    it('未知模型无价格事实时：execute() 拒绝以虚假定价执行，返回 BLOCKED', async () => {
      const planUnknown = await plan({ modelId: 999, mediaType: 'video', flowType: 'diversion' });
      const execRes = await execute({
        modelId: 999,
        mediaType: 'video',
        mode: 'mock',
        contract: planUnknown.contract,
      });

      expect(execRes.ok).toBe(false);
      expect(execRes.status).toBe('BLOCKED');
      expect(execRes.message).toContain('BLOCKED');
    });

    it('未知模型缺少定价时：pricing.allowPass 为 false，verify() 绝不判为 PASS，返回 UNVERIFIED', async () => {
      const contractFallback = discoverModelContract(999, 'video');
      expect(contractFallback.pricing.source).toBe('MANUAL_REQUIRED');
      expect(contractFallback.pricing.allowPass).toBe(false);

      const mp4Buffer = createSyntheticValidMp4({ width: 1280, height: 720, durationSeconds: 4 });
      const verifyRes = await verify({
        taskId: 99901,
        modelId: 999,
        mediaType: 'video',
        artifactBuffer: mp4Buffer,
        terminalStatus: 'SUCCESS',
        contract: contractFallback,
        scoreLogs: [{ task_id: 99901, type: 2, score: -28, memo: '预扣' }],
      });

      // 绝不能为 SUCCESS / PASS
      expect(verifyRes.passed).toBe(false);
      expect(verifyRes.status).toBe('UNVERIFIED');
      expect(verifyRes.verdict).toBe('UNVERIFIED');
      expect(verifyRes.evidence.billing.status).toBe('UNVERIFIED');
      expect(verifyRes.reasons.some((r) => r.includes('BLOCKED_FALLBACK_PRICING'))).toBe(true);
    });

    it('配置冲突检测：静态契约与输入配置冲突时记录 CONFIG_MISMATCH 并阻断通过', async () => {
      const contractConflict = discoverModelContract(84, 'video', { alias: 'conflict-wan' });
      expect(contractConflict.conflicts.length).toBeGreaterThan(0);

      const mp4Buffer = createSyntheticValidMp4({ width: 1280, height: 720, durationSeconds: 5 });
      const verifyRes = await verify({
        taskId: 84005,
        modelId: 84,
        mediaType: 'video',
        artifactBuffer: mp4Buffer,
        terminalStatus: 'SUCCESS',
        expectedPoints: 70,
        contract: contractConflict,
        scoreLogs: [{ task_id: 84005, type: 2, score: -70, memo: '预扣' }],
      });

      expect(verifyRes.passed).toBe(false);
      expect(verifyRes.verdict).toBe('FAIL');
      expect(verifyRes.reasons.some((r) => r.includes('CONFIG_MISMATCH') || r.includes('配置冲突'))).toBe(true);
    });

    it('能力裁剪与安全边界：生图模型在不支持参考图时不生成 boundary-refimg 用例', async () => {
      const planRes = await plan({
        modelId: 955,
        mediaType: 'image',
        changeType: 'new_model',
        customPoints: 10,
        mainConfig: {
          globalRouteRules: {
            image: {
              955: { max_ref_images: 0 },
            },
          },
        },
      });

      expect(planRes.testPlan?.tests.some((t) => t.id === 'boundary-refimg')).toBe(false);
    });
  });

  describe('11. 生产级四态验收判决系统 (Production Acceptance Engine)', () => {
    it('验收状态 1: ACCEPTED - 证据齐备、对账吻合、无回归漂移时输出 ACCEPTED 且 isComplete=true', async () => {
      const planRes = await plan({
        modelId: 84,
        mediaType: 'video',
        changeType: 'diversion_change',
        duration: 5,
        resolution: '720p',
      });
      const mp4Buffer = createSyntheticValidMp4({ width: 1280, height: 720, durationSeconds: 5 });

      const verifyRes = await verify({
        taskId: 88811,
        modelId: 84,
        mediaType: 'video',
        artifactBuffer: mp4Buffer,
        terminalStatus: 'SUCCESS',
        expectedPoints: 70,
        baseline: planRes.testPlan?.baseline,
        scoreLogs: [{ task_id: 88811, type: 2, score: -70, memo: '预扣' }],
        dbExtraConfirmed: true,
        gatewayChannelConfirmed: true,
      });

      expect(verifyRes.acceptance).toBe('ACCEPTED');
      expect(verifyRes.passed).toBe(true);
      expect(verifyRes.evidenceCompleteness.isComplete).toBe(true);
      expect(verifyRes.evidenceCompleteness.missingEvidence.length).toBe(0);
      expect(verifyRes.acceptanceReport.acceptance).toBe('ACCEPTED');
      expect(verifyRes.acceptanceReport.verified.length).toBe(verifyRes.evidenceCompleteness.requiredEvidence.length);
      expect(verifyRes.expectedVsActual?.regressionDiff?.regressionStatus).toBe('CLEAN');
    });

    it('验收状态 2: REJECTED - 任务失败、产物损坏或基线非预期漂移时输出 REJECTED', async () => {
      const planRes = await plan({
        modelId: 84,
        mediaType: 'video',
        changeType: 'diversion_change',
        duration: 5,
        resolution: '720p',
      });
      const mp4Buffer = createSyntheticValidMp4({ width: 1280, height: 720, durationSeconds: 5 });

      // 扣费异常漂移
      const verifyRes = await verify({
        taskId: 88812,
        modelId: 84,
        mediaType: 'video',
        artifactBuffer: mp4Buffer,
        terminalStatus: 'SUCCESS',
        expectedPoints: 120, // 预期 70，实际扣了 120
        baseline: planRes.testPlan?.baseline,
        scoreLogs: [{ task_id: 88812, type: 2, score: -120, memo: '预扣' }],
        dbExtraConfirmed: true,
        gatewayChannelConfirmed: true,
      });

      expect(verifyRes.acceptance).toBe('REJECTED');
      expect(verifyRes.passed).toBe(false);
      expect(verifyRes.acceptanceReport.acceptance).toBe('REJECTED');
      expect(verifyRes.acceptanceReport.unexpectedChanges.length).toBeGreaterThan(0);
      expect(verifyRes.expectedVsActual?.regressionDiff?.regressionStatus).toBe('REGRESSION');
    });

    it('验收状态 3: BLOCKED - 缺少核心单价（未提供刊例或使用fallback）或静态契约未验真时输出 BLOCKED', async () => {
      const planUnknown = await plan({ modelId: 999, mediaType: 'video', flowType: 'diversion' });
      expect(planUnknown.acceptanceForecast).toBe('BLOCKED');
      expect(planUnknown.missingInputs).toContain('pricing');

      const mp4Buffer = createSyntheticValidMp4({ width: 1280, height: 720, durationSeconds: 4 });
      const verifyBlocked = await verify({
        taskId: 88813,
        modelId: 999,
        mediaType: 'video',
        artifactBuffer: mp4Buffer,
        terminalStatus: 'SUCCESS',
        contract: planUnknown.contract,
      });

      expect(verifyBlocked.acceptance).toBe('BLOCKED');
      expect(verifyBlocked.acceptanceReport.acceptance).toBe('BLOCKED');
    });

    it('验收状态 4: UNVERIFIED - 区分“证据不足”与“没有问题”：未提供 DB extra 证据时不可判定 ACCEPTED', async () => {
      const planRes = await plan({
        modelId: 201,
        mediaType: 'image',
        changeType: 'diversion_change',
        customPoints: 10,
      });
      const pngBuffer = Buffer.concat([
        Buffer.from('89504e470d0a1a0a0000000d4948445200000400000004000806000000', 'hex'),
        Buffer.alloc(32),
      ]);

      // 未提供 dbExtraConfirmed
      const verifyRes = await verify({
        taskId: 88814,
        modelId: 201,
        mediaType: 'image',
        artifactBuffer: pngBuffer,
        terminalStatus: 'SUCCESS',
        expectedPoints: 10,
        scoreLogs: [{ task_id: 88814, type: 2, score: -10, memo: '预扣' }],
        // dbExtraConfirmed 未传
      });

      // 缺少 extra.diversion 真实证据时不可判定 PASS，生产验收为 UNVERIFIED
      expect(verifyRes.passed).toBe(false);
      expect(verifyRes.acceptance).toBe('UNVERIFIED');
      expect(verifyRes.evidenceCompleteness.isComplete).toBe(false);
      expect(verifyRes.evidenceCompleteness.missingEvidence.some((e) => e.includes('MANUAL_DB_EVIDENCE_REQUIRED'))).toBe(true);
      expect(verifyRes.expectedVsActual?.evidenceStatus.extraSnapshot).toBe('MANUAL_DB_EVIDENCE_REQUIRED');
      expect(verifyRes.acceptanceReport.manualEvidenceRequired.some((m) => m.includes('extra.diversion'))).toBe(true);
      expect(verifyRes.acceptanceReport.summaryText).toContain('UNVERIFIED');
    });

    it('视频两级分流：缺少 NewAPI 网关渠道证据时，阻断 ACCEPTED 并输出 UNVERIFIED', async () => {
      const planRes = await plan({
        modelId: 84,
        mediaType: 'video',
        changeType: 'diversion_change',
        duration: 5,
        resolution: '720p',
      });
      const mp4Buffer = createSyntheticValidMp4({ width: 1280, height: 720, durationSeconds: 5 });

      // 提供 dbExtraConfirmed，但未提供 gatewayChannelConfirmed
      const verifyRes = await verify({
        taskId: 88815,
        modelId: 84,
        mediaType: 'video',
        artifactBuffer: mp4Buffer,
        terminalStatus: 'SUCCESS',
        expectedPoints: 70,
        baseline: planRes.testPlan?.baseline,
        scoreLogs: [{ task_id: 88815, type: 2, score: -70, memo: '预扣' }],
        dbExtraConfirmed: true,
        gatewayChannelConfirmed: false,
      });

      expect(verifyRes.acceptance).toBe('UNVERIFIED');
      expect(verifyRes.evidenceCompleteness.isComplete).toBe(false);
      expect(verifyRes.evidenceCompleteness.missingEvidence.some((e) => e.includes('gatewayChannel'))).toBe(true);
      expect(verifyRes.expectedVsActual?.diffs.some((d) => d.field === 'gatewayChannel' && d.status === 'MANUAL_REQUIRED')).toBe(true);
    });

    it('回归比对三态语义：基线比对在证据不全时输出 regressionStatus: UNKNOWN，禁止假定 CLEAN', async () => {
      const planRes = await plan({
        modelId: 84,
        mediaType: 'video',
        changeType: 'diversion_change',
        duration: 5,
        resolution: '720p',
      });
      const mp4Buffer = createSyntheticValidMp4({ width: 1280, height: 720, durationSeconds: 5 });

      // 未提供 scoreLogs 与 dbExtraConfirmed
      const verifyRes = await verify({
        taskId: 88816,
        modelId: 84,
        mediaType: 'video',
        artifactBuffer: mp4Buffer,
        terminalStatus: 'SUCCESS',
        expectedPoints: 70,
        baseline: planRes.testPlan?.baseline,
      });

      const reg = verifyRes.expectedVsActual?.regressionDiff;
      expect(reg).toBeDefined();
      expect(reg?.isRegression).toBe(false);
      // 证据缺失，不能假定 CLEAN
      expect(reg?.regressionStatus).toBe('UNKNOWN');
      expect(reg?.missingEvidence.length).toBeGreaterThan(0);
      expect(verifyRes.acceptance).toBe('UNVERIFIED');
    });

    it('plan 阶段最小必填项校验：缺少定价或组织分流别名时产生 missingInputs 与 acceptanceForecast=BLOCKED', async () => {
      // 1. 缺少定价
      const planNoPrice = await plan({
        modelId: 988,
        mediaType: 'video',
        flowType: 'diversion',
      });
      expect(planNoPrice.acceptanceForecast).toBe('BLOCKED');
      expect(planNoPrice.missingInputs).toContain('pricing');

      // 2. 补充定价与规格后，阻断解除
      const planWithPrice = await plan({
        modelId: 988,
        mediaType: 'video',
        flowType: 'diversion',
        pointsPerSecond: 10,
        resolution: '720p',
        alias: 'custom-model-alias',
      });
      expect(planWithPrice.acceptanceForecast).toBe('UNVERIFIED');
      expect(planWithPrice.missingInputs?.length ?? 0).toBe(0);
    });
  });

  describe('11. 智能体层 (Agent Layer): 意图解析、ChangeContract 建立、最小充分测试计划与执行/验证管道', () => {
    describe('11.1 自然语言变更意图解析 (parseChangeIntent)', () => {
      it('解析新图片模型意图：提取模型ID、媒体类型、场景与单价', () => {
        const parsed = parseChangeIntent('新增图片模型 950 --price 5');
        expect(parsed.modelId).toBe(950);
        expect(parsed.mediaType).toBe('image');
        expect(parsed.changeType).toBe('new_model');
        expect(parsed.scenario).toBe('IMAGE_NEW_MODEL');
        expect(parsed.price).toBe(5);
        expect(parsed.customPoints).toBe(5);
      });

      it('解析新视频模型意图：提取模型ID、媒体类型、场景与按秒单价', () => {
        const parsed = parseChangeIntent('接入 960 视频模型 --points-per-second 7');
        expect(parsed.modelId).toBe(960);
        expect(parsed.mediaType).toBe('video');
        expect(parsed.changeType).toBe('new_model');
        expect(parsed.scenario).toBe('VIDEO_NEW_MODEL');
        expect(parsed.pointsPerSecond).toBe(7);
        expect(parsed.price).toBe(7);
      });

      it('解析已有图片模型分流变更意图', () => {
        const parsed = parseChangeIntent('给 201 增加 NewAPI 分流');
        expect(parsed.modelId).toBe(201);
        expect(parsed.mediaType).toBe('image');
        expect(parsed.changeType).toBe('diversion_change');
        expect(parsed.scenario).toBe('IMAGE_DIVERSION_CHANGE');
      });

      it('解析已有视频模型分流变更意图', () => {
        const parsed = parseChangeIntent('把 84 切到 NewAPI --points-per-second 14');
        expect(parsed.modelId).toBe(84);
        expect(parsed.mediaType).toBe('video');
        expect(parsed.changeType).toBe('diversion_change');
        expect(parsed.scenario).toBe('VIDEO_DIVERSION_CHANGE');
        expect(parsed.pointsPerSecond).toBe(14);
      });

      it('兼容纯自然语言中文词汇与数字提取', () => {
        const parsed = parseChangeIntent('上线新视频模型编号960，单价7积分每秒');
        expect(parsed.modelId).toBe(960);
        expect(parsed.mediaType).toBe('video');
        expect(parsed.changeType).toBe('new_model');
        expect(parsed.scenario).toBe('VIDEO_NEW_MODEL');
        expect(parsed.price).toBe(7);
      });
    });

    describe('11.2 ChangeContract 建立与最小充分测试计划生成', () => {
      it('场景 1: 新图片模型 (#950 Direct) — 建立契约并安全裁剪网关调度', async () => {
        const planRes = await plan({
          requirement: '接入 950 新图片模型 --price 5',
        });

        expect(planRes.changeContract).toBeDefined();
        const contract = planRes.changeContract!;
        expect(contract.scenario).toBe('IMAGE_NEW_MODEL');
        expect(contract.modelId).toBe(950);
        expect(contract.mediaType).toBe('image');
        expect(contract.routingExpectation.mode).toBe('DIRECT');
        expect(contract.pricing.allowPass).toBe(true);
        expect(contract.pricing.points).toBe(5);

        // 验证测试用例 rationale
        expect(planRes.testPlan?.tests.every((t) => t.rationale && t.rationale.whyIncluded && t.rationale.riskAddressed)).toBe(true);

        // 验证裁剪测试用例：直接接入模型跳过网关候选调度
        expect(planRes.testPlan?.skippedTests?.some((s) => s.rule.includes('免网关调度') || s.rule === 'DIRECT_NO_GATEWAY_ROUTING')).toBe(true);

        // 验证 testerActionSummary
        expect(planRes.testerActionSummary).toBeDefined();
        expect(planRes.testerActionSummary?.automatedSummary.length).toBeGreaterThan(0);
        expect(planRes.testerActionSummary?.skippedSummary.length).toBeGreaterThan(0);
        expect(planRes.testerActionSummary?.nextStep.length).toBeGreaterThan(0);
      });

      it('场景 2: 新视频模型 (#960 Direct) — 建立契约并生成时长规格矩阵与产物结构核验', async () => {
        const planRes = await plan({
          requirement: '接入 960 新视频模型 --points-per-second 7',
        });

        expect(planRes.changeContract).toBeDefined();
        const contract = planRes.changeContract!;
        expect(contract.scenario).toBe('VIDEO_NEW_MODEL');
        expect(contract.modelId).toBe(960);
        expect(contract.mediaType).toBe('video');
        expect(contract.routingExpectation.mode).toBe('DIRECT');

        // 测试包含时长规格矩阵与产物结构
        const testPurposes = planRes.testPlan?.tests.map((t) => t.purpose) ?? [];
        expect(testPurposes.some((p) => p.includes('规格') || p.includes('时长') || p.includes('分辨率'))).toBe(true);
        expect(testPurposes.some((p) => p.includes('产物') || p.includes('MP4') || p.includes('媒体'))).toBe(true);

        // 人工确认汇总包含 MP4 Box / OSS
        expect(planRes.testerActionSummary?.manualRequiredSummary.some((m) => m.includes('MP4') || m.includes('moov') || m.includes('OSS'))).toBe(true);
      });

      it('场景 3: 已有图片模型分流 (#201 NewAPI) — 保留网关候选并对全量模型免组织隔离', async () => {
        const planRes = await plan({
          requirement: '给 201 增加 NewAPI 全量分流',
        });

        expect(planRes.changeContract).toBeDefined();
        const contract = planRes.changeContract!;
        expect(contract.scenario).toBe('IMAGE_DIVERSION_CHANGE');
        expect(contract.modelId).toBe(201);
        expect(contract.mediaType).toBe('image');
        expect(contract.routingExpectation.mode).toBe('DIVERSION');

        // 网关候选测试必须保留
        const testPurposes = planRes.testPlan?.tests.map((t) => t.purpose) ?? [];
        expect(testPurposes.some((p) => p.includes('网关') || p.includes('上游') || p.includes('渠道候选'))).toBe(true);

        // 全量模型 (is_newapi_global) 免组织路由组隔离
        expect(planRes.testPlan?.skippedTests?.some((s) => s.rule.includes('全量模型免组织隔离') || s.rule === 'GLOBAL_MODEL_NO_GROUP_ISOLATION')).toBe(true);
      });

      it('场景 4: 已有视频模型分流 (#84 NewAPI) — 全链路回归、网关候选与两级分流', async () => {
        const planRes = await plan({
          requirement: '把 84 切到 NewAPI --points-per-second 14',
        });

        expect(planRes.changeContract).toBeDefined();
        const contract = planRes.changeContract!;
        expect(contract.scenario).toBe('VIDEO_DIVERSION_CHANGE');
        expect(contract.modelId).toBe(84);
        expect(contract.mediaType).toBe('video');

        // 测试用例覆盖计费、网关、产物与回归基线
        const testLayers = new Set(planRes.testPlan?.tests.map((t) => t.layer) ?? []);
        expect(testLayers.has('billing')).toBe(true);
        expect(testLayers.has('routing')).toBe(true);
        expect(testLayers.has('artifact')).toBe(true);
        expect(planRes.testPlan?.baseline).toBeDefined();
        expect(planRes.testPlan?.regressionExpectations?.length).toBeGreaterThan(0);

        // 包含查库证据模板
        expect(planRes.testerActionSummary?.manualRequiredSummary.some((m) => m.includes('SELECT') || m.includes('newapi_diversion_log'))).toBe(true);
      });
    });

    describe('11.3 参数传递闭环与 Fail-Closed 阻断机制', () => {
      it('execute: 未知新模型未提供价格时拒绝执行，阻断并返回 BLOCKED', async () => {
        const execRes = await execute({
          modelId: 995,
          mediaType: 'video',
          flow: 'direct',
        });

        expect(execRes.status).toBe('BLOCKED');
        expect(execRes.message).toContain('刊例定价未确定');
        expect(execRes.ok).toBe(false);
      });

      it('execute: 传入 price 参数后阻断解除，顺利完成测试执行', async () => {
        const execRes = await execute({
          modelId: 995,
          mediaType: 'image',
          flow: 'direct',
          price: 5,
        });

        expect(execRes.status).toBe('SUBMITTED');
        expect(execRes.ok).toBe(true);
        expect(execRes.points).toBe(5);
      });

      it('verify: 未知新模型未提供价格时拒绝验收，阻断并返回 BLOCKED', async () => {
        const verifyRes = await verify({
          taskId: 99501,
          modelId: 995,
          mediaType: 'video',
          terminalStatus: 'SUCCESS',
        });

        expect(verifyRes.acceptance).toBe('BLOCKED');
        expect(verifyRes.reasons.some((r) => r.includes('定价未确定') || r.includes('真实刊例'))).toBe(true);
        expect(verifyRes.evidenceCompleteness.isComplete).toBe(false);
      });

      it('verify: 传入 pointsPerSecond 参数后，动态精准计算预期扣费并核对账单', async () => {
        const mp4Buffer = createSyntheticValidMp4({ width: 1280, height: 720, durationSeconds: 5 });
        const verifyRes = await verify({
          taskId: 99502,
          modelId: 995,
          mediaType: 'video',
          duration: 5,
          pointsPerSecond: 7, // 预期 7 * 5 = 35 积分
          artifactBuffer: mp4Buffer,
          terminalStatus: 'SUCCESS',
          scoreLogs: [{ task_id: 99502, type: 2, score: -35, memo: '扣费' }],
          dbExtraConfirmed: true,
          gatewayChannelConfirmed: true,
        });

        expect(verifyRes.acceptance).toBe('ACCEPTED');
        expect(verifyRes.evidence.billing.expectedPoints).toBe(35);
        expect(verifyRes.evidence.billing.netDeductedPoints).toBe(35);
        expect(verifyRes.evidence.billing.status).toBe('PASS');
        const billingDiff = verifyRes.expectedVsActual?.diffs.find((d) => d.field === 'billingPoints');
        expect(billingDiff?.expected).toBe(35);
        expect(billingDiff?.actual).toBe(35);
        expect(billingDiff?.matched).toBe(true);
      });
    });

    describe('11.4 生产级测试计划价值裁剪与门禁归一化 (Test Value Pruning & Guard Consolidation)', () => {
      it('新模型接入不生成低价值自证 contract-spec，由物理产物与真实任务验真', async () => {
        const imagePlan = await plan({ modelId: 998, mediaType: 'image', changeType: 'new_model' });
        const videoPlan = await plan({ modelId: 999, mediaType: 'video', changeType: 'new_model' });

        expect(imagePlan.testPlan?.tests.some((t) => t.id === 'contract-spec')).toBe(false);
        expect(videoPlan.testPlan?.tests.some((t) => t.id === 'contract-spec')).toBe(false);
      });

      it('视频分流变更移除伪真人人脸识别测试 main-eligibility-human', async () => {
        const videoPlan = await plan({ modelId: 84, mediaType: 'video', changeType: 'diversion_change' });
        expect(videoPlan.testPlan?.tests.some((t) => t.id === 'main-eligibility-human')).toBe(false);
      });

      it('统一归一化网关准入门禁 gateway-eligibility-guard 覆盖各业务场景边界', async () => {
        // 视频新模型：提示词超长准入门禁
        const videoNew = await plan({ modelId: 999, mediaType: 'video', changeType: 'new_model' });
        const videoNewGuard = videoNew.testPlan?.tests.find((t) => t.id === 'gateway-eligibility-guard');
        expect(videoNewGuard).toBeDefined();
        expect(videoNewGuard?.layer).toBe('boundary');
        expect(videoNewGuard?.input).toHaveProperty('cuewordLength', 5001);

        // 图片分流：非标自定义像素尺寸拦截
        const imgDiv = await plan({ modelId: 201, mediaType: 'image', changeType: 'diversion_change' });
        const imgDivGuard = imgDiv.testPlan?.tests.find((t) => t.id === 'gateway-eligibility-guard');
        expect(imgDivGuard).toBeDefined();
        expect(imgDivGuard?.input).toHaveProperty('sizeType', 'pixels');

        // 视频分流：非标 MOV 格式拦截
        const videoDiv = await plan({ modelId: 84, mediaType: 'video', changeType: 'diversion_change' });
        const videoDivGuard = videoDiv.testPlan?.tests.find((t) => t.id === 'gateway-eligibility-guard');
        expect(videoDivGuard).toBeDefined();
        expect(videoDivGuard?.input).toHaveProperty('outputFormat', 'mov');
      });
    });
  });
});
