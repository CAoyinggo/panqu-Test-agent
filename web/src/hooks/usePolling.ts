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
        if (alive) setLoading(false);
      }
    };
    void run();
    const timer = setInterval(() => void run(), intervalMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [intervalMs, tick]);

  return { data, error, loading, refresh: () => setTick((t) => t + 1) };
}
