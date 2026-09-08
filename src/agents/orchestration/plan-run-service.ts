// Plan Run Service：run-plan CLI 的可注入编排层（无 LLM、无网络副作用、确定性）。
//
// 将「结构化测试计划」的 plan / execute / status 生命周期收敛为可单测的纯函数：
//   1. persistPlan —— 校验后的归一化计划原子落盘（plan.json + manifest.json + pointer）；
//   2. executeRun —— 文件锁 + 幂等 + Policy Gate + 确定性执行 + 原子落盘；
//   3. statusRun  —— 只读取真实 manifest / result 状态（不伪造「分析/恢复」）。
//
// 该路径禁止创建 Runtime LLM、读取 LLM_PROVIDER、调用模型 API、回退 MockLLM、调用 traecli。

import fs from 'node:fs';
import path from 'node:path';
import { writeAtomic, withFileLock } from '../../utils/atomic-fs.js';
import { generateRunId } from '../../utils/run-id.js';
import {
  classifyPlanCase,
  generatePlanId,
  planHash,
  type NormalizedPlan,
} from '../plan/plan-contract.js';
import {
  evaluatePlanPolicyGate,
  parseAllowedOrigins,
  type PlanPolicyGateResult,
} from '../plan/plan-policy-gate.js';
import {
  executePlan,
  type PlanCaseExecutionResult,
  type PlanExecutionResult,
  type ResolveHostFn,
} from './plan-executor.js';

// —— 固定目录（服务端运维配置，不含 Trae 传入参数） ——

const DEFAULT_OUTPUT_ROOT = process.env.TESTFLOW_OUTPUT_DIR || path.resolve('output');
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

export interface PlanRunDeps {
  outputRoot?: string;
  /** 服务端允许的目标 origin（未配置 fail-closed）。 */
  allowedOrigins?: ReadonlySet<string>;
  /** 测试注入：替换真实执行引擎（网络侧只允许被替换，用于并发/预算测试）。 */
  executePlanFn?: typeof executePlan;
  /** 测试注入：DNS 解析。 */
  resolveHost?: ResolveHostFn;
}

export interface ExecutePlanInput {
  plan_id?: string;
  expected_plan_hash?: string;
  idempotency_key?: string;
  budget_cases?: number;
  budget_duration?: number;
}

export interface LookupInput {
  plan_id?: string;
  run_id?: string;
}

export interface PlanRunPaths {
  plan: string;
  manifest: string;
  result?: string;
  report?: string;
  gate?: string;
}

interface PlanRecord {
  plan_id: string;
  run_id: string;
  plan_hash: string;
  schema_version: string;
  created_at: string;
  environment: string;
  target_url: string;
  scope: string;
  normalized: NormalizedPlan;
}

interface Manifest {
  run_id: string;
  plan_id: string;
  plan_hash: string;
  environment: string;
  target_url: string;
  status: 'PLANNED' | 'EXECUTED' | 'BLOCKED' | 'NOT_FOUND';
  created_at: string;
  updated_at?: string;
  idempotency_key?: string;
  summary?: unknown;
  gate?: PlanPolicyGateResult;
  files: PlanRunPaths;
}

interface PlanPointer {
  plan_id: string;
  run_id: string;
  plan_hash: string;
}

function outputRoot(deps: PlanRunDeps): string {
  return deps.outputRoot ?? DEFAULT_OUTPUT_ROOT;
}

function runsDir(root: string): string {
  return path.join(root, 'runs');
}

function plansDir(root: string): string {
  return path.join(root, 'plans');
}

function resolveRunDir(root: string, runId: string): string {
  return path.join(runsDir(root), runId);
}

function resolvePlanPointerPath(root: string, planId: string): string {
  return path.join(plansDir(root), `${planId}.json`);
}

/** 输出目录收紧为 0700，文件由 writeAtomic 落成 0600。 */
function ensureDirPrivate(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function writeJsonAtomic(filePath: string, data: unknown): void {
  // writeAtomic 内部会 ensureDir，但这里提前用 0700 收紧目录。
  ensureDirPrivate(path.dirname(filePath));
  writeAtomic(filePath, JSON.stringify(data, null, 2));
}

/** HTML 等非 JSON 内容：原始文本原子写入，禁止 JSON.stringify（否则会带双引号转义）。 */
function writeTextAtomic(filePath: string, content: string): void {
  ensureDirPrivate(path.dirname(filePath));
  writeAtomic(filePath, content);
}

function loadJson<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function safeId(value: string | undefined, label: string): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200 || !SAFE_ID.test(value) || value.includes('..')) {
    void label;
    return null;
  }
  return value;
}

