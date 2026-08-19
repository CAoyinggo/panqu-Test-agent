// QA Home（Phase 39.7）：QA 工作台——告诉 QA “现在应该做什么”
// Action Center + 快速操作 + 我的项目 / 今日 Runs / 失败 Runs / 待审批 / 常用 Plan / Template / Flaky / 高风险
import { Link } from 'react-router-dom';
import { api } from '../api';
import { usePolling } from '../hooks/usePolling';
import { Card, StatusBadge, Table, Badge, Empty, fmtTime } from '../components/ui';

interface ActionItem {
  id: string;
  category: string;
  severity: string;
  title: string;
  detail: string;
  target: string;
}

interface QaHomeData {
  projects: Array<{ id: string; name: string }>;
  todayRuns: number;
  runningRuns: Array<{ runId: string; projectId: string; environment: string; progress: number }>;
  failedRuns: Array<{ runId: string; projectId: string; environment: string; status: string }>;
  pendingApprovals: Array<{ approvalId: string; action: string; riskLevel: string; environment: string; reason: string }>;
  recentFailures: Array<{ runId: string; projectId: string; environment: string }>;
  recentDefects: Array<{ defectId: string; title: string; severity: string; status: string }>;
  recentReleases: Array<{ runId: string; projectId: string; decision: string }>;
  commonPlans: Array<{ id: string; name: string; mode: string }>;
  commonTemplates: Array<{ id: string; name: string; mode: string; runCount: number }>;
  flakyCases: Array<{ caseId: string; flakeRate: number }>;
  highRiskCases: Array<{ caseId: string; risk: string }>;
  actionCenter: ActionItem[];
}

const SEVERITY_KIND: Record<string, 'err' | 'warn' | 'info' | 'muted'> = {
  CRITICAL: 'err',
  HIGH: 'err',
  MEDIUM: 'warn',
  LOW: 'info',
};

