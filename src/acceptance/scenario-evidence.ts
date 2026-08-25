import type {
  EvidenceEnvelope,
  EvidenceRequirement,
  Scenario,
  ScenarioAssertion,
} from './scenario-contract.js';

function containsAll<T>(actual: readonly T[], expected: readonly T[]): boolean {
  const values = new Set(actual);
  return expected.every((item) => values.has(item));
}

/**
 * Required Evidence 的唯一匹配规则。相同 kind 不能替代 requirement identity，
 * 未验证、跨 Scenario、跨 Operation 或缺失 AC 追溯的证据均不能支撑 PASS。
 */
export function evidenceSatisfiesRequirement(
  scenario: Pick<Scenario, 'id' | 'assertions'>,
  requirement: EvidenceRequirement,
  evidence: EvidenceEnvelope,
): boolean {
  if (evidence.id !== requirement.id || evidence.requirementId && evidence.requirementId !== requirement.id) return false;
  if (evidence.scenarioId !== scenario.id || evidence.verified !== true) return false;
  if (requirement.operationId && evidence.operationId !== requirement.operationId) return false;
  const linkedAssertions = scenario.assertions.filter((assertion) => requirement.assertionIds.includes(assertion.id));
  const requiredCriteria = [...new Set(linkedAssertions.flatMap((assertion) => assertion.acceptanceCriteriaIds))];
  return containsAll(evidence.acceptanceCriteriaIds, requiredCriteria);
}

export function findEvidenceForRequirement(
  scenario: Pick<Scenario, 'id' | 'assertions'>,
  requirement: EvidenceRequirement,
  evidence: readonly EvidenceEnvelope[],
): EvidenceEnvelope | undefined {
  return evidence.find((item) => evidenceSatisfiesRequirement(scenario, requirement, item));
}

/** 只返回 Assertion 明确绑定且已通过 Requirement identity 校验的原始观察证据。 */
export function evidenceForAssertion(
  scenario: Pick<Scenario, 'id' | 'assertions' | 'evidenceRequirements'>,
  assertion: ScenarioAssertion,
  evidence: readonly EvidenceEnvelope[],
): EvidenceEnvelope[] {
  const wanted = new Set(assertion.evidenceRequirementIds);
  return scenario.evidenceRequirements
    .filter((requirement) => wanted.has(requirement.id) && requirement.assertionIds.includes(assertion.id))
    .flatMap((requirement) => {
      const match = findEvidenceForRequirement(scenario, requirement, evidence);
      return match ? [match] : [];
    });
}