function buildCaseSummary(normalized: NormalizedPlan): unknown {
  const executable = normalized.testCases.filter((c) => classifyPlanCase(c).classification === 'EXECUTABLE').length;
  const designedOnly = normalized.testCases.filter((c) => classifyPlanCase(c).classification === 'DESIGNED_ONLY').length;
  const byType: Record<string, number> = {};
  for (const c of normalized.testCases) byType[c.type] = (byType[c.type] ?? 0) + 1;
  return {
    cases_total: normalized.testCases.length,
    executable,
    designed_only: designedOnly,
    by_type: byType,
  };
}

function buildRiskSummary(normalized: NormalizedPlan): unknown {
  const levels: Record<string, number> = {};
  for (const r of normalized.risks) levels[r.level] = (levels[r.level] ?? 0) + 1;
  return { risks_total: normalized.risks.length, levels };
}

/** 解析服务端允许列表（必需配置，缺失即空集合 → 门禁 fail-closed）。 */
function resolveAllowedOrigins(deps: PlanRunDeps): ReadonlySet<string> {
  if (deps.allowedOrigins) return deps.allowedOrigins;
  return parseAllowedOrigins(process.env.TESTFLOW_ALLOWED_TARGET_ORIGINS);
}

// —— 持久化 ——

export function persistPlan(normalized: NormalizedPlan, deps: PlanRunDeps = {}): {
  planId: string;
  runId: string;
  hash: string;
  caseSummary: unknown;
  riskSummary: unknown;
  paths: PlanRunPaths;
} {
  const root = outputRoot(deps);
  ensureDirPrivate(runsDir(root));
  ensureDirPrivate(plansDir(root));

  const planId = generatePlanId('plan');
  const runId = generateRunId();
  const hash = planHash(normalized);
  const now = new Date().toISOString();
  const runDir = resolveRunDir(root, runId);
  ensureDirPrivate(runDir);

  const planRecord: PlanRecord = {
    plan_id: planId,
    run_id: runId,
    plan_hash: hash,
    schema_version: normalized.schemaVersion,
    created_at: now,
    environment: normalized.environment,
    target_url: normalized.targetUrl,
    scope: normalized.scope,
    normalized,
  };
  const planPath = path.join(runDir, 'plan.json');
  const manifestPath = path.join(runDir, 'manifest.json');
  const manifest: Manifest = {
    run_id: runId,
    plan_id: planId,
    plan_hash: hash,
    environment: normalized.environment,
    target_url: normalized.targetUrl,
    status: 'PLANNED',
    created_at: now,
    files: { plan: planPath, manifest: manifestPath },
  };

  // 原子写入顺序：先 plan / manifest，最后指针（指针存在即代表计划可解析）。
  writeJsonAtomic(path.join(runDir, 'plan.json'), planRecord);
  writeJsonAtomic(manifestPath, manifest);
  writeJsonAtomic(resolvePlanPointerPath(root, planId), { plan_id: planId, run_id: runId, plan_hash: hash } satisfies PlanPointer);

  return {
    planId,
    runId,
    hash,
    caseSummary: buildCaseSummary(normalized),
    riskSummary: buildRiskSummary(normalized),
    paths: { plan: planPath, manifest: manifestPath },
  };
}

// —— 状态读取 ——

