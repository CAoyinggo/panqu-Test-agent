import type { AssertionDefinition, TestActor, TestCase, TestType } from '../agents/test-design/testcase-schema.js';
import type { AcceptanceRequirement, ActorSpec, ApiSpec, ParameterSpec } from './requirement-ir.js';
import type { TestPoint } from './test-point.js';
import { assignStableAcceptanceCaseIds } from './acceptance-execution-plan.js';

interface ParameterVector {
  kind: 'MISSING' | 'MIN_MINUS' | 'MIN' | 'MIN_PLUS' | 'MAX_MINUS' | 'MAX' | 'MAX_PLUS' | 'EMPTY' | 'NULL' | 'INVALID_TYPE' | 'DECIMAL' | 'EXTREME' | 'FORMAT_INVALID' | 'ENUM_INVALID';
  label: string;
  value: unknown;
  expectedStatus?: number;
  expectedOutcome: 'ACCEPT' | 'REJECT';
  constraint: string;
  omit?: boolean;
  designReason?: string;
  coveredKinds?: ParameterVector['kind'][];
}

function actorOf(actor: ActorSpec | undefined): TestActor | undefined {
  return actor ? {
    id: actor.id,
    userId: actor.userId,
    role: actor.role,
    tenantId: actor.tenantId,
    tokenRef: actor.tokenRef,
    provenance: 'CONFIGURED',
  } : undefined;
}

function safePattern(pattern: string | undefined): RegExp | undefined {
  if (!pattern) return undefined;
  try {
    return new RegExp(pattern);
  } catch {
    return undefined;
  }
}

function parameterAccepts(parameter: ParameterSpec, value: unknown): boolean {
  if (value === null) return parameter.nullable === true;
  if (parameter.enum?.length && !parameter.enum.some((candidate) => Object.is(candidate, value))) return false;
  if (parameter.type === 'string') {
    if (typeof value !== 'string') return false;
    if (parameter.minLength !== undefined && value.length < parameter.minLength) return false;
    if (parameter.maxLength !== undefined && value.length > parameter.maxLength) return false;
    const pattern = safePattern(parameter.pattern);
    if (parameter.pattern && (!pattern || !pattern.test(value))) return false;
    return true;
  }
  if (parameter.type === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) return false;
  } else if (parameter.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  } else if (parameter.type === 'boolean' && typeof value !== 'boolean') return false;
  else if (parameter.type === 'array' && !Array.isArray(value)) return false;
  else if (parameter.type === 'object' && (typeof value !== 'object' || Array.isArray(value))) return false;
  if (typeof value === 'number') {
    if (parameter.min !== undefined && value < parameter.min) return false;
    if (parameter.max !== undefined && value > parameter.max) return false;
  }
  return true;
}

function stringAcceptsExcept(
  parameter: ParameterSpec,
  value: string,
  excluded: 'pattern' | 'enum',
): boolean {
  if (parameter.minLength !== undefined && value.length < parameter.minLength) return false;
  if (parameter.maxLength !== undefined && value.length > parameter.maxLength) return false;
  if (excluded !== 'enum' && parameter.enum?.length
    && !parameter.enum.some((candidate) => Object.is(candidate, value))) return false;
  const pattern = safePattern(parameter.pattern);
  if (excluded !== 'pattern' && parameter.pattern && (!pattern || !pattern.test(value))) return false;
  return true;
}

function singleFaultString(parameter: ParameterSpec, target: 'pattern' | 'enum'): string | undefined {
  const minimum = parameter.minLength ?? 0;
  const maximum = parameter.maxLength ?? Math.max(minimum, 8);
  if (minimum > maximum) return undefined;
  const lengths = [...new Set([minimum, Math.min(maximum, Math.max(minimum, 1)), Math.min(maximum, Math.max(minimum, 2)), maximum])]
    .filter((length) => length >= 0 && length <= 64);
  const seeds = ['A', 'Z', 'a', 'z', '0', '1', '_', '-', '!', 'x', 'invalid', 'aa', 'ZZ', '00', ''];
  for (const length of lengths) {
    for (const seed of seeds) {
      const value = seed.length === length ? seed : (seed[0] ?? 'x').repeat(length);
      if (!stringAcceptsExcept(parameter, value, target)) continue;
      if (target === 'pattern') {
        const pattern = safePattern(parameter.pattern);
        if (pattern && !pattern.test(value)) return value;
      } else if (parameter.enum?.length && !parameter.enum.some((candidate) => Object.is(candidate, value))) {
        return value;
      }
    }
  }
  return undefined;
}

function validStringValue(parameter: ParameterSpec, exactLength?: number): string | undefined {
  const minimum = exactLength ?? parameter.minLength ?? 0;
  const maximum = exactLength ?? parameter.maxLength ?? Math.max(minimum, 2);
  if (minimum > maximum || maximum < 0) return undefined;
  const preferredLength = exactLength ?? Math.min(maximum, Math.max(minimum, Math.min(2, maximum)));
  const literal = parameter.pattern?.match(/^\^([A-Za-z0-9 _.-]+)\$$/)?.[1];
  const patternChars = [...new Set((parameter.pattern?.match(/[A-Za-z0-9]/g) ?? []))];
  const seeds = [
    parameter.default,
    ...(parameter.enum ?? []),
    literal,
    ...patternChars,
    'Z', 'A', 'a', '0', '1', '_', '-', 'test', 'aa', '',
  ].filter((candidate): candidate is string => typeof candidate === 'string');
  const candidates = new Set<string>();
  for (const seed of seeds) {
    candidates.add(seed);
    if (preferredLength >= 0 && seed.length !== preferredLength) {
      const unit = seed[0] ?? 'a';
      candidates.add(unit.repeat(preferredLength));
    }
  }
  for (const candidate of candidates) {
    if ((exactLength === undefined || candidate.length === exactLength) && parameterAccepts(parameter, candidate)) return candidate;
  }
  return undefined;
}

function validValue(parameter: ParameterSpec): unknown {
  if (parameter.default !== undefined && parameterAccepts(parameter, parameter.default)) return parameter.default;
  if (parameter.enum?.length) {
    const enumValue = parameter.enum.find((candidate) => parameterAccepts(parameter, candidate));
    if (enumValue !== undefined) return enumValue;
  }
  if (parameter.type === 'string') return validStringValue(parameter);
  if (parameter.type === 'integer' || parameter.type === 'number') {
    const candidate = parameter.min !== undefined && parameter.max !== undefined
      ? Math.max(parameter.min, Math.min(parameter.max, 30))
      : parameter.min ?? 1;
    return parameter.type === 'integer' ? Math.trunc(candidate) : candidate;
  }
  if (parameter.type === 'boolean') return true;
  if (parameter.type === 'array') return [];
  if (parameter.type === 'object') return {};
  return 'valid';
}

function validBody(api: ApiSpec): Record<string, unknown> {
  return Object.fromEntries(api.body
    .filter((parameter) => parameter.required || parameter.default !== undefined)
    .map((parameter) => [parameter.name, validValue(parameter)]));
}

function pathValues(api: ApiSpec, targetId: string): Record<string, unknown> {
  return Object.fromEntries(api.pathParams.map((parameter) => [
    parameter.name,
    api.pathParams.length === 1
      && parameter.type === 'string' && /(?:^id$|id$)/i.test(parameter.name) && targetId !== 'no-target'
      ? targetId
      : parameter.default,
  ]));
}

function queryValues(api: ApiSpec): Record<string, unknown> {
  return Object.fromEntries(api.query
    .filter((parameter) => parameter.required || parameter.default !== undefined)
    .map((parameter) => [parameter.name, validValue(parameter)]));
}

function headerValues(api: ApiSpec): Record<string, string> {
  return Object.fromEntries(api.headers
    .filter((parameter) => !/^(?:authorization|cookie|set-cookie|x-api-key|api-key)$/i.test(parameter.name))
    .filter((parameter) => parameter.required || parameter.default !== undefined)
    .map((parameter) => [parameter.name, String(validValue(parameter))]));
}

function apiRequiresActor(api: ApiSpec): boolean {
  return api.authPolicy === 'AUTH_REQUIRED' || api.headers.some((header) =>
    header.required && /^(?:authorization|cookie|x-api-key|api-key)$/i.test(header.name));
}

