// 共享 UI 组件：卡片 / 指标 / 徽章 / 表格 / 状态
import type { ReactNode } from 'react';

export function Card({ title, children, action }: { title?: ReactNode; children: ReactNode; action?: ReactNode }): ReactNode {
  return (
    <div className="card">
      {title !== undefined && (
        <div className="card-head">
          <div className="card-title">{title}</div>
          {action && <div className="card-action">{action}</div>}
        </div>
      )}
      <div className="card-body">{children}</div>
    </div>
  );
}

export interface MetricValue {
  value: number | null;
  tracked: boolean;
  unit?: string;
}

export function MetricCard({ label, value, unit, tracked, hint }: { label: string; value: number | null | string; unit?: string; tracked?: boolean; hint?: string }): ReactNode {
  const val = value === null || value === undefined ? '—' : typeof value === 'number' ? value.toLocaleString('zh-CN') : value;
  return (
    <div className="metric-card">
      <div className="metric-label">{label}</div>
      <div className="metric-value">
        {val}
        {unit && <span className="metric-unit">{unit}</span>}
      </div>
      {tracked !== undefined && (
        <div className={`metric-track ${tracked ? 'ok' : 'off'}`}>{tracked ? '● 真实数据' : '○ 未激活'}</div>
      )}
      {hint && <div className="metric-hint">{hint}</div>}
    </div>
  );
}

export function Badge({ kind, children }: { kind: 'ok' | 'warn' | 'err' | 'info' | 'muted'; children: ReactNode }): ReactNode {
  return <span className={`badge badge-${kind}`}>{children}</span>;
}

export function StatusBadge({ status }: { status: string }): ReactNode {
  const s = String(status ?? '').toUpperCase();
  const kind = s === 'COMPLETED' || s === 'SUCCESS' || s === 'ACTIVE' || s === 'HEALTHY' || s === 'APPROVED' || s === 'MERGED' || s === 'QUEUED' || s === 'RUNNING' || s === 'PASS' || s === 'PASSED' || s === 'REVIEW'
    ? s === 'RUNNING' || s === 'QUEUED' ? 'info' : s === 'REVIEW' ? 'warn' : 'ok'
    : s === 'FAILED' || s === 'ERROR' || s === 'DOWN' || s === 'REJECTED' || s === 'BLOCK' || s === 'BLOCKED' ? 'err' : 'muted';
  // 空串/undefined/null 均显示占位符（Phase 42.1：StatusBadge 空值兜底）
  return <Badge kind={kind}>{status ? status : '—'}</Badge>;
}

export function Table({ head, children }: { head: string[]; children: ReactNode }): ReactNode {
  return (
    <table className="table">
      <thead>
        <tr>{head.map((h) => <th key={h}>{h}</th>)}</tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

export function JsonBlock({ data }: { data: unknown }): ReactNode {
  return <pre className="json-block">{JSON.stringify(data, null, 2)}</pre>;
}

export function Empty({ text }: { text: string }): ReactNode {
  return <div className="empty">{text}</div>;
}

export function fmtTime(iso: string | undefined | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}

/** 时间窗口选项（1h/6h/24h/7d/30d/release/version） */
export const WINDOW_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '1h', label: '1小时' },
  { value: '6h', label: '6小时' },
  { value: '24h', label: '24小时' },
  { value: '7d', label: '7天' },
  { value: '30d', label: '30天' },
  { value: 'release', label: 'Release' },
  { value: 'version', label: 'Version' },
];

export function WindowSwitcher({ value, onChange }: { value: string; onChange: (w: string) => void }): ReactNode {
  return (
    <div className="window-switcher">
      {WINDOW_OPTIONS.map((o) => (
        <button
          key={o.value}
          className={`btn btn-sm${value === o.value ? ' btn-active' : ' btn-ghost'}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
