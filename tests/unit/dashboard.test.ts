// 单元测试：Agent KPI Dashboard（Phase 20.8）
// 覆盖：buildAgentDashboard 指标聚合 / saveAgentDashboard 持久化到 output/<date>/agent-summary.json
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildAgentDashboard,
  saveAgentDashboard,
  loadLatestDashboard,
} from '../../src/qa/dashboard.js';
import type { AgentPipelineResult } from '../../src/agents/orchestration/agent-pipeline.js';
import type { Requirement } from '../../src/agents/requirement/requirement-schema.js';
import type { RiskAssessment } from '../../src/agents/risk/risk-schema.js';
import type { DataPlan } from '../../src/agents/data/data-schema.js';
import type { ExecutionOutcome } from '../../src/agents/execution/execution-schema.js';
import type { AnalysisReport } from '../../src/agents/analysis/analysis-schema.js';

/** 构造最小可用的 AgentPipelineResult */
function makeResult(over: Partial<AgentPipelineResult> = {}): AgentPipelineResult {
  const requirement: Requirement = {
    feature: 'wan3',
    confidence: 0.95,
    capabilities: ['提交任务', '状态查询'],
    inputs: ['prompt', 'resolution'],
    businessRules: ['积分扣减'],
    risks: ['concurrency'],
    requirements: [{ name: 'resolution', values: ['720P'] }],
    dependencies: ['积分服务'],
  };
  const outcome: ExecutionOutcome = {
    feature: 'wan3',
    total: 2,
    passed: 1,
    failed: 1,
    timedOut: 0,
    passRate: 50,
    results: [
      { caseId: 'tc-01', name: '通过', pass: true, passRate: 100 },
      { caseId: 'tc-02', name: '失败', pass: false, passRate: 0, error: '期望 4001，实际 4003' },
    ],
    reports: [],
    executed: true,
  };
  return {
    taskId: 't-dash',
    requirement,
    testCases: [
      { id: 'tc-01', feature: 'wan3', name: 'a', priority: 'P0', tags: [], steps: [], assertions: [{ target: 'response', path: 'a', operator: 'equals', expected: 'x', severity: 'P0' }] },
      { id: 'tc-02', feature: 'wan3', name: 'b', priority: 'P1', tags: [], steps: [], assertions: [] },
    ],
    risk: {} as RiskAssessment,
    dataPlan: {} as DataPlan,
    dataContext: {},
    outcome,
    report: {} as AnalysisReport,
    stages: {},
    durationMs: 1234,
    exitCode: 1,
    rcas: [{
      caseId: 'tc-02', category: 'ASSERTION', rootCause: 'x', confidence: 0.8,
      evidence: ['断言失败'], evidenceItems: [], facts: [], inferences: [], guesses: [],
      excludedCauses: [], recommendedAction: '按新响应结构修正断言',
    }],
    defects: [{
      id: 'd1', feature: 'wan3', severity: 'P1', title: 't', status: 'DRAFT', priority: 'HIGH',
      description: 'd', steps: ['s'], expected: 'e', actual: 'a', impact: 'i', environment: 'test',
      evidence: ['x'], logs: [], relatedCases: ['tc-02'], createdAt: '',
    }],
    healing: {
      feature: 'wan3', total: 1, summary: 's',
      suggestions: [{
        id: 'h1', caseId: 'tc-02', oldPath: 'error.code', newPath: '4003', type: 'error-code',
        risk: 'high', status: 'SUGGESTED', confidence: 0.9, reason: 'r', patch: 'p', evidence: [], createdAt: '',
      }],
    },
    approvals: [
      { id: 'apr-1', operation: 'create-defect', target: 't', environment: 'test', severity: 'P1', decision: 'REVIEW', reason: 'r', payload: {}, createdAt: '' },
    ],
    approvalResults: [{ requestId: 'apr-1', verdict: 'pending', decision: 'REVIEW', at: '' }],
    coverage: {
      feature: 'wan3',
      dimensions: [{ name: 'requirement', covered: 2, total: 2, rate: 100 }, { name: 'assertion', covered: 8, total: 10, rate: 80 }],
      coverage: { requirement: 100, assertion: 80 },
      gaps: [],
      recommendedCases: [],
    },
    budgetStatus: { agentCalls: 6, llmCalls: 8, toolCalls: 10, tokensUsed: 1200, durationMs: 1234, exceeded: [], exceededAny: false },
    ...over,
  };
}

describe('buildAgentDashboard KPI 聚合', () => {
  it('聚合需求 / 用例 / 执行 / 分析 / 可观测指标', () => {
    const d = buildAgentDashboard(makeResult(), { environment: 'test' });
    expect(d.feature).toBe('wan3');
    expect(d.requirement.capabilities).toBe(2);
    expect(d.requirement.businessRules).toBe(1);
    expect(d.testCases.total).toBe(2);
    expect(d.testCases.byPriority).toEqual({ P0: 1, P1: 1 });
    expect(d.testCases.assertions).toBe(1);
    expect(d.execution.passRate).toBe(50);
    expect(d.execution.executed).toBe(true);
    expect(d.analysis.rcas).toBe(1);
    expect(d.analysis.defects).toBe(1);
    expect(d.analysis.healingSuggestions).toBe(1);
    expect(d.analysis.approvals).toBe(1);
    expect(d.analysis.pending).toBe(1);
    expect(d.coverage.requirement).toBe(100);
    expect(d.observability.agentCalls).toBe(6);
    expect(d.observability.llmCalls).toBe(8);
    expect(d.observability.toolCalls).toBe(10);
    expect(d.observability.tokensUsed).toBe(1200);
    expect(d.observability.durationMs).toBe(1234);
    expect(d.summary).toContain('RCA 1');
  });

  it('未执行（skipExecution）时执行指标为零但可读', () => {
    const d = buildAgentDashboard(makeResult({ outcome: { feature: 'wan3', total: 0, passed: 0, failed: 0, timedOut: 0, passRate: 0, results: [], reports: [], executed: false } }));
    expect(d.execution.executed).toBe(false);
    expect(d.execution.passRate).toBe(0);
    expect(d.testCases.total).toBe(2);
  });
});

describe('saveAgentDashboard 持久化', () => {
  it('写入 output/<date>/agent-summary.json 且可回读', () => {
    const prev = process.env.TESTFLOW_OUTPUT_DIR;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-'));
    process.env.TESTFLOW_OUTPUT_DIR = tmp;
    try {
      const file = saveAgentDashboard(makeResult(), { environment: 'test' });
      expect(file).toContain('agent-summary.json');
      expect(fs.existsSync(file)).toBe(true);
      const loaded = loadLatestDashboard();
      expect(loaded).not.toBeNull();
      expect(loaded!.feature).toBe('wan3');
      expect(loaded!.taskId).toBe('t-dash');
    } finally {
      if (prev === undefined) delete process.env.TESTFLOW_OUTPUT_DIR;
      else process.env.TESTFLOW_OUTPUT_DIR = prev;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
