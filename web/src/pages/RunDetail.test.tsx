// Phase 43.1/43.2：RunDetail 回归测试
// 覆盖：评论提交携带正确契约 { body }（此前发 { text } → 200 但正文恒为空）；
//      RUNNING 状态显示 Cancel Run 按钮。
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import RunDetail from './RunDetail';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const DETAIL = {
  run: {
    runId: 'run-1', status: 'RUNNING', projectId: 'wan3', environment: 'test',
    trigger: 'manual', createdAt: '2026-08-20T00:00:00Z',
  },
  approvals: [],
  trace: null,
  checkpoint: null,
};

const REPORT = {
  runId: 'run-1', projectId: 'wan3', environment: 'test', trigger: 'manual',
  status: 'RUNNING', progress: 50, createdAt: '2026-08-20T00:00:00Z',
  releaseDecision: null, coverage: { total: 10, completed: 5, failed: 0, remaining: 5 },
  failures: [], rca: [], cost: { value: null, tracked: false, unit: 'CNY' },
  approvals: [], risk: 'low', decisionTrace: null,
};

/** 按 URL 路由的 fetch mock：detail/report/comments 每次轮询都返回同一份 */
function routingFetch(calls: Array<{ method: string; url: string; body?: unknown }>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = String(init?.method ?? 'GET');
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    if (url.endsWith('/api/runs/run-1/detail')) return jsonResponse(200, DETAIL);
    if (url.endsWith('/api/runs/run-1/report')) return jsonResponse(200, REPORT);
    if (url.endsWith('/api/runs/run-1/comments') && method === 'GET') return jsonResponse(200, []);
    if (url.endsWith('/api/runs/run-1/comments') && method === 'POST') return jsonResponse(200, { mentions: [] });
    if (url.endsWith('/rerun')) return jsonResponse(200, { runId: 'run-again', status: 'QUEUED' });
    if (url.endsWith('/clone')) return jsonResponse(200, { runId: 'run-clone', status: 'QUEUED' });
    if (url.endsWith('/template')) return jsonResponse(200, { id: 'tpl-1', name: 'wan3 模板' });
    if (url.endsWith('/share')) return jsonResponse(200, { token: 'tok-1', url: 'http://x/runs/run-1/report?share=tok-1' });
    if (url.endsWith('/cancel')) return jsonResponse(200, { runId: 'run-1', status: 'CANCELLED' });
    if (url.endsWith('/assign')) return jsonResponse(200, { runId: 'run-1', status: 'RUNNING', assignees: ['zhangsan'] });
    return jsonResponse(404, {});
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/runs/run-1']}>
      <Routes>
        <Route path="/runs/:id" element={<RunDetail />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('RunDetail（43.1 评论契约 / 43.2 Cancel）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('评论提交携带 { body } 契约（不再发 { text } → 正文为空）', async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    vi.stubGlobal('fetch', routingFetch(calls));
    renderPage();
    await waitFor(() => expect(screen.getByText('Run ID')).toBeInTheDocument());
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('评论内容（@用户名 可通知）'), '请确认模型服务');
    await user.click(screen.getByRole('button', { name: '评论' }));
    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/comments'));
      expect(post?.body).toEqual({ body: '请确认模型服务' });
    });
  });

  it('RUNNING 状态显示 Cancel Run 按钮（QUEUED/RUNNING 可取消）', async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    vi.stubGlobal('fetch', routingFetch(calls));
    renderPage();
    await waitFor(() => expect(screen.getByText('Run ID')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Cancel Run' })).toBeInTheDocument();
  });

  it('点击 Cancel Run → POST /cancel 并显示成功 banner', async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    vi.stubGlobal('fetch', routingFetch(calls));
    renderPage();
    await waitFor(() => expect(screen.getByText('Run ID')).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Cancel Run' }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/cancel'))).toBe(true);
      expect(screen.getByText(/已取消 Run/)).toBeInTheDocument();
    });
  });

  it('点击 Run Again → POST /rerun 并显示成功 banner', async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    vi.stubGlobal('fetch', routingFetch(calls));
    renderPage();
    await waitFor(() => expect(screen.getByText('Run ID')).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Run Again' }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/rerun'))).toBe(true);
      expect(screen.getByText(/Run Again → run-again/)).toBeInTheDocument();
    });
  });

  it('指派 Assign → POST /assign 携带 assignees', async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    vi.stubGlobal('fetch', routingFetch(calls));
    renderPage();
    await waitFor(() => expect(screen.getByText('Run ID')).toBeInTheDocument());
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('指派给（逗号分隔用户名）'), 'zhangsan');
    await user.click(screen.getByRole('button', { name: '指派 Assign' }));
    await waitFor(() => {
      const assign = calls.find((c) => c.method === 'POST' && c.url.endsWith('/assign'));
      expect(assign?.body).toEqual({ assignees: ['zhangsan'] });
      expect(screen.getByText(/已指派给 zhangsan/)).toBeInTheDocument();
    });
  });

  it('点击 Share Report → 展示分享链接', async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    vi.stubGlobal('fetch', routingFetch(calls));
    renderPage();
    await waitFor(() => expect(screen.getByText('Run ID')).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Share Report' }));
    await waitFor(() => expect(screen.getByText(/已生成分享链接/)).toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'http://x/runs/run-1/report?share=tok-1' })).toBeInTheDocument();
  });

  it('点击 Clone Configuration → POST /clone 并显示成功 banner', async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    vi.stubGlobal('fetch', routingFetch(calls));
    renderPage();
    await waitFor(() => expect(screen.getByText('Run ID')).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Clone Configuration' }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/clone'))).toBe(true);
      expect(screen.getByText(/Clone Configuration → run-clone/)).toBeInTheDocument();
    });
  });

  it('点击 Create Template → POST /template 并显示成功 banner', async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    vi.stubGlobal('fetch', routingFetch(calls));
    renderPage();
    await waitFor(() => expect(screen.getByText('Run ID')).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Create Template' }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/template'))).toBe(true);
      expect(screen.getByText(/已保存模板：wan3 模板/)).toBeInTheDocument();
    });
  });

  it('空评论点击 → 不发 POST /comments（guard）', async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    vi.stubGlobal('fetch', routingFetch(calls));
    renderPage();
    await waitFor(() => expect(screen.getByText('Run ID')).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '评论' }));
    await waitFor(() => expect(screen.getByText('Run ID')).toBeInTheDocument());
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/comments'))).toBe(false);
  });

  it('空指派输入点击 → 不发 POST /assign（guard）', async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    vi.stubGlobal('fetch', routingFetch(calls));
    renderPage();
    await waitFor(() => expect(screen.getByText('Run ID')).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '指派 Assign' }));
    await waitFor(() => expect(screen.getByText('Run ID')).toBeInTheDocument());
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/assign'))).toBe(false);
  });

  it('写操作失败 → 展示错误 banner（不再静默吞掉）', async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const failFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method ?? 'GET');
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });
      if (url.endsWith('/api/runs/run-1/detail')) return jsonResponse(200, DETAIL);
      if (url.endsWith('/api/runs/run-1/report')) return jsonResponse(200, REPORT);
      if (url.endsWith('/api/runs/run-1/comments') && method === 'GET') return jsonResponse(200, []);
      if (url.endsWith('/rerun')) return jsonResponse(500, { error: 'internal_error', message: '重跑服务不可用' });
      return jsonResponse(404, {});
    });
    vi.stubGlobal('fetch', failFetch);
    renderPage();
    await waitFor(() => expect(screen.getByText('Run ID')).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Run Again' }));
    await waitFor(() => expect(screen.getByText('重跑服务不可用')).toBeInTheDocument());
  });
  it('报告/评论加载失败 → 页面仍渲染 Run 信息（catch 降级不崩溃）', async () => {
    const failReportFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method ?? 'GET');
      if (url.endsWith('/api/runs/run-1/detail')) return jsonResponse(200, DETAIL);
      if (url.endsWith('/api/runs/run-1/report')) return jsonResponse(500, { error: 'internal_error' });
      if (url.endsWith('/api/runs/run-1/comments') && method === 'GET') return jsonResponse(500, { error: 'internal_error' });
      return jsonResponse(404, {});
    });
    vi.stubGlobal('fetch', failReportFetch);
    renderPage();
    await waitFor(() => expect(screen.getByText('Run ID')).toBeInTheDocument());
    // 报告摘要不渲染，但 Run 操作与评论卡片仍在
    expect(screen.queryByText('报告摘要（关键结论）')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run Again' })).toBeInTheDocument();
    expect(screen.getByText('暂无评论')).toBeInTheDocument();
  });
});