function vectorsFor(parameter: ParameterSpec, successStatus?: number, invalidStatus?: number): ParameterVector[] {
  const vectors: ParameterVector[] = [];
  if (parameter.required && parameter.location !== 'path') {
    vectors.push({ kind: 'MISSING', label: 'missing', value: undefined, expectedStatus: invalidStatus, expectedOutcome: 'REJECT', constraint: 'required field omitted', omit: true });
  }
  if (parameter.type === 'string') {
    if (parameter.minLength !== undefined) {
      if (parameter.minLength > 0) vectors.push(
        { kind: 'MIN_MINUS', label: 'min-1', value: 'a'.repeat(parameter.minLength - 1), expectedStatus: invalidStatus, expectedOutcome: 'REJECT', constraint: `minLength-1=${parameter.minLength - 1}` },
      );
      if (parameter.maxLength === undefined || parameter.minLength <= parameter.maxLength) vectors.push(
        { kind: 'MIN', label: 'min', value: 'a'.repeat(parameter.minLength), expectedStatus: successStatus, expectedOutcome: 'ACCEPT', constraint: `minLength=${parameter.minLength}` },
      );
      if (parameter.maxLength === undefined || parameter.minLength + 1 <= parameter.maxLength) vectors.push(
        { kind: 'MIN_PLUS', label: 'min+1', value: 'a'.repeat(parameter.minLength + 1), expectedStatus: successStatus, expectedOutcome: 'ACCEPT', constraint: `minLength+1=${parameter.minLength + 1}` },
      );
    }
    if (parameter.maxLength !== undefined) {
      if (parameter.maxLength > 0 && (parameter.minLength === undefined || parameter.maxLength - 1 >= parameter.minLength)) vectors.push(
        { kind: 'MAX_MINUS', label: 'max-1', value: 'a'.repeat(parameter.maxLength - 1), expectedStatus: successStatus, expectedOutcome: 'ACCEPT', constraint: `maxLength-1=${parameter.maxLength - 1}` },
      );
      if (parameter.minLength === undefined || parameter.maxLength >= parameter.minLength) vectors.push(
        { kind: 'MAX', label: 'max', value: 'a'.repeat(parameter.maxLength), expectedStatus: successStatus, expectedOutcome: 'ACCEPT', constraint: `maxLength=${parameter.maxLength}` },
      );
      vectors.push(
        { kind: 'MAX_PLUS', label: 'max+1', value: 'a'.repeat(parameter.maxLength + 1), expectedStatus: invalidStatus, expectedOutcome: 'REJECT', constraint: `maxLength+1=${parameter.maxLength + 1}` },
      );
    }
    vectors.push(
      { kind: 'EMPTY', label: 'empty', value: '', expectedStatus: parameter.minLength !== undefined && parameter.minLength > 0 ? invalidStatus : undefined, expectedOutcome: parameter.minLength !== undefined && parameter.minLength > 0 ? 'REJECT' : 'ACCEPT', constraint: 'empty string' },
      { kind: 'NULL', label: 'null', value: null, expectedStatus: parameter.nullable ? successStatus : invalidStatus, expectedOutcome: parameter.nullable ? 'ACCEPT' : 'REJECT', constraint: `nullable=${parameter.nullable}` },
      { kind: 'INVALID_TYPE', label: 'wrong-type', value: 12345, expectedStatus: invalidStatus, expectedOutcome: 'REJECT', constraint: 'type=string' },
    );
    if (parameter.pattern) {
      const value = singleFaultString(parameter, 'pattern');
      vectors.push({
        kind: 'FORMAT_INVALID', label: 'format-invalid', value,
        expectedStatus: invalidStatus, expectedOutcome: 'REJECT', constraint: `pattern=${parameter.pattern}`,
        designReason: value === undefined
          ? 'SINGLE_FAULT_VECTOR_UNAVAILABLE：无法生成仅违反 pattern 且满足其他显式约束的确定性输入'
          : undefined,
      });
    }
    if (parameter.enum?.length) {
      const value = singleFaultString(parameter, 'enum');
      vectors.push({
        kind: 'ENUM_INVALID', label: 'enum-invalid', value,
        expectedStatus: invalidStatus, expectedOutcome: 'REJECT', constraint: `enum=${JSON.stringify(parameter.enum)}`,
        designReason: value === undefined
          ? 'SINGLE_FAULT_VECTOR_UNAVAILABLE：无法生成仅违反 enum 且满足其他显式约束的确定性输入'
          : undefined,
      });
    }
  } else if (parameter.type === 'integer' || parameter.type === 'number') {
    if (parameter.min !== undefined) {
      vectors.push(
        { kind: 'MIN_MINUS', label: 'min-1', value: parameter.min - 1, expectedStatus: invalidStatus, expectedOutcome: 'REJECT', constraint: `min-1=${parameter.min - 1}` },
      );
      if (parameter.max === undefined || parameter.min <= parameter.max) vectors.push(
        { kind: 'MIN', label: 'min', value: parameter.min, expectedStatus: successStatus, expectedOutcome: 'ACCEPT', constraint: `min=${parameter.min}` },
      );
      if (parameter.max === undefined || parameter.min + 1 <= parameter.max) vectors.push(
        { kind: 'MIN_PLUS', label: 'min+1', value: parameter.min + 1, expectedStatus: successStatus, expectedOutcome: 'ACCEPT', constraint: `min+1=${parameter.min + 1}` },
      );
    }
    if (parameter.max !== undefined) {
      if (parameter.min === undefined || parameter.max - 1 >= parameter.min) vectors.push(
        { kind: 'MAX_MINUS', label: 'max-1', value: parameter.max - 1, expectedStatus: successStatus, expectedOutcome: 'ACCEPT', constraint: `max-1=${parameter.max - 1}` },
      );
      if (parameter.min === undefined || parameter.max >= parameter.min) vectors.push(
        { kind: 'MAX', label: 'max', value: parameter.max, expectedStatus: successStatus, expectedOutcome: 'ACCEPT', constraint: `max=${parameter.max}` },
      );
      vectors.push(
        { kind: 'MAX_PLUS', label: 'max+1', value: parameter.max + 1, expectedStatus: invalidStatus, expectedOutcome: 'REJECT', constraint: `max+1=${parameter.max + 1}` },
      );
    }
    vectors.push(
      { kind: 'EMPTY', label: 'empty', value: '', expectedStatus: invalidStatus, expectedOutcome: 'REJECT', constraint: 'empty value' },
      { kind: 'NULL', label: 'null', value: null, expectedStatus: parameter.nullable ? successStatus : invalidStatus, expectedOutcome: parameter.nullable ? 'ACCEPT' : 'REJECT', constraint: `nullable=${parameter.nullable}` },
      { kind: 'INVALID_TYPE', label: 'wrong-type', value: 'abc', expectedStatus: invalidStatus, expectedOutcome: 'REJECT', constraint: `type=${parameter.type}` },
      ...(parameter.type === 'integer' ? [{ kind: 'DECIMAL' as const, label: 'decimal', value: 18.5, expectedStatus: invalidStatus, expectedOutcome: 'REJECT' as const, constraint: 'integer rejects decimal' }] : []),
      { kind: 'EXTREME', label: 'extreme', value: Number.MAX_SAFE_INTEGER, expectedStatus: parameter.max !== undefined ? invalidStatus : undefined, expectedOutcome: parameter.max !== undefined ? 'REJECT' : 'ACCEPT', constraint: 'extreme numeric value' },
    );
  }
  const normalized = vectors.flatMap((vector): ParameterVector[] => {
    if (parameter.type !== 'string' || typeof vector.value !== 'string') return [vector];
    const acceptedByFullContract = parameterAccepts(parameter, vector.value);
    if (vector.expectedOutcome === 'ACCEPT' && !acceptedByFullContract) {
      if (vector.kind === 'EMPTY' && invalidStatus !== undefined) {
        return [{ ...vector, expectedOutcome: 'REJECT', expectedStatus: invalidStatus, constraint: `${vector.constraint}; violates explicit string contract` }];
      }
      const replacement = validStringValue(parameter, vector.value.length);
      if (replacement !== undefined) return [{ ...vector, value: replacement }];
      // This boundary position has no value satisfying the combined explicit
      // constraints (for example maxLength=1 with pattern ^Z$ at length 0).
      // Omitting it is safer than sending an invalid value with a 2xx oracle.
      return [];
    }
    if (vector.expectedOutcome === 'REJECT' && acceptedByFullContract) {
      const alternatives = ['__invalid_format__', '!', 'x', '0', ''].filter((value) => !parameterAccepts(parameter, value));
      return alternatives.length ? [{ ...vector, value: alternatives[0] }] : [];
    }
    return [vector];
  });
  const byInput = new Map<string, ParameterVector>();
  for (const vector of normalized) {
    const key = `${JSON.stringify(vector.value)}:${vector.expectedOutcome}:${vector.expectedStatus ?? 'UNRESOLVED'}`;
    const existing = byInput.get(key);
    if (!existing) {
      byInput.set(key, { ...vector, coveredKinds: [vector.kind] });
      continue;
    }
    existing.coveredKinds = [...new Set([...(existing.coveredKinds ?? [existing.kind]), vector.kind])];
    if (!existing.constraint.includes(vector.constraint)) existing.constraint = `${existing.constraint}; ${vector.constraint}`;
    existing.designReason ??= vector.designReason;
  }
  return [...byInput.values()];
}

