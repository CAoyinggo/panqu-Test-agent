#!/usr/bin/env node
'use strict';

/**
 * trae-test-mcp-stdio.js — Trae 原生 stdio MCP Server（零 HTTP、零 LLM、零密钥、零 DeepSeek）。
 *
 * 安全约定（服务端强制，不依赖人设）：
 *   - stdout 只输出 MCP JSON-RPC（换行分隔，每行一个 JSON 对象）；所有日志只写 stderr。
 *   - 只暴露 execute_test_plan 一个工具，action 仅 plan/execute/status。
 *   - 相对本文件所在仓库解析 dist/bin/run-plan.js（不使用任何个人绝对路径）；
 *     使用 process.execPath + 固定入口，shell=false，不接受命令 / cwd / 脚本路径 / 输出路径。
 *   - 不读取任何 LLM_* / 模型密钥 / Keychain / DeepSeek 配置。
 *   - 顶层入参严格白名单校验，拒绝未知字段与敏感凭据字段。
 */

const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('child_process');
const readline = require('readline');
const {
  EXECUTE_TEST_PLAN_TOOL,
  PLAN_ACTIONS,
  PLAN_TOP_LEVEL_KEYS,
  PLAN_SENSITIVE_FIELD,
} = require('./execute-test-plan-schema.js');

// ===== 路径解析（相对本文件所在仓库根，禁止硬编码个人绝对路径）=====
const REPO_ROOT = path.resolve(__dirname, '..');
const CWD = REPO_ROOT;
const RUN_PLAN_ENTRY = path.join(REPO_ROOT, 'dist', 'bin', 'run-plan.js');

// 启动前校验执行器入口存在；缺失则 fail-closed，不回退任何仓库外旧路径、不启动其它程序。
if (!fs.existsSync(RUN_PLAN_ENTRY)) {
  process.stderr.write('[trae-test-mcp-stdio] 请先在 test-flow 仓库执行 npm run build\n');
  process.exit(1);
}

// ===== 枚举 =====
const LEGACY_TOOL_NAME = 'run_requirement_test';
const TOOL_NAME = EXECUTE_TEST_PLAN_TOOL.name;

// ===== 限制 =====
const EXEC_TIMEOUT = 30 * 60 * 1000; // 30 分钟
const MAX_CONCURRENCY = 2;           // 最大并发执行数（默认 2）
const MAX_STDOUT = 5 * 1024 * 1024;
const MAX_STDERR = 1024 * 1024;
const MAX_SAFE_TOKEN_LENGTH = 200;
const MAX_PLAN_BYTES = 10 * 1024 * 1024;

// ===== 工具定义（唯一暴露，来自共享 Schema 模块 execute-test-plan-schema.js）=====

// ===== 输出 / 日志 =====
function log(...args) {
  // eslint-disable-next-line no-console
  process.stderr.write(`[trae-test-mcp-stdio] ${args.map(String).join(' ')}\n`);
}

// ===== stdout 写回：返回可等待 Promise，正确处理 write 回调 / 背压 / stream error =====
// 串行队列天然处理背压（无需手动 drain）；write 回调在数据 flush 完成（或出错）后被调用。
let stdoutChain = Promise.resolve();
process.stdout.on('error', (e) => {
  log('stdout 写错误（下游可能已关闭）：', e && e.message ? e.message : String(e));
});

function send(obj) {
  const payload = `${JSON.stringify(obj)}\n`;
  stdoutChain = stdoutChain.then(() => new Promise((resolve, reject) => {
    process.stdout.write(payload, (err) => {
      if (err) reject(err instanceof Error ? err : new Error(String(err)));
      else resolve();
    });
  }));
  return stdoutChain;
}

// ===== 校验工具 =====
function containsSensitiveKey(obj, depth = 0) {
  if (depth > 20 || obj === null || obj === undefined) return false;
  if (Array.isArray(obj)) return obj.some((item) => containsSensitiveKey(item, depth + 1));
  if (typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj)) {
      if (PLAN_SENSITIVE_FIELD.test(key)) return true;
      if (value && typeof value === 'object' && containsSensitiveKey(value, depth + 1)) return true;
    }
  }
  return false;
}

