/**
 * Panqu AI DevTest — Requirement Trace & Impact Analysis (wardenIQ Native Absorption)
 *
 * 核心架构约束 (遵循 docs/ARCHITECTURE_FREEZE.md 受控扩展原则):
 * 1. 最小需求追踪数据模型：requirementId -> testIds -> sourceRefs；
 * 2. 纯函数影响分析：changedPaths -> affectedTests、coverageGaps、riskInputs；
 * 3. 零基础设施依赖：绝对不连接数据库、UI、任务管理系统、外部网络或文件系统监控；
 * 4. 严格不可变与确定性：输入输出均无副作用，输出对象深层冻结。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CanonicalTestSpec } from './canonical-protocol.js';
import type { CapabilityMaturityLevel } from './capability-maturity.js';

// ============================================================================
// 一、需求追踪契约 (RequirementTrace Contracts)
// ============================================================================

export interface RequirementTrace {
  readonly requirementId: string;
  readonly testIds: readonly string[];
  readonly sourceRefs: readonly string[]; // 源码文件路径、模块或核心端点
  readonly description?: string;
}

export interface RequirementTraceMap {
  readonly [requirementId: string]: RequirementTrace;
}

// ============================================================================
// 二、影响分析契约 (Impact Analysis Contracts)
// ============================================================================

export interface CoverageGap {
  readonly changedPath: string;
  readonly reason: string;
  readonly requirementId?: string;
}

export type RiskInputType =
  | 'PAID_OR_SUBMIT_SIDE_EFFECT'
  | 'POSITIVE_COST_LIMIT'
  | 'MISSING_CRITICAL_ASSERTIONS'
  | 'UNSAFE_EXECUTION_MODE';

export interface RiskInputItem {
  readonly testId: string;
  readonly requirementId?: string;
  readonly riskType: RiskInputType;
  readonly reason: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface ImpactAnalysisOptions {
  readonly changedPaths: readonly string[];
  readonly traces: readonly RequirementTrace[];
  readonly testSpecs?: readonly CanonicalTestSpec[];
}

export interface ImpactAnalysisResult {
  readonly executed?: boolean;
  readonly changedPaths: readonly string[];
  readonly affectedRequirements: readonly string[];
  readonly affectedTests: readonly string[];
  readonly coverageGaps: readonly CoverageGap[];
  readonly riskInputs: readonly RiskInputItem[];
}

// ============================================================================
// 三、路径规整与匹配辅助函数 (纯函数)
// ============================================================================

function normalizePath(p: string): string {
  return p.trim().replace(/^(\.\/)+/, '').replace(/\\/g, '/');
}

function isPathMatch(candidatePath: string, refPath: string): boolean {
  const normCandidate = normalizePath(candidatePath);
  const normRef = normalizePath(refPath);

  if (normCandidate === normRef) {
    return true;
  }
  // 目录前缀匹配
  if (normCandidate.startsWith(normRef.endsWith('/') ? normRef : `${normRef}/`)) {
    return true;
  }
  if (normRef.startsWith(normCandidate.endsWith('/') ? normCandidate : `${normCandidate}/`)) {
    return true;
  }
  return false;
}

// ============================================================================
// 四、纯函数影响分析引擎 (Pure Impact Analysis)
// ============================================================================

/**
 * 纯函数影响分析核心引擎
 * 接收变更路径与追踪关系，输出受影响测试、覆盖缺口与风险输入
 */
