import type { Requirement } from '../requirement/requirement-schema.js';
import { applyTestCaseQualityGate, type TestCaseQualityGateResult } from '../../acceptance/test-case-quality-gate.js';
import { generateAcceptanceApiCases } from '../../acceptance/test-case-generator.js';
import { buildAcceptanceTestDesign, type AcceptanceTestDesign } from '../../acceptance/test-objective.js';
import { parseAcceptanceRequirement } from '../../acceptance/requirement-parser.js';
import { generateTestPoints } from '../../acceptance/test-point.js';
import { reviewTestDesign, type TestDesignReview } from '../../acceptance/test-design-intelligence.js';
import type { AcceptanceRequirement } from '../../acceptance/requirement-ir.js';
import type { TestCase } from './testcase-schema.js';

export interface CanonicalAgentTestDesign {
  requirement: AcceptanceRequirement;
  design: AcceptanceTestDesign;
  quality: TestCaseQualityGateResult;
  review: TestDesignReview;
  cases: TestCase[];
  markdown: string;
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function markdownFacts(requirement: Requirement): string[] {
  const explicit = requirement.understanding?.facts
    .filter((fact) => fact.knowledge === 'EXPLICIT')
    .map((fact) => fact.source ?? fact.statement) ?? [];
  return unique([
    ...explicit,
    requirement.goal,
    ...requirement.businessRules,
    ...(requirement.constraints ?? []),
    ...requirement.requirements.map((item) => item.values.length
      ? `输入 ${item.name} 的需求声明取值为 ${item.values.map((value) => JSON.stringify(value)).join('、')}`
      : `输入 ${item.name} 的规则尚未明确`),
    ...requirement.dependencies.map((dependency) => `业务依赖：${dependency}`),
  ]);
}

/**
 * 历史 Agent Requirement 到 canonical Requirement Parser 的轻量输入投影。
 * 它只搬运已声明事实，不补 Actor、状态、接口、字段或预期结果。
 */
export function projectAgentRequirementMarkdown(requirement: Requirement): string {
  const source = requirement.source?.trim();
  if (source && (/^\s*#/m.test(source) || /^\s*\|.+\|\s*$/m.test(source))) return source;
  const facts = source
    ? unique(source.split(/[。；;\n]+/).map((item) => item.trim()).filter(Boolean))
    : markdownFacts(requirement);
  const fallbackFacts = facts.length ? facts : markdownFacts(requirement);
  return [
    `# ${requirement.feature && requirement.feature !== 'unknown' ? requirement.feature : 'Requirement'}`,
    '',
    '## Requirement Facts',
    ...fallbackFacts.map((fact) => `- ${fact}`),
  ].join('\n');
}

/**
 * TestDesignAgent 的确定性 V2 生成入口。复用 Acceptance 的 Requirement Model、
 * Business Model、Strategy、Generator 与 Quality Gate，不维护第二套 Case 规则。
 */
export function generateCanonicalAgentTestDesign(
  requirement: Requirement,
  options: { maxCases?: number } = {},
): CanonicalAgentTestDesign {
  const markdown = projectAgentRequirementMarkdown(requirement);
  const canonicalRequirement = parseAcceptanceRequirement(markdown, { documentId: 'test-design-agent' });
  const design = buildAcceptanceTestDesign(canonicalRequirement);
  const points = generateTestPoints(canonicalRequirement, design);
  const generated = generateAcceptanceApiCases(canonicalRequirement, points);
  const quality = applyTestCaseQualityGate({
    requirement: canonicalRequirement,
    objectives: design.objectives,
    testCases: generated,
  });
  const selected = quality.testCases.slice(0, Math.max(0, options.maxCases ?? 50));
  for (const testCase of selected) {
    testCase.metadata = {
      ...(testCase.metadata ?? {}),
      source: 'deterministic-generator',
      canonicalGenerator: 'acceptance',
    };
  }
  const review = reviewTestDesign({
    requirement: canonicalRequirement,
    businessModel: design.businessModel,
    strategy: design.testStrategy,
    scenarioCandidates: design.scenarioCandidates,
    testCases: selected,
  });
  return { requirement: canonicalRequirement, design, quality, review, cases: selected, markdown };
}
