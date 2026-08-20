// Phase 43.3：资产版本追溯页组件测试（AssetVersions.tsx）
// 覆盖：版本历史渲染 / 两版本对比展示字段级差异
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import AssetVersions from './AssetVersions';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const VERSIONS = [
  { assetType: 'test-case', assetId: 'wan3-case-001', version: 1, changeReason: '初版', createdBy: 'qa-a', createdAt: '2026-08-01T00:00:00Z' },
  { assetType: 'test-case', assetId: 'wan3-case-001', version: 2, changeReason: '补充用例', createdBy: 'qa-b', createdAt: '2026-08-02T00:00:00Z' },
];

const DIFF = {
  assetType: 'test-case', assetId: 'wan3-case-001', fromVersion: 1, toVersion: 2,
  changed: ['steps'], added: ['expected'], removed: [],
  changes: [{ key: 'steps', from: ['a'], to: ['a', 'b'] }],
};

function routingFetch(calls: Array<{ method: string; url: string }>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = String(init?.method ?? 'GET');
    calls.push({ method, url });
    if (url.includes('/api/assets/wan3-case-001/compare')) return jsonResponse(200, DIFF);
    if (url.endsWith('/api/assets/wan3-case-001/versions')) return jsonResponse(200, VERSIONS);
    return jsonResponse(404, {});
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/assets/wan3-case-001']}>
      <Routes>
        <Route path="/assets/:id" element={<AssetVersions />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('AssetVersions 页面（43.3）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('渲染版本历史（变更原因 + 对比按钮）', async () => {
    const calls: Array<{ method: string; url: string }> = [];
    vi.stubGlobal('fetch', routingFetch(calls));
    renderPage();
    await waitFor(() => expect(screen.getByText('初版')).toBeInTheDocument());
    expect(screen.getByText('补充用例')).toBeInTheDocument();
    // 版本 ≥2 时出现对比区（v1/v2 文本因节点拆分，用唯一文案断言）
    expect(screen.getByRole('button', { name: '对比' })).toBeInTheDocument();
  });

  it('选择版本并对比 → 展示字段级差异表', async () => {
    const calls: Array<{ method: string; url: string }> = [];
    vi.stubGlobal('fetch', routingFetch(calls));
    renderPage();
    await waitFor(() => expect(screen.getByText('初版')).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '对比' }));
    await waitFor(() => expect(screen.getByText('steps')).toBeInTheDocument());
    expect(screen.getByText(/变更 1 项/)).toBeInTheDocument();
  });

  it('只有一个版本 → 不渲染对比区（44.2 覆盖收口）', async () => {
    const singleFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/assets/wan3-case-001/compare')) return jsonResponse(200, DIFF);
      if (url.endsWith('/api/assets/wan3-case-001/versions')) {
        return jsonResponse(200, [VERSIONS[0]]);
      }
      return jsonResponse(404, {});
    });
    vi.stubGlobal('fetch', singleFetch);
    renderPage();
    await waitFor(() => expect(screen.getByText('初版')).toBeInTheDocument());
    // 仅 1 版本 → 无「版本对比」卡片、无「对比」按钮
    expect(screen.queryByText('版本对比')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '对比' })).not.toBeInTheDocument();
  });

  it('版本加载失败 → 展示错误 banner（44.2 覆盖收口）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(500, { error: 'internal', message: '版本服务不可用' })));
    renderPage();
    await waitFor(() => expect(screen.getByText('版本服务不可用')).toBeInTheDocument());
  });

  it('对比失败 → 展示对比错误区且清空差异（44.2 覆盖收口）', async () => {
    const failCompareFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/assets/wan3-case-001/compare')) {
        return jsonResponse(500, { error: 'internal', message: '对比服务不可用' });
      }
      if (url.endsWith('/api/assets/wan3-case-001/versions')) return jsonResponse(200, VERSIONS);
      return jsonResponse(404, {});
    });
    vi.stubGlobal('fetch', failCompareFetch);
    renderPage();
    await waitFor(() => expect(screen.getByText('初版')).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '对比' }));
    await waitFor(() => expect(screen.getByText('对比服务不可用')).toBeInTheDocument());
    expect(screen.queryByText(/变更 1 项/)).not.toBeInTheDocument();
  });

  it('选择 From/To 版本后对比 → 携带所选版本参数（44.2 覆盖收口）', async () => {
    const calls: Array<{ method: string; url: string }> = [];
    vi.stubGlobal('fetch', routingFetch(calls));
    renderPage();
    await waitFor(() => expect(screen.getByText('初版')).toBeInTheDocument());
    const user = userEvent.setup();
    // 切换 From → v2（v1/v2 均存在；这里验证 select 变更触发 state）
    await user.selectOptions(screen.getByLabelText('对比起始版本'), '2');
    await user.click(screen.getByRole('button', { name: '对比' }));
    await waitFor(() => expect(screen.getByText('steps')).toBeInTheDocument());
    const compareCall = calls.find((c) => c.url.includes('/compare'));
    expect(compareCall?.url).toContain('from=2');
    expect(compareCall?.url).toContain('to=2');
  });
});
