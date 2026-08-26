import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { DevTestBaselineDiff, DevTestProblem, DevTestProblemLifecycle, DevTestRerunFilter } from './types.js';
import type { TestCase } from '../agents/test-design/testcase-schema.js';

export interface BaselineProblem {
  signature: string;
  id: string;
  affectedCases: string[];
  lifecycle?: DevTestProblemLifecycle;
  failureClass?: DevTestProblem['failureClass'];
  rootCause?: string;
}

export interface DevTestCaseHistoryEntry {
  runId: string;
  status: string;
  durationMs: number;
  at: string;
}

export interface DevTestBaselineSnapshot {
  runId: string;
  requirementHash: string;
  sourceKey?: string;
  cases: Array<{ caseId: string; status: string; durationMs?: number; history?: DevTestCaseHistoryEntry[];
    contracts?: Array<{ contractId: string; fingerprint: string }>; verified?: boolean; evidenceComplete?: boolean;
    oracleVerdict?: string }>;
  problems: BaselineProblem[];
  regressionCaseIds?: string[];
  requirementAcIds?: string[];
  codeVersion?: string;
  contractVersion?: string;
}

export function requirementHash(markdown: string): string {
  return createHash('sha256').update(markdown).digest('hex');
}

export function baselinePath(outDir: string, markdown: string, sourceKey?: string): string {
  const stableSource = sourceKey && sourceKey !== 'inline-markdown' ? requirementHash(sourceKey) : requirementHash(markdown);
  return path.join(outDir, '.devtest-baselines', `${stableSource.slice(0, 24)}.json`);
}

export async function loadDevTestBaseline(outDir: string, markdown: string, sourceKey?: string): Promise<DevTestBaselineSnapshot | undefined> {
  try {
    const parsed = JSON.parse(await readFile(baselinePath(outDir, markdown, sourceKey), 'utf8')) as DevTestBaselineSnapshot;
    const sameIdentity = sourceKey && sourceKey !== 'inline-markdown' ? parsed.sourceKey === sourceKey
      : parsed.requirementHash === requirementHash(markdown);
    return sameIdentity && Array.isArray(parsed.cases) ? parsed : undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    throw new Error(`DEVTEST_BASELINE_INVALID：${(error as Error).message}`);
  }
}

export function problemSignature(problem: Pick<DevTestProblem, 'type' | 'reasonCode' | 'dimension' | 'affectedCases' | 'rootCause'>): string {
  return `${problem.type}|${problem.reasonCode ?? ''}|${problem.dimension}|${problem.rootCause ?? [...problem.affectedCases].sort().join(',')}`;
}

export function rerunCaseIds(
  snapshot: DevTestBaselineSnapshot | undefined,
  currentCases: readonly TestCase[] = [],
  target?: DevTestRerunFilter,
): string[] {
  if (!snapshot) return [];
  if (target && /^P\d{3,}$/i.test(target)) {
    return [...new Set(snapshot.problems.find((problem) => problem.id.toUpperCase() === target.toUpperCase())?.affectedCases ?? [])];
  }
  const statuses = target === 'failed' ? ['FAIL', 'TIMEOUT', 'CANCELLED']
    : target === 'blocked' ? ['BLOCKED', 'NOT_EXECUTED']
      : ['FAIL', 'BLOCKED', 'NOT_EXECUTED', 'TIMEOUT', 'CANCELLED'];
  if (target === 'regression') return [...new Set(snapshot.regressionCaseIds ?? [])];
  const cases = snapshot.cases.filter((item) => statuses.includes(item.status))
    .map((item) => item.caseId);
  const previousByCase = new Map(snapshot.cases.map((item) => [item.caseId, item]));
  const contractChanged = currentCases.filter((testCase) => {
    const before = previousByCase.get(testCase.id)?.contracts ?? [];
    const beforeById = new Map(before.map((item) => [item.contractId, item.fingerprint]));
    return (testCase.contractDependencies ?? []).some((dependency) => beforeById.has(dependency.contractId)
      && beforeById.get(dependency.contractId) !== dependency.fingerprint);
  }).map((testCase) => testCase.id);
  const problemCases = target ? [] : snapshot.problems.flatMap((problem) => problem.affectedCases ?? []);
  return [...new Set([...cases, ...problemCases, ...contractChanged])];
}