function vectorsForStrategy(vectors: ParameterVector[], point: TestPoint): ParameterVector[] {
  const selected = new Set<ParameterVector['kind']>();
  if (point.strategies.includes('VALID_INVALID')) return vectors;
  if (point.strategies.includes('REQUIRED_MISSING')) selected.add('MISSING');
  if (point.canonicalFact.constraints.some((constraint) => constraint.kind === 'TYPE')) {
    selected.add('INVALID_TYPE');
    selected.add('DECIMAL');
  }
  if (point.canonicalFact.constraints.some((constraint) => constraint.kind === 'NULLABLE')) selected.add('NULL');
  if (point.strategies.includes('MIN_MAX_BOUNDARY')) {
    ['MIN_MINUS', 'MIN', 'MIN_PLUS', 'MAX_MINUS', 'MAX', 'MAX_PLUS', 'EMPTY', 'NULL', 'INVALID_TYPE', 'DECIMAL', 'EXTREME']
      .forEach((kind) => selected.add(kind as ParameterVector['kind']));
  }
  if (point.strategies.includes('FORMAT_VALID_INVALID')) selected.add('FORMAT_INVALID');
  if (point.strategies.includes('ENUM_VALID_INVALID')) selected.add('ENUM_INVALID');
  if (!selected.size) return vectors;
  return vectors.flatMap((vector): ParameterVector[] => {
    const covered = vector.coveredKinds ?? [vector.kind];
    const selectedKind = covered.find((kind) => selected.has(kind));
    return selectedKind ? [{ ...vector, kind: selectedKind }] : [];
  });
}

function assertionsFor(
  status: number,
  body: Record<string, unknown> | undefined,
  api: ApiSpec,
  validateReturnedBody: boolean,
  point: TestPoint,
): AssertionDefinition[] {
  const trace = {
    factIds: point.factIds,
    objectiveId: point.objectiveId,
    objectiveIds: [point.objectiveId],
    sourceType: point.sourceType,
    provenance: point.provenance,
  };
  const assertions: AssertionDefinition[] = [{ type: 'STATUS_CODE', expected: status, severity: status >= 400 ? 'P1' : 'P0', ...trace }];
  // 只有需求明确声明“返回更新后的数据”时才推导响应体断言。
  // API Request schema 不是 Response schema；把请求字段无条件当响应字段会制造假失败。
  if (validateReturnedBody && status >= 200 && status < 300 && api.method !== 'HEAD') {
    assertions.push({ type: 'JSON_PATH', path: 'data.id', severity: 'P0', ...trace });
    for (const [name, value] of Object.entries(body ?? {})) {
      assertions.push({ type: 'JSON_VALUE', path: `data.${name}`, expected: value, severity: 'P0', ...trace });
    }
  }
  return assertions;
}

function statusFrom(point: TestPoint, api: ApiSpec): number | undefined {
  const explicit = point.canonicalFact.expected.status;
  if (explicit !== undefined) return explicit;
  if (point.canonicalFact.actor?.kind === 'ANONYMOUS') {
    return api.responses.find((response) => response.status === 401)?.status;
  }
  if (point.canonicalFact.expected.kind === 'DENY') {
    // A deny fact without a declared deny response is incomplete. Never fall
    // through to the operation's success response.
    return api.responses.find((response) => response.status === 403)?.status;
  }
  if (point.canonicalFact.expected.kind === 'NOT_FOUND') {
    return api.responses.find((response) => response.status === 404)?.status;
  }
  if (['FAILURE', 'INVALID'].includes(point.canonicalFact.expected.kind)) {
    return api.responses.find((response) => response.status >= 400)?.status;
  }
  // Strategy can know that an explicit Method+Path must bind without knowing
  // its HTTP result. Never turn that binding oracle into an implicit 2xx.
  if (point.canonicalFact.expected.kind === 'UNKNOWN') return undefined;
  return api.responses.find((response) => response.status >= 200 && response.status < 300)?.status;
}

function testTypeOf(point: TestPoint): TestType {
  // API_CRUD_FUNCTION adds a FUNCTIONAL Objective to an API Fact, but it does
  // not change the Case's source contract into a standalone functional action.
  // Keep the compiled Case API-typed while retaining both Objective traces.
  if (point.dimension === 'FUNCTIONAL' && point.strategyIds.includes('API_CRUD_FUNCTION')) return 'API';
  return point.category;
}

function traceOf(requirement: AcceptanceRequirement, point: TestPoint): NonNullable<TestCase['source']> {
  return {
    requirementId: requirement.id,
    testPointId: point.id,
    acceptanceCriteriaIds: point.acceptanceCriteriaIds,
    factIds: point.factIds,
    objectiveIds: [point.objectiveId],
    scenarioId: point.scenarioId,
    sourceType: point.sourceType,
    provenance: point.provenance,
    apiSpecId: point.apiBinding?.apiSpecId,
    apiOperationKey: point.apiBinding?.operationKey,
    documentId: point.source?.documentId,
    section: point.source?.section,
    line: point.source?.line,
  };
}

function actorMentionedByObjective(requirement: AcceptanceRequirement, point: TestPoint): ActorSpec | undefined {
  return actorsMentionedByObjective(requirement, point)[0];
}

function actorsMentionedByObjective(requirement: AcceptanceRequirement, point: TestPoint): ActorSpec[] {
  return [point.canonicalFact.actor?.id, point.canonicalFact.targetActor?.id]
    .filter((id): id is string => Boolean(id))
    .map((id) => requirement.actors.find((actor) => actor.id === id))
    .filter((actor): actor is ActorSpec => Boolean(actor));
}

function primaryActor(requirement: AcceptanceRequirement, point: TestPoint): ActorSpec | undefined {
  const explicit = actorMentionedByObjective(requirement, point);
  if (explicit) return explicit;
  const role = point.canonicalFact.actor?.role;
  if (role) {
    const unique = actorWithUniqueRole(requirement, role);
    if (unique) return unique;
  }
  const ownerOnly = point.canonicalFact.expected.kind === 'ALLOW'
    && (point.canonicalFact.constraints.some((constraint) => constraint.kind === 'OWNER_ONLY')
      || point.canonicalFact.scopes.some((scope) => scope.relation === 'OWNER_ONLY' || scope.relation === 'SELF'));
  // For an explicit “USER may access own resource” Fact, any configured USER
  // is a valid representative. Document order gives deterministic identity and
  // the target is derived from that same actor; no cross-user permission is invented.
  if (ownerOnly && role) return requirement.actors.find((actor) => actor.role.toLowerCase() === role.toLowerCase());
  const scopedDeny = point.canonicalFact.expected.kind === 'DENY'
    && point.canonicalFact.scopes.some((scope) => scope.relation === 'OTHER' || scope.relation === 'CROSS');
  if (!scopedDeny) return undefined;
  if (role) return requirement.actors.find((actor) => actor.role.toLowerCase() === role.toLowerCase());
  const crossTenant = point.canonicalFact.scopes.some((scope) => scope.dimension === 'TENANT' && scope.relation === 'CROSS');
  return crossTenant
    ? requirement.actors.find((actor) => actor.tenantId
      && requirement.actors.some((candidate) => candidate.tenantId && candidate.tenantId !== actor.tenantId))
    : undefined;
}

function actorForApi(requirement: AcceptanceRequirement, point: TestPoint, api: ApiSpec): ActorSpec | undefined {
  if (point.canonicalFact.constraints.some((constraint) => constraint.kind === 'AUTH_NOT_REQUIRED')) return undefined;
  return primaryActor(requirement, point)
    ?? (apiRequiresActor(api) && requirement.actors.length === 1 ? requirement.actors[0] : undefined);
}

function actorWithUniqueRole(requirement: AcceptanceRequirement, role: string): ActorSpec | undefined {
  const matching = requirement.actors.filter((actor) => actor.role.toLowerCase() === role.toLowerCase());
  return matching.length === 1 ? matching[0] : undefined;
}

function explicitActorRelation(
  requirement: AcceptanceRequirement,
  point: TestPoint,
): { source?: ActorSpec; target?: ActorSpec } {
  const source = point.canonicalFact.actor?.id
    ? requirement.actors.find((actor) => actor.id === point.canonicalFact.actor?.id)
    : primaryActor(requirement, point);
  const target = point.canonicalFact.targetActor?.id
    ? requirement.actors.find((actor) => actor.id === point.canonicalFact.targetActor?.id)
    : undefined;
  return { source, target };
}

function otherActor(requirement: AcceptanceRequirement, actor: ActorSpec | undefined, crossTenant = false): ActorSpec | undefined {
  return requirement.actors.find((candidate) => candidate.id !== actor?.id
    && (crossTenant ? Boolean(actor?.tenantId && candidate.tenantId && candidate.tenantId !== actor.tenantId) : true));
}

