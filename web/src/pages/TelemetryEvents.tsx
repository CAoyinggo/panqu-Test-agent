// 遥测事件流：全部事件（GET /telemetry/events）
import { api } from '../api';
import { usePolling } from '../hooks/usePolling';
import { Card, Table, Badge, fmtTime, Empty } from '../components/ui';

interface TelemetryEvent {
  eventId: string;
  runId: string;
  projectId?: string;
  feature?: string;
  type: string;
  value?: number;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

const TYPE_KIND: Record<string, 'ok' | 'warn' | 'err' | 'info' | 'muted'> = {
  llm: 'info',
  execution: 'ok',
  cost: 'warn',
  rca: 'info',
  'rca.verify': 'ok',
  flaky: 'warn',
  healing: 'info',
  release: 'err',
};

export default function TelemetryEvents(): JSX.Element {
  const { data, error } = usePolling<TelemetryEvent[]>(() => api.get<TelemetryEvent[]>('/telemetry/events'), 2000);

  return (
    <div>
      <h1 className="page-title">遥测事件</h1>
      <div className="page-sub">事件流 · 每 2 秒刷新 · 最近 {data?.length ?? 0} 条</div>
      {error && <div className="error-banner">{error}</div>}
      <Card>
        {!data && !error && <Empty text="加载中…" />}
        {data && data.length === 0 && <Empty text="暂无遥测事件" />}
        {data && data.length > 0 && (
          <Table head={['事件 ID', '类型', 'Run', '项目', 'Feature', '值', '时间']}>
            {data.slice().reverse().map((e) => (
              <tr key={e.eventId}>
                <td className="mono">{e.eventId}</td>
                <td><Badge kind={TYPE_KIND[e.type] ?? 'muted'}>{e.type}</Badge></td>
                <td className="mono">{e.runId}</td>
                <td className="mono">{e.projectId ?? '—'}</td>
                <td>{e.feature ?? '—'}</td>
                <td>{e.value !== undefined ? e.value : '—'}</td>
                <td>{fmtTime(e.timestamp)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