export function statusRun(input: LookupInput, deps: PlanRunDeps = {}): Record<string, unknown> {
  const root = outputRoot(deps);
  const runId = input.run_id ? safeId(input.run_id, 'run_id') : null;
  if (runId) {
    const manifest = loadJson<Manifest>(path.join(resolveRunDir(root, runId), 'manifest.json'));
    if (!manifest) return { ok: false, code: 'NOT_FOUND', message: `运行不存在：${runId}` };
    return {
      ok: true,
      action: 'status',
      run_id: runId,
      plan_id: manifest.plan_id,
      plan_hash: manifest.plan_hash,
      status: manifest.status,
      summary: manifest.summary,
      paths: manifest.files,
    };
  }
  const planId = input.plan_id ? safeId(input.plan_id, 'plan_id') : null;
  if (!planId) return { ok: false, code: 'INVALID_ARGS', message: '缺少 plan_id 或 run_id' };
  const pointer = loadJson<PlanPointer>(resolvePlanPointerPath(root, planId));
  if (!pointer || !pointer.run_id) return { ok: false, code: 'PLAN_NOT_FOUND', message: `计划不存在：${planId}` };
  const manifest = loadJson<Manifest>(path.join(resolveRunDir(root, pointer.run_id), 'manifest.json'));
  if (!manifest) return { ok: false, code: 'NOT_FOUND', message: `运行不存在：${pointer.run_id}` };
  return {
    ok: true,
    action: 'status',
    run_id: pointer.run_id,
    plan_id: planId,
    plan_hash: manifest.plan_hash,
    status: manifest.status,
    summary: manifest.summary,
    paths: manifest.files,
  };
}

// —— 执行 ——

function gateBlockCode(gate: PlanPolicyGateResult): string {
  const blockedByEnvironment = gate.checks.some((c) => c.name === 'environment' && !c.passed && c.blocking);
  if (blockedByEnvironment) return 'APPROVAL_BACKEND_NOT_IMPLEMENTED';
  return 'POLICY_GATE_BLOCKED';
}

export async function executeRun(input: ExecutePlanInput, deps: PlanRunDeps = {}): Promise<Record<string, unknown>> {
  const root = outputRoot(deps);
  const planId = safeId(input.plan_id, 'plan_id');
  if (!planId) return { ok: false, code: 'INVALID_ARGS', message: '缺少合法 plan_id' };

  // idempotency_key 必填（无法绑定审批记录 → 用幂等键建立持久化执行记录）。
  const idempotencyKey = safeId(input.idempotency_key, 'idempotency_key');
  if (!idempotencyKey) return { ok: false, code: 'INVALID_ARGS', message: '缺少合法 idempotency_key（必填）' };

  const pointer = loadJson<PlanPointer>(resolvePlanPointerPath(root, planId));
  if (!pointer || !pointer.run_id) return { ok: false, code: 'PLAN_NOT_FOUND', blocked: true, message: `计划不存在：${planId}` };

  const runDir = resolveRunDir(root, pointer.run_id);
  const lockPath = path.join(runDir, 'execution');
  const runId = pointer.run_id;

  const result = await withFileLock(lockPath, async () => {
    // 锁内重读 manifest：已执行则按幂等策略返回。
    const existingManifest = loadJson<Manifest>(path.join(runDir, 'manifest.json'));
    if (existingManifest?.status === 'EXECUTED') {
      if (existingManifest.idempotency_key === idempotencyKey) {
        return { ok: true, action: 'execute', replayed: true, run_id: runId, plan_id: planId, plan_hash: existingManifest.plan_hash, summary: existingManifest.summary, paths: existingManifest.files };
      }
      return { ok: false, code: 'PLAN_ALREADY_EXECUTED', blocked: true, message: '该不可变计划已执行，不同 idempotency_key 默认拒绝重复执行（尚无 rerun action）' };
    }

    const planRecord = loadJson<PlanRecord>(path.join(runDir, 'plan.json'));
    if (!planRecord) {
      const manifest: Manifest = {
        run_id: runId,
        plan_id: planId,
        plan_hash: '',
        environment: '',
        target_url: '',
        status: 'NOT_FOUND',
        created_at: new Date().toISOString(),
        files: { plan: path.join(runDir, 'plan.json'), manifest: path.join(runDir, 'manifest.json') },
      };
      writeJsonAtomic(path.join(runDir, 'manifest.json'), manifest);
      return { ok: false, code: 'PLAN_NOT_FOUND', blocked: true, message: `计划文件缺失：${planId}` };
    }

    // 哈希绑定：防止计划被替换。
    const expectedHash = typeof input.expected_plan_hash === 'string' ? input.expected_plan_hash : '';
    const recomputedHash = planHash(planRecord.normalized);
    if (recomputedHash !== expectedHash || recomputedHash !== planRecord.plan_hash) {
      return { ok: false, code: 'PLAN_HASH_MISMATCH', blocked: true, message: '计划哈希不一致，执行已 BLOCKED' };
    }

    // 确定性 Policy Gate：未放行绝不调用 fetch。
    const allowedOrigins = resolveAllowedOrigins(deps);
    const gate = evaluatePlanPolicyGate(planRecord.normalized, {
      allowedTargetOrigins: allowedOrigins,
      budgetCases: input.budget_cases,
      budgetDurationMs: input.budget_duration,
    });
    const gatePath = path.join(runDir, 'gate.json');
    writeJsonAtomic(gatePath, gate);

    if (gate.verdict === 'BLOCK') {
      const manifest: Manifest = {
        run_id: runId,
        plan_id: planId,
        plan_hash: recomputedHash,
        environment: planRecord.normalized.environment,
        target_url: planRecord.normalized.targetUrl,
        status: 'BLOCKED',
        created_at: planRecord.created_at,
        updated_at: new Date().toISOString(),
        gate,
        files: { plan: path.join(runDir, 'plan.json'), manifest: path.join(runDir, 'manifest.json'), gate: gatePath },
      };
      writeJsonAtomic(path.join(runDir, 'manifest.json'), manifest);
      return {
        ok: false,
        blocked: true,
        code: gateBlockCode(gate),
        action: 'execute',
        run_id: runId,
        plan_id: planId,
        plan_hash: recomputedHash,
        gate,
        paths: manifest.files,
      };
    }

    // 放行：执行（网络侧只读 + 允许列表 + 预算）。executePlanFn 可注入用于并发/预算测试。
    const runFn = deps.executePlanFn ?? executePlan;
    const result: PlanExecutionResult = await runFn(planRecord.normalized, {
      planId,
      planHash: recomputedHash,
      allowedTargetOrigins: allowedOrigins,
      budgetCases: input.budget_cases,
      budgetDurationMs: input.budget_duration,
      resolveHost: deps.resolveHost,
    });

    return finalizeExecute(planId, runId, recomputedHash, idempotencyKey, gate, result, root);
  }, { timeoutMs: 15_000 });

  return result;
}