export function reconcileDevTestProblems(
  problems: readonly DevTestProblem[],
  baseline: DevTestBaselineSnapshot | undefined,
  reproProblemId?: string,
): DevTestProblem[] {
  const previousBySignature = new Map((baseline?.problems ?? []).map((problem) => [problem.signature, problem]));
  const usedIds = new Set((baseline?.problems ?? []).map((problem) => problem.id));
  let nextId = Math.max(0, ...(baseline?.problems ?? []).map((problem) => Number(problem.id.match(/\d+/)?.[0] ?? 0))) + 1;
  const priority = (problem: DevTestProblem): number => problem.judgement === 'CONFIRMED_BUG' ? 3
    : problem.judgement === 'LIKELY_BUG' || problem.failureClass === 'PRODUCT_BUG' ? 2 : 1;
  const prioritized = [...problems].sort((left, right) => priority(right) - priority(left));
  return prioritized.map((problem) => {
    const previous = previousBySignature.get(problemSignature(problem));
    let id = previous?.id;
    while (!id || usedIds.has(id) && id !== previous?.id) id = `P${String(nextId++).padStart(3, '0')}`;
    usedIds.add(id);
    const blocked = problem.failureClass !== 'PRODUCT_BUG';
    const regressed = problem.affectedCases.some((caseId) => {
      const previousCase = baseline?.cases.find((item) => item.caseId === caseId);
      return previousCase?.status === 'PASS' && previousCase.verified === true && previousCase.evidenceComplete === true;
    });
    const verifiedFixedBaseline = previous?.affectedCases.length
      ? previous.affectedCases.every((caseId) => {
        const baselineCase = baseline?.cases.find((item) => item.caseId === caseId);
        return baselineCase?.status === 'PASS' && baselineCase.verified === true && baselineCase.evidenceComplete === true;
      }) : false;
    const lifecycle: DevTestProblemLifecycle = blocked ? 'BLOCKED'
      : previous?.lifecycle === 'FIXED' && verifiedFixedBaseline ? 'REOPENED'
        : previous ? (reproProblemId?.toUpperCase() === id.toUpperCase() ? 'REPRODUCED' : 'STILL_FAIL')
          : regressed ? 'REGRESSION' : 'OPEN';
    return { ...problem, id, lifecycle };
  });
}

export function buildBaselineDiff(input: {
  baseline?: DevTestBaselineSnapshot;
  currentRunId: string;
  cases: Array<{ caseId: string; status: string; durationMs?: number; verified?: boolean; evidenceComplete?: boolean;
    oracleVerdict?: string }>;
  problems: readonly DevTestProblem[];
  rerunCaseIds?: readonly string[];
  rerunTarget?: string;
  scopeCaseIds?: readonly string[];
  requirementAcIds?: readonly string[];
  codeVersion?: string;
  contractVersion?: string;
}): DevTestBaselineDiff {
  const beforeProblems = new Map((input.baseline?.problems ?? []).map((item) => [item.signature, item]));
  const afterProblems = new Map(input.problems.map((item) => [problemSignature(item), item]));
  const beforeCases = new Map((input.baseline?.cases ?? []).map((item) => [item.caseId, item]));
  const currentCases = new Map(input.cases.map((item) => [item.caseId, item]));
  const verifiedPass = (item: { status: string; verified?: boolean; evidenceComplete?: boolean } | undefined): boolean =>
    item?.status === 'PASS' && item.verified === true && item.evidenceComplete === true;
  const scope = new Set(input.scopeCaseIds ?? input.cases.map((item) => item.caseId));
  const isInScope = (problem: BaselineProblem): boolean => problem.affectedCases.length > 0
    && problem.affectedCases.every((caseId) => scope.has(caseId));
  const newlyBlocked = input.cases.filter((item) => item.status === 'BLOCKED' && beforeCases.get(item.caseId)?.status !== 'BLOCKED').map((item) => item.caseId);
  const fixedProblems = [...beforeProblems].filter(([signature, problem]) => !afterProblems.has(signature) && isInScope(problem)
    && problem.affectedCases.every((caseId) => verifiedPass(currentCases.get(caseId)))).map(([, problem]) => problem.id);
  const problemLifecycle: DevTestBaselineDiff['problemLifecycle'] = [
    ...input.problems.map((problem) => ({ problemId: problem.id, status: problem.lifecycle ?? 'OPEN' })),
    ...fixedProblems.map((problemId) => ({ problemId, status: 'FIXED' as const })),
    ...[...beforeProblems.values()].filter((problem) => !isInScope(problem) && !input.problems.some((item) => item.id === problem.id))
      .map((problem) => ({ problemId: problem.id, status: problem.lifecycle ?? 'OPEN' })),
  ];
  const target = input.rerunTarget;
  const targetProblem = target && /^P\d{3,}$/i.test(target)
    ? input.problems.find((problem) => problem.id.toUpperCase() === target.toUpperCase()) : undefined;
  const targetFixed = target && fixedProblems.some((id) => id.toUpperCase() === target.toUpperCase());
  const rerunOutcomes: DevTestBaselineDiff['rerunOutcomes'] = target ? [{
    target,
    status: targetFixed ? 'FIXED'
      : targetProblem ? (targetProblem.failureClass === 'PRODUCT_BUG' ? 'STILL_FAIL' : 'BLOCKED')
        : input.cases.some((item) => item.status === 'FAIL' && verifiedPass(beforeCases.get(item.caseId))) ? 'REGRESSION'
          : input.cases.some((item) => item.status === 'BLOCKED' || item.status === 'NOT_EXECUTED') ? 'BLOCKED' : 'FIXED',
  }] : [];
  return {
    baselineRunId: input.baseline?.runId,
    currentRunId: input.currentRunId,
    newProblems: [...afterProblems].filter(([signature]) => !beforeProblems.has(signature)).map(([, problem]) => problem.id),
    resolvedProblems: fixedProblems,
    persistentProblems: [...afterProblems].filter(([signature]) => beforeProblems.has(signature)).map(([, problem]) => problem.id),
    newBlocked: newlyBlocked,
    newlyBlocked,
    regressions: input.cases.filter((item) => item.status === 'FAIL' && verifiedPass(beforeCases.get(item.caseId))).map((item) => item.caseId),
    unchanged: input.cases.filter((item) => beforeCases.get(item.caseId)?.status === item.status).map((item) => item.caseId),
    rerunCaseIds: [...(input.rerunCaseIds ?? [])],
    problemLifecycle,
    rerunOutcomes,
  };
}

