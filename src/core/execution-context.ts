import { AsyncLocalStorage } from 'node:async_hooks';
import type { MetricsCollector } from '../utils/metrics.js';

/**
 * A writable log sink is deliberately kept behind a small interface so the
 * execution context does not depend on fs.WriteStream at runtime.
 */
export interface ExecutionLogSink {
  write(line: string): unknown;
  end(): unknown;
}

export interface ExecutionLogContext {
  task?: string;
  scene?: string;
  trace?: string;
  caseId?: string;
  step?: string;
  sink?: ExecutionLogSink;
}

export interface ExecutionContext {
  log: ExecutionLogContext;
  metrics?: MetricsCollector;
}

export interface ExecutionContextInput {
  log?: Partial<ExecutionLogContext>;
  metrics?: MetricsCollector;
}

const executionStorage = new AsyncLocalStorage<ExecutionContext>();

/** Return the context belonging to the current asynchronous execution chain. */
export function getExecutionContext(): ExecutionContext | undefined {
  return executionStorage.getStore();
}

/**
 * Run work in an isolated context. Nested scopes inherit the parent values but
 * receive their own mutable log metadata, so changing Case B can never mutate
 * Case A (or its parent run).
 *
 * Cleanup is part of the scope contract and is always reached, including when
 * work throws. AsyncLocalStorage.run then restores the parent automatically.
 */
export async function withExecutionContext<T>(
  input: ExecutionContextInput,
  work: (context: ExecutionContext) => Promise<T> | T,
  cleanup?: (context: ExecutionContext) => Promise<void> | void,
): Promise<T> {
  const parent = executionStorage.getStore();
  const context: ExecutionContext = {
    log: {
      ...(parent?.log ?? {}),
      ...(input.log ?? {}),
    },
    metrics: input.metrics ?? parent?.metrics,
  };

  return executionStorage.run(context, async () => {
    try {
      return await work(context);
    } finally {
      await cleanup?.(context);
    }
  });
}
