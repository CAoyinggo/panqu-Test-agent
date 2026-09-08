import { createHash } from 'node:crypto';
import type {
  AcceptanceRequirement,
  CanonicalScope,
  RequirementFact,
  RequirementSource,
} from './requirement-ir.js';

export interface BusinessProjectionTrace {
  factIds: string[];
  sources: RequirementSource[];
  confidence: number;
  conflict: boolean;
  conflictReasons: string[];
}

export interface BusinessActorProjection extends BusinessProjectionTrace {
  id: string;
  name: string;
  role: string;
  userId?: string;
  tenantId?: string;
  projectId?: string;
}

export interface BusinessResourceProjection extends BusinessProjectionTrace {
  id: string;
  type: string;
  identifiers: Record<string, string>;
  expressions: string[];
}

export interface BusinessOwnershipProjection extends BusinessProjectionTrace {
  id: string;
  resourceId: string;
  ownerActorId?: string;
  subjectActorId?: string;
  tenantId?: string;
  projectId?: string;
  scopes: CanonicalScope[];
  relation: 'SELF' | 'OTHER_USER' | 'SAME_TENANT' | 'CROSS_TENANT' | 'SAME_PROJECT' | 'CROSS_PROJECT' | 'UNKNOWN';
}

export interface BusinessStateProjection extends BusinessProjectionTrace {
  id: string;
  resourceId?: string;
  from?: string;
  action: string;
  to?: string;
}

export interface BusinessRuleProjection extends BusinessProjectionTrace {
  id: string;
  description: string;
  kind: 'PERMISSION' | 'ISOLATION' | 'STATE' | 'BUSINESS' | 'CONSTRAINT' | 'SIDE_EFFECT';
}

export interface BusinessDependencyProjection extends BusinessProjectionTrace {
  id: string;
  resourceId?: string;
  description: string;
  kind: 'RESOURCE' | 'EXTERNAL' | 'STATE' | 'BUSINESS';
}

export interface BusinessRiskProjection extends BusinessProjectionTrace {
  id: string;
  resourceIds: string[];
  category: 'SECURITY' | 'DATA_INTEGRITY' | 'FINANCIAL' | 'CONCURRENCY' | 'DEPENDENCY' | 'RECOVERY' | 'BUSINESS_CONTINUITY';
  level: 'P0' | 'P1' | 'P2';
  description: string;
}

export interface BusinessFlowStepProjection extends BusinessProjectionTrace {
  id: string;
  actorId?: string;
  resourceId?: string;
  action: string;
  operationRef?: string;
  fromState?: string;
  toState?: string;
  scopes: CanonicalScope[];
  dependsOn: string[];
}

export interface BusinessFlowProjection extends BusinessProjectionTrace {
  id: string;
  name: string;
  mode: 'SINGLE_OPERATION' | 'SEQUENCE' | 'PARALLEL' | 'CROSS_ACTOR' | 'CROSS_TENANT' | 'RECOVERY';
  actorIds: string[];
  resourceIds: string[];
  roleIds: string[];
  tenantIds: string[];
  projectIds: string[];
  steps: BusinessFlowStepProjection[];
}

