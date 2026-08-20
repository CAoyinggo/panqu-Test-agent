// Phase 45：AI 质量（AI 测试质量评测）Dashboard
// 数据源：GET /api/eval/report（确定性规则评测，model=rules）
// 展示：总体分 / 8 领域分数卡片（label+score）/ 关键安全指标（非 0 红显）/ 版本信息与成本
//       点击领域展开 → results 逐条（Case ID / Passed / Score / Expected / Actual / Errors / Evidence）
//       Evidence 可点击查看 Case / Expected / Actual / Difference / Reason / Evidence
import { useEffect, useState } from 'react';
import { getEvalReport } from '../api';
import type { EvalReport, EvalDomain, EvalResult } from '../api';
import { Card, Table, Badge, Empty, MetricCard, fmtTime } from '../components/ui';

/** 领域代码兜底文案（后端 domains[].label 优先） */
const DOMAIN_LABEL: Record<string, string> = {
  REQUIREMENT: '需求质量',
  TEST_DESIGN: '测试设计',
  RISK: '风险评估',
  SELECTION: '用例选择',
  RCA: '根因分析',
  DEFECT: '缺陷管理',
  HEALING: '自愈',
  RELEASE: '发布决策',
};

/** 0~1 分数 → 百分比文案 */
function fmtScore(s: number | undefined | null): string {
  if (s === undefined || s === null || Number.isNaN(Number(s))) return '—';
  return `${(Number(s) * 100).toFixed(1)}%`;
}

function domainLabel(d: EvalDomain): string {
  return d.label || DOMAIN_LABEL[d.domain] || d.domain;
}

/** 关键安全指标卡：非 0 红显 */
function CriticalItem({ label, value }: { label: string; value: number }): JSX.Element {
  const bad = Number(value) > 0;
  return (
    <div className="metric-card">
      <div className="metric-label">{label}</div>
      <div className="metric-value" style={bad ? { color: 'var(--err)' } : undefined}>{Number(value)}</div>
      <div className="metric-track" style={bad ? { color: 'var(--err)' } : undefined}>
        {bad ? '● 命中安全风险，需处理' : '○ 无命中'}
      </div>
    </div>
  );
}

/** 结果详情：Case / Expected / Actual / Difference / Reason / Evidence */
function EvalDetail({ result, onClose }: { result: EvalResult; onClose: () => void }): JSX.Element {
  const same = String(result.expected ?? '') === String(result.actual ?? '');
  const reason = result.errors && result.errors.length > 0 ? result.errors.join('；') : '无';
  return (
    <div className="eval-detail" data-testid={`detail-${result.caseId}`}>
      <div className="eval-detail-head">
        <div className="eval-detail-title">结果详情 · {result.caseId}</div>
        <button className="btn btn-sm btn-ghost" onClick={onClose}>关闭</button>
      </div>
      <div className="row"><span className="k">用例 ID</span><span className="v mono">{result.caseId}</span></div>
      <div className="row"><span className="k">期望输出（Expected）</span><span className="v mono">{result.expected || '—'}</span></div>
      <div className="row"><span className="k">实际输出（Actual）</span><span className="v mono">{result.actual || '—'}</span></div>
      <div className="row"><span className="k">差异（Difference）</span><span className="v">{same ? '一致' : '存在差异'}</span></div>
      <div className="row"><span className="k">原因（Reason）</span><span className="v">{reason}</span></div>
      <div className="row"><span className="k">证据（Evidence）</span><span className="v mono">{result.evidence || '—'}</span></div>
    </div>
  );
}

