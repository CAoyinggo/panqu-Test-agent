import type { AcceptanceRequirement } from './requirement-ir.js';
import { parseAcceptanceRequirement } from './requirement-parser.js';
import type { BlockedReason, Scenario } from './scenario-contract.js';
import { parseScenarioMarkdown, type ScenarioMarkdownParseResult } from './scenario-markdown-parser.js';
import { buildScenarioExecutionReport, type ScenarioExecutionReport } from './scenario-report.js';
import { runScenario, type ScenarioRunOutcome, type ScenarioRunnerOptions } from './scenario-runner.js';
import { scoreScenarioQuality, type ScenarioQualityResult } from './scenario-quality.js';
import { selectTestPatterns, TEST_PATTERN_IDS, type SelectedTestPattern, type TestPatternId } from './test-pattern-registry.js';
import { loadScenarioAssetPack, type ScenarioAssetPack } from './scenario-asset-loader.js';
import { contractDependency } from '../contracts/dependency-index.js';
import { registerAcceptanceApiContracts } from '../contracts/contract-gate.js';
import { createPhase1ContractResolver } from '../contracts/seed-contracts.js';
import { contractSource } from '../contracts/source-priority.js';

export interface ScenarioPipelineOptions extends ScenarioRunnerOptions {
  markdown: string;
  documentId?: string;
  domain?: string;
}

export interface ScenarioPipelineResult {
  parse: ScenarioMarkdownParseResult;
  requirement: AcceptanceRequirement;
  selectedPatterns: SelectedTestPattern[];
  scenario: Scenario;
  run: ScenarioRunOutcome;
  quality: ScenarioQualityResult;
  report: ScenarioExecutionReport;
}

export interface ScenarioAssetPipelineOptions extends ScenarioRunnerOptions {
  directory: string;
}

export interface ScenarioAssetPipelineResult extends ScenarioPipelineResult {
  asset: ScenarioAssetPack;
}

function designBlock(code: BlockedReason['code'], message: string, details: Record<string, unknown> = {}): BlockedReason {
  return { code, stage: 'DESIGN', message, details, recoverable: true };
}

interface ScenarioCriterionMetadata {
  id: string;
  description: string;
}

/**
 * Pattern/冲突分析只消费需求事实与 AC。API Contract、Assertions、Cleanup 等
 * Scenario 实现章节不能反向生成“需求事实”，否则观察步骤、清理动作或断言
 * 文案会制造伪 Pattern，甚至把同一拒绝场景误报为 ALLOW/DENY 冲突。
 */
function requirementProjection(scenario: Scenario): string {
  const metadata = scenario.metadata?.acceptanceCriteria;
  const criteria = Array.isArray(metadata)
    ? metadata.filter((item): item is ScenarioCriterionMetadata => Boolean(
      item && typeof item === 'object'
      && typeof (item as Record<string, unknown>).id === 'string'
      && typeof (item as Record<string, unknown>).description === 'string',
    ))
    : [];
  const criteriaMarkdown = criteria.length
    ? criteria.map((item) => `### ${item.id}\n\n${item.description}`).join('\n\n')
    : scenario.acceptanceCriteriaIds.map((id) => `### ${id}\n\n${id}`).join('\n\n');
  return `# Requirement\n\n${scenario.requirement}\n\n## Acceptance Criteria\n\n${criteriaMarkdown}`;
}

/** Requirement Markdown → Canonical Scenario → Pattern → Gate → Runner → Evidence Report。 */
export async function runScenarioPipeline(options: ScenarioPipelineOptions): Promise<ScenarioPipelineResult> {
  const parse = parseScenarioMarkdown(options.markdown, { documentId: options.documentId, domain: options.domain });
  const scenario: Scenario = {
    ...parse.scenario,
    patternIds: [...parse.scenario.patternIds],
    blockedReasons: [...parse.scenario.blockedReasons],
  };
  const requirement = parseAcceptanceRequirement(requirementProjection(scenario), { documentId: options.documentId });
  const contractResolver = options.contractResolver && 'registry' in options.contractResolver
    ? options.contractResolver as import('../contracts/resolver.js').ContractResolver
    : createPhase1ContractResolver();
  const requirementContract = contractResolver.registry.register({
    id: `resource.scenario.${scenario.id.toLowerCase()}`,
    kind: 'resource',
    subject: scenario.id,
    version: scenario.schemaVersion,
    status: 'ACTIVE',
    value: { requirement: scenario.requirement, acceptanceCriteriaIds: scenario.acceptanceCriteriaIds },
    sources: [contractSource('markdown', options.documentId ?? `scenario:${scenario.id}`)],
    createdAt: new Date().toISOString(),
  });
  const apiDependencies = registerAcceptanceApiContracts(
    requirement.apis,
    contractResolver,
    options.documentId ?? `scenario:${scenario.id}`,
  );
  scenario.contractDependencies = [
    ...(scenario.contractDependencies ?? []),
    contractDependency(requirementContract),
    ...scenario.operations.flatMap((operation) => {
      const api = requirement.apis.find((candidate) => candidate.method === operation.method && candidate.path === operation.path);
      const dependency = api ? apiDependencies.get(api.id) : undefined;
      return dependency ? [dependency] : [];
    }),
  ].filter((dependency, index, all) => all.findIndex((item) => item.contractId === dependency.contractId) === index);
  contractResolver.registry.recordDependencies(scenario.id, scenario.contractDependencies);

  const knownPatterns = scenario.patternIds.filter((id): id is TestPatternId => (TEST_PATTERN_IDS as readonly string[]).includes(id));
  const unknownPatterns = scenario.patternIds.filter((id) => !(TEST_PATTERN_IDS as readonly string[]).includes(id));
  if (unknownPatterns.length) {
    scenario.blockedReasons.push(designBlock('INVALID_SCENARIO', `未知 Test Pattern：${unknownPatterns.join(', ')}`, { unknownPatterns }));
    scenario.executionMode = 'BLOCKED';
  }
  const selectedPatterns = selectTestPatterns(requirement, knownPatterns);
  scenario.patternIds = [...new Set([...knownPatterns, ...selectedPatterns.map((item) => item.id)])];

  const blockedFacts = requirement.factLedger.filter((fact) => fact.status === 'BLOCKED');
  if (blockedFacts.length) {
    scenario.blockedReasons.push(designBlock('REQUIREMENT_CONFLICT', 'Requirement Fact Ledger 存在冲突，禁止选择性猜测后执行', {
      factIds: blockedFacts.map((fact) => fact.id),
    }));
    scenario.executionMode = 'BLOCKED';
  }

  const run = await runScenario(scenario, { ...options, contractResolver, requireContractDependencies: true });
  const quality = scoreScenarioQuality(scenario, run.gate);
  const report = buildScenarioExecutionReport({ scenario, result: run.result, gate: run.gate, quality });
  return { parse, requirement, selectedPatterns, scenario, run: { ...run, result: report.result }, quality, report };
}

/**
 * Persisted Scenario Pack 的 canonical 入口：先严格校验 requirement.md + expected.json，
 * 再进入与内存 Markdown 完全相同的 Pattern/Gate/Runner/Evidence/Report 主链。
 */
export async function runScenarioAssetPipeline(
  options: ScenarioAssetPipelineOptions,
): Promise<ScenarioAssetPipelineResult> {
  const asset = await loadScenarioAssetPack(options.directory);
  const result = await runScenarioPipeline({
    ...options,
    markdown: asset.markdown,
    documentId: asset.requirementPath,
    domain: asset.parse.scenario.domain,
  });
  return { asset, ...result };
}