function validateSafeToken(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SAFE_TOKEN_LENGTH) {
    return { error: `${name} 长度非法` };
  }
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.includes('..')) {
    return { error: `${name} 包含非法字符` };
  }
  return { ok: true, value };
}

function toPositiveInt(value, max, name) {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n) || n <= 0 || n > max) return { error: `${name} 必须是 1~${max} 之间的正整数` };
  return { ok: true, value: n };
}

function validateArgs(argumentsObj) {
  const params = argumentsObj || {};
  for (const key of Object.keys(params)) {
    if (!PLAN_TOP_LEVEL_KEYS.has(key)) return { error: `拒绝未知或禁用的顶层字段：${key}` };
  }
  if (containsSensitiveKey(params)) return { error: '检测到敏感凭据字段，本次调用已拒绝' };

  const action = params.action;
  if (!PLAN_ACTIONS.has(action)) return { error: 'action 必须是 plan/execute/status 之一（analyze/resume 第一阶段未实现）' };

  if (action === 'plan') {
    if (!params.plan || typeof params.plan !== 'object' || Array.isArray(params.plan)) {
      return { error: 'action=plan 需要提供 plan 对象' };
    }
    const planJson = JSON.stringify(params.plan);
    if (Buffer.byteLength(planJson, 'utf8') > MAX_PLAN_BYTES) return { error: 'plan 超过大小上限' };
    return { ok: true, action, argv: [RUN_PLAN_ENTRY, '--stdin', '--action=plan', '--json'], stdinPayload: planJson };
  }

  if (action === 'execute') {
    const pid = validateSafeToken(String(params.plan_id ?? ''), 'plan_id');
    if (pid.error) return pid;
    const hash = typeof params.expected_plan_hash === 'string' && /^[0-9a-f]{64}$/i.test(params.expected_plan_hash)
      ? { ok: true, value: params.expected_plan_hash.toLowerCase() }
      : { error: 'expected_plan_hash 必须是 64 位 SHA-256 十六进制' };
    if (hash.error) return hash;
    const ik = validateSafeToken(String(params.idempotency_key ?? ''), 'idempotency_key');
    if (ik.error) return ik;

    const payload = { plan_id: pid.value, expected_plan_hash: hash.value, idempotency_key: ik.value };
    if (params.budget_cases !== undefined && params.budget_cases !== null) {
      const bc = toPositiveInt(params.budget_cases, 10000, 'budget_cases');
      if (bc.error) return bc;
      payload.budget_cases = bc.value;
    }
    if (params.budget_duration !== undefined && params.budget_duration !== null) {
      const bd = toPositiveInt(params.budget_duration, 24 * 60 * 60 * 1000, 'budget_duration');
      if (bd.error) return bd;
      payload.budget_duration = bd.value;
    }
    return { ok: true, action, argv: [RUN_PLAN_ENTRY, '--stdin', '--action=execute', '--json'], stdinPayload: JSON.stringify(payload) };
  }

  // status
  const payload = {};
  if (params.run_id !== undefined && params.run_id !== null && params.run_id !== '') {
    const rid = validateSafeToken(String(params.run_id), 'run_id');
    if (rid.error) return rid;
    payload.run_id = rid.value;
  }
  if (params.plan_id !== undefined && params.plan_id !== null && params.plan_id !== '') {
    const pid = validateSafeToken(String(params.plan_id), 'plan_id');
    if (pid.error) return pid;
    payload.plan_id = pid.value;
  }
  if (!payload.run_id && !payload.plan_id) return { error: 'action=status 需要 plan_id 或 run_id' };
  return { ok: true, action, argv: [RUN_PLAN_ENTRY, '--stdin', '--action=status', '--json'], stdinPayload: JSON.stringify(payload) };
}

