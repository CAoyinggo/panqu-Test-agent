/**
 * DevTest 编排器：需求文档 → 五维用例 → SAFE 初步验证 → 问题清单 → 固定产物。
 *
 * 复用边界（不重造）：
 * - 解析/用例生成/质量门禁/执行全部走 runAcceptancePipeline；
 * - 本层只负责：输入源解析（本地/飞书）、SAFE 安全策略推导、写路径闸门注入、
 *   统一问题清单、固定格式产物落盘。
 *
 * fail-closed 承诺：
 * - 写路径默认挂起（SAFE_MODE_MUTATION_HOLD），只有显式 confirmMutations 放行；
 * - DRY_RUN 模式零 HTTP 调用；
 * - 飞书拉取失败、文档为空、策略缺失都以结构化错误暴露，绝不静默降级。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { runAcceptancePipeline } from '../acceptance/acceptance-pipeline.js';
import { parseAcceptanceRequirement } from '../acceptance/requirement-parser.js';
import type { AcceptanceExecutionSafetyPolicy } from '../acceptance/acceptance-safety-policy.js';

import { buildDevTestReportEnvelope, renderCasesCsv, renderDevTestHtml, renderProblemsMarkdown } from './artifacts.js';
import { fetchFeishuDoc, loadFeishuCredentials } from './feishu-fetch.js';
import { buildDevTestProblems, deriveDevTestConclusion } from './problem-engine.js';
import { SafeMutationHoldProcessor, buildOperationPolicies } from './safe-mode.js';
import type { DevTestOptions, DevTestRunResult } from './types.js';

async function resolveMarkdown(options: DevTestOptions): Promise<{ markdown: string; docSource: string }> {
  if (options.markdown !== undefined) {
    if (!options.markdown.trim()) throw new Error('DEVTEST_INPUT_EMPTY：markdown 输入为空');
    return { markdown: options.markdown, docSource: options.documentId ?? 'inline-markdown' };
  }
  if (options.docPath !== undefined) {
    const content = await readFile(options.docPath, 'utf8');
    if (!content.trim()) throw new Error(`DEVTEST_INPUT_EMPTY：文档为空：${options.docPath}`);
    return { markdown: content, docSource: options.docPath };
  }
  if (options.feishuUrl !== undefined) {
    const credentials = await loadFeishuCredentials(options.feishuCredentialsPath);
    const content = await fetchFeishuDoc(options.feishuUrl, credentials);
    return { markdown: content, docSource: options.feishuUrl };
  }
  throw new Error('DEVTEST_INPUT_MISSING：必须提供 --doc <文件> / --feishu <链接> / markdown 输入之一');
}

export async function runDevTest(options: DevTestOptions): Promise<DevTestRunResult> {
  const { markdown, docSource } = await resolveMarkdown(options);

  // 预解析仅为推导安全策略；管线内部会再次完整解析，两者同源无漂移风险。
  const requirement = parseAcceptanceRequirement(markdown, { documentId: options.documentId });

  let origin: string;
  try {
    origin = new URL(options.baseUrl).origin;
  } catch {
    throw new Error(`DEVTEST_BASE_URL_INVALID：baseUrl 不是合法 URL：${options.baseUrl}`);
  }
  const safetyPolicy: AcceptanceExecutionSafetyPolicy = {
    environment: options.environment,
    allowedOrigins: options.environment.toLowerCase() === 'local' ? undefined : [origin],
    operationPolicies: buildOperationPolicies(requirement.apis),
    // 仅 local loopback 允许显式豁免 Cleanup；test/integration 的写路径必须配置 Cleanup。
    allowNoCleanup: options.environment.toLowerCase() === 'local',
  };

  const pipelineResult = await runAcceptancePipeline({
    markdown,
    project: options.project ?? 'devtest',
    documentId: options.documentId,
    baseUrl: options.baseUrl,
    environment: options.environment,
    safetyPolicy,
    mode: options.dryRun ? 'dry-run' : 'execute',
    processor: options.dryRun ? undefined : new SafeMutationHoldProcessor({ confirmMutations: options.confirmMutations === true }),
    actorHeaders: options.actorHeaders,
    maxCases: options.maxCases,
    signal: options.signal,
    lifecycle: (options.lifecyclePrepare || options.lifecycleCleanup)
      ? {
        prepare: options.lifecyclePrepare,
        cleanup: options.lifecycleCleanup,
      }
      : undefined,
  });

  const { problems, dimensionStats } = buildDevTestProblems({
    report: pipelineResult.report,
    contracts: pipelineResult.contracts,
    results: pipelineResult.results,
    requirementWarnings: pipelineResult.requirement.warnings.map((warning) => ({
      code: warning.code,
      message: warning.message,
      blocking: warning.blocking,
    })),
  });

  const pendingMutationCaseIds = pipelineResult.results
    .filter((result) => result.attribution?.reason?.startsWith('SAFE_MODE_MUTATION_HOLD'))
    .map((result) => result.caseId);

  const conclusion = deriveDevTestConclusion(pipelineResult.report);
  const generatedAt = new Date().toISOString();
  const renderInput = {
    runId: pipelineResult.runId,
    generatedAt,
    meta: {
      docSource,
      baseUrl: options.baseUrl,
      environment: options.environment,
      mode: options.dryRun ? ('dry-run' as const) : ('execute' as const),
      confirmMutations: options.confirmMutations === true,
    },
    conclusion,
    report: pipelineResult.report,
    problems,
    dimensionStats,
    pendingMutationCaseIds,
  };

  const baseDir = options.outDir ?? path.join('output', 'devtest');
  const dir = path.join(baseDir, pipelineResult.runId);
  await mkdir(dir, { recursive: true });

  const artifacts = {
    dir,
    requirementMd: path.join(dir, 'requirement.md'),
    reportHtml: path.join(dir, 'report.html'),
    reportJson: path.join(dir, 'report.json'),
    casesCsv: path.join(dir, 'cases.csv'),
    problemsMd: path.join(dir, 'problems.md'),
  };
  await Promise.all([
    writeFile(artifacts.requirementMd, markdown, 'utf8'),
    writeFile(artifacts.reportHtml, renderDevTestHtml(renderInput), 'utf8'),
    writeFile(artifacts.reportJson, `${JSON.stringify(buildDevTestReportEnvelope(renderInput), null, 2)}\n`, 'utf8'),
    writeFile(artifacts.casesCsv, renderCasesCsv({ report: pipelineResult.report }), 'utf8'),
    writeFile(artifacts.problemsMd, renderProblemsMarkdown(problems, { conclusion, pendingMutationCaseIds }), 'utf8'),
  ]);

  return {
    runId: pipelineResult.runId,
    conclusion,
    pendingMutationCaseIds,
    problems,
    dimensionStats,
    artifacts,
    pipeline: {
      summary: pipelineResult.report.summary,
      trust: pipelineResult.report.trust,
      mode: options.dryRun ? 'dry-run' : 'execute',
    },
  };
}
