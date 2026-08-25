import { describe, expect, it } from 'vitest';
import { AcceptanceCliError, parseAcceptanceCliArgs, runAcceptanceCli } from '../../src/acceptance/acceptance-cli.js';

describe('Acceptance CLI contract', () => {
  it('supports required input, scope, config and rerun parameters', () => {
    expect(parseAcceptanceCliArgs([
      '--requirement', 'req.md', '--output=reports', '--project', 'users', '--environment', 'test',
      '--mode', 'execute', '--scope', 'AC-1,PERMISSION', '--config', 'acceptance.config.json',
      '--max-cases', '200', '--deadline=30000',
    ])).toMatchObject({ requirement: 'req.md', output: 'reports', project: 'users', environment: 'test', mode: 'execute', scope: ['AC-1', 'PERMISSION'], maxCases: 200, deadlineMs: 30000 });
    expect(parseAcceptanceCliArgs(['--run-id', 'RUN-01ARZ3NDEKTSV4RRFFQ69G5FAV', '--case-id', 'API-001'])).toMatchObject({ caseId: 'API-001' });
    expect(parseAcceptanceCliArgs(['--run-id', 'RUN-01ARZ3NDEKTSV4RRFFQ69G5FAV', '--regression']))
      .toMatchObject({ runId: 'RUN-01ARZ3NDEKTSV4RRFFQ69G5FAV', regression: true });
  });

  it('rejects unknown, duplicate, missing, conflicting and invalid arguments', () => {
    expect(() => parseAcceptanceCliArgs(['--unknown'])).toThrow(AcceptanceCliError);
    expect(() => parseAcceptanceCliArgs(['--text', 'a', '--text', 'b'])).toThrow('参数重复');
    expect(() => parseAcceptanceCliArgs(['--requirement', 'a', '--text', 'b'])).toThrow('必须且只能提供');
    expect(() => parseAcceptanceCliArgs(['--case-id', 'API-001', '--text', 'a'])).toThrow('--case-id 必须');
    expect(() => parseAcceptanceCliArgs(['--text', 'a', '--mode', 'unsafe'])).toThrow('--mode 仅支持');
    expect(() => parseAcceptanceCliArgs(['--text', 'a', '--max-cases', '0'])).toThrow('--max-cases 必须');
    expect(() => parseAcceptanceCliArgs(['--text', 'a', '--deadline', 'nope'])).toThrow('--deadline 必须');
    expect(() => parseAcceptanceCliArgs(['--text', 'a', '--regression'])).toThrow('--regression 必须');
    expect(() => parseAcceptanceCliArgs(['--run-id', 'RUN-01ARZ3NDEKTSV4RRFFQ69G5FAV', '--case-id', 'CASE-1', '--regression']))
      .toThrow('--regression 与 --case-id 互斥');
    expect(() => parseAcceptanceCliArgs(['--run-id', 'RUN-01ARZ3NDEKTSV4RRFFQ69G5FAV', '--regression', '--scope', 'P0']))
      .toThrow('不能再用 --scope');
  });

  it('fails with a clear configuration error rather than using strange defaults', async () => {
    await expect(runAcceptanceCli(['--text', '# A\nGET /a\nAC-1 返回 200'], {})).rejects.toThrow('缺少 output');
    await expect(runAcceptanceCli(['--text', '# A', '--output', 'tmp'], {
      ACCEPTANCE_PROJECT: 'p', ACCEPTANCE_ENVIRONMENT: 'production', ACCEPTANCE_MODE: 'execute', ACCEPTANCE_BASE_URL: 'http://127.0.0.1',
    })).rejects.toThrow('默认禁止直接在 production');
    await expect(runAcceptanceCli(['--text', '# A\nGET /a\nAC-1 返回 200', '--output', 'tmp'], {
      ACCEPTANCE_PROJECT: 'p', ACCEPTANCE_ENVIRONMENT: 'staging', ACCEPTANCE_MODE: 'execute', ACCEPTANCE_BASE_URL: 'http://127.0.0.1',
    })).rejects.toThrow('未进入 Acceptance 执行 Allowlist');
  });
});