function isolationTargetActor(
  requirement: AcceptanceRequirement,
  point: TestPoint,
  sourceActor: ActorSpec | undefined,
): ActorSpec | undefined {
  if (!sourceActor) return undefined;
  const relation = explicitActorRelation(requirement, point);
  if (relation.target) return relation.target;
  if (point.canonicalFact.scopes.some((scope) => scope.relation === 'SELF' || scope.relation === 'OWNER_ONLY')) return sourceActor;
  const sameTenant = point.canonicalFact.scopes.some((scope) => scope.dimension === 'TENANT' && scope.relation === 'SAME');
  const crossTenant = point.canonicalFact.scopes.some((scope) => scope.dimension === 'TENANT' && scope.relation === 'CROSS');
  const candidates = requirement.actors
    .filter((candidate): candidate is ActorSpec => Boolean(candidate && candidate.id !== sourceActor.id))
    .filter((candidate, index, all) => all.findIndex((item) => item.id === candidate.id) === index);
  if (sameTenant) return candidates.find((candidate) => Boolean(sourceActor.tenantId && candidate.tenantId === sourceActor.tenantId));
  if (crossTenant) return candidates.find((candidate) => Boolean(sourceActor.tenantId && candidate.tenantId && candidate.tenantId !== sourceActor.tenantId));
  return candidates[0];
}

function actorTarget(actor: ActorSpec | undefined): string | undefined {
  return actor?.userId ?? actor?.id;
}

function explicitPathTarget(api: ApiSpec, point: TestPoint): string | undefined {
  if (api.pathParams.length !== 1) return undefined;
  const parameter = api.pathParams[0].name;
  const entry = Object.entries(point.canonicalFact.resource.identifiers)
    .find(([name]) => name.toLowerCase() === parameter.toLowerCase());
  return entry?.[1];
}

function actorCanProvidePathTarget(api: ApiSpec, point: TestPoint): boolean {
  if (api.pathParams.length !== 1) return false;
  const parameter = api.pathParams[0].name;
  if (/(?:^|\/)(?:users?|profiles?|accounts?|members?)(?:\/|$)/i.test(api.path)
    && /^(?:id|userId|accountId|profileId|memberId)$/i.test(parameter)) return true;
  return ['PERMISSION', 'DATA_ISOLATION', 'AUTH'].includes(point.category)
    && /^(?:id|userId|ownerId|accountId|tenantId)$/i.test(parameter);
}

function configuredPathTarget(
  api: ApiSpec,
  point: TestPoint,
  actor: ActorSpec | undefined,
): string | undefined {
  if (api.pathParams.length !== 1) return undefined;
  return explicitPathTarget(api, point)
    ?? api.pathParams.find((parameter) => parameter.default !== undefined)?.default?.toString()
    ?? (actorCanProvidePathTarget(api, point) ? actorTarget(actor) : undefined);
}

function designAssertion(point: TestPoint): AssertionDefinition[] {
  if (point.outcomeStatus !== 'KNOWN') return [];
  const statusAssertion: AssertionDefinition[] = point.canonicalFact.expected.status === undefined ? [] : [{
    type: 'STATUS_CODE',
    expected: point.canonicalFact.expected.status,
    severity: point.canonicalFact.expected.status >= 400 ? 'P1' : point.priority,
    factIds: point.factIds,
    objectiveId: point.objectiveId,
    objectiveIds: [point.objectiveId],
    sourceType: point.sourceType,
    provenance: point.provenance,
  }];
  return [...statusAssertion, {
    type: 'DESIGN_EXPECTATION',
    expected: point.expectedOutcome,
    description: point.expectedOutcome,
    severity: point.priority,
    factIds: point.factIds,
    objectiveId: point.objectiveId,
    objectiveIds: [point.objectiveId],
    sourceType: point.sourceType,
    provenance: point.provenance,
  }];
}

function designedOnlyCase(
  requirement: AcceptanceRequirement,
  point: TestPoint,
  id: string,
  reason: string,
  actions: string[] = [point.objective],
): TestCase {
  return {
    id,
    feature: requirement.features[0]?.name ?? requirement.title,
    name: point.objective,
    priority: point.priority,
    testType: testTypeOf(point),
    executionMode: 'DESIGNED_ONLY',
    source: traceOf(requirement, point),
    tags: ['acceptance', 'designed-only', point.dimension.toLowerCase(), point.sourceType.toLowerCase()],
    preconditions: point.preconditions,
    steps: [],
    assertions: designAssertion(point),
    expected: point.outcomeStatus === 'KNOWN' ? { description: point.expectedOutcome } : undefined,
    design: {
      objectiveIds: [point.objectiveId],
      factIds: point.factIds,
      scenarioId: point.scenarioId,
      sourceType: point.sourceType,
      expectedOutcome: point.expectedOutcome,
      actions,
      executability: 'DESIGNED_ONLY',
      reason,
    },
    metadata: { reason, objective: point.objective, dimension: point.dimension },
  };
}

/** 只消费 Normalizer 明确提取的响应字段和值；Generator 不再重读需求文本。 */
function explicitFieldAssertions(_requirement: AcceptanceRequirement, point: TestPoint): AssertionDefinition[] {
  const assertions: AssertionDefinition[] = [];
  const value = point.canonicalFact.expected.value;
  const fields = value && typeof value === 'object' && !Array.isArray(value)
    && 'fields' in value && value.fields && typeof value.fields === 'object' && !Array.isArray(value.fields)
    ? value.fields as Record<string, unknown> : {};
  for (const [path, expected] of Object.entries(fields)) {
    assertions.push({
      type: 'JSON_VALUE', path, expected, severity: point.priority,
      factIds: point.factIds, objectiveId: point.objectiveId, objectiveIds: [point.objectiveId],
      sourceType: point.sourceType, provenance: point.provenance,
    });
  }
  return assertions.filter((assertion, index, all) => all.findIndex((candidate) => candidate.path === assertion.path
    && Object.is(candidate.expected, assertion.expected)) === index);
}

function mergeUnique<T>(left: T[] = [], right: T[] = []): T[] {
  return [...new Set([...left, ...right])];
}

function testTypeRank(type: TestType | undefined): number {
  const order: TestType[] = [
    // AUTH_NOT_REQUIRED 是 Operation 的执行上下文，不应覆盖同一次请求的
    // CRUD/API 业务意图。更高风险的 Permission/Isolation 等仍保持高优先级。
    'AUTH', 'API', 'FUNCTIONAL', 'UI', 'COMPATIBILITY', 'PERFORMANCE', 'ERROR', 'PARAMETER',
    'BOUNDARY', 'SECURITY', 'PERMISSION', 'STATE', 'SIDE_EFFECT', 'CLEANUP',
    'BUSINESS_RULE', 'DATA_ISOLATION', 'HYBRID',
  ];
  return order.indexOf(type ?? 'FUNCTIONAL');
}