/** 领域展开区：results 逐条表格 + Evidence 详情 */
function DomainResults({ domain }: { domain: EvalDomain }): JSX.Element {
  const [detail, setDetail] = useState<EvalResult | null>(null);
  const [failedOnly, setFailedOnly] = useState(false);
  const results = failedOnly ? domain.results.filter((r) => !r.passed) : domain.results;
  const failedCount = domain.results.filter((r) => !r.passed).length;
  return (
    <div className="domain-results">
      <div className="controls">
        <button className={`btn btn-sm${failedOnly ? ' btn-active' : ' btn-ghost'}`} onClick={() => setFailedOnly((f) => !f)}>
          {failedOnly ? '显示全部' : `仅看失败（${failedCount}）`}
        </button>
      </div>
      {detail && <EvalDetail result={detail} onClose={() => setDetail(null)} />}
      {results.length === 0 && <Empty text="该领域暂无逐条结果" />}
      {results.length > 0 && (
        <Table head={['Case ID', 'Passed', 'Score', 'Expected', 'Actual', 'Errors', 'Evidence']}>
          {results.map((r) => (
            <tr key={r.caseId}>
              <td className="mono">{r.caseId}</td>
              <td>{r.passed ? <Badge kind="ok">PASS</Badge> : <Badge kind="err">FAIL</Badge>}</td>
              <td>{fmtScore(r.score)}</td>
              <td className="cell-clip" title={r.expected}>{r.expected || '—'}</td>
              <td className="cell-clip" title={r.actual}>{r.actual || '—'}</td>
              <td>{r.errors && r.errors.length > 0 ? r.errors.join('；') : '—'}</td>
              <td>
                <button className="btn btn-sm btn-ghost" onClick={() => setDetail(r)}>查看</button>
              </td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}

/** 领域分数卡片：点击展开 / 收起 results */
function DomainCard({ domain, expanded, onToggle }: { domain: EvalDomain; expanded: boolean; onToggle: () => void }): JSX.Element {
  const label = domainLabel(domain);
  const scoreKind = domain.score >= 0.9 ? 'ok' : domain.score >= 0.7 ? 'warn' : 'err';
  return (
    <div className="domain-card">
      <button className="domain-toggle" onClick={onToggle} aria-expanded={expanded}>
        <div className="domain-main">
          <div className="domain-name">{label}</div>
          <div className="domain-bench">
            {domain.benchmark}@{domain.benchmarkVersion} · 通过 {domain.passed}/{domain.total} · 结果 {domain.results.length} 条
          </div>
        </div>
        <div className={`domain-score ${scoreKind}`}>{fmtScore(domain.score)}</div>
        <div className="domain-caret">{expanded ? '收起' : '展开'}</div>
      </button>
      {expanded && <DomainResults domain={domain} />}
    </div>
  );
}

export default function AIQuality(): JSX.Element {
  const [data, setData] = useState<EvalReport | null>(null);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        const r = await getEvalReport();
        if (alive) setData(r);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void load();
    return () => { alive = false; };
  }, []);

  const vi = data?.versionInfo;

  return (
    <div>
      <h1 className="page-title">AI 质量</h1>
      <div className="page-sub">AI 测试质量评测 · 确定性规则评测（model=rules）· 点击领域可展开逐条结果</div>
      {error && <div className="error-banner">{error}</div>}
      {!data && !error && <Empty text="加载中…" />}
      {data && (
        <>
          <div className="metric-grid">
            <MetricCard label="总体评分" value={fmtScore(data.overall)} hint={`原始分数 ${Number(data.overall).toFixed(3)}`} />
            <MetricCard label="评测成本" value={data.cost?.cost ?? 0} hint={`${data.cost?.totalTokens ?? 0} tokens · 延迟 ${data.cost?.latencyMs ?? 0} ms`} />
            <MetricCard label="报告版本" value={data.version || '—'} hint={`生成于 ${fmtTime(data.generatedAt)}`} />
            <MetricCard label="评测模型" value={vi?.model || '—'} hint={`modelVersion ${vi?.modelVersion ?? '—'}`} />
          </div>

          <Card title="关键安全指标（非 0 红显）">
            <div className="metric-grid">
              <CriticalItem label="P0 Miss" value={data.critical?.p0Miss ?? 0} />
              <CriticalItem label="False Pass" value={data.critical?.falsePass ?? 0} />
              <CriticalItem label="Unsafe Healing" value={data.critical?.unsafeHealing ?? 0} />
              <CriticalItem label="Skipped Critical" value={data.critical?.skippedCritical ?? 0} />
            </div>
          </Card>

          <Card title="版本信息">
            <Table head={['模型', 'Model 版本', 'Prompt 版本', 'Tool 版本', 'Agent 版本']}>
              <tr>
                <td className="mono">{vi?.model || '—'}</td>
                <td className="mono">{vi?.modelVersion || '—'}</td>
                <td className="mono">{vi?.promptVersion || '—'}</td>
                <td className="mono">{vi?.toolVersion || '—'}</td>
                <td className="mono">{vi?.agentVersion || '—'}</td>
              </tr>
            </Table>
          </Card>

          <h2 className="section-title">领域评测（{data.domains.length}）</h2>
          <div className="domain-grid">
            {data.domains.map((d) => (
              <DomainCard
                key={d.domain}
                domain={d}
                expanded={expanded === d.domain}
                onToggle={() => setExpanded(expanded === d.domain ? null : d.domain)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
