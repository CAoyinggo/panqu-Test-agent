import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {
  RecordSession,
  ReplaySession,
  createRecordSession,
  createReplaySession,
  type Fixture,
} from '../../src/utils/mock-recorder.js';

// 辅助：创建临时目录
function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mock-test-'));
}

// 辅助：创建模拟 Response 对象
function makeResponse(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

describe('Mock Recorder', () => {
  let tempDir: string;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    tempDir = tmpDir();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    // 确保恢复原始 fetch
    globalThis.fetch = originalFetch;
    // 清理临时目录
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('RecordSession', () => {
    it('starts and stops recording', () => {
      const session = createRecordSession(tempDir);
      session.start();
      // fetch should be patched
      expect(globalThis.fetch).not.toBe(originalFetch);
      session.stop();
      // fetch should be restored
      expect(globalThis.fetch).toBe(originalFetch);
    });

    it('records fixtures from fetch calls', async () => {
      // Set up mock BEFORE creating session
      const fakeResponse = makeResponse(JSON.stringify({ code: 1, data: { id: 123 } }), 200, { 'content-type': 'application/json' });
      globalThis.fetch = vi.fn().mockResolvedValue(fakeResponse) as any;

      const session = createRecordSession(tempDir);
      session.start();

      // Make a request
      await fetch('https://api.example.com/users/1', {
        method: 'GET',
        headers: { 'x-custom': 'value' },
      });

      const fixtures = session.stop();
      expect(fixtures.length).toBe(1);
      expect(fixtures[0].request.url).toBe('https://api.example.com/users/1');
      expect(fixtures[0].request.method).toBe('GET');
      expect(fixtures[0].response.status).toBe(200);
      expect(fixtures[0].response.body).toEqual({ code: 1, data: { id: 123 } });
    });

    it('saves fixtures to file on stop', () => {
      const session = createRecordSession(tempDir);
      session.start();
      session.stop();

      const fixtureFile = path.join(tempDir, 'fixtures.json');
      expect(fs.existsSync(fixtureFile)).toBe(true);

      const content = JSON.parse(fs.readFileSync(fixtureFile, 'utf-8'));
      expect(Array.isArray(content)).toBe(true);
    });

    it('filters by URL pattern', async () => {
      const fakeResponse = makeResponse('{"ok":true}', 200);
      globalThis.fetch = vi.fn().mockResolvedValue(fakeResponse) as any;

      const session = createRecordSession(tempDir, {
        urlFilter: /api\.example\.com/,
      });
      session.start();

      // Matching URL
      await fetch('https://api.example.com/test');

      // Non-matching URL (should pass through, not recorded)
      await fetch('https://other.com/test');

      const fixtures = session.stop();
      // Only the matching URL should be recorded
      // (the non-matching one goes through to originalFetch)
      expect(fixtures.length).toBe(1);
      expect(fixtures[0].request.url).toBe('https://api.example.com/test');
    });

    it('filters sensitive headers', async () => {
      const fakeResponse = makeResponse('{}', 200);
      globalThis.fetch = vi.fn().mockResolvedValue(fakeResponse) as any;

      const session = createRecordSession(tempDir, {
        headerFilter: ['cookie', 'authorization'],
      });
      session.start();

      await fetch('https://api.example.com/test', {
        headers: {
          'cookie': 'session=abc',
          'authorization': 'Bearer token',
          'x-custom': 'keep-me',
        },
      });

      const fixtures = session.stop();
      expect(fixtures[0].request.headers).not.toHaveProperty('cookie');
      expect(fixtures[0].request.headers).not.toHaveProperty('authorization');
      expect(fixtures[0].request.headers['x-custom']).toBe('keep-me');
    });

    it('records POST body', async () => {
      const fakeResponse = makeResponse('{}', 201);
      globalThis.fetch = vi.fn().mockResolvedValue(fakeResponse) as any;

      const session = createRecordSession(tempDir);
      session.start();

      await fetch('https://api.example.com/users', {
        method: 'POST',
        body: JSON.stringify({ name: 'Alice', age: 30 }),
        headers: { 'content-type': 'application/json' },
      });

      const fixtures = session.stop();
      expect(fixtures[0].request.method).toBe('POST');
      expect(fixtures[0].request.body).toEqual({ name: 'Alice', age: 30 });
    });
  });

  describe('ReplaySession', () => {
    it('loads fixtures from directory', () => {
      // Create a fixture file
      const fixture: Fixture = {
        id: 'test-1',
        request: {
          url: 'https://api.example.com/users/1',
          method: 'GET',
          headers: {},
        },
        response: {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
          body: { id: 1, name: 'Alice' },
          durationMs: 50,
        },
        recordedAt: new Date().toISOString(),
        bodyHash: '',
      };

      fs.writeFileSync(
        path.join(tempDir, 'fixtures.json'),
        JSON.stringify([fixture]),
      );

      const session = createReplaySession(tempDir);
      session.start();

      // fetch should be patched
      expect(globalThis.fetch).not.toBe(originalFetch);

      session.stop();
    });

    it('returns recorded response on match', async () => {
      const fixture: Fixture = {
        id: 'test-2',
        request: {
          url: 'https://api.example.com/users/1',
          method: 'GET',
          headers: {},
        },
        response: {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
          body: { id: 1, name: 'Alice' },
          durationMs: 50,
        },
        recordedAt: new Date().toISOString(),
        bodyHash: '',
      };

      fs.writeFileSync(
        path.join(tempDir, 'fixtures.json'),
        JSON.stringify([fixture]),
      );

      const session = createReplaySession(tempDir);
      session.start();

      const res = await fetch('https://api.example.com/users/1', { method: 'GET' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ id: 1, name: 'Alice' });

      session.stop();
    });

    it('returns 404 on miss with skip strategy', async () => {
      const session = createReplaySession(tempDir, {
        onMissing: 'skip',
      });
      session.start();

      const res = await fetch('https://api.example.com/nonexistent', { method: 'GET' });
      expect(res.status).toBe(404);

      session.stop();
    });

    it('throws on miss with error strategy', async () => {
      const session = createReplaySession(tempDir, {
        onMissing: 'error',
      });
      session.start();

      await expect(
        fetch('https://api.example.com/nonexistent', { method: 'GET' }),
      ).rejects.toThrow('Mock fixture 未找到');

      session.stop();
    });

    it('passthrough on miss with passthrough strategy', async () => {
      const fakeResponse = makeResponse('{"real":true}', 200);
      globalThis.fetch = vi.fn().mockResolvedValue(fakeResponse) as any;

      const session = createReplaySession(tempDir, {
        onMissing: 'passthrough',
      });
      session.start();

      const res = await fetch('https://api.example.com/nonexistent', { method: 'GET' });
      expect(res.status).toBe(200);

      session.stop();
    });

    it('matches POST with body in strict mode', async () => {
      const body = { name: 'Alice' };
      const bodyHash = crypto
        .createHash('sha256')
        .update(JSON.stringify(body))
        .digest('hex')
        .slice(0, 16);

      const fixture: Fixture = {
        id: 'test-3',
        request: {
          url: 'https://api.example.com/users',
          method: 'POST',
          headers: {},
          body,
        },
        response: {
          status: 201,
          statusText: 'Created',
          headers: {},
          body: { id: 1 },
          durationMs: 30,
        },
        recordedAt: new Date().toISOString(),
        bodyHash,
      };

      fs.writeFileSync(
        path.join(tempDir, 'fixtures.json'),
        JSON.stringify([fixture]),
      );

      const session = createReplaySession(tempDir, {
        matchStrategy: 'strict',
        onMissing: 'error',
      });
      session.start();

      // Matching body
      const res = await fetch('https://api.example.com/users', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      });
      expect(res.status).toBe(201);

      session.stop();
    });

    it('stop returns match/miss statistics', async () => {
      const fixture: Fixture = {
        id: 'test-4',
        request: {
          url: 'https://api.example.com/hit',
          method: 'GET',
          headers: {},
        },
        response: {
          status: 200,
          statusText: 'OK',
          headers: {},
          body: {},
          durationMs: 10,
        },
        recordedAt: new Date().toISOString(),
        bodyHash: '',
      };

      fs.writeFileSync(
        path.join(tempDir, 'fixtures.json'),
        JSON.stringify([fixture]),
      );

      const session = createReplaySession(tempDir, { onMissing: 'skip' });
      session.start();

      await fetch('https://api.example.com/hit', { method: 'GET' });
      await fetch('https://api.example.com/miss', { method: 'GET' });

      const stats = session.stop();
      expect(stats.matched).toBe(1);
      expect(stats.missed).toBe(1);
    });
  });

  describe('fetch restoration safety', () => {
    it('restores original fetch even if stop called twice', () => {
      const session = createRecordSession(tempDir);
      session.start();
      session.stop();
      session.stop(); // double stop should not crash
      expect(globalThis.fetch).toBe(originalFetch);
    });

    it('replay session restores fetch on stop', () => {
      const session = createReplaySession(tempDir);
      session.start();
      expect(globalThis.fetch).not.toBe(originalFetch);
      session.stop();
      expect(globalThis.fetch).toBe(originalFetch);
    });
  });
});