/** 基于真实执行语义去重，并把覆盖的 Fact/Objective 合并到同一 Case。 */
export function deduplicateAcceptanceCases(input: TestCase[]): TestCase[] {
  const output: TestCase[] = [];
  const bySemanticKey = new Map<string, TestCase>();
  for (const testCase of input) {
    const request = testCase.steps.find((step) => step.type === 'HTTP_REQUEST');
    const isExecutableRequest = testCase.executionMode === 'EXECUTABLE' && request?.type === 'HTTP_REQUEST';
    const key = JSON.stringify({
      executionMode: testCase.executionMode,
      protocol: testCase.protocol,
      actor: testCase.actor ? { id: testCase.actor.id, role: testCase.actor.role, tenantId: testCase.actor.tenantId } : null,
      preconditions: testCase.executionMode === 'EXECUTABLE' ? undefined : testCase.preconditions,
      data: isExecutableRequest ? undefined : testCase.data,
      steps: testCase.steps,
      expected: testCase.executionMode === 'EXECUTABLE'
        ? { status: testCase.expected?.status, fields: testCase.expected?.fields }
        : testCase.expected,
      // A parameter label is trace metadata, not an execution difference. The
      // same Actor/HTTP input/oracle is one execution; this is safety-critical
      // for mutations and also avoids redundant reads.
      parameter: !isExecutableRequest && testCase.parameterContext ? {
        name: testCase.parameterContext.parameter,
        vector: testCase.parameterContext.boundaryVector,
        value: testCase.parameterContext.testData,
      } : null,
      designActions: testCase.executionMode === 'EXECUTABLE' ? undefined : testCase.design?.actions,
    });
    const existing = bySemanticKey.get(key);
    if (!existing) {
      bySemanticKey.set(key, testCase);
      output.push(testCase);
      continue;
    }
    if (existing.source && testCase.source) {
      existing.source.factIds = mergeUnique(existing.source.factIds, testCase.source.factIds);
      existing.source.objectiveIds = mergeUnique(existing.source.objectiveIds, testCase.source.objectiveIds);
      existing.source.acceptanceCriteriaIds = mergeUnique(existing.source.acceptanceCriteriaIds, testCase.source.acceptanceCriteriaIds);
    }
    if (existing.design && testCase.design) {
      existing.design.factIds = mergeUnique(existing.design.factIds, testCase.design.factIds);
      existing.design.objectiveIds = mergeUnique(existing.design.objectiveIds, testCase.design.objectiveIds);
    }
    existing.preconditions = mergeUnique(existing.preconditions, testCase.preconditions);
    existing.tags = mergeUnique(existing.tags, testCase.tags);
    existing.parameterContext ??= testCase.parameterContext;
    const parameterCoverage = [
      ...(existing.parameterCoverage ?? (existing.parameterContext ? [{
        parameter: existing.parameterContext.parameter,
        constraint: existing.parameterContext.constraint,
        testData: existing.parameterContext.testData,
        expectedResponse: existing.parameterContext.expectedResponse,
        expectedOutcome: existing.parameterContext.expectedOutcome,
        boundaryVectors: existing.parameterContext.boundaryVector ? [existing.parameterContext.boundaryVector] : [],
      }] : [])),
      ...(testCase.parameterCoverage ?? (testCase.parameterContext ? [{
        parameter: testCase.parameterContext.parameter,
        constraint: testCase.parameterContext.constraint,
        testData: testCase.parameterContext.testData,
        expectedResponse: testCase.parameterContext.expectedResponse,
        expectedOutcome: testCase.parameterContext.expectedOutcome,
        boundaryVectors: testCase.parameterContext.boundaryVector ? [testCase.parameterContext.boundaryVector] : [],
      }] : [])),
    ];
    if (parameterCoverage.length) {
      existing.parameterCoverage = [];
      for (const coverage of parameterCoverage) {
        const same = existing.parameterCoverage.find((candidate) => candidate.parameter === coverage.parameter
          && JSON.stringify(candidate.testData) === JSON.stringify(coverage.testData)
          && candidate.expectedResponse === coverage.expectedResponse
          && candidate.expectedOutcome === coverage.expectedOutcome);
        if (same) {
          same.boundaryVectors = mergeUnique(same.boundaryVectors, coverage.boundaryVectors);
          if (!same.constraint.includes(coverage.constraint)) same.constraint = `${same.constraint}; ${coverage.constraint}`;
        } else {
          existing.parameterCoverage.push({ ...coverage, boundaryVectors: [...coverage.boundaryVectors] });
        }
      }
    }
    if (testTypeRank(testCase.testType) > testTypeRank(existing.testType)) existing.testType = testCase.testType;
    for (const assertion of testCase.assertions) {
      const same = existing.assertions.find((candidate) => candidate.type === assertion.type && candidate.path === assertion.path
        && JSON.stringify(candidate.expected) === JSON.stringify(assertion.expected));
      if (!same) existing.assertions.push(assertion);
      else {
        same.factIds = mergeUnique(same.factIds, assertion.factIds);
        same.objectiveIds = mergeUnique(same.objectiveIds ?? (same.objectiveId ? [same.objectiveId] : []), assertion.objectiveIds ?? (assertion.objectiveId ? [assertion.objectiveId] : []));
      }
    }
  }
  return output;
}

