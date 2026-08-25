/**
 * DevTest Problem Engine：把 acceptance 管线里分散的异常信号
 * （执行失败断言、BLOCKED 原因、DESIGNED_ONLY 缺口、需求告警、契约门禁、
 * 产品缺陷草稿）统一归一为四级问题清单。
 *
 * 铁律：宁可多报 minor，不许静默吞掉任何异常信号；分级规则必须是可测试的纯函数。
 */

import type { AcceptanceReport } from '../acceptance/acceptance-report.js';
import type {
  DevTestDimensionStat,
  DevTestProblem,
  DevTestProblemCategory,
  DevTestProblemSeverity,
} from './types.js';

const SEVERITY_ORDER: Record<DevTestProblemSeverity, number> = {
  critical: 0,
  major: 1,
  minor: 2,
  trivial: 3,
};

/** DefectDraft.severity（P0~P3）→ DevTest 四级。 */
function severityOfDefect(severity: string | undefined): DevTestProblemSeverity {
  switch (severity) {
    case 'P0': return 'critical';
    case 'P1': return 'major';
    case 'P2': return 'minor';
    default: return 'trivial';
  }
}

/** 按原因码给出开发者的下一步建议；未识别的码不编造建议。 */
export function suggestionForReasonCode(code: string | undefined): string | undefined {
  if (!code) return undefined;
  const map: Record<string, string> = {
    SAFE_MODE_MUTATION_HOLD: '确认写路径风险后加 --confirm-mutations 重跑；或保持 SAFE 模式仅完成只读验证。',
    UI_EXECUTOR_UNAVAILABLE: 'UI 用例已生成但暂无 Browser Processor：可作为人工 UI 检查单执行，待 Adapter 主线接入后自动化。',
    DATA_EXECUTOR_UNAVAILABLE: '数据验证已设计但缺 Data Connector / 双 Actor 凭据：补齐后重跑即可自动执行。',
    EXPECTED_OUTCOME_UNKNOWN: '为对应 AC 补充可判定的预期结果（状态码/字段值），禁止系统猜测。',
    AUTH_POLICY_UNKNOWN: '在需求中显式声明「无需认证」或「认证 Header + Actor」，禁止猜测匿名身份。',
    EXECUTION_ACTION_UNAVAILABLE: '该目标没有可绑定的执行动作：检查 AC 是否显式写了 Method + Path。',
    CLEANUP_POLICY_REQUIRED: 'test/integration 环境执行写路径需配置 Cleanup；本机验证请改用 --env local（仅 loopback）。',
    REQUIREMENT_CONTRACT_INCOMPLETE: '按报告中的阻断码补全需求文档的参数/认证/响应约束后重跑。',
  };
  return map[code];
}

function reasonCodeOf(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  const match = reason.match(/^[A-Z][A-Z0-9_]+/);
  return match ? match[0] : undefined;
}

interface DraftProblem extends Omit<DevTestProblem, 'id'> {}

/** 聚合相同 title+category 的草稿，合并 caseIds 并保持首次出现顺序。 */
function dedupe(drafts: DraftProblem[]): DevTestProblem[] {
  const merged = new Map<string, DraftProblem>();
  for (const draft of drafts) {
    const key = `${draft.category}::${draft.title}`;
    const existing = merged.get(key);
    if (existing) {
      for (const caseId of draft.caseIds) {
        if (!existing.caseIds.includes(caseId)) existing.caseIds.push(caseId);
      }
      for (const item of draft.evidence) {
        if (existing.evidence.length < 5 && !existing.evidence.includes(item)) existing.evidence.push(item);
      }
      continue;
    }
    merged.set(key, { ...draft, caseIds: [...draft.caseIds] });
  }
  return [...merged.values()].map((problem, index) => ({
    ...problem,
    id: `PROB-${String(index + 1).padStart(3, '0')}`,
  }));
}

/**
 * 从 runAcceptancePipeline 的返回结果构建统一问题清单与维度统计。
 * 输入即管线产物，不做二次解析，保证与报告同源。
 */
