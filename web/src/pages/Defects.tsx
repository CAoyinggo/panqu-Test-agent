// Defect 管理（Phase 40.2）：登记缺陷 / 列表 / 状态流转 / 指派 / 详情
import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api';
import { usePolling } from '../hooks/usePolling';
import { Card, StatusBadge, Table, Badge, Empty, fmtTime } from '../components/ui';

interface Defect {
  id: string;
  defectId: string;
  projectId: string;
  environment?: string;
  runId?: string;
  caseId?: string;
  title: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  status: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED' | 'WONT_FIX';
  description?: string;
  assignee?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  resolution?: string;
}

const SEVERITY_KIND: Record<string, 'err' | 'warn' | 'info' | 'muted'> = {
  critical: 'err',
  high: 'err',
  medium: 'warn',
  low: 'info',
};

const STATUS_STEPS = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'WONT_FIX'] as const;

export default function Defects(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const { data, error, refresh } = usePolling<Defect[]>(() => api.get<Defect[]>('/defects'), 3000);
  const [projectId, setProjectId] = useState('wan3');
  const [title, setTitle] = useState('');
  const [severity, setSeverity] = useState('medium');
  const [runId, setRunId] = useState('');
  const [caseId, setCaseId] = useState('');
  const [description, setDescription] = useState('');
  const [msg, setMsg] = useState('');
  const [assignee, setAssignee] = useState('');
  // 43.1：写操作错误反馈（此前 doCreate/doStatus/doAssign 无 try/catch，失败为 unhandled rejection）
  const [err, setErr] = useState('');

  const detail = id && data ? data.find((d) => d.defectId === id) ?? null : null;

  const doCreate = async (): Promise<void> => {
    if (!title.trim()) { setMsg('请填写缺陷标题'); return; }
    setErr('');
    try {
      await api.post<Defect>('/defects', {
        projectId,
        title: title.trim(),
        severity,
        runId: runId.trim() || undefined,
        caseId: caseId.trim() || undefined,
        description: description.trim() || undefined,
      });
      setTitle(''); setRunId(''); setCaseId(''); setDescription('');
      setMsg('缺陷已登记'); refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const doStatus = async (defectId: string, status: Defect['status']): Promise<void> => {
    setErr('');
    try {
      await api.patch<Defect>(`/defects/${defectId}/status`, { status });
      setMsg(`已更新为 ${status}`); refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const doAssign = async (defectId: string): Promise<void> => {
    const who = assignee.trim();
    if (!who) { setMsg('请填写处理人'); return; }
    setErr('');
    try {
      await api.post<Defect>(`/defects/${defectId}/assign`, { assignee: who });
      setMsg(`已指派给 ${who}`); setAssignee(''); refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  if (detail) {
    return (
      <div>
        <h1 className="page-title"><Link className="link" to="/defects">‹ 返回缺陷列表</Link></h1>
        <Card title={`${detail.title}`}>
          <div className="grid-2">
            <div>
              <div className="mono small">ID：{detail.defectId}</div>
              <div>项目：<span className="mono">{detail.projectId}</span>{detail.environment ? ` · 环境 ${detail.environment}` : ''}</div>
              <div>级别：<Badge kind={SEVERITY_KIND[detail.severity] ?? 'muted'}>{detail.severity}</Badge></div>
              <div>状态：<StatusBadge status={detail.status} /></div>
              {detail.assignee && <div>处理人：<span className="mono">{detail.assignee}</span></div>}
              <div>登记人：<span className="mono">{detail.createdBy}</span> · {fmtTime(detail.createdAt)}</div>
              {detail.runId && <div>关联 Run：<Link className="link mono" to={`/runs/${detail.runId}`}>{detail.runId}</Link></div>}
              {detail.caseId && <div>关联 Case：<span className="mono">{detail.caseId}</span></div>}
            </div>
            <div>
              <div className="form-row">
                <input placeholder="指派处理人" value={assignee} onChange={(e) => setAssignee(e.target.value)} />
                <button className="btn btn-sm" onClick={() => void doAssign(detail.defectId)}>指派</button>
              </div>
              <div className="btn-group" style={{ marginTop: 8 }}>
                {STATUS_STEPS.map((s) => (
                  <button key={s} className="btn btn-sm" disabled={s === detail.status} onClick={() => void doStatus(detail.defectId, s)}>{s}</button>
                ))}
              </div>
              {detail.description && <p className="small" style={{ marginTop: 8 }}>{detail.description}</p>}
              {detail.resolution && <p className="small" style={{ marginTop: 8 }}>解决说明：{detail.resolution}</p>}
            </div>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <h1 className="page-title">Defect 管理</h1>
      <div className="page-sub">平台缺陷登记 · 关联 Run / TestCase · 状态机流转</div>
      {error && <div className="error-banner">{error}</div>}
      {err && <div className="error-banner">{err}</div>}
      {msg && <div className="ok-banner">{msg}</div>}

      <Card title="登记缺陷">
        <div className="form-row">
          <input aria-label="项目（默认 wan3）" placeholder="项目（默认 wan3）" value={projectId} onChange={(e) => setProjectId(e.target.value)} style={{ width: 100 }} />
          <input aria-label="标题（必填）" placeholder="标题（必填，如 首页白屏）" value={title} onChange={(e) => setTitle(e.target.value)} />
          <select aria-label="级别" value={severity} onChange={(e) => setSeverity(e.target.value)}>
            <option value="critical">critical</option>
            <option value="high">high</option>
            <option value="medium">medium</option>
            <option value="low">low</option>
          </select>
          <input aria-label="Run ID（可选）" placeholder="Run ID（可选）" value={runId} onChange={(e) => setRunId(e.target.value)} />
        </div>
        <div className="form-row">
          <input aria-label="Case ID（可选）" placeholder="Case ID（可选）" value={caseId} onChange={(e) => setCaseId(e.target.value)} />
          <input aria-label="描述（可选）" placeholder="描述（可选）" value={description} onChange={(e) => setDescription(e.target.value)} />
          <button className="btn btn-sm" onClick={() => void doCreate()}>登记</button>
        </div>
      </Card>

      <Card title={`全部缺陷（${data?.length ?? 0}）`}>
        {!data && <Empty text="加载中…" />}
        {data && data.length === 0 && <Empty text="暂无缺陷" />}
        {data && data.length > 0 && (
          <Table head={['缺陷', '项目', '级别', '状态', '处理人', '登记', '操作']}>
            {data.map((d) => (
              <tr key={d.defectId}>
                <td><Link className="link" to={`/defects/${d.defectId}`}>{d.title}</Link><div className="mono small">{d.defectId}</div></td>
                <td className="mono">{d.projectId}</td>
                <td><Badge kind={SEVERITY_KIND[d.severity] ?? 'muted'}>{d.severity}</Badge></td>
                <td><StatusBadge status={d.status} /></td>
                <td className="mono">{d.assignee ?? '—'}</td>
                <td>{fmtTime(d.createdAt)}</td>
                <td>
                  <div className="btn-group">
                    {d.status === 'OPEN' && <button className="btn btn-sm" onClick={() => void doStatus(d.defectId, 'IN_PROGRESS')}>开始处理</button>}
                    {d.status === 'IN_PROGRESS' && <button className="btn btn-sm" onClick={() => void doStatus(d.defectId, 'RESOLVED')}>标记解决</button>}
                    {(d.status === 'RESOLVED' || d.status === 'WONT_FIX') && <button className="btn btn-sm" onClick={() => void doStatus(d.defectId, 'CLOSED')}>关闭</button>}
                    {(d.status === 'CLOSED' || d.status === 'WONT_FIX') && <button className="btn btn-sm" onClick={() => void doStatus(d.defectId, 'OPEN')}>重开</button>}
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
