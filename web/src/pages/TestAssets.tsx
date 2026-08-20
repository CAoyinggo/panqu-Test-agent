// Phase 43.3：测试资产 Web 化
// 平台 `src/platform/test-assets/`（wan3 真实资产目录 + 统计）此前仅有 API，无任何页面。
// 本页：统计卡片（total / byCategory / byPriority / bySource）+ 资产表格；点击资产进入版本追溯页。
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Card, StatusBadge, Table, Badge, MetricCard, Empty, fmtTime } from '../components/ui';

interface TestAsset {
  id: string;
  type: 'test-case';
  projectId: string;
  feature: string;
  business: string;
  title: string;
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  category: string;
  status: 'ACTIVE' | 'ARCHIVED';
  source: string;
  createdAt: string;
  updatedAt?: string;
}

interface AssetStats {
  total: number;
  byCategory: Record<string, number>;
  byPriority: Record<string, number>;
  bySource: { reuse: number; onboarding: number };
}

const PRIORITY_KIND: Record<string, 'err' | 'warn' | 'info' | 'muted'> = {
  P0: 'err',
  P1: 'warn',
  P2: 'info',
  P3: 'muted',
};

export default function TestAssets(): JSX.Element {
  const [items, setItems] = useState<TestAsset[] | null>(null);
  const [stats, setStats] = useState<AssetStats | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        const [a, s] = await Promise.all([
          api.get<{ items?: TestAsset[] } | TestAsset[]>('/test-assets'),
          api.get<AssetStats>('/test-assets/stats'),
        ]);
        if (!alive) return;
        // 后端契约：{ items: [...] }（与 /knowledge 一致）；兼容裸数组
        const list = Array.isArray(a) ? a : (a.items ?? []);
        setItems(list);
        setStats(s);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void load();
    return () => { alive = false; };
  }, []);

  return (
    <div>
      <h1 className="page-title">测试资产</h1>
      <div className="page-sub">平台真实资产目录（wan3 用例资产）· 统计 + 列表 + 版本追溯</div>
      {error && <div className="error-banner">{error}</div>}
      {!items && !error && <Empty text="加载中…" />}
      {items && stats && (
        <>
          <div className="metric-grid">
            <MetricCard label="资产总数" value={stats.total} />
            <MetricCard label="复用来源" value={stats.bySource.reuse} hint="来自资产复用" />
            <MetricCard label="新接入" value={stats.bySource.onboarding} hint="来自项目接入" />
            {Object.entries(stats.byPriority).map(([p, n]) => (
              <MetricCard key={p} label={`优先级 ${p}`} value={n} />
            ))}
          </div>
          <Card title={`资产列表（${items.length}）`}>
            {items.length === 0 && <Empty text="暂无测试资产" />}
            {items.length > 0 && (
              <Table head={['资产 ID', '标题', 'Feature', '业务线', '优先级', '分类', '状态', '来源', '更新']}>
                {items.map((a) => (
                  <tr key={a.id}>
                    <td className="mono"><Link className="link" to={`/assets/${a.id}`}>{a.id}</Link></td>
                    <td>{a.title}</td>
                    <td className="mono">{a.feature}</td>
                    <td className="mono">{a.business}</td>
                    <td><Badge kind={PRIORITY_KIND[a.priority] ?? 'muted'}>{a.priority}</Badge></td>
                    <td>{a.category}</td>
                    <td><StatusBadge status={a.status} /></td>
                    <td>{a.source}</td>
                    <td>{fmtTime(a.updatedAt ?? a.createdAt)}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
