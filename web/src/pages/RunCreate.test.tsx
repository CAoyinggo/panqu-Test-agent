// Phase 43.2：新建 Run 页面组件测试（RunCreate.tsx）
// 覆盖：渲染表单字段 / 提交调用 POST /runs 全参数 / 项目 ID 为空时禁用创建
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import RunCreate from './RunCreate';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/runs/new']}>
      <RunCreate />
    </MemoryRouter>
  );
}

describe('RunCreate 页面（43.2）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('渲染新建 Run 表单（项目/环境/触发/创建按钮）', () => {
    renderPage();
    expect(screen.getByRole('heading', { name: '新建 Run' })).toBeInTheDocument();
    expect(screen.getByLabelText('项目 ID（必填）')).toBeInTheDocument();
    expect(screen.getByLabelText('环境（必选）')).toBeInTheDocument();
    expect(screen.getByLabelText('触发类型（必选）')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '创建 Run' })).toBeInTheDocument();
  });

  it('填写表单并提交 → POST /runs 携带全参数（planId/suiteIds/budget/releaseGate）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { runId: 'run-new-1', status: 'QUEUED' }));
    vi.stubGlobal('fetch', fetchMock);
    renderPage();
    const user = userEvent.setup();
    // 项目框有默认值 'wan3'，须先 clear 再输入，避免追加成 'wan3wan3'
    await user.clear(screen.getByLabelText('项目 ID（必填）'));
    await user.type(screen.getByLabelText('项目 ID（必填）'), 'wan3');
    await user.selectOptions(screen.getByLabelText('环境（必选）'), 'preonline');
    await user.selectOptions(screen.getByLabelText('触发类型（必选）'), 'release');
    await user.type(screen.getByLabelText('Feature（可选）'), 'video-suite');
    await user.type(screen.getByLabelText('Plan ID（可选）'), 'plan-1');
    await user.type(screen.getByLabelText('Suite IDs（可选）'), 'suite-1,suite-2');
    await user.type(screen.getByLabelText('预算（可选）'), '10');
    await user.click(screen.getByLabelText('Release 门禁'));
    await user.click(screen.getByRole('button', { name: '创建 Run' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init.body));
    expect(init.method).toBe('POST');
    expect(body.projectId).toBe('wan3');
    expect(body.environment).toBe('preonline');
    expect(body.trigger).toBe('release');
    expect(body.planId).toBe('plan-1');
    expect(body.suiteIds).toEqual(['suite-1', 'suite-2']);
    expect(body.budget).toBe(10);
    expect(body.releaseGate).toBe(true);
  });

  it('提交失败（403）→ 展示错误 banner', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(403, { error: { code: 'forbidden', message: '没有权限创建 Run' } })));
    renderPage();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('项目 ID（必填）'), 'wan3');
    await user.click(screen.getByRole('button', { name: '创建 Run' }));
    await waitFor(() => expect(screen.getByText('没有权限创建 Run')).toBeInTheDocument());
  });
});
