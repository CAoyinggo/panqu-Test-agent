import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { TestCase } from '../agents/test-design/testcase-schema.js';
import type { AcceptanceCaseExecutionResult } from './api-processor.js';
import type { runAcceptancePipeline } from './acceptance-pipeline.js';
import { redactAcceptanceArtifact, writeAcceptanceReports, type AcceptanceReport } from './acceptance-report.js';
import type { AcceptanceExecutionPlanIdentity } from './acceptance-execution-plan.js';
import { ACCEPTANCE_CASE_IDENTITY_POLICY } from './acceptance-execution-plan.js';
import type { FactBasedRegressionPlan } from './acceptance-regression.js';

export type AcceptancePipelineExecution = Awaited<ReturnType<typeof runAcceptancePipeline>>;

export interface AcceptanceRunManifest {
  schemaVersion?: number;
  operationIdentityPolicy?: 'HTTP_METHOD_EXACT_PATH_V1';
  caseIdentityPolicy?: typeof ACCEPTANCE_CASE_IDENTITY_POLICY;
  executionPlan?: AcceptanceExecutionPlanIdentity;
  regressionPlan?: FactBasedRegressionPlan;
  /**
   * SAFE 仅表示归档 requirement.md 与原始输入逐字一致，能够作为重跑输入。
   * 发生脱敏时只保留审计产物，禁止把掩码值重新发送到被测系统。
   */
  replaySafety?: 'SAFE' | 'BLOCKED_REDACTED_INPUT';
  runId: string;
  parentRunId?: string;
  project: string;
  environment: string;
  mode: 'execute' | 'dry-run';
  createdAt: string;
  requirementFile: 'requirement.md';
  /** 原始解析身份；重放时保持 Fact/Objective/Assertion trace ID 稳定。 */
  requirementDocumentId?: string;
  selectedCaseIds: string[];
}

export interface AcceptanceRunArtifacts {
  runDirectory: string;
  manifest: string;
  requirement: string;
  requirementIr: string;
  testPoints: string;
  testCases: string;
  execution: string;
  defects: string;
  reportJson: string;
  reportMarkdown: string;
  reportHtml: string;
}

