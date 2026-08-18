// Healing Loop：自愈闭环执行器（Phase 20.5）
// 完整闭环：发现失效 → 分析新响应 → 生成 Patch/Diff → 人工审批（Approval Policy）→
//          应用 Patch 到 Test DSL → 重新执行 → 验证测试恢复。
// 铁律：不经过审批绝不应用补丁；应用补丁只作用于测试用例副本（Test DSL），
// 绝不修改核心代码。错误码类修复风险为 high，须人工确认是预期业务调整还是回归缺陷。
import type { TestCase } from '../test-design/testcase-schema.js';
import type { CaseExecutionResult } from '../execution/execution-schema.js';
import { HealingAnalysis, HealingSuggestion } from './healing-schema.js';
import { evaluateApproval, ApprovalEvaluation } from '../approval/approval-policy.js';

/** 解析补丁文本为结构化变更（from → to） */
export function parseHealingPatch(patch: string): { from: string; to: string } | null {
  const fromM = patch.match(/^-\s*[\w.]+?\s*[:：]\s*['"]?([^'"\n]+)['"]?/m);
  const toM = patch.match(/^\+\s*[\w.]+?\s*[:：]\s*['"]?([^'"\n]+)['"]?/m);
  if (fromM && toM) return { from: fromM[1].trim(), to: toM[1].trim() };
  return null;
}

/** 应用自愈补丁到 Test DSL 用例（返回修改副本 + 实际 diff；不修改原对象） */
export function applyHealingPatch(suggestion: HealingSuggestion, testCase: TestCase): { def: TestCase; diff: string } {
  const def: TestCase = JSON.parse(JSON.stringify(testCase));
  const parsed = parseHealingPatch(suggestion.patch);
  const changes: string[] = [];

  if (suggestion.type === 'json-path' || suggestion.type === 'api-field') {
    const from = parsed?.from ?? suggestion.oldPath;
    const to = parsed?.to ?? suggestion.newPath;
    if (!to) return { def, diff: '补丁缺少目标值，未应用' };
    for (const a of def.assertions ?? []) {
      if (a.path && a.path === from) {
        a.path = to;
        changes.push(`assertion.path: '${from}' → '${to}'`);
      }
    }
  } else if (suggestion.type === 'error-code') {
    const from = parsed?.from ?? suggestion.oldPath;
    const to = parsed?.to ?? suggestion.newPath;
    if (!to) return { def, diff: '补丁缺少目标值，未应用' };
    for (const a of def.assertions ?? []) {
      if (String(a.expected) === from) {
        a.expected = to;
        changes.push(`assertion.expected: '${from}' → '${to}'`);
      }
    }
    // 期望汇总中的错误码同步更新（可选字段）
    if (def.expected?.fields && typeof def.expected.fields === 'object') {
      for (const [k, v] of Object.entries(def.expected.fields)) {
        if (String(v) === from) {
          def.expected.fields[k] = to;
          changes.push(`expected.fields.${k}: '${from}' → '${to}'`);
        }
      }
    }
  }

  return { def, diff: changes.length > 0 ? changes.join('\n') : suggestion.patch };
}

/** 审批结果（供闭环使用） */
export interface HealingApproval {
  required: boolean;
  decision: string;
  granted: boolean;
  reason: string;
}

/** 判定自愈修复审批（复用 Approval Policy；apply-healing 恒为变更类操作） */
export function evaluateHealingApproval(suggestion: HealingSuggestion, environment: string, humanApproval: 'approved' | 'rejected' | 'auto'): HealingApproval {
  const policy: ApprovalEvaluation = evaluateApproval({
    environment,
    severity: suggestion.risk === 'high' ? 'P0' : 'P2',
    operation: 'apply-healing',
  });
  if (policy.decision === 'DENY') {
    return { required: true, decision: policy.decision, granted: false, reason: policy.reason };
  }
  let granted = false;
  if (humanApproval === 'approved') {
    granted = true;
  } else if (humanApproval === 'auto' && policy.decision === 'AUTO') {
    granted = true;
  }
  return { required: true, decision: policy.decision, granted, reason: policy.reason };
}

/** 自愈闭环输入 */
export interface HealingLoopInput {
  feature: string;
  /** 目标测试用例（Test DSL，补丁应用对象） */
  testCase: TestCase;
  /** 失败执行结果 */
  failedResult: CaseExecutionResult;
  /** 自愈分析（由 SelfHealingAgent / analyzeHealing 产出） */
  analysis: HealingAnalysis;
  /** 重新执行器：接收应用补丁后的用例副本，返回执行结果 */
  runner: (def: TestCase) => Promise<CaseExecutionResult>;
  /** 环境（默认 test） */
  environment?: string;
  /** 人工审批结果（默认 rejected，即未获批准不应用） */
  humanApproval?: 'approved' | 'rejected' | 'auto';
}

/** 自愈闭环结果 */
export interface HealingLoopResult {
  feature: string;
  testCaseId: string;
  /** 是否检测到可自愈变更 */
  detected: boolean;
  suggestions: HealingSuggestion[];
  chosen?: HealingSuggestion;
  approval: HealingApproval;
  applied?: { def: TestCase; diff: string };
  reexecuted?: CaseExecutionResult;
  /** 补丁应用并重新执行后测试是否恢复 */
  recovered: boolean;
  summary: string;
}

/**
 * 运行自愈闭环。
 * 流程：检测（analysis 已含）→ 审批 → 应用 Patch → 重新执行 → 验证恢复。
 */
export async function runHealingLoop(input: HealingLoopInput): Promise<HealingLoopResult> {
  const { feature, testCase, analysis, environment = 'test', runner, humanApproval = 'rejected' } = input;

  if (analysis.suggestions.length === 0) {
    return {
      feature,
      testCaseId: testCase.id,
      detected: false,
      suggestions: [],
      approval: { required: false, decision: 'AUTO', granted: false, reason: '未检测到可自愈变更，不做修改' },
      recovered: false,
      summary: '未检测到可自愈的变更，测试保持原状（证据不足不做修改）',
    };
  }

  const suggestion = analysis.suggestions[0];
  const approval = evaluateHealingApproval(suggestion, environment, humanApproval);

  if (!approval.granted) {
    return {
      feature,
      testCaseId: testCase.id,
      detected: true,
      suggestions: analysis.suggestions,
      chosen: suggestion,
      approval,
      recovered: false,
      summary: `已生成自愈建议（${suggestion.type}：${suggestion.oldPath} → ${suggestion.newPath ?? '新值'}）但未获人工批准（${approval.decision}），测试保持失败，等待人工决定`,
    };
  }

  const applied = applyHealingPatch(suggestion, testCase);
  const reexecuted = await runner(applied.def);
  const recovered = reexecuted.pass;

  return {
    feature,
    testCaseId: testCase.id,
    detected: true,
    suggestions: analysis.suggestions,
    chosen: suggestion,
    approval,
    applied,
    reexecuted,
    recovered,
    summary: recovered
      ? `自愈闭环成功：${applied.diff.replace(/\n/g, '；')}，重新执行通过（recovered=true）`
      : `自愈补丁已应用但重新执行仍失败：${applied.diff.replace(/\n/g, '；')}`,
  };
}