export async function saveDevTestBaseline(input: {
  outDir: string; markdown: string; runId: string;
  sourceKey?: string;
  cases: Array<{ caseId: string; status: string; durationMs?: number; verified?: boolean; evidenceComplete?: boolean;
    oracleVerdict?: string }>;
  problems: readonly DevTestProblem[];
  testCases?: readonly TestCase[];
  baselineDiff?: DevTestBaselineDiff;
  previousBaseline?: DevTestBaselineSnapshot;
  scopeCaseIds?: readonly string[];
  requirementAcIds?: readonly string[];
  codeVersion?: string;
  contractVersion?: string;
}): Promise<void> {
  const target = baselinePath(input.outDir, input.markdown, input.sourceKey);
  await mkdir(path.dirname(target), { recursive: true });
  const scope = new Set(input.scopeCaseIds ?? input.cases.map((item) => item.caseId));
  const previousCaseById = new Map((input.previousBaseline?.cases ?? []).map((item) => [item.caseId, item]));
  const currentCases = input.cases.map((item) => ({
    ...item,
    history: [
      ...(previousCaseById.get(item.caseId)?.history ?? []),
      { runId: input.runId, status: item.status, durationMs: item.durationMs ?? 0, at: new Date().toISOString() },
    ].slice(-20),
    contracts: input.testCases?.find((testCase) => testCase.id === item.caseId)?.contractDependencies
      ?.filter((dependency): dependency is typeof dependency & { fingerprint: string } => Boolean(dependency.fingerprint))
      .map((dependency) => ({ contractId: dependency.contractId, fingerprint: dependency.fingerprint })),
  }));
  const currentProblems = input.problems.map((problem) => ({ signature: problemSignature(problem), id: problem.id,
    affectedCases: [...problem.affectedCases], lifecycle: problem.lifecycle, failureClass: problem.failureClass,
    rootCause: problem.rootCause }));
  const retainedProblems = (input.previousBaseline?.problems ?? []).filter((problem) =>
    !problem.affectedCases.length || problem.affectedCases.some((caseId) => !scope.has(caseId)));
  const fixedProblems = (input.previousBaseline?.problems ?? []).filter((problem) =>
    input.baselineDiff?.resolvedProblems.includes(problem.id)).map((problem) => ({ ...problem, lifecycle: 'FIXED' as const }));
  const snapshot: DevTestBaselineSnapshot = {
    runId: input.runId,
    requirementHash: requirementHash(input.markdown),
    sourceKey: input.sourceKey,
    cases: [
      ...(input.previousBaseline?.cases ?? []).filter((item) => !scope.has(item.caseId)),
      ...currentCases,
    ],
    problems: [...retainedProblems, ...fixedProblems, ...currentProblems].filter((problem, index, all) =>
      all.findIndex((candidate) => candidate.signature === problem.signature) === index),
    regressionCaseIds: [...new Set([
      ...(input.previousBaseline?.regressionCaseIds ?? []).filter((caseId) => !scope.has(caseId)),
      ...(input.baselineDiff?.regressions ?? []),
    ])],
    requirementAcIds: [...(input.requirementAcIds ?? input.previousBaseline?.requirementAcIds ?? [])],
    codeVersion: input.codeVersion ?? input.previousBaseline?.codeVersion,
    contractVersion: input.contractVersion ?? input.previousBaseline?.contractVersion,
  };
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  await rename(temporary, target);
}