export function analyzeImpact(
  options: Readonly<ImpactAnalysisOptions>
): Readonly<ImpactAnalysisResult> {
  const changedPaths = (options.changedPaths || []).map(normalizePath);
  const traces = options.traces || [];
  const testSpecs = options.testSpecs || [];

  const affectedReqsSet = new Set<string>();
  const affectedTestsSet = new Set<string>();
  const coveredChangedPathsSet = new Set<string>();
  const coverageGaps: CoverageGap[] = [];
  const riskInputs: RiskInputItem[] = [];

  // 1. 遍历变更路径，匹配需求追踪
  for (const changedPath of changedPaths) {
    let matchedAnyTrace = false;

    for (const trace of traces) {
      const isMatched = (trace.sourceRefs || []).some((ref) => isPathMatch(changedPath, ref));

      if (isMatched) {
        matchedAnyTrace = true;
        coveredChangedPathsSet.add(changedPath);
        affectedReqsSet.add(trace.requirementId);

        if (!trace.testIds || trace.testIds.length === 0) {
          coverageGaps.push({
            changedPath,
            requirementId: trace.requirementId,
            reason: `变更文件命中了需求 [${trace.requirementId}]，但该需求未关联任何测试用例 (testIds 为空)`,
          });
        } else {
          for (const tid of trace.testIds) {
            affectedTestsSet.add(tid);
          }
        }
      }
    }

    if (!matchedAnyTrace) {
      coverageGaps.push({
        changedPath,
        reason: '变更文件未关联任何需求追踪 (sourceRefs)，缺少测试覆盖',
      });
    }
  }

  // 2. 风险输入分析 (针对所有受影响的 CanonicalTestSpec)
  const affectedTestsList = Array.from(affectedTestsSet).sort();
  const affectedSpecs = testSpecs.filter((s) => affectedTestsSet.has(s.testId));

  for (const spec of affectedSpecs) {
    // (1) 写入/付费副作用策略风险
    if (spec.sideEffectPolicy === 'ALLOW_SUBMIT' || spec.sideEffectPolicy === 'ALLOW_PAID') {
      riskInputs.push({
        testId: spec.testId,
        requirementId: spec.requirementId,
        riskType: 'PAID_OR_SUBMIT_SIDE_EFFECT',
        reason: `受影响测试声明了非只读策略 [${spec.sideEffectPolicy}]，存在写操作或资金扣减风险`,
        details: { sideEffectPolicy: spec.sideEffectPolicy },
      });
    }

    // (2) 资金成本预算风险
    if (
      spec.costLimit.maxCostPoints > 0 ||
      (spec.costLimit.maxCostCny !== undefined && spec.costLimit.maxCostCny > 0)
    ) {
      riskInputs.push({
        testId: spec.testId,
        requirementId: spec.requirementId,
        riskType: 'POSITIVE_COST_LIMIT',
        reason: `受影响测试声明了非零成本预算 (maxCostPoints: ${spec.costLimit.maxCostPoints})`,
        details: { costLimit: spec.costLimit },
      });
    }

    // (3) 缺少关键确定性断言风险
    const hasCriticalAssertion = (spec.deterministicAssertions || []).some((a) => a.critical === true);
    if (!hasCriticalAssertion) {
      riskInputs.push({
        testId: spec.testId,
        requirementId: spec.requirementId,
        riskType: 'MISSING_CRITICAL_ASSERTIONS',
        reason: '受影响测试缺少关键确定性断言 (critical assertions)，存在假通过风险',
        details: { assertionCount: spec.deterministicAssertions?.length || 0 },
      });
    }

    // (4) 生产 REAL 模式执行风险
    if (spec.executionMode === 'REAL') {
      riskInputs.push({
        testId: spec.testId,
        requirementId: spec.requirementId,
        riskType: 'UNSAFE_EXECUTION_MODE',
        reason: '受影响测试运行于生产 REAL 模式，变更直接波及线上环境',
        details: { executionMode: spec.executionMode },
      });
    }
  }

  return Object.freeze({
    changedPaths: Object.freeze([...changedPaths]),
    affectedRequirements: Object.freeze(Array.from(affectedReqsSet).sort()),
    affectedTests: Object.freeze(affectedTestsList),
    coverageGaps: Object.freeze(coverageGaps),
    riskInputs: Object.freeze(riskInputs),
  });
}

/**
 * 校验并构建 RequirementTrace 索引表 (纯函数)
 */
export function buildRequirementTraceIndex(
  traces: readonly RequirementTrace[]
): ReadonlyMap<string, RequirementTrace> {
  const map = new Map<string, RequirementTrace>();
  for (const t of traces) {
    if (!t.requirementId) {
      throw new Error('buildRequirementTraceIndex: 需求追踪记录必须包含 requirementId');
    }
    map.set(t.requirementId, Object.freeze({ ...t }));
  }
  return map;
}

