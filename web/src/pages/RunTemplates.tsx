// Run Template（Phase 39.3）：Save as Template → Run Template（只复制 Configuration）
import { useState } from 'react';
import { api } from '../api';
import { usePolling } from '../hooks/usePolling';
import { Card, StatusBadge, Table, Empty, fmtTime } from '../components/ui';

interface Template {
  id: string;
  projectId: string;
  name: string;
  environment: string;
  suiteIds: string[];
  mode: string;
  budget?: number;
  releaseGate?: boolean;
  runCount: number;
  createdBy: string;
  createdAt: string;
}

export default function RunTemplates(): JSX.Element {
  const { data, error, refresh } = usePolling<Template[]>(() => api.get<Template[]>('/run-templates'), 3000);
  const [name, setName] = useState('');
  const [suiteIds, setSuiteIds] = useState('');
  const [environment, setEnvironment] = useState('staging');
  const [mode, setMode] = useState('AUTONOMOUS');
  const [budget, setBudget] = useState('10');
  const [msg, setMsg] = useState('');

  const doCreate = async (): Promise<void> => {
    if (!name.trim()) { setMsg('请填写模板名称'); return; }
    await api.post<Template>('/run-templates', {
      projectId: 'wan3', name: name.trim(),
      suiteIds: suiteIds.split(',').map((s) => s.trim()).filter(Boolean),
      environment, mode, budget: budget ? Number(budget) : undefined, releaseGate: true,
    });
    setName(''); setSuiteIds(''); setMsg('已创建'); refresh();
  };

  const doRun = async (id: string): Promise<void> => {
    const r = await api.post<{ runId: string; status: string }>(`/run-templates/${id}/run`);
    setMsg(`已按模板启动 Run：${r.runId}（${r.status}，仅复制配置）`); refresh();
  };

  return (
    <div>
      <h1 className="page-title">Run Templates</h1>
      <div className="page-sub">“这套测试我上次跑过，再跑一次”——只复制 Configuration，不复制旧结果/RCA/Release 决策</div>
      {error && <div className="error-banner">{error}</div>}
      {msg && <div className="ok-banner">{msg}</div>}

      <Card title="新建 Run Template">
        <div className="form-row">
          <input aria-label="名称" placeholder="名称（如 WAN3 回归模板）" value={name} onChange={(e) => setName(e.target.value)} />
          <input aria-label="Suite IDs（逗号分隔）" placeholder="Suite IDs（逗号分隔）" value={suiteIds} onChange={(e) => setSuiteIds(e.target.value)} />
          <select aria-label="环境" value={environment} onChange={(e) => setEnvironment(e.target.value)}>
            {['test', 'staging', 'preprod'].map((e) => <option key={e} value={e}>{e}</option>)}
          </select>
          <select aria-label="模式" value={mode} onChange={(e) => setMode(e.target.value)}>
            {['MANUAL', 'REGRESSION', 'AUTONOMOUS'].map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <input aria-label="Budget" placeholder="Budget" value={budget} onChange={(e) => setBudget(e.target.value)} style={{ width: 80 }} />
          <button className="btn btn-sm" onClick={() => void doCreate()}>创建</button>
        </div>
      </Card>

      <Card title={`全部 Template（${data?.length ?? 0}）`}>
        {!data && <Empty text="加载中…" />}
        {data && data.length === 0 && <Empty text="暂无 Template" />}
        {data && data.length > 0 && (
          <Table head={['名称', '模式', '环境', 'Budget', '门禁', '复用次数', '操作']}>
            {data.map((t) => (
              <tr key={t.id}>
                <td>{t.name}<div className="mono small">{t.id}</div></td>
                <td><StatusBadge status={t.mode} /></td>
                <td>{t.environment}</td>
                <td>{t.budget ?? '—'}</td>
                <td>{t.releaseGate ? '开' : '关'}</td>
                <td>{t.runCount}</td>
                <td><button className="btn btn-sm" onClick={() => void doRun(t.id)}>Run</button></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
