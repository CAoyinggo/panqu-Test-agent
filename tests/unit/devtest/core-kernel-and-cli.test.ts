import { describe, expect, it, vi } from 'vitest';
import {
  probe,
  plan,
  execute,
  verify,
  type ProbeKernelOptions,
  type PlanKernelOptions,
  type ExecuteKernelOptions,
  type VerifyKernelOptions,
} from '../../../src/devtest/core-kernel.js';
import { runDevTestCli } from '../../../bin/devtest-cli.js';
import { DEVTEST_VERSION } from '../../../src/devtest/version.js';
import { createSyntheticValidMp4 } from '../../../src/devtest/media-inspector.js';
import * as mediaFlow from '../../../src/devtest/media-flow.js';
import { DevTestMcpService } from '../../../src/devtest/mcp-service.js';
import { discoverModelContract } from '../../../src/devtest/env-probe.js';

describe('DevTest 纯净内核层 (Core Kernel)', () => {
  describe('1. probe (环境探活)', () => {
    it('支持受控 mock 探活，返回健康状态与可用渠道', async () => {
      const res = await probe({ mock: true, env: 'test' });
      expect(res.ok).toBe(true);
      expect(res.env).toBe('test');
      expect(res.status).toBe('HEALTHY');
      expect(res.auth.status).toBe('MISSING');
      expect(res.candidateChannelCount).toBeGreaterThan(0);
      expect(res.endpoints.length).toBeGreaterThan(0);
    });

    it('真实探活在目标地址不可达时安全返回阻断或降级报告', async () => {
      const res = await probe({
        env: 'test',
        baseUrl: 'https://test-dev-unreachable.example.com',
        timeoutMs: 500,
        mock: false,
      });
      expect(res).toBeDefined();
      expect(res.env).toBe('test');
      expect(res.status).toBe('BLOCKED');
      expect(res.ok).toBe(false);
    });
  });

  describe('2. plan (分流推导与测试规划)', () => {
    it('推导全量开放视频模型 (Model 84/88) 命中 NewAPI 全局分流与计费基准', async () => {
      const plan84 = await plan({
        modelId: 84,
        mediaType: 'video',
        resolution: '720p',
        duration: 5,
      });

      expect(plan84.ok).toBe(true);
      expect(plan84.modelId).toBe(84);
      expect(plan84.mediaType).toBe('video');
      expect(plan84.willDivert).toBe(true);
      expect(plan84.decision).toBe('NEWAPI_GLOBAL');
      expect(plan84.routeLine).toBe(10);
      expect(plan84.expectedPoints).toBe(70); // Wan 3.0 720p: 14 pt/s * 5s = 70 pt
      expect(plan84.candidateChannels.length).toBeGreaterThan(0);
    });

    it('推导排除直连视频模型 (Model 16 fast / 58 mini) 回退直连链路', async () => {
      const plan16 = await plan({
        modelId: 16,
        mediaType: 'video',
        resolution: '720p',
        duration: 4,
      });

      expect(plan16.ok).toBe(true);
      expect(plan16.willDivert).toBe(false);
      expect(plan16.decision).toBe('FALLBACK_DIRECT');
      expect(plan16.routeLine).toBe(0);
    });

    it('推导生图模型 (Model 201 / 205) 依据刊例价和分组规则推导预期', async () => {
      const plan205 = await plan({
        modelId: 205,
        mediaType: 'image',
        resolution: '2k',
      });

      expect(plan205.ok).toBe(true);
      expect(plan205.mediaType).toBe('image');
      expect(plan205.expectedPoints).toBe(15); // 2k flare 为 15 积分
    });
  });

  describe('3. execute (任务执行)', () => {
    it('受控仿真派发任务，生成合法 Task ID 及初始凭据', async () => {
      const res = await execute({
        modelId: 84,
        mediaType: 'video',
        mode: 'mock',
        prompt: 'devtest_cinematic_landscape',
        duration: 5,
        resolution: '720p',
      });

      expect(res.ok).toBe(true);
      expect(res.mode).toBe('mock');
      expect(res.status).toBe('SUBMITTED');
      expect(res.taskId).toBeGreaterThan(0);
      expect(res.points).toBe(70);
      expect(res.credentialsMasked).toBeDefined();
    });

    it('真实执行在缺少 sessionFile 时拦截并返回安全错误', async () => {
      const res = await execute({
        modelId: 84,
        mediaType: 'video',
        mode: 'real',
        prompt: 'devtest_real_submit',
      });

      expect(res.ok).toBe(false);
      expect(res.status).toBe('ERROR');
      expect(res.message).toContain('sessionFile');
    });
  });

  describe('4. verify (物理验真与三大账务不变量核验)', () => {
    it('成功任务：有效 MP4 容器结构 + 正常预扣结算流水通过验真', async () => {
      const mp4Buffer = createSyntheticValidMp4({ width: 1280, height: 720, durationSeconds: 5 });
      const res = await verify({
        taskId: 98765,
        modelId: 84,
        mediaType: 'video',
        artifactBuffer: mp4Buffer,
        terminalStatus: 'SUCCESS',
        expectedPoints: 70,
        scoreLogs: [
          { task_id: 98765, type: 2, score: -70, memo: '任务预扣' },
        ],
      });

      expect(res.ok).toBe(true);
      expect(res.passed).toBe(true);
      expect(res.status).toBe('SUCCESS');
      expect(res.artifact?.decodable).toBe(true);
      expect(res.artifact?.containerIdentified).toBe(true);
      expect(res.billing?.passed).toBe(true);
      expect(res.billingAudit).toBe('AUDITED');
      expect(res.invariants?.antiDoubleBilling).toBe(true);
      expect(res.invariants?.netChargeZero).toBe(true);
      expect(res.invariants?.refundIdempotency).toBe(true);
    });

    it('不变量拦截：失败任务未退款导致 netChargeZero 不变量失败', async () => {
      const mp4Buffer = createSyntheticValidMp4({ width: 1280, height: 720, durationSeconds: 5 });
      const res = await verify({
        taskId: 98766,
        modelId: 84,
        mediaType: 'video',
        artifactBuffer: mp4Buffer,
        terminalStatus: 'FAILED',
        expectedPoints: 70,
        scoreLogs: [
          // 只有预扣，无退款流水
          { task_id: 98766, type: 2, score: -70, memo: '任务预扣' },
        ],
      });

      expect(res.ok).toBe(true);
      expect(res.passed).toBe(false);
      expect(res.status).toBe('FAILED');
      expect(res.invariants?.netChargeZero).toBe(false);
      expect(res.reasons.some((r) => r.includes('失败净扣归零'))).toBe(true);
    });

    it('不变量拦截：并发/重试导致多笔预扣，违反防重复扣费不变量', async () => {
      const mp4Buffer = createSyntheticValidMp4({ width: 1280, height: 720, durationSeconds: 5 });
      const res = await verify({
        taskId: 98767,
        modelId: 84,
        mediaType: 'video',
        artifactBuffer: mp4Buffer,
        terminalStatus: 'SUCCESS',
        expectedPoints: 70,
        scoreLogs: [
          { task_id: 98767, type: 2, score: -70, memo: '预扣 1' },
          { task_id: 98767, type: 2, score: -70, memo: '预扣 2 重复扣费' },
        ],
      });

      expect(res.ok).toBe(true);
      expect(res.passed).toBe(false);
      expect(res.status).toBe('FAILED');
      expect(res.invariants?.antiDoubleBilling).toBe(false);
      expect(res.reasons.some((r) => r.includes('防重复扣费'))).toBe(true);
    });

    it('物理结构拦截：损坏的媒体容器拒绝通过', async () => {
      const corruptBuffer = Buffer.from('NOT_A_VALID_MEDIA_FILE_HEADER_GARBAGE');
      const res = await verify({
        taskId: 98768,
        modelId: 84,
        mediaType: 'video',
        artifactBuffer: corruptBuffer,
        terminalStatus: 'SUCCESS',
      });

      expect(res.ok).toBe(true);
      expect(res.passed).toBe(false);
      expect(res.artifact?.decodable).toBe(false);
      expect(res.reasons.some((r) => r.includes('物理完整性'))).toBe(true);
    });

    it('脱机无凭据拦截：未提供产物 Buffer 或流水时标记 UNVERIFIED 且拒绝谎报通过', async () => {
      const res = await verify({
        taskId: 12345,
        modelId: 84,
        mediaType: 'video',
      });

      expect(res.ok).toBe(true);
      expect(res.passed).toBe(false);
      expect(res.status).toBe('UNVERIFIED');
      expect(res.mode).toBe('mock');
      expect(res.artifact).toBeUndefined();
      expect(res.billingAudit).toBe('SKIPPED_NO_LOGS');
      expect(res.reasons.some((r) => r.includes('缺失真实媒体产物'))).toBe(true);
      expect(res.reasons.some((r) => r.includes('SKIPPED_NO_LOGS'))).toBe(true);
    });

    it('真实状态轮询：状态为 1 (排队中) 时返回 PROCESSING 状态且不盲目验真', async () => {
      const pollSpy = vi.spyOn(mediaFlow, 'pollTaskStatus').mockResolvedValueOnce({
        finalSnapshot: {
          taskId: 88801,
          taskStatus: 1,
          statusLabel: '排队中 (Queued)',
          progress: 35,
          pollCount: 1,
          durationMs: 120,
        },
        totalPolls: 1,
        timeline: [{ timeMs: 120, status: 1, progress: 35 }],
      });

      const res = await verify({
        taskId: 88801,
        modelId: 84,
        mediaType: 'video',
        baseUrl: 'https://test-main.example.com',
        cookies: 'PHPSESSID=mock_session_123',
      });

      pollSpy.mockRestore();

      expect(res.ok).toBe(true);
      expect(res.passed).toBe(false);
      expect(res.status).toBe('PROCESSING');
      expect(res.progress).toBe(35);
      expect(res.reasons[0]).toContain('仍在排队/生成中');
    });

    it('真实状态轮询：状态为 3 (失败) 时返回 FAILED 并带上主站错误原文', async () => {
      const pollSpy = vi.spyOn(mediaFlow, 'pollTaskStatus').mockResolvedValueOnce({
        finalSnapshot: {
          taskId: 88802,
          taskStatus: 3,
          statusLabel: '失败 (Failed)',
          error: '上游算力集群排队超时，已熔断',
          progress: 0,
          pollCount: 1,
          durationMs: 200,
        },
        totalPolls: 1,
        timeline: [],
      });

      const res = await verify({
        taskId: 88802,
        modelId: 84,
        mediaType: 'video',
        baseUrl: 'https://test-main.example.com',
        cookies: 'PHPSESSID=mock_session_123',
        scoreLogs: [
          { task_id: 88802, type: 2, score: -28, memo: '预扣' },
          { task_id: 88802, type: 1, score: 28, memo: '全额退款' },
        ],
      });

      pollSpy.mockRestore();

      expect(res.ok).toBe(true);
      expect(res.passed).toBe(false);
      expect(res.status).toBe('FAILED');
      expect(res.reasons.some((r) => r.includes('上游算力集群排队超时'))).toBe(true);
      expect(res.billing?.netChargeZero).toBe(true);
    });

    it('真实状态轮询：状态为 2 (成功) 时流式探测 Range 二进制并完成物理验真', async () => {
      const validMp4 = createSyntheticValidMp4({ width: 1280, height: 720, durationSeconds: 4 });
      const pollSpy = vi.spyOn(mediaFlow, 'pollTaskStatus').mockResolvedValueOnce({
        finalSnapshot: {
          taskId: 88803,
          taskStatus: 2,
          statusLabel: '成功 (Success)',
          videoUrl: 'https://cdn.example.com/videos/output_88803.mp4',
          progress: 100,
          pollCount: 1,
          durationMs: 300,
        },
        totalPolls: 1,
        timeline: [],
      });

      // 模拟 Range 0-65535 HTTP GET 响应
      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes('cdn.example.com')) {
          return {
            ok: true,
            status: 206,
            statusText: 'Partial Content',
            arrayBuffer: async () => validMp4.buffer.slice(validMp4.byteOffset, validMp4.byteOffset + validMp4.byteLength),
          } as unknown as Response;
        }
        return originalFetch(url, init);
      });

      const res = await verify({
        taskId: 88803,
        modelId: 84,
        mediaType: 'video',
        baseUrl: 'https://test-main.example.com',
        cookies: 'PHPSESSID=mock_session_123',
        expectedPoints: 28,
        scoreLogs: [
          { task_id: 88803, type: 2, score: -28, memo: '预扣' },
        ],
      });

      pollSpy.mockRestore();
      global.fetch = originalFetch;

      expect(res.ok).toBe(true);
      expect(res.passed).toBe(true);
      expect(res.status).toBe('SUCCESS');
      expect(res.mode).toBe('real');
      expect(res.artifact?.decodable).toBe(true);
      expect(res.probeDurationMs).toBeDefined();
      expect(res.billing?.passed).toBe(true);
    });
  });
});

