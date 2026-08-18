// 遥测快照：成本 / RCA 准确率 / Flaky / Healing（GET /telemetry/snapshot?window=）
import { useState } from 'react';
import { api } from '../api';
import { usePolling } from '../hooks/usePolling';
import { Card, MetricCard, Table, WindowSwitcher, Empty } from '../components/ui';

interface MetricSample {
  value: number | null;
  tracked: boolean;
  sampleCount: number;
  unit?: string;
}

interface CostBreakdown {
  total: MetricSample;
  perRun: MetricSample;
  perFeature: MetricSample;
  perProject: MetricSample;
  perModel: Array<{ model: string; cost: number; tokens: number; requests: number }>;
}

interface TelemetrySnapshot {
  cost: CostBreakdown;
  rcaAccuracy: MetricSample;
  flakyRate: MetricSample;
  healing: {
    successRate: MetricSample;
    falseHealingRate: MetricSample;
    recoveryRate: MetricSample;
  };
}

export default function Telemetry(): JSX.Element {
  const [window, setWindow] = useState('7d');
  const { data, error } = usePolling<TelemetrySnapshot>(() => api.get<TelemetrySnapshot>(`/telemetry/snapshot?window=${window}`), 2000);

  return (
    <div>
      <div className="page-title">遥测快照</div>
      <div className="page-sub">真实运行遥测 · 每 2 秒刷新</div>
      <WindowSwitcher value={window} onChange={setWindow} />
      {error && <div className="error-banner">{error}</div>}
      {!data && !error && <Empty text="加载中…" />}
      {data && (
        <>
          <div className="grid">
            <MetricCard label="总成本" value={data.cost.total.value} unit="CNY" tracked={data.cost.total.tracked} hint={`样本 ${data.cost.total.sampleCount}`} />
            <MetricCard label="单 Run 成本" value={data.cost.perRun.value} unit="CNY" tracked={data.cost.perRun.tracked} hint={`样本 ${data.cost.perRun.sampleCount}`} />
            <MetricCard label="单 Feature 成本" value={data.cost.perFeature.value} unit="CNY" tracked={data.cost.perFeature.tracked} hint={`样本 ${data.cost.perFeature.sampleCount}`} />
            <MetricCard label="单项目成本" value={data.cost.perProject.value} unit="CNY" tracked={data.cost.perProject.tracked} hint={`样本 ${data.cost.perProject.sampleCount}`} />
          </div>
          <div className="grid">
            <MetricCard label="RCA 准确率" value={data.rcaAccuracy.value} unit="%" tracked={data.rcaAccuracy.tracked} hint={`验证 ${data.rcaAccuracy.sampleCount}`} />
            <MetricCard label="Flaky 率" value={data.flakyRate.value} unit="%" tracked={data.flakyRate.tracked} hint={`样本 ${data.flakyRate.sampleCount}`} />
            <MetricCard label="自愈成功率" value={data.healing.successRate.value} unit="%" tracked={data.healing.successRate.tracked} hint={`样本 ${data.healing.successRate.sampleCount}`} />
            <MetricCard label="恢复率" value={data.healing.recoveryRate.value} unit="%" tracked={data.healing.recoveryRate.tracked} hint={`样本 ${data.healing.recoveryRate.sampleCount}`} />
          </div>
          <div className="grid">
            <MetricCard label="误自愈率" value={data.healing.falseHealingRate.value} unit="%" tracked={data.healing.falseHealingRate.tracked} hint={`样本 ${data.healing.falseHealingRate.sampleCount}`} />
          </div>
          <Card title={`按模型成本（${data.cost.perModel.length}）`}>
            {data.cost.perModel.length === 0 ? (
              <Empty text="暂无成本样本" />
            ) : (
              <Table head={['模型', '成本 (CNY)', 'Tokens', '请求数']}>
                {data.cost.perModel.map((m) => (
                  <tr key={m.model}>
                    <td className="mono">{m.model}</td>
                    <td>{m.cost.toFixed(4)}</td>
                    <td>{m.tokens.toLocaleString('zh-CN')}</td>
                    <td>{m.requests}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
