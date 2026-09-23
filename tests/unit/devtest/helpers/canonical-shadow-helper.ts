/**
 * Panqu AI DevTest — Canonical Regression Helper
 * Phase 1.5B 表驱动 Canonical 回归测试辅助工具 (对齐冻结的 Golden Expectations)
 *
 * 核心架构边界 (遵守 docs/ARCHITECTURE_FREEZE.md 受控扩展原则):
 * 1. 本模块纯粹存在于测试套件中，严禁从 core-kernel、CLI、MCP 或任何生产调用链中导入；
 * 2. 实际调用当前 Canonical 驱动的 core-kernel.verify() 并与预设的冻结黄金预期 (Frozen Golden Expectations) 比对；
 *    严禁重新引入旧版 verify 源码，历史基准值明确为冻结的 golden expectations；
 * 3. 显式归一化裁决状态为 PASS / FAIL / UNVERIFIED；
 * 4. 严格将差异划分为 6 类，计算迁移安全门槛指标：
 *    - EXPECTED_STRICTER 必须具备白名单原因码且显式标记 expectedStricter=true，否则归入 NEEDS_REVIEW；
 *    - MAPPING_GAP 必须严格为 0，任一 MAPPING_FAILED 阻断安全门禁；
 *    - evidenceIds 必须来自 mapper 实际生成的 Envelope，严禁预填伪造；
 *    - P0 假 PASS 场景通过 tags: ['P0_FALSE_PASS'] 识别，不依赖固定场景编号。
 */

import type { CanonicalTestSpec, CanonicalEvidenceEnvelope } from '../../../../src/devtest/canonical-protocol.js';
import {
  evaluateCanonicalVerdict,
  type CanonicalVerdictResult,
  type CanonicalVerdict,
} from '../../../../src/devtest/canonical-verdict-engine.js';
import { verify, type VerifyKernelOptions, type VerifyKernelResult } from '../../../../src/devtest/core-kernel.js';
import { mapVerifyToCanonicalEvidence } from '../../../../src/devtest/legacy-protocol-mappers.js';

// ============================================================================
// 一、统一比较状态与差异分类定义
// ============================================================================

export type GoldenExpectationVerdict = 'PASS' | 'FAIL' | 'UNVERIFIED';

export type ShadowComparisonCategory =
  'MATCH' | 'EXPECTED_STRICTER' | 'REGRESSION_RISK' | 'MAPPING_GAP' | 'SEMANTIC_MISMATCH' | 'NEEDS_REVIEW';

/**
 * 允许的 EXPECTED_STRICTER 原因码白名单
 */
export const ALLOWED_EXPECTED_STRICTER_REASONS = [
  'USER_ASSERTION_ONLY_TIGHTENED',
  'STATIC_CONTRACT_UNVERIFIED_FOR_REAL',
  'REJECT_FIXTURE_FOR_REAL_SPEC',
] as const;

export type AllowedExpectedStricterReason = (typeof ALLOWED_EXPECTED_STRICTER_REASONS)[number];

/**
 * 差异分类算法（比对 Canonical 裁决与冻结黄金预期）：
 * - MATCH: 结果与冻结黄金预期一致且映射成功
 * - EXPECTED_STRICTER: 必须同时满足：
 *     1. expectedStricter === true;
 *     2. reasonCode 位于允许白名单列表;
 *     3. goldenExpectation === 'PASS' (冻结黄金预期为 PASS);
 *     4. canonicalVerdict === 'FAIL' || canonicalVerdict === 'UNVERIFIED' (新引擎更严格安全拦截).
 *   未显式标记或原因码不在白名单的收紧，必须分类为 NEEDS_REVIEW！
 * - REGRESSION_RISK: 冻结黄金预期为 FAIL/UNVERIFIED，新引擎判定为 PASS（冒进放行，存在回归风险）
 * - MAPPING_GAP: 证据映射失败 (mappingSuccess === false)
 * - SEMANTIC_MISMATCH: 语义不可比
 * - NEEDS_REVIEW: 无法自动判定的差异
 */
