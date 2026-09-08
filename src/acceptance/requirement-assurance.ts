import { createHash } from 'node:crypto';
import type { AcceptanceRequirement, RequirementFact, RequirementSource } from './requirement-ir.js';
import type { TestCase } from '../agents/test-design/testcase-schema.js';

export type RequirementAssuranceStatus = 'CONTEXT' | 'NEEDS_CONFIRMATION' | 'NOT_UNDERSTOOD'
  | 'UNCOVERED' | 'NOT_TESTED' | 'BLOCKED' | 'PASS' | 'FAIL';
export interface RequirementAssurance {
  policy: 'NO_SILENT_REQUIREMENT_GAPS_V1';
  phase: 'BEFORE_EXECUTION' | 'AFTER_EXECUTION';
  status: 'READY' | 'BLOCKED' | 'PASS' | 'FAIL';
  entries: Array<{ id: string; statement: string; source: RequirementSource; factIds: string[];
    caseIds: string[]; status: RequirementAssuranceStatus; reason: string; question?: string }>;
  unresolvedIds: string[];
  blockedCaseIds: string[];
}

/** Confirmation is a property of the requirement, not an execution approval or a model score. */
export function requirementNeedsConfirmation(fact: Pick<RequirementFact, 'statement' | 'epistemicType' | 'provenance'> & { source?: RequirementSource }): boolean {
  return fact.epistemicType !== 'FACT' || fact.provenance === 'INFERRED' || fact.provenance === 'UNKNOWN'
    || /待确认|待定|尚未确定|需要确认|\bTBD\b|\bTODO\b|to be confirmed/i.test(`${fact.statement} ${fact.source?.text ?? fact.source?.content ?? ''}`);
}

