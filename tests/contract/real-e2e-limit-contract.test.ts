import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LoadedCase } from '../../src/cases/loader.js';

const realProbe = vi.hoisted(() => ({ submits: 0, statusReads: 0, billingReads: 0 }));

vi.mock('../e2e/real/real-env.js', () => ({
  REAL_ENABLED: false,
  REAL_SUBMIT: false,
  getRealEnv: () => ({
    projectId: 1,
    csrfPage: '/csrf',
    submitUrl: '/submit',
    statusUrl: '/status',
    http: {
      getCsrfToken: async () => 'csrf-token',
      api: async (name: string) => {
        if (name === '真实提交') {
          realProbe.submits += 1;
          return { json: { code: 1, data: { id: 'task-1' } } };
        }
        realProbe.statusReads += 1;
        return { json: { data: [{ status: 'created', progress: 0 }] } };
      },
    },
    billing: {
      summary: async () => {
        realProbe.billingReads += 1;
        return {};
      },
    },
  }),
}));

import { realSmokeRunner } from '../e2e/real/real-agent-e2e.test.js';

function cases(count: number): LoadedCase[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `real-limit-${index + 1}`,
    feature: 'wan3',
    file: '<contract>',
    def: {
      name: `real-limit-${index + 1}`,
      scene: 'video',
      extra: { agentTestCaseId: `real-limit-${index + 1}` },
    },
  }));
}

afterEach(() => {
  vi.unstubAllEnvs();
  realProbe.submits = 0;
  realProbe.statusReads = 0;
  realProbe.billingReads = 0;
});

describe('Real E2E execution limit contract', () => {
  it('[P0-05] REAL_E2E_MAX_CASES=1 executes one case and marks four NOT_EXECUTED', async () => {
    vi.stubEnv('REAL_E2E_MAX_CASES', '1');

    const outcome = await realSmokeRunner(cases(5), { env: 'test' });
    const submitted = outcome.results.filter((item) => item.checks?.some((check) => check.name === 'real-submit'));
    const limited = outcome.results.filter((item) => item.checks?.some((check) => check.name === 'real-smoke-skip'));

    expect(realProbe).toEqual({ submits: 1, statusReads: 1, billingReads: 1 });
    expect(submitted).toHaveLength(1);
    expect(limited).toHaveLength(4);
    expect(limited.every((item) => item.executed === false && item.status === 'NOT_EXECUTED' && item.pass === false)).toBe(true);
    expect(outcome.passed).toBe(1);
  });
});
