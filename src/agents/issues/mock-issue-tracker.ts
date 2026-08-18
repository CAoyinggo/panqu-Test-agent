// 本地 IssueTracker（Phase 20.4，离线测试 / 草稿阶段默认实现）：
// 第一阶段只允许生成 Draft；createIssue 必须通过 Approval（approved）。
// 支持本地模拟创建（含审批门禁），用于集成测试与人工确认前的草稿沉淀。
import type { DefectDraft } from '../defect/defect-schema.js';
import {
  requireApproved,
  buildIssueBody,
  type ApprovedDefect,
  type Issue,
  type IssueDraft,
  type IssueTracker,
} from './issue-types.js';

/** 本地 IssueTracker（内存存储，可持久化） */
export class LocalIssueTracker implements IssueTracker {
  name = 'local';

  private drafts: IssueDraft[] = [];
  private issues: Issue[] = [];
  private seq = 0;

  /** 已创建的本地 Issue（供测试断言） */
  listIssues(): Issue[] {
    return [...this.issues];
  }

  async createDraft(input: DefectDraft): Promise<IssueDraft> {
    const draft: IssueDraft = {
      draftId: input.id,
      tracker: this.name,
      title: input.title,
      body: buildIssueBody(input),
      metadata: { severity: input.severity, priority: input.priority, feature: input.feature },
      createdAt: new Date().toISOString(),
      status: 'draft',
    };
    this.drafts.push(draft);
    return draft;
  }

  /** 创建正式 Issue：必须经 Approval approved，否则拒绝 */
  async createIssue(approved: ApprovedDefect): Promise<Issue> {
    requireApproved(approved);
    this.seq += 1;
    const issue: Issue = {
      key: `LOCAL-${this.seq}`,
      tracker: this.name,
      title: approved.draft.title,
      state: 'open',
      createdAt: new Date().toISOString(),
      externalId: `local-${this.seq}`,
    };
    this.issues.push(issue);
    return issue;
  }

  async searchIssues(query: string): Promise<Issue[]> {
    const q = query.toLowerCase();
    return this.issues.filter(
      (i) => i.title.toLowerCase().includes(q) || i.key.toLowerCase().includes(q),
    );
  }
}
