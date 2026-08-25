import { parseArgs as parseNodeArgs } from 'node:util';
import { isDeepStrictEqual } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { runAcceptancePipeline, type AcceptanceDataLifecycle } from './acceptance-pipeline.js';
import {
  findAcceptanceRegressionSource,
  findAcceptanceRun,
  writeAcceptanceRunArtifacts,
  type AcceptanceRunArtifacts,
} from './acceptance-delivery.js';
import { parseAcceptanceRequirement } from './requirement-parser.js';
import { generateTestPoints } from './test-point.js';
import { generateAcceptanceApiCases } from './test-case-generator.js';
import { applyTestCaseQualityGate } from './test-case-quality-gate.js';
import { buildAcceptanceTestDesign } from './test-objective.js';
import { redactSensitiveText } from '../core/redact.js';
import { redactAcceptanceArtifact } from './acceptance-report.js';
import type { AcceptanceReport } from './acceptance-report.js';
import { isDesignedOnlyCase, type TestCase } from '../agents/test-design/testcase-schema.js';
import {
  ACCEPTANCE_EXECUTION_ENVIRONMENT_ALLOWLIST,
  evaluateAcceptanceExecutionSafety,
  type AcceptanceEnvironmentPolicy,
  type AcceptanceExecutionSafetyPolicy,
  type AcceptanceOperationPolicy,
} from './acceptance-safety-policy.js';
import {
  ACCEPTANCE_CASE_IDENTITY_POLICY,
  type AcceptanceExecutionPlanIdentity,
} from './acceptance-execution-plan.js';
import { buildFactBasedRegressionPlan, type FactBasedRegressionPlan } from './acceptance-regression.js';

export { ACCEPTANCE_EXECUTION_ENVIRONMENT_ALLOWLIST } from './acceptance-safety-policy.js';
export type {
  AcceptanceEnvironmentPolicy,
  AcceptanceExecutionSafetyPolicy,
  AcceptanceOperationEffect,
  AcceptanceOperationPolicy,
} from './acceptance-safety-policy.js';

export class AcceptanceCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AcceptanceCliError';
  }
}

type Mode = 'execute' | 'dry-run';

interface LifecycleRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface AcceptanceConfig {
  project?: string;
  environment?: string;
  mode?: Mode;
  output?: string;
  baseUrl?: string;
  actorHeaders?: Record<string, Record<string, string>>;
  timeoutMs?: number;
  maxCases?: number;
  deadlineMs?: number;
  allowNoCleanup?: boolean;
  dataLifecycle?: { prepare?: LifecycleRequest; cleanup?: LifecycleRequest };
  environmentPolicy?: AcceptanceEnvironmentPolicy;
  /** key 为稳定 Operation Key，例如 `PUT /api/users/{id}`。 */
  operationPolicies?: Record<string, AcceptanceOperationPolicy>;
}

export interface AcceptanceCliArgs {
  help: boolean;
  requirement?: string;
  text?: string;
  output?: string;
  project?: string;
  environment?: string;
  mode?: Mode;
  config?: string;
  baseUrl?: string;
  scope?: string[];
  runId?: string;
  caseId?: string;
  regression: boolean;
  timeoutMs?: number;
  maxCases?: number;
  deadlineMs?: number;
}

export interface AcceptanceCliRunResult {
  exitCode: number;
  runId?: string;
  artifacts?: AcceptanceRunArtifacts;
  conclusion?: string;
  summary?: { total: number; passed: number; failed: number; blocked: number; notExecuted: number };
  warnings?: string[];
  trust?: AcceptanceReport['trust'];
  regression?: FactBasedRegressionPlan;
}

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  requirement: { type: 'string' },
  text: { type: 'string' },
  output: { type: 'string' },
  project: { type: 'string' },
  environment: { type: 'string' },
  mode: { type: 'string' },
  config: { type: 'string' },
  'base-url': { type: 'string' },
  scope: { type: 'string' },
  'run-id': { type: 'string' },
  'case-id': { type: 'string' },
  regression: { type: 'boolean' },
  timeout: { type: 'string' },
  'max-cases': { type: 'string' },
  deadline: { type: 'string' },
} as const;

