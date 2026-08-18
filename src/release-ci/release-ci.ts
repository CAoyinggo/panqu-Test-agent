// Autonomous Release → CI/CD 适配层（Phase 23.4）
// 统一 Release Contract：releaseId / runId / decision / confidence / checks / evidence /
// blockReasons / recommendations / traceId / createdAt。
// CI Exit Code 规范：0=PASS、1=BLOCK、2=REVIEW、3=SYSTEM_ERROR（REVIEW 绝不返回 0）。
// 输出：output/<date>/<feature>/release-decision.json
// Deterministic First：决策由规则引擎（decideRelease）推导，本层仅做契约映射与 I/O，不调用 LLM。

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { decideRelease, type ReleaseDecisionInput } from '../release-decision/index.js';

/** 发布决策结论（含 SYSTEM_ERROR 供 CI 使用） */
export type ReleaseVerdict = 'PASS' | 'REVIEW' | 'BLOCK' | 'SYSTEM_ERROR';

/** 发布检查项（Gate 明细） */
export interface ReleaseCheck {
  name: string;
  status: 'pass' | 'fail';
  value: string;
}

/** 证据项 */
export interface Evidence {
  type: string;
  value: string;
}

/** 统一 Release Contract（任务书八） */
export interface ReleaseDecision {
  releaseId: string;
  runId: string;
  feature?: string;
  decision: 'PASS' | 'REVIEW' | 'BLOCK' | 'SYSTEM_ERROR';
  confidence: number;
  checks: ReleaseCheck[];
  evidence: Evidence[];
  blockReasons: string[];
  recommendations: string[];
  traceId: string;
  createdAt: string;
}

/** 构建 Release Contract 的输入 */
export interface ReleaseContractInput {
  runId: string;
  releaseId?: string;
  feature?: string;
  traceId?: string;
  decisionInput: ReleaseDecisionInput;
  /** SYSTEM_ERROR 原因（可选；设置则 decision=SYSTEM_ERROR） */
  systemError?: string;
}

/** CI Exit Code：0=PASS、1=BLOCK、2=REVIEW、3=SYSTEM_ERROR（统一规范，任务书九） */
export function releaseExitCode(decision: ReleaseDecision['decision']): number {
  switch (decision) {
    case 'PASS':
      return 0;
    case 'BLOCK':
      return 1;
    case 'REVIEW':
      return 2;
    case 'SYSTEM_ERROR':
      return 3;
  }
}

/** 由 ReleaseDecisionInput 构建 checks（与 decideRelease 信号一致，供 Contract 明细） */
function buildChecks(input: ReleaseDecisionInput): ReleaseCheck[] {
  const p0Failed = Math.max(0, input.p0.total - input.p0.passed);
  const p1Rate = input.p1.total > 0 ? input.p1.passed / input.p1.total : 1;
  const thresholds = input.thresholds ?? {};
  const p1PassRate = thresholds.p1PassRate ?? 0.98;
  const minCoverage = thresholds.minCoverage ?? 0.9;
  const flakyTolerance = thresholds.flakyTolerance ?? 1;
  return [
    { name: 'P0', status: p0Failed === 0 ? 'pass' : 'fail', value: `${input.p0.passed}/${input.p0.total} passed` },
    { name: 'P1 PassRate', status: p1Rate >= p1PassRate ? 'pass' : 'fail', value: `${(p1Rate * 100).toFixed(1)}%` },
    { name: 'Coverage', status: input.coverage >= minCoverage ? 'pass' : 'fail', value: `${(input.coverage * 100).toFixed(1)}%` },
    { name: 'Critical Defects', status: input.criticalDefects <= 0 ? 'pass' : 'fail', value: `${input.criticalDefects} open` },
    { name: 'Flaky', status: (input.flakyCount ?? 0) <= flakyTolerance ? 'pass' : 'fail', value: `${input.flakyCount ?? 0} cases` },
    { name: 'Known Issues', status: (input.knownIssues ?? 0) <= 0 ? 'pass' : 'fail', value: `${input.knownIssues ?? 0} open` },
    { name: 'Risk Level', status: (input.riskLevel ?? 'LOW') !== 'HIGH' ? 'pass' : 'fail', value: input.riskLevel ?? 'LOW' },
    { name: 'Model Change', status: !input.modelChange ? 'pass' : 'fail', value: input.modelChange ? 'detected' : 'none' },
    { name: 'Environment', status: !input.environmentAbnormal ? 'pass' : 'fail', value: input.environmentAbnormal ? 'abnormal' : 'normal' },
  ];
}