export function buildDevTestProblems(input: {
  report: AcceptanceReport;
  /** 管线返回的 contractPreflight（AcceptanceReport 本体不含该字段）。 */
  contracts?: { validation: { status: string; reasons: string[] } };
  results: Array<{
    caseId: string;
    status?: string;
    pass?: boolean;
    priority?: string;
    error?: string;
    classification?: string;
    attribution?: { reason?: string };
    evidence?: { assertions?: Array<{ pass?: boolean; detail?: string; expected?: unknown; actual?: unknown }> };
  }>;
  requirementWarnings: Array<{ code?: string; message?: string; blocking?: boolean }>;
}): { problems: DevTestProblem[]; dimensionStats: DevTestDimensionStat[] } {
  const { report } = input;
  // AcceptanceCaseReportItem 没有独立 dimension 字段，testType 即维度投影
  // （FUNCTIONAL/API/UI/PARAMETER/AUTH/PERMISSION/DATA_ISOLATION/...）。
  const dimensionByCase = new Map(report.cases.map((item) => [item.caseId, String(item.testType)]));
  const drafts: DraftProblem[] = [];

  // 1. 契约门禁失败 → critical
  if (input.contracts && input.contracts.validation.status !== 'VALID') {
    drafts.push({
      severity: 'critical',
      category: 'CONTRACT_GATE',
      title: `CONTRACT_GATE_${input.contracts.validation.status}：${input.contracts.validation.reasons.join('；')}`,
      reasonCode: `CONTRACT_GATE_${input.contracts.validation.status}`,
      caseIds: [],
      reproduce: [],
      evidence: [...input.contracts.validation.reasons],
      suggestion: suggestionForReasonCode('REQUIREMENT_CONTRACT_INCOMPLETE'),
    });
  }

  // 2. 阻断型需求告警 → major
  for (const warning of input.requirementWarnings.filter((item) => item.blocking)) {
    const code = warning.code ?? 'REQUIREMENT_WARNING';
    drafts.push({
      severity: 'major',
      category: 'REQUIREMENT_ISSUE',
      title: `${code}：${warning.message ?? '需求契约不完整'}`,
      reasonCode: code,
      caseIds: [],
      reproduce: [],
      evidence: [warning.message ?? code],
      suggestion: suggestionForReasonCode('REQUIREMENT_CONTRACT_INCOMPLETE'),
    });
  }

  // 3. 真实执行的 FAIL 断言 → P0 critical / 其余 major（每个失败用例一条）
  for (const result of input.results.filter((item) => item.status === 'FAIL')) {
    const failedDetails = (result.evidence?.assertions ?? [])
      .filter((assertion) => assertion.pass === false)
      .slice(0, 3)
      .map((assertion) => assertion.detail || `expected=${JSON.stringify(assertion.expected)} actual=${JSON.stringify(assertion.actual)}`);
    drafts.push({
      severity: result.priority === 'P0' ? 'critical' : 'major',
      category: 'ASSERTION_FAILURE',
      title: result.error?.replace(/^FAIL[:：]\s*/, '') || `用例 ${result.caseId} 执行失败`,
      dimension: dimensionByCase.get(result.caseId),
      caseIds: [result.caseId],
      reproduce: [`使用 --case-id ${result.caseId} 单独重跑复现`],
      evidence: failedDetails.length ? failedDetails : ['断言失败（详见报告证据附录）'],
      suggestion: '先核对是环境数据问题还是产品缺陷；环境因素排除后按缺陷流程处理。',
    });
  }

  // 4. BLOCKED 结果按原因码聚合 → minor（整体被挡时升级 major）
  const allBlockedRun = report.summary.designed > 0
    && report.summary.executed === 0
    && report.summary.blocked + report.summary.notExecuted === report.summary.designed;
  const blockedByCode = new Map<string, { caseIds: string[]; sampleReason: string }>();
  for (const result of input.results.filter((item) => item.status === 'BLOCKED')) {
    const code = reasonCodeOf(result.attribution?.reason) ?? reasonCodeOf(result.error) ?? 'EXECUTION_BLOCKED';
    const bucket = blockedByCode.get(code) ?? { caseIds: [], sampleReason: result.attribution?.reason ?? result.error ?? code };
    bucket.caseIds.push(result.caseId);
    blockedByCode.set(code, bucket);
  }
  for (const [code, bucket] of blockedByCode) {
    drafts.push({
      severity: allBlockedRun ? 'major' : 'minor',
      category: 'EXECUTION_BLOCKED',
      title: `${code}：${bucket.sampleReason}`,
      reasonCode: code,
      caseIds: bucket.caseIds,
      reproduce: [],
      evidence: [bucket.sampleReason],
      suggestion: suggestionForReasonCode(code),
    });
  }

  // 5. DESIGNED_ONLY 缺口按原因码聚合 → trivial（同时进入报告「未知项」）
  const designedOnlyByCode = new Map<string, { caseIds: string[]; sampleReason: string }>();
  for (const result of input.results.filter((item) => item.status === 'NOT_EXECUTED')) {
    const raw = result.attribution?.reason ?? result.error ?? 'NOT_EXECUTED';
    const code = reasonCodeOf(raw) ?? 'DESIGNED_ONLY';
    const bucket = designedOnlyByCode.get(code) ?? { caseIds: [], sampleReason: raw.replace(/^NOT_EXECUTED[:：]\s*/, '') };
    bucket.caseIds.push(result.caseId);
    designedOnlyByCode.set(code, bucket);
  }
  for (const [code, bucket] of designedOnlyByCode) {
    drafts.push({
      severity: 'trivial',
      category: 'DESIGN_ONLY_GAP',
      title: `${code}：${bucket.sampleReason}`,
      reasonCode: code,
      caseIds: bucket.caseIds,
      reproduce: [],
      evidence: [bucket.sampleReason],
      suggestion: suggestionForReasonCode(code),
    });
  }

  // 6. 产品缺陷草稿（真实执行 FAIL 归因产品层）→ 按 P0~P3 映射
  for (const defect of report.defects) {
    const affectedCaseIds = defect.affectedCaseIds.length > 0
      ? defect.affectedCaseIds
      : defect.relatedCases;
    drafts.push({
      severity: severityOfDefect(defect.severity),
      category: 'PRODUCT_DEFECT',
      title: defect.title,
      dimension: affectedCaseIds
        .map((caseId) => dimensionByCase.get(caseId))
        .find((dimension) => dimension !== undefined),
      caseIds: affectedCaseIds,
      reproduce: defect.steps ?? [],
      evidence: defect.evidence ?? [],
      suggestion: '缺陷草稿需人工确认后再进入缺陷流程；若为测试数据问题请忽略并在报告中备注。',
    });
  }

  const problems = dedupe(drafts).sort((left, right) =>
    SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity]
    || left.category.localeCompare(right.category)
    || left.id.localeCompare(right.id));

  // 维度统计：以用例为行、执行结果为列。
  const statusByCase = new Map(input.results.map((result) => [result.caseId, result.status ?? 'UNKNOWN']));
  const statOrder: string[] = [];
  const statMap = new Map<string, DevTestDimensionStat>();
  for (const item of report.cases) {
    const dimension = String(item.testType ?? 'OTHER');
    let stat = statMap.get(dimension);
    if (!stat) {
      stat = { dimension, total: 0, executable: 0, passed: 0, failed: 0, blocked: 0, notExecuted: 0 };
      statMap.set(dimension, stat);
      statOrder.push(dimension);
    }
    stat.total += 1;
    const status = statusByCase.get(item.caseId);
    if (item.executionMode === 'EXECUTABLE') stat.executable += 1;
    if (status === 'PASS') stat.passed += 1;
    else if (status === 'FAIL') stat.failed += 1;
    else if (status === 'BLOCKED') stat.blocked += 1;
    else if (status === 'NOT_EXECUTED' || status === undefined) stat.notExecuted += 1;
  }

  return { problems, dimensionStats: statOrder.map((dimension) => statMap.get(dimension)!) };
}

/**
 * 面向开发者的结论归一：直接复用 acceptance 报告的权威 conclusion，
 * 保证 DevTest 横幅与验收语义一致（FAIL > BLOCKED > PARTIAL > PASS）。
 */
export function deriveDevTestConclusion(report: AcceptanceReport): 'PASS' | 'FAIL' | 'BLOCKED' | 'PARTIAL' {
  return report.conclusion;
}
