// 审计日志（GET /audit）
import { api } from '../api';
import { usePolling } from '../hooks/usePolling';
import { Card, Table, Badge, fmtTime, Empty } from '../components/ui';

interface AuditEntry {
  entryId: string;
  timestamp: string;
  actor: string;
  role: string;
  action: string;
  resource: string;
  environment?: string;
  result: 'success' | 'denied' | 'error' | 'pending';
  approvalId?: string;
  traceId?: string;
}

const RESULT_KIND: Record<string, 'ok' | 'warn' | 'err' | 'info' | 'muted'> = {
  success: 'ok',
  denied: 'err',
  error: 'err',
  pending: 'warn',
};

export default function Audit(): JSX.Element {
  const { data, error } = usePolling<AuditEntry[]>(() => api.get<AuditEntry[]>('/audit'), 2000);

  return (
    <div>
      <h1 className="page-title">审计日志</h1>
      <div className="page-sub">全部操作审计 · 每 2 秒刷新 · 最近 {data?.length ?? 0} 条</div>
      {error && <div className="error-banner">{error}</div>}
      <Card>
        {!data && !error && <Empty text="加载中…" />}
        {data && data.length === 0 && <Empty text="暂无审计日志" />}
        {data && data.length > 0 && (
          <Table head={['时间', '操作人', '角色', '动作', '资源', '环境', '结果', 'Trace']}>
            {data.slice().reverse().map((a) => (
              <tr key={a.entryId}>
                <td>{fmtTime(a.timestamp)}</td>
                <td>{a.actor}</td>
                <td>{a.role}</td>
                <td className="mono">{a.action}</td>
                <td className="mono">{a.resource}</td>
                <td>{a.environment ?? '—'}</td>
                <td><Badge kind={RESULT_KIND[a.result] ?? 'muted'}>{a.result}</Badge></td>
                <td className="mono">{a.traceId ?? '—'}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