describe('RunDetail 报告摘要 / 评论 / 审批渲染（43.3 覆盖补强）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('报告含 failures/RCA/decisionTrace → 渲染表格与 JsonBlock', async () => {
    const richReport = {
      ...REPORT,
      releaseDecision: { decision: 'GO', result: '通过', reason: '无 P0 缺陷' },
      failures: [{ caseId: 'c-1', reason: '断言失败', category: 'func' }],
      rca: [{ caseId: 'c-1', category: '配置变更', verified: true }],
      cost: { value: 3.2, tracked: true, unit: 'CNY' },
      durationMs: 3200,
      decisionTrace: { plan: ['s1', 's2'] },
    };
    const richFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method ?? 'GET');
      if (url.endsWith('/api/runs/run-1/detail')) return jsonResponse(200, DETAIL);
      if (url.endsWith('/api/runs/run-1/report')) return jsonResponse(200, richReport);
      if (url.endsWith('/api/runs/run-1/comments') && method === 'GET') return jsonResponse(200, []);
      return jsonResponse(404, {});
    });
    vi.stubGlobal('fetch', richFetch);
    renderPage();
    await waitFor(() => expect(screen.getByText('Release 决策')).toBeInTheDocument());
    expect(screen.getAllByText('GO').length).toBeGreaterThan(0);
    expect(screen.getByText('断言失败')).toBeInTheDocument();
    expect(screen.getByText('配置变更')).toBeInTheDocument();
    expect(screen.getByText('3.2 CNY')).toBeInTheDocument();
    expect(screen.getByText(/DecisionTrace/)).toBeInTheDocument();
  });

  it('评论带 mentions → 渲染 @badge 与正文；审批记录 → 渲染表格', async () => {
    const richDetail = {
      ...DETAIL,
      approvals: [{ approvalId: 'appr-1', action: 'approve', riskLevel: 'high', status: 'APPROVED', decidedBy: 'mgr', decidedAt: '2026-08-20T01:00:00Z' }],
    };
    const comments = [
      { id: 'cm-1', actor: 'zhangsan', text: '请确认模型服务', mentions: ['lisi'], createdAt: '2026-08-20T00:10:00Z' },
    ];
    const richFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method ?? 'GET');
      if (url.endsWith('/api/runs/run-1/detail')) return jsonResponse(200, richDetail);
      if (url.endsWith('/api/runs/run-1/report')) return jsonResponse(200, REPORT);
      if (url.endsWith('/api/runs/run-1/comments') && method === 'GET') return jsonResponse(200, comments);
      return jsonResponse(404, {});
    });
    vi.stubGlobal('fetch', richFetch);
    renderPage();
    await waitFor(() => expect(screen.getByText('请确认模型服务')).toBeInTheDocument());
    expect(screen.getByText('@lisi')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('审批记录')).toBeInTheDocument());
    expect(screen.getByText('appr-1')).toBeInTheDocument();
    expect(screen.getByText('mgr')).toBeInTheDocument();
  });
});
