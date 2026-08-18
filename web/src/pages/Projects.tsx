// 项目管理：列表 + 创建（GET/POST /projects）
import { useState } from 'react';
import { api } from '../api';
import { usePolling } from '../hooks/usePolling';
import { Card, Table, fmtTime, Empty } from '../components/ui';

interface Environment {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
}

interface Project {
  id: string;
  name: string;
  businesses: string[];
  environments: Environment[];
  defaultEnvironment: string;
  createdAt: string;
  updatedAt: string;
}

export default function Projects(): JSX.Element {
  const { data, error, refresh } = usePolling<Project[]>(() => api.get<Project[]>('/projects'), 2000);
  const [form, setForm] = useState({ id: '', name: '', businesses: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!form.id.trim() || !form.name.trim()) {
      setErr('请填写项目 ID 与名称');
      return;
    }
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await api.post('/projects', {
        id: form.id.trim(),
        name: form.name.trim(),
        businesses: form.businesses.split(',').map((s) => s.trim()).filter(Boolean),
      });
      setMsg('项目创建成功');
      setForm({ id: '', name: '', businesses: '' });
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="page-title">项目管理</div>
      <div className="page-sub">全部项目 · 每 2 秒刷新</div>
      {error && <div className="error-banner">{error}</div>}

      <Card title="创建项目">
        <form className="form-row" onSubmit={submit}>
          <input className="input" placeholder="项目 ID（如 wan3）" value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} />
          <input className="input" placeholder="项目名称" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input className="input" placeholder="业务线（逗号分隔，如 text-to-video,asr）" value={form.businesses} onChange={(e) => setForm({ ...form, businesses: e.target.value })} />
          <button className="btn" type="submit" disabled={busy}>{busy ? '创建中…' : '创建'}</button>
        </form>
        {err && <div className="error-banner">{err}</div>}
        {msg && <div className="ok-banner">{msg}</div>}
      </Card>

      <Card title={`项目列表（${data?.length ?? 0}）`}>
        {!data && !error && <Empty text="加载中…" />}
        {data && data.length === 0 && <Empty text="暂无项目" />}
        {data && data.length > 0 && (
          <Table head={['ID', '名称', '业务线', '环境', '默认环境', '创建时间']}>
            {data.map((p) => (
              <tr key={p.id}>
                <td className="mono">{p.id}</td>
                <td>{p.name}</td>
                <td>{(p.businesses ?? []).join(', ') || '—'}</td>
                <td>{(p.environments ?? []).map((e) => e.name).join(', ') || '—'}</td>
                <td>{p.defaultEnvironment}</td>
                <td>{fmtTime(p.createdAt)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
