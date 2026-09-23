import { describe, it, expect, afterEach, vi } from 'vitest';

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('Framework-Level Failure Isolation Proof Fixture', () => {
  it('case_fail_dirty: mutates global fetch and process.env then fails directly', () => {
    global.fetch = vi.fn().mockImplementation(async () => new Response('leaked_from_failing_case'));
    vi.stubEnv('DIRTY_TEST_ENV_KEY', 'LEAKED_DIRTY_VALUE');
    // Direct assertion failure - NO try/finally inside this test!
    expect('dirty_state_actual').toBe('expected_mismatch_to_trigger_failure');
  });

  it('case_verify_clean: confirms top-level afterEach cleaned up after previous test failure', () => {
    // Assert global.fetch is completely restored
    expect(vi.isMockFunction(global.fetch)).toBe(false);
    expect(global.fetch).toBe(originalFetch);

    // Assert process.env is completely unstubbed
    expect(process.env.DIRTY_TEST_ENV_KEY).toBeUndefined();
  });
});
