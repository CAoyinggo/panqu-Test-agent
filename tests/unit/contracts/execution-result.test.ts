import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CANONICAL_EXECUTION_STATUSES,
  CANONICAL_RUN_LIFECYCLE_STATUSES,
  type CaseResult,
  type CoverageResult,
  type RunResult,
  assertValidCaseResult,
  assertValidCoverageResult,
  assertValidRunResult,
} from '../../../src/contracts/execution-result.js';
import { coverageLedgerToCanonicalRunResult } from '../../../src/devtest/canonical-adapter.js';
import { toAgentCaseResult } from '../../../src/agents/execution/canonical-adapter.js';
import { toPlatformExecutionStatus } from '../../../src/platform/runs/canonical-adapter.js';
import { toAcceptanceTypeStatistics } from '../../../src/acceptance/canonical-adapter.js';
import type {
  CoverageLedgerSummary,
  TestPointCoverageLedgerItem,
  CoverageLedgerReconciliation,
} from '../../../src/devtest/coverage-ledger.js';

describe('Phase 2 Canonical Execution Result Contracts', () => {
  it('Requirement 1: contracts layer has zero business dependencies on Acceptance, DevTest, Agent, Platform, or MCP', async () => {
    const contractsFilePath = path.resolve('src/contracts/execution-result.ts');
    const content = await readFile(contractsFilePath, 'utf8');

    // contracts/execution-result.ts must not import from any higher-level layer
    expect(content).not.toMatch(/from\s+['"].*\/(acceptance|devtest|agents|platform|mcp|bin)[\/']/);
    expect(content).not.toMatch(/from\s+['"](axios|express|playwright|lodash|vitest)/);
  });

  it('Requirement 2: only four canonical ExecutionStatus values are supported', () => {
    expect(CANONICAL_EXECUTION_STATUSES).toEqual(['PASS', 'FAIL', 'BLOCKED', 'NOT_EXECUTED']);
    expect(CANONICAL_EXECUTION_STATUSES).toHaveLength(4);
    // Explicitly confirm no 5th status like SUCCESS, ERROR, SKIPPED, DESIGNED_ONLY
    expect(CANONICAL_EXECUTION_STATUSES).not.toContain('SUCCESS');
    expect(CANONICAL_EXECUTION_STATUSES).not.toContain('ERROR');
    expect(CANONICAL_EXECUTION_STATUSES).not.toContain('SKIPPED');
    expect(CANONICAL_EXECUTION_STATUSES).not.toContain('DESIGNED_ONLY');
  });

  it('Requirement 3: SKIPPED is preserved as non_execution_reason, NOT as a 5th ExecutionStatus', () => {
    const skippedCase: CaseResult = {
      case_id: 'CASE-SKIP-01',
      requirement_ids: ['REQ-01'],
      execution_status: 'NOT_EXECUTED',
      executed: false,
      non_execution_reason: 'SKIPPED: user skipped manual mutation check',
    };

    expect(CANONICAL_EXECUTION_STATUSES).toContain(skippedCase.execution_status);
    expect(skippedCase.execution_status).toBe('NOT_EXECUTED');
    expect(skippedCase.non_execution_reason).toContain('SKIPPED');
    expect(() => assertValidCaseResult(skippedCase)).not.toThrow();
  });

  it('Requirement 4: invariants enforce executed flag and disallow invalid states', () => {
    // PASS requires executed = true
    expect(() =>
      assertValidCaseResult({
        case_id: 'C1',
        requirement_ids: [],
        execution_status: 'PASS',
        executed: false,
      }),
    ).toThrow(/requires executed = true/);

    // FAIL requires executed = true
    expect(() =>
      assertValidCaseResult({
        case_id: 'C2',
        requirement_ids: [],
        execution_status: 'FAIL',
        executed: false,
      }),
    ).toThrow(/requires executed = true/);

    // NOT_EXECUTED requires executed = false
    expect(() =>
      assertValidCaseResult({
        case_id: 'C3',
        requirement_ids: [],
        execution_status: 'NOT_EXECUTED',
        executed: true,
      }),
    ).toThrow(/requires executed = false/);

    // Valid cases pass without error
    expect(() =>
      assertValidCaseResult({
        case_id: 'C4',
        requirement_ids: ['REQ-1'],
        execution_status: 'PASS',
        executed: true,
      }),
    ).not.toThrow();

    expect(() =>
      assertValidCaseResult({
        case_id: 'C5',
        requirement_ids: ['REQ-1'],
        execution_status: 'BLOCKED',
        executed: false,
        blocked_reason: 'Missing token',
      }),
    ).not.toThrow();
  });

  it('Requirement 5: stable ID and timestamps are strictly preserved across adapters without regeneration', () => {
    const canonicalCase: CaseResult = {
      case_id: 'CASE-STABLE-999',
      requirement_ids: ['REQ-001'],
      execution_status: 'PASS',
      executed: true,
      started_at: '2026-09-14T10:00:00.000Z',
      completed_at: '2026-09-14T10:00:05.000Z',
    };

    // Agent adapter
    const agentCase = toAgentCaseResult(canonicalCase, 'Stable Test Case');
    expect(agentCase.caseId).toBe('CASE-STABLE-999');
    expect(agentCase.status).toBe('PASS');
    expect(agentCase.timestamp).toBe('2026-09-14T10:00:05.000Z');

    // Platform adapter
    const platformStatus = toPlatformExecutionStatus(canonicalCase.execution_status);
    expect(platformStatus).toBe('PASSED');
  });

  it('Requirement 6: CoverageResult count identity (passed + failed + blocked + not_executed === total)', () => {
    const validCoverage: CoverageResult = {
      total: 10,
      passed: 4,
      failed: 2,
      blocked: 1,
      not_executed: 3,
      covered_requirements: 4,
      uncovered_requirements: 2,
      reconciliation_status: 'MATCH',
    };
    expect(() => assertValidCoverageResult(validCoverage)).not.toThrow();

    const invalidCoverage: CoverageResult = {
      ...validCoverage,
      total: 12, // mismatch: 4 + 2 + 1 + 3 = 10 !== 12
    };
    expect(() => assertValidCoverageResult(invalidCoverage)).toThrow(/does not match total/);
  });

  it('Requirement 7: Acceptance adapter projects from canonical CoverageResult without re-deriving counts', () => {
    const coverage: CoverageResult = {
      total: 7,
      passed: 3,
      failed: 1,
      blocked: 2,
      not_executed: 1,
      covered_requirements: 3,
      uncovered_requirements: 1,
      reconciliation_status: 'MATCH',
    };

    const acceptanceStats = toAcceptanceTypeStatistics(coverage);
    expect(acceptanceStats.total).toBe(7);
    expect(acceptanceStats.passed).toBe(3);
    expect(acceptanceStats.failed).toBe(1);
    expect(acceptanceStats.blocked).toBe(2);
    expect(acceptanceStats.notExecuted).toBe(1);
  });

  it('Requirement 8: RunResult lifecycle COMPLETED can coexist with FAIL, BLOCKED, or NOT_EXECUTED cases', () => {
    const mixedRun: RunResult = {
      run_id: 'RUN-MIXED-001',
      lifecycle_status: 'COMPLETED',
      conclusion: 'BLOCKED',
      created_at: '2026-09-14T09:00:00.000Z',
      coverage: {
        total: 3,
        passed: 1,
        failed: 1,
        blocked: 1,
        not_executed: 0,
        covered_requirements: 1,
        uncovered_requirements: 2,
        reconciliation_status: 'MATCH',
      },
      requirement_results: [
        { requirement_id: 'REQ-1', case_ids: ['C1'], status: 'PASS', coverage_status: 'COVERED' },
        { requirement_id: 'REQ-2', case_ids: ['C2'], status: 'FAIL', coverage_status: 'PARTIALLY_COVERED' },
        { requirement_id: 'REQ-3', case_ids: ['C3'], status: 'BLOCKED', coverage_status: 'BLOCKED', uncovered_or_blocked_reason: 'Env down' },
      ],
      case_results: [
        { case_id: 'C1', requirement_ids: ['REQ-1'], execution_status: 'PASS', executed: true },
        { case_id: 'C2', requirement_ids: ['REQ-2'], execution_status: 'FAIL', executed: true },
        { case_id: 'C3', requirement_ids: ['REQ-3'], execution_status: 'BLOCKED', executed: false, blocked_reason: 'Env down' },
      ],
      reconciliation: { status: 'MATCH', reconciled: true, mismatches: [] },
    };

    expect(mixedRun.lifecycle_status).toBe('COMPLETED');
    expect(mixedRun.case_results.some((c) => c.execution_status === 'FAIL')).toBe(true);
    expect(mixedRun.case_results.some((c) => c.execution_status === 'BLOCKED')).toBe(true);
    expect(() => assertValidRunResult(mixedRun)).not.toThrow();
  });

  it('Requirement 9: identical coverage ledger input produces deterministic canonical RunResult', () => {
    const dummyItem = {
      caseId: 'C-001',
      requirementId: 'REQ-1',
      linkedFactIds: ['REQ-1'],
      isUntracedCase: false,
      testPointId: 'TP-1',
      title: 'Resource query',
      dimension: 'API',
      planned: true,
      selected: true,
      selectionReason: 'selected',
      executed: true,
      dispatchAttempted: true,
      processorInvoked: true,
      oracleVerdict: 'PASS',
      collectedEvidence: ['HTTP_RESPONSE'],
      missingEvidence: [],
      finalStatus: 'PASS',
      finalClassification: 'PASSED',
      statusReason: 'passed',
      dataBindings: [],
    } as unknown as TestPointCoverageLedgerItem;

    const summary = {
      totalPlanned: 1,
      totalSelected: 1,
      totalExecuted: 1,
      totalPassed: 1,
      totalConfirmedBugs: 0,
      totalTestBlocked: 0,
      totalUntested: 0,
      dataBindingStats: {
        providedAndConsumed: 0,
        providedButUnbound: 0,
        boundNotDispatched: 0,
        providedButInvalid: 0,
        providedButRejected: 0,
        missing: 0,
      },
      runLevelBlockers: [],
    } as unknown as CoverageLedgerSummary;

    const reconciliation: CoverageLedgerReconciliation = {
      status: 'MATCH',
      reconciled: true,
      legacyCount: { passed: 1, failed: 0, blocked: 0, notExecuted: 0, total: 1 },
      ledgerCount: { passed: 1, confirmedBugs: 0, testBlocked: 0, untested: 0, total: 1 },
      runIdMatch: true,
      selectedCasesMatch: true,
      caseIdCoverageMatch: true,
      mismatches: [],
    };

    const res1 = coverageLedgerToCanonicalRunResult({
      runId: 'RUN-DET',
      items: [dummyItem],
      summary,
      reconciliation,
      createdAt: '2026-09-14T00:00:00.000Z',
    });

    const res2 = coverageLedgerToCanonicalRunResult({
      runId: 'RUN-DET',
      items: [dummyItem],
      summary,
      reconciliation,
      createdAt: '2026-09-14T00:00:00.000Z',
    });

    expect(res1).toEqual(res2);
    expect(res1.coverage.total).toBe(1);
    expect(res1.coverage.passed).toBe(1);
    expect(res1.case_results[0].case_id).toBe('C-001');
  });
});