export default function QAHome(): JSX.Element {
  const { data, error } = usePolling<QaHomeData>(() => api.get<QaHomeData>('/qa-home'), 3000);

  return (
    <div>
      <div className="page-title">QA 工作台</div>
      <div className="page-sub">告诉我现在该做什么 · 每 3 秒刷新</div>
      {error && <div className="error-banner">{error}</div>}
      {!data && !error && <Empty text="加载中…" />}
      {data && (
        <>
          {/* 快速操作 */}
          <div className="metric-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
            <Link className="btn btn-sm" to="/suites/new">+ 新建 Suite</Link>
            <Link className="btn btn-sm" to="/plans/new">+ 新建 Test Plan</Link>
            <Link className="btn btn-sm" to="/templates/new">+ 新建 Run Template</Link>
            <Link className="btn btn-sm" to="/runs">历史 Runs</Link>
            <Link className="btn btn-sm" to="/approvals">待审批</Link>
          </div>

          {/* Action Center */}
          <Card title={`Action Center（${data.actionCenter.length} 项待处理）`}>
            {data.actionCenter.length === 0 && <Empty text="暂无待处理事项 🎉" />}
            {data.actionCenter.length > 0 && (
              <Table head={['级别', '事项', '说明', '直达']}>
                {data.actionCenter.map((a) => (
                  <tr key={a.id}>
                    <td><Badge kind={SEVERITY_KIND[a.severity] ?? 'muted'}>{a.severity}</Badge></td>
                    <td>{a.title}</td>
                    <td>{a.detail}</td>
                    <td>{actionTarget(a)}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>

          <div className="metric-grid">
            <Metric label="今日 Runs" value={String(data.todayRuns)} />
            <Metric label="进行中 Runs" value={String(data.runningRuns.length)} />
            <Metric label="失败 Runs" value={String(data.failedRuns.length)} />
            <Metric label="待处理审批" value={String(data.pendingApprovals.length)} />
          </div>

          <div className="grid-2">
            <Card title="我的项目">
              <Table head={['项目', '操作']}>
                {data.projects.map((p) => (
                  <tr key={p.id}>
                    <td className="mono">{p.id}</td>
                    <td><Link className="link" to={`/runs?project=${p.id}`}>看 Runs</Link></td>
                  </tr>
                ))}
              </Table>
            </Card>
            <Card title="进行中 Runs">
              {data.runningRuns.length === 0 && <Empty text="无进行中 Run" />}
              {data.runningRuns.length > 0 && (
                <Table head={['Run', '项目', '环境', '进度']}>
                  {data.runningRuns.map((r) => (
                    <tr key={r.runId}>
                      <td className="mono"><Link className="link" to={`/runs/${r.runId}`}>{r.runId}</Link></td>
                      <td className="mono">{r.projectId}</td>
                      <td>{r.environment}</td>
                      <td>{r.progress}%</td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>
          </div>

          <div className="grid-2">
            <Card title="最近失败 Runs">
              {data.failedRuns.length === 0 && <Empty text="无失败 Run" />}
              {data.failedRuns.length > 0 && (
                <Table head={['Run', '项目', '环境', '状态']}>
                  {data.failedRuns.map((r) => (
                    <tr key={r.runId}>
                      <td className="mono"><Link className="link" to={`/runs/${r.runId}`}>{r.runId}</Link></td>
                      <td className="mono">{r.projectId}</td>
                      <td>{r.environment}</td>
                      <td><StatusBadge status={r.status} /></td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>
            <Card title="待处理 Approval">
              {data.pendingApprovals.length === 0 && <Empty text="无待审批" />}
              {data.pendingApprovals.length > 0 && (
                <Table head={['动作', '风险', '环境', '原因']}>
                  {data.pendingApprovals.map((a) => (
                    <tr key={a.approvalId}>
                      <td>{a.action}</td>
                      <td><StatusBadge status={a.riskLevel} /></td>
                      <td>{a.environment}</td>
                      <td>{a.reason}</td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>
          </div>

          <div className="grid-2">
            <Card title="常用 Test Plan">
              {data.commonPlans.length === 0 && <Empty text="暂无常用 Plan" />}
              {data.commonPlans.length > 0 && (
                <Table head={['名称', '模式']}>
                  {data.commonPlans.map((p) => (
                    <tr key={p.id}>
                      <td>{p.name}</td>
                      <td><StatusBadge status={p.mode} /></td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>
            <Card title="常用 Template">
              {data.commonTemplates.length === 0 && <Empty text="暂无常用 Template" />}
              {data.commonTemplates.length > 0 && (
                <Table head={['名称', '模式', '复用']}>
                  {data.commonTemplates.map((t) => (
                    <tr key={t.id}>
                      <td>{t.name}</td>
                      <td><StatusBadge status={t.mode} /></td>
                      <td>{t.runCount}</td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>
          </div>

          <div className="grid-2">
            <Card title="Flaky Cases">
              {data.flakyCases.length === 0 && <Empty text="暂无 Flaky" />}
              {data.flakyCases.length > 0 && (
                <Table head={['Case', 'Flake 率']}>
                  {data.flakyCases.map((f) => (
                    <tr key={f.caseId}>
                      <td className="mono">{f.caseId}</td>
                      <td>{(f.flakeRate * 100).toFixed(0)}%</td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>
            <Card title="高风险 Cases">
              {data.highRiskCases.length === 0 && <Empty text="暂无高风险 Case" />}
              {data.highRiskCases.length > 0 && (
                <Table head={['Case', '风险']}>
                  {data.highRiskCases.map((h) => (
                    <tr key={h.caseId}>
                      <td className="mono">{h.caseId}</td>
                      <td><StatusBadge status={h.risk} /></td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>
          </div>
        </>
      )}
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

function actionTarget(a: ActionItem): JSX.Element {
  if (a.category === 'RELEASE') return <Link className="link" to={`/approvals`}>去审批</Link>;
  if (a.category === 'APPROVAL') return <Link className="link" to={`/approvals`}>去审批</Link>;
  if (a.category === 'FAILURE') return <Link className="link" to={`/runs/${a.target}`}>处理失败</Link>;
  if (a.category === 'WORKER') return <Link className="link" to={`/workers`}>检查 Worker</Link>;
  if (a.category === 'FLAKY') return <Link className="link" to={`/runs`}>确认 Flaky</Link>;
  if (a.category === 'RCA') return <Link className="link" to={`/runs/${a.target}`}>确认 RCA</Link>;
  return <span>{a.detail}</span>;
}
