import { describe, expect, it, vi } from 'vitest';
import {
  getExecutionContext,
  withExecutionContext,
  type ExecutionLogSink,
} from '../../src/core/execution-context.js';
import { logger, setNoColor } from '../../src/utils/logger.js';
import { metrics, MetricsCollector } from '../../src/utils/metrics.js';
import { getTraceId } from '../../src/utils/trace.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('execution context concurrency contract', () => {
  it('并发 Case A/B 的 caseId、task 和 step 不会互相覆盖', async () => {
    const lines: string[] = [];
    const sink: ExecutionLogSink = {
      write: (line) => lines.push(line.trim()),
      end: vi.fn(),
    };
    const aStarted = deferred();
    const bFinished = deferred();
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    setNoColor(true);

    try {
      await Promise.all([
        withExecutionContext({
          log: { caseId: 'case-A', task: 'Task A', scene: 'video', sink },
        }, async () => {
          logger.step('A-step');
          logger.info('A-before');
          aStarted.resolve();
          await bFinished.promise;
          logger.info('A-after');
        }),
        withExecutionContext({
          log: { caseId: 'case-B', task: 'Task B', scene: 'image', sink },
        }, async () => {
          await aStarted.promise;
          logger.step('B-step');
          logger.info('B-only');
          bFinished.resolve();
        }),
      ]);
    } finally {
      setNoColor(false);
      consoleSpy.mockRestore();
    }

    const entries = lines.map((line) => JSON.parse(line) as Record<string, string>);
    const aEntries = entries.filter((entry) => entry.msg.startsWith('A-'));
    const bEntries = entries.filter((entry) => entry.msg.startsWith('B-'));

    expect(aEntries).toHaveLength(3);
    expect(aEntries.every((entry) => entry.caseId === 'case-A')).toBe(true);
    expect(aEntries.every((entry) => entry.task === 'Task A')).toBe(true);
    expect(aEntries.every((entry) => entry.step === 'A-step')).toBe(true);
    expect(bEntries).toHaveLength(2);
    expect(bEntries.every((entry) => entry.caseId === 'case-B')).toBe(true);
    expect(bEntries.every((entry) => entry.task === 'Task B')).toBe(true);
    expect(bEntries.every((entry) => entry.step === 'B-step')).toBe(true);
  });

  it('metrics 门面按异步用例路由到各自实例', async () => {
    const caseA = new MetricsCollector();
    const caseB = new MetricsCollector();
    caseA.start();
    caseB.start();
    const aRecorded = deferred();

    await Promise.all([
      withExecutionContext({ metrics: caseA }, async () => {
        metrics.recordStep('processor.video', 11);
        aRecorded.resolve();
        await Promise.resolve();
        metrics.recordApiRetry();
        metrics.setPassRate(100);
      }),
      withExecutionContext({ metrics: caseB }, async () => {
        await aRecorded.promise;
        metrics.recordStep('processor.image', 23);
        metrics.recordCaseRetry();
        metrics.setPassRate(0);
      }),
    ]);

    const a = caseA.toJSON();
    const b = caseB.toJSON();
    expect(a.steps).toEqual({ 'processor.video': { duration: 11, calls: 1 } });
    expect(a.apiRetries).toBe(1);
    expect(a.caseRetries).toBe(0);
    expect(a.passRate).toBe(100);
    expect(b.steps).toEqual({ 'processor.image': { duration: 23, calls: 1 } });
    expect(b.apiRetries).toBe(0);
    expect(b.caseRetries).toBe(1);
    expect(b.passRate).toBe(0);
  });

  it('异常时仍执行 cleanup，并在离开 scope 后清除上下文', async () => {
    const cleanup = vi.fn();
    const collector = new MetricsCollector();

    await expect(withExecutionContext(
      { log: { caseId: 'failing-case' }, metrics: collector },
      async () => {
        expect(getExecutionContext()?.log.caseId).toBe('failing-case');
        throw new Error('expected failure');
      },
      (context) => {
        expect(getExecutionContext()).toBe(context);
        cleanup(context.log.caseId);
      },
    )).rejects.toThrow('expected failure');

    expect(cleanup).toHaveBeenCalledExactlyOnceWith('failing-case');
    expect(getExecutionContext()).toBeUndefined();
  });

  it('子 scope 完成后恢复父 scope，而不是遗留子 caseId', async () => {
    await withExecutionContext({ log: { caseId: 'parent', trace: 'trace-parent' } }, async () => {
      await withExecutionContext({ log: { caseId: 'child', trace: 'trace-child' } }, async () => {
        expect(getExecutionContext()?.log.caseId).toBe('child');
        expect(getTraceId()).toBe('trace-child');
      });
      expect(getExecutionContext()?.log.caseId).toBe('parent');
      expect(getTraceId()).toBe('trace-parent');
    });
    expect(getExecutionContext()).toBeUndefined();
  });
});
