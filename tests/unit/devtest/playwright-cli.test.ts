import { describe, expect, it, vi } from 'vitest';
import { main, parseCliArgs } from '../../../src/devtest/run-playwright-cli.js';
import { DEVTEST_HELP, main as devtest } from '../../../bin/run-devtest.js';

describe('Playwright CLI integration', () => {
  it('supports the complete CLI options and a session path without embedding secrets', () => {
    const options = parseCliArgs(['--media', 'image', '--mode', 'browser', '--task-id', '123',
      '--model', '12', '--session-file', '/tmp/panqu-session.json', '--expect-failure']);
    expect(options).toMatchObject({ mediaType: 'image', executionMode: 'UI_E2E', taskId: 123,
      modelId: 12, sessionFile: '/tmp/panqu-session.json', expectFailure: true });
  });
  it('does not let a later mode option override explicit mock intent', () => {
    expect(parseCliArgs(['--mock', '--mode', 'api']).executionMode).toBe('MOCK');
    expect(parseCliArgs(['--mode', 'browser', '--mock']).useBrowserPage).toBe(false);
  });
  it.each([['--unknown'], ['--media'], ['--media', 'audio'], ['--mode', 'typo'],
    ['--env', 'production'], ['--model', 'NaN'], ['--session-file', 'relative.json']])('rejects invalid arguments %j', (...args) => {
    expect(() => parseCliArgs(args)).toThrow('PLAYWRIGHT_ARG_INVALID');
  });
  it('help is read-only through both the standalone and devtest entry points', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('NO_NETWORK_ALLOWED'));
    try {
      expect(await main(['--help'])).toBe(0);
      expect(await devtest(['playwright', '--help'])).toBe(0);
      expect(network).not.toHaveBeenCalled();
      expect(log.mock.calls.flat().join('\n')).toContain('--session-file');
      expect(DEVTEST_HELP).toContain('diversion|playwright');
    } finally { log.mockRestore(); network.mockRestore(); }
  });
});