/**
 * 构建统一 Release Contract。
 * 规则引擎决定 verdict（BLOCK > REVIEW > PASS）；SYSTEM_ERROR 由调用方显式传入。
 */
export function buildReleaseDecision(input: ReleaseContractInput): ReleaseDecision {
  if (input.systemError) {
    return {
      releaseId: input.releaseId ?? `release-${input.runId}`,
      runId: input.runId,
      feature: input.feature,
      decision: 'SYSTEM_ERROR',
      confidence: 0,
      checks: [],
      evidence: [{ type: 'system-error', value: input.systemError }],
      blockReasons: [input.systemError],
      recommendations: ['检查流水线环境与依赖后重试'],
      traceId: input.traceId ?? `${input.runId}:system`,
      createdAt: new Date().toISOString(),
    };
  }

  const d = decideRelease(input.decisionInput);
  return {
    releaseId: input.releaseId ?? `release-${input.runId}`,
    runId: input.runId,
    feature: input.feature,
    decision: d.decision,
    confidence: d.confidence,
    checks: buildChecks(input.decisionInput),
    evidence: d.evidence.map((e) => ({ type: e.type, value: e.value })),
    blockReasons: d.blockingFactors.length > 0 ? d.blockingFactors : d.reasons,
    recommendations: d.recommendedActions,
    traceId: input.traceId ?? `${input.runId}:release`,
    createdAt: new Date().toISOString(),
  };
}

/** 输出路径：output/<date>/<feature>/release-decision.json（任务书八） */
export function releaseDecisionPath(decision: ReleaseDecision, baseDir = 'output'): string {
  const date = decision.createdAt.slice(0, 10); // yyyy-mm-dd
  const feature = decision.feature ?? 'default';
  return join(baseDir, date, feature, 'release-decision.json');
}

/** 写入 Release Contract JSON */
export function writeReleaseDecision(decision: ReleaseDecision, opts: { baseDir?: string } = {}): string {
  const file = releaseDecisionPath(decision, opts.baseDir ?? 'output');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(decision, null, 2)}\n`, 'utf-8');
  return file;
}

/** 读取指定文件路径的 Release Contract */
export function readReleaseDecisionFile(file: string): ReleaseDecision | null {
  try {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf-8')) as ReleaseDecision;
  } catch {
    return null;
  }
}

/**
 * 按 runId 查找 Release Contract（CLI --run-id 用）。
 * 优先定向 output/<date>/<feature>/release-decision.json；否则递归扫描 output 目录匹配 runId。
 */
export function loadReleaseDecision(
  runId: string,
  opts: { date?: string; feature?: string; baseDir?: string } = {},
): ReleaseDecision | null {
  const baseDir = opts.baseDir ?? 'output';
  // 定向路径
  if (opts.date && opts.feature) {
    const file = join(baseDir, opts.date, opts.feature, 'release-decision.json');
    const d = readReleaseDecisionFile(file);
    if (d && d.runId === runId) return d;
  }
  // 扫描 output 目录
  if (!existsSync(baseDir)) return null;
  const found = scanForRunId(baseDir, runId);
  return found;
}

/** 递归扫描 baseDir 下的 release-decision.json，匹配 runId */
function scanForRunId(baseDir: string, runId: string): ReleaseDecision | null {
  for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
    const full = join(baseDir, entry.name);
    if (entry.isDirectory()) {
      const hit = scanForRunId(full, runId);
      if (hit) return hit;
    } else if (entry.name === 'release-decision.json') {
      const d = readReleaseDecisionFile(full);
      if (d && d.runId === runId) return d;
    }
  }
  return null;
}

/** 最近一次决策（Dashboard / 报告用） */
export function latestReleaseDecision(baseDir = 'output'): ReleaseDecision | null {
  if (!existsSync(baseDir)) return null;
  const results: Array<{ file: string; mtimeMs: number; decision: ReleaseDecision }> = [];
  for (const date of readdirSync(baseDir).sort().reverse()) {
    const dateDir = join(baseDir, date);
    if (!existsSync(dateDir)) continue;
    for (const feature of readdirSync(dateDir).sort().reverse()) {
      const file = join(dateDir, feature, 'release-decision.json');
      const d = readReleaseDecisionFile(file);
      if (d) {
        try {
          results.push({ file, mtimeMs: statSync(file).mtimeMs, decision: d });
        } catch {
          /* ignore */
        }
      }
    }
  }
  results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return results[0]?.decision ?? null;
}
