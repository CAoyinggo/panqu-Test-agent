import type { ChangedArtifact } from '../discovery/types.js';
import type { DiscoveredOperation } from '../discovery/types.js';
import type { FeatureRisk, FeatureRiskSummary, FeatureRiskType } from './types.js';

const LEVEL_ORDER = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;

function add(target: Map<FeatureRiskType, FeatureRisk>, type: FeatureRiskType, level: FeatureRisk['level'], reason: string): void {
  const existing = target.get(type);
  if (!existing) target.set(type, { type, level, reasons: [reason] });
  else {
    if (LEVEL_ORDER.indexOf(level) > LEVEL_ORDER.indexOf(existing.level)) existing.level = level;
    if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
  }
}

export function classifyFeatureRisk(operations: readonly DiscoveredOperation[], artifacts: readonly ChangedArtifact[] = []): FeatureRiskSummary {
  const risks = new Map<FeatureRiskType, FeatureRisk>();
  const sideEffects = new Set(operations.flatMap((operation) => operation.sideEffects ?? []));
  const methods = new Set(operations.map((operation) => operation.method));
  if (methods.has('POST') && (methods.has('GET') || methods.has('PUT') || methods.has('PATCH') || methods.has('DELETE'))) add(risks, 'CRUD', 'MEDIUM', '同一变更包含资源读写 Operation');
  if (operations.some((operation) => (operation.auth as { required?: boolean } | undefined)?.required === true)) add(risks, 'AUTHENTICATION', 'HIGH', 'API Contract 声明认证依赖');
  if (operations.some((operation) => /admin|permission|role|auth/i.test(`${operation.path} ${JSON.stringify(operation.auth ?? '')}`))) add(risks, 'AUTHORIZATION', 'HIGH', '路径或认证契约涉及权限控制');
  if (operations.some((operation) => /upload|file|multipart/i.test(`${operation.path} ${JSON.stringify(operation.requestSchema ?? '')}`))) add(risks, 'FILE_UPLOAD', 'HIGH', '发现文件上传语义');
  if (operations.some((operation) => /task|status|submit|queue|job|callback|result/i.test(operation.path))) add(risks, 'ASYNC_TASK', 'HIGH', '发现任务提交/状态/结果语义');
  if ([...sideEffects].some((effect) => /billing|charge|payment|积分/i.test(effect)) || operations.some((operation) => /billing|charge|payment/i.test(operation.path))) add(risks, 'BILLING', 'CRITICAL', '发现计费或余额副作用');
  if (operations.some((operation) => /status|transition|state/i.test(operation.path))) add(risks, 'STATE_MACHINE', 'HIGH', '发现状态转换或状态查询');
  if ([...sideEffects].some((effect) => /provider|external/i.test(effect))) add(risks, 'EXTERNAL_PROVIDER', 'HIGH', '发现外部 Provider 依赖');
  if (artifacts.some((artifact) => artifact.kind === 'UI')) add(risks, 'UI_STATE', 'MEDIUM', '变更包含 UI Component 或网络调用');
  if (operations.some((operation) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(operation.method)) || artifacts.some((artifact) => artifact.kind === 'DATABASE')) add(risks, 'DATA_MUTATION', 'HIGH', '变更包含写 Operation 或 DB Schema');
  const values = [...risks.values()];
  const overall = values.reduce<FeatureRisk['level']>((highest, item) => (
    LEVEL_ORDER.indexOf(item.level) > LEVEL_ORDER.indexOf(highest) ? item.level : highest
  ), 'LOW');
  return { risks: values, overall, sideEffects: [...sideEffects] };
}
