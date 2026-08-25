/**
 * DevTest（需求驱动 · 开发者自助测试）共享类型。
 *
 * DevTest 是 acceptance 管线之上的开发者封装层：
 * 需求文档 → 五维用例 → SAFE 初步验证 → 统一问题清单 → 固定格式报告。
 * 本模块只定义跨文件的数据契约，不包含执行逻辑。
 */

import type { AcceptanceReport } from '../acceptance/acceptance-report.js';

/** 问题严重程度：critical / major / minor / trivial 四级。 */
export type DevTestProblemSeverity = 'critical' | 'major' | 'minor' | 'trivial';

/** 问题来源类别，决定报告中的分组与建议话术。 */
export type DevTestProblemCategory =
  | 'PRODUCT_DEFECT'
  | 'ASSERTION_FAILURE'
  | 'EXECUTION_BLOCKED'
  | 'DESIGN_ONLY_GAP'
  | 'REQUIREMENT_ISSUE'
  | 'CONTRACT_GATE'
  | 'SAFETY_GATE';

export interface DevTestProblem {
  id: string;
  severity: DevTestProblemSeverity;
  category: DevTestProblemCategory;
  /** 一句话问题标题；相同 title+category 会聚合 caseIds。 */
  title: string;
  /** 所属五维之一（API/FUNCTIONAL/UI/DATA_ISOLATION/PARAMETER_VALIDATION/...）。 */
  dimension?: string;
  /** 结构化原因码（如 SAFE_MODE_MUTATION_HOLD / UI_EXECUTOR_UNAVAILABLE）。 */
  reasonCode?: string;
  /** 关联用例 ID 列表。 */
  caseIds: string[];
  /** 复现步骤。 */
  reproduce: string[];
  /** 证据摘要（断言详情、响应状态等）。 */
  evidence: string[];
  /** 给开发者的下一步建议。 */
  suggestion?: string;
}

/** 单个维度的用例统计。 */
export interface DevTestDimensionStat {
  dimension: string;
  total: number;
  executable: number;
  passed: number;
  failed: number;
  blocked: number;
  notExecuted: number;
}

/** DevTest 运行结论（在 acceptance 语义之上面向开发者的简化归一）。 */
export type DevTestConclusion = 'PASS' | 'FAIL' | 'BLOCKED' | 'PARTIAL';

/** runDevTest 的输入选项。 */
export interface DevTestOptions {
  /** 需求文档内容（与 docPath / feishu 三选一，优先级 markdown > docPath > feishu）。 */
  markdown?: string;
  /** 本地需求文档路径。 */
  docPath?: string;
  /** 飞书 wiki/docx/doc 链接（需提供 credentials）。 */
  feishuUrl?: string;
  /** 飞书自建应用凭证；使用 --feishu 时必填。 */
  feishuCredentialsPath?: string;
  documentId?: string;
  project?: string;
  baseUrl: string;
  /** local / test / integration；prod 被安全策略禁止。 */
  environment: string;
  /** true 时写路径（POST/PUT/PATCH/DELETE）真实放行执行；默认 SAFE 挂起待确认。 */
  confirmMutations?: boolean;
  /** DRY_RUN：只生成资产不发起任何 HTTP 请求。 */
  dryRun?: boolean;
  /** 产物输出目录，默认 output/devtest/<runId>/。 */
  outDir?: string;
  maxCases?: number;
  signal?: AbortSignal;
  actorHeaders?: Record<string, Record<string, string>>;
  lifecyclePrepare?: () => Promise<void>;
  lifecycleCleanup?: () => Promise<void>;
}

/** DevTest 运行产物路径集合。 */
export interface DevTestArtifacts {
  dir: string;
  requirementMd: string;
  reportHtml: string;
  reportJson: string;
  casesCsv: string;
  problemsMd: string;
}

/** runDevTest 的返回结果。 */
export interface DevTestRunResult {
  runId: string;
  conclusion: DevTestConclusion;
  /** SAFE 模式下被挂起、等待确认的写路径用例 ID。 */
  pendingMutationCaseIds: string[];
  problems: DevTestProblem[];
  dimensionStats: DevTestDimensionStat[];
  artifacts: DevTestArtifacts;
  pipeline: {
    summary: AcceptanceReport['summary'];
    trust: AcceptanceReport['trust'];
    mode: 'execute' | 'dry-run';
  };
}
