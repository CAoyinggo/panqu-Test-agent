// Phase 42.1：usePolling 轮询 Hook 单元测试
// 覆盖：立即首拉 / 按 interval 轮询 / 数据更新 / 失败置 error / 卸载清理定时器 / refresh 手动刷新
import { describe, expect, it, vi, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { usePolling } from './usePolling';

describe('usePolling（Phase 42.1）', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('挂载即拉取并返回数据，loading 结束', async () => {
    const fetcher = vi.fn().mockResolvedValue({ value: 42 });
    const { result } = renderHook(() => usePolling(fetcher, 1000));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.data).toEqual({ value: 42 }));
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('按 interval 轮询重复拉取', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetcher = vi.fn().mockImplementation(async () => ({ n: ++calls }));
    const { result } = renderHook(() => usePolling(fetcher, 1000));
    // 首拉
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    // 2 个轮询周期
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(result.current.data).toEqual({ n: 3 });
  });

  it('失败时置 error 且保留最后一次成功数据', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ value: 1 })
      .mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => usePolling(fetcher, 1000));
    await waitFor(() => expect(result.current.data).toEqual({ value: 1 }));
    // 触发第二次拉取失败
    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.error).toBe('boom'));
    expect(result.current.data).toEqual({ value: 1 });
  });

  it('卸载后清理定时器：不再拉取（无内存泄漏）', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValue({ value: 1 });
    const { unmount } = renderHook(() => usePolling(fetcher, 1000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const callsAfterMount = fetcher.mock.calls.length;
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    // 卸载后 3 个周期内不再增加调用
    expect(fetcher.mock.calls.length).toBe(callsAfterMount);
  });

  it('refresh() 手动触发立即重新拉取', async () => {
    let calls = 0;
    const fetcher = vi.fn().mockImplementation(async () => ({ n: ++calls }));
    const { result } = renderHook(() => usePolling(fetcher, 60_000));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(result.current.data).toEqual({ n: 2 });
  });

  it('慢请求完成前不会启动重叠轮询', async () => {
    vi.useFakeTimers();
    let resolve!: (value: number) => void;
    const fetcher = vi.fn(() => new Promise<number>((done) => { resolve = done; }));
    renderHook(() => usePolling(fetcher, 1000));
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => { resolve(1); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
