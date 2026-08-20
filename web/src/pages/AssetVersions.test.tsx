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
});