/** AcceptanceRequirement 的业务语义投影；不复制或替代 Requirement Model。 */
export interface BusinessModelProjection {
  schemaVersion: 'BUSINESS_MODEL_PROJECTION_V1';
  requirementId: string;
  actors: BusinessActorProjection[];
  roles: Array<BusinessProjectionTrace & { id: string; name: string; actorIds: string[] }>;
  resources: BusinessResourceProjection[];
  ownerships: BusinessOwnershipProjection[];
  tenants: Array<BusinessProjectionTrace & { id: string; actorIds: string[]; resourceIds: string[] }>;
  projects: Array<BusinessProjectionTrace & { id: string; actorIds: string[]; resourceIds: string[] }>;
  states: BusinessStateProjection[];
  rules: BusinessRuleProjection[];
  dependencies: BusinessDependencyProjection[];
  risks: BusinessRiskProjection[];
  flows: BusinessFlowProjection[];
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}-${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12).toUpperCase()}`;
}

function trace(facts: readonly RequirementFact[]): BusinessProjectionTrace {
  return {
    factIds: [...new Set(facts.map((fact) => fact.id))],
    sources: facts.map((fact) => fact.source),
    confidence: facts.length ? Math.min(...facts.map((fact) => fact.confidence ?? 1)) : 1,
    conflict: facts.some((fact) => fact.status === 'BLOCKED'),
    conflictReasons: [...new Set(facts.filter((fact) => fact.status === 'BLOCKED')
      .map((fact) => fact.statusReason ?? `Fact ${fact.id} conflicted`))],
  };
}

function resourceKey(fact: RequirementFact): string {
  const resource = fact.canonical.resource;
  return JSON.stringify({ type: resource.kind, identifiers: resource.identifiers });
}

function relation(scopes: readonly CanonicalScope[]): BusinessOwnershipProjection['relation'] {
  if (scopes.some((scope) => scope.dimension === 'TENANT' && scope.relation === 'CROSS')) return 'CROSS_TENANT';
  if (scopes.some((scope) => scope.dimension === 'TENANT' && scope.relation === 'SAME')) return 'SAME_TENANT';
  if (scopes.some((scope) => scope.dimension === 'PROJECT' && scope.relation === 'CROSS')) return 'CROSS_PROJECT';
  if (scopes.some((scope) => scope.dimension === 'PROJECT' && scope.relation === 'SAME')) return 'SAME_PROJECT';
  if (scopes.some((scope) => scope.relation === 'OTHER')) return 'OTHER_USER';
  if (scopes.some((scope) => scope.relation === 'SELF' || scope.relation === 'OWNER_ONLY')) return 'SELF';
  return 'UNKNOWN';
}

function riskOf(fact: RequirementFact): Pick<BusinessRiskProjection, 'category' | 'level'> | undefined {
  const constraints = new Set(fact.canonical.constraints.map((item) => item.kind));
  if (fact.category === 'PERMISSION' || fact.category === 'AUTH' || fact.category === 'DATA_ISOLATION') return { category: 'SECURITY', level: 'P0' };
  if (fact.canonical.sideEffects.some((effect) => effect.kind === 'BILLING' || effect.kind === 'INVENTORY')) return { category: 'FINANCIAL', level: 'P0' };
  if (constraints.has('CONCURRENCY')) return { category: 'CONCURRENCY', level: 'P0' };
  if (constraints.has('RECOVERY')) return { category: 'RECOVERY', level: 'P0' };
  if (fact.canonical.sideEffects.some((effect) => effect.kind === 'EXTERNAL')) return { category: 'DEPENDENCY', level: 'P1' };
  if (fact.category === 'STATE' || fact.category === 'SIDE_EFFECT'
    || constraints.has('IDEMPOTENT') || constraints.has('ATOMIC') || constraints.has('CONSISTENCY')) {
    return { category: 'DATA_INTEGRITY', level: 'P0' };
  }
  if (fact.category === 'BUSINESS_RULE') return { category: 'BUSINESS_CONTINUITY', level: 'P1' };
  return undefined;
}

function factsForActor(requirement: AcceptanceRequirement, actorId: string): RequirementFact[] {
  return requirement.factLedger.filter((fact) => fact.canonical.actor?.id === actorId
    || fact.canonical.targetActor?.id === actorId
    || fact.entityRefs.items.some((ref) => ref.type === 'ACTOR' && ref.id === actorId));
}

/**
 * 从现有 Requirement IR/Fact Ledger 构建统一 Business Model Projection。
 * 所有关系均携带原 Fact/Source/Confidence/Conflict，禁止从用例文本二次猜测。
 */
export function buildBusinessModelProjection(requirement: AcceptanceRequirement): BusinessModelProjection {
  const resourceGroups = new Map<string, RequirementFact[]>();
  for (const fact of requirement.factLedger) {
    if (fact.canonical.resource.kind === 'UNKNOWN') continue;
    const key = resourceKey(fact);
    resourceGroups.set(key, [...(resourceGroups.get(key) ?? []), fact]);
  }
  const resources = [...resourceGroups.entries()].map(([key, facts]): BusinessResourceProjection => {
    const canonical = facts[0].canonical.resource;
    return {
      id: stableId('RES', key),
      type: canonical.kind,
      identifiers: { ...canonical.identifiers },
      expressions: [...new Set(facts.flatMap((fact) => fact.canonical.resource.expression ? [fact.canonical.resource.expression] : []))],
      ...trace(facts),
    };
  });
  const resourceByFact = new Map<string, BusinessResourceProjection>();
  for (const resource of resources) for (const factId of resource.factIds) resourceByFact.set(factId, resource);

  const actors = requirement.actors.map((actor): BusinessActorProjection => {
    const facts = factsForActor(requirement, actor.id);
    return { id: actor.id, name: actor.name, role: actor.role, userId: actor.userId, tenantId: actor.tenantId, projectId: actor.projectId, ...trace(facts) };
  });
  const roles = [...new Set(actors.map((actor) => actor.role))].map((name) => {
    const members = actors.filter((actor) => actor.role === name);
    const facts = requirement.factLedger.filter((fact) => members.some((actor) => actor.factIds.includes(fact.id)));
    return { id: stableId('ROLE', name), name, actorIds: members.map((actor) => actor.id), ...trace(facts) };
  });

  const ownerships: BusinessOwnershipProjection[] = requirement.factLedger.flatMap((fact) => {
    const resource = resourceByFact.get(fact.id);
    if (!resource || (!fact.canonical.scopes.length && !fact.canonical.actor && !fact.canonical.targetActor)) return [];
    const subject = actors.find((actor) => actor.id === fact.canonical.actor?.id);
    const target = actors.find((actor) => actor.id === fact.canonical.targetActor?.id);
    const rel = relation(fact.canonical.scopes);
    const owner = rel === 'OTHER_USER' || rel === 'CROSS_TENANT' || rel === 'CROSS_PROJECT' ? target : subject;
    return [{
      id: stableId('OWN', { fact: fact.id, resource: resource.id, scopes: fact.canonical.scopes }),
      resourceId: resource.id,
      ownerActorId: owner?.id,
      subjectActorId: subject?.id,
      tenantId: owner?.tenantId ?? subject?.tenantId,
      projectId: owner?.projectId ?? subject?.projectId,
      scopes: fact.canonical.scopes.map((scope) => ({ ...scope })),
      relation: rel,
      ...trace([fact]),
    }];
  });

  const configuredStates: BusinessStateProjection[] = requirement.stateRules.map((state) => {
    const facts = requirement.factLedger.filter((fact) => fact.entityRefs.items
      .some((ref) => ref.type === 'STATE_RULE' && ref.id === state.id));
    return { id: state.id, resourceId: facts.map((fact) => resourceByFact.get(fact.id)?.id).find(Boolean), from: state.from, action: state.action, to: state.to, ...trace(facts) };
  });
  const projectedStates: BusinessStateProjection[] = requirement.factLedger.flatMap((fact) => {
    const value = fact.canonical.expected.value;
    const transition = value && typeof value === 'object' && !Array.isArray(value)
      ? value as { from?: unknown; to?: unknown } : undefined;
    const constraint = fact.canonical.constraints.find((item) => item.kind === 'STATE_TRANSITION');
    if (fact.category !== 'STATE' && !transition?.from && !transition?.to && !constraint) return [];
    const configured = configuredStates.find((state) => state.factIds.includes(fact.id));
    if (configured?.from || configured?.to) return [];
    return [{
      id: configured?.id ?? stableId('STATE', fact.id),
      resourceId: resourceByFact.get(fact.id)?.id,
      from: transition?.from === undefined ? undefined : String(transition.from),
      action: fact.canonical.action.expression ?? fact.canonical.action.kind,
      to: transition?.to === undefined ? undefined : String(transition.to),
      ...trace([fact]),
    }];
  });
  const states = [...configuredStates, ...projectedStates];
  const rules: BusinessRuleProjection[] = [
    ...requirement.businessRules.map((rule) => {
      const facts = requirement.factLedger.filter((fact) => fact.entityRefs.items.some((ref) => ref.type === 'BUSINESS_RULE' && ref.id === rule.id));
      return { id: rule.id, description: rule.description, kind: 'BUSINESS' as const, ...trace(facts) };
    }),
    ...requirement.permissions.map((rule) => {
      const facts = requirement.factLedger.filter((fact) => fact.entityRefs.items.some((ref) => ref.type === 'PERMISSION' && ref.id === rule.id));
      return { id: rule.id, description: `${rule.actorRole} ${rule.effect} ${rule.action} ${rule.resource}`, kind: 'PERMISSION' as const, ...trace(facts) };
    }),
    ...requirement.isolationRules.map((rule) => {
      const facts = requirement.factLedger.filter((fact) => fact.entityRefs.items.some((ref) => ref.type === 'ISOLATION_RULE' && ref.id === rule.id));
      return { id: rule.id, description: `${rule.dimension} ${rule.subject} ${rule.expected} ${rule.resource}`, kind: 'ISOLATION' as const, ...trace(facts) };
    }),
    ...requirement.stateRules.map((rule) => {
      const state = states.find((item) => item.id === rule.id)!;
      const facts = requirement.factLedger.filter((fact) => state.factIds.includes(fact.id));
      return { id: `RULE-${rule.id}`, description: `${rule.from ?? '*'} --${rule.action}--> ${rule.to ?? '*'}`, kind: 'STATE' as const, ...trace(facts) };
    }),
  ];

  const dependencies = requirement.factLedger.flatMap((fact): BusinessDependencyProjection[] => {
    const resourceId = resourceByFact.get(fact.id)?.id;
    const external: BusinessDependencyProjection[] = fact.canonical.sideEffects.filter((effect) => effect.kind === 'EXTERNAL' || effect.observation === 'EXTERNAL').map((effect) => ({
      id: stableId('DEP', { fact: fact.id, effect: effect.expression }), resourceId,
      description: effect.expression, kind: 'EXTERNAL', ...trace([fact]),
    }));
    if (/(?:依赖|前置资源|上游|depends?\s+on|dependency)/i.test(fact.statement)) external.push({
      id: stableId('DEP', { fact: fact.id, statement: fact.statement }), resourceId,
      description: fact.statement, kind: 'RESOURCE', ...trace([fact]),
    });
    return external;
  });
  const risks = requirement.factLedger.flatMap((fact): BusinessRiskProjection[] => {
    const value = riskOf(fact);
    if (!value) return [];
    const resourceId = resourceByFact.get(fact.id)?.id;
    return [{ id: stableId('RISK', { fact: fact.id, category: value.category }), resourceIds: resourceId ? [resourceId] : [],
      ...value, description: fact.statement, ...trace([fact]) }];
  });

  const orderedFacts = [...requirement.factLedger]
    .filter((fact) => fact.normativity === 'NORMATIVE')
    .sort((left, right) => left.source.lineStart - right.source.lineStart);
  const flows: BusinessFlowProjection[] = orderedFacts.map((fact, index) => {
    const resource = resourceByFact.get(fact.id);
    const actorIds = [fact.canonical.actor?.id, fact.canonical.targetActor?.id].filter((id): id is string => Boolean(id));
    const scopedActors = actors.filter((actor) => actorIds.includes(actor.id));
    const state = states.find((item) => item.factIds.includes(fact.id));
    const scopes = fact.canonical.scopes.map((scope) => ({ ...scope }));
    const flowTrace = trace([fact]);
    const step: BusinessFlowStepProjection = {
      id: `FLOW-STEP-${String(index + 1).padStart(3, '0')}`,
      actorId: fact.canonical.actor?.id,
      resourceId: resource?.id,
      action: fact.canonical.action.kind,
      operationRef: fact.canonical.action.operationKey,
      fromState: state?.from,
      toState: state?.to,
      scopes,
      dependsOn: [],
      ...flowTrace,
    };
    return {
      id: stableId('FLOW', fact.id),
      name: fact.statement,
      mode: scopes.some((scope) => scope.dimension === 'TENANT' && scope.relation === 'CROSS') ? 'CROSS_TENANT'
        : actorIds.length > 1 ? 'CROSS_ACTOR'
          : fact.canonical.constraints.some((item) => item.kind === 'CONCURRENCY') ? 'PARALLEL'
            : fact.canonical.constraints.some((item) => item.kind === 'RECOVERY') ? 'RECOVERY' : 'SINGLE_OPERATION',
      actorIds,
      resourceIds: resource ? [resource.id] : [],
      roleIds: roles.filter((role) => scopedActors.some((actor) => role.actorIds.includes(actor.id))).map((role) => role.id),
      tenantIds: [...new Set(scopedActors.flatMap((actor) => actor.tenantId ? [actor.tenantId] : []))],
      projectIds: [...new Set(scopedActors.flatMap((actor) => actor.projectId ? [actor.projectId] : []))],
      steps: [step],
      ...flowTrace,
    };
  });

  const tenants = [...new Set(actors.flatMap((actor) => actor.tenantId ? [actor.tenantId] : []))].map((id) => {
    const members = actors.filter((actor) => actor.tenantId === id);
    const owned = ownerships.filter((ownership) => ownership.tenantId === id);
    const facts = requirement.factLedger.filter((fact) => [...members, ...owned].some((item) => item.factIds.includes(fact.id)));
    return { id, actorIds: members.map((actor) => actor.id), resourceIds: [...new Set(owned.map((item) => item.resourceId))], ...trace(facts) };
  });
  const projects = [...new Set(actors.flatMap((actor) => actor.projectId ? [actor.projectId] : []))].map((id) => {
    const members = actors.filter((actor) => actor.projectId === id);
    const owned = ownerships.filter((ownership) => ownership.projectId === id);
    const facts = requirement.factLedger.filter((fact) => [...members, ...owned].some((item) => item.factIds.includes(fact.id)));
    return { id, actorIds: members.map((actor) => actor.id), resourceIds: [...new Set(owned.map((item) => item.resourceId))], ...trace(facts) };
  });

  return { schemaVersion: 'BUSINESS_MODEL_PROJECTION_V1', requirementId: requirement.id, actors, roles, resources,
    ownerships, tenants, projects, states, rules, dependencies, risks, flows };
}

export function businessFlowForFacts(model: BusinessModelProjection, factIds: readonly string[]): BusinessFlowProjection | undefined {
  const matches = model.flows.filter((flow) => flow.factIds.some((id) => factIds.includes(id)));
  if (!matches.length) return undefined;
  if (matches.length === 1) return matches[0];
  const steps = matches.flatMap((flow) => flow.steps).map((step, index, all) => ({
    ...step,
    dependsOn: step.dependsOn.length ? step.dependsOn : index ? [all[index - 1].id] : [],
  }));
  return {
    id: stableId('FLOW', matches.map((flow) => flow.id)),
    name: matches.map((flow) => flow.name).join(' → '),
    mode: matches.some((flow) => flow.mode === 'CROSS_TENANT') ? 'CROSS_TENANT'
      : matches.some((flow) => flow.mode === 'CROSS_ACTOR') ? 'CROSS_ACTOR' : 'SEQUENCE',
    actorIds: [...new Set(matches.flatMap((flow) => flow.actorIds))],
    resourceIds: [...new Set(matches.flatMap((flow) => flow.resourceIds))],
    roleIds: [...new Set(matches.flatMap((flow) => flow.roleIds))],
    tenantIds: [...new Set(matches.flatMap((flow) => flow.tenantIds))],
    projectIds: [...new Set(matches.flatMap((flow) => flow.projectIds))],
    steps,
    factIds: [...new Set(matches.flatMap((flow) => flow.factIds))],
    sources: matches.flatMap((flow) => flow.sources),
    confidence: Math.min(...matches.map((flow) => flow.confidence)),
    conflict: matches.some((flow) => flow.conflict),
    conflictReasons: [...new Set(matches.flatMap((flow) => flow.conflictReasons))],
  };
}
