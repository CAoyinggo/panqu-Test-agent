// Phase 46：AI Improvement（AI 持续改进闭环）Dashboard
// 数据源：GET /ai-feedback /ai-errors /ai-improvements /prompts /models /experiments /knowledge/review /ai-quality
// 展示：待核验反馈 / 错误聚类 / 改进提案 / Prompt·Model 版本 / Shadow·Canary 实验 / 知识 Review / AI 质量聚合
// 人工门禁：verify / approve / reject / 创建实验 仅 RELEASE_APPROVE 角色（RELEASE_MANAGER / ADMIN）可操作，
//          非审批角色只读（按钮禁用并提示），禁止 AI 自批。
import { useEffect, useMemo, useState } from 'react';
import {
  getAIFeedback, verifyAIFeedback, getAIErrors, getAIImprovements, approveImprovement, rejectImprovement,
  getPrompts, getModels, getExperiments, createExperiment, getKnowledgeReview, getAIQuality,
  getContinuousEvals, runContinuousEval,
  getBenchmarkCandidates, bridgeBenchmarkCandidates, approveBenchmarkCandidate, rejectBenchmarkCandidate, mergeBenchmarkCandidates,
  type AIFeedbackItem, type AIErrorCluster, type ImprovementProposalItem, type PromptVersionItem,
  type ModelVersionItem, type ExperimentItem, type KnowledgeReview, type AIQualityReport,
  type ContinuousEvalList, type BenchmarkCandidateItem, type BenchmarkMergeResult,
} from '../api';
import { getStoredUser } from '../api';
import { Card, Table, Badge, StatusBadge, Empty, MetricCard, fmtTime } from '../components/ui';

