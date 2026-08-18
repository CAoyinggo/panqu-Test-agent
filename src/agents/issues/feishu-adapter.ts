// 飞书项目 Issue Adapter（Phase 20.4）：
// 通过飞书开放平台创建任务（/open-apis/task/v2/tasks）与搜索任务。
// 安全：createDraft 无副作用；createIssue 必须 Approved 且配置完整（token）。
// 配置来自环境变量（ISSUE_TRACKER=feishu / ISSUE_BASE_URL=https://open.feishu.cn / ISSUE_TOKEN）。
// 注意：需飞书租户管理员授权，未授权时 createIssue 会返回明确错误。
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

/** 飞书任务适配器 */
export class FeishuIssueAdapter implements IssueTracker {
  name = 'feishu';

  constructor(private readonly cfg: IssueTrackerConfig) {}

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.cfg.token ?? ''}`,
      'Content-Type': 'application/json',
    };
  }

  private api(path: string): string {
    return `${this.cfg.baseUrl ?? 'https://open.feishu.cn'}${path}`;
  }

  async createDraft(input: DefectDraft): Promise<IssueDraft> {
    return {
      draftId: input.id,
      tracker: this.name,
      title: input.title,
      body: buildIssueBody(input),
      metadata: { severity: input.severity, priority: input.priority },
      createdAt: new Date().toISOString(),
      status: 'draft',
    };
  }

  async createIssue(approved: ApprovedDefect): Promise<Issue> {
    requireApproved(approved);
    requireTrackerConfig(this.cfg, ['token']);
    const res = await fetch(this.api('/open-apis/task/v2/tasks'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        data: {
          summary: approved.draft.title,
          description: buildIssueBody(approved.draft),
          due: { timestamp: String(Math.floor(Date.now() / 1000) + 3 * 24 * 3600) },
        },
      }),
    });
    const j = (await res.json()) as { code?: number; msg?: string; data?: { task?: { task_guid?: string; url?: string } } };
    if (!res.ok || (j.code !== undefined && j.code !== 0)) {
      throw new Error(`飞书创建任务失败（code=${j.code ?? res.status}）：${j.msg ?? ''}`);
    }
    return {
      key: j.data?.task?.task_guid ?? approved.draft.id,
      tracker: this.name,
      url: j.data?.task?.url,
      title: approved.draft.title,
      state: 'open',
      createdAt: new Date().toISOString(),
      externalId: j.data?.task?.task_guid,
    };
  }

  async searchIssues(query: string): Promise<Issue[]> {
    requireTrackerConfig(this.cfg, ['token']);
    const res = await fetch(this.api(`/open-apis/task/v2/tasks?page_size=20`), { headers: this.headers() });
    const j = (await res.json()) as { code?: number; data?: { items?: Array<{ task_guid?: string; url?: string; summary?: string; completed_at?: string }> } };
    if (!res.ok || (j.code !== undefined && j.code !== 0)) throw new Error(`飞书搜索任务失败（code=${j.code ?? res.status}）`);
    const q = query.toLowerCase();
    return (j.data?.items ?? [])
      .filter((i) => (i.summary ?? '').toLowerCase().includes(q))
      .map((i) => ({
        key: i.task_guid ?? '',
        tracker: this.name,
        url: i.url,
        title: i.summary ?? '',
        state: i.completed_at ? 'completed' : 'open',
        createdAt: new Date().toISOString(),
        externalId: i.task_guid,
      }));
  }
}
