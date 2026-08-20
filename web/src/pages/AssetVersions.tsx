// Phase 43.3：资产版本追溯 Web 化
// 平台 `workflow/asset-versioning.ts`（GET /assets/:id/versions + compare）此前无页面。
// 本页：版本历史表（version / changeReason / createdBy / createdAt）+ 任意两版本对比（字段级 diff）。
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { Card, Table, Empty, fmtTime, JsonBlock } from '../components/ui';

interface AssetVersionSummary {
  assetType: string;
  assetId: string;
  version: number;
  changeReason?: string;
  createdBy: string;
  createdAt: string;
}

interface AssetDiff {
  assetType: string;
  assetId: string;
  fromVersion: number;
  toVersion: number;
  changed: string[];
  added: string[];
  removed: string[];
  changes: Array<{ key: string; from: unknown; to: unknown }>;
}

export default function AssetVersions(): JSX.Element {
  const { id = '' } = useParams();
  const [versions, setVersions] = useState<AssetVersionSummary[] | null>(null);
  const [error, setError] = useState('');
  const [from, setFrom] = useState(1);
  const [to, setTo] = useState(2);
  const [diff, setDiff] = useState<AssetDiff | null>(null);
  const [diffErr, setDiffErr] = useState('');

  useEffect(() => {
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        const v = await api.get<AssetVersionSummary[]>(`/assets/${id}/versions`);
        if (!alive) return;
        const list = Array.isArray(v) ? v : [];
        setVersions(list);
        if (list.length >= 2) {
          setFrom(list[list.length - 2].version);
          setTo(list[list.length - 1].version);
        } else if (list.length === 1) {
          setFrom(list[0].version);
          setTo(list[0].version);
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void load();
    return () => { alive = false; };
  }, [id]);

  const doCompare = async (): Promise<void> => {
    setDiffErr('');
    try {
      const d = await api.get<AssetDiff>(`/assets/${id}/compare?from=${from}&to=${to}`);
      setDiff(d);
    } catch (e) {
      setDiff(null);
      setDiffErr(e instanceof Error ? e.message : String(e));
    }
  };

  const sorted = useMemo(() => (versions ? [...versions].sort((a, b) => a.version - b.version) : []), [versions]);

  return (
    <div>
      <h1 className="page-title">资产版本追溯</h1>
      <div className="page-sub mono">{id} · 版本历史与字段级对比</div>
      <div className="form-row" style={{ marginBottom: 8 }}>
        <Link className="btn btn-sm" to="/assets">← 返回资产列表</Link>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {!versions && !error && <Empty text="加载中…" />}
      {versions && (
        <>
          <Card title={`版本历史（${versions.length}）`}>
            {versions.length === 0 && <Empty text="该资产暂无版本记录" />}
            {versions.length > 0 && (
              <Table head={['版本', '变更原因', '创建人', '创建时间']}>
                {sorted.map((v) => (
                  <tr key={v.version}>
                    <td className="mono">v{v.version}</td>
                    <td>{v.changeReason ?? '—'}</td>
                    <td className="mono">{v.createdBy}</td>
                    <td>{fmtTime(v.createdAt)}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
          {versions.length >= 2 && (
            <Card title="版本对比">
              <div className="form-row">
                <label className="form-label">From</label>
                <select aria-label="对比起始版本" value={from} onChange={(e) => setFrom(Number(e.target.value))}>
                  {sorted.map((v) => <option key={v.version} value={v.version}>v{v.version}</option>)}
                </select>
                <label className="form-label">To</label>
                <select aria-label="对比结束版本" value={to} onChange={(e) => setTo(Number(e.target.value))}>
                  {sorted.map((v) => <option key={v.version} value={v.version}>v{v.version}</option>)}
                </select>
                <button className="btn btn-sm" onClick={() => void doCompare()}>对比</button>
              </div>
              {diffErr && <div className="error-banner">{diffErr}</div>}
              {diff && (
                <>
                  <div className="small muted">变更 {diff.changed.length} 项 · 新增 {diff.added.length} 项 · 移除 {diff.removed.length} 项</div>
                  {diff.changes.length === 0 && diff.added.length === 0 && diff.removed.length === 0 && <Empty text="两版本无差异" />}
                  {diff.changes.length > 0 && (
                    <Table head={['字段', 'From', 'To']}>
                      {diff.changes.map((c) => (
                        <tr key={c.key}>
                          <td className="mono">{c.key}</td>
                          <td>{c.from === undefined ? '—' : JSON.stringify(c.from)}</td>
                          <td>{c.to === undefined ? '—' : JSON.stringify(c.to)}</td>
                        </tr>
                      ))}
                    </Table>
                  )}
                  {diff.added.length > 0 && <div className="small ok">新增字段：{diff.added.join(', ')}</div>}
                  {diff.removed.length > 0 && <div className="small err">移除字段：{diff.removed.join(', ')}</div>}
                  <JsonBlock data={diff} />
                </>
              )}
            </Card>
          )}
        </>
      )}
    </div>
  );
}
