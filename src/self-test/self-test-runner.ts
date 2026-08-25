import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import type { ApiSpec, HttpMethod } from '../acceptance/requirement-ir.js';
import { createAcceptanceHttpScenarioProcessor, runScenario, type ScenarioProcessor } from '../acceptance/scenario-runner.js';
import type { ExecutionApproval, ProjectExecutionPolicy } from '../agents/policy/policy-gate.js';
import { createPhase1ContractResolver } from '../contracts/seed-contracts.js';
import type { ContractResolver } from '../contracts/resolver.js';
import type { ContractResolution } from '../contracts/types.js';
import { discoverChanges } from '../discovery/change/change-discovery.js';
import { resolveDiscoveredOperations } from '../discovery/api/api-discovery.js';
import { discoverOpenApi, mergeOperations, type OpenApiDocument } from '../discovery/api/source-scanners.js';
import { observeRuntime, type RuntimeProbeInput } from '../discovery/api/runtime-discovery.js';
import { buildOperationGraph } from '../discovery/operation-graph.js';
import { operationId, normalizeOperationPath } from '../discovery/operation-id.js';
import type { DiscoveredOperation } from '../discovery/types.js';
import { ObserverRegistry } from '../observers/registry.js';
import { observeProcessor } from '../observers/processor-observer.js';
import { classifyFeatureRisk } from './risk-classifier.js';
import { generateMinimalSelfTestPack } from './pack-generator.js';
import { evaluateSelfTestSafety } from './execution-safety.js';
import { deriveFeatureResult, evidenceSummary, inferUnknowns, terminalScenarioResult } from './report.js';
import type {
  DeveloperSelfTestInput, DeveloperSelfTestReport, SelfTestExecutionMode, SelfTestScenarioResult,
} from './types.js';

const execFile = promisify(execFileCallback);

export interface DeveloperSelfTestOptions {
  mode?: SelfTestExecutionMode;
  root?: string;
  changedContents?: ReadonlyMap<string, string>;
  openApiDocuments?: Array<{ document: OpenApiDocument; ref: string }>;
  runtimeProbes?: RuntimeProbeInput[];
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  resolver?: ContractResolver;
  observers?: ObserverRegistry;
  processors?: readonly ScenarioProcessor[];
  actorHeaders?: Record<string, Record<string, string>>;
  approval?: ExecutionApproval;
  projectPolicy?: ProjectExecutionPolicy;
  estimatedCost?: number;
  environmentAvailable?: boolean;
  signal?: AbortSignal;
}