export function isRequirementObligation(fact: Pick<RequirementFact, 'statement' | 'epistemicType' | 'provenance' | 'normativity' | 'source'>): boolean {
  if (/^#{1,6}\s/.test((fact.source.text ?? fact.source.content ?? '').trim())) return false;
  return fact.normativity === 'NORMATIVE' || requirementNeedsConfirmation(fact)
    && /待确认|待定|\bTBD\b|\bTODO\b|必须|不得|允许|应当|应该|支持|返回|删除|保存|must|shall|return|delete/i.test(fact.statement);
}

function bareOperation(fact: RequirementFact, requirement: AcceptanceRequirement): string | undefined {
  const operation = requirement.apis.find((api) => api.operationKey === fact.statement.trim());
  // A method/path declaration is binding metadata, not a missing business expected result.
  return operation && fact.entityRefs.apiSpecIds.includes(operation.id) ? operation.id : undefined;
}

/** Always inventories the full source/ledger, never only the selected or successful cases. */
export function buildRequirementAssurance(input: {
  requirement: AcceptanceRequirement;
  markdown?: string;
  allTestCases: readonly TestCase[];
  selectedCaseIds: readonly string[];
  observations?: ReadonlyMap<string, { status: string; verified: boolean; verifiedFactIds: readonly string[]; bindingApiSpecId?: string }>;
}): RequirementAssurance {
  const selected = new Set(input.selectedCaseIds);
  const entries: RequirementAssurance['entries'] = [];
  const blockedCaseIds = new Set<string>();
  for (const fact of input.requirement.factLedger) {
    const operationId = bareOperation(fact, input.requirement);
    const cases = input.allTestCases.filter((testCase) => testCase.source?.factIds?.includes(fact.id)
      || operationId && testCase.source?.apiSpecId === operationId);
    const pending = requirementNeedsConfirmation(fact);
    const requirementLike = isRequirementObligation(fact);
    let status: RequirementAssuranceStatus = 'CONTEXT';
    let reason = '保留背景/结构说明，不计作需求通过';
    if (requirementLike) {
      if (pending) { status = 'NEEDS_CONFIRMATION'; reason = '规则含推测、意见、未知来源或待确认标记，不能作为验收预期'; }
      else if (fact.status === 'BLOCKED' || fact.canonical.normalizationStatus === 'UNRESOLVED' && !operationId) {
        status = 'NOT_UNDERSTOOD'; reason = fact.statusReason ?? '未形成明确且无冲突的业务预期';
      } else if (!cases.length || !operationId && !cases.some((testCase) => testCase.assertions.some((assertion) =>
        assertion.type !== 'DESIGN_EXPECTATION' && assertion.factIds?.includes(fact.id)))) {
        status = 'UNCOVERED'; reason = '没有与此要求关联的确定性断言，不能用其他要求的测试代替';
      } else {
        status = 'NOT_TESTED'; reason = '已保留测试映射，但本轮尚未完成全部关联验证';
        if (input.observations) {
          const observations = cases.map((testCase) => selected.has(testCase.id) ? input.observations!.get(testCase.id) : undefined);
          const verified = observations.every((observation) => observation?.verified
            && (operationId ? observation.bindingApiSpecId === operationId : observation.verifiedFactIds.includes(fact.id)));
          if (verified && observations.every((observation) => observation?.status === 'PASS')) {
            status = 'PASS'; reason = '本轮全部关联断言与实际证据通过';
          } else if (observations.some((observation) => observation?.verified && observation.status === 'FAIL')) {
            status = 'FAIL'; reason = '本轮关联证据证明要求未满足；其他缺口仍单独保留';
          } else if (observations.some((observation) => observation && !observation.verified)) {
            status = 'BLOCKED'; reason = '实际执行、确定性判断或要求对应的证据不完整';
          }
        }
      }
    }
    if (status === 'NEEDS_CONFIRMATION' || status === 'NOT_UNDERSTOOD') {
      // If the unknown rule has no mapping, its impact cannot safely be scoped.
      for (const id of cases.length ? cases.map((testCase) => testCase.id) : input.selectedCaseIds) blockedCaseIds.add(id);
    }
    entries.push({ id: fact.id, statement: fact.statement, source: fact.source, factIds: [fact.id],
      caseIds: cases.map((testCase) => testCase.id), status, reason,
      question: status === 'NEEDS_CONFIRMATION' || status === 'NOT_UNDERSTOOD'
        ? `请确认“${fact.statement}”的适用条件及明确的成功/失败结果；当前实现不能代替业务决定。` : undefined });
  }
  // Cross-check raw lines so a parser omission remains visible even without a Fact/Case.
  for (const [index, raw] of (input.markdown ?? '').split(/\r?\n/).entries()) {
    const text = raw.trim();
    if (!text || /^#{1,6}\s|^`{3}|^~{3}|^\|?\s*:?-{3,}|^<!--|-->$/.test(text)) continue;
    if (input.requirement.factLedger.some((fact) => index + 1 >= fact.source.lineStart && index + 1 <= fact.source.lineEnd)) continue;
    const id = `SOURCE-${createHash('sha256').update(`${index + 1}:${text}`).digest('hex').slice(0, 16)}`;
    entries.push({ id, statement: text, source: { line: index + 1, content: raw }, factIds: [], caseIds: [],
      status: 'NOT_UNDERSTOOD', reason: '原文没有进入需求账本，禁止静默丢弃', question: `请明确这段原文的业务含义：“${text}”` });
    input.selectedCaseIds.forEach((caseId) => blockedCaseIds.add(caseId));
  }
  const unresolvedIds = entries.filter((entry) => !['CONTEXT', 'PASS', 'FAIL'].includes(entry.status)).map((entry) => entry.id);
  const obligations = entries.filter((entry) => entry.status !== 'CONTEXT');
  return { policy: 'NO_SILENT_REQUIREMENT_GAPS_V1', phase: input.observations ? 'AFTER_EXECUTION' : 'BEFORE_EXECUTION',
    status: entries.some((entry) => entry.status === 'FAIL') ? 'FAIL'
      : !obligations.length || (input.observations ? unresolvedIds.length > 0 : entries.some((entry) =>
        ['NEEDS_CONFIRMATION', 'NOT_UNDERSTOOD', 'UNCOVERED'].includes(entry.status))) ? 'BLOCKED'
        : input.observations ? 'PASS' : 'READY',
    entries, unresolvedIds, blockedCaseIds: [...blockedCaseIds] };
}
