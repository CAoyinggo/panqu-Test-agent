import { Link, useSearchParams } from 'react-router-dom';
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

// 43.1：Runs 页支持 ?project=<id> 过滤（QA Home「看 Runs」直达项目视角）。
// 此前 query 被忽略，表现为展示全部 Runs，项目过滤失效。
export default function Runs(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const project = params.get('project') ?? '';
  const { data, error } = usePolling<RunRow[]>(() => api.get<RunRow[]>('/runs'), 2000);
  const filtered = project
    ? (data ?? []).filter((r) => r.projectId === project)
    : (data ?? []);

  return (
    <div>
      <h1 className="page-title">执行记录</h1>
      <div className="page-sub">Run 列表 · 每 2 秒刷新</div>
      {error && <div className="error-banner">{error}</div>}
      <div className="form-row" style={{ marginBottom: 8 }}>
        <Link className="btn btn-sm" to="/runs/new">+ 新建 Run</Link>
        {project && (
          <button className="btn btn-sm btn-ghost" onClick={() => setParams({})}>
            项目过滤：{project} ✕
          </button>
        )}
      </div>
      <Card>
        {!data && !error && <Empty text="加载中…" />}
        {data && filtered.length === 0 && (
          <Empty text={project ? `项目 ${project} 暂无执行记录` : '暂无执行记录'} />
        )}
        {filtered.length > 0 && (
          <Table head={['Run ID', '状态', '项目', '环境', '触发', 'Feature', '创建时间', '完成时间']}>
            {filtered.map((r) => (
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
