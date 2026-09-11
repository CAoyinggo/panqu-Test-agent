/**
 * Panqu Playwright 闭环测试智能体单元与集成测试套件
 *
 * 覆盖：
 * 1. 视频成功案例（Wan 3.0 文生视频）端到端闭环
 * 2. 图片成功案例（RunningHub 场景生图）端到端闭环
 * 3. 业务错误与生成失败分支（跳过产物校验、查退款、收诊断）
 * 4. 错误渠道分流（预期 NewAPI 实际走直连 -> FAIL）
 * 5. 分流证据缺失（缺少 extra 快照 -> BLOCKED，严禁 PASS）
 * 6. 无效产物与解码失败（FILE_INVALID -> FAIL）
 * 7. 计费对账异常（少扣、多扣、重复扣、重复退）
 * 8. 异步轮询超时（未达终态 -> TIMEOUT -> 不得通过）
 * 9. 敏感凭证脱敏（严防 Cookie/Token 明文泄露）
 */

import { describe, it, expect } from 'vitest';
import {
  runPanquPlaywrightFlow,
  calculateExpectedPoints,
  deriveExpectedDiversion,
  inspectBufferMedia,
  createSyntheticValidMp4,
  sanitizeObject,
  sanitizeSensitiveText,
} from '../../src/devtest/panqu-playwright-engine.js';
import {
  createPanquPlaywrightFixture,
  parseCookieString,
} from '../../src/devtest/panqu-playwright-fixture.js';
import {
  SupplierCostOracle,
  STANDARD_RECHARGE_PRESETS,
  type UpstreamCallRecord,
} from '../../src/devtest/supplier-cost-oracle.js';

// 标准合法的测试媒体 Header Buffers（含完整容器、元数据与样例轨道）
const VALID_MP4_BUFFER = createSyntheticValidMp4({ width: 1280, height: 720, durationSeconds: 4 });
const TRUNCATED_MP4_BUFFER = Buffer.from([
  0x00, 0x00, 0x00, 0x20, // size 32
  0x66, 0x74, 0x79, 0x70, // 'ftyp'
  0x69, 0x73, 0x6f, 0x6d, // 'isom'
  0x00, 0x00, 0x02, 0x00, // minor version
  0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32, 0x61, 0x76, 0x63, 0x31, 0x6d, 0x70, 0x34, 0x31,
]);

const VALID_PNG_BUFFER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG Signature
  0x00, 0x00, 0x00, 0x0d, // IHDR length
  0x49, 0x48, 0x44, 0x52, // 'IHDR'
  0x00, 0x00, 0x04, 0x00, // width = 1024
  0x00, 0x00, 0x04, 0x00, // height = 1024
  0x08, 0x06, 0x00, 0x00, 0x00, // bit depth, color type, compression, filter, interlace
  0x00, 0x00, 0x00, 0x00, // CRC
]);

const CORRUPT_BUFFER = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]);

