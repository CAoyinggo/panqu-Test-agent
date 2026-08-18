// Jira Issue Adapter（Phase 20.4）：
// 通过 Jira REST API（/rest/api/2/issue）创建 Bug / 搜索 Issue。
// 安全：createDraft 无副作用；createIssue 必须 Approved 且配置完整（projectKey + token + username）。
// 配置来自环境变量（ISSUE_TRACKER=jira / ISSUE_BASE_URL / ISSUE_TOKEN / ISSUE_PROJECT_KEY / ISSUE_USERNAME）。
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

/** Jira 严重度 → Jira 优先级名称 */
const JIRA_PRIORITY: Record<string, string> = {
  P0: 'Highest',
  P1: 'High',
  P2: 'Medium',
  P3: 'Low',
};

/** Jira Issue 适配器 */
export class JiraIssueAdapter implements IssueTracker {
  name = 'jira';

  constructor(private readonly cfg: IssueTrackerConfig) {}

  private headers(): Record<string, string> {
    const basic = Buffer.from(`${this.cfg.username ?? ''}:${this.cfg.token ?? ''}`).toString('base64');
    return {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/json',
    };
  }

  private api(path: string): string {
    return `${this.cfg.baseUrl ?? ''}${path}`;
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
    requireTrackerConfig(this.cfg, ['projectKey', 'token', 'baseUrl']);
    const res = await fetch(this.api('/rest/api/2/issue'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        fields: {
          project: { key: this.cfg.projectKey },
          summary: approved.draft.title,
          description: buildIssueBody(approved.draft),
          issuetype: { name: 'Bug' },
          priority: { name: JIRA_PRIORITY[approved.draft.severity] ?? 'Medium' },
          labels: [approved.draft.feature],
        },
      }),
    });
    const j = (await res.json()) as { key?: string; self?: string };
    if (!res.ok) {
      throw new Error(`Jira 创建 Issue 失败（HTTP ${res.status}）：${JSON.stringify(j).slice(0, 300)}`);
    }
    return {
      key: j.key ?? approved.draft.id,
      tracker: this.name,
      url: j.self,
      title: approved.draft.title,
      state: 'open',
      createdAt: new Date().toISOString(),
      externalId: j.key,
    };
  }

  async searchIssues(query: string): Promise<Issue[]> {
    requireTrackerConfig(this.cfg, ['token', 'baseUrl']);
    const jql = encodeURIComponent(`text ~ "${query}"`);
    const res = await fetch(this.api(`/rest/api/2/search?jql=${jql}`), { headers: this.headers() });
    const j = (await res.json()) as { issues?: Array<{ key: string; self?: string; fields?: { summary?: string; status?: { name?: string }; created?: string } }> };
    if (!res.ok) throw new Error(`Jira 搜索 Issue 失败（HTTP ${res.status}）`);
    return (j.issues ?? []).map((i) => ({
      key: i.key,
      tracker: this.name,
      url: i.self,
      title: i.fields?.summary ?? '',
      state: i.fields?.status?.name ?? 'open',
      createdAt: i.fields?.created ?? new Date().toISOString(),
      externalId: i.key,
    }));
  }
}
