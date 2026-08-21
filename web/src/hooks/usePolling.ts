// 2 秒轮询 Hook（25.6 要求）
import { useEffect, useRef, useState } from 'react';

export function usePolling<T>(fetcher: () => Promise<T>, intervalMs = 2000): { data: T | null; error: string | null; loading: boolean; refresh: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async (): Promise<void> => {
      try {
        const value = await fetcherRef.current();
        if (alive) {
          setData(value);
          setError(null);
        }
      } catch (err) {
        if (alive) setError((err as Error).message);
      } finally {
        if (alive) {
          setLoading(false);
          // Phase 53 reliability scan：完成后再安排下一次，慢请求不会与下一轮重叠形成风暴。
          timer = setTimeout(() => void run(), intervalMs);
        }
      }
    };
    void run();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [intervalMs, tick]);

  return { data, error, loading, refresh: () => setTick((t) => t + 1) };
}
