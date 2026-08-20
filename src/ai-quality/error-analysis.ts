// Error Analysis（Phase 46 / 43.4）：评测失败后的自动错误分析
// 从 Feedback Registry（或评测失败结果）自动聚类错误：
//   为什么失败？属于哪类错误？集中在哪个项目/模型/Prompt/Tool/环境？
// 输出 ErrorCluster（domain + category + count + cases + suspectedCause + evidence）。
import { randomBytes } from 'node:crypto';
import type { AIFeedback, ErrorCluster, ErrorTaxonomy } from './contract.js';
import { ERROR_TAXONOMY_LABELS } from './contract.js';
import { deriveErrorTaxonomy } from './feedback.js';
import type { EvaluationResult } from '../eval/contract.js';

export interface ErrorAnalysisSource {
  feedback?: AIFeedback[];
  /** 评测失败结果（Phase 45 runner 输出的 tracked 失败用例） */
  evalFailures?: Array<{ result: EvaluationResult; benchmark?: string }>;
}

export interface ErrorAnalysisOptions {
  now?: () => string;
}

/** 确定性 cluster id（保留用于兼容） */
export function newId(): string {
  return `ec-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

/** 从反馈/评测失败推导错误分类（与 FeedbackRegistry.classifyAll 复用同一套确定性规则） */
export function classifyFeedback(fb: AIFeedback): ErrorTaxonomy | null {
  return deriveErrorTaxonomy(fb);
}

/**
 * 自动错误分析：聚合为 ErrorCluster。
 * 聚类键 = domain + taxonomy；count 统计；cases 记录关联 caseId（无 caseId 时用反馈 id）；
 * evidence 存原始快照（feedback 或 eval result）；suspectedCause 按分类给确定性启发。
 */
export function analyzeErrors(src: ErrorAnalysisSource, opts: ErrorAnalysisOptions = {}): ErrorCluster[] {
  const now = opts.now?.() ?? new Date().toISOString();
  const clusterMap = new Map<string, ErrorCluster>();

  const keyOf = (domain: string, category: ErrorTaxonomy): string => `${domain}|${category}`;

  const ensure = (domain: string, category: ErrorTaxonomy): ErrorCluster => {
    const k = keyOf(domain, category);
    let c = clusterMap.get(k);
    if (!c) {
      c = {
        // 确定性 id：同一 domain+category 永远生成同一 cluster，保证提案幂等去重
        id: `ec-${domain.toLowerCase()}-${category.toLowerCase()}`,
        domain: domain as ErrorCluster['domain'],
        category,
        count: 0,
        cases: [],
        suspectedCause: suspectedCause(category),
        evidence: [],
        createdAt: now,
        lastSeenAt: now,
      };
      clusterMap.set(k, c);
    }
    return c;
  };

  for (const fb of src.feedback ?? []) {
    const taxonomy = deriveErrorTaxonomy(fb);
    if (!taxonomy) continue;
    const c = ensure(fb.domain, taxonomy);
    c.count += 1;
    const ref = fb.caseId ?? fb.id; // 无 caseId 时用反馈 id 作为用例标识
    if (!c.cases.includes(ref)) c.cases.push(ref);
    c.evidence.push({ kind: 'feedback', id: fb.id, createdAt: fb.createdAt, note: fb.note });
    if (fb.createdAt > c.lastSeenAt) c.lastSeenAt = fb.createdAt;
  }

  for (const { result, benchmark } of src.evalFailures ?? []) {
    if (!result || result.tracked === false || result.passed) continue;
    const taxonomy = classifyEvalResult(result);
    if (!taxonomy) continue;
    const c = ensure(result.domain, taxonomy);
    c.count += 1;
    if (!c.cases.includes(result.caseId)) c.cases.push(result.caseId);
    c.evidence.push({ kind: 'eval', caseId: result.caseId, errors: result.errors, benchmark });
    c.lastSeenAt = now;
  }

  return [...clusterMap.values()].sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));
}

/** 从评测失败结果推导错误分类（确定性） */
export function classifyEvalResult(r: EvaluationResult): ErrorTaxonomy | null {
  if (!r.tracked || r.passed) return null;
  const errText = (r.errors ?? []).join(' ');
  // 安全类
  if (errText.includes('DANGEROUS') || errText.includes('Unsafe Healing') || errText.includes('掩盖')) return 'UNSAFE';
  if (errText.includes('重复')) return 'DUPLICATE';
  if (errText.includes('Critical Miss') || errText.includes('漏判') || errText.includes('漏选')) return 'UNDER_PREDICTION';
  if (errText.includes('过度') || errText.includes('False Block')) return 'OVER_PREDICTION';
  if (errText.includes('缺失') || errText.includes('缺')) return 'MISSING';
  return 'WRONG';
}

/** 确定性疑似根因启发 */
export function suspectedCause(category: ErrorTaxonomy): string | undefined {
  switch (category) {
    case 'UNDER_PREDICTION':
      return '低估或漏判：规则/模型对严重度、临界用例、关键风险的敏感度不足';
    case 'OVER_PREDICTION':
      return '过度预测：判定过于保守，产生误报（如虚高风险 / 过度 BLOCK）';
    case 'UNSAFE':
      return '不安全行为：自愈/决策可能掩盖真实 Bug 或产生副作用';
    case 'DUPLICATE':
      return '重复产出：去重逻辑缺失或相似度判定过松';
    case 'MISSING':
      return '缺失输出：字段/断言/根因覆盖不全';
    case 'WRONG':
      return '错误输出：预测与真值不符，多为规则边界或上下文覆盖不足';
    case 'INCONSISTENT':
      return '自相矛盾：部分命中但存在冲突字段';
    case 'LOW_VALUE':
      return '低价值输出：产出存在但对决策贡献有限';
    default:
      return undefined;
  }
}

/** 人类可读摘要（用于 Web / CLI） */
export function formatErrorCluster(c: ErrorCluster): string {
  return `[${c.domain}] ${ERROR_TAXONOMY_LABELS[c.category]} ×${c.count}（${c.cases.slice(0, 3).join(', ') || '无 caseId'}）${c.suspectedCause ? `｜ ${c.suspectedCause}` : ''}`;
}
