import { Link } from 'react-router-dom';
import { api } from '../api';
import { usePolling } from '../hooks/usePolling';
import { Card, StatusBadge, Table, fmtTime, Empty } from '../components/ui';

export interface RunRow {
  runId: string;
  status: string;
  projectId: string;
  environment: string;
  trigger: string;
  feature?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export default function Runs(): JSX.Element {
  const { data, error } = usePolling<RunRow[]>(() => api.get<RunRow[]>('/runs'), 2000);

  return (
    <div>
      <h1 className="page-title">执行记录</h1>
      <div className="page-sub">全部 Run 列表 · 每 2 秒刷新</div>
      {error && <div className="error-banner">{error}</div>}
      <Card>
        {!data && !error && <Empty text="加载中…" />}
        {data && data.length === 0 && <Empty text="暂无执行记录" />}
        {data && data.length > 0 && (
          <Table head={['Run ID', '状态', '项目', '环境', '触发', 'Feature', '创建时间', '完成时间']}>
            {data.map((r) => (
              <tr key={r.runId}>
                <td className="mono"><Link className="link" to={`/runs/${r.runId}`}>{r.runId}</Link></td>
                <td><StatusBadge status={r.status} /></td>
                <td className="mono">{r.projectId}</td>
                <td>{r.environment}</td>
                <td>{r.trigger}</td>
                <td>{r.feature ?? '—'}</td>
                <td>{fmtTime(r.createdAt)}</td>
                <td>{fmtTime(r.finishedAt)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
