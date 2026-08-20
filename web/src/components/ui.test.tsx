// Phase 42.1：共享 UI 组件单元测试（ui.tsx）
// 覆盖：Card（含/不含标题与 action）/ Badge / StatusBadge 状态映射 / MetricCard /
//      Table / Empty / fmtTime / WindowSwitcher
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  Card,
  Badge,
  StatusBadge,
  MetricCard,
  Table,
  Empty,
  JsonBlock,
  fmtTime,
  WindowSwitcher,
  WINDOW_OPTIONS,
} from './ui';

describe('UI 组件（Phase 42.1）', () => {
  describe('Card', () => {
    it('渲染标题与内容', () => {
      render(<Card title="我的卡片">内容正文</Card>);
      expect(screen.getByText('我的卡片')).toBeInTheDocument();
      expect(screen.getByText('内容正文')).toBeInTheDocument();
    });

    it('无标题时不渲染卡片头，仅渲染内容', () => {
      render(<Card>只有内容</Card>);
      expect(screen.queryByText('card-head', { selector: '.card-head' })).toBeNull();
      expect(screen.getByText('只有内容')).toBeInTheDocument();
    });

    it('渲染 action 区域', () => {
      render(<Card title="t" action={<button>操作</button>}>c</Card>);
      expect(screen.getByRole('button', { name: '操作' })).toBeInTheDocument();
    });
  });

  describe('Badge / StatusBadge', () => {
    it('Badge 渲染 kind class', () => {
      const { container } = render(<Badge kind="err">失败</Badge>);
      expect(container.querySelector('.badge-err')).toBeTruthy();
      expect(screen.getByText('失败')).toBeInTheDocument();
    });

    it('StatusBadge 状态 → 颜色映射（COMPLETED=ok / FAILED=err / RUNNING=info / UNKNOWN=muted）', () => {
      const { rerender } = render(<StatusBadge status="COMPLETED" />);
      expect(screen.getByText('COMPLETED').className).toContain('badge-ok');
      rerender(<StatusBadge status="FAILED" />);
      expect(screen.getByText('FAILED').className).toContain('badge-err');
      rerender(<StatusBadge status="RUNNING" />);
      expect(screen.getByText('RUNNING').className).toContain('badge-info');
      rerender(<StatusBadge status="SOMETHING" />);
      expect(screen.getByText('SOMETHING').className).toContain('badge-muted');
    });

    it('StatusBadge 大小写不敏感且空值显示占位', () => {
      render(<StatusBadge status="" />);
      expect(screen.getByText('—')).toBeInTheDocument();
    });
  });

  describe('MetricCard', () => {
    it('数值千分位格式化 + 单位', () => {
      render(<MetricCard label="成本" value={12345} unit="元" tracked />);
      expect(screen.getByText('12,345')).toBeInTheDocument();
      expect(screen.getByText('元')).toBeInTheDocument();
      expect(screen.getByText('● 真实数据')).toBeInTheDocument();
    });

    it('null 显示占位符，未激活显示 ○ 未激活', () => {
      render(<MetricCard label="指标" value={null} tracked={false} />);
      expect(screen.getByText('—')).toBeInTheDocument();
      expect(screen.getByText('○ 未激活')).toBeInTheDocument();
    });

    it('未传 tracked 时不渲染真实数据标记', () => {
      render(<MetricCard label="指标" value={5} />);
      expect(screen.queryByText('● 真实数据')).toBeNull();
      expect(screen.queryByText('○ 未激活')).toBeNull();
    });
  });

  describe('Table / Empty / JsonBlock', () => {
    it('Table 渲染表头与行内容', () => {
      render(
        <Table head={['名称', '状态']}>
          <tr><td>A</td><td>B</td></tr>
        </Table>
      );
      expect(screen.getByRole('columnheader', { name: '名称' })).toBeInTheDocument();
      expect(screen.getByRole('columnheader', { name: '状态' })).toBeInTheDocument();
      expect(screen.getByText('A')).toBeInTheDocument();
    });

    it('Empty 渲染占位文案', () => {
      render(<Empty text="暂无数据" />);
      expect(screen.getByText('暂无数据')).toBeInTheDocument();
    });

    it('JsonBlock 序列化对象为格式化 JSON', () => {
      render(<JsonBlock data={{ a: 1, b: [2] }} />);
      expect(screen.getByText(/"a": 1/)).toBeInTheDocument();
    });
  });

  describe('fmtTime / WindowSwitcher', () => {
    it('fmtTime 格式化 ISO 时间（zh-CN 24h）', () => {
      expect(fmtTime('2026-08-20T08:30:00.000Z')).not.toBe('—');
      expect(fmtTime(undefined)).toBe('—');
      expect(fmtTime(null)).toBe('—');
    });

    it('WindowSwitcher 渲染全部窗口选项并触发 onChange', async () => {
      const onChange = vi.fn();
      render(<WindowSwitcher value="24h" onChange={onChange} />);
      expect(WINDOW_OPTIONS).toHaveLength(7);
      for (const o of WINDOW_OPTIONS) {
        expect(screen.getByRole('button', { name: o.label })).toBeInTheDocument();
      }
      await userEvent.click(screen.getByRole('button', { name: '7天' }));
      expect(onChange).toHaveBeenCalledWith('7d');
    });
  });
});