// ============================================================================
// 五、TestSpec 前置追踪关联与影响分析适配器 (纯函数)
// ============================================================================

export interface UnexecutedImpactAnalysis {
  readonly executed: false;
  readonly reason: string;
}

export interface ResolvedRequirementTrace {
  readonly requirementId: string;
  readonly requirementText?: string;
  readonly trace?: RequirementTrace;
  readonly impactAnalysis: ImpactAnalysisResult | UnexecutedImpactAnalysis;
}

export interface ResolveRequirementTraceOptions {
  readonly requirementId?: string;
  readonly requirementText?: string;
  readonly requirement?: string;
  readonly changedPaths?: readonly string[];
  readonly traces?: readonly RequirementTrace[];
  readonly testId?: string;
  readonly testSpecs?: readonly CanonicalTestSpec[];
}

/**
 * 判断字符串是否为稳定需求标识符 (Stable Requirement ID)
 * 规则：
 * 1. 必须为非空字符串；
 * 2. 长度不超过 64 个字符；
 * 3. 必须符合标识符格式 (如 REQ-xxx, SYS-xxx, 或字母数字中划线下划线，不含空格、汉字或标点)；
 * 4. 禁止使用 REQ-DEFAULT 或 UNRESOLVED_REQUIREMENT 占位符。
 */
export function isStableRequirementId(val: unknown): val is string {
  if (typeof val !== 'string') return false;
  const trimmed = val.trim();
  if (trimmed === '' || trimmed === 'REQ-DEFAULT' || trimmed === 'UNRESOLVED_REQUIREMENT') return false;
  if (trimmed.length > 64) return false;
  return /^[A-Za-z0-9_.-]+$/.test(trimmed);
}

/**
 * 将需求追踪与变更影响分析前置接入 Canonical TestSpec 构建过程 (纯函数)
 * - 分离 requirementId (稳定标识) 与 requirementText (自然语言描述)；
 * - 禁止将整段需求文本作为 requirementId，禁止使用 REQ-DEFAULT 伪造真实需求；
 * - 无稳定需求 ID 时输出 UNRESOLVED_REQUIREMENT 且 impactAnalysis.executed=false；
 * - 当提供 changedPaths 与 traces 时，执行严谨的影响分析；
 * - 纯函数无副作用，深冻结输出。
 */
export function resolveRequirementTraceForSpec(
  options: Readonly<ResolveRequirementTraceOptions>
): Readonly<ResolvedRequirementTrace> {
  const traces = options.traces || [];
  const changedPaths = options.changedPaths || [];

  let reqId: string | undefined = undefined;
  let reqText: string | undefined = options.requirementText?.trim();

  if (isStableRequirementId(options.requirementId)) {
    reqId = options.requirementId.trim();
  }

  if (options.requirement) {
    const rawReq = options.requirement.trim();
    // 只有在 traces 中存在真实匹配的 requirementId 时，才允许从 legacy requirement 提取为 reqId
    // 严禁因为 rawReq 格式符合 REQ-* 就盲目将其当做真实需求！
    const traceMatch = traces.find((t) => t.requirementId === rawReq);
    if (traceMatch) {
      if (!reqId) reqId = rawReq;
    } else {
      if (!reqText) reqText = rawReq;
    }
  }

  let matchedTrace: RequirementTrace | undefined;
  if (reqId) {
    matchedTrace = traces.find((t) => t.requirementId === reqId);
  } else if (reqText) {
    matchedTrace = traces.find((t) => t.description && t.description.includes(reqText!));
    if (matchedTrace) {
      reqId = matchedTrace.requirementId;
    }
  }

  if (!matchedTrace && options.testId) {
    matchedTrace = traces.find((t) => (t.testIds || []).includes(options.testId!));
    if (matchedTrace && !reqId) {
      reqId = matchedTrace.requirementId;
    }
  }

  if (!reqId) {
    return Object.freeze({
      requirementId: 'UNRESOLVED_REQUIREMENT',
      requirementText: reqText,
      trace: undefined,
      impactAnalysis: Object.freeze({
        executed: false,
        reason: reqText
          ? `UNRESOLVED_REQUIREMENT: 提供了需求描述 "${reqText}" 但未关联有效 stable requirementId，拒绝虚构影响分析`
          : 'UNRESOLVED_REQUIREMENT: 缺少有效 stable requirementId 与需求描述，未执行影响分析',
      }),
    });
  }

  if (changedPaths.length === 0 && traces.length === 0) {
    return Object.freeze({
      requirementId: reqId,
      requirementText: reqText,
      trace: matchedTrace ? Object.freeze({ ...matchedTrace }) : undefined,
      impactAnalysis: Object.freeze({
        executed: false,
        reason: 'NO_CHANGE_OR_REQUIREMENT_INPUT',
      }),
    });
  }

  const analysis = analyzeImpact({
    changedPaths,
    traces: traces.length > 0 ? traces : (matchedTrace ? [matchedTrace] : []),
    testSpecs: options.testSpecs,
  });

  return Object.freeze({
    requirementId: reqId,
    requirementText: reqText,
    trace: matchedTrace ? Object.freeze({ ...matchedTrace }) : undefined,
    impactAnalysis: analysis,
  });
}

