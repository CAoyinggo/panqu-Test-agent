import { describe, expect, it } from 'vitest';
import { applyTestCaseQualityGate } from '../../src/acceptance/test-case-quality-gate.js';
import { generateAcceptanceApiCases } from '../../src/acceptance/test-case-generator.js';
import {
  aggregateTestDesignQuality,
  evaluateTestDesignQuality,
  type TestDesignObservation,
} from '../../src/acceptance/test-design-quality-metrics.js';
import { parseAcceptanceRequirement } from '../../src/acceptance/requirement-parser.js';
import { generateTestPoints } from '../../src/acceptance/test-point.js';
import { buildAcceptanceTestDesign } from '../../src/acceptance/test-objective.js';
import {
  TEST_DESIGN_BENCHMARK_DIMENSIONS,
  TEST_DESIGN_QUALITY_GROUND_TRUTH,
} from './fixtures/test-design-quality-ground-truth.js';

function observe(index: number): TestDesignObservation {
  const truth = TEST_DESIGN_QUALITY_GROUND_TRUTH[index];
  const requirement = parseAcceptanceRequirement(truth.markdown, { documentId: truth.documentId });
  const design = buildAcceptanceTestDesign(requirement);
  const points = generateTestPoints(requirement, design);
  const generated = generateAcceptanceApiCases(requirement, points);
  const quality = applyTestCaseQualityGate({ requirement, objectives: design.objectives, testCases: generated });
  return { requirement, objectives: design.objectives, testCases: quality.testCases };
}

