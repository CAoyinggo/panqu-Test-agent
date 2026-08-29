// stdio MCP 仓库内可移植性测试：
// 1) 从与仓库无关的 cwd 启动仓库内 stdio Server；2) initialize 成功；3) tools/list 只有 execute_test_plan；
// 4) action=plan 返回 plan_id/run_id/plan_hash；5) tools/call 后立即关闭 stdin 最后响应不丢失；
// 6) dist/bin/run-plan.js 缺失时 fail-closed 且不回退旧路径；7) 仓库内 MCP 资产不含个人绝对路径；
// 8) 精确解析 .trae/mcp.json；9) 真正 relocated repository（走 fake dist，返回唯一标记）。
// 本测试只依赖 test-flow 仓库内资产，不依赖仓库外 /Users/mac/agents/mcp-bridge。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const STDIO_SERVER = path.join(ROOT, 'mcp-bridge', 'trae-test-mcp-stdio.js');
const SCHEMA_FILE = path.join(ROOT, 'mcp-bridge', 'execute-test-plan-schema.js');
const PROMPT_FILE = path.join(ROOT, 'mcp-bridge', 'PANQU_TRAE_AGENT_PROMPT.md');
const MCP_JSON = path.join(ROOT, '.trae', 'mcp.json');
const BRIDGE_PACKAGE = path.join(ROOT, 'mcp-bridge', 'package.json');

// relocated 测试的 fake 执行器唯一标记（不得与真实 run-plan 输出混淆）。
const FAKE_MARKER = 'RELOCATED_FAKE_RUNPLAN_MARKER_7f3a9c1e';

const tmpDirs: string[] = [];
function newTmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'stdio-portable-'));
  tmpDirs.push(d);
  return d;
}

// 与仓库无关的 cwd（非 test-flow 根目录）。
const IRRELEVANT_CWD = newTmpDir();

afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

function plan(): Record<string, unknown> {
  return {
    requirement_summary: '仓库内可移植性冒烟',
    target_url: 'https://api.example.com/',
    environment: 'test',
    test_scope: 'api',
    test_cases: [
      {
        id: 'C1',
        name: '健康检查',
        priority: 'P1',
        type: 'API',
        steps: [{ type: 'HTTP_REQUEST', method: 'GET', url: '/x' }],
        assertions: [{ type: 'STATUS_CODE', operator: 'equals', expected: 200 }],
      },
    ],
    risks: [],
  };
}

// 确定性 fake run-plan：返回唯一搬迁标记，不发网络请求。
function fakeRunPlanScript(): string {
  return [
    '#!/usr/bin/env node',
    "'use strict';",
    `const MARKER = '${FAKE_MARKER}';`,
    'process.stdin.resume();',
    "process.stdin.on('end', () => {",
    '  const out = {',
    "    ok: true,",
    "    plan_id: 'plan-fake-' + MARKER,",
    "    run_id: 'run-fake-' + MARKER,",
    "    plan_hash: 'f'.repeat(64),",
    '    case_summary: { cases_total: 1, executable: 1, designed_only: 0, marker: MARKER },',
    '    risk_summary: { risks_total: 0, levels: {}, marker: MARKER },',
    "    message: 'fake run-plan marker=' + MARKER,",
    '  };',
    "  process.stdout.write(JSON.stringify(out) + '\\n');",
    '});',
    '',
  ].join('\n');
}

function callStdio(
  cwd: string,
  lines: string[],
  env: Record<string, string>,
  serverPath: string = STDIO_SERVER,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [serverPath], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.on('error', (e) => resolve({ code: null, stdout, stderr: stderr + String(e && e.message ? e.message : e) }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    for (const l of lines) child.stdin.write(`${l}\n`);
    child.stdin.end();
  });
}