/** Test Point → 可执行 HTTP TestCase；不能落到 API 操作的点明确保留为 DESCRIPTIVE_ONLY。 */
export function generateAcceptanceApiCases(requirement: AcceptanceRequirement, points: TestPoint[]): TestCase[] {
  const apiById = new Map(requirement.apis.map((api) => [api.id, api]));
  let sequence = 0;
  const nextId = (): string => `API-${String(++sequence).padStart(3, '0')}`;
  const cases: TestCase[] = [];
  const feature = requirement.features[0]?.name ?? requirement.title;

  const buildCase = (input: {
    point: TestPoint;
    api: ApiSpec;
    name: string;
    actor?: ActorSpec;
    targetId: string;
    body?: Record<string, unknown>;
    pathParams?: Record<string, unknown>;
    query?: Record<string, unknown>;
    headers?: Record<string, string>;
    status: number;
    parameter?: { spec: ParameterSpec; vector: ParameterVector };
    extraAssertions?: AssertionDefinition[];
    negativeContractIntent?: TestCase['negativeContractIntent'];
  }): TestCase => {
    const actor = actorOf(input.actor);
    return {
      id: nextId(),
      feature,
      name: input.name,
      priority: input.point.priority,
      testType: testTypeOf(input.point),
      executionMode: 'EXECUTABLE',
      source: traceOf(requirement, input.point),
      protocol: 'HTTP',
      actor,
      tags: ['acceptance', 'api', input.point.category.toLowerCase(), input.point.sourceType.toLowerCase()],
      preconditions: input.point.preconditions,
      data: { targetId: input.targetId },
      steps: [{
        type: 'HTTP_REQUEST', method: input.api.method, url: input.api.path,
        pathParams: input.pathParams ?? pathValues(input.api, input.targetId),
        query: input.query ?? queryValues(input.api),
        headers: input.headers ?? headerValues(input.api),
        ...(input.api.method === 'GET' || input.api.method === 'HEAD' || input.body === undefined ? {} : { body: input.body }),
        actor,
      }],
      assertions: [
        ...assertionsFor(
          input.status,
          input.body,
          input.api,
          requirement.factLedger.some((fact) => input.point.factIds.includes(fact.id)
            && /返回.*(?:更新后|创建后|请求中).*(?:资料|数据|字段)/i.test(fact.statement)),
          input.point,
        ),
        ...(input.extraAssertions ?? []),
      ],
      expected: { status: String(input.status), description: input.point.expectedOutcome },
      design: {
        objectiveIds: [input.point.objectiveId],
        factIds: input.point.factIds,
        scenarioId: input.point.scenarioId,
        sourceType: input.point.sourceType,
        expectedOutcome: input.point.expectedOutcome,
        actions: [`${input.api.method} ${input.api.path}`, `验证：${input.point.expectedOutcome}`],
        executability: 'EXECUTABLE',
      },
      metadata: { source: 'acceptance-generator', objective: input.point.objective, dimension: input.point.dimension },
      parameterContext: input.parameter ? {
        parameter: input.parameter.spec.name,
        constraint: input.parameter.vector.constraint,
        testData: input.parameter.vector.value,
        expectedResponse: input.parameter.vector.expectedStatus,
        expectedOutcome: input.parameter.vector.expectedOutcome,
        boundaryVector: input.parameter.vector.kind,
      } : undefined,
      parameterCoverage: input.parameter ? [{
        parameter: input.parameter.spec.name,
        constraint: input.parameter.vector.constraint,
        testData: input.parameter.vector.value,
        expectedResponse: input.parameter.vector.expectedStatus,
        expectedOutcome: input.parameter.vector.expectedOutcome,
        boundaryVectors: input.parameter.vector.coveredKinds ?? [input.parameter.vector.kind],
      }] : undefined,
      negativeContractIntent: input.negativeContractIntent,
    };
  };

  for (const point of points) {
    if (point.executionTarget === 'UI' || (point.executionTarget === 'FUNCTIONAL' && !point.apiBinding)
      || (point.executionTarget === 'DATA' && !point.apiBinding)) {
      const reason = point.executionTarget === 'UI'
        ? 'UI_EXECUTOR_UNAVAILABLE：UI 测试已设计，但当前核心链没有 Browser/UI Processor'
        : point.executionTarget === 'DATA'
          ? 'DATA_EXECUTOR_UNAVAILABLE：数据验证已设计，但当前没有可靠 Data Connector 与状态证据'
          : point.outcomeStatus === 'UNKNOWN'
            ? 'EXPECTED_OUTCOME_UNKNOWN：需求未声明可判定结果，禁止猜测'
            : 'EXECUTION_ACTION_UNAVAILABLE：测试目标没有可绑定的执行动作';
      cases.push(designedOnlyCase(requirement, point, nextId(), reason));
      continue;
    }
    const api = point.apiBinding ? apiById.get(point.apiBinding.apiSpecId) : undefined;
    if (!api || point.bindingIssue) {
      const reason = point.bindingIssue
        ? `${point.bindingIssue.code}：${point.bindingIssue.message}`
        : `API_NOT_FOUND：${point.apiBinding?.apiSpecId ?? '未绑定'} 不存在`;
      const designed = designedOnlyCase(requirement, point, nextId(), reason);
      designed.metadata = { ...designed.metadata, bindingIssue: point.bindingIssue?.code ?? 'API_NOT_FOUND' };
      cases.push(designed);
      continue;
    }

    if (api.authPolicy === 'AUTH_UNKNOWN') {
      cases.push(designedOnlyCase(
        requirement,
        point,
        nextId(),
        'AUTH_POLICY_UNKNOWN：Operation 未显式声明 AUTH_REQUIRED 或 AUTH_NOT_REQUIRED，禁止猜测 anonymous/credentialed 身份并执行',
      ));
      continue;
    }

    if (point.sourceType === 'HEURISTIC') {
      cases.push(designedOnlyCase(
        requirement,
        point,
        nextId(),
        'HEURISTIC_EXECUTION_NOT_AUTHORIZED：该测试建议来自标准启发式/推导信息，不是 Requirement/API Contract/Configuration 的可执行约束',
      ));
      continue;
    }

    if (point.category === 'PERFORMANCE') {
      cases.push(designedOnlyCase(
        requirement,
        point,
        nextId(),
        'PERFORMANCE_EXECUTOR_UNAVAILABLE：当前 HTTP Runner 只能验证响应契约，不能证明未量化的延迟、吞吐或并发目标',
      ));
      continue;
    }

    if (api.pathParams.length > 1) {
      cases.push(designedOnlyCase(
        requirement,
        point,
        nextId(),
        'MULTI_PATH_BINDING_INCOMPLETE：当前执行计划没有逐参数的 EXPLICIT/CONFIGURED/DataPrepare Path 值，禁止把单个标量复制到多个资源参数',
      ));
      continue;
    }

    if (point.sourceType === 'CONTRACT'
      && point.category === 'API'
      && point.acceptanceCriteriaIds.length === 0
      && api.responses.filter((response) => response.status >= 200 && response.status < 300).length > 1) {
      cases.push(designedOnlyCase(
        requirement,
        point,
        nextId(),
        'SUCCESS_RESPONSE_AMBIGUOUS：同一 Operation 声明多个 2xx，但没有条件把输入映射到唯一预期；禁止重复执行写请求',
      ));
      continue;
    }

    if (api.responses.filter((response) => response.status >= 200 && response.status < 300).length > 1
      && point.canonicalFact.expected.status === undefined) {
      cases.push(designedOnlyCase(
        requirement,
        point,
        nextId(),
        'SUCCESS_RESPONSE_AMBIGUOUS：当前测试目标没有把输入/场景映射到多个 2xx 中的唯一预期状态，禁止任选一个状态或重复执行',
      ));
      continue;
    }

    // Business/state semantics need a state probe, not an HTTP status. Resolve
    // this before status binding so “任一失败时全部回滚” cannot be downgraded
    // to a generic BINDING_INCOMPLETE merely because no failure status exists.
    if (['BUSINESS_RULE', 'STATE', 'HYBRID'].includes(point.category)
      && explicitFieldAssertions(requirement, point).length === 0) {
      cases.push(designedOnlyCase(
        requirement,
        point,
        nextId(),
        'BUSINESS_OBSERVABILITY_MISSING：需求没有声明可执行的状态探针、字段或后置查询，禁止用 HTTP Status 代替业务验证',
        [`执行 ${api.operationKey}`, `验证业务后置条件：${point.expectedOutcome}`],
      ));
      continue;
    }

    const defaultStatus = statusFrom(point, api);
    if (defaultStatus === undefined) {
      point.bindingIssue = {
        code: 'BINDING_INCOMPLETE', stage: 'BINDING', blocking: true,
        message: `${point.id} 无法从 AC 或 ${api.id} 响应契约确定预期状态`,
        source: point.source, sourceAcId: point.acceptanceCriteriaIds[0], sourceTestPointId: point.id,
        candidateApiSpecIds: [api.id],
      };
      const designed = designedOnlyCase(requirement, point, nextId(), `BINDING_INCOMPLETE：${point.bindingIssue.message}`);
      designed.metadata = { ...designed.metadata, bindingIssue: 'BINDING_INCOMPLETE' };
      cases.push(designed);
      continue;
    }

    if (point.category === 'UI') {
      cases.push(designedOnlyCase(requirement, point, nextId(), 'UI_EXECUTOR_UNAVAILABLE：HTTP Operation 不能作为 UI 证据'));
      continue;
    }

    if (['SIDE_EFFECT', 'CLEANUP'].includes(point.category)) {
      cases.push(designedOnlyCase(
        requirement,
        point,
        nextId(),
        'EXTERNAL_EVIDENCE_UNAVAILABLE：HTTP 响应字段只能证明响应契约，不能证明邮件、扣费、库存、消息或清理等真实副作用已经发生',
        [`执行 ${api.operationKey}`, `通过 Event/DB/Provider Connector 验证真实副作用：${point.expectedOutcome}`],
      ));
      continue;
    }

    if (['BUSINESS_RULE', 'STATE', 'HYBRID'].includes(point.category)) {
      const semanticAssertions = explicitFieldAssertions(requirement, point);
      if (!semanticAssertions.length) {
        cases.push(designedOnlyCase(
          requirement,
          point,
          nextId(),
          'BUSINESS_OBSERVABILITY_MISSING：需求没有声明可执行的状态探针、字段或后置查询，禁止用 HTTP Status 代替业务验证',
          [`执行 ${api.operationKey}`, `验证业务后置条件：${point.expectedOutcome}`],
        ));
        continue;
      }
      const body = api.body.length ? validBody(api) : undefined;
      const semanticActor = actorForApi(requirement, point, api);
      const semanticTarget = configuredPathTarget(api, point, semanticActor);
      if (api.pathParams.length && !semanticTarget) {
        cases.push(designedOnlyCase(requirement, point, nextId(), 'TEST_DATA_UNAVAILABLE：业务规则 Case 缺少明确目标资源 ID'));
        continue;
      }
      cases.push(buildCase({
        point, api, name: `${point.acceptanceCriteriaIds[0] ?? point.id} ${api.operationKey} 业务规则`,
        actor: semanticActor, targetId: semanticTarget ?? 'no-target', body,
        status: defaultStatus,
        extraAssertions: semanticAssertions,
      }));
      continue;
    }

    if (point.category === 'PARAMETER' || point.category === 'BOUNDARY') {
      const allParameters = [...api.pathParams, ...api.query, ...api.headers, ...api.body];
      const referenced = point.parameterNames.length
        ? allParameters.filter((parameter) => point.parameterNames.some((name) => name.toLowerCase() === parameter.name.toLowerCase()))
        : [];
      const parameters = referenced.length ? referenced : allParameters.length === 1 ? allParameters : [];
      if (!parameters.length) {
        cases.push(designedOnlyCase(requirement, point, nextId(), 'PARAMETER_TARGET_AMBIGUOUS：参数类 Fact 未唯一指向 ApiSpec 参数'));
        continue;
      }
      const explicitStatusNumber = point.canonicalFact.expected.status;
      const successStatus = explicitStatusNumber !== undefined && explicitStatusNumber < 400
        ? explicitStatusNumber
        : api.responses.find((response) => response.status >= 200 && response.status < 300)?.status;
      const invalidStatus = explicitStatusNumber !== undefined && explicitStatusNumber >= 400
        ? explicitStatusNumber
        : api.responses.find((response) => response.status >= 400)?.status;
      const parameterVectors = parameters.map((parameter) => ({
        parameter,
        vectors: vectorsForStrategy(vectorsFor(parameter, successStatus, invalidStatus), point),
      }));
      const configuredActor = actorForApi(requirement, point, api);
      const configuredTarget = configuredPathTarget(api, point, configuredActor);
      if (apiRequiresActor(api) && !configuredActor) {
        const designed = designedOnlyCase(
          requirement,
          point,
          nextId(),
          'ACTOR_CONTEXT_INCOMPLETE：认证接口的参数测试没有可唯一选择的 EXPLICIT/CONFIGURED Actor，禁止任选身份执行',
        );
        designed.metadata = { ...designed.metadata, bindingIssue: 'ACTOR_CONTEXT_INCOMPLETE' };
        cases.push(designed);
        continue;
      }
      for (const { parameter, vectors } of parameterVectors) {
        for (const vector of vectors) {
          if (vector.designReason) {
            const designed = designedOnlyCase(
              requirement,
              point,
              nextId(),
              vector.designReason,
              [`构造 ${parameter.name}/${vector.kind} 单故障输入`, `验证 ${vector.constraint}`],
            );
            designed.name = `${point.acceptanceCriteriaIds[0] ?? point.id} ${parameter.name} ${vector.label}`;
            designed.parameterContext = {
              parameter: parameter.name,
              constraint: vector.constraint,
              testData: vector.value,
              expectedResponse: vector.expectedStatus,
              expectedOutcome: vector.expectedOutcome,
              boundaryVector: vector.kind,
            };
            cases.push(designed);
            continue;
          }
          if (parameter.location === 'path' && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(api.method)) {
            const designed = designedOnlyCase(
              requirement,
              point,
              nextId(),
              'MUTATION_PATH_FIXTURE_UNAVAILABLE：生成的 Path 边界值不等于已隔离准备的真实资源；禁止直接对猜测 ID 发起写操作',
            );
            designed.name = `${point.acceptanceCriteriaIds[0] ?? point.id} ${parameter.name} ${vector.label}`;
            designed.parameterContext = {
              parameter: parameter.name,
              constraint: vector.constraint,
              testData: vector.value,
              expectedResponse: vector.expectedStatus,
              expectedOutcome: vector.expectedOutcome,
              boundaryVector: vector.kind,
            };
            cases.push(designed);
            continue;
          }
          const vectorSuppliesCompletePath = parameter.location === 'path'
            && api.pathParams.length === 1
            && vector.value !== null
            && vector.value !== undefined
            && String(vector.value).length > 0;
          if (parameter.location === 'path' && vector.expectedOutcome === 'ACCEPT' && !configuredTarget) {
            const designed = designedOnlyCase(
              requirement,
              point,
              nextId(),
              'TEST_DATA_UNAVAILABLE：合法 Path 边界值没有对应的已存在隔离资源，不能把 2xx/成功当作可靠预期',
            );
            designed.name = `${point.acceptanceCriteriaIds[0] ?? point.id} ${parameter.name} ${vector.label}`;
            designed.parameterContext = {
              parameter: parameter.name,
              constraint: vector.constraint,
              testData: vector.value,
              expectedResponse: vector.expectedStatus,
              expectedOutcome: vector.expectedOutcome,
              boundaryVector: vector.kind,
            };
            cases.push(designed);
            continue;
          }
          if (api.pathParams.length && !configuredTarget && !vectorSuppliesCompletePath) {
            const designed = designedOnlyCase(
              requirement,
              point,
              nextId(),
              'TEST_DATA_UNAVAILABLE：Path 资源标识没有 EXPLICIT/CONFIGURED 来源，禁止使用生成器硬编码 ID',
              [`准备可访问的 ${api.pathParams.map((item) => item.name).join(', ')} 资源`, `设置 ${parameter.location} 参数 ${parameter.name}=${JSON.stringify(vector.value)}`],
            );
            designed.name = `${point.acceptanceCriteriaIds[0] ?? point.id} ${parameter.name} ${vector.label}`;
            designed.parameterContext = {
              parameter: parameter.name,
              constraint: vector.constraint,
              testData: vector.value,
              expectedResponse: vector.expectedStatus,
              expectedOutcome: vector.expectedOutcome,
              boundaryVector: vector.kind,
            };
            cases.push(designed);
            continue;
          }
          if (vector.expectedStatus === undefined) {
            const designed = designedOnlyCase(
              requirement,
              point,
              nextId(),
              `EXPECTED_STATUS_UNRESOLVED：${parameter.name}/${vector.kind} 的 ${vector.expectedOutcome} 语义没有明确 HTTP Response，禁止默认推断 200/400`,
              [`设置 ${parameter.location} 参数 ${parameter.name}=${JSON.stringify(vector.value)}`, `${vector.expectedOutcome === 'ACCEPT' ? '接受' : '拒绝'}该输入`],
            );
            designed.name = `${point.acceptanceCriteriaIds[0] ?? point.id} ${parameter.name} ${vector.label}`;
            designed.parameterContext = {
              parameter: parameter.name,
              constraint: vector.constraint,
              testData: vector.value,
              expectedOutcome: vector.expectedOutcome,
              boundaryVector: vector.kind,
            };
            cases.push(designed);
            continue;
          }
          const body = api.body.length ? validBody(api) : undefined;
          const pathParams = pathValues(api, configuredTarget ?? 'unused');
          const query = queryValues(api);
          const headers = headerValues(api);
          if (parameter.location === 'body' && body) {
            if (vector.omit) delete body[parameter.name]; else body[parameter.name] = vector.value;
          }
          if (parameter.location === 'path') pathParams[parameter.name] = vector.value;
          if (parameter.location === 'query') {
            if (vector.omit) delete query[parameter.name]; else query[parameter.name] = vector.value;
          }
          if (parameter.location === 'header') {
            if (vector.omit) delete headers[parameter.name]; else headers[parameter.name] = String(vector.value);
          }
          const negativeContractIntent: NonNullable<TestCase['negativeContractIntent']> | undefined = vector.expectedStatus >= 400
            ? parameter.location === 'body'
              ? vector.omit ? { omittedBodyFields: [parameter.name] } : { invalidBodyFields: [parameter.name] }
              : parameter.location === 'query'
                ? vector.omit ? { omittedQueryParams: [parameter.name] } : { invalidQueryParams: [parameter.name] }
                : parameter.location === 'header'
                  ? vector.omit ? { omittedHeaders: [parameter.name] } : { invalidHeaders: [parameter.name] }
                  : { invalidPathParams: [parameter.name] }
            : undefined;
          cases.push(buildCase({
            point, api,
            name: `${point.acceptanceCriteriaIds[0] ?? point.id} ${parameter.name} ${vector.label}`,
            actor: configuredActor, targetId: configuredTarget ?? 'no-target', body,
            pathParams, query, headers,
            status: vector.expectedStatus, parameter: { spec: parameter, vector },
            negativeContractIntent,
          }));
        }
      }
      continue;
    }

    const body = api.body.length ? validBody(api) : undefined;
    const relation = explicitActorRelation(requirement, point);
    const authNotRequired = point.canonicalFact.constraints.some((constraint) => constraint.kind === 'AUTH_NOT_REQUIRED');
    // Public 的业务 Fact 即使在文字里点名了某个配置 Actor，也必须使用匿名
    // 请求证明“无需认证”；不能让 relation.source 绕过 actorForApi 的约束。
    const configuredActor = authNotRequired ? undefined : relation.source ?? actorForApi(requirement, point, api);
    const explicitlyRelatedTarget = relation.target;
    const configuredTarget = configuredPathTarget(api, point, explicitlyRelatedTarget ?? configuredActor);
    const anonymousAuthScenario = authNotRequired || point.canonicalFact.actor?.kind === 'ANONYMOUS';
    const unsupportedAuthScenario = /(?:token|凭据|认证).*(?:过期|失效|无效|撤销|错误|scope|audience)|(?:expired|invalid|revoked|near-expiry|wrong\s+audience|missing\s+scope).*(?:token|credential|auth|凭据|认证)/i.test(point.objective);
    if (unsupportedAuthScenario || (/\b401\b/.test(point.objective) && !anonymousAuthScenario)) {
      cases.push(designedOnlyCase(requirement, point, nextId(), 'AUTH_SCENARIO_UNSUPPORTED：当前 Actor Runtime 不能确定性准备 expired/invalid/revoked/scope/audience 凭据，禁止改写为 anonymous'));
    } else if (anonymousAuthScenario) {
      if (api.pathParams.length && !configuredTarget) {
        cases.push(designedOnlyCase(requirement, point, nextId(), 'TEST_DATA_UNAVAILABLE：匿名场景缺少明确目标资源 ID'));
      } else {
        cases.push(buildCase({
          point, api, name: `${point.acceptanceCriteriaIds[0] ?? point.id} ${api.method} ${api.path} 未登录`,
          targetId: configuredTarget ?? 'no-target', body, status: defaultStatus,
          negativeContractIntent: { omittedHeaders: api.headers.filter((header) => /^(?:authorization|cookie|x-api-key|api-key)$/i.test(header.name)).map((header) => header.name) },
        }));
      }
    } else if (point.canonicalFact.expected.kind === 'NOT_FOUND') {
      if (apiRequiresActor(api) && !configuredActor) {
        cases.push(designedOnlyCase(requirement, point, nextId(), 'ACTOR_CONTEXT_INCOMPLETE：认证接口的不存在资源场景没有明确 Actor，禁止匿名改写'));
      } else if (api.pathParams.length && !explicitPathTarget(api, point)) {
        cases.push(designedOnlyCase(requirement, point, nextId(), 'TEST_DATA_UNAVAILABLE：不存在资源场景缺少显式 Path 参数值，禁止使用可能真实存在的硬编码 ID'));
      } else {
        cases.push(buildCase({ point, api, name: `${point.acceptanceCriteriaIds[0] ?? point.id} ${api.method} ${api.path} 不存在`, actor: configuredActor, targetId: explicitPathTarget(api, point) ?? 'no-target', body, status: defaultStatus }));
      }
    } else if (point.dimension === 'DATA_ISOLATION') {
      const sourceActor = configuredActor;
      const targetActor = isolationTargetActor(requirement, point, sourceActor);
      if (!sourceActor || !targetActor || !actorTarget(targetActor)) {
        cases.push(designedOnlyCase(requirement, point, nextId(), 'ISOLATION_CONTEXT_INCOMPLETE：需要至少两个 EXPLICIT/CONFIGURED Actor/Scope 与资源归属，禁止硬编码 A/B'));
      } else if ((point.canonicalFact.expected.kind === 'DENY' || defaultStatus === 403)
        && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(api.method)) {
        const designed = designedOnlyCase(requirement, point, nextId(), 'NON_MUTATION_EVIDENCE_UNAVAILABLE：隔离写操作不能只断言拒绝状态；缺少后置状态证据证明未发生跨范围修改');
        designed.actor = actorOf(sourceActor);
        designed.data = { targetId: actorTarget(targetActor)! };
        cases.push(designed);
      } else {
        cases.push(buildCase({ point, api, name: `${point.acceptanceCriteriaIds[0] ?? point.id} ${api.method} ${api.path} 跨数据范围`, actor: sourceActor, targetId: actorTarget(targetActor)!, body, status: defaultStatus }));
      }
    } else if (point.canonicalFact.actor?.kind === 'ADMIN') {
      const admin = configuredActor?.role.toUpperCase() === 'ADMIN'
        ? configuredActor
        : actorWithUniqueRole(requirement, 'ADMIN');
      const target = explicitlyRelatedTarget ?? otherActor(requirement, admin);
      if (!admin || (api.pathParams.length && !actorTarget(target))) {
        cases.push(designedOnlyCase(requirement, point, nextId(), 'ACTOR_CONTEXT_INCOMPLETE：需求提到管理员，但没有对应 CONFIGURED Actor/目标资源'));
      } else {
        cases.push(buildCase({ point, api, name: `${point.acceptanceCriteriaIds[0] ?? point.id} ${api.method} ${api.path} 管理员`, actor: admin, targetId: actorTarget(target) ?? 'no-target', body, status: defaultStatus }));
      }
    } else if (point.canonicalFact.expected.kind === 'DENY') {
      const sourceActor = configuredActor;
      const crossTenant = point.canonicalFact.scopes.some((scope) => scope.dimension === 'TENANT' && scope.relation === 'CROSS');
      const target = explicitlyRelatedTarget ?? otherActor(requirement, sourceActor, crossTenant);
      if (!sourceActor || !target || !actorTarget(target)) {
        cases.push(designedOnlyCase(requirement, point, nextId(), 'ACTOR_CONTEXT_INCOMPLETE：拒绝语义缺少明确 Subject/Target Actor 与资源归属'));
      } else if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(api.method)) {
        const designed = designedOnlyCase(requirement, point, nextId(), 'NON_MUTATION_EVIDENCE_UNAVAILABLE：拒绝写操作不能只断言 403；缺少后置查询/DB/Event 证据证明资源未被修改');
        designed.actor = actorOf(sourceActor);
        designed.data = { targetId: actorTarget(target)! };
        cases.push(designed);
      } else {
        cases.push(buildCase({ point, api, name: `${point.acceptanceCriteriaIds[0] ?? point.id} ${api.method} ${api.path} 无权限`, actor: sourceActor, targetId: actorTarget(target)!, body, status: defaultStatus }));
      }
    } else if (point.canonicalFact.expected.status === 403) {
      cases.push(designedOnlyCase(requirement, point, nextId(), 'AUTH_SCENARIO_AMBIGUOUS：403 未说明角色、Scope、Tenant 或目标资源，禁止推断身份场景'));
    } else if (defaultStatus >= 400) {
      cases.push(designedOnlyCase(requirement, point, nextId(), `ERROR_SCENARIO_UNSUPPORTED：期望 ${defaultStatus}，但需求没有提供当前 Runner 可确定性准备的错误前置条件`));
    } else {
      if (apiRequiresActor(api) && !configuredActor) {
        cases.push(designedOnlyCase(requirement, point, nextId(), 'ACTOR_CONTEXT_INCOMPLETE：认证接口没有可唯一选择的 CONFIGURED Actor'));
      } else if (api.pathParams.length && !configuredTarget) {
        cases.push(designedOnlyCase(requirement, point, nextId(), 'TEST_DATA_UNAVAILABLE：资源 Path Parameter 没有 EXPLICIT/CONFIGURED 值'));
      } else {
        cases.push(buildCase({ point, api, name: `${point.acceptanceCriteriaIds[0] ?? point.id} ${api.method} ${api.path}`, actor: configuredActor, targetId: configuredTarget ?? 'no-target', body, status: defaultStatus }));
      }
    }
  }
  return assignStableAcceptanceCaseIds(coalesceCoveredOperationDesignCases(
    failCloseAmbiguousExecutableOracles(deduplicateAcceptanceCases(cases)),
  ));
}

