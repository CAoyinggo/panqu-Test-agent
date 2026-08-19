// Test Plan（Phase 39.2）：Plan → Suite → TestCase；创建 / 运行 / 查看 Cases
import { useState } from 'react';
import { api } from '../api';
import { usePolling } from '../hooks/usePolling';
import { Card, StatusBadge, Table, Empty, fmtTime } from '../components/ui';

interface Plan {
  id: string;
  projectId: string;
  name: string;
  suiteIds: string[];
  environment: string;
  mode: string;
  budget?: number;
  createdBy: string;
  createdAt: string;
}

export default function TestPlans(): JSX.Element {
  const { data, error, refresh } = usePolling<Plan[]>(() => api.get<Plan[]>('/test-plans'), 3000);
  const [name, setName] = useState('');
  const [suiteIds, setSuiteIds] = useState('');
  const [environment, setEnvironment] = useState('staging');
  const [mode, setMode] = useState('REGRESSION');
  const [msg, setMsg] = useState('');

  const doCreate = async (): Promise<void> => {
    if (!name.trim()) { setMsg('请填写 Plan 名称'); return; }
    await api.post<Plan>('/test-plans', {
      projectId: 'wan3', name: name.trim(),
      suiteIds: suiteIds.split(',').map((s) => s.trim()).filter(Boolean),
      environment, mode,
    });
    setName(''); setSuiteIds(''); setMsg('已创建'); refresh();
  };

  const doRun = async (id: string): Promise<void> => {
    const r = await api.post<{ runId: string; status: string }>(`/test-plans/${id}/run`);
    setMsg(`已启动 Run：${r.runId}（${r.status}）`); refresh();
  };

  return (
    <div>
      <div className="page-title">Test Plans</div>
      <div className="page-sub">测试计划（Plan → Suite → TestCase）</div>
      {error && <div className="error-banner">{error}</div>}
      {msg && <div className="ok-banner">{msg}</div>}

      <Card title="新建 Test Plan">
        <div className="form-row">
          <input placeholder="名称（如 WAN3 回归计划）" value={name} onChange={(e) => setName(e.target.value)} />
          <input placeholder="Suite IDs（逗号分隔）" value={suiteIds} onChange={(e) => setSuiteIds(e.target.value)} />
          <select value={environment} onChange={(e) => setEnvironment(e.target.value)}>
            {['test', 'staging', 'preprod', 'production'].map((e) => <option key={e} value={e}>{e}</option>)}
          </select>
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            {['MANUAL', 'REGRESSION', 'AUTONOMOUS'].map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <button className="btn btn-sm" onClick={() => void doCreate()}>创建</button>
        </div>
      </Card>

      <Card title={`全部 Test Plan（${data?.length ?? 0}）`}>
        {!data && <Empty text="加载中…" />}
        {data && data.length === 0 && <Empty text="暂无 Plan" />}
        {data && data.length > 0 && (
          <Table head={['名称', '模式', '环境', 'Suites', '创建人', '操作']}>
            {data.map((p) => (
              <tr key={p.id}>
                <td>{p.name}<div className="mono small">{p.id}</div></td>
                <td><StatusBadge status={p.mode} /></td>
                <td>{p.environment}</td>
                <td>{p.suiteIds.length}</td>
                <td>{p.createdBy}</td>
                <td><button className="btn btn-sm" onClick={() => void doRun(p.id)}>运行</button></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