// ===== 通过 stdin 写入结构化 JSON 调用 run-plan CLI（shell=false、固定 cwd、固定入口、超时终止）=====
function runPlan(argv, stdinPayload) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const child = spawn(process.execPath, argv, { cwd: CWD, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      setTimeout(() => { if (!settled) { try { child.kill('SIGKILL'); } catch { /* ignore */ } } }, 5000).unref();
    }, EXEC_TIMEOUT);
    if (timer.unref) timer.unref();

    child.stdin.on('error', () => { /* stdin 提前关闭，忽略 */ });
    try { child.stdin.end(stdinPayload, 'utf8'); } catch { /* ignore */ }

    child.stdout.on('data', (c) => { if (stdout.length < MAX_STDOUT) stdout += c.toString(); });
    child.stderr.on('data', (c) => { if (stderr.length < MAX_STDERR) stderr += c.toString(); });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, timedOut: false, spawnError: e.message, stderr });
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: !timedOut, timedOut, code, signal, stdout, stderr, spawnError: null });
    });
  });
}

function parseStdout(stdout) {
  if (!stdout) return null;
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { /* ignore */ }
    }
    return null;
  }
}

function termResult(isError, parsed, meta, action) {
  const lines = [];
  if (meta.timedOut) lines.push('执行超时（已终止）。');
  else if (meta.spawnError) lines.push(`执行失败（无法启动子进程）：${meta.spawnError}`);
  else if (!parsed) lines.push(`执行结束（exit=${meta.code ?? '未知'}），未解析到有效 JSON。`);
  else {
    if (parsed.ok === true) lines.push('结果：成功');
    else if (parsed.blocked === true) lines.push('结果：BLOCKED');
    else lines.push('结果：失败');
    if (parsed.code) lines.push(`code=${parsed.code}`);
    if (parsed.message) lines.push(`message=${parsed.message}`);
    if (parsed.plan_id) lines.push(`plan_id=${parsed.plan_id}`);
    if (parsed.run_id) lines.push(`run_id=${parsed.run_id}`);
    if (parsed.plan_hash) lines.push(`plan_hash=${parsed.plan_hash}`);
    if (action === 'plan') {
      if (parsed.case_summary) lines.push(`用例摘要：${JSON.stringify(parsed.case_summary)}`);
      if (parsed.risk_summary) lines.push(`风险摘要：${JSON.stringify(parsed.risk_summary)}`);
    }
    if (parsed.summary && typeof parsed.summary.passed === 'number') {
      lines.push(`designed_total=${parsed.summary.designedTotal} executable_total=${parsed.summary.executableTotal} executed_total=${parsed.summary.executedTotal} passed=${parsed.summary.passed} failed=${parsed.summary.failed} blocked=${parsed.summary.blocked} designed_only=${parsed.summary.designedOnly}`);
    }
    if (parsed.status) lines.push(`status=${parsed.status}`);
  }
  return {
    content: [{ type: 'text', text: lines.join('\n') || '（已返回结构化结果）' }],
    isError,
    structuredContent: {
      action,
      ok: parsed?.ok === true,
      blocked: parsed?.blocked === true,
      timed_out: meta.timedOut,
      exit_code: meta.code ?? null,
      code: parsed?.code ?? null,
      message: parsed?.message ?? null,
      plan_id: parsed?.plan_id ?? null,
      run_id: parsed?.run_id ?? null,
      plan_hash: parsed?.plan_hash ?? null,
      case_summary: parsed?.case_summary ?? null,
      risk_summary: parsed?.risk_summary ?? null,
      summary: parsed?.summary ?? null,
      status: parsed?.status ?? null,
      gate: parsed?.gate ?? null,
      paths: parsed?.paths ?? null,
    },
  };
}

// ===== 并发控制 / 生命周期跟踪 / 优雅退出 =====
let activeRuns = 0;
let accepting = true;
let shuttingDown = false;
const inflight = new Set();
const SHUTDOWN_TIMEOUT_MS = 8000;

// 每个请求的完整生命周期（接收 → 执行 → 响应 flush 写出）都纳入 inflight，关闭时据此等待。
function trackLifecycle(p) {
  inflight.add(p);
  p.catch((e) => log('请求生命周期异常：', e && e.stack ? e.stack : String(e)));
  p.finally(() => inflight.delete(p));
}