// ============================================================================
// 六、真实 Git 变更收集器 (Real Git Changed Paths Collector)
// ============================================================================

const execFileAsync = promisify(execFile);

export interface CollectGitChangedPathsOptions {
  readonly cwd?: string;
  readonly maxBuffer?: number;
}

export interface CollectGitChangedPathsResult {
  readonly ok: boolean;
  readonly changedPaths: readonly string[];
  readonly error?: string;
}

/**
 * 只读收集 Git 工作区变更路径 (未暂存、已暂存、未跟踪)
 * 核心不变量：
 * 1. 使用 Node execFile 调用 git，参数为数组，严禁 shell 拼接；
 * 2. 支持 unstaged、staged 与 untracked 文件；
 * 3. 路径规范化、去重、稳定排序；
 * 4. Git 失败或非仓库时 fail-closed，不返回空成功。
 */
export async function collectGitChangedPaths(
  options?: CollectGitChangedPathsOptions
): Promise<CollectGitChangedPathsResult> {
  const cwd = options?.cwd || process.cwd();
  const maxBuffer = options?.maxBuffer || 10 * 1024 * 1024;

  try {
    // 1. 检查是否在 git 工作树内
    await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd, maxBuffer });

    // 2. 收集工作区变更：使用 porcelain=v1 -z -u
    const { stdout } = await execFileAsync(
      'git',
      ['status', '--porcelain=v1', '-z', '-u'],
      { cwd, maxBuffer }
    );

    const changedPathsSet = new Set<string>();
    const parts = stdout.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const entry = parts[i];
      if (!entry) continue;
      const status = entry.slice(0, 2);
      const filePath = entry.slice(3);
      if (filePath) {
        changedPathsSet.add(normalizePath(filePath));
      }
      // 重命名 (R) 或拷贝 (C) 时紧跟旧/新路径
      if (status.includes('R') || status.includes('C')) {
        i++;
        if (i < parts.length && parts[i]) {
          changedPathsSet.add(normalizePath(parts[i]));
        }
      }
    }

    const sortedPaths = Array.from(changedPathsSet).sort();
    return {
      ok: true,
      changedPaths: Object.freeze(sortedPaths),
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      changedPaths: Object.freeze([]),
      error: `Git 变更收集失败 (fail-closed): ${errorMsg}`,
    };
  }
}

// ============================================================================
// 七、权威需求映射查找与成熟度解析 (Authoritative Requirement Traces)
// ============================================================================

export interface FindRequirementTracesOptions {
  readonly cwd?: string;
  readonly filePath?: string;
  readonly searchPaths?: readonly string[];
}

export type FindRequirementTracesStatus =
  | 'LOADED'
  | 'BLOCKED_DATA_MISSING'
  | 'INVALID_REQUIREMENT_TRACE';

export interface FindRequirementTracesResult {
  readonly status: FindRequirementTracesStatus;
  readonly traces: readonly RequirementTrace[];
  readonly sourceFile?: string;
  readonly error?: string;
}

export const DEFAULT_REQUIREMENT_TRACE_SEARCH_PATHS = [
  'devtest-requirements.json',
  'docs/devtest-requirements.json',
  '.devtest/requirements.json',
] as const;

