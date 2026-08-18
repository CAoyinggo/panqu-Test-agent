// 指标激活状态：tracked=false 指标按真实遥测自动激活（GET /metrics/activation）
import { api } from '../api';
import { usePolling } from '../hooks/usePolling';
import { Card, Table, Badge, fmtTime, Empty, MetricCard } from '../components/ui';

interface ActivationRecord {
  metric: string;
  activated: boolean;
  firstActivatedAt: string | null;
  lastSampleAt: string | null;
  sampleCount: number;
}

interface ActivationStatus {
  records: ActivationRecord[];
  activeCount: number;
}

const METRIC_LABEL: Record<string, string> = {
  cost: 'LLM 成本',
  rcaAccuracy: 'RCA 准确率',
  flakyRate: 'Flaky 率',
  healingRate: '自愈率',
  execution: '执行',
};

export default function TelemetryActivation(): JSX.Element {
  const { data, error } = usePolling<ActivationStatus>(() => api.get<ActivationStatus>('/metrics/activation'), 2000);

  return (
    <div>
      <div className="page-title">指标激活</div>
      <div className="page-sub">真实遥测首样本自动激活 · 每 2 秒刷新</div>
      {error && <div className="error-banner">{error}</div>}
      {!data && !error && <Empty text="加载中…" />}
      {data && (
        <>
          <div className="grid">
            <MetricCard label="已激活指标" value={data.activeCount} />
            <MetricCard label="跟踪指标总数" value={data.records.length} />
          </div>
          <Card title={`激活明细（${data.records.length}）`}>
            {data.records.length === 0 ? (
              <Empty text="暂无激活记录" />
            ) : (
              <Table head={['指标', '名称', '状态', '首样本激活', '最近样本', '样本数']}>
                {data.records.map((r) => (
                  <tr key={r.metric}>
                    <td className="mono">{r.metric}</td>
                    <td>{METRIC_LABEL[r.metric] ?? r.metric}</td>
                    <td>{r.activated ? <Badge kind="ok">已激活</Badge> : <Badge kind="muted">未激活</Badge>}</td>
                    <td>{fmtTime(r.firstActivatedAt)}</td>
                    <td>{fmtTime(r.lastSampleAt)}</td>
                    <td>{r.sampleCount}</td>
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