describe('Panqu Playwright 闭环测试智能体', () => {
  describe('一、确定性计费与分流推导规则', () => {
    it('独立计算各模型刊例价与时长计费（10积分=1元）', () => {
      // Wan 3.0: 7 pts/s * 4s = 28 pts
      expect(calculateExpectedPoints({ mediaType: 'video', modelId: 84, duration: 4 })).toBe(28);

      // Wan 3.0 Prime 480p: 11 pts/s * 4s = 44 pts
      expect(calculateExpectedPoints({ mediaType: 'video', modelId: 88, duration: 4, resolution: '480p' })).toBe(44);

      // Wan 3.0 Prime 720p: 22 pts/s * 4s = 88 pts
      expect(calculateExpectedPoints({ mediaType: 'video', modelId: 88, duration: 4, resolution: '720p' })).toBe(88);

      // TalkingData Seedance 480p: 15 pts/s * 4s = 60 pts
      expect(calculateExpectedPoints({ mediaType: 'video', modelId: 15, duration: 4, resolution: '480p' })).toBe(60);

      // Image 生成标准刊例价 = 5 pts
      expect(calculateExpectedPoints({ mediaType: 'image', modelId: 201 })).toBe(5);
    });

    it('独立推导预期分流渠道与模型别名', () => {
      // 视频 Wan 3.0
      const wan3Diversion = deriveExpectedDiversion({ mediaType: 'video', modelId: 84 });
      expect(wan3Diversion.expectedNewApi).toBe(true);
      expect(wan3Diversion.expectedModelAlias).toBe('wan3.0-video');

      // 视频 Wan 3.0 Prime
      const primeDiversion = deriveExpectedDiversion({ mediaType: 'video', modelId: 88 });
      expect(primeDiversion.expectedNewApi).toBe(true);
      expect(primeDiversion.expectedModelAlias).toBe('wan3.0-video-prime');

      // 视频 TalkingData
      const tdDiversion = deriveExpectedDiversion({ mediaType: 'video', modelId: 15 });
      expect(tdDiversion.expectedNewApi).toBe(true);
      expect(tdDiversion.expectedModelAlias).toBe('seedance-2.0');

      // 图片 (serviceline=r 命中分流)
      const imgDiversion = deriveExpectedDiversion({ mediaType: 'image', modelId: 201, serviceline: 'r' });
      expect(imgDiversion.expectedNewApi).toBe(true);
      expect(imgDiversion.expectedModelAlias).toBe('runninghub-nano-banana-2');

      // 图片 (serviceline!=r 走直连)
      const imgDirect = deriveExpectedDiversion({ mediaType: 'image', modelId: 201, serviceline: 't' });
      expect(imgDirect.expectedNewApi).toBe(false);
    });

    it('媒体 Buffer 物理可解码性校验', () => {
      const mp4Check = inspectBufferMedia(VALID_MP4_BUFFER, 'video');
      expect(mp4Check.decodable).toBe(true);
      expect(mp4Check.format).toContain('mp4');

      const pngCheck = inspectBufferMedia(VALID_PNG_BUFFER, 'image');
      expect(pngCheck.decodable).toBe(true);
      expect(pngCheck.format).toBe('png');
      expect(pngCheck.dimensions).toEqual({ width: 1024, height: 1024 });

      const corruptCheck = inspectBufferMedia(CORRUPT_BUFFER, 'video');
      expect(corruptCheck.decodable).toBe(false);
      expect(corruptCheck.reasons.length).toBeGreaterThan(0);
    });
  });

  describe('二、端到端全链路场景（正向、负向与异常分支）', () => {
    it('用例 1：Wan 3.0 视频正向成功全链路（提交 → 任务完成 → 分流核查 → 产物解码 → 账单对账 → PASS）', async () => {
      const result = await runPanquPlaywrightFlow({
        caseId: 'TC-VIDEO-WAN3-SUCCESS',
        mediaType: 'video',
        modelId: 84,
        duration: 4,
        resolution: '480p',
        mockSubmitResponse: {
          status: 200,
          body: { code: 1, msg: 'ok', data: { id: 18001 } },
        },
        mockStatusResponses: [
          { status: 200, body: { task_status: 1, progress: 30 } },
          { status: 200, body: { task_status: 2, progress: 100, video_url: 'https://v.panqu.com.cn/video/sample.mp4' } },
        ],
        mockTaskDetails: {
          id: 18001,
          video_url: 'https://v.panqu.com.cn/video/sample.mp4',
          extra: {
            diversion: 10,
            newapi_model: 'wan3.0-video',
            newapi_org_id: 0,
            newapi_group: '',
            points: 28,
            channel_name: '万相—yhuo',
          },
        },
        mockAssetBuffer: VALID_MP4_BUFFER,
        mockScoreLogs: [
          { type: 'PRE_DEDUCT', points: 28 },
          { type: 'SETTLE', points: 28 },
        ],
      });

      // 校验提交
      expect(result.submission.responseCode).toBe(1);
      expect(result.taskId).toBe(18001);

      // 校验状态机
      expect(result.taskTracking.terminalStatus).toBe('SUCCESS');
      expect(result.taskTracking.pollCount).toBe(2);

      // 校验分流
      expect(result.diversion.passed).toBe(true);
      expect(result.diversion.isDiverted).toBe(true);
      expect(result.diversion.evidenceState).toBe('VERIFIED');
      expect(result.diversion.newapiModel).toBe('wan3.0-video');

      // 校验产物
      expect(result.artifact.passed).toBe(true);
      expect(result.artifact.decodable).toBe(true);
      expect(result.artifact.qualityClassification).toBe('TASK_SUCCESS_AND_VALID');

      // 校验账单对账
      expect(result.billing.passed).toBe(true);
      expect(result.billing.expectedPoints).toBe(28);
      expect(result.billing.netDeductedPoints).toBe(28);
      expect(result.billing.underCharged).toBe(false);
      expect(result.billing.overCharged).toBe(false);

      // 整体状态判定
      expect(result.overallStatus).toBe('PASS');
    });

    it('用例 2：RunningHub 图片正向成功全链路（提交 → 轮询成功 → 分流核查 → PNG解码 → 账单对账 → PASS）', async () => {
      const result = await runPanquPlaywrightFlow({
        caseId: 'TC-IMAGE-RUNNINGHUB-SUCCESS',
        mediaType: 'image',
        modelId: 201,
        serviceline: 'r',
        mockSubmitResponse: {
          status: 200,
          body: { code: 1, msg: 'ok', data: { id: 18002 } },
        },
        mockStatusResponses: [
          { status: 200, body: { task_status: 1, progress: 50 } },
          { status: 200, body: { task_status: 2, progress: 100, pic_url: 'https://v.panqu.com.cn/image/sample.png' } },
        ],
        mockTaskDetails: {
          id: 18002,
          pic_url: 'https://v.panqu.com.cn/image/sample.png',
          extra: {
            newapi_image: 1,
            newapi_model: 'runninghub-nano-banana-2',
            newapi_org_id: 10,
            newapi_group: 'panqu_test',
          },
        },
        mockAssetBuffer: VALID_PNG_BUFFER,
        mockScoreLogs: [
          { type: 'PRE_DEDUCT', points: 5 },
          { type: 'SETTLE', points: 5 },
        ],
      });

      expect(result.taskId).toBe(18002);
      expect(result.diversion.passed).toBe(true);
      expect(result.diversion.isDiverted).toBe(true);
      expect(result.artifact.passed).toBe(true);
      expect(result.artifact.format).toBe('png');
      expect(result.artifact.dimensions).toEqual({ width: 1024, height: 1024 });
      expect(result.billing.passed).toBe(true);
      expect(result.billing.netDeductedPoints).toBe(5);
      expect(result.overallStatus).toBe('PASS');
    });

    it('用例 3：业务生成失败与退款闭环（跳过产物校验 → 校验失败原因 → 核查积分全额退回）', async () => {
      const result = await runPanquPlaywrightFlow({
        caseId: 'TC-FAILURE-REFUND-BRANCH',
        mediaType: 'video',
        modelId: 84,
        expectFailure: true,
        mockSubmitResponse: {
          status: 200,
          body: { code: 1, msg: 'ok', data: { id: 18003 } },
        },
        mockStatusResponses: [
          { status: 200, body: { task_status: 1, progress: 20 } },
          { status: 200, body: { task_status: 3, progress: 0, err: 'UPSTREAM_SAFETY_FILTER_REJECTED' } },
        ],
        mockTaskDetails: {
          id: 18003,
          extra: { diversion: 10, newapi_model: 'wan3.0-video', newapi_org_id: 0, newapi_group: '' },
        },
        // 关键断言：失败任务在账单流水中有预扣，且必须有对应的全额 REFUND
        mockScoreLogs: [
          { type: 'PRE_DEDUCT', points: 28 },
          { type: 'REFUND', points: 28 },
        ],
      });

      expect(result.taskTracking.terminalStatus).toBe('FAILED');
      expect(result.taskTracking.failureCategory).toBe('PRODUCT_FAILURE');

      // 产物校验应该优雅跳过，而不是爆出 404 或解码错误
      expect(result.artifact.skipped).toBe(true);
      expect(result.artifact.qualityClassification).toBe('TASK_FAILED_SKIPPED');

      // 对账应该确认净扣除为 0
      expect(result.billing.passed).toBe(true);
      expect(result.billing.netDeductedPoints).toBe(0);
      expect(result.billing.refundedPoints).toBe(28);

      // 预期失败用例成功闭环
      expect(result.overallStatus).toBe('PASS');
    });

    it('用例 4：错误渠道分流识别（预期 NewAPI 分流，实际走直连 -> FAIL）', async () => {
      const result = await runPanquPlaywrightFlow({
        caseId: 'TC-WRONG-CHANNEL-DIVERSION',
        mediaType: 'video',
        modelId: 84, // 预期命中 NewAPI (diversion=10)
        mockSubmitResponse: {
          status: 200,
          body: { code: 1, msg: 'ok', data: { id: 18004 } },
        },
        mockStatusResponses: [
          { status: 200, body: { task_status: 2, progress: 100 } },
        ],
        mockTaskDetails: {
          id: 18004,
          extra: {
            // 异常分流：diversion=0（未分流走直连）
            diversion: 0,
            newapi_model: '',
          },
        },
        mockAssetBuffer: VALID_MP4_BUFFER,
      });

      expect(result.diversion.passed).toBe(false);
      expect(result.diversion.status).toBe('FAIL');
      expect(result.diversion.evidenceState).toBe('MISMATCH');
      expect(result.overallStatus).toBe('FAIL');
    });

    it('用例 5：分流证据缺失时标记 BLOCKED（未验证证据严禁报告 PASS）', async () => {
      const result = await runPanquPlaywrightFlow({
        caseId: 'TC-MISSING-DIVERSION-EVIDENCE',
        mediaType: 'video',
        modelId: 84,
        mockSubmitResponse: {
          status: 200,
          body: { code: 1, msg: 'ok', data: { id: 18005 } },
        },
        mockStatusResponses: [
          { status: 200, body: { task_status: 2, progress: 100 } },
        ],
        mockTaskDetails: {
          id: 18005,
          // extra 为空，证据缺失
          extra: {},
        },
        mockAssetBuffer: VALID_MP4_BUFFER,
      });

      expect(result.diversion.passed).toBe(false);
      expect(result.diversion.status).toBe('BLOCKED');
      expect(result.diversion.evidenceState).toBe('UNVERIFIED');
      expect(result.overallStatus).toBe('BLOCKED');
    });

    it('用例 6：无效产物识别（任务报告完成但产物字节损坏不可解码 -> FAIL）', async () => {
      const result = await runPanquPlaywrightFlow({
        caseId: 'TC-CORRUPT-ARTIFACT-FAILURE',
        mediaType: 'video',
        modelId: 84,
        mockSubmitResponse: {
          status: 200,
          body: { code: 1, msg: 'ok', data: { id: 18006 } },
        },
        mockStatusResponses: [
          { status: 200, body: { task_status: 2, progress: 100 } },
        ],
        mockTaskDetails: {
          id: 18006,
          extra: { diversion: 10, newapi_model: 'wan3.0-video' },
        },
        mockAssetBuffer: CORRUPT_BUFFER, // 损坏的非 MP4 字节流
      });

      expect(result.artifact.passed).toBe(false);
      expect(result.artifact.decodable).toBe(false);
      expect(result.artifact.qualityClassification).toBe('FILE_INVALID');
      expect(result.overallStatus).toBe('FAIL');
    });

    it('用例 7：计费对账多扣、少扣与重复扣费精准排查', async () => {
      // 场景 A：少扣费（预期 28，实际只扣了 14）
      const underChargeResult = await runPanquPlaywrightFlow({
        caseId: 'TC-BILLING-UNDERCHARGE',
        mediaType: 'video',
        modelId: 84,
        duration: 4,
        resolution: '480p',
        mockSubmitResponse: { status: 200, body: { code: 1, data: { id: 18007 } } },
        mockStatusResponses: [{ status: 200, body: { task_status: 2 } }],
        mockTaskDetails: { id: 18007, extra: { diversion: 10 } },
        mockAssetBuffer: VALID_MP4_BUFFER,
        mockScoreLogs: [{ type: 'PRE_DEDUCT', points: 14 }],
      });
      expect(underChargeResult.billing.passed).toBe(false);
      expect(underChargeResult.billing.underCharged).toBe(true);

      // 场景 B：多扣费（预期 28，实际扣了 35）
      const overChargeResult = await runPanquPlaywrightFlow({
        caseId: 'TC-BILLING-OVERCHARGE',
        mediaType: 'video',
        modelId: 84,
        duration: 4,
        resolution: '480p',
        mockSubmitResponse: { status: 200, body: { code: 1, data: { id: 18008 } } },
        mockStatusResponses: [{ status: 200, body: { task_status: 2 } }],
        mockTaskDetails: { id: 18008, extra: { diversion: 10 } },
        mockAssetBuffer: VALID_MP4_BUFFER,
        mockScoreLogs: [{ type: 'PRE_DEDUCT', points: 35 }],
      });
      expect(overChargeResult.billing.passed).toBe(false);
      expect(overChargeResult.billing.overCharged).toBe(true);

      // 场景 C：重复扣费（2 条预扣记录）
      const duplicateChargeResult = await runPanquPlaywrightFlow({
        caseId: 'TC-BILLING-DUPLICATE-CHARGE',
        mediaType: 'video',
        modelId: 84,
        mockSubmitResponse: { status: 200, body: { code: 1, data: { id: 18009 } } },
        mockStatusResponses: [{ status: 200, body: { task_status: 2 } }],
        mockTaskDetails: { id: 18009, extra: { diversion: 10 } },
        mockAssetBuffer: VALID_MP4_BUFFER,
        mockScoreLogs: [
          { type: 'PRE_DEDUCT', points: 28 },
          { type: 'PRE_DEDUCT', points: 28 },
        ],
      });
      expect(duplicateChargeResult.billing.passed).toBe(false);
      expect(duplicateChargeResult.billing.duplicateCharged).toBe(true);

      // 场景 D：失败未退费（实扣 28 未退还）
      const unrefundedResult = await runPanquPlaywrightFlow({
        caseId: 'TC-BILLING-UNREFUNDED',
        mediaType: 'video',
        modelId: 84,
        expectFailure: true,
        mockSubmitResponse: { status: 200, body: { code: 1, data: { id: 18010 } } },
        mockStatusResponses: [{ status: 200, body: { task_status: 3 } }],
        mockTaskDetails: { id: 18010, extra: { diversion: 10 } },
        mockScoreLogs: [
          { type: 'PRE_DEDUCT', points: 28 }, // 仅扣未退
        ],
      });
      expect(unrefundedResult.billing.passed).toBe(false);
      expect(unrefundedResult.overallStatus).toBe('FAIL');
    });

    it('用例 8：异步轮询超时判定（超时未达终态不得算通过）', async () => {
      const result = await runPanquPlaywrightFlow({
        caseId: 'TC-POLL-TIMEOUT',
        mediaType: 'video',
        modelId: 84,
        mockSubmitResponse: {
          status: 200,
          body: { code: 1, msg: 'ok', data: { id: 18011 } },
        },
        // 模拟一直停留在生成中 (status 1)
        mockStatusResponses: [
          { status: 200, body: { task_status: 1, progress: 10 } },
          { status: 200, body: { task_status: 1, progress: 30 } },
          { status: 200, body: { task_status: 1, progress: 40 } },
        ],
        mockTaskDetails: { id: 18011, extra: { diversion: 10 } },
      });

      // 在提供的响应走完且未达终态时，由于 mock 结束，terminalStatus 为 UNKNOWN 或 TIMEOUT
      expect(result.taskTracking.terminalStatus).not.toBe('SUCCESS');
      expect(result.overallStatus).not.toBe('PASS');
    });

    it('用例 10：Playwright Fixture 统一生命周期与请求上下文', async () => {
      const fixture = await createPanquPlaywrightFixture({
        browserType: 'auto',
        headless: true,
        recordTrace: true,
      });
      expect(fixture.request).toBeDefined();

      if (fixture.isHeadlessBrowserAvailable && fixture.page) {
        await fixture.page.setContent('<html><body><button id="test-btn">提交</button></body></html>');
        const btn = fixture.page.locator('#test-btn');
        expect(await btn.isVisible()).toBe(true);
        await btn.click();
      }

      await fixture.dispose();
      if (fixture.isHeadlessBrowserAvailable) {
        expect(fixture.tracePath?.endsWith('.zip')).toBe(true);
      }
    });
  });

  describe('三、平台侧供应商成本核算与毛利模型独立审计 (SupplierCostOracle)', () => {
    it('独立核算 Wan 3.0 视频各分辨率上游成本（万相 Line 10）', () => {
      // 480P: 4s * 0.18 = 0.72 CNY
      const c480 = SupplierCostOracle.calculateExpectedCost({
        mediaType: 'video',
        modelId: 84,
        duration: 4,
        resolution: '480p',
      });
      expect(c480.expectedCostCny).toBe(0.72);
      expect(c480.unitCostCny).toBe(0.18);
      expect(c480.channelCode).toBe('WX');

      // 720P: 4s * 0.36 = 1.44 CNY
      const c720 = SupplierCostOracle.calculateExpectedCost({
        mediaType: 'video',
        modelId: 84,
        duration: 4,
        resolution: '720p',
      });
      expect(c720.expectedCostCny).toBe(1.44);

      // 1080P: 4s * 0.72 = 2.88 CNY
      const c1080 = SupplierCostOracle.calculateExpectedCost({
        mediaType: 'video',
        modelId: 84,
        duration: 4,
        resolution: '1080p',
      });
      expect(c1080.expectedCostCny).toBe(2.88);
    });

    it('独立核算 Wan 3.0 Prime 高规格视频成本', () => {
      // Prime 480P: 4s * 0.315 = 1.26 CNY
      const p480 = SupplierCostOracle.calculateExpectedCost({
        mediaType: 'video',
        modelId: 88,
        duration: 4,
        resolution: '480p',
      });
      expect(p480.expectedCostCny).toBe(1.26);

      // Prime 720P: 4s * 0.63 = 2.52 CNY
      const p720 = SupplierCostOracle.calculateExpectedCost({
        mediaType: 'video',
        modelId: 88,
        duration: 4,
        resolution: '720p',
      });
      expect(p720.expectedCostCny).toBe(2.52);
    });

    it('独立核算 TalkingData Seedance 系列成本（火山基准折算）', () => {
      // Seedance 2.0 480P: 4s * 0.3696 = 1.4784 CNY
      const td480 = SupplierCostOracle.calculateExpectedCost({
        mediaType: 'video',
        modelId: 15,
        duration: 4,
        resolution: '480p',
      });
      expect(td480.expectedCostCny).toBe(1.4784);
      expect(td480.channelCode).toBe('TD');

      // Seedance 2.0 720P: 4s * 0.7952 = 3.1808 CNY
      const td720 = SupplierCostOracle.calculateExpectedCost({
        mediaType: 'video',
        modelId: 15,
        duration: 4,
        resolution: '720p',
      });
      expect(td720.expectedCostCny).toBe(3.1808);
    });

    it('独立核算 RunningHub 图片生成成本（按张计费）', () => {
      // RunningHub Nano Banana 2: 0.08 CNY/张
      const rhBanana = SupplierCostOracle.calculateExpectedCost({
        mediaType: 'image',
        modelId: 201,
      });
      expect(rhBanana.expectedCostCny).toBe(0.08);
      expect(rhBanana.unitCostCny).toBe(0.08);
      expect(rhBanana.unit).toBe('yuan_per_image');
      expect(rhBanana.channelCode).toBe('RH');

      // RunningHub Standard: 0.05 CNY/张
      const rhStd = SupplierCostOracle.calculateExpectedCost({
        mediaType: 'image',
        modelId: 12,
      });
      expect(rhStd.expectedCostCny).toBe(0.05);
    });

    it('任务生成失败时严格区分上游执行状态与真实成本（拒绝归零 vs 失败计费 vs 未知阻塞）', () => {
      // 场景 A: 上游前置拦截或排队未执行 -> 成本严格归零
      const rejectedCost = SupplierCostOracle.audit({
        mediaType: 'video',
        modelId: 84,
        duration: 4,
        resolution: '480p',
        userPointsPaid: 0,
        terminalStatus: 'FAILED',
        upstreamExecutionState: 'REJECTED_BEFORE_EXECUTION',
      });
      expect(rejectedCost.expectedCostCny).toBe(0);
      expect(rejectedCost.isSuccessCharged).toBe(false);
      expect(rejectedCost.pricingBasis).toContain('成本归零');
      expect(rejectedCost.status).toBe('PASS');

      // 场景 B: 上游已执行 GPU 计算但任务中途失败（上游依然计费扣款）
      const failedCharged = SupplierCostOracle.audit({
        mediaType: 'video',
        modelId: 84,
        duration: 4,
        resolution: '480p',
        userPointsPaid: 0, // 用户已退款，净扣 0
        terminalStatus: 'FAILED',
        upstreamExecutionState: 'EXECUTED_FAILED',
        rechargeBatch: STANDARD_RECHARGE_PRESETS['100_TIER'],
      });
      expect(failedCharged.expectedCostCny).toBe(0.72); // 依然产生 ¥0.72 成本
      expect(failedCharged.userRevenueCny).toBe(0);
      expect(failedCharged.estimatedGrossProfitCny).toBe(-0.72); // 负毛利 -0.72 元
      expect(failedCharged.estimatedGrossMarginPercent).toBeUndefined();
      expect(failedCharged.grossMarginLabel).toContain('N/A'); // 零收入不计算除零百分比，标记 N/A

      // 场景 C: 上游执行证据缺失 -> 标记 UNKNOWN
      const unknownCost = SupplierCostOracle.audit({
        mediaType: 'video',
        modelId: 84,
        duration: 4,
        resolution: '480p',
        userPointsPaid: 0,
        terminalStatus: 'FAILED',
        upstreamExecutionState: 'UNKNOWN',
        requireVerifiedCostEvidence: true,
      });
      expect(unknownCost.status).toBe('BLOCKED');
      expect(unknownCost.evidenceLevel).toBe('UNVERIFIED');
      expect(unknownCost.reasons.some((r) => r.includes('缺少明确凭证') || r.includes('未知记录'))).toBe(true);
    });

    it('准确核算平台用户收费与供应商成本之间的毛利额与毛利率（梯级充值赠送与兜底估算）', () => {
      // 场景 A: 充值 100 元档位（无赠送，100元 / 1000积分 = 0.1000 元/积分）
      const auditTier100 = SupplierCostOracle.audit({
        mediaType: 'video',
        modelId: 84,
        duration: 4,
        resolution: '480p',
        userPointsPaid: 28,
        terminalStatus: 'SUCCESS',
        rechargeBatch: STANDARD_RECHARGE_PRESETS['100_TIER'],
      });
      expect(auditTier100.effectiveCnyPerPoint).toBe(0.1);
      expect(auditTier100.userRevenueCny).toBe(2.8);
      expect(auditTier100.expectedCostCny).toBe(0.72);
      expect(auditTier100.estimatedGrossProfitCny).toBe(2.08);
      expect(auditTier100.estimatedGrossMarginPercent).toBe(74.29);
      expect(auditTier100.grossMarginLabel).toBe('74.29%');

      // 场景 B: 充值 300 元档位（赠送 300 积分，300元 / 3300积分 ≈ 0.090909 元/积分）
      const auditTier300 = SupplierCostOracle.audit({
        mediaType: 'video',
        modelId: 84,
        duration: 4,
        resolution: '480p',
        userPointsPaid: 28,
        terminalStatus: 'SUCCESS',
        rechargeBatch: STANDARD_RECHARGE_PRESETS['300_TIER'],
      });
      expect(auditTier300.userRevenueCny).toBe(2.5455);
      expect(auditTier300.expectedCostCny).toBe(0.72);
      expect(auditTier300.estimatedGrossProfitCny).toBe(1.8255);
      expect(auditTier300.estimatedGrossMarginPercent).toBe(71.71);

      // 场景 C: 充值 1000 元档位（赠送 5000 积分，1000元 / 15000积分 ≈ 0.066667 元/积分）
      const auditTier1000 = SupplierCostOracle.audit({
        mediaType: 'video',
        modelId: 84,
        duration: 4,
        resolution: '480p',
        userPointsPaid: 28,
        terminalStatus: 'SUCCESS',
        rechargeBatch: STANDARD_RECHARGE_PRESETS['1000_TIER'],
      });
      expect(auditTier1000.userRevenueCny).toBe(1.8667);
      expect(auditTier1000.expectedCostCny).toBe(0.72);
      expect(auditTier1000.estimatedGrossProfitCny).toBe(1.1467);
      expect(auditTier1000.estimatedGrossMarginPercent).toBe(61.43);

      // 场景 D: 积分来源不详，使用平台兜底估算（~30积分/元，严禁假设 10积分=1元）
      const auditFallback = SupplierCostOracle.audit({
        mediaType: 'video',
        modelId: 84,
        duration: 4,
        resolution: '480p',
        userPointsPaid: 28,
        terminalStatus: 'SUCCESS',
      });
      expect(auditFallback.revenueCalculationBasis).toContain('ESTIMATED_FALLBACK_30_PTS_PER_CNY');
      expect(auditFallback.userRevenueCny).toBe(0.9333);
      expect(auditFallback.expectedCostCny).toBe(0.72);
      expect(auditFallback.estimatedGrossProfitCny).toBe(0.2133);
      expect(auditFallback.estimatedGrossMarginPercent).toBe(22.85);

      // 场景 E: RunningHub 生图（5 积分，兜底估算）
      const auditImage = SupplierCostOracle.audit({
        mediaType: 'image',
        modelId: 201,
        userPointsPaid: 5,
        terminalStatus: 'SUCCESS',
        rechargeBatch: STANDARD_RECHARGE_PRESETS['100_TIER'],
      });
      expect(auditImage.userRevenueCny).toBe(0.5);
      expect(auditImage.expectedCostCny).toBe(0.08);
      expect(auditImage.estimatedGrossProfitCny).toBe(0.42);
      expect(auditImage.estimatedGrossMarginPercent).toBe(84);
    });

    it('支持任务多上游调用（重试/降级）成本累加', () => {
      const calls: UpstreamCallRecord[] = [
        {
          channelName: 'NewAPI Line 10',
          modelName: 'seedance-2.0',
          executionState: 'REJECTED_BEFORE_EXECUTION',
          billed: false,
          costCny: 0,
        },
        {
          channelName: '火山引擎 Direct',
          modelName: 'cgt-20260909201050-5m8gg',
          executionState: 'EXECUTED_SUCCESS',
          billed: true,
          costCny: 1.2,
        },
      ];

      const multiCallAudit = SupplierCostOracle.audit({
        mediaType: 'video',
        modelId: 15,
        duration: 4,
        resolution: '480p',
        userPointsPaid: 60,
        terminalStatus: 'SUCCESS',
        upstreamCalls: calls,
        rechargeBatch: STANDARD_RECHARGE_PRESETS['100_TIER'],
      });

      expect(multiCallAudit.expectedCostCny).toBe(1.2);
      expect(multiCallAudit.upstreamCalls?.length).toBe(2);
      expect(multiCallAudit.userRevenueCny).toBe(6.0);
      expect(multiCallAudit.estimatedGrossProfitCny).toBe(4.8);
      expect(multiCallAudit.estimatedGrossMarginPercent).toBe(80.0);
    });

    it('外部供应商账单核对与偏差排查', () => {
      // 场景 A: 外部实账与内部预期一致
      const matched = SupplierCostOracle.audit({
        mediaType: 'video',
        modelId: 84,
        duration: 4,
        resolution: '480p',
        userPointsPaid: 28,
        terminalStatus: 'SUCCESS',
        upstreamBillReceived: true,
        actualRecordedCostCny: 0.72,
      });
      expect(matched.evidenceLevel).toBe('BILL_RECONCILED');
      expect(matched.passed).toBe(true);

      // 场景 B: 外部实账偏差过大（异常差额报警）
      const deviated = SupplierCostOracle.audit({
        mediaType: 'video',
        modelId: 84,
        duration: 4,
        resolution: '480p',
        userPointsPaid: 28,
        terminalStatus: 'SUCCESS',
        upstreamBillReceived: true,
        actualRecordedCostCny: 0.99, // 偏高
      });
      expect(deviated.evidenceLevel).toBe('BILL_RECONCILED');
      expect(deviated.passed).toBe(false);
      expect(deviated.reasons.some((r) => r.includes('供应商成本账单偏差'))).toBe(true);
    });
  });

  describe('四、深层敏感信息脱敏与执行模式解耦保障 (Security & Decoupling)', () => {
    it('文本与对象多层嵌套深度脱敏（Cookie、Token、JWT、Secret、FastAdmin凭证）', () => {
      // 文本脱敏
      const rawText = 'Headers: Cookie: fastadmin_sid=abcdef123456; PHPSESSID=s987654321; Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-ID';
      const sanitized = sanitizeSensitiveText(rawText);
      expect(sanitized).not.toContain('abcdef123456');
      expect(sanitized).not.toContain('s987654321');
      expect(sanitized).toContain('[REDACTED_COOKIE]');

      // 深层嵌套对象脱敏
      const nestedPayload = {
        task_id: 12345,
        credentials: {
          token: 'sk-secret-token-12345678',
          apiKey: 'test-only', // 合成占位值；验证按字段名脱敏，不使用仿真真实密钥
          fastadmin_sid: 'sid-99999',
          cookie_string: 'fastadmin_sid=sid-99999; token=secret',
        },
        items: [
          { auth_header: 'Bearer eyJhbGciOiJIUzI1NiJ9.test', password: 'my-super-secret-password' },
        ],
      };

      const safeObj = sanitizeObject(nestedPayload);
      expect(safeObj.credentials.token).toBe('[REDACTED_SECRET]');
      expect(safeObj.credentials.apiKey).toBe('[REDACTED_SECRET]');
      expect(safeObj.credentials.fastadmin_sid).toBe('[REDACTED_SECRET]');
      expect(safeObj.credentials.cookie_string).not.toContain('sid-99999');
      expect(safeObj.items[0].password).toBe('[REDACTED_SECRET]');
      expect(safeObj.items[0].auth_header).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    });

    it('业务任务终态与测试断言判定正交解耦', async () => {
      // 任务业务失败，但测试完整捕获了退款与错误码 -> 业务终态 FAILED，测试断言 PASS
      const flowRes = await runPanquPlaywrightFlow({
        caseId: 'TC-DECOUPLED-FAILURE',
        mediaType: 'video',
        modelId: 84,
        expectFailure: true,
        mockSubmitResponse: { status: 200, body: { code: 1, data: { id: 19001 } } },
        mockStatusResponses: [{ status: 200, body: { task_status: 3, err: 'SAFETY_VIOLATION' } }],
        mockTaskDetails: { id: 19001, extra: { diversion: 10, newapi_model: 'wan3.0-video' } },
        mockScoreLogs: [
          { type: 'PRE_DEDUCT', points: 28 },
          { type: 'REFUND', points: 28 },
        ],
      });

      expect(flowRes.businessTaskStatus).toBe('FAILED');
      expect(flowRes.testAssertionStatus).toBe('PASS');
      expect(flowRes.artifact.verificationLevel).toBe('SKIPPED_ON_FAILURE');
      expect(flowRes.supplierCost.expectedCostCny).toBe(0);
    });

    it('供应商成本核算偏差导致 status=FAIL 时严格阻断全链路测试 PASS 门禁', async () => {
      // 业务任务正常成功、分流正常、产物正常、对账正常，但外部供应商成本账单发生严重偏差（预期0.72，账单9.99）
      const flowRes = await runPanquPlaywrightFlow({
        caseId: 'TC-COST-GATE-FAIL',
        mediaType: 'video',
        modelId: 84,
        duration: 4,
        resolution: '480p',
        mockSubmitResponse: { status: 200, body: { code: 1, data: { id: 19002 } } },
        mockStatusResponses: [{ status: 200, body: { task_status: 2 } }],
        mockTaskDetails: { id: 19002, extra: { diversion: 10, newapi_model: 'wan3.0-video' } },
        mockAssetBuffer: VALID_MP4_BUFFER,
        mockScoreLogs: [
          { type: 'PRE_DEDUCT', points: 28 },
          { type: 'SETTLE', points: 28 },
        ],
        upstreamBillReceived: true,
        mockRecordedCostCny: 9.99, // 账单严重偏差
      });

      expect(flowRes.businessTaskStatus).toBe('SUCCESS');
      expect(flowRes.billing.passed).toBe(true);
      expect(flowRes.artifact.passed).toBe(true);
      expect(flowRes.supplierCost.passed).toBe(false);
      expect(flowRes.supplierCost.status).toBe('FAIL');
      // 核心门禁验证：整体测试断言必须为 FAIL，绝不可因业务成功而判定 PASS
      expect(flowRes.testAssertionStatus).toBe('FAIL');
      expect(flowRes.overallStatus).toBe('FAIL');
    });

    it('上游执行证据缺失且开启严格凭证核验时整体断言标记 BLOCKED', async () => {
      const flowRes = await runPanquPlaywrightFlow({
        caseId: 'TC-COST-GATE-BLOCKED',
        mediaType: 'video',
        modelId: 84,
        duration: 4,
        resolution: '480p',
        mockSubmitResponse: { status: 200, body: { code: 1, data: { id: 19003 } } },
        mockStatusResponses: [{ status: 200, body: { task_status: 3, err: 'UNKNOWN_FAILURE' } }],
        mockTaskDetails: { id: 19003, extra: { diversion: 10, newapi_model: 'wan3.0-video' } },
        mockScoreLogs: [
          { type: 'PRE_DEDUCT', points: 28 },
          { type: 'REFUND', points: 28 },
        ],
        expectFailure: true,
        upstreamExecutionState: 'UNKNOWN',
        requireVerifiedCostEvidence: true,
      });

      expect(flowRes.businessTaskStatus).toBe('FAILED');
      expect(flowRes.supplierCost.status).toBe('BLOCKED');
      expect(flowRes.testAssertionStatus).toBe('BLOCKED');
      expect(flowRes.overallStatus).toBe('BLOCKED');
    });
  });
});