export function classifyShadowDifference(params: {
  goldenExpectation: GoldenExpectationVerdict;
  canonicalVerdict: CanonicalVerdict | 'MAPPING_FAILED';
  mappingSuccess: boolean;
  isExpectedStricterScenario?: boolean;
  reasonCode?: string;
  semanticMismatch?: boolean;
}): ShadowComparisonCategory {
  if (params.semanticMismatch) {
    return 'SEMANTIC_MISMATCH';
  }
  if (!params.mappingSuccess || params.canonicalVerdict === 'MAPPING_FAILED') {
    return 'MAPPING_GAP';
  }
  if (params.goldenExpectation === params.canonicalVerdict) {
    return 'MATCH';
  }
  // 冻结黄金预期为 PASS，新引擎为 FAIL 或 UNVERIFIED
  if (
    params.goldenExpectation === 'PASS' &&
    (params.canonicalVerdict === 'FAIL' || params.canonicalVerdict === 'UNVERIFIED')
  ) {
    const isReasonAllowed =
      Boolean(params.reasonCode) &&
      ALLOWED_EXPECTED_STRICTER_REASONS.includes(params.reasonCode as AllowedExpectedStricterReason);

    if (params.isExpectedStricterScenario === true && isReasonAllowed) {
      return 'EXPECTED_STRICTER';
    }
    // 未显式批准的收紧必须分类为 NEEDS_REVIEW
    return 'NEEDS_REVIEW';
  }
  // 冻结黄金预期为 FAIL 或 UNVERIFIED，新版判定为 PASS (更宽松，冒进漏检风险)
  if (
    (params.goldenExpectation === 'FAIL' || params.goldenExpectation === 'UNVERIFIED') &&
    params.canonicalVerdict === 'PASS'
  ) {
    return 'REGRESSION_RISK';
  }
  return 'NEEDS_REVIEW';
}

// ============================================================================
// 二、单测试场景与结果结构
// ============================================================================

export interface ShadowTestCase {
  index: number;
  name: string;
  testId: string;
  capturedAt: string;
  verifyOptions: VerifyKernelOptions; // 实际调用 Canonical 驱动的 verify()
  spec: CanonicalTestSpec;
  goldenExpectation: GoldenExpectationVerdict; // 必填：冻结的历史基准黄金预期 (Frozen Golden Expectations)
  rawLegacyVerdict?: string;
  rawLegacyAcceptance?: string;
  tags?: string[]; // 例如: ['P0_FALSE_PASS']
  expectedStricter?: boolean;
  reasonCode: string;
  notes: string;
  semanticMismatch?: boolean;
  extraEnvelopes?: CanonicalEvidenceEnvelope[];
}

export interface ShadowComparisonRecord {
  scenarioIndex: number;
  scenarioName: string;
  testId: string;
  tags: string[];
  goldenExpectation: GoldenExpectationVerdict; // 冻结的历史基准黄金预期
  rawLegacyVerdict: string;
  rawLegacyAcceptance?: string;
  canonicalVerdict: CanonicalVerdict | 'MAPPING_FAILED';
  category: ShadowComparisonCategory;
  mappingSuccess: boolean;
  mappingIssues: string[];
  reasonCode: string;
  evidenceIds: string[]; // 必须来自实际生成的信封
  notes: string;
  canonicalResultDetails?: CanonicalVerdictResult;
  actualLegacyResult?: VerifyKernelResult;
}

export interface ShadowComparisonSummary {
  totalScenarios: number;
  matchCount: number;
  expectedStricterCount: number;
  regressionRiskCount: number;
  mappingGapCount: number;
  semanticMismatchCount: number;
  needsReviewCount: number;
  isSafetyGatePassed: boolean;
  gateCheckDetails: {
    p0FalsePassTightened: boolean;
    regressionRiskZero: boolean;
    mappingGapZero: boolean;
    needsReviewZero: boolean;
    noWeakerEvidenceLooserVerdict: boolean;
    allDifferencesHaveReasonAndEvidence: boolean;
  };
}

/**
 * 执行单个表驱动 Canonical 回归用例（实际调用 Canonical verify() 并与冻结的黄金预期比对）
 */
