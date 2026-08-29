// stdio MCP 子进程级测试：验证「tools/call 后立即关闭 stdin，仍收到且只收到一个完整、可解析的 JSON-RPC 响应」，
// 以及优雅退出不会在 stdout flush 前丢失最后响应。
// 需要先 `npm run build`（stdio 服务会调用 dist/bin/run-plan.js）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const STDIO_SERVER = path.join(ROOT, 'mcp-bridge', 'trae-test-mcp-stdio.js');

const tmpDirs: string[] = [];
function newTmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'stdio-mcp-'));
  tmpDirs.push(d);
  return d;
}

beforeAll(() => {
  expect(fs.existsSync(STDIO_SERVER), 'stdio 服务脚本应存在').toBe(true);
});

afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

function plan(): Record<string, unknown> {
  return {
    requirement_summary: 'stdio flush 冒烟',
    target_url: 'https://api.example.com/',
    environment: 'test',
    test_scope: 'api',
    test_cases: [
      {
        id: 'C1',
        name: '健康检查',
        priority: 'P0',
        type: 'API',
        steps: [{ type: 'HTTP_REQUEST', method: 'GET', url: '/x' }],
        assertions: [{ type: 'STATUS_CODE', operator: 'equals', expected: 200 }],
      },
    ],
    risks: [],
  };
}

function callStdio(lines: string[], tmpDir: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [STDIO_SERVER], {
      cwd: ROOT,
      env: {
        ...process.env,
        TESTFLOW_OUTPUT_DIR: tmpDir,
        TESTFLOW_ALLOWED_TARGET_ORIGINS: 'https://api.example.com',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.on('error', (e) => resolve({ code: null, stdout, stderr: stderr + String(e && e.message ? e.message : e) }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    for (const l of lines) child.stdin.write(`${l}\n`);
    child.stdin.end(); // 立即关闭 stdin，验证最后响应仍被 flush。
  });
}

describe('stdio MCP：最后响应不丢失', () => {
  it('发出 tools/call(execute_test_plan, action=plan) 后立即关闭 stdin，仍收到且只收到一个完整可解析响应', async () => {
    const tmp = newTmpDir();
    const argumentsObj = { action: 'plan', plan: plan() };
    const { stdout } = await callStdio([
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'execute_test_plan', arguments: argumentsObj } }),
    ], tmp);

    const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
    expect(lines.length).toBe(1);

    const resp = JSON.parse(lines[0]);
    expect(resp.jsonrpc).toBe('2.0');
    expect(resp.id).toBe(1);
    expect(resp.result).toBeTruthy();
    expect(resp.result?.structuredContent?.ok).toBe(true);
    expect(resp.result?.structuredContent?.plan_id).toBeTruthy();
  });
});