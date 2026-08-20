// Phase 45：AI 质量页面组件测试（AIQuality.tsx）
// 覆盖：总体评分 + 8 领域渲染 / 关键安全指标（非 0 红显）/ 展开领域可见 Case ID 与 errors /
//       点击 Evidence 查看 Case/Expected/Actual/Difference/Reason/Evidence 详情
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import AIQuality from './AIQuality';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AIQuality />
    </MemoryRouter>
  );
}

/** 领域元信息（8 个领域） */
const DOMAIN_META = [
  { domain: 'REQUIREMENT', label: '需求质量', benchmark: 'req-bench', benchmarkVersion: 'v1', total: 12, tracked: 10, untracked: 2, passed: 10, score: 0.83 },
  { domain: 'TEST_DESIGN', label: '测试设计', benchmark: 'td-bench', benchmarkVersion: 'v2', total: 15, tracked: 13, untracked: 2, passed: 11, score: 0.73 },
  { domain: 'RISK', label: '风险评估', benchmark: 'risk-bench', benchmarkVersion: 'v1', total: 9, tracked: 9, untracked: 0, passed: 8, score: 0.89 },
  { domain: 'SELECTION', label: '用例选择', benchmark: 'sel-bench', benchmarkVersion: 'v1', total: 20, tracked: 18, untracked: 2, passed: 17, score: 0.85 },
  { domain: 'RCA', label: '根因分析', benchmark: 'rca-bench', benchmarkVersion: 'v2', total: 8, tracked: 7, untracked: 1, passed: 6, score: 0.75 },
  { domain: 'DEFECT', label: '缺陷管理', benchmark: 'def-bench', benchmarkVersion: 'v3', total: 6, tracked: 6, untracked: 0, passed: 4, score: 0.67 },
  { domain: 'HEALING', label: '自愈', benchmark: 'heal-bench', benchmarkVersion: 'v1', total: 10, tracked: 9, untracked: 1, passed: 9, score: 0.9 },
  { domain: 'RELEASE', label: '发布决策', benchmark: 'rel-bench', benchmarkVersion: 'v2', total: 7, tracked: 7, untracked: 0, passed: 7, score: 1.0 },
];

/** 8 领域评测报告（确定性规则评测 model=rules） */
const REPORT = {
  version: 'eval-report-2026.08.45',
  generatedAt: '2026-08-20T08:00:00Z',
  overall: 0.85,
  critical: { p0Miss: 1, falsePass: 0, unsafeHealing: 2, skippedCritical: 0 },
  cost: { cost: 12.5, totalTokens: 125000, latencyMs: 3200 },
  versionInfo: { model: 'rules', modelVersion: 'r45.2', promptVersion: 'p12', toolVersion: 't9', agentVersion: 'a3' },
  domains: DOMAIN_META.map((m) => ({
    ...m,
    metrics: { precision: 0.9, recall: 0.8 },
    failures: [],
    results: [
      {
        caseId: `CASE-${m.domain}-001`,
        domain: m.domain,
        score: m.score,
        passed: m.score >= 0.8,
        tracked: true,
        expected: m.domain === 'DEFECT' ? '缺陷应归类为严重级别 P1，并挂接来源用例' : `${m.domain} 期望输出`,
        actual: m.domain === 'DEFECT' ? '缺陷被归类为 P2，未挂接来源用例' : `${m.domain} 实际输出`,
        errors: m.domain === 'DEFECT' ? ['缺少严重级别断言', '缺少来源用例关联校验'] : [],
        evidence: m.domain === 'DEFECT' ? 'evidence://defect/001/payload.json' : `evidence://${m.domain.toLowerCase()}/001/trace.json`,
      },
    ],
  })),
};

const DOMAIN_LABELS = ['需求质量', '测试设计', '风险评估', '用例选择', '根因分析', '缺陷管理', '自愈', '发布决策'];

describe('AIQuality 页面（45）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('渲染总体评分、8 个领域与关键安全指标', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, REPORT)));
    renderPage();
    await waitFor(() => expect(screen.getByText('总体评分')).toBeInTheDocument());
    // 页面标题
    expect(screen.getByText('AI 质量')).toBeInTheDocument();
    // 8 个领域卡片
    for (const label of DOMAIN_LABELS) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    // 版本信息与成本
    expect(screen.getByText('评测成本')).toBeInTheDocument();
    expect(screen.getByText('版本信息')).toBeInTheDocument();
    // 关键安全指标
    expect(screen.getByText('P0 Miss')).toBeInTheDocument();
    expect(screen.getByText('False Pass')).toBeInTheDocument();
    expect(screen.getByText('Unsafe Healing')).toBeInTheDocument();
    expect(screen.getByText('Skipped Critical')).toBeInTheDocument();
  });

  it('非 0 关键安全指标红显', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, REPORT)));
    renderPage();
    await waitFor(() => expect(screen.getByText('P0 Miss')).toBeInTheDocument());
    // p0Miss=1 / unsafeHealing=2 非 0 → 值红显（var(--err)）
    expect(screen.getByText('1').style.color).toBe('var(--err)');
    expect(screen.getByText('2').style.color).toBe('var(--err)');
    // falsePass=0 / skippedCritical=0 → 正常色（非红）
    const zeros = screen.getAllByText('0');
    for (const z of zeros) {
      expect(z.style.color).not.toBe('var(--err)');
    }
  });

  it('展开领域可查看 Case ID 与 errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, REPORT)));
    renderPage();
    await waitFor(() => expect(screen.getByText('缺陷管理')).toBeInTheDocument());
    // 未展开前不应出现 caseId
    expect(screen.queryByText('CASE-DEFECT-001')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /缺陷管理/ }));
    // 展开后可见 caseId 与 errors
    expect(screen.getByText('CASE-DEFECT-001')).toBeInTheDocument();
    expect(screen.getByText(/缺少严重级别断言/)).toBeInTheDocument();
    expect(screen.getByText(/缺少来源用例关联校验/)).toBeInTheDocument();
  });

  it('点击 Evidence 查看 Case/Expected/Actual/Difference/Reason/Evidence 详情', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, REPORT)));
    renderPage();
    await waitFor(() => expect(screen.getByText('缺陷管理')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /缺陷管理/ }));
    // 该领域 1 条结果 → 1 个「查看」按钮
    await userEvent.click(screen.getByRole('button', { name: '查看' }));
    const detail = within(screen.getByTestId('detail-CASE-DEFECT-001'));
    expect(detail.getByText(/结果详情/)).toBeInTheDocument();
    expect(detail.getByText('期望输出（Expected）')).toBeInTheDocument();
    expect(detail.getByText('实际输出（Actual）')).toBeInTheDocument();
    expect(detail.getByText('差异（Difference）')).toBeInTheDocument();
    expect(detail.getByText('原因（Reason）')).toBeInTheDocument();
    expect(detail.getByText('证据（Evidence）')).toBeInTheDocument();
    // Reason 为 errors 拼接
    expect(detail.getByText('缺少严重级别断言；缺少来源用例关联校验')).toBeInTheDocument();
    // Evidence 内容可见
    expect(detail.getByText(/evidence:\/\/defect\/001\/payload\.json/)).toBeInTheDocument();
  });
});