export async function runSingleShadowComparison(testCase: ShadowTestCase): Promise<ShadowComparisonRecord> {
  // 1. 黄金预期必填门禁：缺少黄金预期必须直接失败，严禁从当前 verify 结果或 legacy 推导！
  if (!testCase.goldenExpectation) {
    throw new Error(
      `ShadowTestCase "${testCase.name}" (${testCase.testId}) 缺少必须的 goldenExpectation 黄金预期！严禁从当前 verify 结果或 legacy 推导！`,
    );
  }
  const goldenExpectation: GoldenExpectationVerdict = testCase.goldenExpectation;

  // 2. 实际执行当前 Canonical 驱动的 core-kernel.verify()
  const actualVerifyResult = await verify(testCase.verifyOptions);

  // 3. 将真实结果传入 legacy mapper
  const mappingRes = mapVerifyToCanonicalEvidence(actualVerifyResult, {
    testId: testCase.testId,
    capturedAt: testCase.capturedAt,
    environment: testCase.spec.environment,
  });

  // 4. 证据 ID 必须来自 mapper 实际生成的 Envelope
  let canonicalVerdict: CanonicalVerdict | 'MAPPING_FAILED';
  let verdictResult: CanonicalVerdictResult | undefined;
  const actualEvidenceIds: string[] = [];

  if (!mappingRes.success || !mappingRes.value) {
    canonicalVerdict = 'MAPPING_FAILED';
  } else {
    const envelopes = testCase.extraEnvelopes ? [...mappingRes.value, ...testCase.extraEnvelopes] : mappingRes.value;

    for (const env of envelopes) {
      actualEvidenceIds.push(env.evidenceId);
    }
    verdictResult = evaluateCanonicalVerdict(testCase.spec, envelopes);
    canonicalVerdict = verdictResult.verdict;
  }

  // 5. 分类差异（比对 Canonical 裁决与冻结黄金预期）
  const category = classifyShadowDifference({
    goldenExpectation,
    canonicalVerdict,
    mappingSuccess: mappingRes.success,
    isExpectedStricterScenario: testCase.expectedStricter,
    reasonCode: testCase.reasonCode,
    semanticMismatch: testCase.semanticMismatch,
  });

  return {
    scenarioIndex: testCase.index,
    scenarioName: testCase.name,
    testId: testCase.testId,
    tags: testCase.tags || [],
    goldenExpectation,
    rawLegacyVerdict: testCase.rawLegacyVerdict || actualVerifyResult.verdict,
    rawLegacyAcceptance: testCase.rawLegacyAcceptance || actualVerifyResult.acceptance,
    canonicalVerdict,
    category,
    mappingSuccess: mappingRes.success,
    mappingIssues: mappingRes.issues.map((i) => `[${i.severity}] ${i.code}: ${i.message}`),
    reasonCode: testCase.reasonCode,
    evidenceIds: actualEvidenceIds, // 证据 ID 必须来自实际生成的 Envelope
    notes: testCase.notes,
    canonicalResultDetails: verdictResult,
    actualLegacyResult: actualVerifyResult,
  };
}

/**
 * 汇总表驱动 Canonical 回归比对结果并验证迁移安全门槛
 */
export function buildShadowSummary(records: ShadowComparisonRecord[]): ShadowComparisonSummary {
  const totalScenarios = records.length;
  const matchCount = records.filter((r) => r.category === 'MATCH').length;
  const expectedStricterCount = records.filter((r) => r.category === 'EXPECTED_STRICTER').length;
  const regressionRiskCount = records.filter((r) => r.category === 'REGRESSION_RISK').length;
  const mappingGapCount = records.filter((r) => r.category === 'MAPPING_GAP').length;
  const semanticMismatchCount = records.filter((r) => r.category === 'SEMANTIC_MISMATCH').length;
  const needsReviewCount = records.filter((r) => r.category === 'NEEDS_REVIEW').length;

  // 门禁检查 1: 已知 P0 假 PASS 场景在新引擎中绝不得 PASS (按 tags: 'P0_FALSE_PASS' 识别，不依赖编号)
  const p0Records = records.filter((r) => r.tags?.includes('P0_FALSE_PASS'));
  const p0FalsePassTightened =
    p0Records.length > 0 && p0Records.every((r) => r.category === 'EXPECTED_STRICTER' && r.canonicalVerdict !== 'PASS');

  // 门禁检查 2: REGRESSION_RISK 严格为 0
  const regressionRiskZero = regressionRiskCount === 0;

  // 门禁检查 3: mappingGapCount 严格等于 0 (任一 MAPPING_FAILED 均阻断门禁)
  const mappingGapZero = mappingGapCount === 0;

  // 门禁检查 4: NEEDS_REVIEW 严格为 0 (未显式标记的收紧不能混入门禁放行)
  const needsReviewZero = needsReviewCount === 0;

  // 门禁检查 5: 新引擎不得在证据更弱时给出更宽松结果
  const noWeakerEvidenceLooserVerdict = regressionRiskCount === 0;

  // 门禁检查 6: 所有非 MATCH 差异均具备具体原因码和实际生成的证据 ID
  const nonMatchRecords = records.filter((r) => r.category !== 'MATCH');
  const allDifferencesHaveReasonAndEvidence = nonMatchRecords.every(
    (r) => r.reasonCode.trim().length > 0 && r.evidenceIds.length > 0,
  );

  const isSafetyGatePassed =
    p0FalsePassTightened &&
    regressionRiskZero &&
    mappingGapZero &&
    needsReviewZero &&
    noWeakerEvidenceLooserVerdict &&
    allDifferencesHaveReasonAndEvidence;

  return {
    totalScenarios,
    matchCount,
    expectedStricterCount,
    regressionRiskCount,
    mappingGapCount,
    semanticMismatchCount,
    needsReviewCount,
    isSafetyGatePassed,
    gateCheckDetails: {
      p0FalsePassTightened,
      regressionRiskZero,
      mappingGapZero,
      needsReviewZero,
      noWeakerEvidenceLooserVerdict,
      allDifferencesHaveReasonAndEvidence,
    },
  };
}