describe('DevTest 本地 CLI 运行入口 (devtest-cli)', () => {
  it('显示帮助信息 --help 且退出码为 0', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });

    const code = await runDevTestCli(['--help']);
    spy.mockRestore();

    expect(code).toBe(0);
    const combined = logs.join('\n');
    expect(combined).toContain('Panqu AI DevTest');
    expect(combined).toContain('probe');
    expect(combined).toContain('plan');
    expect(combined).toContain('execute');
    expect(combined).toContain('verify');
  });

  it('显示版本号 --version 且退出码为 0', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });

    const code = await runDevTestCli(['--version']);
    spy.mockRestore();

    expect(code).toBe(0);
    expect(logs.join('\n')).toContain(DEVTEST_VERSION);
  });

  it('运行 probe 命令输出 ANSI 颜色文本并返回 0', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });

    const code = await runDevTestCli(['probe', '--mock']);
    spy.mockRestore();

    expect(code).toBe(0);
    const text = logs.join('\n');
    expect(text).toContain('环境探活报告');
  });

  it('运行 probe --json 输出纯 JSON 格式并返回 0', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });

    const code = await runDevTestCli(['probe', '--mock', '--json']);
    spy.mockRestore();

    expect(code).toBe(0);
    const json = JSON.parse(logs.join(''));
    expect(json.ok).toBe(true);
    expect(json.status).toBe('HEALTHY');
  });

  it('运行 plan 命令并支持 --json 格式化', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });

    const code = await runDevTestCli(['plan', '--model', '84', '--media', 'video', '--json']);
    spy.mockRestore();

    expect(code).toBe(0);
    const json = JSON.parse(logs.join(''));
    expect(json.ok).toBe(true);
    expect(json.modelId).toBe(84);
    expect(json.willDivert).toBe(true);
  });

  it('运行 execute 命令受控仿真派发并支持 --json', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });

    const code = await runDevTestCli(['execute', '--model', '84', '--media', 'video', '--mode', 'mock', '--json']);
    spy.mockRestore();

    expect(code).toBe(0);
    const json = JSON.parse(logs.join(''));
    expect(json.ok).toBe(true);
    expect(json.mode).toBe('mock');
    expect(json.taskId).toBeGreaterThan(0);
  });

  it('运行 verify 在无凭据时如实告警未通过线上验收且返回状态码 1', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });

    const code = await runDevTestCli(['verify', '--task', '55555', '--model', '84', '--media', 'video', '--json']);
    spy.mockRestore();

    expect(code).toBe(1);
    const json = JSON.parse(logs.join(''));
    expect(json.ok).toBe(true);
    expect(json.taskId).toBe(55555);
    expect(json.passed).toBe(false);
    expect(json.status).toBe('UNVERIFIED');
    expect(json.billingAudit).toBe('SKIPPED_NO_LOGS');
  });

  it('运行 verify 文本模式输出包含脱机演算与未连接主站警告', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });

    const code = await runDevTestCli(['verify', '--task', '55555', '--model', '84', '--media', 'video']);
    spy.mockRestore();

    expect(code).toBe(1);
    const text = logs.join('\n');
    expect(text).toContain('当前未连接真实主站获取产物 URL / 账单流水，仅执行脱机静态演算');
    expect(text).toContain('UNVERIFIED');
  });

  it('未知命令 fail-closed 返回 1', async () => {
    const errors: string[] = [];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      errors.push(args.join(' '));
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const code = await runDevTestCli(['unknown-command']);
    errorSpy.mockRestore();
    logSpy.mockRestore();

    expect(code).toBe(1);
    expect(errors.join(' ')).toContain('未知命令');
  });
});