function failCloseAmbiguousExecutableOracles(input: TestCase[]): TestCase[] {
  const groups = new Map<string, TestCase[]>();
  for (const testCase of input) {
    if (testCase.executionMode !== 'EXECUTABLE') continue;
    const request = testCase.steps.find((step) => step.type === 'HTTP_REQUEST');
    if (!request || request.type !== 'HTTP_REQUEST') continue;
    const signature = JSON.stringify({
      actor: testCase.actor ? { id: testCase.actor.id, userId: testCase.actor.userId, role: testCase.actor.role, tenantId: testCase.actor.tenantId } : null,
      method: request.method,
      url: request.url,
      pathParams: request.pathParams,
      query: request.query,
      headers: request.headers,
      body: request.body,
    });
    const group = groups.get(signature) ?? [];
    group.push(testCase);
    groups.set(signature, group);
  }
  for (const group of groups.values()) {
    const statuses = new Set(group.flatMap((testCase) => testCase.assertions
      .filter((assertion) => assertion.type === 'STATUS_CODE')
      .map((assertion) => Number(assertion.expected))));
    if (statuses.size <= 1) continue;
    const reason = `EXECUTION_ORACLE_AMBIGUOUS：相同 Actor/Input/Operation 对应多个期望状态 ${[...statuses].sort().join('/')}，禁止重复真实执行`;
    for (const testCase of group) {
      testCase.executionMode = 'DESIGNED_ONLY';
      testCase.protocol = undefined;
      testCase.steps = [];
      testCase.assertions = [{
        type: 'DESIGN_EXPECTATION',
        expected: testCase.expected?.description ?? reason,
        description: reason,
        severity: testCase.priority === 'P3' ? 'P2' : testCase.priority,
        factIds: testCase.source?.factIds,
        objectiveIds: testCase.source?.objectiveIds,
        objectiveId: testCase.source?.objectiveIds?.[0],
        sourceType: testCase.source?.sourceType,
        provenance: testCase.source?.provenance,
      }];
      if (testCase.design) {
        testCase.design.executability = 'DESIGNED_ONLY';
        testCase.design.reason = reason;
      }
      testCase.metadata = { ...testCase.metadata, reason };
    }
  }
  return input;
}