export const ACCEPTANCE_HELP = `开发验收测试

首次运行：
  npm run acceptance -- --requirement <file|-> [--config acceptance.config.json]

单 Case 重跑：
  npm run acceptance -- --run-id <RUN-id> --case-id <CASE-id> [--config acceptance.config.json]

Fact-based Regression：
  npm run acceptance -- --run-id <RUN-id> --regression [--config acceptance.config.json]

参数：
  --requirement    Markdown/纯文本需求文件；- 表示 stdin
  --text           直接传入需求文本（与 --requirement 互斥）
  --project        项目标识
  --environment    环境；execute 当前仅支持 local/test/integration，Staging 未开放
  --mode           execute 或 dry-run
  --output         报告根目录
  --scope          AC ID 或类型，逗号分隔
  --run-id         已有 Run ID，用于复现
  --case-id        与 --run-id 配合，单独重跑 Case
  --regression     重跑原失败 Case、同 Fact Case 与同测试策略相关 Case
  --config         配置文件；默认查找 ./acceptance.config.json
  --base-url       execute 目标服务 URL；优先级高于配置文件
  --timeout        单个 HTTP 请求超时（毫秒）
  --max-cases      真实执行的最大 Case 数，超限时在请求前阻断
  --deadline       HTTP Execution 阶段时限（毫秒），到期取消请求并阻断剩余 Case

结论边界：
  总结论为 INITIAL_VALIDATION；存在 DESIGNED_ONLY 或未验证 Fact 时只会是 PARTIAL/BLOCKED。
  Operation Contract PASS 与完整 Requirement Verification 始终分开显示。
`;

export function parseAcceptanceCliArgs(argv: string[]): AcceptanceCliArgs {
  let parsed;
  try {
    parsed = parseNodeArgs({ args: argv, options: OPTIONS, allowPositionals: false, strict: true, tokens: true });
  } catch (error) {
    throw new AcceptanceCliError(`参数解析失败：${(error as Error).message}`);
  }
  const seen = new Set<string>();
  for (const token of parsed.tokens) {
    if (token.kind !== 'option') continue;
    if (seen.has(token.name)) throw new AcceptanceCliError(`参数重复：--${token.name}`);
    seen.add(token.name);
  }
  const stringValue = (name: keyof typeof OPTIONS): string | undefined => {
    const value = parsed.values[name];
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !value.trim()) throw new AcceptanceCliError(`参数 --${name} 缺少有效值`);
    return value.trim();
  };
  const mode = stringValue('mode');
  if (mode && mode !== 'execute' && mode !== 'dry-run') throw new AcceptanceCliError('--mode 仅支持 execute 或 dry-run');
  const timeout = stringValue('timeout');
  if (timeout && (!Number.isSafeInteger(Number(timeout)) || Number(timeout) <= 0)) throw new AcceptanceCliError('--timeout 必须是正整数毫秒');
  const maxCases = stringValue('max-cases');
  if (maxCases && (!Number.isSafeInteger(Number(maxCases)) || Number(maxCases) <= 0)) throw new AcceptanceCliError('--max-cases 必须是正整数');
  const deadline = stringValue('deadline');
  if (deadline && (!Number.isSafeInteger(Number(deadline)) || Number(deadline) <= 0)) throw new AcceptanceCliError('--deadline 必须是正整数毫秒');
  const args: AcceptanceCliArgs = {
    help: parsed.values.help === true,
    requirement: stringValue('requirement'),
    text: stringValue('text'),
    output: stringValue('output'),
    project: stringValue('project'),
    environment: stringValue('environment'),
    mode: mode as Mode | undefined,
    config: stringValue('config'),
    baseUrl: stringValue('base-url'),
    scope: stringValue('scope')?.split(',').map((item) => item.trim()).filter(Boolean),
    runId: stringValue('run-id'),
    caseId: stringValue('case-id'),
    regression: parsed.values.regression === true,
    timeoutMs: timeout ? Number(timeout) : undefined,
    maxCases: maxCases ? Number(maxCases) : undefined,
    deadlineMs: deadline ? Number(deadline) : undefined,
  };
  const inputs = [args.requirement, args.text, args.runId].filter(Boolean);
  if (!args.help && inputs.length !== 1) throw new AcceptanceCliError('必须且只能提供 --requirement、--text 或 --run-id 之一');
  if (args.caseId && !args.runId) throw new AcceptanceCliError('--case-id 必须与 --run-id 一起使用');
  if (args.regression && !args.runId) throw new AcceptanceCliError('--regression 必须与 --run-id 一起使用');
  if (args.regression && args.caseId) throw new AcceptanceCliError('--regression 与 --case-id 互斥');
  if (args.regression && args.scope?.length) throw new AcceptanceCliError('--regression 使用 Fact/Policy 完整影响范围，不能再用 --scope 静默缩小');
  return args;
}

