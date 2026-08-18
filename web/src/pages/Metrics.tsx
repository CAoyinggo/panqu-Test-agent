// 平台指标：全部平台指标 + 时间窗口（GET /metrics?window=）
import { useState } from 'react';
import { api } from '../api';
import { usePolling } from '../hooks/usePolling';
import { Card, MetricCard, WindowSwitcher, Empty } from '../components/ui';

interface MetricValue {
  value: number | null;
  tracked: boolean;
  unit?: string;
}

interface PlatformMetrics {
  runSuccessRate: MetricValue;
  queueLength: number;
  workerUtilization: MetricValue;
  avgRunDurationMs: MetricValue;
  p95RunDurationMs: MetricValue;
  rcaAccuracy: MetricValue;
  releaseBlockRate: MetricValue;
  flakyRate: MetricValue;
  healingRate: MetricValue;
  humanApprovalRate: MetricValue;
  llmCost: MetricValue;
  executionCost: MetricValue;
  costPerRun: MetricValue;
  costPerFeature: MetricValue;
}

export default function Metrics(): JSX.Element {
  const [window, setWindow] = useState('7d');
  const { data, error } = usePolling<PlatformMetrics>(() => api.get<PlatformMetrics>(`/metrics?window=${window}`), 2000);

  return (
    <div>
      <div className="page-title">平台指标</div>
      <div className="page-sub">真实遥测计算 · 无数据不激活 · 每 2 秒刷新</div>
      <WindowSwitcher value={window} onChange={setWindow} />
      {error && <div className="error-banner">{error}</div>}
      {!data && !error && <Empty text="加载中…" />}
      {data && (
        <>
          <div className="grid">
            <MetricCard label="Run 成功率" value={data.runSuccessRate.value} unit="%" tracked={data.runSuccessRate.tracked} />
            <MetricCard label="队列长度" value={data.queueLength} />
            <MetricCard label="Worker 利用率" value={data.workerUtilization.value} unit="%" tracked={data.workerUtilization.tracked} />
            <MetricCard label="平均执行时长" value={data.avgRunDurationMs.value} unit="ms" tracked={data.avgRunDurationMs.tracked} />
          </div>
          <div className="grid">
            <MetricCard label="P95 执行时长" value={data.p95RunDurationMs.value} unit="ms" tracked={data.p95RunDurationMs.tracked} />
            <MetricCard label="RCA 准确率" value={data.rcaAccuracy.value} unit="%" tracked={data.rcaAccuracy.tracked} />
            <MetricCard label="发布阻断率" value={data.releaseBlockRate.value} unit="%" tracked={data.releaseBlockRate.tracked} />
            <MetricCard label="Flaky 率" value={data.flakyRate.value} unit="%" tracked={data.flakyRate.tracked} />
          </div>
          <div className="grid">
            <MetricCard label="自愈率" value={data.healingRate.value} unit="%" tracked={data.healingRate.tracked} />
            <MetricCard label="人工审批率" value={data.humanApprovalRate.value} unit="%" tracked={data.humanApprovalRate.tracked} />
            <MetricCard label="LLM 成本" value={data.llmCost.value} unit="CNY" tracked={data.llmCost.tracked} />
            <MetricCard label="单 Run 成本" value={data.costPerRun.value} unit="CNY" tracked={data.costPerRun.tracked} />
          </div>
          <div className="grid">
            <MetricCard label="单 Feature 成本" value={data.costPerFeature.value} unit="CNY" tracked={data.costPerFeature.tracked} />
            <MetricCard label="执行成本" value={data.executionCost.value} unit="CNY" tracked={data.executionCost.tracked} />
          </div>
          <Card title="说明">
            <p className="muted">● 表示指标已由真实遥测数据激活（tracked=true）；○ 表示当前窗口内无真实样本，保持未激活，不使用 0 占位。</p>
          </Card>
        </>
      )}
    </div>
  );
}
