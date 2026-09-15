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
      expect(res.artifact.decodable).toBe(true);
      expect(res.artifact.containerIdentified).toBe(true);
      expect(res.billing.passed).toBe(true);
      expect(res.invariants.antiDoubleBilling).toBe(true);
      expect(res.invariants.netChargeZero).toBe(true);
      expect(res.invariants.refundIdempotency).toBe(true);
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
      expect(res.invariants.netChargeZero).toBe(false);
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
      expect(res.invariants.antiDoubleBilling).toBe(false);
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
      expect(res.artifact.decodable).toBe(false);
      expect(res.reasons.some((r) => r.includes('物理完整性'))).toBe(true);
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

  it('运行 verify 验证任务并返回校验结果', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });

    const code = await runDevTestCli(['verify', '--task', '55555', '--model', '84', '--media', 'video', '--json']);
    spy.mockRestore();

    expect(code).toBe(0);
    const json = JSON.parse(logs.join(''));
    expect(json.ok).toBe(true);
    expect(json.taskId).toBe(55555);
    expect(json.passed).toBe(true);
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
