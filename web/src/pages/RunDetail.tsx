// Run Detail（Phase 39 增强）：报告摘要 / Run Again / Clone / Save Template / Share / Export / 协作评论
import { useEffect, useState } from 'react';
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
    mode?: string;
    budget?: number;
    releaseGate?: boolean;
    planId?: string;
    suiteIds?: string[];
    templateId?: string;
    assetVersion?: Record<string, number>;
    createdAt: string;
    startedAt?: string;
    finishedAt?: string;
  };
  trace?: unknown;
  checkpoint?: unknown;
  approvals?: Array<{ approvalId: string; action: string; riskLevel: string; status: string; decidedBy?: string; decidedAt?: string }>;
}

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

interface CommentEntry {
  id: string;
  actor: string;
  text: string;
  mentions: string[];
  createdAt: string;
}

export default function RunDetail(): JSX.Element {
  const { id = '' } = useParams();
  const { data, error, refresh } = usePolling<RunDetailData>(() => api.get<RunDetailData>(`/runs/${id}/detail`), 2000);
  const [report, setReport] = useState<ReportSummary | null>(null);
  const [share, setShare] = useState<{ token: string; url: string } | null>(null);
  const [comments, setComments] = useState<CommentEntry[]>([]);
  const [comment, setComment] = useState('');
  const [msg, setMsg] = useState('');

  const loadReport = async (): Promise<void> => {
    try {
      const r = await api.get<ReportSummary>(`/runs/${id}/report`);
      setReport(r);
    } catch { setReport(null); }
  };
  const loadComments = async (): Promise<void> => {
    try {
      const c = await api.get<CommentEntry[]>(`/runs/${id}/comments`);
      setComments(Array.isArray(c) ? c : []);
    } catch { setComments([]); }
  };
  // 41.17：报告/评论只应在挂载/切换 Run 时加载一次；此前在每次渲染都调用 init，
  //        loadReport 的 setReport 又触发重渲染 → 无限循环 → 2s 内刷爆 API 限流(429)。
  useEffect(() => {
    let alive = true;
    const run = async (): Promise<void> => {
      await loadReport();
      if (alive) await loadComments();
    };
    void run();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const doRunAgain = async (): Promise<void> => {
    const r = await api.post<{ runId: string; status: string }>(`/runs/${id}/rerun`);
    setMsg(`Run Again → ${r.runId}（${r.status}，仅复制配置）`);
  };
  const doClone = async (): Promise<void> => {
    const r = await api.post<{ runId: string; status: string }>(`/runs/${id}/clone`);
    setMsg(`Clone Configuration → ${r.runId}（${r.status}）`);
  };
  const doSaveTemplate = async (): Promise<void> => {
    const r = await api.post<{ id: string; name: string }>(`/runs/${id}/template`, { name: `${data?.run.projectId ?? 'run'} 模板` });
    setMsg(`已保存模板：${r.name}（${r.id}）`);
  };
  const doShare = async (): Promise<void> => {
    const r = await api.post<{ token: string; url: string }>(`/runs/${id}/share`);
    setShare(r); setMsg('已生成分享链接');
  };
  const doComment = async (): Promise<void> => {
    if (!comment.trim()) return;
    const r = await api.post<{ mentions: string[] }>(`/runs/${id}/comments`, { text: comment });
    setMsg(r.mentions.length ? `已评论并 @${r.mentions.join('、')}（已通知）` : '已评论');
    setComment(''); await loadComments();
  };

  return (
    <div>
      <h1 className="page-title">执行详情</h1>
      <div className="page-sub mono">{id} · 每 2 秒刷新</div>
      {error && <div className="error-banner">{error}</div>}
      {msg && <div className="ok-banner">{msg}</div>}
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
              <tr><td>模式</td><td>{data.run.mode ?? '—'}</td></tr>
              <tr><td>Budget</td><td>{data.run.budget ?? '—'}</td></tr>
              <tr><td>Release Gate</td><td>{data.run.releaseGate ? '开' : '—'}</td></tr>
              <tr><td>Plan</td><td className="mono">{data.run.planId ?? '—'}</td></tr>
              <tr><td>Suites</td><td className="mono">{(data.run.suiteIds ?? []).join(', ') || '—'}</td></tr>
              <tr><td>Template</td><td className="mono">{data.run.templateId ?? '—'}</td></tr>
              <tr><td>Asset 版本</td><td className="mono">{JSON.stringify(data.run.assetVersion ?? {})}</td></tr>
              <tr><td>创建</td><td>{fmtTime(data.run.createdAt)}</td></tr>
              <tr><td>完成</td><td>{fmtTime(data.run.finishedAt)}</td></tr>
            </Table>
          </Card>

          <Card title="快速复用">
            <div className="btn-group">
              <button className="btn btn-sm" onClick={() => void doRunAgain()}>Run Again</button>
              <button className="btn btn-sm" onClick={() => void doClone()}>Clone Configuration</button>
              <button className="btn btn-sm" onClick={() => void doSaveTemplate()}>Create Template</button>
              <button className="btn btn-sm" onClick={() => void doShare()}>Share Report</button>
              {share && (
                <a className="link mono" href={share.url} target="_blank" rel="noreferrer">{share.url}</a>
              )}
              <a className="btn btn-sm" href={`/runs/${id}/report/export?format=json`} target="_blank" rel="noreferrer">Export JSON</a>
              <a className="btn btn-sm" href={`/runs/${id}/report/export?format=html`} target="_blank" rel="noreferrer">Export HTML</a>
            </div>
          </Card>

          {report && (
            <Card title="报告摘要（关键结论）">
              <div className="metric-grid">
                <Metric label="Release 决策" value={report.releaseDecision?.decision ?? '—'} />
                <Metric label="风险" value={report.risk} />
                <Metric label="覆盖" value={`${report.coverage.completed}/${report.coverage.total}`} />
                <Metric label="失败" value={String(report.coverage.failed)} />
                <Metric label="RCA" value={String(report.rca.length)} />
                <Metric label="成本" value={report.cost.tracked ? `${report.cost.value} ${report.cost.unit}` : '未跟踪 (tracked=false)'} />
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
              {report.failures.length > 0 && (
                <Table head={['Case', '原因', 'RCA 分类']}>
                  {report.failures.map((f, i) => (
                    <tr key={i}>
                      <td className="mono">{f.caseId ?? '—'}</td>
                      <td>{f.reason ?? '—'}</td>
                      <td>{f.category ?? '—'}</td>
                    </tr>
                  ))}
                </Table>
              )}
              {report.rca.length > 0 && (
                <Table head={['Case', 'RCA 分类', '已验证']}>
                  {report.rca.map((r, i) => (
                    <tr key={i}>
                      <td className="mono">{r.caseId ?? '—'}</td>
                      <td>{r.category}</td>
                      <td>{r.verified ? '是' : '待确认'}</td>
                    </tr>
                  ))}
                </Table>
              )}
              {report.decisionTrace ? <div className="small muted">DecisionTrace（为什么选/跳/败/重规划/停）：<JsonBlock data={report.decisionTrace as Record<string, unknown>} /></div> : null}
            </Card>
          )}

          <Card title="协作评论（@user 触发通知）">
            <div className="form-row">
              <input aria-label="评论内容（@用户名 可通知）" placeholder="输入评论，@用户名 可通知，如 @zhangsan 请确认模型服务…" value={comment} onChange={(e) => setComment(e.target.value)} />
              <button className="btn btn-sm" onClick={() => void doComment()}>评论</button>
            </div>
            {comments.length === 0 && <Empty text="暂无评论" />}
            {comments.map((c) => (
              <div key={c.id} className="comment-row">
                <span className="mono small">{c.actor}</span>
                <span className="small">{fmtTime(c.createdAt)}</span>
                {c.mentions.map((m) => <span key={m} className="badge badge-warn">@{m}</span>)}
                <div>{c.text}</div>
              </div>
            ))}
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

function Metric({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="metric-card">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
    </div>
  );
}
