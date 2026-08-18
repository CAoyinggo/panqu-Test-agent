// Defect Agent：标准缺陷草稿生成（Phase 14）
// 流程：FAIL → RCA → Defect Agent → 标准缺陷草稿。
// 铁律：缺陷生成与缺陷提交分离 —— 本 Agent 只产出 Defect Draft（status=DRAFT），
// 绝不默认创建正式缺陷；提交动作必须经 Approval（Phase 16）。
import { BaseAgent } from '../core/agent.js';
import type { AgentContext } from '../core/agent-context.js';
import { parseLLMJson } from '../../llm/index.js';
import type { CaseExecutionResult, ExecutionOutcome } from '../execution/execution-schema.js';
import { RootCauseAnalysis } from '../analysis/root-cause-schema.js';
import {
  DefectDraft,
  DefectSeverity,
  DefectPriority,
  DEFECT_JSON_SCHEMA,
  isDefectLike,
  validateDefect,
  buildDefect,
} from './defect-schema.js';

/** 系统提示词：只允许生成草稿，禁止声称已提交 */
const SYSTEM_PROMPT = `你是资深缺陷分析师。基于失败用例与根因分析，生成标准缺陷草稿。
重要：你只生成缺陷草稿（DRAFT），不要声称已提交缺陷、不要填写提交单号。
输出严格符合如下 JSON Schema（只输出 JSON，不要 Markdown 围栏）：
${JSON.stringify(DEFECT_JSON_SCHEMA, null, 2)}

规则：
- title：一句话标题（如「文生视频 1080P+10秒 生成任务失败：模型服务 503」）
- severity：P0（阻塞/资金/安全）/ P1（严重）/ P2（一般）/ P3（轻微）
- priority：CRITICAL / HIGH / MEDIUM / LOW
- steps：可复现步骤（尽量引用用例场景）
- expected / actual：基于断言与响应摘要
- impact：影响范围（用户可见性/涉及模块）
- evidence：保留根因分析中的证据
- relatedCases：相关用例 ID
- 不要编造证据中不存在的信息`;

/** 缺陷输入 */
export interface DefectAgentInput {
  feature: string;
  environment: string;
  /** 失败用例 */
  failedCases: CaseExecutionResult[];
  /** 与 failedCases 按 caseId 对齐的 RCA 结果 */
  rcas: RootCauseAnalysis[];
  outcome?: ExecutionOutcome;
}

/** 严重度/优先级映射（确定性规则，任务书第 21 节 Deterministic First） */
const CATEGORY_SEVERITY: Record<string, { severity: DefectSeverity; priority: DefectPriority }> = {
  AUTH_ERROR: { severity: 'P1', priority: 'HIGH' },
  BILLING_ERROR: { severity: 'P1', priority: 'HIGH' },
  MODEL_ERROR: { severity: 'P1', priority: 'HIGH' },
  CONCURRENCY_ERROR: { severity: 'P2', priority: 'MEDIUM' },
  TIMEOUT: { severity: 'P2', priority: 'MEDIUM' },
  ASSERTION: { severity: 'P2', priority: 'MEDIUM' },
  DATA_ERROR: { severity: 'P2', priority: 'MEDIUM' },
  ENVIRONMENT_ERROR: { severity: 'P3', priority: 'LOW' },
  NETWORK_ERROR: { severity: 'P3', priority: 'LOW' },
  TEST_CODE_ERROR: { severity: 'P3', priority: 'LOW' },
};

/** 确定性缺陷草稿生成：基于失败用例 + RCA（不依赖 LLM） */
export function buildDefectFromRca(
  failed: CaseExecutionResult,
  rca: RootCauseAnalysis | undefined,
  feature: string,
  environment: string,
  seq: number,
): DefectDraft {
  const sev = rca ? CATEGORY_SEVERITY[rca.category] ?? { severity: 'P2' as DefectSeverity, priority: 'MEDIUM' as DefectPriority } : { severity: 'P2' as DefectSeverity, priority: 'MEDIUM' as DefectPriority };
  const failedChecks = (failed.checks ?? []).filter((c) => !c.pass);
  const evidence = [
    ...(rca?.facts ?? []),
    ...(rca?.rootCause ? [`根因：${rca.rootCause}`] : []),
    ...(failed.error ? [`错误：${failed.error}`] : []),
  ].filter(Boolean);
  const logs = failedChecks.map((c) => `[${c.name}] ${c.detail}`);
  const actual = failedChecks.find((c) => c.detail)?.detail ?? failed.error ?? '实际结果未知';
  const expected = failedChecks.find((c) => c.detail)?.name ? `断言「${failedChecks[0].name}」应通过` : '预期用例通过';

  return buildDefect({
    id: `defect-${String(seq).padStart(3, '0')}`,
    feature,
    title: `${rca ? `[${rca.category}] ` : ''}${failed.name}失败${rca?.rootCause ? `：${rca.rootCause}` : ''}`,
    severity: sev.severity,
    priority: sev.priority,
    description: `用例 ${failed.caseId} ${failed.name} 执行失败。${failed.error ?? '断言未通过'}。${rca?.rootCause ? `根因定位：${rca.rootCause}。` : ''}`,
    steps: [failed.scene ? `执行场景：${failed.scene}` : `执行用例：${failed.caseId}`, ...failedChecks.slice(0, 5).map((c) => `校验「${c.name}」`)],
    expected,
    actual,
    impact: `${feature} 模块${failed.timedOut ? '（超时）' : ''}${rca && rca.category === 'BILLING_ERROR' ? '，涉及积分/计费，用户可感知' : ''}`,
    environment,
    evidence,
    logs,
    responseSummary: failed.error,
    relatedCases: [failed.caseId],
    rca: rca ? { category: rca.category, rootCause: rca.rootCause, confidence: rca.confidence } : undefined,
    createdAt: new Date().toISOString(),
    source: 'rules',
  });
}