function interpolateEnvironment(text: string, env: NodeJS.ProcessEnv): string {
  return text.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_match, name: string) => {
    const value = env[name];
    if (value === undefined) throw new AcceptanceCliError(`配置引用的环境变量未设置：${name}`);
    return value;
  });
}

async function loadConfig(configPath: string | undefined, env: NodeJS.ProcessEnv): Promise<AcceptanceConfig> {
  const candidate = configPath ? path.resolve(configPath) : path.resolve('acceptance.config.json');
  if (!configPath && !fs.existsSync(candidate)) return {};
  let raw: string;
  try {
    raw = await readFile(candidate, 'utf8');
    const parsed = JSON.parse(interpolateEnvironment(raw, env)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('顶层必须是 JSON Object');
    const config = parsed as AcceptanceConfig;
    for (const key of ['timeoutMs', 'maxCases', 'deadlineMs'] as const) {
      const value = config[key];
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new Error(`${key} 必须是正整数`);
    }
    if (config.allowNoCleanup !== undefined && typeof config.allowNoCleanup !== 'boolean') throw new Error('allowNoCleanup 必须是 boolean');
    if (config.environmentPolicy?.allowedOrigins !== undefined
      && (!Array.isArray(config.environmentPolicy.allowedOrigins) || config.environmentPolicy.allowedOrigins.some((value) => typeof value !== 'string' || !value.trim()))) {
      throw new Error('environmentPolicy.allowedOrigins 必须是非空 URL 字符串数组');
    }
    if (config.operationPolicies !== undefined && (!config.operationPolicies || typeof config.operationPolicies !== 'object' || Array.isArray(config.operationPolicies))) {
      throw new Error('operationPolicies 必须是 Object');
    }
    return config;
  } catch (error) {
    throw new AcceptanceCliError(`Acceptance 配置读取失败 ${candidate}：${(error as Error).message}`);
  }
}

function parseActorHeaders(env: NodeJS.ProcessEnv): Record<string, Record<string, string>> | undefined {
  if (!env.ACCEPTANCE_ACTOR_HEADERS_JSON) return undefined;
  try {
    return JSON.parse(env.ACCEPTANCE_ACTOR_HEADERS_JSON) as Record<string, Record<string, string>>;
  } catch (error) {
    throw new AcceptanceCliError(`ACCEPTANCE_ACTOR_HEADERS_JSON 不是合法 JSON：${(error as Error).message}`);
  }
}

async function lifecycleRequest(baseUrl: string, request: LifecycleRequest, timeoutMs: number): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (!/^\/(?!\/)/.test(request.path) || /[\\?#\u0000-\u001f]/.test(request.path)) {
      throw new Error('Lifecycle path 必须是 single-leading-slash 相对路径');
    }
    const base = new URL(baseUrl);
    const target = new URL(request.path, base);
    if (target.origin !== base.origin) throw new Error('Lifecycle target origin 与 baseUrl 不一致');
    const headers = { ...(request.headers ?? {}) };
    const init: RequestInit = { method: request.method ?? 'POST', headers, signal: controller.signal, redirect: 'manual' };
    if (request.body !== undefined) {
      if (!Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(request.body);
    }
    const response = await fetch(target, init);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    throw new Error(redactSensitiveText(`Lifecycle ${request.method ?? 'POST'} ${request.path} 失败：${(error as Error).message}`));
  } finally {
    clearTimeout(timer);
  }
}

function createLifecycle(config: AcceptanceConfig, baseUrl: string, timeoutMs: number): AcceptanceDataLifecycle | undefined {
  if (!config.dataLifecycle) return undefined;
  return {
    prepare: config.dataLifecycle.prepare ? () => lifecycleRequest(baseUrl, config.dataLifecycle!.prepare!, timeoutMs) : undefined,
    cleanup: config.dataLifecycle.cleanup ? () => lifecycleRequest(baseUrl, config.dataLifecycle!.cleanup!, timeoutMs) : undefined,
  };
}

async function readRequirement(args: AcceptanceCliArgs): Promise<{ markdown: string; documentId: string; parentRunId?: string; inherited?: AcceptanceConfig; archivedCases?: TestCase[]; expectedExecutionPlan?: AcceptanceExecutionPlanIdentity }> {
  if (args.runId) throw new Error('run-id requires output lookup');
  if (args.text) return { markdown: args.text, documentId: 'inline-requirement' };
  if (args.requirement === '-') {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return { markdown: Buffer.concat(chunks).toString('utf8'), documentId: 'stdin-requirement' };
  }
  const requirementPath = path.resolve(args.requirement!);
  try {
    const info = await stat(requirementPath);
    if (!info.isFile()) throw new Error('不是文件');
    return { markdown: await readFile(requirementPath, 'utf8'), documentId: path.basename(requirementPath) };
  } catch (error) {
    throw new AcceptanceCliError(`需求文件读取失败 ${requirementPath}：${(error as Error).message}`);
  }
}

function replayComparable(testCase: TestCase): unknown {
  const safe = redactAcceptanceArtifact(testCase) as TestCase;
  return {
    source: {
      acceptanceCriteriaIds: safe.source?.acceptanceCriteriaIds,
      apiSpecId: safe.source?.apiSpecId,
      apiOperationKey: safe.source?.apiOperationKey,
    },
    testType: safe.testType,
    protocol: safe.protocol,
    actor: safe.actor ? { id: safe.actor.id, role: safe.actor.role } : undefined,
    steps: safe.steps.map((step) => ({
      type: step.type, method: step.method, url: step.url,
      pathParams: step.pathParams, query: step.query, headers: step.headers, body: step.body,
      actor: step.actor ? { id: step.actor.id, role: step.actor.role } : undefined,
    })),
    assertions: safe.assertions,
    parameterContext: safe.parameterContext,
    parameterCoverage: safe.parameterCoverage,
    negativeContractIntent: safe.negativeContractIntent,
  };
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new AcceptanceCliError(`缺少 ${name}；请通过 CLI、acceptance.config.json 或环境变量显式配置`);
  return value.trim();
}

export async function runAcceptanceCli(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<AcceptanceCliRunResult> {
  const args = parseAcceptanceCliArgs(argv);
  if (args.help) return { exitCode: 0 };
  const config = await loadConfig(args.config, env);
  const output = required(args.output ?? env.ACCEPTANCE_OUTPUT ?? config.output, 'output');
  let input: {
    markdown: string;
    documentId: string;
    parentRunId?: string;
    inherited?: AcceptanceConfig;
    archivedCases?: TestCase[];
    expectedExecutionPlan?: AcceptanceExecutionPlanIdentity;
    regressionPlan?: FactBasedRegressionPlan;
  };
  if (args.runId) {
    const regressionSource = args.regression
      ? await findAcceptanceRegressionSource(output, args.runId)
      : undefined;
    const previous = regressionSource ?? await findAcceptanceRun(output, args.runId);
    if (previous.manifest.schemaVersion !== 3 || previous.manifest.replaySafety !== 'SAFE') {
      throw new AcceptanceCliError(
        `ARCHIVE_REPLAY_UNSAFE：Run ${args.runId} 的需求归档包含脱敏替换或使用旧版 Manifest；禁止把归档掩码值发送到被测系统，必须从原始需求重新建立基线`,
      );
    }
    if (previous.manifest.caseIdentityPolicy !== ACCEPTANCE_CASE_IDENTITY_POLICY
      || !previous.manifest.executionPlan) {
      throw new AcceptanceCliError(
        `ARCHIVE_REPLAY_UNSAFE：Run ${args.runId} 缺少稳定 Case Identity / Execution Plan Digest；必须从原始需求重新建立基线`,
      );
    }
    input = {
      markdown: previous.markdown,
      documentId: previous.manifest.requirementDocumentId ?? previous.manifest.requirementFile,
      parentRunId: args.runId,
      inherited: { project: previous.manifest.project, environment: previous.manifest.environment, mode: previous.manifest.mode },
      archivedCases: previous.testCases,
      expectedExecutionPlan: previous.manifest.executionPlan,
      regressionPlan: regressionSource ? buildFactBasedRegressionPlan({
        testCases: regressionSource.testCases,
        failedCaseIds: regressionSource.results
          .filter((result) => result.status === 'FAIL'
            && result.executed === true
            && result.classification === 'PRODUCT_FAILURE')
          .map((result) => result.caseId),
        authorizedCaseIds: regressionSource.manifest.selectedCaseIds,
      }) : undefined,
    };
  } else {
    input = await readRequirement(args);
  }
  if (!input.markdown.trim()) throw new AcceptanceCliError('需求内容为空');

  const project = required(args.project ?? env.ACCEPTANCE_PROJECT ?? config.project ?? input.inherited?.project, 'project');
  const environment = required(args.environment ?? env.ACCEPTANCE_ENVIRONMENT ?? config.environment ?? input.inherited?.environment, 'environment');
  const mode = required(args.mode ?? env.ACCEPTANCE_MODE ?? config.mode ?? input.inherited?.mode, 'mode') as Mode;
  if (mode !== 'execute' && mode !== 'dry-run') throw new AcceptanceCliError(`非法 mode：${mode}`);
  if (mode === 'execute' && /^prod(?:uction)?$/i.test(environment)) throw new AcceptanceCliError('Acceptance CLI 默认禁止直接在 production 执行');
  if (mode === 'execute' && !(ACCEPTANCE_EXECUTION_ENVIRONMENT_ALLOWLIST as readonly string[]).includes(environment.toLowerCase())) {
    throw new AcceptanceCliError(`环境 ${environment} 未进入 Acceptance 执行 Allowlist；当前仅允许 ${ACCEPTANCE_EXECUTION_ENVIRONMENT_ALLOWLIST.join(', ')}，Staging 需先通过独立 Pilot Entry Gate`);
  }
  const baseUrl = args.baseUrl ?? env.ACCEPTANCE_BASE_URL ?? config.baseUrl ?? '';
  const actorHeaders = parseActorHeaders(env) ?? config.actorHeaders;
  const requirement = parseAcceptanceRequirement(input.markdown, { documentId: input.documentId });
  const design = buildAcceptanceTestDesign(requirement);
  const generatedCases = applyTestCaseQualityGate({
    requirement,
    objectives: design.objectives,
    testCases: generateAcceptanceApiCases(requirement, generateTestPoints(requirement, design)),
  }).testCases;
  const requestedScope = new Set((args.scope ?? []).map((item) => item.toUpperCase()));
  const requestedCaseIds = new Set(args.caseId
    ? [args.caseId]
    : input.regressionPlan?.affectedCaseIds ?? []);
  const selectedCases = generatedCases.filter((testCase) => {
    if (requestedCaseIds.size && !requestedCaseIds.has(testCase.id)) return false;
    if (!requestedScope.size) return true;
    return requestedScope.has(String(testCase.testType ?? '').toUpperCase())
      || testCase.source?.factIds?.some((id) => requestedScope.has(id.toUpperCase())) === true
      || testCase.source?.objectiveIds?.some((id) => requestedScope.has(id.toUpperCase())) === true
      || testCase.source?.acceptanceCriteriaIds.some((id) => requestedScope.has(id.toUpperCase())) === true;
  });
  if (args.caseId && !selectedCases.length) throw new AcceptanceCliError(`Run 中不存在 Case：${args.caseId}`);
  if (args.regression && !selectedCases.length) throw new AcceptanceCliError('REGRESSION_SELECTION_EMPTY：归档影响范围没有匹配当前稳定 Case');
  if (requestedScope.size && !selectedCases.length) throw new AcceptanceCliError(`指定测试范围没有匹配用例：${[...requestedScope].join(', ')}`);
  const executableSelectedCases = selectedCases.filter((testCase) => !isDesignedOnlyCase(testCase));
  if (mode === 'execute' && executableSelectedCases.length) required(baseUrl, 'API baseUrl');
  if (args.runId && requestedCaseIds.size) {
    for (const selected of selectedCases) {
      const archived = input.archivedCases?.find((testCase) => testCase.id === selected.id);
      if (!archived) throw new AcceptanceCliError(`归档 Run 中不存在 Case：${selected.id}`);
      if (!isDesignedOnlyCase(archived) && (!archived.source?.apiSpecId || !archived.source.apiOperationKey)) {
        throw new AcceptanceCliError(`归档 Case ${selected.id} 缺少稳定 Operation Identity；这是旧 Artifact，必须迁移或重新建立基线`);
      }
      if (!isDeepStrictEqual(replayComparable(archived), replayComparable(selected))) {
        throw new AcceptanceCliError(`ARCHIVE_REPLAY_MISMATCH：${selected.id} 重新生成后的执行语义与归档不一致，已在 Data Prepare 前阻断`);
      }
    }
    const missingSelected = [...requestedCaseIds].filter((caseId) => !selectedCases.some((testCase) => testCase.id === caseId));
    if (missingSelected.length) {
      throw new AcceptanceCliError(`ARCHIVE_REPLAY_MISMATCH：当前计划缺少归档回归 Case：${missingSelected.join(', ')}`);
    }
  }
  let safetyPolicy: AcceptanceExecutionSafetyPolicy | undefined;
  if (mode === 'execute' && executableSelectedCases.length) {
    const missingActors = [...new Set(selectedCases.filter((testCase) => !isDesignedOnlyCase(testCase)).map((testCase) => testCase.actor?.tokenRef).filter((ref): ref is string => Boolean(ref)))]
      .filter((ref) => !actorHeaders?.[ref]);
    if (missingActors.length) throw new AcceptanceCliError(`缺少 Actor 凭据映射：${missingActors.join(', ')}`);
    const operationKeys = [...new Set(selectedCases
      .filter((testCase) => !isDesignedOnlyCase(testCase))
      .map((testCase) => testCase.source?.apiOperationKey)
      .filter((key): key is string => Boolean(key)))];
    safetyPolicy = {
      environment,
      allowedOrigins: config.environmentPolicy?.allowedOrigins,
      operationPolicies: config.operationPolicies ?? {},
      allowNoCleanup: config.allowNoCleanup === true,
    };
    const safetyDecision = evaluateAcceptanceExecutionSafety({
      policy: safetyPolicy,
      environment,
      baseUrl,
      operationKeys,
      hasCleanup: Boolean(config.dataLifecycle?.cleanup),
    });
    if (!safetyDecision.allowed) throw new AcceptanceCliError(safetyDecision.reason ?? 'Acceptance execution safety policy blocked');
  }
  const timeoutMs = args.timeoutMs ?? config.timeoutMs ?? 5000;
  const maxCases = args.maxCases ?? config.maxCases;
  const deadlineMs = args.deadlineMs ?? config.deadlineMs;
  const execution = await runAcceptancePipeline({
    markdown: input.markdown,
    documentId: input.documentId,
    project,
    environment,
    mode,
    baseUrl,
    safetyPolicy,
    actorHeaders,
    timeoutMs,
    maxCases,
    deadlineMs,
    scope: args.scope,
    caseIds: requestedCaseIds.size ? [...requestedCaseIds] : undefined,
    expectedExecutionPlan: input.expectedExecutionPlan,
    regressionPlan: input.regressionPlan,
    parentRunId: input.parentRunId,
    lifecycle: createLifecycle(config, baseUrl, timeoutMs),
  });
  const artifacts = await writeAcceptanceRunArtifacts({
    execution,
    markdown: input.markdown,
    outputRoot: output,
    project,
    environment,
    mode,
    parentRunId: input.parentRunId,
    regressionPlan: input.regressionPlan,
  });
  const warnings = execution.requirement.warnings.map((warning) => `${warning.code}: ${warning.message}`);
  const exitCode = execution.report.conclusion === 'FAIL' ? 1
    : execution.report.conclusion === 'BLOCKED' ? 2
      : execution.report.conclusion === 'PARTIAL' ? 3 : 0;
  return {
    exitCode,
    runId: execution.runId,
    artifacts,
    conclusion: execution.report.conclusion,
    summary: execution.report.summary,
    warnings,
    trust: execution.report.trust,
    regression: input.regressionPlan,
  };
}
