// Pipeline Scenarios：端到端自治流水线验收场景（Phase 23.5）
// 6 个最终验收场景：普通变更 / 高风险变更 / 探索发现问题 / 动态重规划 / Release REVIEW / Release BLOCK。
// 全部确定性、离线可复现；CLI 与 tests/e2e/autonomous-pipeline.test.ts 复用。

import type { PortfolioCaseInput } from '../portfolio/portfolio-schema.js';
import { runAutonomousPipeline, type AutonomousPipelineInput, type AutonomousPipelineResult } from './autonomous-pipeline.js';

/** 场景定义 */
export interface PipelineScenario {
  id: string;
  name: string;
  /** 构建流水线输入 */
  build: () => AutonomousPipelineInput;
  /** 期望标签（测试与 CLI 自检用） */
  expect: {
    releaseDecision: string;
    exitCode: number;
    minimumReplans?: number;
    minimumRca?: number;
    affectedCount?: number;
  };
}

/** 确定性生成 100 个候选用例 */
export function caseSet100(primaryTag: string, secondaryTag?: string): PortfolioCaseInput[] {
  const out: PortfolioCaseInput[] = [];
  for (let i = 1; i <= 100; i++) {
    const id = `tc-${String(i).padStart(3, '0')}`;
    const tags: string[] = [];
    if (i >= 61 && i <= 80) tags.push(primaryTag);
    if (secondaryTag && i >= 71 && i <= 75) tags.push(secondaryTag);
    let priority: PortfolioCaseInput['priority'] = 'P2';
    let riskScore = 0.1;
    if (i <= 30) {
      priority = 'P0';
      riskScore = 0.1;
    } else if (i <= 50) {
      priority = 'P1';
      riskScore = 0.5;
    } else if (i <= 60) {
      priority = 'P1';
      riskScore = 0.6;
    } else if (i <= 90) {
      priority = 'P2';
      riskScore = 0.3;
    } else {
      priority = 'P3';
      riskScore = 0.2;
    }
    out.push({
      caseId: id,
      priority,
      riskScore,
      changeTags: tags.length ? tags : undefined,
      historicalFailures: i >= 86 && i <= 90 ? 3 : undefined,
    });
  }
  return out;
}

/** 动态重规划场景：A(P0) B/C(P1, model) D(P2, model) E(P3) */
export function replanCases(): PortfolioCaseInput[] {
  return [
    { caseId: 'A', priority: 'P0', changeTags: ['core'], riskScore: 0.1 },
    { caseId: 'B', priority: 'P1', changeTags: ['model'], riskScore: 0.6 },
    { caseId: 'C', priority: 'P1', changeTags: ['model'], riskScore: 0.5 },
    { caseId: 'D', priority: 'P2', changeTags: ['model'], riskScore: 0.3 },
    { caseId: 'E', priority: 'P3', riskScore: 0.2 },
  ];
}

export const PIPELINE_SCENARIOS: PipelineScenario[] = [
  {
    id: 'code-change-pass',
    name: 'Scenario 1：普通变更 → Impact → Portfolio → Regression → PASS',
    build: () => ({
      change: { type: 'code', target: 'wan3/video-editor' },
      cases: caseSet100('video-editor'),
      feature: 'wan3/video-editor',
      environment: 'test',
      outcomes: {},
      signals: { coverage: 0.95 },
    }),
    expect: { releaseDecision: 'PASS', exitCode: 0 },
  },
  {
    id: 'model-change-risk',
    name: 'Scenario 2：高风险变更（模型）→ Impact → Risk ↑ → Priority ↑ → Regression',
    build: () => ({
      change: { type: 'model', target: 'wan3/text-to-video' },
      cases: caseSet100('model', 'text-to-video'),
      feature: 'wan3/text-to-video',
      environment: 'test',
      outcomes: {},
      signals: { coverage: 0.95 },
    }),
    expect: { releaseDecision: 'REVIEW', exitCode: 2, affectedCount: 20 },
  },
  {
    id: 'exploration-failure',
    name: 'Scenario 3：探索发现问题 → RCA → Knowledge → Regression',
    build: () => ({
      change: { type: 'code', target: 'wan3/video-editor' },
      cases: caseSet100('video-editor'),
      feature: 'wan3/video-editor',
      environment: 'test',
      outcomes: { 'explore-gap-wan3-export': false },
      failureReasons: { 'explore-gap-wan3-export': '导出耗时超过阈值，疑似回归' },
      exploration: {
        coverageGaps: ['wan3-export'],
        approveHighRisk: false,
        // 覆盖缺口探索候选按 P1 优先执行（默认 P3 位于队列末尾，会在自适应停止前被截断）
        priority: 'P1',
      },
      // 放宽自治预算：默认 maxDecisionDepth=20 仅允许执行 21 个用例，无法覆盖 P1 探索候选
      budget: {
        maxAutonomousCases: 200,
        maxAutonomousCost: 200,
        maxAutonomousDuration: 6000000,
        maxLLMCalls: 200,
        maxDecisionDepth: 200,
        maxConsecutiveReplans: 2,
      },
      signals: { coverage: 0.92 },
    }),
    expect: { releaseDecision: 'REVIEW', exitCode: 2, minimumRca: 1 },
  },
  {
    id: 'replan-block',
    name: 'Scenario 4：动态重规划 → RePlan → Priority Update → Stop Low Priority → BLOCK',
    build: () => ({
      change: { type: 'model', target: 'wan3/text-to-video' },
      cases: replanCases(),
      feature: 'wan3/text-to-video',
      environment: 'test',
      outcomes: { A: true, B: false, C: false, D: true, E: true },
      clusterFailureTrigger: 2,
      // 本场景聚焦重规划动力学：显式 Full Regression，A–E 全部进入计划
      fullRegression: true,
    }),
    expect: { releaseDecision: 'BLOCK', exitCode: 1, minimumReplans: 2, minimumRca: 2 },
  },
  {
    id: 'release-review',
    name: 'Scenario 5：Release REVIEW（P0 PASS / P1 99% / Coverage 93% / Flaky 2 / Known Issue 1）→ exit 2',
    build: () => ({
      change: { type: 'code', target: 'wan3/video-editor' },
      cases: caseSet100('video-editor'),
      feature: 'wan3/video-editor',
      environment: 'test',
      outcomes: {},
      signals: { coverage: 0.93, flakyCount: 2, knownIssues: 1 },
    }),
    expect: { releaseDecision: 'REVIEW', exitCode: 2 },
  },
  {
    id: 'release-block',
    name: 'Scenario 6：Release BLOCK（P0 Fail = 1）→ exit 1',
    build: () => ({
      change: { type: 'code', target: 'wan3/video-editor' },
      cases: [
        { caseId: 'crit-1', priority: 'P0', riskScore: 0.1 },
        { caseId: 'crit-2', priority: 'P1', riskScore: 0.5 },
      ],
      feature: 'wan3/video-editor',
      environment: 'test',
      outcomes: { 'crit-1': false, 'crit-2': true },
    }),
    expect: { releaseDecision: 'BLOCK', exitCode: 1, minimumRca: 1 },
  },
];

/** 运行指定场景并返回结果 */
export function runPipelineScenario(scenario: PipelineScenario): AutonomousPipelineResult {
  return runAutonomousPipeline(scenario.build());
}

/** 按 id 查找场景 */
export function findPipelineScenario(id: string): PipelineScenario | undefined {
  return PIPELINE_SCENARIOS.find((s) => s.id === id);
}