/**
 * 查找并校验仓库中的权威需求映射文件
 * 核心不变量：
 * 1. 查找权威需求映射文件；
 * 2. 校验 stable requirementId、sourceRefs、testIds；
 * 3. 找不到权威映射时严格返回 BLOCKED_DATA_MISSING，禁止创建虚假映射。
 */
export function findAuthoritativeRequirementTraces(
  options?: FindRequirementTracesOptions
): FindRequirementTracesResult {
  const cwd = options?.cwd || process.cwd();
  const candidatePaths = options?.filePath
    ? [options.filePath]
    : options?.searchPaths || DEFAULT_REQUIREMENT_TRACE_SEARCH_PATHS;

  let targetPath: string | undefined;
  for (const relPath of candidatePaths) {
    const absPath = path.isAbsolute(relPath) ? relPath : path.resolve(cwd, relPath);
    if (fs.existsSync(absPath)) {
      targetPath = absPath;
      break;
    }
  }

  if (!targetPath) {
    return {
      status: 'BLOCKED_DATA_MISSING',
      traces: Object.freeze([]),
      error: '未找到权威需求映射文件 (devtest-requirements.json)，拒绝创建虚假映射 (BLOCKED_DATA_MISSING)',
    };
  }

  try {
    const rawText = fs.readFileSync(targetPath, 'utf-8');
    const parsed = JSON.parse(rawText);
    if (!Array.isArray(parsed)) {
      return {
        status: 'INVALID_REQUIREMENT_TRACE',
        traces: Object.freeze([]),
        sourceFile: targetPath,
        error: `需求映射文件 [${targetPath}] 根节点必须为数组`,
      };
    }

    if (parsed.length === 0) {
      return {
        status: 'BLOCKED_DATA_MISSING',
        traces: Object.freeze([]),
        sourceFile: targetPath,
        error: `权威映射文件为空 [${targetPath}] (BLOCKED_DATA_MISSING)`,
      };
    }

    const validatedTraces: RequirementTrace[] = [];
    for (let idx = 0; idx < parsed.length; idx++) {
      const item = parsed[idx];
      if (!item || typeof item !== 'object') {
        return {
          status: 'INVALID_REQUIREMENT_TRACE',
          traces: Object.freeze([]),
          sourceFile: targetPath,
          error: `需求映射项 [索引 ${idx}] 必须为有效对象`,
        };
      }
      if (!isStableRequirementId(item.requirementId)) {
        return {
          status: 'INVALID_REQUIREMENT_TRACE',
          traces: Object.freeze([]),
          sourceFile: targetPath,
          error: `需求映射项 [索引 ${idx}] 的 requirementId ("${item.requirementId}") 不是合法的 stable requirementId`,
        };
      }
      if (!Array.isArray(item.sourceRefs) || !item.sourceRefs.every((r: unknown) => typeof r === 'string' && r.trim() !== '')) {
        return {
          status: 'INVALID_REQUIREMENT_TRACE',
          traces: Object.freeze([]),
          sourceFile: targetPath,
          error: `需求映射项 [${item.requirementId}] 的 sourceRefs 必须为非空字符串数组`,
        };
      }
      if (!Array.isArray(item.testIds) || !item.testIds.every((t: unknown) => typeof t === 'string' && t.trim() !== '')) {
        return {
          status: 'INVALID_REQUIREMENT_TRACE',
          traces: Object.freeze([]),
          sourceFile: targetPath,
          error: `需求映射项 [${item.requirementId}] 的 testIds 必须为非空字符串数组`,
        };
      }

      validatedTraces.push(Object.freeze({
        requirementId: item.requirementId,
        sourceRefs: Object.freeze([...item.sourceRefs]),
        testIds: Object.freeze([...item.testIds]),
        description: typeof item.description === 'string' ? item.description : undefined,
      }));
    }

    if (validatedTraces.length === 0) {
      return {
        status: 'BLOCKED_DATA_MISSING',
        traces: Object.freeze([]),
        sourceFile: targetPath,
        error: `权威映射文件为空 [${targetPath}]，有效条目为 0 (BLOCKED_DATA_MISSING)`,
      };
    }

    return {
      status: 'LOADED',
      traces: Object.freeze(validatedTraces),
      sourceFile: targetPath,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      status: 'INVALID_REQUIREMENT_TRACE',
      traces: Object.freeze([]),
      sourceFile: targetPath,
      error: `需求映射文件 [${targetPath}] 解析失败: ${errorMsg}`,
    };
  }
}

