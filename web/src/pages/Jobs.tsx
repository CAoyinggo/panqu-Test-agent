// 调度任务（GET /jobs）
import { api } from '../api';
import { usePolling } from '../hooks/usePolling';
import { Card, Table, StatusBadge, fmtTime, Empty } from '../components/ui';

interface TestJob {
  jobId: string;
  runId: string;
  priority: number;
  projectId: string;
  environment: string;
  requiredCapability?: string;
  retryCount: number;
  maxRetries: number;
  status: string;
  claimedBy?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export default function Jobs(): JSX.Element {
  const { data, error } = usePolling<TestJob[]>(() => api.get<TestJob[]>('/jobs'), 2000);

  return (
    <div>
      <h1 className="page-title">调度任务</h1>
      <div className="page-sub">Scheduler 队列 · 每 2 秒刷新</div>
      {error && <div className="error-banner">{error}</div>}
      <Card>
        {!data && !error && <Empty text="加载中…" />}
        {data && data.length === 0 && <Empty text="暂无调度任务" />}
        {data && data.length > 0 && (
          <Table head={['Job ID', 'Run', '状态', '项目', '环境', '能力', '优先级', '重试', '认领', '错误', '更新时间']}>
            {data.map((j) => (
              <tr key={j.jobId}>
                <td className="mono">{j.jobId}</td>
                <td className="mono">{j.runId}</td>
                <td><StatusBadge status={j.status} /></td>
                <td className="mono">{j.projectId}</td>
                <td>{j.environment}</td>
                <td>{j.requiredCapability ?? 'general'}</td>
                <td>{j.priority}</td>
                <td>{j.retryCount}/{j.maxRetries}</td>
                <td>{j.claimedBy ?? '—'}</td>
                <td className="cell-clip" title={j.error}>{j.error ?? '—'}</td>
                <td>{fmtTime(j.updatedAt)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
