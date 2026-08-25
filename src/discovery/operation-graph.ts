import type { DiscoveredOperation, OperationGraph, OperationGraphEdge } from './types.js';

function resourceKey(path: string): string {
  return path.replace(/\{[^}]+\}|:[A-Za-z_$][\w$]*/g, ':id').replace(/\/(status|result|detail|recent|list)$/i, '').replace(/\/$/, '');
}

function actionRank(operation: DiscoveredOperation): number {
  if (operation.method === 'POST') return 0;
  if (operation.method === 'GET' || operation.method === 'HEAD') return 1;
  if (operation.method === 'PUT' || operation.method === 'PATCH') return 2;
  if (operation.method === 'DELETE') return 3;
  return 4;
}

export function buildOperationGraph(operations: readonly DiscoveredOperation[]): OperationGraph {
  const nodes = [...operations];
  const edges: OperationGraphEdge[] = [];
  const groups = new Map<string, DiscoveredOperation[]>();
  for (const operation of nodes) {
    const key = resourceKey(operation.path);
    groups.set(key, [...(groups.get(key) ?? []), operation]);
  }
  for (const [resource, group] of groups) {
    const sorted = [...group].sort((left, right) => actionRank(left) - actionRank(right) || left.path.localeCompare(right.path));
    for (let index = 1; index < sorted.length; index++) {
      edges.push({ from: sorted[index - 1].id, to: sorted[index].id, kind: 'RESOURCE', reason: `共享资源 ${resource}` });
    }
  }
  for (const operation of nodes) {
    if (operation.auth !== undefined) edges.push({ from: 'auth', to: operation.id, kind: 'AUTHENTICATION', reason: 'Operation 声明认证依赖' });
    for (const effect of operation.sideEffects ?? []) {
      edges.push({ from: operation.id, to: `effect:${effect}`, kind: 'SIDE_EFFECT', reason: effect });
    }
  }
  const inbound = new Set(edges.filter((edge) => nodes.some((node) => node.id === edge.from)).map((edge) => edge.to));
  return {
    nodes, edges, roots: nodes.filter((node) => !inbound.has(node.id)).map((node) => node.id),
    warnings: nodes.length && edges.length === 0 ? ['OPERATION_GRAPH_DISCONNECTED：未发现可证明的跨 Operation 依赖'] : [],
  };
}
