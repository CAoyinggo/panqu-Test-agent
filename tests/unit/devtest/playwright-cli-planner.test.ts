import { describe, expect, it } from 'vitest';
import { main, parseCliArgs } from '../../../src/devtest/run-playwright-cli.js';

describe('Playwright CLI Planner Integration', () => {
  it('支持解析 --requirement, --onboard-model, --alias, --plan-only 命令行参数', () => {
    const options = parseCliArgs([
      '--onboard-model', '88',
      '--media', 'video',
      '--alias', 'wan3.0-prime',
      '--global',
      '--plan-only',
    ]);

    expect(options.onboardModelId).toBe(88);
    expect(options.mediaType).toBe('video');
    expect(options.modelAlias).toBe('wan3.0-prime');
    expect(options.isGlobalModel).toBe(true);
    expect(options.planOnly).toBe(true);
  });

  it('执行 --plan-only 模式时通过 SelfTestPlanner 输出规划结果并返回退出码 0', async () => {
    const exitCode = await main([
      '--onboard-model', '88',
      '--media', 'video',
      '--alias', 'wan3.0-prime',
      '--plan-only',
    ]);

    expect(exitCode).toBe(0);
  });
});
