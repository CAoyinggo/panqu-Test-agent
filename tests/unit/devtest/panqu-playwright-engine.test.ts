import { describe, expect, it } from 'vitest';
import { runPanquPlaywrightFlow, createSyntheticValidMp4 } from '../../../src/devtest/panqu-playwright-engine.js';

describe('Panqu Playwright Flow Engine - 全链路闭环与质量门禁', () => {
  // 合法 MP4 ISO-BMFF 容器模拟 (含 ftyp, moov, mvhd, trak, tkhd, mdat)
  const validMp4Buffer = createSyntheticValidMp4({ width: 854, height: 480, durationSeconds: 4 });
  // 合法 PNG 魔数头模拟 (8 字节 89504e470d0a1a0a + IHDR 宽 1024 高 1024)
  const validPngBuffer = Buffer.concat([
    Buffer.from('89504e470d0a1a0a0000000d4948445200000400000004000806000000', 'hex'),
    Buffer.alloc(32),
  ]);

  describe('成功样板闭环验证', () => {
    it('样板 1：Wan 3.0 视频生成全链路闭环 (提交 + 状态 + 路由 + 产物 + 28积分对账 -> PASS)', async () => {
      const evidence = await runPanquPlaywrightFlow({
        caseId: 'TC-VIDEO-WAN3-01',
        mediaType: 'video',
        modelId: 84,
        duration: 4,
        resolution: '480p',
        mockSubmitResponse: {
          status: 200,
          body: { code: 1, msg: 'ok', data: { id: 10001 } },
        },
        mockStatusResponses: [
          { status: 200, body: { code: 1, data: { task_status: 1, progress: 30 } } },
          { status: 200, body: { code: 1, data: { task_status: 2, progress: 100, video_url: 'https://v.panqu.com/video1.mp4' } } },
        ],
        mockTaskDetails: {
          id: 10001,
          line: 10,
          status: 2,
          extra: {
            diversion: 10,
            newapi_log_id: 501,
            newapi_org_id: 0,
            newapi_group: '',
            newapi_model: 'wan3.0-video',
            channel_id: 36,
            channel_name: '万相—yhuo',
          },
        },
        mockGatewayLog: {
          id: 501,
          ai_task_id: 10001,
          newapi_task_id: 'task_wan_abc',
          channel_id: 36,
          channel_name: '万相—yhuo',
          status: 'SUCCESS',
        },
        mockAssetBuffer: validMp4Buffer,
        mockScoreLogs: [
          { task_id: 10001, type: 2, score: -28, memo: '预扣 28 积分' },
        ],
      });

      expect(evidence.overallStatus).toBe('PASS');
      expect(evidence.taskId).toBe(10001);
      expect(evidence.submission.responseCode).toBe(1);
      expect(evidence.taskTracking.terminalStatus).toBe('SUCCESS');
      expect(evidence.diversion.status).toBe('PASS');
      expect(evidence.diversion.evidenceState).toBe('VERIFIED');
      expect(evidence.diversion.actualChannel).toBe('万相—yhuo');
      expect(evidence.artifact.status).toBe('PASS');
      expect(evidence.artifact.decodable).toBe(true);
      expect(evidence.billing.status).toBe('PASS');
      expect(evidence.billing.netDeductedPoints).toBe(28);
    });

    it('样板 2：Pan Banana Pro 场景生图全链路闭环 (提交 + 状态 + 路由 + 产物 + 5积分对账 -> PASS)', async () => {
      const evidence = await runPanquPlaywrightFlow({
        caseId: 'TC-IMAGE-BANANA-01',
        mediaType: 'image',
        modelId: 12,
        serviceline: 'r',
        mockSubmitResponse: {
          status: 200,
          body: { code: 1, msg: 'ok', data: { id: 20002 } },
        },
        mockStatusResponses: [
          { status: 200, body: { code: 1, data: { task_status: 2, progress: 100, pic_url: 'https://v.panqu.com/pic1.png' } } },
        ],
        mockTaskDetails: {
          id: 20002,
          line: 10,
          status: 2,
          extra: {
            newapi_image: 1,
            newapi_log_id: 602,
            newapi_org_id: 10,
            newapi_group: 'panqu_test',
            newapi_model: 'pan-banana-pro',
            channel_id: 40,
            channel_name: 'RH-图片',
          },
        },
        mockGatewayLog: {
          id: 602,
          ai_task_id: 20002,
          channel_id: 40,
          channel_name: 'RH-图片',
          status: 'SUCCESS',
        },
        mockAssetBuffer: validPngBuffer,
        mockScoreLogs: [
          { task_id: 20002, type: 2, score: -10, memo: '生图扣费' },
        ],
      });

      expect(evidence.overallStatus).toBe('PASS');
      expect(evidence.taskId).toBe(20002);
      expect(evidence.diversion.isDiverted).toBe(true);
      expect(evidence.artifact.format).toBe('png');
      expect(evidence.billing.netDeductedPoints).toBe(10);
    });
  });

  describe('任务失败与退款闭环', () => {
    it('生成失败任务：自动跳过产物物理校验，全额退款核销后在 expectFailure 模式下 PASS', async () => {
      const evidence = await runPanquPlaywrightFlow({
        caseId: 'TC-FAIL-REFUND-01',
        mediaType: 'video',
        modelId: 84,
        expectFailure: true,
        mockSubmitResponse: {
          status: 200,
          body: { code: 1, msg: 'ok', data: { id: 30003 } },
        },
        mockStatusResponses: [
          { status: 200, body: { code: 1, data: { task_status: 3, progress: 0, err: 'Upstream vendor timeout' } } },
        ],
        mockTaskDetails: {
          id: 30003,
          line: 10,
          status: 3,
          extra: {
            diversion: 10,
            newapi_org_id: 0,
            newapi_group: '',
            newapi_model: 'wan3.0-video',
            channel_name: '万相—yhuo',
            channel_id: 36,
          },
        },
        mockScoreLogs: [
          { task_id: 30003, type: 2, score: -28 }, // 预扣 28
          { task_id: 30003, type: 1, score: 28 },  // 失败全额退还 28
        ],
      });

      expect(evidence.taskTracking.terminalStatus).toBe('FAILED');
      expect(evidence.artifact.skipped).toBe(true);
      expect(evidence.artifact.qualityClassification).toBe('TASK_FAILED_SKIPPED');
      expect(evidence.billing.netDeductedPoints).toBe(0);
      expect(evidence.billing.missingRefund).toBe(false);
      expect(evidence.overallStatus).toBe('PASS');
    });
  });

  describe('预置错误注入与校验器防御能力验证 (Negative Tests)', () => {
    it('错误注入 1：网关调度命中未授权非法渠道，RoutingEvidenceCollector 精确拦截并判 FAIL', async () => {
      const evidence = await runPanquPlaywrightFlow({
        caseId: 'TC-NEGATIVE-WRONG-CHANNEL',
        mediaType: 'video',
        modelId: 84,
        mockSubmitResponse: {
          status: 200,
          body: { code: 1, data: { id: 40004 } },
        },
        mockStatusResponses: [
          { status: 200, body: { code: 1, data: { task_status: 2, progress: 100 } } },
        ],
        mockTaskDetails: {
          id: 40004,
          line: 10,
          extra: {
            diversion: 10,
            channel_id: 999,
            channel_name: '非法外部黑渠道',
          },
        },
        mockGatewayLog: {
          ai_task_id: 40004,
          channel_id: 999,
          channel_name: '非法外部黑渠道',
        },
        mockAssetBuffer: validMp4Buffer,
        mockScoreLogs: [{ task_id: 40004, type: 2, score: -28 }],
      });

      expect(evidence.diversion.status).toBe('FAIL');
      expect(evidence.diversion.evidenceState).toBe('MISMATCH');
      expect(evidence.diversion.reasons.some((r) => r.includes('网关调度渠道非法'))).toBe(true);
      expect(evidence.overallStatus).toBe('FAIL');
    });

    it('错误注入 2：计费异常超扣积分 (44 vs 28)，BillingOracle 精确拦截 OVER_CHARGED 并判 FAIL', async () => {
      const evidence = await runPanquPlaywrightFlow({
        caseId: 'TC-NEGATIVE-OVER-CHARGED',
        mediaType: 'video',
        modelId: 84,
        duration: 4,
        resolution: '480p',
        mockSubmitResponse: {
          status: 200,
          body: { code: 1, data: { id: 50005 } },
        },
        mockStatusResponses: [
          { status: 200, body: { code: 1, data: { task_status: 2, progress: 100 } } },
        ],
        mockTaskDetails: {
          id: 50005,
          line: 10,
          extra: {
            diversion: 10,
            channel_name: '万相—yhuo',
            channel_id: 36,
          },
        },
        mockAssetBuffer: validMp4Buffer,
        mockScoreLogs: [
          { task_id: 50005, type: 2, score: -44 }, // 故意多扣 16 积分
        ],
      });

      expect(evidence.billing.status).toBe('FAIL');
      expect(evidence.billing.overCharged).toBe(true);
      expect(evidence.billing.reasons.some((r) => r.includes('多扣费'))).toBe(true);
      expect(evidence.overallStatus).toBe('FAIL');
    });

    it('错误注入 3：主站缺少 extra 路由快照底层证据，RoutingEvidenceCollector 严格标记 BLOCKED 拒绝通过', async () => {
      const evidence = await runPanquPlaywrightFlow({
        caseId: 'TC-NEGATIVE-MISSING-EVIDENCE',
        mediaType: 'video',
        modelId: 84,
        mockSubmitResponse: {
          status: 200,
          body: { code: 1, data: { id: 60006 } },
        },
        mockStatusResponses: [
          { status: 200, body: { code: 1, data: { task_status: 2, progress: 100 } } },
        ],
        mockTaskDetails: {
          id: 60006,
          line: 10,
          extra: undefined, // 缺失底层快照
        },
        mockAssetBuffer: validMp4Buffer,
        mockScoreLogs: [{ task_id: 60006, type: 2, score: -28 }],
      });

      expect(evidence.diversion.status).toBe('BLOCKED');
      expect(evidence.diversion.evidenceState).toBe('UNVERIFIED');
      expect(evidence.overallStatus).toBe('BLOCKED');
    });

    it('错误注入 4：产物无法解码或文件损坏，ArtifactCheck 精确识别 FILE_INVALID 并判 FAIL', async () => {
      const evidence = await runPanquPlaywrightFlow({
        caseId: 'TC-NEGATIVE-CORRUPTED-ASSET',
        mediaType: 'video',
        modelId: 84,
        mockSubmitResponse: {
          status: 200,
          body: { code: 1, data: { id: 70007 } },
        },
        mockStatusResponses: [
          { status: 200, body: { code: 1, data: { task_status: 2, progress: 100, video_url: 'http://v.panqu.com/bad.mp4' } } },
        ],
        mockTaskDetails: {
          id: 70007,
          line: 10,
          extra: { diversion: 10, channel_name: '万相—yhuo', channel_id: 36 },
        },
        mockAssetBuffer: Buffer.from('corrupted_not_a_valid_video_stream'),
        mockScoreLogs: [{ task_id: 70007, type: 2, score: -28 }],
      });

      expect(evidence.artifact.status).toBe('FAIL');
      expect(evidence.artifact.qualityClassification).toBe('FILE_INVALID');
      expect(evidence.overallStatus).toBe('FAIL');
    });

    it('错误注入 5：必须要求网关证据 (requireGatewayEvidence: true) 但网关证据缺失，判定 UNVERIFIED 并阻断 BLOCKED', async () => {
      const evidence = await runPanquPlaywrightFlow({
        caseId: 'TC-NEGATIVE-REQUIRE-GATEWAY-EVIDENCE',
        mediaType: 'video',
        modelId: 84,
        requireGatewayEvidence: true,
        mockSubmitResponse: {
          status: 200,
          body: { code: 1, data: { id: 80008 } },
        },
        mockStatusResponses: [
          { status: 200, body: { code: 1, data: { task_status: 2, progress: 100 } } },
        ],
        mockTaskDetails: {
          id: 80008,
          line: 10,
          extra: {
            diversion: 10,
            channel_name: '万相—yhuo',
            channel_id: 36,
          },
        },
        mockGatewayLog: undefined, // 缺失网关底层证据
        mockAssetBuffer: validMp4Buffer,
        mockScoreLogs: [{ task_id: 80008, type: 2, score: -28 }],
      });

      expect(evidence.diversion.status).toBe('BLOCKED');
      expect(evidence.diversion.evidenceState).toBe('UNVERIFIED');
      expect(evidence.overallStatus).toBe('BLOCKED');
    });

    it('错误注入 6：任务成功但账单流水完全缺失预扣记录 (mockScoreLogs: [])，严禁虚假放行，精确判 BLOCKED', async () => {
      const evidence = await runPanquPlaywrightFlow({
        caseId: 'TC-NEGATIVE-MISSING-SCORE-LOGS',
        mediaType: 'video',
        modelId: 84,
        duration: 4,
        resolution: '480p',
        mockSubmitResponse: {
          status: 200,
          body: { code: 1, data: { id: 80009 } },
        },
        mockStatusResponses: [
          { status: 200, body: { code: 1, data: { task_status: 2, progress: 100 } } },
        ],
        mockTaskDetails: {
          id: 80009,
          line: 10,
          extra: { diversion: 10, channel_name: '万相—yhuo', channel_id: 36 },
        },
        mockGatewayLog: {
          ai_task_id: 80009,
          channel_id: 36,
          channel_name: '万相—yhuo',
        },
        mockAssetBuffer: validMp4Buffer,
        mockScoreLogs: [], // 故意传入空流水，模拟未发生记账
      });

      expect(evidence.billing.status).toBe('BLOCKED');
      expect(evidence.billing.reasons.some((r) => r.includes('预扣流水'))).toBe(true);
      expect(evidence.overallStatus).toBe('BLOCKED');
    });

    it('错误注入 7：任务失败但退款流水缺失 (missingRefund)，BillingOracle 精确拦截并判 FAIL', async () => {
      const evidence = await runPanquPlaywrightFlow({
        caseId: 'TC-NEGATIVE-MISSING-REFUND',
        mediaType: 'video',
        modelId: 84,
        expectFailure: true,
        mockSubmitResponse: {
          status: 200,
          body: { code: 1, data: { id: 80010 } },
        },
        mockStatusResponses: [
          { status: 200, body: { code: 1, data: { task_status: 3, progress: 0, err: 'failed' } } },
        ],
        mockTaskDetails: {
          id: 80010,
          line: 10,
          status: 3,
          extra: { diversion: 10, channel_name: '万相—yhuo', channel_id: 36 },
        },
        mockScoreLogs: [
          { task_id: 80010, type: 2, score: -28 },
          // 故意缺失退款流水
        ],
      });

      expect(evidence.billing.status).toBe('FAIL');
      expect(evidence.billing.missingRefund).toBe(true);
      expect(evidence.billing.reasons.some((r) => r.includes('漏退款') || r.includes('未退回'))).toBe(true);
      expect(evidence.overallStatus).toBe('FAIL');
    });

    it('错误注入 8：UI_E2E 模式下无可用浏览器进程，严格阻断 BLOCKED，严禁以接口调用冒充页面通过', async () => {
      const mockApiOnlyFixture: any = {
        isHeadlessBrowserAvailable: false,
        page: undefined,
        request: {
          post: async () => ({
            status: () => 200,
            text: async () => JSON.stringify({ code: 1, data: { id: 80011 } }),
          }),
          get: async () => ({ ok: () => true, json: async () => ({ code: 1, data: {} }) }),
          dispose: async () => {},
        },
        dispose: async () => {},
      };

      const evidence = await runPanquPlaywrightFlow({
        caseId: 'TC-NEGATIVE-UI-E2E-BROWSER-BLOCKED',
        mediaType: 'video',
        executionMode: 'UI_E2E',
        fixture: mockApiOnlyFixture,
      });

      expect(evidence.overallStatus).toBe('BLOCKED');
      expect(evidence.testAssertionStatus).toBe('BLOCKED');
      expect(evidence.degradedFromBrowser).toBe(true);
      expect(evidence.degradedReason).toContain('UI_E2E 模式要求真实浏览器页面交互');
      expect(evidence.submission.submissionTransport).toBe('BROWSER_PAGE');
    });

    it('错误注入 9：提交状态未知 (SUBMISSION_UNKNOWN)，严防盲目重试引发二次扣费，严格判定为 BLOCKED', async () => {
      const evidence = await runPanquPlaywrightFlow({
        caseId: 'TC-NEGATIVE-SUBMISSION-UNKNOWN',
        mediaType: 'video',
        modelId: 84,
        mockSubmitResponse: {
          status: 504,
          body: { code: 0, msg: 'Gateway Timeout' },
        },
      });

      expect(evidence.submission.submissionState).toBe('UNKNOWN');
      expect(evidence.failureCategory).toBe('SUBMISSION_UNKNOWN');
      expect(evidence.overallStatus).toBe('BLOCKED');
    });

    it('错误注入 10：串入其他任务证据 (task_id 错配)，对账器严格拦截并不误判为通过', async () => {
      const evidence = await runPanquPlaywrightFlow({
        caseId: 'TC-NEGATIVE-CROSS-TASK-POLLUTION',
        mediaType: 'video',
        modelId: 84,
        duration: 4,
        resolution: '480p',
        mockSubmitResponse: {
          status: 200,
          body: { code: 1, data: { id: 80012 } },
        },
        mockStatusResponses: [
          { status: 200, body: { code: 1, data: { task_status: 2, progress: 100 } } },
        ],
        mockTaskDetails: {
          id: 80012,
          line: 10,
          extra: { diversion: 10, channel_name: '万相—yhuo', channel_id: 36 },
        },
        mockAssetBuffer: validMp4Buffer,
        mockScoreLogs: [
          // 故意传入另一个任务的流水 (id: 99999)
          { task_id: 99999, type: 2, score: -28, memo: '任务 99999 扣费' },
        ],
      });

      expect(evidence.billing.status).toBe('FAIL');
      expect(evidence.billing.reasons.some((r) => r.includes('成功任务缺失预扣流水记录'))).toBe(true);
      expect(evidence.overallStatus).toBe('FAIL');
    });
  });
});
