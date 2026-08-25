import type {
  Contract,
  DriftClassification,
  DriftField,
  DriftResult,
  DriftSeverity,
} from './types.js';

const SEVERITY_RANK: Record<DriftSeverity, number> = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

function valueType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function classification(path: string, before: unknown, after: unknown): DriftClassification {
  if (before === undefined) return 'ADDED';
  if (after === undefined) return 'REMOVED';
  if (valueType(before) !== valueType(after)) return 'TYPE_CHANGED';
  if (Array.isArray(before) && Array.isArray(after)) return 'ENUM_CHANGED';
  if (/(?:schema|properties|required|request|response)/i.test(path)) return 'SCHEMA_CHANGED';
  if (/(?:behavior|workflow|task|status|permission|billing|effect)/i.test(path)) return 'BEHAVIOR_CHANGED';
  return 'CHANGED';
}

function severityFor(kind: DriftClassification): DriftSeverity {
  if (kind === 'TYPE_CHANGED' || kind === 'SCHEMA_CHANGED') return 'CRITICAL';
  if (kind === 'REMOVED' || kind === 'ENUM_CHANGED' || kind === 'BEHAVIOR_CHANGED') return 'HIGH';
  if (kind === 'CHANGED') return 'HIGH';
  return 'MEDIUM';
}

function diff(before: unknown, after: unknown, path = '$'): DriftField[] {
  if (Object.is(before, after)) return [];
  if (before && after && typeof before === 'object' && typeof after === 'object'
    && !Array.isArray(before) && !Array.isArray(after)) {
    const beforeRecord = before as Record<string, unknown>;
    const afterRecord = after as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)])].sort();
    return keys.flatMap((key) => diff(beforeRecord[key], afterRecord[key], `${path}.${key}`));
  }
  if (Array.isArray(before) && Array.isArray(after)
    && JSON.stringify(before) === JSON.stringify(after)) return [];
  const kind = classification(path, before, after);
  const severity = severityFor(kind);
  return [{
    path,
    classification: kind,
    before,
    after,
    severity,
    impact: `${path} ${kind}；依赖该字段的 Scenario 必须重新确认契约`,
  }];
}

export class DriftDetector {
  compare(expected: Contract, observed: Contract): DriftResult {
    if (!expected || !observed || expected.id !== observed.id) return {
      status: 'UNKNOWN',
      contractId: expected?.id ?? observed?.id ?? 'unknown',
      expectedVersion: expected?.version,
      observedVersion: observed?.version,
      changedFields: [],
      severity: 'HIGH',
      reason: 'Contract identity 不一致或输入缺失',
    };
    if (expected.status === 'CONFLICT' || observed.status === 'CONFLICT') return {
      status: 'CONFLICT', contractId: expected.id, expectedVersion: expected.version, observedVersion: observed.version,
      expectedFingerprint: expected.fingerprint, observedFingerprint: observed.fingerprint,
      changedFields: [], severity: 'CRITICAL', reason: '待比较 Contract 本身处于 CONFLICT',
    };
    const changedFields = diff(expected.value, observed.value);
    const severity = changedFields.reduce<DriftSeverity>((highest, item) => (
      SEVERITY_RANK[item.severity] > SEVERITY_RANK[highest] ? item.severity : highest
    ), 'LOW');
    return {
      status: changedFields.length ? 'DRIFT' : 'NO_DRIFT',
      contractId: expected.id,
      expectedVersion: expected.version,
      observedVersion: observed.version,
      changedFields,
      severity,
      expectedFingerprint: expected.fingerprint,
      observedFingerprint: observed.fingerprint,
    };
  }
}
