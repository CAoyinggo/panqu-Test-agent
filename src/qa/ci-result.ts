// CI 结果状态机（Phase 20.7）
// 六态：PASS / FAIL / WARNING / BLOCKED / KNOWN_ISSUE / FLAKY
// 阻断规则：
//   - P0 Fail（非已知问题）→ BLOCKED（阻断）
//   - P1 Fail（非已知/非环境）→ FAIL（按配置决定是否阻断）
//   - P2/P3 Fail → WARNING（不阻断，nightly 关注）
//   - Flaky → FLAKY（不直接判产品失败）
//   - Environment Error（5xx/超时/网络/429）→ WARNING（标记，不直接判产品失败）
//   - Known Issue（open）→ KNOWN_ISSUE（按状态处理，不判失败）
import { hasExecutableEvidence, type ExecutionOutcome, type CaseExecutionResult } from '../agents/execution/execution-schema.js';

/** CI 六态结论 */
export type CiVerdict = 'PASS' | 'FAIL' | 'WARNING' | 'BLOCKED' | 'KNOWN_ISSUE' | 'FLAKY';

/** 单个用例的 CI 归类 */
export type CiCaseStatusKind = 'pass' | 'fail' | 'flaky' | 'env-error' | 'known-issue';

export interface CiCaseStatus {
  caseId: string;
  priority: 'P0' | 'P1' | 'P2' | 'P3' | undefined;
  pass: boolean;
  status: CiCaseStatusKind;
  reason?: string;
}

/** CI 结果计算输入 */
export interface CiResultOptions {
  environment?: string;
  /** caseId → 优先级（执行结果本身不携带优先级，需由测试计划/选择器提供） */
  priorities?: Record<string, string>;
  /** caseId → 已知问题状态（open 视为已知问题，不判失败） */
  knownIssues?: Record<string, 'open' | 'fixed' | 'wonfix'>;
  /** Flaky Agent 标记的 flaky caseId 列表 */
  flakyCaseIds?: string[];
  /** P0 失败是否阻断（默认 true） */
  blockOnP0?: boolean;
  /** P1 失败是否判 FAIL（默认 true） */
  failOnP1?: boolean;
  /** 环境错误是否降级为 WARNING（默认 true） */
  classifyEnvironment?: boolean;
  /** Flaky 是否不判失败（默认 true） */
  ignoreFlaky?: boolean;
}

/** CI 结果 */
export interface CiResult {
  verdict: CiVerdict;
  feature: string;
  environment: string;
  total: number;
  cases: CiCaseStatus[];
  counts: { total: number; pass: number; fail: number; flaky: number; envError: number; knownIssue: number };
  blockReasons: string[];
  summary: string;
}

/** 判断是否为环境类错误（5xx / 429 / 超时 / 网络），非产品逻辑失败 */
export function isEnvironmentError(r: CaseExecutionResult): boolean {
  const blob = [r.error ?? '', ...(r.checks ?? []).map((c) => `${c.name} ${c.detail}`)].join(' ');
  return (
    /\b(50\d)\b/.test(blob) ||
    /\b429\b/.test(blob) ||
    /timeout|超时|timed ?out/i.test(blob) ||
    /ECONNREFUSED|ENOTFOUND|ECONNRESET|EAI_AGAIN|network|网络/i.test(blob)
  );
}

function priorityOf(r: CaseExecutionResult, priorities?: Record<string, string>): 'P0' | 'P1' | 'P2' | 'P3' | undefined {
  // 优先级来源：优先取调用方提供的映射（测试计划/选择器），其次取结果自身携带的 priority 字段
  const raw = priorities?.[r.caseId] ?? r.priority;
  if (raw === 'P0' || raw === 'P1' || raw === 'P2' || raw === 'P3') return raw;
  return undefined;
}