function parseLines(stdout: string): Record<string, unknown>[] {
  return stdout.split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('stdio MCP：仓库内可移植性', () => {
  beforeAll(() => {
    expect(fs.existsSync(STDIO_SERVER), '仓库内 stdio 服务脚本应存在').toBe(true);
    expect(fs.existsSync(MCP_JSON), '仓库内 .trae/mcp.json 应存在').toBe(true);
  });

  it('仓库内 MCP 资产（stdio/schema/prompt/.trae/mcp.json）不含个人绝对路径', () => {
    const assets = [STDIO_SERVER, SCHEMA_FILE, PROMPT_FILE, MCP_JSON];
    for (const asset of assets) {
      const content = fs.readFileSync(asset, 'utf8');
      expect(content, `${path.basename(asset)} 不应包含 /Users/mac`).not.toContain('/Users/mac');
      expect(content, `${path.basename(asset)} 不应包含 /usr/local/bin/node`).not.toContain('/usr/local/bin/node');
    }
  });

  it('精确解析 .trae/mcp.json：唯一 panqu-test-mcp 且 command/args/env 严格匹配', () => {
    const raw = fs.readFileSync(MCP_JSON, 'utf8');
    let p: Record<string, unknown> = {};
    expect(() => { p = JSON.parse(raw) as Record<string, unknown>; }).not.toThrow();
    // 拒绝顶层未知字段漂移：顶层键严格只有 mcpServers。
    expect(Object.keys(p).sort()).toEqual(['mcpServers']);
    const mcpServers = p.mcpServers as Record<string, Record<string, unknown>>;
    expect(Object.keys(mcpServers)).toEqual(['panqu-test-mcp']);
    const cfg = mcpServers['panqu-test-mcp'];
    // 拒绝 server 级未知字段漂移：config 键严格只有 args/command/env。
    expect(Object.keys(cfg).sort()).toEqual(['args', 'command', 'env']);
    expect(cfg.command).toBe('node');
    expect(cfg.args).toEqual(['${workspaceFolder}/mcp-bridge/trae-test-mcp-stdio.js']);
    const env = cfg.env as Record<string, unknown>;
    // 拒绝 env 级未知字段漂移：env 键严格只有 TESTFLOW_ALLOWED_TARGET_ORIGINS。
    expect(Object.keys(env).sort()).toEqual(['TESTFLOW_ALLOWED_TARGET_ORIGINS']);
    expect(env.TESTFLOW_ALLOWED_TARGET_ORIGINS).toBe('https://test.panqu.com');
  });

  it('从与仓库无关的 cwd 启动，initialize 成功', async () => {
    const { stdout } = await callStdio(
      IRRELEVANT_CWD,
      [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })],
      {},
    );
    const responses = parseLines(stdout);
    expect(responses.length).toBeGreaterThanOrEqual(1);
    const init = responses[0];
    expect(init.result).toBeTruthy();
    const result = init.result as Record<string, unknown>;
    expect(result.protocolVersion).toBeTruthy();
    expect(result.serverInfo).toBeTruthy();
  });

  it('tools/list 只暴露 execute_test_plan', async () => {
    const { stdout } = await callStdio(
      IRRELEVANT_CWD,
      [JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })],
      {},
    );
    const responses = parseLines(stdout);
    const list = responses.find((r) => r.id === 2);
    expect(list).toBeTruthy();
    const result = (list as Record<string, unknown>).result as Record<string, unknown>;
    const tools = result.tools as Array<{ name: string }>;
    expect(tools.map((t) => t.name)).toEqual(['execute_test_plan']);
  });

  it('action=plan 返回 plan_id、run_id、plan_hash', async () => {
    const tmp = newTmpDir();
    const call = JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'execute_test_plan', arguments: { action: 'plan', plan: plan() } },
    });
    const { stdout } = await callStdio(
      IRRELEVANT_CWD,
      [call],
      { TESTFLOW_OUTPUT_DIR: tmp, TESTFLOW_ALLOWED_TARGET_ORIGINS: 'https://api.example.com' },
    );
    const responses = parseLines(stdout);
    const resp = responses.find((r) => r.id === 3);
    expect(resp).toBeTruthy();
    const result = (resp as Record<string, unknown>).result as Record<string, unknown>;
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc.ok).toBe(true);
    expect(sc.plan_id).toBeTruthy();
    expect(sc.run_id).toBeTruthy();
    expect(sc.plan_hash).toBeTruthy();
  });

  it('tools/call 后立即关闭 stdin，最后响应不丢失', async () => {
    const tmp = newTmpDir();
    const call = JSON.stringify({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'execute_test_plan', arguments: { action: 'plan', plan: plan() } },
    });
    const { stdout } = await callStdio(
      IRRELEVANT_CWD,
      [call], // 单条请求，写完立即关 stdin。
      { TESTFLOW_OUTPUT_DIR: tmp, TESTFLOW_ALLOWED_TARGET_ORIGINS: 'https://api.example.com' },
    );
    const responses = parseLines(stdout);
    expect(responses.length).toBe(1);
    const resp = responses[0];
    expect(resp.id).toBe(4);
    expect(resp.result).toBeTruthy();
  });

  it('dist/bin/run-plan.js 缺失时 fail-closed，且不回退旧路径', async () => {
    // 在临时目录构造一个「无 dist」的最小仓库：只复制 stdio 与 schema，不创建 dist。
    const fakeRoot = newTmpDir();
    const fakeBridge = path.join(fakeRoot, 'mcp-bridge');
    fs.mkdirSync(fakeBridge, { recursive: true });
    fs.copyFileSync(STDIO_SERVER, path.join(fakeBridge, 'trae-test-mcp-stdio.js'));
    fs.copyFileSync(SCHEMA_FILE, path.join(fakeBridge, 'execute-test-plan-schema.js'));

    const { code, stderr } = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [path.join(fakeBridge, 'trae-test-mcp-stdio.js')], {
        cwd: fakeRoot,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (c) => { stderr += c.toString(); });
      child.on('error', () => resolve({ code: null, stderr }));
      child.on('close', (c) => resolve({ code: c, stderr }));
      child.stdin.end();
    });

    // 无 dist 时进程应立即以非零状态退出，不能正常 start。
    expect(code).not.toBe(0);
    expect(code).not.toBeNull();
    // 必须给出明确提示：请先执行 npm run build，且不得回退到任何仓库外旧路径。
    expect(stderr).toContain('请先在 test-flow 仓库执行 npm run build');
  });

  it('真正 relocated repository：ESM 父包 + CommonJS bridge，正负例均走 fake dist', async () => {
    // 构造真正的临时仓库根：父包声明 ESM（type=module），mcp-bridge 目录声明 CommonJS（type=commonjs）。
    const fakeRoot = newTmpDir();
    fs.writeFileSync(path.join(fakeRoot, 'package.json'), JSON.stringify({ type: 'module' }));
    const fakeBridge = path.join(fakeRoot, 'mcp-bridge');
    fs.mkdirSync(fakeBridge, { recursive: true });
    fs.copyFileSync(STDIO_SERVER, path.join(fakeBridge, 'trae-test-mcp-stdio.js'));
    fs.copyFileSync(SCHEMA_FILE, path.join(fakeBridge, 'execute-test-plan-schema.js'));
    // 复制真实仓库的 mcp-bridge/package.json（含 {"type":"commonjs"}）。
    const bridgePkgDest = path.join(fakeBridge, 'package.json');
    fs.copyFileSync(BRIDGE_PACKAGE, bridgePkgDest);

    // 断言被复制的 bridge package 内容为 CommonJS（父包 ESM 下必须显式声明，否则 require 不可用）。
    const bridgePkgContent = fs.readFileSync(bridgePkgDest, 'utf8');
    expect(JSON.parse(bridgePkgContent)).toEqual({ type: 'commonjs' });

    // 提供 fake dist/bin/run-plan.js：负例失败必须来自模块类型不兼容，而非 dist 缺失。
    const fakeDist = path.join(fakeRoot, 'dist', 'bin');
    fs.mkdirSync(fakeDist, { recursive: true });
    fs.writeFileSync(path.join(fakeDist, 'run-plan.js'), fakeRunPlanScript());

    // 第三个与临时仓库、真实仓库都无关的 cwd。
    const thirdCwd = newTmpDir();
    const tmpOut = newTmpDir();
    const fakeServer = path.join(fakeBridge, 'trae-test-mcp-stdio.js');

    // 负例：删除 mcp-bridge/package.json，父包 type=module → stdio .js 被当作 ESM，require 不可用。
    fs.unlinkSync(bridgePkgDest);
    const neg = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [fakeServer], {
        cwd: thirdCwd,
        env: { ...process.env, TESTFLOW_OUTPUT_DIR: tmpOut, TESTFLOW_ALLOWED_TARGET_ORIGINS: 'https://api.example.com' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (c) => { stderr += c.toString(); });
      child.on('error', () => resolve({ code: null, stderr }));
      child.on('close', (c) => resolve({ code: c, stderr }));
      child.stdin.end();
    });
    expect(neg.code).not.toBe(0);
    expect(neg.code).not.toBeNull();
    // stderr 必须体现 CommonJS/require/module 类型不兼容（而非 dist 缺失的提示）。
    expect(neg.stderr).toMatch(/require is not defined/);

    // 正例：恢复 mcp-bridge/package.json 后，从第三个无关 cwd 启动，走 fake dist 返回唯一标记。
    fs.writeFileSync(bridgePkgDest, bridgePkgContent);

    const lines = [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'execute_test_plan', arguments: { action: 'plan', plan: plan() } },
      }),
    ];

    const { stdout, code } = await callStdio(
      thirdCwd,
      lines,
      { TESTFLOW_OUTPUT_DIR: tmpOut, TESTFLOW_ALLOWED_TARGET_ORIGINS: 'https://api.example.com' },
      fakeServer,
    );
    expect(code).toBe(0);
    const responses = parseLines(stdout);

    const init = responses.find((r) => r.id === 1);
    expect(init).toBeTruthy();
    expect((init as Record<string, unknown>).result).toBeTruthy();

    const list = responses.find((r) => r.id === 2);
    const listResult = (list as Record<string, unknown>).result as Record<string, unknown>;
    const tools = listResult.tools as Array<{ name: string }>;
    expect(tools.map((t) => t.name)).toEqual(['execute_test_plan']);

    const planRes = responses.find((r) => r.id === 3);
    expect(planRes).toBeTruthy();
    const planResResult = (planRes as Record<string, unknown>).result as Record<string, unknown>;
    const sc = planResResult.structuredContent as Record<string, unknown>;
    expect(sc.ok).toBe(true);
    // 证明走的是临时仓库 fake run-plan（唯一标记），而非当前真实仓库 dist，也不访问 legacy MCP。
    expect(String(sc.plan_id ?? '')).toContain(FAKE_MARKER);
    expect(String(sc.run_id ?? '')).toContain(FAKE_MARKER);
    expect(stdout).toContain(FAKE_MARKER);
  });
});