async function handleToolsCall(id, name, argumentsObj) {
  if (name === LEGACY_TOOL_NAME) {
    await send({
      jsonrpc: '2.0', id,
      result: { content: [{ type: 'text', text: 'LEGACY_TOOL_DISABLED：run_requirement_test 已禁用，请使用 execute_test_plan' }], isError: true },
    });
    return;
  }
  if (name !== TOOL_NAME) {
    await send({ jsonrpc: '2.0', id, error: { code: -32602, message: `未知工具：${name}` } });
    return;
  }

  if (!accepting) {
    await send({ jsonrpc: '2.0', id, error: { code: -32000, message: '服务正在关闭，不再接收新请求' } });
    return;
  }

  const v = validateArgs(argumentsObj);
  if (v.error) {
    await send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: v.error }], isError: true } });
    return;
  }

  if (activeRuns >= MAX_CONCURRENCY) {
    await send({
      jsonrpc: '2.0', id,
      result: { content: [{ type: 'text', text: 'BLOCKED/BUSY：并发执行数已达上限，请稍后重试' }], isError: true },
    });
    return;
  }

  activeRuns++;
  try {
    const meta = await runPlan(v.argv, v.stdinPayload);
    const parsed = parseStdout(meta.stdout);
    const ok = !meta.timedOut && !meta.spawnError && !!parsed && parsed.ok === true;
    await send({ jsonrpc: '2.0', id, result: termResult(!ok, parsed, meta, v.action) });
  } catch (e) {
    const message = e && e.stack ? e.stack : String(e);
    log('tools/call 异步异常：', message);
    // 异步异常转为 JSON-RPC 错误，不能形成 unhandled rejection。
    await send({ jsonrpc: '2.0', id, error: { code: -32603, message: 'tools/call 执行异常：' + message } });
  } finally {
    activeRuns--;
  }
}

// ===== stdio 主循环：按行读取 JSON-RPC =====
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

async function handleLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;

  let body;
  try {
    body = JSON.parse(trimmed);
  } catch {
    await send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: '请求不是合法 JSON' } });
    return;
  }

  const { id, method, params } = body;
  if (typeof method !== 'string') {
    await send({ jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message: '缺少 method 字段' } });
    return;
  }

  if (method === 'initialize') {
    await send({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'panqu-test-mcp', version: '1.0.0' },
      },
    });
    return;
  }

  if (method === 'notifications/initialized') {
    // 通知无 id，不返回响应。
    return;
  }

  if (method === 'tools/list') {
    await send({ jsonrpc: '2.0', id, result: { tools: [EXECUTE_TEST_PLAN_TOOL] } });
    return;
  }

  if (method === 'tools/call') {
    const name = params && params.name;
    const argumentsObj = (params && params.arguments) || {};
    await handleToolsCall(id, name, argumentsObj);
    return;
  }

  await send({ jsonrpc: '2.0', id: id ?? null, error: { code: -32601, message: '未知方法' } });
}

rl.on('line', (line) => {
  if (shuttingDown) return;
  trackLifecycle(handleLine(line));
});

rl.on('close', () => {
  log('stdio 输入已关闭，停止接收新请求，等待在途请求与待写响应 flush 完成');
  accepting = false;
  shuttingDown = true;

  // 有界优雅退出超时：超时后如实以非零状态退出（保留有界兜底，避免永久挂起）。
  const forceTimer = setTimeout(() => {
    log('优雅退出超时，以非零状态退出');
    process.exitCode = 1;
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  Promise.allSettled([...inflight, stdoutChain]).then(() => {
    clearTimeout(forceTimer);
    log('在途请求与待写响应已全部完成，自然退出');
    // 正常关闭：仅设置 exitCode，不调用 process.exit，确保响应已全部 flush。
    process.exitCode = 0;
  });
});

process.on('uncaughtException', (e) => {
  log('uncaughtException', e && e.stack ? e.stack : String(e));
  process.exitCode = 1;
  process.exit(1);
});

log('trae-test-mcp-stdio ready');