async function changedFiles(input: DeveloperSelfTestInput, root: string): Promise<string[]> {
  if (input.changedFiles?.length) return [...input.changedFiles];
  if (!input.commit) return [];
  const { stdout } = await execFile('git', ['diff', '--name-only', '--diff-filter=ACMRT', input.commit], { cwd: root });
  return stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

function entrypointOperations(entrypoints: readonly string[]): DiscoveredOperation[] {
  return entrypoints.map((entrypoint) => {
    const url = new URL(entrypoint, 'http://self-test.local');
    const path = normalizeOperationPath(url.pathname);
    return {
      id: operationId('GET', path), method: 'GET', path,
      source: [{ type: 'FRONTEND', ref: `developer-entrypoint:${entrypoint}`, confidence: 0.6 }],
      confidence: 0.6, safeProbe: true,
    };
  });
}

function apiSpecs(operations: readonly DiscoveredOperation[]): ApiSpec[] {
  return operations.filter((operation) => ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(operation.method)).map((operation) => ({
    id: operation.id, operationKey: `${operation.method} ${operation.path}`,
    authPolicy: operation.auth === undefined ? 'AUTH_UNKNOWN'
      : (operation.auth as { required?: boolean }).required === false ? 'AUTH_NOT_REQUIRED' : 'AUTH_REQUIRED',
    method: operation.method as HttpMethod, path: operation.path,
    headers: [], query: [], pathParams: [], body: [],
    responses: operation.observed ? [{ status: operation.observed.status }] : [],
  }));
}

function featureId(input: DeveloperSelfTestInput): string {
  return input.module?.trim() || input.requirement?.id?.trim() || input.branch?.trim() || 'developer-change';
}

function featureContracts(input: DeveloperSelfTestInput, resolver: ContractResolver): ContractResolution[] {
  if (!input.module?.trim()) return [];
  const queries = [
    { kind: 'model' as const, subject: input.module, environment: input.environment },
    { kind: 'enum' as const, subject: `${input.module}.workflow`, environment: input.environment },
  ];
  // Module name alone does not imply that every feature needs a model/workflow Contract.
  // Resolve only identities already known by the Registry; Wan3 is picked up generically.
  return queries.filter((query) => resolver.registry.candidates(query).length > 0)
    .map((query) => resolver.resolve(query));
}

export async function runDeveloperSelfTest(
  input: DeveloperSelfTestInput,
  options: DeveloperSelfTestOptions = {},
): Promise<DeveloperSelfTestReport> {
  if (!input.environment?.trim()) throw new Error('SELF_TEST_INPUT_INVALID：environment 必填');
  if (!input.requirement && !input.changedFiles?.length && !input.commit && !input.entrypoints?.length) {
    throw new Error('SELF_TEST_INPUT_INVALID：requirement / changedFiles / commit / entrypoints 至少提供一项');
  }
  const startedAt = new Date().toISOString();
  const runId = `SELF-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const root = options.root ?? process.cwd();
  const mode = options.mode ?? 'SAFE';
  const resolver = options.resolver ?? createPhase1ContractResolver();
  const files = await changedFiles(input, root);
  const change = await discoverChanges(files, { root, contents: options.changedContents });
  const openApi = (options.openApiDocuments ?? []).flatMap((item) => discoverOpenApi(item.document, item.ref));
  const entrypoints = entrypointOperations(input.entrypoints ?? []);
  let runtime: DiscoveredOperation[] = [];
  const warnings = [...change.warnings];
  const requestedRuntimeProbes = options.runtimeProbes ?? (input.entrypoints ?? []).map((entrypoint): RuntimeProbeInput => {
    const url = new URL(entrypoint, options.baseUrl ?? 'http://self-test.local');
    return { method: 'GET', path: `${url.pathname}${url.search}` };
  });
  if (requestedRuntimeProbes.length && mode !== 'DRY_RUN') {
    if (!options.baseUrl) warnings.push('RUNTIME_DISCOVERY_BLOCKED：runtimeProbes 已配置但缺少 baseUrl');
    else {
      const observed = await observeRuntime(requestedRuntimeProbes, {
        baseUrl: options.baseUrl, fetchImpl: options.fetchImpl, signal: options.signal, timeoutMs: 10_000,
      });
      runtime = observed.operations;
      warnings.push(...observed.errors.map((error) => `RUNTIME_DISCOVERY_FAILED：${error}`));
    }
  }
  const operations = mergeOperations([...change.operations, ...openApi, ...entrypoints, ...runtime]);
  const resolved = resolveDiscoveredOperations(operations, resolver, input.environment);
  const moduleResolutions = featureContracts(input, resolver);
  const contracts = [...resolved.map((item) => item.resolution), ...moduleResolutions];
  const graph = buildOperationGraph(operations);
  const risk = classifyFeatureRisk(operations, change.files);
  const pack = generateMinimalSelfTestPack(
    featureId(input), resolved, risk,
    moduleResolutions.filter((item) => item.status === 'RESOLVED' && item.contract).map((item) => item.contract!),
  );
  const registry = options.observers ?? new ObserverRegistry();
  let processors = [...(options.processors ?? [])];
  if (!processors.length && options.baseUrl) processors = [createAcceptanceHttpScenarioProcessor({
    baseUrl: options.baseUrl, fetchImpl: options.fetchImpl, actorHeaders: options.actorHeaders,
    apiSpecs: apiSpecs(operations), contractResolver: resolver,
  })];
  processors = processors.map((processor) => observeProcessor(processor, registry, input.environment));
  const scenarioResults: SelfTestScenarioResult[] = [];
  for (const scenario of pack.scenarios) {
    const safety = evaluateSelfTestSafety(scenario, input, mode, risk, {
      approval: options.approval, projectPolicy: options.projectPolicy, estimatedCost: options.estimatedCost,
    });
    if (!safety.allowed) {
      scenarioResults.push({
        scenario, safety,
        result: terminalScenarioResult(scenario, safety.disposition === 'NOT_EXECUTED' ? 'NOT_EXECUTED' : 'BLOCKED', safety.reasons, runId),
      });
      continue;
    }
    const outcome = await runScenario(scenario, {
      runId, processors, signal: options.signal,
      environmentAvailable: options.environmentAvailable ?? Boolean(options.baseUrl || options.processors?.length),
      policyAllowed: true, contractResolver: resolver, requireContractDependencies: true,
      additionalEvidenceKinds: new Set(registry.capabilities().has('DATABASE') ? ['DATABASE'] : []),
      sideEffectFreeProbe: () => mode === 'SAFE' && scenario.metadata?.safeProbe === true
        && scenario.tags?.includes('validation') === true,
    });
    scenarioResults.push({ scenario, safety, result: outcome.result });
  }
  const unknowns = inferUnknowns(scenarioResults);
  if (!operations.length) unknowns.push({ type: 'UNKNOWN_API', reason: 'Discovery 没有发现任何 API Operation', requiredCapability: 'changed route/controller/OpenAPI/runtime observation' });
  if (moduleResolutions.some((item) => item.status !== 'RESOLVED')) unknowns.push({ type: 'UNKNOWN_CONTRACT', reason: 'Module model/workflow Contract 未完全解析', requiredCapability: 'ACTIVE model and workflow Contract', relatedId: input.module });
  const finishedAt = new Date().toISOString();
  const blockedReasons = [...new Set(scenarioResults.flatMap((item) => [...item.safety.reasons, ...item.result.blockedReasons.map((reason) => `${reason.code}：${reason.message}`)]))];
  return {
    schemaVersion: 'developer-self-test-report.v1', runId, feature: featureId(input),
    requirement: input.requirement ? { id: input.requirement.id, ref: input.requirement.ref } : undefined,
    commit: input.commit, branch: input.branch, environment: input.environment, mode,
    discovery: { ...change, operations, warnings }, graph, contracts, risk,
    pack: {
      generated: pack.scenarios.length,
      executable: scenarioResults.filter((item) => item.safety.allowed).length,
      blocked: scenarioResults.filter((item) => !item.safety.allowed || item.result.status === 'BLOCKED').length,
    },
    scenarios: scenarioResults, evidence: evidenceSummary(scenarioResults),
    result: deriveFeatureResult(scenarioResults), blockedReasons, unknowns,
    startedAt, finishedAt, durationMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
  };
}
