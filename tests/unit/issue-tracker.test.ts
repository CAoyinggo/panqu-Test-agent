// 单元测试：IssueTracker（Phase 20.4）
// 覆盖：草稿阶段无副作用、审批门禁（未批准禁止创建）、开关门禁（ISSUE_CREATE_ENABLED）、
// 生产环境 read-only、工厂创建各适配器、环境变量配置加载、正文生成、搜索。
import { describe, it, expect, beforeEach } from 'vitest';
import {
  LocalIssueTracker,
  IssueTrackerService,
  createIssueTracker,
  createIssueTrackerFromEnv,
  loadIssueTrackerConfigFromEnv,
  issueCreateEnabled,
  environmentAllowsCreate,
  buildIssueBody,
  requireApproved,
  type IssueTrackerConfig,
  type ApprovedDefect,
} from '../../src/agents/index.js';
import type { DefectDraft } from '../../src/agents/defect/defect-schema.js';
import type { ApprovalResult } from '../../src/agents/approval/approval-schema.js';

const draft: DefectDraft = {
  id: 'defect-001',
  feature: 'wan3',
  title: '视频生成后 URL 字段缺失',
  severity: 'P1',
  priority: 'HIGH',
  description: '返回数据中缺少 result.url',
  steps: ['提交 720P 任务', '查询详情'],
  expected: '返回 result.url',
  actual: 'data.result 为空',
  impact: '用户无法播放视频',
  environment: 'test',
  evidence: ['HTTP 200', 'data.result 缺失'],
  logs: [],
  relatedCases: ['WAN-001'],
  status: 'DRAFT',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const approved: ApprovalResult = { requestId: 'req-1', verdict: 'approved', decision: 'AUTO', at: '2026-01-01T00:00:00.000Z' };
const rejected: ApprovalResult = { requestId: 'req-2', verdict: 'rejected', decision: 'MANUAL', at: '2026-01-01T00:00:00.000Z' };

function makeApproved(approval: ApprovalResult = approved): ApprovedDefect {
  return { draft, approval, approvalRequestId: approval.requestId, approvedAt: approval.at };
}

describe('issue-tracker - 草稿阶段', () => {
  it('createDraft 无外部副作用，产出标准草稿', async () => {
    const tracker = new LocalIssueTracker();
    const d = await tracker.createDraft(draft);
    expect(d.status).toBe('draft');
    expect(d.tracker).toBe('local');
    expect(d.title).toBe(draft.title);
    expect(d.body).toContain('## 复现步骤');
    expect(tracker.listIssues().length).toBe(0); // 未创建正式 Issue
  });

  it('buildIssueBody 含证据 / 关联用例 / RCA', () => {
    const body = buildIssueBody({ ...draft, rca: { category: 'DATA_ERROR', rootCause: '响应结构变化', confidence: 0.9 } });
    expect(body).toContain('## 证据');
    expect(body).toContain('WAN-001');
    expect(body).toContain('DATA_ERROR');
  });
});

describe('issue-tracker - 审批门禁', () => {
  it('未批准（rejected/pending）禁止创建正式 Issue', async () => {
    const tracker = new LocalIssueTracker();
    const service = new IssueTrackerService(tracker, { createEnabled: true });
    await expect(service.createIssue(makeApproved(rejected))).rejects.toThrow('禁止创建正式 Issue');
    await expect(service.createIssue(makeApproved({ ...approved, verdict: 'pending' }))).rejects.toThrow('禁止创建正式 Issue');
    expect(tracker.listIssues().length).toBe(0);
  });

  it('requireApproved 直接拒绝未批准', () => {
    expect(() => requireApproved(makeApproved(rejected))).toThrow('禁止创建正式 Issue');
  });

  it('已批准 + 开关开启 → 创建成功', async () => {
    const tracker = new LocalIssueTracker();
    const service = new IssueTrackerService(tracker, { createEnabled: true });
    const issue = await service.createIssue(makeApproved());
    expect(issue.key).toMatch(/^LOCAL-/);
    expect(tracker.listIssues().length).toBe(1);
  });

  it('开关默认关闭 → 即使已批准也拒绝创建', async () => {
    const tracker = new LocalIssueTracker();
    const service = new IssueTrackerService(tracker); // createEnabled 默认 false
    await expect(service.createIssue(makeApproved())).rejects.toThrow('ISSUE_CREATE_ENABLED');
    expect(tracker.listIssues().length).toBe(0);
  });

  it('生产环境 read-only → 拒绝创建', async () => {
    const tracker = new LocalIssueTracker();
    const service = new IssueTrackerService(tracker, { createEnabled: true });
    const prodApproved = makeApproved();
    prodApproved.draft = { ...draft, environment: 'production' };
    await expect(service.createIssue(prodApproved)).rejects.toThrow(/read-only|环境策略/);
    expect(tracker.listIssues().length).toBe(0);
  });
});

describe('issue-tracker - 工厂与环境变量', () => {
  beforeEach(() => {
    for (const k of ['ISSUE_TRACKER', 'ISSUE_BASE_URL', 'ISSUE_TOKEN', 'ISSUE_PROJECT_KEY', 'ISSUE_REPO', 'ISSUE_CREATE_ENABLED']) delete process.env[k];
  });

  it('工厂创建各适配器', () => {
    const cfg: IssueTrackerConfig = { tracker: 'github', token: 'x', repo: 'a/b' };
    expect(createIssueTracker({ tracker: 'local' }).name).toBe('local');
    expect(createIssueTracker(cfg).name).toBe('github');
    expect(createIssueTracker({ tracker: 'gitlab', token: 'x', projectKey: 'p' }).name).toBe('gitlab');
    expect(createIssueTracker({ tracker: 'jira', token: 'x' }).name).toBe('jira');
    expect(createIssueTracker({ tracker: 'feishu', token: 'x' }).name).toBe('feishu');
    expect(() => createIssueTracker({ tracker: 'unknown' as never })).toThrow('不支持的 IssueTracker');
  });

  it('环境变量配置加载（未配置默认 local）', () => {
    expect(loadIssueTrackerConfigFromEnv().tracker).toBe('local');
    process.env.ISSUE_TRACKER = 'github';
    process.env.ISSUE_REPO = 'org/repo';
    process.env.ISSUE_TOKEN = 'ghp_x';
    const cfg = loadIssueTrackerConfigFromEnv();
    expect(cfg.tracker).toBe('github');
    expect(cfg.repo).toBe('org/repo');
    expect(cfg.token).toBe('ghp_x');
  });

  it('ISSUE_CREATE_ENABLED 默认关闭，显式开启生效', () => {
    expect(issueCreateEnabled()).toBe(false);
    process.env.ISSUE_CREATE_ENABLED = 'true';
    expect(issueCreateEnabled()).toBe(true);
  });

  it('createIssueTrackerFromEnv 返回包装服务的名称', () => {
    const svc = createIssueTrackerFromEnv();
    expect(svc.name).toBe('local');
  });

  it('环境策略：生产拒绝创建，test/preonline 允许', () => {
    expect(environmentAllowsCreate('production')).toBe(false);
    expect(environmentAllowsCreate('prod')).toBe(false);
    expect(environmentAllowsCreate('test')).toBe(true);
    expect(environmentAllowsCreate('preonline')).toBe(true);
  });

  it('适配器草稿不触发远端调用（无 Token 也可创建草稿）', async () => {
    const gh = createIssueTracker({ tracker: 'github' } as IssueTrackerConfig);
    const d = await gh.createDraft(draft);
    expect(d.tracker).toBe('github');
    // 未配置 token 时 createIssue 必须报配置缺失错误（而非静默）
    await expect(gh.createIssue(makeApproved())).rejects.toThrow('配置缺失');
  });
});
