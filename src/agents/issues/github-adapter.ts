// GitHub Issue Adapter（Phase 20.4）：
// 通过 GitHub REST API 创建 Issue / 搜索 Issue。
// 安全：createDraft 无副作用；createIssue 必须 Approved 且配置完整（repo + token）。
// 配置全部来自环境变量（ISSUE_TRACKER=github / ISSUE_BASE_URL / ISSUE_TOKEN / ISSUE_REPO）。
import type { DefectDraft } from '../defect/defect-schema.js';
import {
  requireApproved,
  requireTrackerConfig,
  buildIssueBody,
  type ApprovedDefect,
  type Issue,
  type IssueDraft,
  type IssueTracker,
  type IssueTrackerConfig,
} from './issue-types.js';

/** GitHub Issue 适配器 */
export class GitHubIssueAdapter implements IssueTracker {
  name = 'github';

  constructor(private readonly cfg: IssueTrackerConfig) {}

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.cfg.token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  private api(path: string): string {
    return `${this.cfg.baseUrl ?? 'https://api.github.com'}${path}`;
  }

  async createDraft(input: DefectDraft): Promise<IssueDraft> {
    return {
      draftId: input.id,
      tracker: this.name,
      title: input.title,
      body: buildIssueBody(input),
      metadata: { severity: input.severity, priority: input.priority, repo: this.cfg.repo },
      createdAt: new Date().toISOString(),
      status: 'draft',
    };
  }

  async createIssue(approved: ApprovedDefect): Promise<Issue> {
    requireApproved(approved);
    requireTrackerConfig(this.cfg, ['repo', 'token']);
    const res = await fetch(this.api(`/repos/${this.cfg.repo}/issues`), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        title: approved.draft.title,
        body: buildIssueBody(approved.draft),
        labels: [approved.draft.severity],
      }),
    });
    const j = (await res.json()) as { number?: number; html_url?: string; title?: string; state?: string; created_at?: string };
    if (!res.ok) {
      throw new Error(`GitHub 创建 Issue 失败（HTTP ${res.status}）：${JSON.stringify(j).slice(0, 300)}`);
    }
    return {
      key: String(j.number ?? approved.draft.id),
      tracker: this.name,
      url: j.html_url,
      title: j.title ?? approved.draft.title,
      state: j.state ?? 'open',
      createdAt: j.created_at ?? new Date().toISOString(),
      externalId: String(j.number ?? ''),
    };
  }

  async searchIssues(query: string): Promise<Issue[]> {
    requireTrackerConfig(this.cfg, ['token']);
    const res = await fetch(this.api(`/search/issues?q=${encodeURIComponent(query)}`), {
      headers: this.headers(),
    });
    const j = (await res.json()) as { items?: Array<{ number: number; html_url?: string; title: string; state: string; created_at: string }> };
    if (!res.ok) throw new Error(`GitHub 搜索 Issue 失败（HTTP ${res.status}）`);
    return (j.items ?? []).map((i) => ({
      key: String(i.number),
      tracker: this.name,
      url: i.html_url,
      title: i.title,
      state: i.state,
      createdAt: i.created_at,
      externalId: String(i.number),
    }));
  }
}