describe('3. 边界核验与双模一致性 (Idempotency & Boundary Audits)', () => {
  it('1. 幂等复验：对同一任务多次执行 verify 纯只读无副作用且结构完全一致', async () => {
    const mp4Buffer = createSyntheticValidMp4({ width: 1280, height: 720, durationSeconds: 4 });
    const verifyOpts: VerifyKernelOptions = {
      taskId: 77701,
      modelId: 84,
      mediaType: 'video',
      artifactBuffer: mp4Buffer,
      expectedPoints: 56,
      terminalStatus: 'SUCCESS',
      scoreLogs: [{ task_id: 77701, type: 2, score: -56, memo: '预扣' }],
    };

    const run1 = await verify(verifyOpts);
    const run2 = await verify(verifyOpts);

    expect(run1.ok).toBe(true);
    expect(run2.ok).toBe(true);
    expect(run1.passed).toBe(true);
    expect(run2.passed).toBe(true);
    expect(run1.status).toBe('SUCCESS');
    expect(run2.status).toBe('SUCCESS');
    expect(run1.evidence).toEqual(run2.evidence);
    expect(run1.evidence.task.status).toBe('PASS');
    expect(run1.evidence.media.status).toBe('PASS');
    expect(run1.evidence.billing.status).toBe('PASS');
    expect(run1.evidence.invariants.status).toBe('PASS');
  });

  it('2. 凭据缺失：媒体缺失但账单有效时，标记 UNVERIFIED 而非误报 FAILED', async () => {
    const res = await verify({
      taskId: 77702,
      modelId: 84,
      mediaType: 'video',
      expectedPoints: 28,
      terminalStatus: 'SUCCESS',
      scoreLogs: [{ task_id: 77702, type: 2, score: -28, memo: '正常扣费' }],
    });

    expect(res.ok).toBe(true);
    expect(res.passed).toBe(false);
    expect(res.status).toBe('UNVERIFIED');
    expect(res.evidence.task.status).toBe('PASS');
    expect(res.evidence.media.status).toBe('UNVERIFIED');
    expect(res.evidence.billing.status).toBe('PASS');
    expect(res.evidence.invariants.status).toBe('PASS');
    expect(res.reasons.some((r) => r.includes('缺失真实媒体产物'))).toBe(true);
  });

  it('3. 物理伪成功拦截：HTTP 200/206 返回但二进制首部损坏，准确判定 media FAIL', async () => {
    const corruptBuffer = Buffer.from('FAKE_HTTP_200_HEADER_DATA_NOT_MP4_OR_PNG');
    const res = await verify({
      taskId: 77703,
      modelId: 84,
      mediaType: 'video',
      artifactBuffer: corruptBuffer,
      expectedPoints: 28,
      terminalStatus: 'SUCCESS',
      scoreLogs: [{ task_id: 77703, type: 2, score: -28 }],
    });

    expect(res.ok).toBe(true);
    expect(res.passed).toBe(false);
    expect(res.status).toBe('FAILED');
    expect(res.evidence.media.status).toBe('FAIL');
    expect(res.evidence.media.decodable).toBe(false);
    expect(res.reasons.some((r) => r.includes('产物物理完整性校验失败'))).toBe(true);
  });

  it('4. 失败无流水拦截：任务终态失败但无流水证明退款，标记 FAILED 且账单 UNVERIFIED', async () => {
    const res = await verify({
      taskId: 77704,
      modelId: 84,
      mediaType: 'video',
      terminalStatus: 'FAILED',
    });

    expect(res.ok).toBe(true);
    expect(res.passed).toBe(false);
    expect(res.status).toBe('FAILED');
    expect(res.evidence.task.status).toBe('FAIL');
    expect(res.evidence.billing.status).toBe('UNVERIFIED');
    expect(res.reasons.some((r) => r.includes('无法核验失败退款净扣归零'))).toBe(true);
  });

  it('5. 重复扣费拦截：存在多笔扣费违反防重复扣费不变量', async () => {
    const mp4Buffer = createSyntheticValidMp4({ width: 1280, height: 720, durationSeconds: 4 });
    const res = await verify({
      taskId: 77705,
      modelId: 84,
      mediaType: 'video',
      artifactBuffer: mp4Buffer,
      expectedPoints: 28,
      terminalStatus: 'SUCCESS',
      scoreLogs: [
        { task_id: 77705, type: 2, score: -28, memo: '预扣 1' },
        { task_id: 77705, type: 2, score: -28, memo: '并发重复预扣 2' },
      ],
    });

    expect(res.ok).toBe(true);
    expect(res.passed).toBe(false);
    expect(res.status).toBe('FAILED');
    expect(res.evidence.invariants.status).toBe('FAIL');
    expect(res.evidence.invariants.antiDoubleBilling).toBe(false);
    expect(res.reasons.some((r) => r.includes('防重复扣费'))).toBe(true);
  });

  it('6. 重复退款拦截：存在多次退款违反退款幂等核销不变量', async () => {
    const mp4Buffer = createSyntheticValidMp4({ width: 1280, height: 720, durationSeconds: 4 });
    const res = await verify({
      taskId: 77706,
      modelId: 84,
      mediaType: 'video',
      artifactBuffer: mp4Buffer,
      expectedPoints: 28,
      terminalStatus: 'FAILED',
      scoreLogs: [
        { task_id: 77706, type: 2, score: -28, memo: '预扣' },
        { task_id: 77706, type: 1, score: 28, memo: '退款 1' },
        { task_id: 77706, type: 1, score: 28, memo: '重复退款 2' },
      ],
    });

    expect(res.ok).toBe(true);
    expect(res.passed).toBe(false);
    expect(res.status).toBe('FAILED');
    expect(res.evidence.invariants.status).toBe('FAIL');
    expect(res.evidence.invariants.refundIdempotency).toBe(false);
    expect(res.reasons.some((r) => r.includes('退款幂等核销'))).toBe(true);
  });

  it('7. 失败任务全额退款：账务与净扣归零 PASS，但任务本身状态为 FAIL', async () => {
    const res = await verify({
      taskId: 77707,
      modelId: 84,
      mediaType: 'video',
      expectedPoints: 28,
      terminalStatus: 'FAILED',
      scoreLogs: [
        { task_id: 77707, type: 2, score: -28, memo: '预扣' },
        { task_id: 77707, type: 1, score: 28, memo: '退款' },
      ],
    });

    expect(res.ok).toBe(true);
    expect(res.passed).toBe(false);
    expect(res.status).toBe('FAILED');
    expect(res.evidence.task.status).toBe('FAIL');
    expect(res.evidence.billing.status).toBe('PASS');
    expect(res.evidence.invariants.status).toBe('PASS');
    expect(res.evidence.invariants.netChargeZero).toBe(true);
  });

  it('8. 双模同源一致性：CLI 与 TRAE MCP 针对相同输入产出一致的裁决与 Evidence 结构', async () => {
    const mcpService = new DevTestMcpService();
    const mcpRes = await mcpService.call({
      action: 'verify',
      task_id: 77708,
      model_id: 84,
      media_type: 'video',
      terminal_status: 'SUCCESS',
    });

    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });
    const code = await runDevTestCli(['verify', '--task', '77708', '--model', '84', '--media', 'video', '--terminal-status', 'SUCCESS', '--json']);
    spy.mockRestore();

    expect(code).toBe(1); // unverified returns 1
    const cliRes = JSON.parse(logs.join(''));

    expect(mcpRes.ok).toBe(cliRes.ok);
    expect(mcpRes.data.passed).toBe(cliRes.passed);
    expect(mcpRes.data.status).toBe(cliRes.status);
    expect(mcpRes.data.evidence.task.status).toBe(cliRes.evidence.task.status);
    expect(mcpRes.data.evidence.media.status).toBe(cliRes.evidence.media.status);
    expect(mcpRes.data.evidence.billing.status).toBe(cliRes.evidence.billing.status);
    expect(mcpRes.data.evidence.invariants.status).toBe(cliRes.evidence.invariants.status);
    expect(mcpRes.summary).toContain('最终裁决 <UNVERIFIED>');
  });

  it('9. 任务查询不到 (taskStatus=0/不存在)：判定 UNVERIFIED，绝不谎报成功', async () => {
    const pollSpy = vi.spyOn(mediaFlow, 'pollTaskStatus').mockResolvedValueOnce({
      finalSnapshot: {
        taskId: 77709,
        taskStatus: 0,
        statusLabel: '待处理 (Pending)',
        progress: 0,
        pollCount: 1,
        durationMs: 150,
      },
      totalPolls: 1,
      timeline: [],
    });

    const res = await verify({
      taskId: 77709,
      baseUrl: 'https://test-main.example.com',
      cookies: 'PHPSESSID=mock_session_77709',
    });

    pollSpy.mockRestore();

    expect(res.ok).toBe(true);
    expect(res.passed).toBe(false);
    expect(res.status).toBe('UNVERIFIED');
    expect(res.verdict).toBe('UNVERIFIED');
    expect(res.evidence.task.status).toBe('UNVERIFIED');
    expect(res.evidence.task.source).toBe('task_not_found');
    expect(res.reasons.some((r) => r.includes('未能从主站获取到任务'))).toBe(true);
  });

  it('10. 归属缺失拦截：MP4 合法但无法证明属于 Task (外部 URL) 判定 UNVERIFIED', async () => {
    const validMp4 = createSyntheticValidMp4({ width: 1280, height: 720, durationSeconds: 4 });
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('external-unbound-video.mp4')) {
        return {
          ok: true,
          status: 206,
          statusText: 'Partial Content',
          arrayBuffer: async () => validMp4.buffer.slice(validMp4.byteOffset, validMp4.byteOffset + validMp4.byteLength),
        } as unknown as Response;
      }
      return originalFetch(url, init);
    });

    const res = await verify({
      taskId: 77710,
      videoUrl: 'https://cdn.example.com/external-unbound-video.mp4',
      terminalStatus: 'SUCCESS',
      expectedPoints: 28,
      scoreLogs: [{ task_id: 77710, type: 2, score: -28 }],
    });

    global.fetch = originalFetch;

    expect(res.ok).toBe(true);
    expect(res.passed).toBe(false);
    expect(res.status).toBe('UNVERIFIED');
    expect(res.verdict).toBe('UNVERIFIED');
    expect(res.evidence.media.status).toBe('UNVERIFIED');
    expect(res.evidence.media.ownership).toBe('UNVERIFIED');
    expect(res.evidence.media.reason).toContain('缺少与 Task #77710 的归属绑定证据');
  });

  it('11. 终态未知拦截：未传入 terminalStatus 且无 session，判定 UNKNOWN/UNVERIFIED，拒绝默认 SUCCESS', async () => {
    const validMp4 = createSyntheticValidMp4({ width: 1280, height: 720, durationSeconds: 4 });
    const res = await verify({
      taskId: 77711,
      artifactBuffer: validMp4,
      expectedPoints: 28,
      scoreLogs: [{ task_id: 77711, type: 2, score: -28 }],
    });

    expect(res.ok).toBe(true);
    expect(res.passed).toBe(false);
    expect(res.status).toBe('UNVERIFIED');
    expect(res.verdict).toBe('UNVERIFIED');
    expect(res.evidence.task.status).toBe('UNVERIFIED');
    expect(res.evidence.task.terminalStatus).toBe('UNKNOWN');
    expect(res.reasons.some((r) => r.includes('终态未知'))).toBe(true);
  });

  it('12. 账务流水缺失拦截：缺少 scoreLogs 判定 UNVERIFIED，不变量 details 均为 UNVERIFIED 绝无假 PASS', async () => {
    const validMp4 = createSyntheticValidMp4({ width: 1280, height: 720, durationSeconds: 4 });
    const res = await verify({
      taskId: 77712,
      terminalStatus: 'SUCCESS',
      artifactBuffer: validMp4,
    });

    expect(res.ok).toBe(true);
    expect(res.passed).toBe(false);
    expect(res.status).toBe('UNVERIFIED');
    expect(res.verdict).toBe('UNVERIFIED');
    expect(res.evidence.billing.status).toBe('UNVERIFIED');
    expect(res.evidence.invariants.status).toBe('UNVERIFIED');
    expect(res.evidence.invariants.details?.antiDoubleBilling.status).toBe('UNVERIFIED');
    expect(res.evidence.invariants.details?.netChargeZero.status).toBe('UNVERIFIED');
    expect(res.evidence.invariants.details?.refundIdempotency.status).toBe('UNVERIFIED');
    expect(res.billingAudit).toBe('SKIPPED_NO_LOGS');
    expect(res.reasons.some((r) => r.includes('缺少真实账务证据获取能力'))).toBe(true);
  });

  it('13. 业务失败与验证失败严格区分：Task 失败但无流水时，业务 FAIL 且账单 UNVERIFIED，总判定 FAILED', async () => {
    const res = await verify({
      taskId: 77713,
      terminalStatus: 'FAILED',
    });

    expect(res.ok).toBe(true);
    expect(res.passed).toBe(false);
    expect(res.status).toBe('FAILED');
    expect(res.verdict).toBe('FAIL');
    expect(res.evidence.task.status).toBe('FAIL');
    expect(res.evidence.billing.status).toBe('UNVERIFIED');
    expect(res.evidence.invariants.status).toBe('UNVERIFIED');
    expect(res.reasons.some((r) => r.includes('任务执行失败'))).toBe(true);
    expect(res.reasons.some((r) => r.includes('无法核验失败退款净扣归零'))).toBe(true);
  });

  it('14. 隔离原则：OFFLINE / FIXTURE 不能伪装 REAL，离线仿真携带专属 simulationId', async () => {
    const execRes = await execute({
      modelId: 84,
      mediaType: 'video',
      mode: 'mock',
    });

    expect(execRes.mode).toBe('mock');
    expect(execRes.isSimulated).toBe(true);
    expect(execRes.simulationId).toMatch(/^sim-offline-/);
    expect(execRes.message).toContain('[OFFLINE 离线仿真]');

    const verifyOffline = await verify({
      taskId: execRes.taskId,
    });
    expect(verifyOffline.executionMode).toBe('offline');
    expect(verifyOffline.status).toBe('UNVERIFIED');

    const validMp4 = createSyntheticValidMp4({ width: 1280, height: 720, durationSeconds: 4 });
    const verifyFixture = await verify({
      taskId: execRes.taskId,
      artifactBuffer: validMp4,
      scoreLogs: [{ task_id: execRes.taskId, type: 2, score: -28 }],
      terminalStatus: 'SUCCESS',
      expectedPoints: 28,
    });
    expect(verifyFixture.executionMode).toBe('fixture');
    expect(verifyFixture.mode).toBe('mock');
  });

  it('15. 零副作用验证：verify 纯只读，执行期间绝对不触发 submitMediaTask 任务派发', async () => {
    const submitSpy = vi.spyOn(mediaFlow, 'submitMediaTask');
    const validMp4 = createSyntheticValidMp4({ width: 1280, height: 720, durationSeconds: 4 });

    await verify({
      taskId: 77715,
      modelId: 84,
      mediaType: 'video',
      artifactBuffer: validMp4,
      terminalStatus: 'SUCCESS',
      expectedPoints: 28,
      scoreLogs: [{ task_id: 77715, type: 2, score: -28 }],
    });

    expect(submitSpy).not.toHaveBeenCalled();
    submitSpy.mockRestore();
  });

  it('16. 账单查询异常拦截：queryTaskBillingLogs 失败时 Fail-closed 判定 UNVERIFIED', async () => {
    const validMp4 = createSyntheticValidMp4({ width: 1280, height: 720, durationSeconds: 4 });
    const billingSpy = vi.spyOn(mediaFlow, 'queryTaskBillingLogs').mockResolvedValueOnce({
      status: 'QUERY_ERROR',
      scoreLogs: [],
      source: 'network_error',
      error: 'ETIMEDOUT: 连接账单数据库超时',
    });
    const statusSpy = vi.spyOn(mediaFlow, 'pollTaskStatus').mockResolvedValueOnce({
      finalSnapshot: {
        taskId: 77716,
        taskStatus: 2,
        statusLabel: '成功',
        progress: 100,
        videoUrl: 'https://test.panqu.com/sample.mp4',
        pollCount: 1,
        durationMs: 10,
      },
      totalPolls: 1,
      timeline: [],
    });

    const res = await verify({
      taskId: 77716,
      baseUrl: 'https://test.panqu.com',
      cookies: 'PHPSESSID=mock_session_123',
      artifactBuffer: validMp4,
    });

    expect(res.ok).toBe(true);
    expect(res.passed).toBe(false);
    expect(res.status).toBe('UNVERIFIED');
    expect(res.verdict).toBe('UNVERIFIED');
    expect(res.evidence.billing.status).toBe('UNVERIFIED');
    expect(res.evidence.invariants.status).toBe('UNVERIFIED');
    expect(res.evidence.billing.reason).toContain('ETIMEDOUT');

    billingSpy.mockRestore();
    statusSpy.mockRestore();
  });

  it('17. 账单流水空记录拦截：真实查询返回空流水，判定缺失预扣，Fail-closed 为 UNVERIFIED', async () => {
    const validMp4 = createSyntheticValidMp4({ width: 1280, height: 720, durationSeconds: 4 });
    const billingSpy = vi.spyOn(mediaFlow, 'queryTaskBillingLogs').mockResolvedValueOnce({
      status: 'QUERY_SUCCESS',
      scoreLogs: [],
      source: 'auth_adminscore',
    });
    const statusSpy = vi.spyOn(mediaFlow, 'pollTaskStatus').mockResolvedValueOnce({
      finalSnapshot: {
        taskId: 77717,
        taskStatus: 2,
        statusLabel: '成功',
        progress: 100,
        videoUrl: 'https://test.panqu.com/sample.mp4',
        pollCount: 1,
        durationMs: 10,
      },
      totalPolls: 1,
      timeline: [],
    });

    const res = await verify({
      taskId: 77717,
      baseUrl: 'https://test.panqu.com',
      cookies: 'PHPSESSID=mock_session_123',
      artifactBuffer: validMp4,
    });

    expect(res.ok).toBe(true);
    expect(res.passed).toBe(false);
    expect(res.status).toBe('UNVERIFIED');
    expect(res.verdict).toBe('UNVERIFIED');
    expect(res.evidence.billing.status).toBe('UNVERIFIED');
    expect(res.evidence.invariants.status).toBe('UNVERIFIED');
    expect(res.evidence.billing.reason).toContain('QUERY_SUCCESS + 0 records');

    billingSpy.mockRestore();
    statusSpy.mockRestore();
  });

  it('18. 链路协议与数据流契约 (CONTRACT / FIXTURE)：Session 流程下状态查询 + 产物验真 + 账务对账协议全通', async () => {
    const validMp4 = createSyntheticValidMp4({ width: 1280, height: 720, durationSeconds: 4 });
    const billingSpy = vi.spyOn(mediaFlow, 'queryTaskBillingLogs').mockResolvedValueOnce({
      status: 'QUERY_SUCCESS',
      scoreLogs: [{ task_id: 77718, type: 2, score: -28, memo: '预扣 28 pt' }],
      source: 'auth_adminscore',
    });
    const statusSpy = vi.spyOn(mediaFlow, 'pollTaskStatus').mockResolvedValueOnce({
      finalSnapshot: {
        taskId: 77718,
        taskStatus: 2,
        statusLabel: '成功',
        progress: 100,
        videoUrl: 'https://test.panqu.com/sample.mp4',
        pollCount: 1,
        durationMs: 10,
      },
      totalPolls: 1,
      timeline: [],
    });

    const res = await verify({
      taskId: 77718,
      baseUrl: 'https://test.panqu.com',
      cookies: 'PHPSESSID=mock_session_123',
      artifactBuffer: validMp4,
      expectedPoints: 28,
      expectedChargeSource: 'REAL_BILLING_FACT',
    });

    expect(res.ok).toBe(true);
    expect(res.passed).toBe(true);
    expect(res.status).toBe('SUCCESS');
    expect(res.verdict).toBe('PASS');
    expect(res.executionMode).toBe('real');
    expect(res.evidence.task.status).toBe('PASS');
    expect(res.evidence.media.status).toBe('PASS');
    expect(res.evidence.media.ownership).toBe('VERIFIED');
    expect(res.evidence.media.source).toBe('TASK_SNAPSHOT');
    expect(res.evidence.billing.status).toBe('PASS');
    expect(res.evidence.billing.expectedChargeSource).toBe('REAL_BILLING_FACT');
    expect(res.evidence.invariants.status).toBe('PASS');
    expect(res.evidence.invariants.antiDoubleBilling).toBe(true);
    expect(res.evidence.invariants.netChargeZero).toBe(true);
    expect(res.evidence.invariants.refundIdempotency).toBe(true);

    billingSpy.mockRestore();
    statusSpy.mockRestore();
  });

  it('19. queryTaskBillingLogs 针对 AdminScore 与 apiPersonalRecords 真实响应格式正确解析', async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/auth/adminscore/index')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            total: 1,
            rows: [
              { id: 991, task_id: 77719, type: 2, score: -28, remark: '预扣 28 分', createtime: '2026-09-15 12:00:00' },
            ],
          }),
        } as unknown as Response;
      }
      return originalFetch(url);
    });

    const queryRes = await mediaFlow.queryTaskBillingLogs(77719, {
      env: 'test',
      base_url: 'https://test.panqu.com',
      cookie_string: 'PHPSESSID=mock_cookie_val',
    });

    global.fetch = originalFetch;

    expect(queryRes.status).toBe('QUERY_SUCCESS');
    expect(queryRes.source).toBe('auth_adminscore');
    expect(queryRes.scoreLogs.length).toBe(1);
    expect(queryRes.scoreLogs[0].task_id).toBe(77719);
    expect(queryRes.scoreLogs[0].score).toBe(-28);
    expect(queryRes.scoreLogs[0].type).toBe(2);
  });

  it('20. queryTaskBillingLogs 严格区分 5 种状态：QUERY_SUCCESS (records=0), QUERY_TIMEOUT, AUTH_FAILED, PARSE_ERROR, QUERY_ERROR', async () => {
    const originalFetch = global.fetch;
    const session: mediaFlow.PanquSession = {
      env: 'test',
      base_url: 'https://test.panqu.com',
      cookie_string: 'PHPSESSID=mock_val',
    };

    // Case A: AUTH_FAILED (401)
    global.fetch = vi.fn().mockImplementation(async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => 'Unauthorized',
    } as unknown as Response));
    const authRes = await mediaFlow.queryTaskBillingLogs(77720, session);
    expect(authRes.status).toBe('AUTH_FAILED');
    expect(authRes.error).toContain('AUTH_FAILED');

    // Case B: PARSE_ERROR
    global.fetch = vi.fn().mockImplementation(async () => ({
      ok: true,
      status: 200,
      text: async () => '<html><body>Gateway Error</body></html>',
    } as unknown as Response));
    const parseRes = await mediaFlow.queryTaskBillingLogs(77720, session);
    expect(parseRes.status).toBe('PARSE_ERROR');
    expect(parseRes.error).toContain('PARSE_ERROR');

    // Case C: QUERY_TIMEOUT
    global.fetch = vi.fn().mockImplementation(async () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    });
    const timeoutRes = await mediaFlow.queryTaskBillingLogs(77720, session);
    expect(timeoutRes.status).toBe('QUERY_TIMEOUT');
    expect(timeoutRes.error).toContain('QUERY_TIMEOUT');

    // Case D: QUERY_SUCCESS + 0 records
    global.fetch = vi.fn().mockImplementation(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ code: 1, data: { total: 0, rows: [] } }),
    } as unknown as Response));
    const zeroRes = await mediaFlow.queryTaskBillingLogs(77720, session);
    expect(zeroRes.status).toBe('QUERY_SUCCESS');
    expect(zeroRes.scoreLogs.length).toBe(0);

    global.fetch = originalFetch;
  });

  it('21. Verify 全流程严格只读锁定：禁止调用任何写操作端点（如任务创建、扣费、退款、修改等）', async () => {
    const originalFetch = global.fetch;
    const recordedCalls: Array<{ url: string; method: string }> = [];

    global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const method = (init?.method || 'GET').toUpperCase();
      recordedCalls.push({ url, method });

      if (url.includes('/apiGetStatus')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            code: 1,
            data: [{ id: 77721, task_status: 2, video_url: 'https://test.panqu.com/video.mp4', progress: 100 }],
          }),
        } as unknown as Response;
      }
      if (url.includes('/video.mp4')) {
        const mp4 = createSyntheticValidMp4({ width: 1280, height: 720, durationSeconds: 4 });
        return {
          ok: true,
          status: 206,
          arrayBuffer: async () => mp4.buffer.slice(mp4.byteOffset, mp4.byteOffset + mp4.byteLength),
        } as unknown as Response;
      }
      if (url.includes('/auth/adminscore/index')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            total: 1,
            rows: [{ id: 1, task_id: 77721, type: 2, score: -28, remark: '预扣 28', createtime: '2026-09-15 12:00:00' }],
          }),
        } as unknown as Response;
      }
      return { ok: false, status: 404, text: async () => 'not found' } as unknown as Response;
    });

    await verify({
      taskId: 77721,
      baseUrl: 'https://test.panqu.com',
      cookies: 'PHPSESSID=mock_val',
      expectedPoints: 28,
    });

    global.fetch = originalFetch;

    expect(recordedCalls.length).toBeGreaterThan(0);
    for (const call of recordedCalls) {
      if (call.method === 'POST') {
        expect(call.url).toContain('/aivideo/v2/task_status/apiGetStatus');
      } else {
        expect(call.method).toBe('GET');
      }
      expect(call.url).not.toContain('/generate');
      expect(call.url).not.toContain('/refund');
      expect(call.url).not.toContain('/charge');
      expect(call.url).not.toContain('/submit');
    }
  });
});

