import type { ContractSource, ContractSourceType } from './types.js';

export type ContractSourcePriority = Readonly<Record<ContractSourceType, number>>;

export const DEFAULT_SOURCE_PRIORITY: ContractSourcePriority = Object.freeze({
  runtime: 100,
  database: 95,
  backend: 90,
  frontend: 80,
  openapi: 70,
  json: 60,
  typescript: 60,
  requirement: 50,
  markdown: 50,
  'test-fixture': 20,
});

export function createSourcePriority(overrides: Partial<Record<ContractSourceType, number>> = {}): ContractSourcePriority {
  return Object.freeze({ ...DEFAULT_SOURCE_PRIORITY, ...overrides });
}

export function contractSource(
  type: ContractSourceType,
  ref: string,
  options: Omit<Partial<ContractSource>, 'type' | 'ref' | 'priority'> & {
    priority?: number;
    priorities?: ContractSourcePriority;
  } = {},
): ContractSource {
  const { priorities = DEFAULT_SOURCE_PRIORITY, ...rest } = options;
  return { type, ref, ...rest, priority: options.priority ?? priorities[type] };
}

export function highestSourcePriority(sources: readonly ContractSource[]): number {
  return sources.reduce((highest, source) => Math.max(highest, source.priority), Number.NEGATIVE_INFINITY);
}

export function sortSources(sources: readonly ContractSource[]): ContractSource[] {
  return [...sources].sort((left, right) => right.priority - left.priority || left.ref.localeCompare(right.ref));
}
