import type { AcceptanceRequirement, CanonicalConstraint } from '../acceptance/requirement-ir.js';
import type { DevTestDiscoveryResult, DevTestFeatureModel } from './types.js';

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function constraintText(constraint: CanonicalConstraint): string {
  return `${constraint.kind}${constraint.field ? `(${constraint.field})` : ''}: ${constraint.expression}`;
}

/** Acceptance Fact Ledger 是唯一语义来源；Feature Model 只是面向 DevTest 的统一只读投影。 */
export function buildDevTestFeatureModel(
  requirement: AcceptanceRequirement,
  discovery: DevTestDiscoveryResult,
): DevTestFeatureModel {
  const facts = requirement.factLedger.filter((fact) => fact.normativity === 'NORMATIVE');
  const actors = facts.flatMap((fact) => [fact.canonical.actor, fact.canonical.targetActor])
    .filter((actor): actor is NonNullable<typeof actor> => Boolean(actor));
  const scopes = facts.flatMap((fact) => fact.canonical.scopes);
  const sideEffects = facts.flatMap((fact) => fact.canonical.sideEffects);
  const constraints = facts.flatMap((fact) => fact.canonical.constraints);
  const discoveredKeys = new Set(discovery.mappedOperations.map((item) => `${item.method} ${item.path}`));
  const apis = requirement.apis.map((api) => ({
    id: api.id, method: api.method, path: api.path, authPolicy: api.authPolicy,
    source: discoveredKeys.has(api.operationKey) ? 'DISCOVERY' as const : 'REQUIREMENT' as const,
  }));
  const inputs = requirement.apis.flatMap((api) => [
    ...api.headers, ...api.query, ...api.pathParams, ...api.body,
  ].map((parameter) => ({
    api: api.operationKey, name: parameter.name, type: parameter.type, location: parameter.location,
    required: parameter.required,
    constraints: [
      parameter.min === undefined ? undefined : `min=${parameter.min}`,
      parameter.max === undefined ? undefined : `max=${parameter.max}`,
      parameter.minLength === undefined ? undefined : `minLength=${parameter.minLength}`,
      parameter.maxLength === undefined ? undefined : `maxLength=${parameter.maxLength}`,
      parameter.pattern ? `pattern=${parameter.pattern}` : undefined,
      parameter.enum ? `enum=${JSON.stringify(parameter.enum)}` : undefined,
    ].filter((item): item is string => Boolean(item)),
  })));
  const unresolved = unique(facts.flatMap((fact) => fact.canonical.unresolved)
    .concat(requirement.warnings.filter((warning) => warning.blocking).map((warning) => warning.message)));
  return {
    feature: {
      id: requirement.features[0]?.id ?? requirement.id,
      name: requirement.features[0]?.name ?? requirement.title,
      description: requirement.features[0]?.description,
    },
    actors: actors.map((actor) => ({ id: actor.id, role: actor.role, kind: actor.kind, source: actor.source })),
    roles: unique([...requirement.actors.map((actor) => actor.role), ...actors.map((actor) => actor.role).filter((item): item is string => Boolean(item))]),
    tenants: unique([...requirement.actors.map((actor) => actor.tenantId).filter((item): item is string => Boolean(item)),
      ...scopes.filter((scope) => scope.dimension === 'TENANT').map((scope) => scope.expression)]),
    projects: unique(scopes.filter((scope) => scope.dimension === 'PROJECT').map((scope) => scope.expression)),
    resources: unique(facts.map((fact) => fact.canonical.resource.kind).filter((item) => item !== 'UNKNOWN')),
    operations: facts.map((fact) => ({ action: fact.canonical.action.kind, expression: fact.canonical.action.expression,
      operationKey: fact.canonical.action.operationKey })).filter((item, index, all) =>
      all.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(item)) === index),
    apis,
    ui: [
      ...requirement.pages.map((page) => ({ path: page.path, kind: 'PAGE', source: 'REQUIREMENT' })),
      ...discovery.mappedUi.map((item) => ({ element: item.name, kind: item.kind, source: item.source })),
    ],
    states: unique(requirement.stateRules.map((rule) => rule.action)
      .concat(constraints.filter((item) => item.kind === 'STATE_TRANSITION' || item.kind === 'UI_STATE').map((item) => item.expression))),
    inputs,
    outputs: requirement.apis.flatMap((api) => api.responses.map((response) => ({
      api: api.operationKey, status: response.status, description: response.description,
    }))),
    permissions: requirement.permissions.map((permission) => ({ role: permission.actorRole, action: permission.action,
      resource: permission.resource, effect: permission.effect })),
    sideEffects: sideEffects.map((effect) => ({ kind: effect.kind, action: effect.action,
      observation: effect.observation, expression: effect.expression })),
    billing: unique(sideEffects.filter((effect) => effect.kind === 'BILLING').map((effect) => effect.expression)),
    externalDependencies: unique(sideEffects.filter((effect) => ['EXTERNAL', 'MESSAGE', 'BILLING'].includes(effect.kind))
      .map((effect) => effect.expression)),
    constraints: unique(constraints.map(constraintText)),
    unresolved,
  };
}