function coalesceCoveredOperationDesignCases(input: TestCase[]): TestCase[] {
  const executableByOperation = new Map<string, TestCase[]>();
  for (const testCase of input) {
    if (testCase.executionMode !== 'EXECUTABLE' || !testCase.source?.apiOperationKey) continue;
    const group = executableByOperation.get(testCase.source.apiOperationKey) ?? [];
    group.push(testCase);
    executableByOperation.set(testCase.source.apiOperationKey, group);
  }
  return input.filter((testCase) => {
    const isOperationContextOnly = testCase.executionMode !== 'EXECUTABLE'
      && testCase.testType === 'API'
      && testCase.source?.sourceType === 'CONTRACT'
      && testCase.design?.reason?.startsWith('BINDING_INCOMPLETE')
      && Boolean(testCase.source.apiOperationKey);
    if (!isOperationContextOnly) return true;
    const target = executableByOperation.get(testCase.source!.apiOperationKey!)?.[0];
    if (!target?.source) return true;
    target.source.factIds = mergeUnique(target.source.factIds, testCase.source?.factIds);
    target.source.objectiveIds = mergeUnique(target.source.objectiveIds, testCase.source?.objectiveIds);
    target.source.acceptanceCriteriaIds = mergeUnique(target.source.acceptanceCriteriaIds, testCase.source?.acceptanceCriteriaIds);
    if (target.design && testCase.design) {
      target.design.factIds = mergeUnique(target.design.factIds, testCase.design.factIds);
      target.design.objectiveIds = mergeUnique(target.design.objectiveIds, testCase.design.objectiveIds);
    }
    const assertion = target.assertions.find((candidate) => candidate.type === 'STATUS_CODE') ?? target.assertions[0];
    if (assertion) {
      assertion.factIds = mergeUnique(assertion.factIds, testCase.source?.factIds);
      assertion.objectiveIds = mergeUnique(
        assertion.objectiveIds ?? (assertion.objectiveId ? [assertion.objectiveId] : []),
        testCase.source?.objectiveIds,
      );
    }
    return false;
  });
}
