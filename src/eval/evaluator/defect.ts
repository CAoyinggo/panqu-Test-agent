// Defect Evaluator（Phase 45 / 42.8）：缺陷质量评估
// 全链路：classifyFailure（分类）→ buildDefectFromRca（缺陷草稿）→ 重复检测。
// 指标：Correct Category / Correct Severity / Correct Priority / Duplicate Rate /
// 完整性（可复现步骤 / 证据 / 关联用例）。
import { classifyFailure, type ClassifierInput } from '../../agents/analysis/failure-classifier.js';
import { buildRootCause } from '../../agents/analysis/root-cause-schema.js';
import { buildDefectFromRca } from '../../agents/defect/defect-agent.js';
import type { DefectGroundTruth } from '../benchmark/data/defect.js';
import { isPassed, roundScore } from '../score.js';
import { exactMatch } from '../metrics.js';
import type { EvaluationCase, EvaluationResult } from '../contract.js';

/** 确定性根因 Key：错误 → 规范化短签名（供重复缺陷检测） */
export function rootCauseKey(input: ClassifierInput): string {
  const err = input.error ?? '';
  const detail = (input.checks ?? []).map((c) => c.detail).join(' ');
  const blob = `${err} ${detail}`;
  if (/bad gateway|502/i.test(blob)) return 'bad gateway';
  if (/503|service unavailable/i.test(blob)) return 'service unavailable';
  if (/401/.test(blob)) return '401';
  if (/403/.test(blob)) return '403';
  if (/insufficient balance|余额不足/i.test(blob)) return 'insufficient balance';
  if (/404/.test(blob)) return '404';
  if (/billing|扣费|积分/i.test(blob)) return 'billing';
  // 兜底：取首段可辨识文本
  const m = err.match(/[a-zA-Z\u4e00-\u9fa5]{4,20}/);
  return m ? m[0].toLowerCase() : 'unknown';
}

/** 完整度评分：步骤/证据/关联用例是否齐备 */
function completenessScore(defect: { steps?: string[]; evidence?: string[]; relatedCases?: string[] }): number {
  let ok = 0;
  if ((defect.steps?.length ?? 0) >= 2) ok++;
  if ((defect.evidence?.length ?? 0) >= 1) ok++;
  if ((defect.relatedCases?.length ?? 0) >= 1) ok++;
  return ok / 3;
}

export function evaluateDefect(c: EvaluationCase<ClassifierInput & { existingDefects?: string[] }, DefectGroundTruth>): EvaluationResult {
  const errors: string[] = [];
  let category = 'UNKNOWN';
  let severity = 'P2';
  let priority = 'MEDIUM';
  let duplicate = false;
  let steps: string[] = [];
  let evidence: string[] = [];
  try {
    const classified = classifyFailure(c.input);
    category = classified.category;
    const rca = buildRootCause({
      caseId: c.input.caseId,
      name: c.input.name,
      category: classified.category,
      rootCause: classified.reasons[0] ?? '根因待确认',
      evidence: classified.reasons,
      evidenceItems: classified.reasons.map((r) => ({ type: 'rules', detail: r, certainty: 'fact' as const })),
      facts: classified.reasons,
      recommendedAction: '按缺陷流程登记并修复',
      confidence: classified.confidence,
    });
    const defect = buildDefectFromRca(
      {
        caseId: c.input.caseId,
        name: c.input.name ?? '',
        scene: undefined,
        pass: false,
        passRate: 0,
        error: c.input.error ?? '',
        timedOut: c.input.timedOut,
        checks: c.input.checks,
      },
      rca,
      'wan3',
      'test',
      1,
    );
    severity = defect.severity;
    priority = defect.priority;
    steps = defect.steps ?? [];
    evidence = defect.evidence ?? [];
    // 重复检测：existingDefects 中含 `<category>:<key>` → 重复
    const existing = c.input.existingDefects ?? [];
    const sig = `${category}:${rootCauseKey(c.input)}`;
    duplicate = existing.some((d) => d.toLowerCase() === sig.toLowerCase());
  } catch (e) {
    errors.push(`缺陷生成失败：${(e as Error).message}`);
  }

  const gt = c.groundTruth;
  const categoryOk = exactMatch(category, gt.expectedCategory);
  const severityOk = exactMatch(severity, gt.expectedSeverity);
  const priorityOk = exactMatch(priority, gt.expectedPriority);
  const duplicateOk = duplicate === gt.expectedDuplicate ? 1 : 0;
  const completeness = completenessScore({ steps, evidence, relatedCases: [c.input.caseId] });
  const score = roundScore(0.35 * categoryOk + 0.15 * severityOk + 0.15 * priorityOk + 0.2 * duplicateOk + 0.15 * completeness);

  if (categoryOk < 1) errors.push(`缺陷分类错误：期望 ${gt.expectedCategory}，实际 ${category}`);
  if (severityOk < 1) errors.push(`严重度错误：期望 ${gt.expectedSeverity}，实际 ${severity}`);
  if (priorityOk < 1) errors.push(`优先级错误：期望 ${gt.expectedPriority}，实际 ${priority}`);
  if (duplicateOk < 1) {
    errors.push(duplicate
      ? `重复创建：该失败命中既有已知问题签名 ${category}:${rootCauseKey(c.input)}，不应新建 Bug`
      : `漏检重复：应识别为既有已知问题 ${category}:${rootCauseKey(c.input)} 的重复`);
  }

  return {
    caseId: c.id,
    domain: 'DEFECT',
    score,
    passed: isPassed(score),
    tracked: true,
    expected: gt,
    actual: { category, severity, priority, duplicate, steps, evidence },
    errors,
    evidence: [
      `Category=${category}（期望 ${gt.expectedCategory}）`,
      `Severity=${severity} / Priority=${priority}`,
      `重复检测=${duplicate}（期望 ${gt.expectedDuplicate}）`,
      `完整度=${completeness.toFixed(2)}（步骤 ${steps.length} / 证据 ${evidence.length}）`,
    ],
  };
}