/**
 * 依据 Git 变更收集器与权威映射文件状态动态解析 wardenIQ 成熟度
 */
export function resolveWardenMaturity(context: {
  readonly gitCollectorAvailable: boolean;
  readonly hasAuthoritativeMapping: boolean;
}): CapabilityMaturityLevel {
  if (context.gitCollectorAvailable && context.hasAuthoritativeMapping) {
    return 'IMPLEMENTED';
  }
  if (context.gitCollectorAvailable && !context.hasAuthoritativeMapping) {
    return 'BLOCKED_DATA_MISSING';
  }
  return 'CONTRACT_ONLY';
}

// ============================================================================
// 八、端到端 Git 变更影响分析执行器 (End-to-End Git Impact Analyzer)
// ============================================================================

export interface AnalyzeGitImpactOptions {
  readonly cwd?: string;
  readonly requirementsFile?: string;
  readonly testSpecs?: readonly CanonicalTestSpec[];
}

export type AnalyzeGitImpactStatus =
  | 'COMPLETED'
  | 'BLOCKED_DATA_MISSING'
  | 'GIT_COLLECTION_FAILED'
  | 'INVALID_REQUIREMENT_TRACE';

export interface AnalyzeGitImpactResult {
  readonly status: AnalyzeGitImpactStatus;
  readonly maturity: CapabilityMaturityLevel;
  readonly changedPaths: readonly string[];
  readonly traces: readonly RequirementTrace[];
  readonly impactResult?: ImpactAnalysisResult;
  readonly error?: string;
}

/**
 * 端到端基于真实 Git 变更与权威需求映射执行影响分析
 */
export async function analyzeGitImpact(
  options?: AnalyzeGitImpactOptions
): Promise<AnalyzeGitImpactResult> {
  const cwd = options?.cwd || process.cwd();

  // 1. 收集真实 Git 变更
  const gitRes = await collectGitChangedPaths({ cwd });
  if (!gitRes.ok) {
    return {
      status: 'GIT_COLLECTION_FAILED',
      maturity: resolveWardenMaturity({ gitCollectorAvailable: false, hasAuthoritativeMapping: false }),
      changedPaths: Object.freeze([]),
      traces: Object.freeze([]),
      error: gitRes.error,
    };
  }

  // 2. 查找权威需求映射
  const tracesRes = findAuthoritativeRequirementTraces({
    cwd,
    filePath: options?.requirementsFile,
  });

  // 独立防御门禁：traces 长度为 0 时必须阻断，不得依赖上游假设
  if (tracesRes.status !== 'LOADED' || tracesRes.traces.length === 0) {
    const finalStatus = tracesRes.status === 'LOADED' || tracesRes.status === 'BLOCKED_DATA_MISSING'
      ? 'BLOCKED_DATA_MISSING'
      : tracesRes.status;

    return {
      status: finalStatus,
      maturity: 'BLOCKED_DATA_MISSING',
      changedPaths: gitRes.changedPaths,
      traces: Object.freeze([]),
      error: tracesRes.traces.length === 0 && tracesRes.status === 'LOADED'
        ? `权威映射文件为空，有效条目为 0 (BLOCKED_DATA_MISSING)`
        : tracesRes.error,
    };
  }

  const maturity = resolveWardenMaturity({
    gitCollectorAvailable: true,
    hasAuthoritativeMapping: tracesRes.traces.length > 0,
  });

  // 3. 执行纯函数影响分析
  const impact = analyzeImpact({
    changedPaths: gitRes.changedPaths,
    traces: tracesRes.traces,
    testSpecs: options?.testSpecs,
  });

  return {
    status: 'COMPLETED',
    maturity,
    changedPaths: gitRes.changedPaths,
    traces: tracesRes.traces,
    impactResult: impact,
  };
}
