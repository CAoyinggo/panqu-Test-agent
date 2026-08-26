import { describe, expect, it, vi } from 'vitest';
import { devTestExitCode, main, parseDevTestArgs } from '../../../bin/run-devtest.js';

describe('DevTest CLI', () => {
  it('支持一条命令位置 Requirement 与规范参数', () => {
    expect(parseDevTestArgs([
      'requirements/demo.md', '--env=test', '--mode', 'safe', '--output', './custom',
      '--max-cases=12', '--no-ui', '--no-data-isolation', '--preflight',
    ])).toMatchObject({
      doc: 'requirements/demo.md', env: 'test', mode: 'SAFE', output: './custom', maxCases: 12,
      enabledDimensions: { UI: false, DATA_ISOLATION: false },
      preflight: true,
    });
  });

  it('缺 Requirement、缺参数值、未知参数、重复参数均拒绝', () => {
    expect(() => parseDevTestArgs([])).toThrow('DEVTEST_ARG_MISSING');
    expect(() => parseDevTestArgs(['a.md', '--env'])).toThrow('DEVTEST_ARG_MISSING_VALUE');
    expect(() => parseDevTestArgs(['a.md', '--wat'])).toThrow('DEVTEST_ARG_UNKNOWN');
    expect(() => parseDevTestArgs(['a.md', '--env', 'test', '--env', 'local'])).toThrow('DEVTEST_ARG_DUPLICATE');
    expect(() => parseDevTestArgs(['a.md', '--output', 'a', '--out', 'b'])).toThrow('DEVTEST_ARG_DUPLICATE');
    expect(() => parseDevTestArgs(['a.md', '--mode', 'safe', '--dry-run'])).toThrow('DEVTEST_ARG_CONFLICT');
  });

  it('非法 mode、环境和 maxCases fail-closed', () => {
    expect(() => parseDevTestArgs(['a.md', '--mode', 'magic'])).toThrow('DEVTEST_ARG_INVALID');
    expect(() => parseDevTestArgs(['a.md', '--env', 'production'])).toThrow('DEVTEST_ARG_INVALID');
    expect(() => parseDevTestArgs(['a.md', '--max-cases', '0'])).toThrow('DEVTEST_ARG_INVALID');
  });

  it('支持 plan、repro 与分类 rerun，并拒绝冲突/非法问题 ID', () => {
    expect(parseDevTestArgs(['a.md', '--plan'])).toMatchObject({ plan: true });
    expect(parseDevTestArgs(['a.md', '--repro', 'P001'])).toMatchObject({ reproProblemId: 'P001' });
    expect(parseDevTestArgs(['a.md', '--rerun', 'blocked'])).toMatchObject({ rerun: true, rerunTarget: 'blocked' });
    expect(parseDevTestArgs(['a.md', '--rerun=P002'])).toMatchObject({ rerun: true, rerunTarget: 'P002' });
    expect(() => parseDevTestArgs(['a.md', '--repro', 'bad'])).toThrow('DEVTEST_ARG_INVALID');
    expect(() => parseDevTestArgs(['a.md', '--plan', '--preflight'])).toThrow('DEVTEST_ARG_CONFLICT');
  });

  it('支持 --final、fail-fast 与安全并发参数', () => {
    expect(parseDevTestArgs(['a.md', '--final', '--fail-fast', '--concurrency', '3', '--timeout', '8000', '--max-runtime', '30000', '--budget', '2.5'])).toMatchObject({
      final: true, failFast: true, concurrency: 3, timeoutMs: 8000, maxRuntimeMs: 30000, budget: 2.5,
    });
    expect(parseDevTestArgs(['a.md', '--no-fail-fast'])).toMatchObject({ failFast: false });
    expect(parseDevTestArgs(['a.md'])).toMatchObject({ failFast: true, timeoutMs: 10_000 });
    expect(parseDevTestArgs(['a.md', '--summary', '--deep'])).toMatchObject({ summary: true, deep: true });
    expect(() => parseDevTestArgs(['a.md', '--final', '--plan'])).toThrow('DEVTEST_ARG_CONFLICT');
    expect(() => parseDevTestArgs(['a.md', '--final', '--repro', 'P001'])).toThrow('DEVTEST_ARG_CONFLICT');
    expect(() => parseDevTestArgs(['a.md', '--concurrency', '9'])).toThrow('DEVTEST_ARG_INVALID');
    expect(() => parseDevTestArgs(['a.md', '--max-runtime', '0'])).toThrow('DEVTEST_ARG_INVALID');
    expect(() => parseDevTestArgs(['a.md', '--budget', '-1'])).toThrow('DEVTEST_ARG_INVALID');
    expect(() => parseDevTestArgs(['a.md', '--fail-fast', '--no-fail-fast'])).toThrow('DEVTEST_ARG_CONFLICT');
  });

  it('不存在文件返回配置错误且不抛出未处理异常', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(main(['/definitely/missing/devtest-requirement.md', '--mode', 'dry-run'])).resolves.toBe(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('DEVTEST_REQUIREMENT_NOT_FOUND'));
    error.mockRestore();
  });

  it('CLI 只有 READY 返回成功，NOT_READY/BLOCKED 均 fail-closed', () => {
    expect(devTestExitCode('READY')).toBe(0);
    expect(devTestExitCode('NOT_READY')).toBe(1);
    expect(devTestExitCode('BLOCKED')).toBe(1);
  });
});