/** 计算 CI 六态结论 */
export function computeCiResult(outcome: ExecutionOutcome, options: CiResultOptions = {}): CiResult {
  const {
    environment = 'test',
    priorities,
    knownIssues = {},
    flakyCaseIds = [],
    blockOnP0 = true,
    failOnP1 = true,
    classifyEnvironment = true,
    ignoreFlaky = true,
  } = options;

  const cases: CiCaseStatus[] = outcome.results.map((r) => {
    const priority = priorityOf(r, priorities);
    if (r.pass) {
      return { caseId: r.caseId, priority, pass: true, status: 'pass' };
    }
    // 已知问题（open）
    if (knownIssues[r.caseId] === 'open') {
      return { caseId: r.caseId, priority, pass: false, status: 'known-issue', reason: '已知问题（open），按状态处理' };
    }
    // 环境错误
    if (classifyEnvironment && isEnvironmentError(r)) {
      return { caseId: r.caseId, priority, pass: false, status: 'env-error', reason: '环境类错误（5xx/超时/网络），不直接判产品失败' };
    }
    // Flaky
    if (ignoreFlaky && flakyCaseIds.includes(r.caseId)) {
      return { caseId: r.caseId, priority, pass: false, status: 'flaky', reason: 'Flaky 用例，不直接阻断' };
    }
    return { caseId: r.caseId, priority, pass: false, status: 'fail' };
  });

  const counts = { total: cases.length, pass: 0, fail: 0, flaky: 0, envError: 0, knownIssue: 0 };
  const statusToCount: Record<CiCaseStatusKind, keyof typeof counts> = {
    pass: 'pass',
    fail: 'fail',
    flaky: 'flaky',
    'env-error': 'envError',
    'known-issue': 'knownIssue',
  };
  for (const c of cases) {
    counts[statusToCount[c.status]] += 1;
  }

  const realFails = cases.filter((c) => c.status === 'fail');
  const blockReasons: string[] = [];

  const hasEvidence = hasExecutableEvidence(outcome);
  if (!hasEvidence) blockReasons.push('NO_EXECUTABLE_EVIDENCE：没有实际执行结果，禁止 PASS');

  // 优先级判定
  const p0Fail = realFails.filter((c) => c.priority === 'P0');
  const p1Fail = realFails.filter((c) => c.priority === 'P1');
  const lowFail = realFails.filter((c) => c.priority === undefined || c.priority === 'P2' || c.priority === 'P3');

  let verdict: CiVerdict;
  if (!hasEvidence) {
    verdict = 'BLOCKED';
  } else if (realFails.length === 0) {
    // 无真实测试失败 → 按标记分类
    if (counts.envError > 0 && counts.flaky === 0 && counts.knownIssue === 0) verdict = 'WARNING';
    else if (counts.knownIssue > 0 && counts.flaky === 0 && counts.envError === 0) verdict = 'KNOWN_ISSUE';
    else if (counts.flaky > 0 && counts.knownIssue === 0 && counts.envError === 0) verdict = 'FLAKY';
    else if (counts.envError > 0 || counts.flaky > 0 || counts.knownIssue > 0) verdict = 'WARNING';
    else verdict = 'PASS';
  } else if (blockOnP0 && p0Fail.length > 0) {
    verdict = 'BLOCKED';
    blockReasons.push(`P0 失败 ${p0Fail.length} 条：${p0Fail.map((c) => c.caseId).join(', ')}`);
  } else if (failOnP1 && p1Fail.length > 0) {
    verdict = 'FAIL';
    blockReasons.push(`P1 失败 ${p1Fail.length} 条：${p1Fail.map((c) => c.caseId).join(', ')}`);
  } else if (lowFail.length > 0) {
    // 仅 P2/P3（或未知优先级）真实失败 → 不阻断，WARNING（nightly 关注）
    verdict = 'WARNING';
    blockReasons.push(`P2/P3 失败 ${lowFail.length} 条：${lowFail.map((c) => c.caseId).join(', ')}`);
  } else if (counts.envError > 0 || counts.flaky > 0) {
    verdict = 'WARNING';
  } else {
    verdict = 'FAIL';
  }

  return {
    verdict,
    feature: outcome.feature,
    environment,
    total: outcome.total,
    cases,
    counts,
    blockReasons,
    summary: `[${verdict}] ${outcome.feature}：共 ${outcome.total} 条，通过 ${counts.pass}，失败 ${counts.fail}，Flaky ${counts.flaky}，环境错误 ${counts.envError}，已知问题 ${counts.knownIssue}${blockReasons.length ? `；阻断原因：${blockReasons.join('；')}` : ''}`,
  };
}
