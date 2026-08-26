import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { TestCase } from '../agents/test-design/testcase-schema.js';
import { devTestDimensionOf } from './dimension-selector.js';
import type {
  DevTestCaseProfile,
  DevTestDimensionDecision,
  DevTestDiscoveryResult,
  DevTestEnvironmentPreflight,
  DevTestExtendedDimension,
  DevTestExecutionEstimate,
  DevTestFeatureModel,
  DevTestPlan,
  DevTestTestValueScore,
  DevTestAdaptiveTestScore,
} from './types.js';
import { tierOf } from './dimension-selector.js';

const execFileAsync = promisify(execFile);

export interface DevTestImpactAnalysis {
  changedFiles: string[];
  affectedCaseIds: string[];
  applied: boolean;
  reason: string;
  codeFingerprint: string;
}

function hash(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function normalizeRef(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

export async function analyzeDevTestImpact(input: {
  projectRoot: string;
  testCases: readonly TestCase[];
  discovery: DevTestDiscoveryResult;
  hasBaseline: boolean;
}): Promise<DevTestImpactAnalysis> {
  let changedFiles: string[] = [];
  let codeFingerprint = hash('clean');
  try {
    const [{ stdout }, { stdout: diff }, { stdout: untracked }] = await Promise.all([
      execFileAsync('git', ['diff', '--name-only', '--diff-filter=ACMR', 'HEAD'], {
        cwd: input.projectRoot, timeout: 3_000, maxBuffer: 1024 * 1024,
      }),
      execFileAsync('git', ['diff', '--no-ext-diff', 'HEAD'], {
        cwd: input.projectRoot, timeout: 3_000, maxBuffer: 8 * 1024 * 1024,
      }),
      execFileAsync('git', ['ls-files', '--others', '--exclude-standard'], {
        cwd: input.projectRoot, timeout: 3_000, maxBuffer: 1024 * 1024,
      }),
    ]);
    const untrackedFiles = untracked.split(/\r?\n/).map((item) => normalizeRef(item.trim())).filter(Boolean);
    changedFiles = [...new Set([...stdout.split(/\r?\n/), ...untrackedFiles].map((item) => normalizeRef(item.trim())).filter(Boolean))].sort();
    const untrackedContent = await Promise.all(untrackedFiles.map(async (file) => {
      try { return `${file}:${await readFile(path.join(input.projectRoot, file), 'utf8')}`; } catch { return `${file}:unreadable`; }
    }));
    codeFingerprint = hash(`${diff}\n${untrackedContent.join('\n')}`);
  } catch {
    return { changedFiles: [], affectedCaseIds: [], applied: false,
      reason: 'Git change unavailable；保留风险优先完整核心计划', codeFingerprint: hash('git-unavailable') };
  }
  if (!changedFiles.length) return { changedFiles, affectedCaseIds: [], applied: false,
    reason: '没有未提交的 Git 代码变化', codeFingerprint };

  const changed = new Set(changedFiles);
  const changedOperations = input.discovery.mappedOperations.filter((operation) => operation.source.some((source) => {
    const ref = normalizeRef(source.ref.split(':')[0]);
    return changed.has(ref) || changedFiles.some((file) => ref.endsWith(file) || file.endsWith(ref));
  }));
  const changedUi = input.discovery.mappedUi.some((element) => {
    const ref = normalizeRef(element.source.split(':')[0]);
    return changed.has(ref) || changedFiles.some((file) => ref.endsWith(file) || file.endsWith(ref));
  });
  const affectedCaseIds = input.testCases.filter((testCase) => {
    if (changedUi && devTestDimensionOf(testCase.testType) === 'UI') return true;
    const requests = testCase.steps.filter((step) => step.type === 'HTTP_REQUEST');
    if (requests.some((step) => changedOperations.some((operation) => operation.method === step.method && operation.path === step.url))) return true;
    const dependencies = (testCase.contractDependencies ?? []).map((item) => item.contractId.toLowerCase());
    return changedFiles.some((file) => dependencies.some((dependency) => file.toLowerCase().includes(dependency.replace(/[^a-z0-9]+/g, '/'))));
  }).map((testCase) => testCase.id);
  const mappedRefs = changedOperations.flatMap((operation) => operation.source.map((source) => normalizeRef(source.ref.split(':')[0])));
  const allChangesMapped = changedFiles.every((file) => mappedRefs.some((ref) => ref.endsWith(file) || file.endsWith(ref))
    || (changedUi && input.discovery.mappedUi.some((element) => normalizeRef(element.source).includes(file))));
  const applied = input.hasBaseline && affectedCaseIds.length > 0 && allChangesMapped;
  return {
    changedFiles,
    affectedCaseIds: [...new Set(affectedCaseIds)],
    applied,
    reason: applied
      ? '所有 Git 变化均可追溯到已发现 API/UI；只执行受影响 Case，未变化核心 Case 复用 Baseline 证据'
      : affectedCaseIds.length ? '仅部分变化可追溯；为避免漏测，影响分析只作为报告提示' : '变化无法可靠映射到 Contract/Feature；未缩小执行范围',
    codeFingerprint,
  };
}

interface AssetCacheRecord {
  schema: 'devtest.asset-cache.v1';
  requirementFingerprint: string;
  contractFingerprint: string;
  codeFingerprint: string;
  featureModel: DevTestFeatureModel;
  selectedCaseIds: string[];
  writtenAt: string;
}

function cachePath(outDir: string, sourceKey: string): string {
  return path.join(outDir, '.devtest-cache', `${hash(sourceKey).slice(0, 24)}.json`);
}

export async function readDevTestAssetCache(input: {
  outDir: string;
  sourceKey: string;
  requirementFingerprint: string;
  contractFingerprint: string;
  codeFingerprint: string;
}): Promise<{ status: DevTestPlan['cache']['status']; reason: string; record?: AssetCacheRecord }> {
  try {
    const record = JSON.parse(await readFile(cachePath(input.outDir, input.sourceKey), 'utf8')) as AssetCacheRecord;
    if (record.schema !== 'devtest.asset-cache.v1') return { status: 'INVALIDATED', reason: '缓存 schema 已变化' };
    if (record.requirementFingerprint !== input.requirementFingerprint) return { status: 'INVALIDATED', reason: 'Requirement Changed' };
    if (record.contractFingerprint !== input.contractFingerprint) return { status: 'INVALIDATED', reason: 'Contract Changed' };
    if (record.codeFingerprint !== input.codeFingerprint) return { status: 'INVALIDATED', reason: 'Code Changed' };
    return { status: 'HIT', reason: 'Requirement / Contract / Code 指纹未变化', record };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'MISS', reason: '首次生成测试资产' };
    return { status: 'INVALIDATED', reason: `缓存不可用：${(error as Error).message}` };
  }
}

export async function writeDevTestAssetCache(input: {
  outDir: string;
  sourceKey: string;
  requirementFingerprint: string;
  contractFingerprint: string;
  codeFingerprint: string;
  featureModel: DevTestFeatureModel;
  selectedCaseIds: string[];
}): Promise<void> {
  const target = cachePath(input.outDir, input.sourceKey);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  const record: AssetCacheRecord = {
    schema: 'devtest.asset-cache.v1',
    requirementFingerprint: input.requirementFingerprint,
    contractFingerprint: input.contractFingerprint,
    codeFingerprint: input.codeFingerprint,
    featureModel: input.featureModel,
    selectedCaseIds: input.selectedCaseIds,
    writtenAt: new Date().toISOString(),
  };
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  await rename(temporary, target);
}

function sideEffectOf(testCase: TestCase): DevTestPlan['estimatedSideEffects'][number]['effect'] {
  const method = testCase.steps.find((step) => step.type === 'HTTP_REQUEST')?.method;
  const text = `${testCase.name} ${JSON.stringify(testCase.steps)} ${(testCase.tags ?? []).join(' ')}`;
  if (/billing|charge|payment|扣费/i.test(text)) return 'BILLING';
  if (/provider|external|third.party|供应商|外部/i.test(text)) return 'PROVIDER';
  if (method === 'DELETE') return 'DELETE';
  if (method && ['POST', 'PUT', 'PATCH'].includes(method)) return 'WRITE';
  return 'READ';
}

export function buildDevTestPlan(input: {
  feature: string;
  selected: readonly TestCase[];
  decisions: readonly DevTestDimensionDecision[];
  scores: Record<string, DevTestTestValueScore>;
  profiles: Record<string, DevTestCaseProfile>;
  deduplication: DevTestPlan['deduplication'];
  environment: DevTestEnvironmentPreflight;
  mutationAuthorized: boolean;
  impact: DevTestImpactAnalysis;
  cache: DevTestPlan['cache'];
  extendedDimensions?: Array<{ dimension: DevTestExtendedDimension; applicable: boolean; reason: string; caseIds: string[] }>;
  concurrency?: number;
  businessFlowIds?: string[];
  regressionGuardCaseIds?: string[];
  estimate?: DevTestExecutionEstimate;
  impactFlowIds?: string[];
  impactExpandedCaseIds?: string[];
  adaptiveScores?: Record<string, DevTestAdaptiveTestScore>;
  deep?: boolean;
}): DevTestPlan {
  const effects = input.selected.map((testCase) => {
    const effect = sideEffectOf(testCase);
    const safeRejection = Boolean(testCase.negativeContractIntent)
      || (testCase.parameterContext?.expectedResponse ?? 0) >= 400
      || testCase.assertions.some((assertion) => assertion.type === 'STATUS_CODE'
        && typeof assertion.expected === 'number' && assertion.expected >= 400 && assertion.expected < 500);
    return { caseId: testCase.id, effect, blocked: ['DELETE', 'BILLING', 'PROVIDER'].includes(effect)
      || (effect === 'WRITE' && !input.mutationAuthorized && !safeRejection) };
  });
  const blockedDimensions = new Set(input.environment.blockedDimensions.map((item) => item.dimension));
  const estimatedBlocked = input.selected.filter((testCase) => testCase.executionMode !== 'EXECUTABLE'
    || blockedDimensions.has(devTestDimensionOf(testCase.testType))
    || effects.find((item) => item.caseId === testCase.id)?.blocked).length;
  const highest = Math.max(0, ...input.selected.map((testCase) => input.scores[testCase.id]?.risk ?? 0));
  const parallel = input.selected.filter((testCase) => {
    const method = testCase.steps.find((step) => step.type === 'HTTP_REQUEST')?.method;
    return ['GET', 'HEAD', 'OPTIONS'].includes(method ?? '')
      && !testCase.actor?.tenantId && !['STATE', 'SIDE_EFFECT', 'DATA_ISOLATION'].includes(testCase.testType ?? '');
  });
  const parallelIds = new Set(parallel.map((item) => item.id));
  const serial = input.selected.filter((item) => !parallelIds.has(item.id));
  return {
    feature: input.feature,
    risk: highest >= 5 ? 'CRITICAL' : highest >= 4 ? 'HIGH' : highest >= 2 ? 'MEDIUM' : 'LOW',
    dimensions: input.decisions.map((decision) => ({
      dimension: decision.dimension,
      applicability: decision.applicability,
      cases: input.selected.filter((testCase) => devTestDimensionOf(testCase.testType) === decision.dimension).length,
    })),
    estimatedCases: input.selected.length,
    estimatedExecutable: input.selected.length - estimatedBlocked,
    estimatedBlocked,
    estimatedSideEffects: effects,
    coreCases: Object.values(input.profiles).filter((profile) => profile.core && profile.coreKind)
      .map((profile) => ({ caseId: profile.caseId, kind: profile.coreKind! })),
    deduplication: input.deduplication,
    impact: {
      changedFiles: input.impact.changedFiles,
      affectedCaseIds: input.impact.affectedCaseIds,
      expandedCaseIds: input.impactExpandedCaseIds ?? input.impact.affectedCaseIds,
      affectedFlowIds: input.impactFlowIds ?? [],
      applied: input.impact.applied,
      scopeConfidence: input.impact.applied ? 'HIGH' : 'LOW',
      reason: input.impact.reason,
    },
    cache: input.cache,
    extendedDimensions: input.extendedDimensions ?? [],
    executionGroups: [
      ...(parallel.length ? [{ mode: 'PARALLEL' as const, caseIds: parallel.map((item) => item.id),
        reason: `只读、无共享写状态；最多并发 ${Math.max(1, input.concurrency ?? 1)}` }] : []),
      ...(serial.length ? [{ mode: 'SERIAL' as const, caseIds: serial.map((item) => item.id),
        reason: '写操作、共享 Actor/Tenant/Resource、状态机或隔离场景强制串行' }] : []),
    ],
    businessFlowIds: input.businessFlowIds ?? [],
    regressionGuardCaseIds: input.regressionGuardCaseIds ?? [],
    estimate: input.estimate ?? {
      estimatedCases: input.selected.length,
      estimatedRequests: input.selected.filter((testCase) => testCase.steps.some((step) => step.type === 'HTTP_REQUEST')).length,
      estimatedRuntimeMs: 0,
      estimatedCost: 0,
      costUnit: 'DEVTEST_UNIT',
      limits: { timeoutMs: 10_000 },
      exceeded: [],
    },
    tiers: {
      TIER_0: input.selected.filter((item) => (input.adaptiveScores?.[item.id]?.tier ?? tierOf(item)) === 'TIER_0').map((item) => item.id),
      TIER_1: input.selected.filter((item) => (input.adaptiveScores?.[item.id]?.tier ?? tierOf(item)) === 'TIER_1').map((item) => item.id),
      TIER_2: input.selected.filter((item) => (input.adaptiveScores?.[item.id]?.tier ?? tierOf(item)) === 'TIER_2').map((item) => item.id),
    },
    deep: input.deep === true,
  };
}

export function contractPlanFingerprint(testCases: readonly TestCase[]): string {
  return hash(testCases.flatMap((testCase) => testCase.contractDependencies ?? [])
    .map((dependency) => `${dependency.contractId}@${dependency.version ?? ''}:${dependency.fingerprint ?? ''}`).sort());
}

export function requirementPlanFingerprint(markdown: string): string {
  return hash(markdown);
}