describe('4. 参数一致性与漂移消除回归测试 (Parameter Consistency & Drift Elimination)', () => {
  it('Case A: Model 84 缺省 resolution - plan / execute / verify 统一推导 480p 且积分规格一致 (56 pt)', async () => {
    // 1. plan: 缺省 resolution 推导首项 480p, duration 推导首项 4s, 计费 14 pt/s * 4s = 56 pt
    const planRes = await plan({ modelId: 84, mediaType: 'video' });
    expect(planRes.expectedPoints).toBe(56);
    expect(planRes.testerActionSummary?.nextStep).toContain('--resolution 480p');
    expect(planRes.testerActionSummary?.nextStep).toContain('--duration 4');

    // 2. execute: 缺省 resolution 仿真模式返回 56 pt
    const execRes = await execute({ modelId: 84, mediaType: 'video', mode: 'mock' });
    expect(execRes.points).toBe(56);

    // 3. execute: 真实提交时携带推导的 480p，绝不再盲目硬编码 720p
    const sessionSpy = vi.spyOn(mediaFlow, 'loadPanquSession').mockResolvedValueOnce({
      env: 'test',
      base_url: 'https://test.panqu.com',
      cookie_string: 'PHPSESSID=mock',
      csrf_token: 'token',
      project_id: 10,
    });
    const submitSpy = vi.spyOn(mediaFlow, 'submitMediaTask').mockResolvedValueOnce({
      ok: true,
      taskId: 84001,
      message: 'ok',
      durationMs: 100,
    });
    await execute({
      modelId: 84,
      mediaType: 'video',
      mode: 'real',
      sessionFile: 'session.json',
    });
    expect(submitSpy).toHaveBeenCalled();
    const callArgs = submitSpy.mock.calls[0][0];
    expect(callArgs.resolution).toBe('480p');
    expect(callArgs.duration).toBe(4);
    sessionSpy.mockRestore();
    submitSpy.mockRestore();

    // 4. verify: 缺省 resolution 独立核验推导 480p/4s -> 56 pt
    const verifyRes = await verify({
      taskId: execRes.taskId,
      modelId: 84,
      mediaType: 'video',
      terminalStatus: 'SUCCESS',
      scoreLogs: [{ task_id: execRes.taskId, type: 2, score: -56, memo: '预扣' }],
    });
    expect(verifyRes.evidence.billing.expectedPoints).toBe(56);
    expect(verifyRes.evidence.billing.netDeductedPoints).toBe(56);
    expect(verifyRes.evidence.billing.status).toBe('PASS');
  });

  it('Case B: Model 15 (Seedance) 缺省 duration - plan / execute / verify 统一推导 3s (75 pt)', async () => {
    // 1. plan: Seedance 契约 durations=[3, 4, 5]，首选值为 3s，计费 25 pt/s * 3s = 75 pt
    const planRes = await plan({ modelId: 15, mediaType: 'video' });
    expect(planRes.expectedPoints).toBe(75);
    expect(planRes.testerActionSummary?.nextStep).toContain('--duration 3');
    expect(planRes.testerActionSummary?.nextStep).toContain('--resolution 480p');

    // 2. execute: 缺省 duration 统一推导为 3s (75 pt)
    const execRes = await execute({ modelId: 15, mediaType: 'video', mode: 'mock' });
    expect(execRes.points).toBe(75);

    // 3. execute: 真实提交验证携带 duration: 3
    const sessionSpy = vi.spyOn(mediaFlow, 'loadPanquSession').mockResolvedValueOnce({
      env: 'test',
      base_url: 'https://test.panqu.com',
      cookie_string: 'PHPSESSID=mock',
      csrf_token: 'token',
      project_id: 10,
    });
    const submitSpy = vi.spyOn(mediaFlow, 'submitMediaTask').mockResolvedValueOnce({
      ok: true,
      taskId: 15001,
      message: 'ok',
      durationMs: 100,
    });
    await execute({
      modelId: 15,
      mediaType: 'video',
      mode: 'real',
      sessionFile: 'session.json',
    });
    expect(submitSpy).toHaveBeenCalled();
    const callArgs = submitSpy.mock.calls[0][0];
    expect(callArgs.duration).toBe(3);
    expect(callArgs.resolution).toBe('480p');
    sessionSpy.mockRestore();
    submitSpy.mockRestore();

    // 4. verify: 缺省 duration 独立推导为 3s，与预扣 75 pt 完全对齐
    const verifyRes = await verify({
      taskId: execRes.taskId,
      modelId: 15,
      mediaType: 'video',
      terminalStatus: 'SUCCESS',
      scoreLogs: [{ task_id: execRes.taskId, type: 2, score: -75, memo: '预扣' }],
    });
    expect(verifyRes.evidence.billing.expectedPoints).toBe(75);
    expect(verifyRes.evidence.billing.netDeductedPoints).toBe(75);
    expect(verifyRes.evidence.billing.status).toBe('PASS');
  });

  it('Case C: 显式参数优先级最高 - resolution=720p, duration=5 不被默认逻辑覆盖 (70 pt)', async () => {
    // 1. plan 显式传参
    const planRes = await plan({ modelId: 84, mediaType: 'video', resolution: '720p', duration: 5 });
    expect(planRes.expectedPoints).toBe(70);
    expect(planRes.testerActionSummary?.nextStep).toContain('--resolution 720p');
    expect(planRes.testerActionSummary?.nextStep).toContain('--duration 5');

    // 2. execute 显式传参
    const execRes = await execute({ modelId: 84, mediaType: 'video', resolution: '720p', duration: 5, mode: 'mock' });
    expect(execRes.points).toBe(70);

    // 3. verify 显式传参
    const verifyRes = await verify({
      taskId: 12345,
      modelId: 84,
      mediaType: 'video',
      resolution: '720p',
      duration: 5,
      terminalStatus: 'SUCCESS',
      scoreLogs: [{ task_id: 12345, type: 2, score: -70, memo: '预扣' }],
    });
    expect(verifyRes.evidence.billing.expectedPoints).toBe(70);
    expect(verifyRes.evidence.billing.status).toBe('PASS');
  });

  it('Case D: 仅支持 480p 的非标契约模型 - execute 缺省时严格遵循契约首选值，不强制产生 720p', async () => {
    const sessionSpy = vi.spyOn(mediaFlow, 'loadPanquSession').mockResolvedValueOnce({
      env: 'test',
      base_url: 'https://test.panqu.com',
      cookie_string: 'PHPSESSID=mock',
      csrf_token: 'token',
      project_id: 10,
    });
    const submitSpy = vi.spyOn(mediaFlow, 'submitMediaTask').mockResolvedValueOnce({
      ok: true,
      taskId: 99701,
      message: 'ok',
      durationMs: 100,
    });

    const customContract = {
      ...discoverModelContract(977, 'video', { price: 10 }),
      supportedResolutions: { value: ['480p'], source: 'SOURCE_INPUT' as const, determined: true, allowPass: true },
    };

    await execute({
      modelId: 977,
      mediaType: 'video',
      mode: 'real',
      sessionFile: 'session.json',
      price: 10,
      contract: customContract,
    });

    expect(submitSpy).toHaveBeenCalled();
    const callArgs = submitSpy.mock.calls[0][0];
    expect(callArgs.resolution).toBe('480p');
    expect(callArgs.resolution).not.toBe('720p');

    sessionSpy.mockRestore();
    submitSpy.mockRestore();
  });

  it('Case E: verify 独立性 - 无 execute / plan 内存上下文时完全独立推导并完成审计', async () => {
    const verifyRes = await verify({
      taskId: 88801,
      modelId: 84,
      mediaType: 'video',
      terminalStatus: 'SUCCESS',
      scoreLogs: [{ task_id: 88801, type: 2, score: -56 }],
    });

    expect(verifyRes.contract).toBeDefined();
    expect(verifyRes.contract?.modelId).toBe(84);
    expect(verifyRes.evidence.billing.expectedPoints).toBe(56);
    expect(verifyRes.evidence.billing.netDeductedPoints).toBe(56);
    expect(verifyRes.evidence.billing.status).toBe('PASS');
    // 缺少物理产物时遵循 Fail-Closed 原则，整体状态为 UNVERIFIED
    expect(verifyRes.passed).toBe(false);
    expect(verifyRes.status).toBe('UNVERIFIED');
  });

  it('Case F: expectedPoints 与 customPoints 隔离 - 视频模型不受污染，图片模型保留兼容', async () => {
    // 1. 视频模型传入 expectedPoints：不污染 pointsPerSecond，不被当成 customPoints
    const vVideo = await verify({
      taskId: 88802,
      modelId: 84,
      mediaType: 'video',
      expectedPoints: 56,
      terminalStatus: 'SUCCESS',
      scoreLogs: [{ task_id: 88802, type: 2, score: -56 }],
    });
    expect(vVideo.contract?.pricing.pointsPerSecond?.value).toBe(14);
    expect(vVideo.contract?.pricing.customPoints?.value).toBeUndefined();

    // 2. 图片模型传入 expectedPoints：兼容作为 customPoints 提供刊例基准
    const vImage = await verify({
      taskId: 88803,
      modelId: 988,
      mediaType: 'image',
      expectedPoints: 10,
      terminalStatus: 'SUCCESS',
      scoreLogs: [{ task_id: 88803, type: 2, score: -10 }],
    });
    expect(vImage.contract?.pricing.customPoints?.value).toBe(10);
    expect(vImage.contract?.pricing.isPricingDetermined).toBe(true);
  });

  it('Case G: verify() 对 moov 位于尾部的合法 MP4（如 Wan3.0 视频）产物正确识别 PASS', async () => {
    const base = createSyntheticValidMp4({ width: 1280, height: 720, durationSeconds: 4 });
    const ftyp = base.subarray(0, 24);
    const moovLen = base.readUInt32BE(24);
    const moov = base.subarray(24, 24 + moovLen);
    const mdat = base.subarray(24 + moovLen);

    // 构造 head + tail 并附加 tailBuffer
    const head = Buffer.concat([ftyp, mdat]);
    (head as any).tailBuffer = moov;

    const vRes = await verify({
      taskId: 88804,
      modelId: 84,
      mediaType: 'video',
      terminalStatus: 'SUCCESS',
      assetBuffer: head,
      scoreLogs: [{ task_id: 88804, type: 2, score: -56 }],
    });

    expect(vRes.evidence.media.status).toBe('PASS');
    expect(vRes.evidence.media.format).toContain('mp4');
    expect(vRes.evidence.media.dimensions).toEqual({ width: 1280, height: 720 });
    expect(vRes.evidence.media.durationSeconds).toBe(4);
    expect(vRes.evidence.media.hasMdat).toBe(true);
    expect(vRes.evidence.media.decodable).toBe(true);
  });
});