describe('Independent 12-class Requirement -> Test Design quality benchmark', () => {
  it('contains the twelve required classes as human-authored semantic oracles', () => {
    expect(TEST_DESIGN_QUALITY_GROUND_TRUTH.map((item) => item.id)).toEqual([...TEST_DESIGN_BENCHMARK_DIMENSIONS]);
    expect(TEST_DESIGN_QUALITY_GROUND_TRUTH).toHaveLength(12);
    for (const benchmark of TEST_DESIGN_QUALITY_GROUND_TRUTH) {
      expect(benchmark.facts.length).toBeGreaterThan(0);
      expect(benchmark.facts.every((fact) => fact.id && fact.sourceText && fact.semanticFragments.length > 0)).toBe(true);
      expect(JSON.stringify(benchmark)).not.toMatch(/FACT-[A-F0-9]{8,}|OBJ-[A-F0-9]{8,}|TC-[A-F0-9]{8,}/);
    }
  });

  it('calculates quality from the independent oracle and keeps every metric finite and bounded', () => {
    const results = TEST_DESIGN_QUALITY_GROUND_TRUTH.map((truth, index) =>
      evaluateTestDesignQuality(truth, observe(index)));
    const aggregate = aggregateTestDesignQuality(results);

    for (const metric of [
      aggregate.factRecall,
      aggregate.silentOmissionRate,
      aggregate.falseInterpretationRate,
      aggregate.objectiveRecall,
      aggregate.objectivePrecision,
      aggregate.caseRecall,
      aggregate.duplicateRate,
      aggregate.executableRate,
    ]) {
      expect(Number.isFinite(metric)).toBe(true);
      expect(metric).toBeGreaterThanOrEqual(0);
      expect(metric).toBeLessThanOrEqual(1);
    }

    // These are quality gates, not vanity targets.  A parser may miss a Fact
    // only if it emits an explicit blocking signal; invented interpretations
    // and semantically duplicated Cases are never accepted as coverage.
    expect(aggregate.factRecall).toBeGreaterThanOrEqual(0.85);
    expect(aggregate.silentOmissionRate).toBeLessThanOrEqual(0.10);
    expect(aggregate.falseInterpretationRate).toBeLessThanOrEqual(0.10);
    expect(aggregate.objectiveRecall).toBeGreaterThanOrEqual(0.85);
    expect(aggregate.objectivePrecision).toBeGreaterThanOrEqual(0.75);
    expect(aggregate.caseRecall).toBeGreaterThanOrEqual(0.65);
    expect(aggregate.duplicateRate).toBe(0);
    expect(results.flatMap((item) => item.missingBlockingWarningCodes)).toEqual([]);
    expect(results.flatMap((item) => item.unexpectedBlockingWarningCodes)).toEqual([]);
  });

  it('does not convert missing UI/Data/side-effect execution capability into executable coverage', () => {
    const ids = ['ATOMICITY', 'IDEMPOTENCY', 'UI_STATE'];
    const results = TEST_DESIGN_QUALITY_GROUND_TRUTH
      .map((truth, index) => ({ truth, result: evaluateTestDesignQuality(truth, observe(index)) }))
      .filter(({ truth }) => ids.includes(truth.id));

    expect(results).toHaveLength(3);
    for (const { truth, result } of results) {
      expect(result.expectedCases, `${truth.id} Ground Truth must retain a designed test`).toBeGreaterThan(0);
      expect(result.executableCases, `${truth.id} has no independent UI/Data/side-effect executor`).toBe(0);
    }
    expect(results.some(({ result }) => result.matchedCases > 0)).toBe(true);
  });

  it('detects silent omission, false interpretation, imprecise objectives and semantic duplicates independently', () => {
    const truth = TEST_DESIGN_QUALITY_GROUND_TRUTH.find((item) => item.id === 'CRUD')!;
    const baseline = observe(TEST_DESIGN_QUALITY_GROUND_TRUTH.indexOf(truth));
    const baselineMetric = evaluateTestDesignQuality(truth, baseline);
    expect(baselineMetric.recognizedFacts).toBe(1);

    const sourceFact = baseline.requirement.factLedger.find((fact) => fact.statement.includes('有效订单'))!;
    expect(sourceFact).toBeDefined();

    const omitted: TestDesignObservation = {
      requirement: {
        ...baseline.requirement,
        factLedger: baseline.requirement.factLedger.filter((fact) => fact.id !== sourceFact.id),
        warnings: [],
      },
      objectives: baseline.objectives.filter((objective) => !objective.factIds.includes(sourceFact.id)),
      testCases: baseline.testCases.filter((testCase) => !testCase.source?.factIds?.includes(sourceFact.id)),
    };
    const omissionMetric = evaluateTestDesignQuality(truth, omitted);
    expect(omissionMetric.factRecall).toBe(0);
    expect(omissionMetric.silentOmissionRate).toBe(1);

    const falseFact = {
      ...sourceFact,
      id: 'INDEPENDENT-FALSE-FACT',
      statement: '普通用户必须删除订单',
      category: 'PERMISSION' as const,
    };
    const falseMetric = evaluateTestDesignQuality(truth, {
      ...baseline,
      requirement: { ...baseline.requirement, factLedger: [...baseline.requirement.factLedger, falseFact] },
    });
    expect(falseMetric.falseInterpretations).toBeGreaterThan(0);
    expect(falseMetric.falseInterpretationRate).toBeGreaterThan(0);

    const precisionTruth = TEST_DESIGN_QUALITY_GROUND_TRUTH.find((item) => item.id === 'PERMISSION')!;
    const precisionBaseline = observe(TEST_DESIGN_QUALITY_GROUND_TRUTH.indexOf(precisionTruth));
    const precisionBaselineMetric = evaluateTestDesignQuality(precisionTruth, precisionBaseline);
    const objective = precisionBaseline.objectives.find((item) => item.scenario.includes('admin-root'))!;
    expect(objective).toBeDefined();
    const impreciseMetric = evaluateTestDesignQuality(precisionTruth, {
      ...precisionBaseline,
      objectives: [...precisionBaseline.objectives, {
        ...objective,
        id: 'INDEPENDENT-FALSE-OBJECTIVE',
        dimension: 'DATA_ISOLATION',
        scenario: 'Invent cross-tenant isolation',
      }],
    });
    expect(precisionBaselineMetric.objectivePrecision).toBeGreaterThan(0);
    expect(impreciseMetric.objectivePrecision).toBeLessThan(precisionBaselineMetric.objectivePrecision);

    const sourceCase = baseline.testCases.find((testCase) => testCase.source?.factIds?.includes(sourceFact.id));
    expect(sourceCase).toBeDefined();
    const duplicate = { ...sourceCase!, id: 'INDEPENDENT-DUPLICATE-CASE' };
    const duplicateMetric = evaluateTestDesignQuality(truth, {
      ...baseline,
      testCases: [...baseline.testCases, duplicate],
    });
    expect(duplicateMetric.duplicateCases).toBeGreaterThan(0);
    expect(duplicateMetric.duplicateRate).toBeGreaterThan(0);
  });
});
