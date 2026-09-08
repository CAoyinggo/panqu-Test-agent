#!/usr/bin/env node
// run-plan.ts — execute_test_plan 的确定性 CLI 入口（无 LLM、无网络副作用阶段分派）。
//
// 用法（仅允许固定参数白名单）：
//   node dist/bin/run-plan.js --stdin --action=plan --json      （stdin 写入结构化 plan JSON）
//   node dist/bin/run-plan.js --stdin --action=execute --json   （stdin 写入 { plan_id, expected_plan_hash, idempotency_key, ... }）
//   node dist/bin/run-plan.js --stdin --action=status --json    （stdin 写入 { plan_id | run_id }）
//
// 安全约定：
//   - shell=false（由 MCP 侧 spawn 保证）
//   - 不产生用户可控的任意文件读取入口（run_id/plan_id 均为服务端生成，且校验字符集）
//   - stdin 有大小上限；stdout 为单一 JSON；失败非零退出码
//
// action 语义（第一阶段，诚实声明）：
//   - plan：校验 + 原子持久化（不执行、零网络）
//   - execute：文件锁 + 幂等 + Policy Gate + 确定性执行（未放行绝不 fetch）
//   - status：只读取真实 manifest / result 状态
//   - analyze / resume：第一阶段未实现，统一返回 NOT_IMPLEMENTED

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validatePlan } from '../src/agents/plan/plan-contract.js';
import {
  executeRun,
  persistPlan,
  statusRun,
  type ExecutePlanInput,
  type LookupInput,
} from '../src/agents/orchestration/plan-run-service.js';

const MAX_STDIN_BYTES = 10 * 1024 * 1024; // 10MB

type Action = 'plan' | 'execute' | 'status' | 'analyze' | 'resume';

interface RunPlanArgs {
  action: Action;
  stdin: boolean;
  json: boolean;
}

export function parseRunPlanArgs(argv: string[]): RunPlanArgs | { error: string } {
  let action: Action | null = null;
  let stdin = false;
  let json = false;
  for (const arg of argv) {
    if (arg === '--stdin') stdin = true;
    else if (arg === '--json') json = true;
    else if (arg.startsWith('--action=')) {
      const v = arg.slice('--action='.length) as Action;
      if (v !== 'plan' && v !== 'execute' && v !== 'status' && v !== 'analyze' && v !== 'resume') {
        return { error: `非法 action：${v}` };
      }
      action = v;
    } else {
      return { error: `未知参数：${arg}` };
    }
  }
  if (!action) return { error: '缺少 --action=plan|execute|status' };
  if (!stdin) return { error: '缺少 --stdin' };
  return { action, stdin, json };
}

function readStdin(maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    let settled = false;
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      size += Buffer.byteLength(chunk, 'utf8');
      if (size > maxBytes) {
        if (!settled) { settled = true; reject(new Error('stdin 超过大小上限')); }
        process.stdin.destroy();
        return;
      }
      data += chunk;
    });
    process.stdin.on('end', () => { if (!settled) { settled = true; resolve(data); } });
    process.stdin.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
  });
}

function dispatch(action: Action, payload: unknown): Promise<Record<string, unknown>> | Record<string, unknown> {
  if (action === 'analyze' || action === 'resume') {
    return { ok: false, code: 'NOT_IMPLEMENTED', message: `action=${action} 第一阶段未实现，仅支持 plan/execute/status` };
  }
  if (action === 'plan') {
    const validation = validatePlan(payload);
    if (!validation.ok) return { ok: false, code: 'PLAN_INVALID', errors: validation.errors };
    const persisted = persistPlan(validation.normalized);
    return {
      ok: true,
      action: 'plan',
      plan_id: persisted.planId,
      plan_hash: persisted.hash,
      run_id: persisted.runId,
      case_summary: persisted.caseSummary,
      risk_summary: persisted.riskSummary,
      paths: { plan: persisted.paths.plan, manifest: persisted.paths.manifest },
    };
  }
  if (action === 'execute') {
    const input = (payload && typeof payload === 'object' ? payload : {}) as ExecutePlanInput;
    return executeRun(input);
  }
  if (action === 'status') {
    const input = (payload && typeof payload === 'object' ? payload : {}) as LookupInput;
    return statusRun(input);
  }
  return { ok: false, code: 'INVALID_ARGS', message: '不支持的操作' };
}

async function run(args: RunPlanArgs): Promise<Record<string, unknown>> {
  let raw = '';
  try {
    raw = await readStdin(MAX_STDIN_BYTES);
  } catch (e) {
    return { ok: false, code: 'INPUT_TOO_LARGE', message: e instanceof Error ? e.message : String(e) };
  }

  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, code: 'INVALID_JSON', message: 'stdin 为空' };

  let payload: unknown;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    return { ok: false, code: 'INVALID_JSON', message: 'stdin 不是合法 JSON' };
  }

  return dispatch(args.action, payload);
}

export async function main(argv: string[]): Promise<number> {
  const parsed = parseRunPlanArgs(argv);
  if ('error' in parsed) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ ok: false, code: 'INVALID_ARGS', message: parsed.error }));
    return 2;
  }
  const outcome: Record<string, unknown> = await run(parsed).catch((e): Record<string, unknown> => ({ ok: false, code: 'INTERNAL_ERROR', message: e instanceof Error ? e.message : String(e) }));
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(outcome));
  return outcome.ok === true ? 0 : (outcome.blocked === true ? 1 : 2);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((e) => {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ ok: false, code: 'INTERNAL_ERROR', message: e instanceof Error ? e.message : String(e) }));
    process.exit(2);
  });
}