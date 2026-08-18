// GitLab Issue Adapter（Phase 20.4）：
// 通过 GitLab REST API 创建 Issue / 搜索 Issue。
// 安全：createDraft 无副作用；createIssue 必须 Approved 且配置完整（projectKey + token）。
// 配置来自环境变量（ISSUE_TRACKER=gitlab / ISSUE_BASE_URL / ISSUE_TOKEN / ISSUE_PROJECT_KEY）。
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

/** GitLab Issue 适配器 */
export class GitLabIssueAdapter implements IssueTracker {
  name = 'gitlab';

  constructor(private readonly cfg: IssueTrackerConfig) {}

  private headers(): Record<string, string> {
    return {
      'PRIVATE-TOKEN': this.cfg.token ?? '',
      'Content-Type': 'application/json',
    };
  }

  private api(path: string): string {
    return `${this.cfg.baseUrl ?? 'https://gitlab.com/api/v4'}${path}`;
  }

  async createDraft(input: DefectDraft): Promise<IssueDraft> {
    return {
      draftId: input.id,
      tracker: this.name,
      title: input.title,
      body: buildIssueBody(input),
      metadata: { severity: input.severity, priority: input.priority, project: this.cfg.projectKey },
      createdAt: new Date().toISOString(),
      status: 'draft',
    };
  }

  async createIssue(approved: ApprovedDefect): Promise<Issue> {
    requireApproved(approved);
    requireTrackerConfig(this.cfg, ['projectKey', 'token']);
    const res = await fetch(this.api(`/projects/${encodeURIComponent(this.cfg.projectKey!)}/issues`), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        title: approved.draft.title,
        description: buildIssueBody(approved.draft),
        labels: approved.draft.severity,
      }),
    });
    const j = (await res.json()) as { iid?: number; web_url?: string; title?: string; state?: string; created_at?: string };
    if (!res.ok) {
      throw new Error(`GitLab 创建 Issue 失败（HTTP ${res.status}）：${JSON.stringify(j).slice(0, 300)}`);
    }
    return {
      key: String(j.iid ?? approved.draft.id),
      tracker: this.name,
      url: j.web_url,
      title: j.title ?? approved.draft.title,
      state: j.state ?? 'opened',
      createdAt: j.created_at ?? new Date().toISOString(),
      externalId: String(j.iid ?? ''),
    };
  }

  async searchIssues(query: string): Promise<Issue[]> {
    requireTrackerConfig(this.cfg, ['projectKey', 'token']);
    const res = await fetch(this.api(`/projects/${encodeURIComponent(this.cfg.projectKey!)}/issues?search=${encodeURIComponent(query)}`), {
      headers: this.headers(),
    });
    const arr = (await res.json()) as Array<{ iid: number; web_url?: string; title: string; state: string; created_at: string }>;
    if (!res.ok) throw new Error(`GitLab 搜索 Issue 失败（HTTP ${res.status}）`);
    return arr.map((i) => ({
      key: String(i.iid),
      tracker: this.name,
      url: i.web_url,
      title: i.title,
      state: i.state,
      createdAt: i.created_at,
      externalId: String(i.iid),
    }));
  }
}
