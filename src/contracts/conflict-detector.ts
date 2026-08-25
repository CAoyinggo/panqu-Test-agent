import type { Contract, ContractConflict } from './types.js';
import { canonicalContractValue, contractFingerprint } from './versioning.js';

function flatten(value: unknown, path = '', out = new Map<string, unknown>()): Map<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length) {
      for (const [key, item] of entries) flatten(item, path ? `${path}.${key}` : key, out);
      return out;
    }
  }
  out.set(path || '$', value);
  return out;
}

export function detectContractConflicts(contracts: readonly Contract[]): ContractConflict[] {
  if (new Set(contracts.map((contract) => contract.fingerprint)).size <= 1) return [];
  const flattened = contracts.map((contract) => ({ contract, values: flatten(contract.value) }));
  const fields = [...new Set(flattened.flatMap((item) => [...item.values.keys()]))].sort();
  return fields.flatMap((field): ContractConflict[] => {
    const groups = new Map<string, Array<{ contract: Contract; value: unknown }>>();
    for (const item of flattened) {
      const present = item.values.has(field);
      const value = present ? item.values.get(field) : undefined;
      const key = present ? contractFingerprint(value) : '__ABSENT__';
      groups.set(key, [...(groups.get(key) ?? []), { contract: item.contract, value }]);
    }
    if (groups.size <= 1) return [];
    return [{
      field,
      values: [...groups.entries()].map(([fingerprint, values]) => ({
        value: values[0].value,
        fingerprint,
        contractIds: [...new Set(values.map((item) => item.contract.id))],
        versions: [...new Set(values.map((item) => item.contract.version))],
        sources: values.flatMap((item) => item.contract.sources),
      })).sort((left, right) => String(left.value === undefined ? '__ABSENT__' : canonicalContractValue(left.value))
        .localeCompare(String(right.value === undefined ? '__ABSENT__' : canonicalContractValue(right.value)))),
      status: 'CONFLICT',
      reason: `字段 ${field} 存在多个可信值；Source Priority 只排序证据，不允许静默覆盖`,
    }];
  });
}
