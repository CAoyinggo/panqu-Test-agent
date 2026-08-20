// Phase 43.3：测试资产页面组件测试（TestAssets.tsx）
// 覆盖：统计卡片 + 资产列表渲染 / 加载失败展示错误
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import TestAssets from './TestAssets';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <TestAssets />
    </MemoryRouter>
  );
}

const ASSETS = [
  {
    id: 'wan3-case-001', type: 'test-case', projectId: 'wan3', feature: '视频合成',
    business: '文生视频', title: '文生视频基础合成', priority: 'P0', category: '功能',
    status: 'ACTIVE', source: 'reuse', createdAt: '2026-08-01T00:00:00Z',
  },
  {
    id: 'wan3-case-002', type: 'test-case', projectId: 'wan3', feature: '视频合成',
    business: '图生视频', title: '图生视频清晰度校验', priority: 'P1', category: '质量',
    status: 'ACTIVE', source: 'onboarding', createdAt: '2026-08-02T00:00:00Z',
  },
];

const STATS = {
  total: 2,
  byCategory: { 功能: 1, 质量: 1 },
  byPriority: { P0: 1, P1: 1 },
  bySource: { reuse: 1, onboarding: 1 },
};

describe('TestAssets 页面（43.3）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('渲染统计卡片与资产列表（复用 / 新接入 / 优先级）', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, ASSETS))
      .mockResolvedValueOnce(jsonResponse(200, STATS)));
    renderPage();
    await waitFor(() => expect(screen.getByText('资产总数')).toBeInTheDocument());
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('文生视频基础合成')).toBeInTheDocument();
    expect(screen.getByText('图生视频清晰度校验')).toBeInTheDocument();
    // 每条资产链接到版本追溯页
    expect(screen.getByRole('link', { name: 'wan3-case-001' })).toHaveAttribute('href', '/assets/wan3-case-001');
  });

  it('接口失败 → 展示错误 banner', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(500, { error: 'internal', message: '服务器内部错误，请重试' })));
    renderPage();
    await waitFor(() => expect(screen.getByText('服务器内部错误，请重试')).toBeInTheDocument());
  });
});
