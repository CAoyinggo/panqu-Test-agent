// 公开分享落地页（Phase 40.3）：无 JWT 可访问（/runs/:id/report?share=<token>）
// 只读展示报告摘要，不提供任何写操作；数据经服务端 share token 校验（防跨项目猜测）。
import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Card, StatusBadge, Table, JsonBlock, Empty, fmtTime } from '../components/ui';

interface ReportSummary {
  runId: string;
  projectId: string;
  environment: string;
  trigger: string;
  status: string;
  progress: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  releaseDecision: { decision: string; result: string; reason?: string; timestamp?: string } | null;
  coverage: { total: number; completed: number; failed: number; remaining: number };
  failures: Array<{ caseId?: string; reason?: string; category?: string }>;
  rca: Array<{ caseId?: string; category: string; verified: boolean }>;
  cost: { value: number | null; tracked: boolean; unit: string };
  approvals: unknown[];
  risk: string;
  decisionTrace: unknown;
}

export default function ReadOnlyRunReport(): JSX.Element {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const shareToken = params.get('share') ?? '';
  const [report, setReport] = useState<ReportSummary | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    api.get<ReportSummary>(`/runs/${id}/report?share=${encodeURIComponent(shareToken)}`)
      .then((r) => { if (alive) setReport(r); })
      .catch((e: Error) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [id, shareToken]);

  return (
    <div className="layout-solo">
      <div className="content">
        <h1 className="page-title">分享报告</h1>
        <div className="page-sub mono">{id} · 只读视图（经分享链接授权访问）</div>
        {error && <div className="error-banner">{error}</div>}
        {!report && !error && <Empty text="加载中…" />}
        {report && (
          <>
            <Card title="Run 信息">
              <Table head={['字段', '值']}>
                <tr><td>Run ID</td><td className="mono">{report.runId}</td></tr>
                <tr><td>项目</td><td className="mono">{report.projectId}</td></tr>
                <tr><td>环境</td><td>{report.environment}</td></tr>
                <tr><td>触发</td><td>{report.trigger}</td></tr>
                <tr><td>状态</td><td><StatusBadge status={report.status} /></td></tr>
                <tr><td>创建</td><td>{fmtTime(report.createdAt)}</td></tr>
                <tr><td>完成</td><td>{fmtTime(report.finishedAt)}</td></tr>
              </Table>
            </Card>

            <Card title="关键结论">
              <div className="metric-grid">
                <Metric label="Release 决策" value={report.releaseDecision?.decision ?? '—'} />
                <Metric label="风险" value={report.risk} />
                <Metric label="覆盖" value={`${report.coverage.completed}/${report.coverage.total}`} />
                <Metric label="失败" value={String(report.coverage.failed)} />
                <Metric label="RCA" value={String(report.rca.length)} />
                <Metric label="成本" value={report.cost.tracked ? `${report.cost.value} ${report.cost.unit}` : '未跟踪'} />
                <Metric label="耗时" value={report.durationMs != null ? `${(report.durationMs / 1000).toFixed(1)}s` : '—'} />
              </div>
              {report.releaseDecision && (
                <Table head={['决策', '结果', '原因']}>
                  <tr>
                    <td><StatusBadge status={report.releaseDecision.decision} /></td>
                    <td>{report.releaseDecision.result}</td>
                    <td>{report.releaseDecision.reason ?? '—'}</td>
                  </tr>
                </Table>
              )}
            </Card>

            {report.failures.length > 0 && (
              <Card title="失败明细">
                <Table head={['Case', '分类', '原因']}>
                  {report.failures.map((f, i) => (
                    <tr key={i}>
                      <td className="mono">{f.caseId ?? '—'}</td>
                      <td>{f.category ?? '—'}</td>
                      <td>{f.reason ?? '—'}</td>
                    </tr>
                  ))}
                </Table>
              </Card>
            )}

            {report.rca.length > 0 && (
              <Card title="RCA">
                <Table head={['Case', 'RCA 分类', '已验证']}>
                  {report.rca.map((r, i) => (
                    <tr key={i}>
                      <td className="mono">{r.caseId ?? '—'}</td>
                      <td>{r.category}</td>
                      <td>{r.verified ? '是' : '待确认'}</td>
                    </tr>
                  ))}
                </Table>
              </Card>
            )}

            {report.decisionTrace ? <Card title="DecisionTrace"><JsonBlock data={report.decisionTrace as Record<string, unknown>} /></Card> : null}

            <Card title="导出">
              <div className="btn-group">
                <a className="btn btn-sm" href={`/runs/${id}/report/export?format=json&share=${encodeURIComponent(shareToken)}`} target="_blank" rel="noreferrer">Export JSON</a>
                <a className="btn btn-sm" href={`/runs/${id}/report/export?format=html&share=${encodeURIComponent(shareToken)}`} target="_blank" rel="noreferrer">Export HTML</a>
              </div>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="metric-card">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
    </div>
  );
}