const TABS = [
  { key: 'feedback', label: '待核验反馈' },
  { key: 'clusters', label: '错误聚类' },
  { key: 'proposals', label: '改进提案' },
  { key: 'versions', label: 'Prompt / Model' },
  { key: 'experiments', label: 'Shadow / Canary' },
  { key: 'continuous', label: '持续评测' },
  { key: 'benchmark', label: 'Benchmark 扩充' },
  { key: 'knowledge', label: '知识 Review' },
  { key: 'quality', label: 'AI 质量' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

const pct = (n: number | undefined | null): string => (n === undefined || n === null || Number.isNaN(Number(n)) ? '—' : `${(Number(n) * 100).toFixed(1)}%`);
const mono = (v: unknown): string => (v === undefined || v === null || v === '' ? '—' : String(v));

/** 是否具备 AI 审批权限（RELEASE_APPROVE：RELEASE_MANAGER / ADMIN） */
function canApprove(): boolean {
  const u = getStoredUser();
  return !!u && (u.role === 'RELEASE_MANAGER' || u.role === 'ADMIN');
}

export default function AIImprovement(): JSX.Element {
  const [tab, setTab] = useState<TabKey>('feedback');
  const [feedback, setFeedback] = useState<AIFeedbackItem[]>([]);
  const [clusters, setClusters] = useState<AIErrorCluster[]>([]);
  const [proposals, setProposals] = useState<ImprovementProposalItem[]>([]);
  const [prompts, setPrompts] = useState<PromptVersionItem[]>([]);
  const [models, setModels] = useState<ModelVersionItem[]>([]);
  const [experiments, setExperiments] = useState<ExperimentItem[]>([]);
  const [knowledge, setKnowledge] = useState<KnowledgeReview | null>(null);
  const [quality, setQuality] = useState<AIQualityReport | null>(null);
  const [continuous, setContinuous] = useState<ContinuousEvalList | null>(null);
  const [benchmark, setBenchmark] = useState<BenchmarkCandidateItem[]>([]);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');

  const approver = canApprove();

  const load = async (): Promise<void> => {
    try {
      const [f, c, p, pr, m, e, k, q, ce, bm] = await Promise.all([
        getAIFeedback(), getAIErrors(), getAIImprovements(), getPrompts(), getModels(), getExperiments(), getKnowledgeReview(), getAIQuality(), getContinuousEvals(), getBenchmarkCandidates(),
      ]);
      setFeedback(f); setClusters(c); setProposals(p); setPrompts(pr); setModels(m); setExperiments(e); setKnowledge(k); setQuality(q); setContinuous(ce); setBenchmark(bm);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => { void load(); }, []);

  const pending = useMemo(() => feedback.filter((x) => !x.verified), [feedback]);
  const unverifiedClusters = useMemo(() => clusters.filter((c) => c.count > 0), [clusters]);

  const runAction = async (id: string, fn: () => Promise<unknown>, okMsg: string): Promise<void> => {
    setBusy(id);
    setError(''); setMsg('');
    try {
      await fn();
      setMsg(okMsg);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const verify = (id: string, note: string): void => {
    void runAction(id, () => verifyAIFeedback(id, note), `反馈 ${id} 已核验`);
  };
  const approve = (id: string): void => {
    void runAction(id, () => approveImprovement(id), `提案 ${id} 已批准`);
  };
  const reject = (id: string, reason: string): void => {
    void runAction(id, () => rejectImprovement(id, reason), `提案 ${id} 已驳回`);
  };
  const runContinuous = (schedule: string): void => {
    void runAction(`ce-${schedule}`, () => runContinuousEval(schedule), `Continuous Evaluation ${schedule} 运行完成`);
  };
  const bridgeBenchmark = (): void => {
    void runAction('bm-bridge', () => bridgeBenchmarkCandidates(), 'Benchmark 失败桥接完成（真实评测失败 → 反馈 + 待审候选）');
  };
  const approveCandidate = (id: string): void => {
    void runAction(id, () => approveBenchmarkCandidate(id), `Benchmark 候选 ${id} 已批准 → 进入已验证 Ground Truth 池`);
  };
  const rejectCandidate = (id: string): void => {
    void runAction(id, () => rejectBenchmarkCandidate(id, 'Web 人工驳回'), `Benchmark 候选 ${id} 已驳回`);
  };
  const mergeCandidates = (): void => {
    void runAction('bm-merge', () => mergeBenchmarkCandidates(), 'Benchmark 扩充并入完成（已批准候选 → 新 Benchmark 版本）');
  };

  const pendingProposals = proposals.filter((p) => p.status === 'EVALUATING' && p.gateVerdict === 'PASS');
  const approvedProposals = proposals.filter((p) => p.status === 'APPROVED');

  return (
    <div>
      <h1 className="page-title">AI Improvement</h1>
      <div className="page-sub">AI 质量优化 · 反馈学习 · 持续改进闭环（Feedback → 聚类 → 提案 → 评测 → 审批 → Shadow → Canary → 回滚）</div>
      {!approver && <div className="info-banner">当前为只读视角：核验 / 审批 / 创建实验需 RELEASE_MANAGER 或 ADMIN 权限（人工门禁，禁止 AI 自批）。</div>}
      {error && <div className="error-banner">{error}</div>}
      {msg && <div className="success-banner">{msg}</div>}

      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.key} className={`btn btn-sm${tab === t.key ? ' btn-active' : ' btn-ghost'}`} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
        <button className="btn btn-sm btn-ghost" onClick={() => void load()}>刷新</button>
      </div>

      {tab === 'feedback' && (
        <Card title={`待核验反馈（${pending.length}）`}>
          {pending.length === 0 && <Empty text="暂无待核验反馈" />}
          {pending.length > 0 && (
            <Table head={['ID', '领域', '类型', '预测', '真值', '来源', '操作']}>
              {pending.map((f) => (
                <tr key={f.id}>
                  <td className="mono">{f.id}</td>
                  <td>{f.domain}</td>
                  <td><Badge kind="warn">{f.feedbackType}</Badge></td>
                  <td className="mono">{mono(f.prediction)}</td>
                  <td className="mono">{mono(f.actual)}</td>
                  <td>{f.source}{f.channel ? `/${f.channel}` : ''}</td>
                  <td>
                    <button className="btn btn-sm btn-ok" disabled={!approver || busy === f.id} onClick={() => verify(f.id, 'Web 人工核验')}>
                      {busy === f.id ? '核验中…' : '核验'}
                    </button>
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}

      {tab === 'clusters' && (
        <Card title={`错误聚类（${unverifiedClusters.length}）`}>
          {unverifiedClusters.length === 0 && <Empty text="暂无错误聚类（无未正确反馈）" />}
          {unverifiedClusters.length > 0 && (
            <Table head={['Cluster', '领域', '分类', '次数', '用例', '疑似根因']}>
              {unverifiedClusters.map((c) => (
                <tr key={c.id}>
                  <td className="mono">{c.id}</td>
                  <td>{c.domain}</td>
                  <td><Badge kind="err">{c.category}</Badge></td>
                  <td>{c.count}</td>
                  <td className="cell-clip">{c.cases.slice(0, 3).join(', ') || '—'}</td>
                  <td className="cell-clip">{c.suspectedCause || '—'}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}

      {tab === 'proposals' && (
        <>
          <Card title={`可审批提案（Gate PASS，${pendingProposals.length}）`}>
            {pendingProposals.length === 0 && <Empty text="暂无 Gate PASS 的可审批提案（需先离线评测）" />}
            {pendingProposals.length > 0 && (
              <Table head={['ID', '目标', '风险', '问题', 'Baseline', 'Candidate', '操作']}>
                {pendingProposals.map((p) => (
                  <tr key={p.id}>
                    <td className="mono">{p.id}</td>
                    <td>{p.target}</td>
                    <td><Badge kind={p.risk === 'HIGH' ? 'err' : p.risk === 'MEDIUM' ? 'warn' : 'ok'}>{p.risk}</Badge></td>
                    <td className="cell-clip">{p.problem}</td>
                    <td>{pct(p.baselineScore)}</td>
                    <td>{pct(p.candidateScore)}</td>
                    <td>
                      <button className="btn btn-sm btn-ok" disabled={!approver || busy === p.id} onClick={() => approve(p.id)}>批准</button>{' '}
                      <button className="btn btn-sm btn-danger" disabled={!approver || busy === p.id} onClick={() => reject(p.id, 'Web 人工驳回')}>驳回</button>
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
          <Card title={`已审批 / 进行中（${proposals.filter((p) => ['APPROVED', 'ACTIVATED', 'ROLLED_BACK', 'EVALUATING', 'PROPOSED'].includes(p.status)).length}）`}>
            {proposals.length === 0 && <Empty text="暂无提案" />}
            {proposals.length > 0 && (
              <Table head={['ID', '目标', '状态', 'Gate', 'Benchmark', '审批人']}>
                {proposals.map((p) => (
                  <tr key={p.id}>
                    <td className="mono">{p.id}</td>
                    <td>{p.target}</td>
                    <td><StatusBadge status={p.status} /></td>
                    <td>{p.gateVerdict ?? '—'}</td>
                    <td className="cell-clip">{p.benchmark ? `${p.benchmark}@${p.benchmarkVersion ?? ''}` : '—'}</td>
                    <td>{p.approvedBy || '—'}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        </>
      )}

      {tab === 'versions' && (
        <>
          <Card title={`Prompt Versions（${prompts.length}）`}>
            {prompts.length === 0 && <Empty text="暂无 Prompt 版本" />}
            {prompts.length > 0 && (
              <Table head={['ID', 'Key', '版本', '状态', 'Benchmark', '创建人']}>
                {prompts.map((p) => (
                  <tr key={p.id}>
                    <td className="mono">{p.id}</td>
                    <td>{p.promptKey}</td>
                    <td>{p.version}</td>
                    <td><StatusBadge status={p.status} /></td>
                    <td>{pct(p.benchmarkScore)}</td>
                    <td>{p.createdBy}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
          <Card title={`Model Versions（${models.length}）`}>
            {models.length === 0 && <Empty text="暂无 Model 版本" />}
            {models.length > 0 && (
              <Table head={['ID', 'Provider', 'Model', 'Version', '状态']}>
                {models.map((m) => (
                  <tr key={m.id}>
                    <td className="mono">{m.id}</td>
                    <td>{m.provider}</td>
                    <td>{m.model}</td>
                    <td>{m.modelVersion}</td>
                    <td><StatusBadge status={m.status} /></td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        </>
      )}

      {tab === 'experiments' && (
        <Card title={`Shadow / Canary 实验（${experiments.length}）`}>
          {experiments.length === 0 && <Empty text="暂无实验" />}
          {experiments.length > 0 && (
            <Table head={['ID', '类型', '状态', '阶段', '提案', '候选', '说明']}>
              {experiments.map((e) => (
                <tr key={e.id}>
                  <td className="mono">{e.id}</td>
                  <td><Badge kind={e.type === 'CANARY' ? 'info' : 'muted'}>{e.type}</Badge></td>
                  <td><StatusBadge status={e.status} /></td>
                  <td>{e.canaryStage ?? '—'}</td>
                  <td className="mono">{e.proposalId}</td>
                  <td className="mono">{e.candidateRef}</td>
                  <td className="cell-clip">{e.rollbackReason || e.activatedAt ? `激活 ${fmtTime(e.activatedAt)}` : '—'}</td>
                </tr>
              ))}
            </Table>
          )}
          {approvedProposals.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div className="section-title">创建实验（已审批提案）</div>
              <Table head={['提案', '目标', '操作']}>
                {approvedProposals.map((p) => (
                  <tr key={p.id}>
                    <td className="mono">{p.id}</td>
                    <td>{p.target}</td>
                    <td>
                      <button className="btn btn-sm" disabled={!approver || busy === p.id} onClick={() => void runAction(p.id, () => createExperiment('SHADOW', p.id, `${p.target.toLowerCase()}-candidate`), `Shadow 实验已创建（${p.id}）`)}>
                        Shadow
                      </button>{' '}
                      <button className="btn btn-sm" disabled={!approver || busy === p.id} onClick={() => void runAction(p.id, () => createExperiment('CANARY', p.id, `${p.target.toLowerCase()}-candidate`), `Canary 实验已创建（${p.id}）`)}>
                        Canary
                      </button>
                    </td>
                  </tr>
                ))}
              </Table>
            </div>
          )}
        </Card>
      )}

      {tab === 'continuous' && (
        <>
          <Card title={`Continuous Evaluation（${continuous?.total ?? 0} 次运行）`}>
            <div className="metric-grid">
              <MetricCard label="最近 Overall" value={pct(continuous?.runs[0]?.current.overall)} />
              <MetricCard label="最近判定" value={continuous?.runs[0]?.regression.verdict ?? '—'} hint={continuous?.runs[0]?.regression.reasons.slice(0, 2).join(' · ')} />
              <MetricCard label="Alert" value={continuous?.runs[0]?.alertSent ? '已发出' : '无'} hint="Critical Regression 需告警" />
              <MetricCard label="Block Release" value={continuous?.runs[0]?.releaseBlocked ? '已阻断' : '未阻断'} hint="verdict=BLOCK 时阻断发布" />
            </div>
            {continuous && continuous.runs.length > 0 && (
              <Table head={['ID', 'Schedule', '触发', 'Overall', '判定', 'P0 Miss', 'False Pass', 'Alert', 'Block', '时间']}>
                {continuous.runs.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">{r.id}</td>
                    <td><Badge kind={r.schedule === 'RELEASE' ? 'warn' : 'info'}>{r.schedule}</Badge></td>
                    <td>{r.triggeredBy}</td>
                    <td>{pct(r.baseline.overall)} → {pct(r.current.overall)}</td>
                    <td><Badge kind={r.regression.verdict === 'BLOCK' ? 'err' : r.regression.verdict === 'REVIEW' ? 'warn' : 'ok'}>{r.regression.verdict}</Badge></td>
                    <td>{r.current.critical.p0Miss}</td>
                    <td>{r.current.critical.falsePass}</td>
                    <td>{r.alertSent ? '是' : '否'}</td>
                    <td>{r.releaseBlocked ? '是' : '否'}</td>
                    <td>{fmtTime(r.createdAt)}</td>
                  </tr>
                ))}
              </Table>
            )}
            {(!continuous || continuous.runs.length === 0) && <Empty text="暂无运行记录。可手动触发一次以建立基线。" />}
          </Card>
          <Card title="手动触发（Nightly / Weekly / Release）">
            <div style={{ display: 'flex', gap: 8 }}>
              {(['NIGHTLY', 'WEEKLY', 'RELEASE'] as const).map((s) => (
                <button key={s} className="btn btn-sm" disabled={!approver || busy === `ce-${s}`} onClick={() => runContinuous(s)}>
                  {busy === `ce-${s}` ? '运行中…' : `运行 ${s}`}
                </button>
              ))}
            </div>
            <div className="muted" style={{ marginTop: 8 }}>
              手动触发需 RELEASE_MANAGER 或 ADMIN（人工门禁）。定时触发由 Nightly / Weekly / Release 调度（{continuous?.schedules.map((s) => `${s.name} ${s.cronLike}`).join(' · ') ?? '—'}）执行，无需人工。
            </div>
          </Card>
        </>
      )}

      {tab === 'benchmark' && (
        <>
          <Card title={`Benchmark 扩充候选（${benchmark.filter((b) => b.status === 'PENDING_REVIEW').length} 待审 / 共 ${benchmark.length}）`}>
            <div className="metric-grid">
              <MetricCard label="待审" value={benchmark.filter((b) => b.status === 'PENDING_REVIEW').length} />
              <MetricCard label="已批准" value={benchmark.filter((b) => b.status === 'APPROVED').length} hint="已并入已验证 Ground Truth 池" />
              <MetricCard label="已并入" value={benchmark.filter((b) => b.status === 'MERGED').length} hint="已落地到 Benchmark 新版本" />
              <MetricCard label="已驳回" value={benchmark.filter((b) => b.status === 'REJECTED').length} />
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <button className="btn btn-sm" disabled={!approver || busy === 'bm-bridge'} onClick={bridgeBenchmark}>
                {busy === 'bm-bridge' ? '桥接中…' : '运行真实评测并桥接失败'}
              </button>
              <button className="btn btn-sm btn-ok" disabled={!approver || busy === 'bm-merge' || benchmark.filter((b) => b.status === 'APPROVED').length === 0} onClick={mergeCandidates}>
                {busy === 'bm-merge' ? '并入中…' : '并入已批准候选 → 新 Benchmark 版本'}
              </button>
            </div>
            <div className="muted" style={{ marginBottom: 8 }}>
              真实失败用例自动生成候选；批准后进入已验证 Ground Truth 池，「并入」把已批准候选落地为该领域 Benchmark 新版本（v2 / v3 …）。桥接 / 批准 / 驳回 / 并入需 RELEASE_MANAGER 或 ADMIN（禁止 AI 自批/自动并库）。
            </div>
            {benchmark.length === 0 && <Empty text="暂无 Benchmark 扩充候选。可点击上方按钮运行真实评测并把失败用例桥接为候选。" />}
            {benchmark.length > 0 && (
              <Table head={['ID', '领域', '用例', '期望', '实际', '来源', '状态', '并入凭据', '操作']}>
                {benchmark.map((b) => (
                  <tr key={b.id}>
                    <td className="mono">{b.id}</td>
                    <td>{b.domain}</td>
                    <td className="mono">{b.caseId}</td>
                    <td className="mono cell-clip">{mono(b.expected)}</td>
                    <td className="mono cell-clip">{mono(b.actual)}</td>
                    <td>{b.source}</td>
                    <td><StatusBadge status={b.status} /></td>
                    <td className="mono cell-clip">{b.mergedBenchmark ? `${b.mergedBenchmark} / ${b.mergedCaseId ?? ''}` : '—'}</td>
                    <td>
                      {b.status === 'PENDING_REVIEW' ? (
                        <>
                          <button className="btn btn-sm btn-ok" disabled={!approver || busy === b.id} onClick={() => approveCandidate(b.id)}>批准</button>{' '}
                          <button className="btn btn-sm btn-danger" disabled={!approver || busy === b.id} onClick={() => rejectCandidate(b.id)}>驳回</button>
                        </>
                      ) : (
                        <span className="muted">{b.reviewer ? `by ${b.reviewer}` : '—'}{b.reason ? `：${b.reason}` : ''}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        </>
      )}

      {tab === 'knowledge' && (
        <>
          <Card title={`知识 Review（待审候选 ${knowledge?.candidates.length ?? 0} / 生产知识 ${knowledge?.items.length ?? 0}）`}>
            <div className="metric-grid">
              <MetricCard label="总知识" value={knowledge?.quality.total ?? 0} />
              <MetricCard label="总使用" value={knowledge?.quality.totalUsages ?? 0} />
              <MetricCard label="成功率" value={pct(knowledge?.quality.successRate)} />
              <MetricCard label="未使用率" value={pct(knowledge?.quality.unusedRate)} />
            </div>
            {knowledge && knowledge.candidates.length > 0 && (
              <Table head={['候选 ID', '类别', '来源', '置信度', '状态', '内容']}>
                {knowledge.candidates.map((c) => (
                  <tr key={c.id}>
                    <td className="mono">{c.id}</td>
                    <td>{c.category}</td>
                    <td>{c.source}</td>
                    <td>{pct(c.confidence)}</td>
                    <td><StatusBadge status={c.status} /></td>
                    <td className="cell-clip">{c.content}</td>
                  </tr>
                ))}
              </Table>
            )}
            {(!knowledge || knowledge.candidates.length === 0) && <Empty text="暂无待审知识候选（错误需先人工核验才可沉淀候选）" />}
          </Card>
        </>
      )}

      {tab === 'quality' && (
        <>
          <Card title="AI Quality 聚合">
            <div className="metric-grid">
              <MetricCard label="Accuracy" value={pct(quality?.accuracy)} />
              <MetricCard label="False Pass" value={quality?.falsePass ?? 0} hint="非 0 即安全风险" />
              <MetricCard label="P0 Miss" value={quality?.p0Miss ?? 0} hint="非 0 即安全风险" />
              <MetricCard label="RCA Accuracy" value={pct(quality?.rcaAccuracy)} />
              <MetricCard label="Selection Recall" value={pct(quality?.selectionRecall)} />
              <MetricCard label="Defect Quality" value={pct(quality?.defectQuality)} />
              <MetricCard label="Healing Safety" value={pct(quality?.healingSafety)} />
              <MetricCard label="成本" value={quality?.cost ?? 0} hint="美元" />
            </div>
          </Card>
          <Card title="闭环进度">
            <div className="metric-grid">
              <MetricCard label="反馈" value={quality?.feedback.total ?? 0} hint={`已核验 ${quality?.feedback.verified ?? 0} · 错误聚类 ${quality?.feedback.errorClusters ?? 0}`} />
              <MetricCard label="提案" value={quality?.proposals.total ?? 0} hint={Object.entries(quality?.proposals.byStatus ?? {}).map(([k, v]) => `${k}=${v}`).join(' · ') || '无'} />
              <MetricCard label="实验" value={quality?.experiments.total ?? 0} hint={`Shadow ${quality?.experiments.shadow ?? 0} · Canary ${quality?.experiments.canary ?? 0}`} />
              <MetricCard label="知识" value={quality?.knowledge.active ?? 0} hint={`候选 ${quality?.knowledge.candidates ?? 0}`} />
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
