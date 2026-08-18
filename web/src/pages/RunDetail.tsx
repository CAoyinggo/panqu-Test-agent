import { useParams } from 'react-router-dom';
import { api } from '../api';
import { usePolling } from '../hooks/usePolling';
import { Card, StatusBadge, Table, JsonBlock, Empty, fmtTime } from '../components/ui';

interface RunDetailData {
  run: {
    runId: string;
    status: string;
    projectId: string;
    environment: string;
    feature?: string;
    trigger: string;
    createdAt: string;
    startedAt?: string;
    finishedAt?: string;
  };
  trace?: unknown;
  checkpoint?: unknown;
  approvals?: Array<{ approvalId: string; action: string; riskLevel: string; status: string; decidedBy?: string; decidedAt?: string }>;
}

export default function RunDetail(): JSX.Element {
  const { id = '' } = useParams();
  const { data, error } = usePolling<RunDetailData>(() => api.get<RunDetailData>(`/runs/${id}/detail`), 2000);

  return (
    <div>
      <div className="page-title">执行详情</div>
      <div className="page-sub mono">{id} · 每 2 秒刷新</div>
      {error && <div className="error-banner">{error}</div>}
      {!data && !error && <Empty text="加载中…" />}
      {data && (
        <>
          <Card title="Run 信息">
            <Table head={['字段', '值']}>
              <tr><td>Run ID</td><td className="mono">{data.run.runId}</td></tr>
              <tr><td>状态</td><td><StatusBadge status={data.run.status} /></td></tr>
              <tr><td>项目</td><td className="mono">{data.run.projectId}</td></tr>
              <tr><td>环境</td><td>{data.run.environment}</td></tr>
              <tr><td>Feature</td><td>{data.run.feature ?? '—'}</td></tr>
              <tr><td>触发</td><td>{data.run.trigger}</td></tr>
              <tr><td>创建</td><td>{fmtTime(data.run.createdAt)}</td></tr>
              <tr><td>完成</td><td>{fmtTime(data.run.finishedAt)}</td></tr>
            </Table>
          </Card>
          {data.approvals && data.approvals.length > 0 && (
            <Card title="审批记录">
              <Table head={['审批 ID', '动作', '风险', '状态', '决策人', '决策时间']}>
                {data.approvals.map((a) => (
                  <tr key={a.approvalId}>
                    <td className="mono">{a.approvalId}</td>
                    <td>{a.action}</td>
                    <td>{a.riskLevel}</td>
                    <td><StatusBadge status={a.status} /></td>
                    <td>{a.decidedBy ?? '—'}</td>
                    <td>{fmtTime(a.decidedAt)}</td>
                  </tr>
                ))}
              </Table>
            </Card>
          )}
          {data.trace && <Card title="执行追踪 (trace)"><JsonBlock data={data.trace} /></Card>}
          {data.checkpoint && <Card title="检查点 (checkpoint)"><JsonBlock data={data.checkpoint} /></Card>}
        </>
      )}
    </div>
  );
}