function dateDirectory(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

async function writePrivate(file: string, value: string): Promise<void> {
  await writeFile(file, value, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
}

function safeJson(value: unknown): string {
  return `${JSON.stringify(redactAcceptanceArtifact(value), null, 2)}\n`;
}

/** 每次运行创建独立 RUN 目录；使用 wx 写入，绝不覆盖旧报告。 */
export async function writeAcceptanceRunArtifacts(input: {
  execution: AcceptancePipelineExecution;
  markdown: string;
  outputRoot: string;
  project: string;
  environment: string;
  mode: 'execute' | 'dry-run';
  parentRunId?: string;
  regressionPlan?: FactBasedRegressionPlan;
}): Promise<AcceptanceRunArtifacts> {
  const dayDir = path.resolve(input.outputRoot, dateDirectory());
  await mkdir(dayDir, { recursive: true });
  const runDirectory = path.join(dayDir, input.execution.runId);
  await mkdir(runDirectory, { recursive: false, mode: 0o700 });

  const files = {
    manifest: path.join(runDirectory, 'run-manifest.json'),
    requirement: path.join(runDirectory, 'requirement.md'),
    requirementIr: path.join(runDirectory, 'requirement.json'),
    testPoints: path.join(runDirectory, 'test-points.json'),
    testCases: path.join(runDirectory, 'test-cases.json'),
    execution: path.join(runDirectory, 'execution.json'),
    defects: path.join(runDirectory, 'defects.json'),
  };
  const archivedMarkdown = String(redactAcceptanceArtifact(input.markdown));
  const manifest: AcceptanceRunManifest = {
    schemaVersion: 3,
    operationIdentityPolicy: 'HTTP_METHOD_EXACT_PATH_V1',
    caseIdentityPolicy: ACCEPTANCE_CASE_IDENTITY_POLICY,
    replaySafety: archivedMarkdown === input.markdown ? 'SAFE' : 'BLOCKED_REDACTED_INPUT',
    runId: input.execution.runId,
    parentRunId: input.parentRunId,
    project: input.project,
    environment: input.environment,
    mode: input.mode,
    createdAt: input.execution.report.generatedAt,
    requirementFile: 'requirement.md',
    requirementDocumentId: input.execution.requirement.source.documentId,
    selectedCaseIds: input.execution.testCases.map((testCase) => testCase.id),
    executionPlan: input.execution.executionPlan,
    regressionPlan: input.regressionPlan,
  };
  await Promise.all([
    writePrivate(files.manifest, safeJson(manifest)),
    writePrivate(files.requirement, archivedMarkdown),
    writePrivate(files.requirementIr, safeJson(input.execution.requirement)),
    writePrivate(files.testPoints, safeJson(input.execution.testPoints)),
    writePrivate(files.testCases, safeJson(input.execution.testCases)),
    writePrivate(files.execution, safeJson({ outcome: input.execution.outcome, results: input.execution.results })),
    writePrivate(files.defects, safeJson(input.execution.defects)),
  ]);
  const reports = await writeAcceptanceReports(input.execution.report, runDirectory, 'report');
  return {
    runDirectory,
    ...files,
    reportJson: reports.json,
    reportMarkdown: reports.markdown,
    reportHtml: reports.html,
  };
}

export async function findAcceptanceRun(outputRoot: string, runId: string): Promise<{
  directory: string;
  manifest: AcceptanceRunManifest;
  markdown: string;
  testCases: TestCase[];
}> {
  if (!/^RUN-[0-9A-HJKMNP-TV-Z]{26}$/.test(runId) || path.basename(runId) !== runId) {
    throw new Error(`非法 Run ID：${runId}`);
  }
  let dates: string[] = [];
  try {
    dates = await readdir(path.resolve(outputRoot));
  } catch {
    throw new Error(`报告输出目录不存在：${path.resolve(outputRoot)}`);
  }
  for (const date of dates.sort().reverse()) {
    const directory = path.join(path.resolve(outputRoot), date, runId);
    try {
      const manifest = JSON.parse(await readFile(path.join(directory, 'run-manifest.json'), 'utf8')) as AcceptanceRunManifest;
      const markdown = await readFile(path.join(directory, manifest.requirementFile), 'utf8');
      let testCases: TestCase[];
      try {
        testCases = JSON.parse(await readFile(path.join(directory, 'test-cases.json'), 'utf8')) as TestCase[];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error(`Run ${runId} 缺少 test-cases.json，必须迁移或重新建立基线后才能安全重跑`);
        }
        throw error;
      }
      if (manifest.runId !== runId) throw new Error('Run Manifest ID 不一致');
      return { directory, manifest, markdown, testCases };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  throw new Error(`未找到 Run：${runId}`);
}

/**
 * Regression requires archived deterministic execution evidence in addition to
 * the replay input. Missing or inconsistent artifacts must never degrade to a
 * full rerun because that would silently expand the authorized side effects.
 */
export async function findAcceptanceRegressionSource(outputRoot: string, runId: string): Promise<{
  directory: string;
  manifest: AcceptanceRunManifest;
  markdown: string;
  testCases: TestCase[];
  results: AcceptanceCaseExecutionResult[];
  report: AcceptanceReport;
}> {
  const run = await findAcceptanceRun(outputRoot, runId);
  try {
    const execution = JSON.parse(await readFile(path.join(run.directory, 'execution.json'), 'utf8')) as {
      results?: AcceptanceCaseExecutionResult[];
    };
    const report = JSON.parse(await readFile(path.join(run.directory, 'report.json'), 'utf8')) as AcceptanceReport;
    if (!Array.isArray(execution.results)) throw new Error('execution.json 缺少 results');
    if (!report || report.runId !== runId || !Array.isArray(report.defects)) {
      throw new Error('report.json Run ID 或 defects 契约无效');
    }
    const archivedIds = new Set(run.testCases.map((testCase) => testCase.id));
    const unauthorized = run.testCases
      .filter((testCase) => !run.manifest.selectedCaseIds.includes(testCase.id))
      .map((testCase) => testCase.id);
    const unknownResults = execution.results.filter((result) => !archivedIds.has(result.caseId)).map((result) => result.caseId);
    const missingArchived = run.manifest.selectedCaseIds.filter((caseId) => !archivedIds.has(caseId));
    const planScope = [...(run.manifest.executionPlan?.selectedCaseIds ?? [])].sort();
    const manifestScope = [...run.manifest.selectedCaseIds].sort();
    const scopeIdentityMismatch = JSON.stringify(planScope) !== JSON.stringify(manifestScope);
    const resultIds = execution.results.map((result) => result.caseId);
    const duplicateResults = resultIds.filter((caseId, index) => resultIds.indexOf(caseId) !== index);
    const productFailureIds = new Set(execution.results
      .filter((result) => result.status === 'FAIL' && result.executed === true && result.classification === 'PRODUCT_FAILURE')
      .map((result) => result.caseId));
    const defectCaseIds = new Set(report.defects.flatMap((defect) => defect.affectedCaseIds ?? defect.relatedCases ?? []));
    const unattributedFailures = [...productFailureIds].filter((caseId) => !defectCaseIds.has(caseId));
    if (unauthorized.length || unknownResults.length || missingArchived.length || duplicateResults.length
      || unattributedFailures.length || scopeIdentityMismatch) {
      throw new Error(`归档范围/归因不一致：unauthorized=${unauthorized.join(',') || '-'} unknownResults=${unknownResults.join(',') || '-'} missingArchived=${missingArchived.join(',') || '-'} duplicateResults=${duplicateResults.join(',') || '-'} unattributedFailures=${unattributedFailures.join(',') || '-'} scopeIdentityMismatch=${scopeIdentityMismatch}`);
    }
    return { ...run, results: execution.results, report };
  } catch (error) {
    throw new Error(`REGRESSION_ARCHIVE_INVALID：Run ${runId} 缺少可信回归证据：${(error as Error).message}`);
  }
}
