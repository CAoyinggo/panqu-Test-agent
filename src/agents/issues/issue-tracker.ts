// IssueTracker 工厂与服务（Phase 20.4）：
// 工厂按 tracker 创建适配器；服务层统一门禁：
//   1) 环境策略（production 一律拒绝创建正式 Issue）
//   2) ISSUE_CREATE_ENABLED=true 才允许创建（默认关闭）
//   3) 必须 Approval approved（requireApproved）
// 第一阶段只允许 createDraft；创建正式 Bug 需显式开启且经审批。
import type { DefectDraft } from '../defect/defect-schema.js';
import {
  requireApproved,
  type ApprovedDefect,
  type Issue,
  type IssueDraft,
  type IssueTracker,
  type IssueTrackerConfig,
} from './issue-types.js';
import { LocalIssueTracker } from './mock-issue-tracker.js';
import { GitHubIssueAdapter } from './github-adapter.js';
import { GitLabIssueAdapter } from './gitlab-adapter.js';
import { JiraIssueAdapter } from './jira-adapter.js';
import { FeishuIssueAdapter } from './feishu-adapter.js';

/** 环境风险策略（Phase 20.8 统一口径）：是否允许创建正式 Issue */
export function environmentAllowsCreate(environment: string): boolean {
  const e = environment.toLowerCase();
  // 生产环境默认 read-only，禁止创建正式缺陷
  if (e === 'production' || e === 'prod') return false;
  return true;
}

/** 按配置创建 IssueTracker */
export function createIssueTracker(config: IssueTrackerConfig): IssueTracker {
  switch (config.tracker) {
    case 'local':
      return new LocalIssueTracker();
    case 'github':
      return new GitHubIssueAdapter(config);
    case 'gitlab':
      return new GitLabIssueAdapter(config);
    case 'jira':
      return new JiraIssueAdapter(config);
    case 'feishu':
      return new FeishuIssueAdapter(config);
    default:
      throw new Error(`不支持的 IssueTracker：${(config as IssueTrackerConfig).tracker}`);
  }
}

/** 从环境变量创建 IssueTracker 配置（ISSUE_TRACKER 未配置时默认 local） */
export function loadIssueTrackerConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): IssueTrackerConfig {
  const tracker = (env.ISSUE_TRACKER ?? 'local').toLowerCase();
  return {
    tracker: (['github', 'gitlab', 'jira', 'feishu', 'local'].includes(tracker) ? tracker : 'local') as IssueTrackerConfig['tracker'],
    baseUrl: env.ISSUE_BASE_URL,
    token: env.ISSUE_TOKEN,
    projectKey: env.ISSUE_PROJECT_KEY,
    repo: env.ISSUE_REPO,
    username: env.ISSUE_USERNAME,
  };
}

/** Issue 创建总开关（默认关闭，必须显式 ISSUE_CREATE_ENABLED=true） */
export function issueCreateEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.ISSUE_CREATE_ENABLED ?? 'false').toLowerCase() === 'true';
}

/** 从环境变量创建门禁服务（ISSUE_TRACKER 未配置默认 local，ISSUE_CREATE_ENABLED 默认关闭） */
export function createIssueTrackerFromEnv(
  env: Record<string, string | undefined> = process.env,
): IssueTrackerService {
  const cfg = loadIssueTrackerConfigFromEnv(env);
  return new IssueTrackerService(createIssueTracker(cfg), {
    createEnabled: issueCreateEnabled(env),
  });
}

/** 门禁服务：包装任意 IssueTracker，统一施加审批 + 开关 + 环境策略 */
export class IssueTrackerService {
  constructor(
    private readonly tracker: IssueTracker,
    private readonly options: { createEnabled?: boolean } = {},
  ) {}

  get name(): string {
    return this.tracker.name;
  }

  get inner(): IssueTracker {
    return this.tracker;
  }

  /** 生成草稿：第一阶段唯一默认动作，无外部副作用 */
  async createDraft(draft: DefectDraft): Promise<IssueDraft> {
    return this.tracker.createDraft(draft);
  }

  /** 创建正式 Issue：必须 审批通过 + 开关开启 + 环境策略允许 */
  async createIssue(approved: ApprovedDefect): Promise<Issue> {
    requireApproved(approved);
    const env = approved.draft.environment.toLowerCase();
    if (!environmentAllowsCreate(env)) {
      throw new Error(`环境策略拒绝创建正式 Issue：${env} 环境默认 read-only（create-defect 需人工审批且环境策略放行）`);
    }
    if (!(this.options.createEnabled ?? issueCreateEnabled())) {
      throw new Error(`Issue 创建未启用：设置 ISSUE_CREATE_ENABLED=true 且通过 Approval 后才允许创建正式缺陷`);
    }
    return this.tracker.createIssue(approved);
  }

  /** 搜索 Issue（只读） */
  async searchIssues(query: string): Promise<Issue[]> {
    return this.tracker.searchIssues(query);
  }
}
