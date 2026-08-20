// Phase 43.2：新建 Run（核心「新建 Run」能力 Web 化）
// 此前 POST /runs 无任何 UI 入口，只能在 Plan/Template/Run Again/Clone 间接触发。
// 本页提供完整参数表单：项目/环境/触发/Feature/Plan/Suites/Template/模式/预算/Release 门禁/资产版本。
import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { api } from '../api';
import { Card, Empty } from '../components/ui';

const ENVIRONMENTS = ['test', 'preonline'];
const TRIGGERS = ['manual', 'schedule', 'pr', 'release', 'model-change', 'config-change', 'autonomous'];

export default function RunCreate(): JSX.Element {
  const navigate = useNavigate();
  const [projectId, setProjectId] = useState('wan3');
  const [environment, setEnvironment] = useState('test');
  const [trigger, setTrigger] = useState('manual');
  const [feature, setFeature] = useState('');
  const [planId, setPlanId] = useState('');
  const [suiteIds, setSuiteIds] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [mode, setMode] = useState('');
  const [budget, setBudget] = useState('');
  const [releaseGate, setReleaseGate] = useState(false);
  const [assetVersion, setAssetVersion] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  const doCreate = async (): Promise<void> => {
    if (!projectId.trim() || !environment) return;
    setErr(''); setBusy(true);
    try {
      const assetVersionObj = assetVersion.trim()
        ? (JSON.parse(assetVersion) as Record<string, number>)
        : undefined;
      const r = await api.post<{ runId: string; status: string }>('/runs', {
        projectId: projectId.trim(),
        environment,
        trigger,
        feature: feature.trim() || undefined,
        planId: planId.trim() || undefined,
        suiteIds: suiteIds.trim() ? suiteIds.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
        templateId: templateId.trim() || undefined,
        mode: mode.trim() || undefined,
        budget: budget.trim() ? Number(budget) : undefined,
        releaseGate,
        assetVersion: assetVersionObj,
      });
      setMsg(`已创建 Run：${r.runId}（${r.status}）`);
      navigate(`/runs/${r.runId}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h1 className="page-title">新建 Run</h1>
      <div className="page-sub">直接对项目发起一次测试执行（POST /runs 全参数）</div>
      {err && <div className="error-banner">{err}</div>}
      {msg && <div className="ok-banner">{msg}</div>}
      <Card title="Run 配置">
        <div className="form-row"><label className="form-label">项目 ID *</label><input aria-label="项目 ID（必填）" value={projectId} onChange={(e) => setProjectId(e.target.value)} /></div>
        <div className="form-row">
          <label className="form-label">环境 *</label>
          <select aria-label="环境（必选）" value={environment} onChange={(e) => setEnvironment(e.target.value)}>
            {ENVIRONMENTS.map((env) => <option key={env} value={env}>{env}</option>)}
          </select>
        </div>
        <div className="form-row">
          <label className="form-label">触发 *</label>
          <select aria-label="触发类型（必选）" value={trigger} onChange={(e) => setTrigger(e.target.value)}>
            {TRIGGERS.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div className="form-row"><label className="form-label">Feature（可选）</label><input aria-label="Feature（可选）" value={feature} onChange={(e) => setFeature(e.target.value)} /></div>
        <div className="form-row"><label className="form-label">Plan ID（可选）</label><input aria-label="Plan ID（可选）" value={planId} onChange={(e) => setPlanId(e.target.value)} /></div>
        <div className="form-row"><label className="form-label">Suite IDs（可选，逗号分隔）</label><input aria-label="Suite IDs（可选）" value={suiteIds} onChange={(e) => setSuiteIds(e.target.value)} /></div>
        <div className="form-row"><label className="form-label">Template ID（可选）</label><input aria-label="Template ID（可选）" value={templateId} onChange={(e) => setTemplateId(e.target.value)} /></div>
        <div className="form-row"><label className="form-label">模式（可选）</label><input aria-label="模式（可选）" value={mode} onChange={(e) => setMode(e.target.value)} placeholder="如 smoke / full" /></div>
        <div className="form-row"><label className="form-label">预算 Budget（可选）</label><input aria-label="预算（可选）" type="number" value={budget} onChange={(e) => setBudget(e.target.value)} /></div>
        <div className="form-row">
          <label className="form-label">Release 门禁</label>
          <label className="check"><input type="checkbox" aria-label="Release 门禁" checked={releaseGate} onChange={(e) => setReleaseGate(e.target.checked)} /> 需要发布审批</label>
        </div>
        <div className="form-row"><label className="form-label">资产版本（可选 JSON）</label><input aria-label="资产版本（可选 JSON）" value={assetVersion} onChange={(e) => setAssetVersion(e.target.value)} placeholder='{"wan3-case-v1": 2}' /></div>
        <div className="form-row">
          <button className="btn" disabled={busy || !projectId.trim()} onClick={() => void doCreate()}>创建 Run</button>
          <Link className="btn btn-ghost" to="/runs">取消</Link>
        </div>
        {!projectId.trim() && <Empty text="项目 ID 必填" />}
      </Card>
    </div>
  );
}
