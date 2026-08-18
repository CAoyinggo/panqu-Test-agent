// IssueTracker 抽象（Phase 20.4）：统一缺陷外部系统接口。
// 铁律：缺陷生成与缺陷提交分离。第一阶段只允许 createDraft（本地草稿），
// 禁止默认创建正式 Bug。只有 Approval → Approved → IssueTracker.createIssue() 才能创建。
import type { DefectDraft } from '../defect/defect-schema.js';
import type { ApprovalResult } from '../approval/approval-schema.js';

/** 本地缺陷草稿（createDraft 产出，无外部副作用） */
export interface IssueDraft {
  /** 草稿 ID（沿用 DefectDraft.id） */
  draftId: string;
  /** 目标系统（github/gitlab/jira/feishu/local） */
  tracker: string;
  /** 远端 key（草稿阶段通常为空，仅本地模拟时有） */
  key?: string;
  title: string;
  body: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  status: 'draft';
}

/** 已批准缺陷（Approval approved 后才可调用 createIssue） */
export interface ApprovedDefect {
  draft: DefectDraft;
  /** 审批结论（verdict 必须为 approved） */
  approval: ApprovalResult;
  /** 对应审批请求 ID */
  approvalRequestId: string;
  approvedAt: string;
  /** 审批人（可选） */
  approver?: string;
}

/** 已创建的正式 Issue */
export interface Issue {
  key: string;
  tracker: string;
  url?: string;
  title: string;
  state: string;
  createdAt: string;
  externalId?: string;
}

/** IssueTracker 配置（全部来自环境变量，禁止硬编码 Token） */
export interface IssueTrackerConfig {
  tracker: 'github' | 'gitlab' | 'jira' | 'feishu' | 'local';
  baseUrl?: string;
  token?: string;
  /** Jira/飞书/GitLab 项目 Key 或 ID */
  projectKey?: string;
  /** GitHub 仓库（owner/repo） */
  repo?: string;
  /** Jira 邮箱（Basic Auth） */
  username?: string;
}

/** IssueTracker 统一接口 */
export interface IssueTracker {
  readonly name: string;
  createDraft(input: DefectDraft): Promise<IssueDraft>;
  createIssue(draft: ApprovedDefect): Promise<Issue>;
  searchIssues(query: string): Promise<Issue[]>;
}

/** 审批结论是否允许创建 */
export function isApprovedForCreate(approval: ApprovalResult): boolean {
  return approval.verdict === 'approved';
}

/** 创建前审批门禁：未获批准直接抛错 */
export function requireApproved(approved: ApprovedDefect): void {
  if (!isApprovedForCreate(approved.approval)) {
    throw new Error(
      `禁止创建正式 Issue：审批结论为「${approved.approval.verdict}」（operation=${approved.approval.decision}，request=${approved.approval.requestId}）`,
    );
  }
}

/** 配置门禁：缺少必要配置时明确报错 */
export function requireTrackerConfig(cfg: IssueTrackerConfig, required: Array<keyof IssueTrackerConfig>): void {
  for (const k of required) {
    if (!cfg[k]) {
      throw new Error(`IssueTracker 配置缺失：${String(k)}（请通过环境变量注入，禁止写入代码）`);
    }
  }
}

/** 从 DefectDraft 生成标准 Issue 正文（统一格式，供各适配器复用） */
export function buildIssueBody(draft: DefectDraft): string {
  const lines: string[] = [];
  lines.push(`## 严重程度 / 优先级`);
  lines.push(`${draft.severity} / ${draft.priority}`);
  lines.push('');
  lines.push(`## 问题描述`);
  lines.push(draft.description || '-');
  lines.push('');
  lines.push(`## 复现步骤`);
  (draft.steps.length ? draft.steps : ['-']).forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  lines.push('');
  lines.push(`## 预期结果`);
  lines.push(draft.expected || '-');
  lines.push('');
  lines.push(`## 实际结果`);
  lines.push(draft.actual || '-');
  lines.push('');
  lines.push(`## 影响范围`);
  lines.push(draft.impact || '-');
  lines.push('');
  lines.push(`## 环境`);
  lines.push(draft.environment);
  lines.push('');
  if (draft.evidence.length) {
    lines.push(`## 证据`);
    draft.evidence.forEach((e) => lines.push(`- ${e}`));
    lines.push('');
  }
  if (draft.relatedCases.length) {
    lines.push(`## 相关用例`);
    lines.push(draft.relatedCases.join(', '));
    lines.push('');
  }
  if (draft.rca) {
    lines.push(`## 关联 RCA`);
    lines.push(`- category: ${draft.rca.category}`);
    lines.push(`- rootCause: ${draft.rca.rootCause}`);
    lines.push(`- confidence: ${draft.rca.confidence}`);
  }
  return lines.join('\n');
}
