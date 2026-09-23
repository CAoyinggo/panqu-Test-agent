// Panqu AI DevTest v6.0.0 Test Isolation & Global Cleanup Contract Tests
import { describe, expect, it, vi, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

describe('Test Isolation & Global Cleanup Contract Tests', () => {
  const originalFetch = global.fetch;
  const initialEnvKey = 'DEVTEST_ISOLATION_PROBE_KEY';

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('1. 全局 fetch 在当前用例被修改后，通过 afterEach 必能还原为原生实现', () => {
    // 初始状态下 fetch 必须是原始实现
    expect(global.fetch).toBe(originalFetch);

    // 模拟用例局部覆盖
    global.fetch = vi.fn().mockImplementation(async () => {
      return new Response('mocked');
    });

    expect(vi.isMockFunction(global.fetch)).toBe(true);
  });

  it('2. 上一个用例结束后的下一个用例中，global.fetch 已经恢复，绝不泄漏 mock', () => {
    expect(vi.isMockFunction(global.fetch)).toBe(false);
    expect(global.fetch).toBe(originalFetch);
  });

  it('3. vi.stubEnv 注入的环境变量在当前用例生效，但 afterEach 必能自动消除', () => {
    expect(process.env[initialEnvKey]).toBeUndefined();

    vi.stubEnv(initialEnvKey, 'STUBBED_TEST_VALUE');
    expect(process.env[initialEnvKey]).toBe('STUBBED_TEST_VALUE');
  });

  it('4. 上一个用例结束后的下一个用例中，process.env 恢复如初，绝不残留 stub 环境变量', () => {
    expect(process.env[initialEnvKey]).toBeUndefined();
  });

  it('5. 方法级别的 vi.spyOn 在模拟测试执行后，经过清理依然安全还原', () => {
    const sampleObj = {
      action: () => 'real_result',
    };

    const spy = vi.spyOn(sampleObj, 'action').mockReturnValue('mock_result');
    expect(sampleObj.action()).toBe('mock_result');

    // 手动调用与 afterEach 等价的还原逻辑
    vi.restoreAllMocks();
    expect(sampleObj.action()).toBe('real_result');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('6. 模拟用例执行中途抛出断言失败 (Assertion Error)，清理机制仍能恢复所有状态', async () => {
    const cleanup = () => {
      global.fetch = originalFetch;
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    };

    const runCrashingTest = async () => {
      try {
        global.fetch = vi.fn().mockImplementation(async () => new Response('leaked_fetch'));
        vi.stubEnv(initialEnvKey, 'LEAKED_ENV_VAR');
        vi.spyOn(console, 'warn').mockImplementation(() => {});

        // 模拟断言在中途抛错崩溃
        throw new Error('ASSERTION_ERROR: expected 1 to be 2');
      } finally {
        cleanup();
      }
    };

    await expect(runCrashingTest()).rejects.toThrow('ASSERTION_ERROR');

    // 验证崩溃后各状态已被无死角还原
    expect(vi.isMockFunction(global.fetch)).toBe(false);
    expect(global.fetch).toBe(originalFetch);
    expect(process.env[initialEnvKey]).toBeUndefined();
    expect(vi.isMockFunction(console.warn)).toBe(false);
  });

  it('7. 模拟异步操作发生异常与网络 Reject 中途中断，测试生命周期依然恢复原貌', async () => {
    const cleanup = () => {
      global.fetch = originalFetch;
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    };

    const runAsyncRejectionTest = async () => {
      try {
        global.fetch = vi.fn().mockRejectedValue(new Error('NETWORK_TIMEOUT_ABORT'));
        vi.stubEnv(initialEnvKey, 'ASYNC_STUB');

        // 模拟异步未捕获异常
        await Promise.reject(new Error('ASYNC_UNHANDLED_PIPELINE_ERROR'));
      } finally {
        cleanup();
      }
    };

    await expect(runAsyncRejectionTest()).rejects.toThrow('ASYNC_UNHANDLED_PIPELINE_ERROR');

    expect(vi.isMockFunction(global.fetch)).toBe(false);
    expect(global.fetch).toBe(originalFetch);
    expect(process.env[initialEnvKey]).toBeUndefined();
  });

  it('8. 多重复合污染抛错：即使在异常分支中，不会发生清理链中断或部分泄漏', () => {
    const cleanup = () => {
      global.fetch = originalFetch;
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    };

    try {
      global.fetch = vi.fn();
      vi.stubEnv(initialEnvKey + '_A', 'VAL_A');
      vi.stubEnv(initialEnvKey + '_B', 'VAL_B');
      vi.spyOn(console, 'info').mockImplementation(() => {});

      throw new TypeError('UNEXPECTED_RUNTIME_TYPE_ERROR');
    } catch {
      cleanup();
    }

    expect(global.fetch).toBe(originalFetch);
    expect(process.env[initialEnvKey + '_A']).toBeUndefined();
    expect(process.env[initialEnvKey + '_B']).toBeUndefined();
    expect(vi.isMockFunction(console.info)).toBe(false);
  });

  it('9. 框架级端到端验证：测试失败中途中断时，测试框架自动调度顶层 afterEach 恢复环境，绝不泄漏至后续用例', () => {
    const fixtureConfig = path.resolve('tests/fixtures/isolation/vitest.fixture.config.ts');
    const res = spawnSync('npx', ['vitest', 'run', '-c', fixtureConfig, '--reporter=json'], {
      encoding: 'utf8',
      cwd: process.cwd(),
      timeout: 15000,
    });

    // 含有故意失败的用例，子进程整体 exit code 必然为 1
    expect(res.status).toBe(1);

    const json = JSON.parse(res.stdout);
    expect(json.numTotalTests).toBe(2);
    expect(json.numFailedTests).toBe(1);
    expect(json.numPassedTests).toBe(1);

    type AssertionRecord = { title: string; status: string; failureMessages: string[] };
    const assertions = json.testResults[0].assertionResults as AssertionRecord[];
    const failCase = assertions.find((a) => a.title.includes('case_fail_dirty'));
    const verifyCase = assertions.find((a) => a.title.includes('case_verify_clean'));

    expect(failCase?.status).toBe('failed');
    expect(failCase?.failureMessages[0]).toContain('AssertionError');

    // 核心断言：后续用例 PASS，证明顶层 afterEach 确实被测试框架在异常中自动执行，并成功还原了全局状态
    expect(verifyCase?.status).toBe('passed');
  });
});