function finalizeExecute(
  planId: string,
  runId: string,
  hash: string,
  idempotencyKey: string,
  gate: PlanPolicyGateResult,
  result: PlanExecutionResult,
  root: string,
): Record<string, unknown> {
  const runDir = resolveRunDir(root, runId);
  ensureDirPrivate(runDir);

  const resultPath = path.join(runDir, 'result.json');
  const reportPath = path.join(runDir, 'report.html');
  const manifestPath = path.join(runDir, 'manifest.json');
  const gatePath = path.join(runDir, 'gate.json');

  // 先落结果与报告，最后才把 manifest 更新为 EXECUTED，避免半成品被当作已执行。
  writeJsonAtomic(resultPath, result);
  writeTextAtomic(reportPath, buildReportHtml(result, planId, runId));
  writeJsonAtomic(gatePath, gate);

  const existing = loadJson<Manifest>(manifestPath);
  const paths: PlanRunPaths = {
    plan: path.join(runDir, 'plan.json'),
    result: resultPath,
    report: reportPath,
    manifest: manifestPath,
    gate: gatePath,
  };
  const manifest: Manifest = {
    run_id: runId,
    plan_id: planId,
    plan_hash: hash,
    environment: result.environment,
    target_url: result.targetUrl,
    status: 'EXECUTED',
    created_at: existing?.created_at ?? new Date().toISOString(),
    updated_at: new Date().toISOString(),
    idempotency_key: idempotencyKey,
    summary: result.summary,
    gate,
    files: paths,
  };
  writeJsonAtomic(manifestPath, manifest);

  return {
    ok: true,
    action: 'execute',
    run_id: runId,
    plan_id: planId,
    plan_hash: hash,
    summary: result.summary,
    gate,
    paths,
  };
}

// —— HTML 报告（自包含，无外部资源）——

