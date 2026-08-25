import { createHash } from 'node:crypto';
import {
  CONTRACT_KINDS,
  CONTRACT_SOURCE_TYPES,
  type Contract,
  type ContractCandidate,
  type ContractSource,
} from './types.js';

function canonicalize(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
    return value;
  }
  if (seen.has(value as object)) throw new Error('Contract value 不能包含循环引用');
  seen.add(value as object);
  try {
    if (Array.isArray(value)) return value.map((item) => canonicalize(item, seen));
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item, seen)]));
  } finally {
    seen.delete(value as object);
  }
}

export function canonicalContractValue(value: unknown): string {
  const serialized = JSON.stringify(canonicalize(value, new WeakSet()));
  if (serialized === undefined) throw new Error('Contract value 不可序列化');
  return serialized;
}

export function contractFingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalContractValue(value)).digest('hex');
}

function validDate(value: string | undefined, field: string): void {
  if (value !== undefined && Number.isNaN(Date.parse(value))) throw new Error(`Contract ${field} 不是合法 ISO 时间`);
}

function validateSource(source: ContractSource, index: number): void {
  if (!CONTRACT_SOURCE_TYPES.includes(source.type)) throw new Error(`Contract sources[${index}].type 无效`);
  if (!source.ref?.trim()) throw new Error(`Contract sources[${index}].ref 缺失`);
  if (!Number.isFinite(source.priority)) throw new Error(`Contract sources[${index}].priority 无效`);
  if (source.confidence !== undefined && (source.confidence < 0 || source.confidence > 1)) {
    throw new Error(`Contract sources[${index}].confidence 必须在 0~1`);
  }
  validDate(source.observedAt, `sources[${index}].observedAt`);
}

export function validateContract<T>(contract: ContractCandidate<T> | Contract<T>): void {
  if (!contract || typeof contract !== 'object') throw new Error('Contract 必须是对象');
  if (!contract.id?.trim()) throw new Error('Contract id 缺失');
  if (!CONTRACT_KINDS.includes(contract.kind)) throw new Error(`Contract kind 无效：${String(contract.kind)}`);
  if (!contract.subject?.trim()) throw new Error('Contract subject 缺失');
  if (!contract.version?.trim()) throw new Error('Contract version 缺失');
  if (!['ACTIVE', 'STALE', 'CONFLICT', 'UNKNOWN', 'EXPIRED'].includes(contract.status)) {
    throw new Error(`Contract status 无效：${String(contract.status)}`);
  }
  if (!Array.isArray(contract.sources)) throw new Error('Contract sources 必须是数组');
  contract.sources.forEach(validateSource);
  if (contract.confidence !== undefined && (contract.confidence < 0 || contract.confidence > 1)) {
    throw new Error('Contract confidence 必须在 0~1');
  }
  validDate(contract.createdAt, 'createdAt');
  validDate(contract.observedAt, 'observedAt');
  validDate(contract.validatedAt, 'validatedAt');
  contractFingerprint(contract.value);
}

export function createContract<T>(input: ContractCandidate<T>): Contract<T> {
  validateContract(input);
  const fingerprint = contractFingerprint(input.value);
  if (input.fingerprint && input.fingerprint !== fingerprint) throw new Error(`Contract fingerprint 不匹配：${input.id}`);
  return { ...input, sources: input.sources.map((source) => ({ ...source })), fingerprint };
}

export function nextContractVersion(versions: readonly string[], prefix = 'v'): string {
  const numbers = versions.map((version) => new RegExp(`^${prefix}(\\d+)$`).exec(version)?.[1])
    .filter((value): value is string => Boolean(value)).map(Number);
  return `${prefix}${(numbers.length ? Math.max(...numbers) : 0) + 1}`;
}
