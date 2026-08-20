// 审批中心：列表 + 批准/驳回（GET /approvals；POST /approvals/:id/approve|reject）
import { useState } from 'react';
import { api } from '../api';
import { usePolling } from '../hooks/usePolling';
import { Card, Table, StatusBadge, fmtTime, Empty, Badge } from '../components/ui';

interface Approval {
  approvalId: string;
  runId: string;
  action: string;
  riskLevel: string;
  environment: string;
  requester: string;
  reason: string;
  status: string;
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
}

export default function Approvals(): JSX.Element {
  const { data, error, refresh } = usePolling<Approval[]>(() => api.get<Approval[]>('/approvals'), 2000);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const decide = async (id: string, decision: 'approve' | 'reject'): Promise<void> => {
    setBusyId(id);
    setMsg(null);
    setErr(null);
    try {
      await api.post(`/approvals/${id}/${decision}`);
      setMsg(`审批 ${id} 已${decision === 'approve' ? '批准' : '驳回'}`);
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const pending = (data ?? []).filter((a) => a.status === 'PENDING');

  return (
    <div>
      <h1 className="page-title">审批中心</h1>
      <div className="page-sub">全部审批请求 · 每 2 秒刷新 · 待审批 {pending.length} 条</div>
      {error && <div className="error-banner">{error}</div>}
      {err && <div className="error-banner">{err}</div>}
      {msg && <div className="ok-banner">{msg}</div>}

      <Card>
        {!data && !error && <Empty text="加载中…" />}
        {data && data.length === 0 && <Empty text="暂无审批请求" />}
        {data && data.length > 0 && (
          <Table head={['审批 ID', 'Run', '动作', '风险', '环境', '申请人', '原因', '状态', '决策', '时间']}>
            {data.map((a) => (
              <tr key={a.approvalId}>
                <td className="mono">{a.approvalId}</td>
                <td className="mono">{a.runId}</td>
                <td>{a.action}</td>
                <td><Badge kind={a.riskLevel === 'dangerous' ? 'err' : a.riskLevel === 'risky' ? 'warn' : 'info'}>{a.riskLevel}</Badge></td>
                <td>{a.environment}</td>
                <td>{a.requester}</td>
                <td className="cell-clip" title={a.reason}>{a.reason}</td>
                <td><StatusBadge status={a.status} /></td>
                <td>
                  {a.status === 'PENDING' ? (
                    <span className="btn-group">
                      <button className="btn btn-sm btn-ok" disabled={busyId === a.approvalId} onClick={() => decide(a.approvalId, 'approve')}>批准</button>
                      <button className="btn btn-sm btn-err" disabled={busyId === a.approvalId} onClick={() => decide(a.approvalId, 'reject')}>驳回</button>
                    </span>
                  ) : (
                    <span>{a.decidedBy ? `${a.decidedBy} @ ${fmtTime(a.decidedAt)}` : '—'}</span>
                  )}
                </td>
                <td>{fmtTime(a.createdAt)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