function esc(s: unknown): string {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function short(v: unknown, n = 120): string {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function statusBadge(status: PlanCaseExecutionResult['status']): string {
  const map: Record<PlanCaseExecutionResult['status'], [string, string]> = {
    PASSED: ['#16a34a', 'PASS'],
    FAILED: ['#dc2626', 'FAIL'],
    ERROR: ['#d97706', 'ERROR'],
    DESIGNED_ONLY: ['#6b7280', 'DESIGNED_ONLY'],
    BLOCKED: ['#64748b', 'BLOCKED'],
    BLOCKED_BY_BUDGET: ['#9333ea', 'BLOCKED_BY_BUDGET'],
    RESPONSE_TOO_LARGE: ['#ea580c', 'RESPONSE_TOO_LARGE'],
  };
  const entry = map[status] ?? ['#475569', String(status)];
  const [bg, label] = entry;
  return `<span style="background:${bg};color:#fff;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600">${esc(label)}</span>`;
}

export function buildReportHtml(result: PlanExecutionResult, planId: string, runId: string): string {
  const s = result.summary;
  const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const passRate = s.passRate === null ? '—' : s.passRate + '%';

  const caseRows = result.caseResults.map((c) => {
    const reason = c.reason ? `<div style="color:#64748b;font-size:12px;margin-top:2px">${esc(c.reason)}</div>` : '';
    const assertionDetail = c.assertions.length
      ? c.assertions.map((a) => `${a.pass ? '✓' : '✗'} ${esc(a.id)} ${esc(a.operator)} ${esc(short(a.expected, 40))}`).join('<br>')
      : '—';
    return `<tr><td><code>${esc(c.caseId)}</code></td><td>${esc(c.name)}</td><td>${statusBadge(c.status)}</td><td>${assertionDetail}</td><td>${reason}</td></tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>执行计划报告 ${esc(planId)}</title>
<style>
:root{--bg:#f8fafc;--ink:#0f172a;--muted:#64748b;--rule:#e2e8f0;--accent:#2563eb}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;line-height:1.6;font-size:14px}
.wrap{max-width:1000px;margin:0 auto;padding:24px 18px 60px}
h1{font-size:24px;margin:0 0 6px}h2{font-size:18px;margin:30px 0 12px;padding-bottom:8px;border-bottom:2px solid var(--accent)}
.muted{color:var(--muted)}code{background:#f1f5f9;border:1px solid var(--rule);border-radius:4px;padding:1px 5px;font-size:12px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin:16px 0}
.card{background:#fff;border:1px solid var(--rule);border-radius:10px;padding:14px}.card .v{font-size:22px;font-weight:700;color:var(--accent)}.card .l{font-size:12px;color:var(--muted);margin-top:4px}
.table-wrap{overflow-x:auto;border:1px solid var(--rule);border-radius:10px;background:#fff}
table{border-collapse:collapse;width:100%;min-width:720px;font-size:13px}th{background:#f1f5f9;text-align:left;padding:9px 12px;border-bottom:2px solid var(--rule)}td{padding:8px 12px;border-bottom:1px solid var(--rule);vertical-align:top}
</style>
</head>
<body>
<div class="wrap">
<h1>执行计划报告</h1>
<div class="muted">plan_id：<code>${esc(planId)}</code> ｜ run_id：<code>${esc(runId)}</code> ｜ target：${esc(result.targetUrl)} ｜ env：${esc(result.environment)} ｜ 生成于 ${esc(time)}</div>

<h2>一、执行统计</h2>
<div class="cards">
<div class="card"><div class="v">${s.designedTotal}</div><div class="l">designed_total</div></div>
<div class="card"><div class="v">${s.executableTotal}</div><div class="l">executable_total</div></div>
<div class="card"><div class="v">${s.executedTotal}</div><div class="l">executed_total</div></div>
<div class="card"><div class="v">${s.passed}</div><div class="l">passed</div></div>
<div class="card"><div class="v">${s.failed}</div><div class="l">failed</div></div>
<div class="card"><div class="v">${s.blocked}</div><div class="l">blocked</div></div>
<div class="card"><div class="v">${s.designedOnly}</div><div class="l">designed_only</div></div>
<div class="card"><div class="v">${passRate}</div><div class="l">通过率 (passed/executed_total)</div></div>
</div>

<h2>二、用例结果</h2>
<div class="table-wrap"><table><thead><tr><th>case_id</th><th>名称</th><th>结果</th><th>断言</th><th>说明</th></tr></thead><tbody>${caseRows}</tbody></table></div>
<p class="muted">DESIGNED_ONLY 用例表示「已设计，当前执行器不支持，未执行」，不进入通过率分母。</p>
</div>
</body>
</html>
`;
}