/** Defect Agent */
export class DefectAgent extends BaseAgent<DefectAgentInput, DefectDraft[]> {
  name = 'defect';
  version = '0.1.0';
  description = '基于失败与 RCA 生成标准缺陷草稿（仅 DRAFT，不提交）';

  async execute(input: DefectAgentInput, context: AgentContext): Promise<DefectDraft[]> {
    if (!input?.failedCases || input.failedCases.length === 0) {
      return [];
    }

    const rcaByCase = new Map((input.rcas ?? []).map((r) => [r.caseId, r]));

    // 1. LLM 优先：一次调用生成全部草稿（失败或空输出回退确定性）
    try {
      const drafts = await this.generateWithLLM(input, context);
      if (drafts.length === 0 && input.failedCases.length > 0) {
        // LLM 响应成功但未产出任何合法草稿 → 视为无效输出，回退确定性生成
        throw new Error('LLM 缺陷草稿为空（无合法缺陷对象），回退确定性生成');
      }
      context.logger.info(`缺陷草稿生成完成（LLM）：${drafts.length} 条`);
      return drafts;
    } catch (e) {
      context.logger.warn(`LLM 缺陷草稿失败，回退确定性生成：${(e as Error).message}`);
    }

    // 2. 确定性回退：逐条生成
    const drafts = input.failedCases.map((f, i) =>
      buildDefectFromRca(f, rcaByCase.get(f.caseId), input.feature, input.environment, i + 1),
    );
    context.logger.info(`缺陷草稿生成完成（规则）：${drafts.length} 条`);
    return drafts;
  }

  /** LLM 生成：只传失败用例 + RCA 摘要，返回缺陷草稿数组 */
  private async generateWithLLM(input: DefectAgentInput, context: AgentContext): Promise<DefectDraft[]> {
    const payload = input.failedCases.slice(0, 10).map((f) => {
      const rca = (input.rcas ?? []).find((r) => r.caseId === f.caseId);
      return {
        caseId: f.caseId,
        name: f.name,
        scene: f.scene,
        error: f.error,
        timedOut: f.timedOut,
        checks: (f.checks ?? []).filter((c) => !c.pass).slice(0, 5),
        rca: rca ? { category: rca.category, rootCause: rca.rootCause, confidence: rca.confidence } : undefined,
      };
    });

    const resp = await context.llm.generate({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `功能：${input.feature}，环境：${input.environment}
失败用例与根因：
${JSON.stringify(payload, null, 2)}

请为每个失败用例输出一条缺陷草稿对象。用 JSON 数组输出。`,
        },
      ],
      temperature: 0,
      jsonMode: true,
    });

    const parsed = parseLLMJson<unknown>(resp);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const rcaByCase = new Map((input.rcas ?? []).map((r) => [r.caseId, r]));
    return list
      .filter(isDefectLike)
      .map((d, i) => normalizeLlmDefect(d, i + 1, input, rcaByCase));
  }
}

/** 归一化 LLM 缺陷草稿：ID/feature/relatedCases/RCA 引用以确定性为准 */
function normalizeLlmDefect(
  raw: Record<string, unknown>,
  seq: number,
  input: DefectAgentInput,
  rcaByCase: Map<string, RootCauseAnalysis>,
): DefectDraft {
  const feature = String(raw.feature ?? input.feature);
  const draft = buildDefect({
    id: `defect-${String(seq).padStart(3, '0')}`,
    feature,
    title: String(raw.title ?? ''),
    severity: (['P0', 'P1', 'P2', 'P3'] as const).includes(raw.severity as DefectSeverity) ? raw.severity as DefectSeverity : 'P2',
    priority: (['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const).includes(raw.priority as DefectPriority) ? raw.priority as DefectPriority : 'MEDIUM',
    description: String(raw.description ?? ''),
    steps: Array.isArray(raw.steps) ? raw.steps.map(String) : [],
    expected: String(raw.expected ?? ''),
    actual: String(raw.actual ?? ''),
    impact: String(raw.impact ?? ''),
    environment: String(raw.environment ?? input.environment),
    evidence: Array.isArray(raw.evidence) ? raw.evidence.map(String) : [],
    logs: Array.isArray(raw.logs) ? raw.logs.map(String) : [],
    responseSummary: raw.responseSummary !== undefined ? String(raw.responseSummary) : undefined,
    relatedCases: Array.isArray(raw.relatedCases) ? raw.relatedCases.map(String) : [],
    createdAt: new Date().toISOString(),
    source: 'llm',
  });
  // 关联确定性 RCA（若失败用例存在）
  const failed = input.failedCases.find((f) => f.caseId === draft.relatedCases[0]);
  if (failed) {
    const rca = rcaByCase.get(failed.caseId);
    if (rca) draft.rca = { category: rca.category, rootCause: rca.rootCause, confidence: rca.confidence };
    if (!draft.relatedCases.includes(failed.caseId)) draft.relatedCases.push(failed.caseId);
  }
  return draft;
}

/** 便捷工厂 */
export function createDefectAgent(): DefectAgent {
  return new DefectAgent();
}

// 重导出便于外部消费
export { DefectDraft, DefectSeverity, DefectPriority, buildDefect } from './defect-schema.js';
export { DEFECT_JSON_SCHEMA, normalizeDefect } from './defect-schema.js';
