import type {
  AssertionDefinition,
  TestActor,
  TestAspect,
  TestBusinessScenario,
  TestCase,
  TestEvidenceRequirement,
  TestExecutionContract,
  TestStep,
  TestType,
} from '../agents/test-design/testcase-schema.js';
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
  // An unspecified type is not permission to invent a business value. Only
  // an explicit default/enum above can make an unknown schema executable.
  return undefined;
}

function unavailableBaselineParameters(api: ApiSpec, except?: ParameterSpec): ParameterSpec[] {
  return [...api.query, ...api.headers, ...api.body]
    .filter((parameter) => parameter !== except && parameter.required)
    .filter((parameter) => !/^(?:authorization|cookie|set-cookie|x-api-key|api-key)$/i.test(parameter.name))
    .filter((parameter) => {
      const value = validValue(parameter);
      return value === undefined || !parameterAccepts(parameter, value);
    });
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
    if (parameter.location === 'path' && vector.value === '') return [{
      ...vector,
      designReason: 'TRANSPORT_VECTOR_UNREPRESENTABLE：空 Path segment 会改变路由而不是向同一 Operation 传递空参数',
    }];
    if (parameter.location === 'header' && parameter.required && vector.value === '') return [{
      ...vector,
      designReason: 'TRANSPORT_VECTOR_UNREPRESENTABLE：当前 Binding/HTTP 层无法区分 required Header 空值与 Header 缺失',
    }];
    if (parameter.location !== 'body' && vector.kind === 'NULL') return [{
      ...vector,
      designReason: 'TRANSPORT_VECTOR_UNREPRESENTABLE：HTTP path/query/header 无法确定性表达 JSON null，禁止把省略或字符串 "null" 当作 null',
    }];
    if (parameter.location !== 'body' && parameter.type === 'string' && vector.kind === 'INVALID_TYPE') return [{
      ...vector,
      designReason: 'TRANSPORT_VECTOR_UNREPRESENTABLE：HTTP path/query/header 会把数值序列化为字符串，无法证明 string wrong-type 单故障',
    }];
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

/** Canonical Fact/Objective → Evidence Plan；不从自然语言补充新的产品规则。 */
function evidenceRequirementsFor(point: TestPoint): TestEvidenceRequirement[] {
  const requirements: TestEvidenceRequirement[] = [];
  const add = (
    channel: TestEvidenceRequirement['channel'],
    phase: TestEvidenceRequirement['phase'],
    description: string,
    expectation: TestEvidenceRequirement['expectation'] = 'PRESENT',
  ): void => {
    if (requirements.some((item) => item.channel === channel && item.phase === phase
      && (item.expectation ?? 'PRESENT') === expectation)) return;
    requirements.push({ channel, phase, required: true, expectation, description, factIds: [...point.factIds] });
  };
  if (point.executionTarget === 'UI') {
    add('UI_STATE', 'AFTER', '采集 Requirement 绑定页面元素及可见状态');
    add('UI_SCREENSHOT', 'AFTER', '保存页面执行后的截图指纹');
    return requirements;
  }
  if (point.apiBinding) {
    add('API_REQUEST', 'DURING', '保存实际 Method、URL、参数与 Actor（敏感信息脱敏）');
    add('API_RESPONSE', 'AFTER', '保存真实 Status、Headers 与 Response Body');
  }
  const canonical = point.canonicalFact;
  const constraintKinds = new Set(canonical.constraints.map((item) => item.kind));
  const mutatingOperation = Boolean((point.apiBinding?.method
    && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(point.apiBinding.method))
    // A contradictory/underspecified binding must not erase the business
    // mutation expressed by the Requirement (for example, a delete rule
    // accidentally bound to GET). Denied mutation paths still require proof
    // that state was not changed.
    || ['CREATE', 'UPDATE', 'DELETE', 'SUBMIT', 'TRANSITION', 'CHARGE', 'ROLLBACK', 'CLEANUP']
      .includes(canonical.action.kind));
  const deniedMutation = mutatingOperation
    && ['DATA_ISOLATION', 'PERMISSION'].includes(point.category)
    && point.canonicalFact.expected.kind === 'DENY';
  // Do not mechanically require a database observer for every 4xx/5xx write.
  // Non-mutation is a required Case oracle only when the Requirement gives us
  // that rule (permission deny, unchanged/rollback/atomicity). DevTest's
  // cross-case snapshots can still detect unexpected side effects independently.
  const nonMutationProofRequired = deniedMutation
    || canonical.expected.kind === 'UNCHANGED'
    || canonical.sideEffects.some((item) => item.action === 'UNCHANGED' || item.action === 'ROLLBACK')
    || canonical.constraints.some((item) => item.kind === 'ATOMIC');
  const requiresState = ['BUSINESS_RULE', 'STATE', 'SIDE_EFFECT', 'CLEANUP', 'HYBRID'].includes(point.category)
    || deniedMutation
    || canonical.expected.kind === 'UNCHANGED'
    || canonical.expected.kind === 'STATE_CHANGED'
    || canonical.constraints.some((item) => ['ATOMIC', 'UNIQUE', 'IDEMPOTENT', 'CONCURRENCY', 'CONSISTENCY',
      'FRONTEND_BACKEND_CONSISTENCY', 'RECOVERY', 'STATE_TRANSITION'].includes(item.kind));
  if (requiresState) {
    if (nonMutationProofRequired || canonical.expected.kind === 'STATE_CHANGED'
      || ['ATOMIC', 'UNIQUE', 'IDEMPOTENT', 'CONCURRENCY', 'CONSISTENCY', 'FRONTEND_BACKEND_CONSISTENCY', 'RECOVERY']
        .some((kind) => constraintKinds.has(kind as typeof canonical.constraints[number]['kind']))) {
      add('DATABASE_STATE', 'BEFORE', '通过独立 Observer 采集操作前业务状态');
    }
    add('DATABASE_STATE', 'AFTER', '通过独立 Observer 验证持久化或资源状态');
    add('STATE_CHANGE', 'AFTER', '比较执行前后业务状态', nonMutationProofRequired
      ? 'UNCHANGED' : canonical.expected.kind === 'STATE_CHANGED' ? 'CHANGED' : 'CONSISTENT');
  }
  const requiresDiff = nonMutationProofRequired;
  if (requiresDiff) add('DATA_DIFF', 'AFTER', '比较请求前后数据并证明失败路径无意外写入',
    'UNCHANGED');
  if (canonical.sideEffects.some((item) => item.observation === 'EVENT')) {
    add('LOG', 'AFTER', '采集事件、审计或处理日志');
  }
  if (constraintKinds.has('FRONTEND_BACKEND_CONSISTENCY')) {
    add('UI_STATE', 'AFTER', '采集 Requirement 绑定的前端显示值');
  }
  return requirements;
}

function testAspectsFor(point: TestPoint, testCase: TestCase): TestAspect[] {
  const aspects = new Set<TestAspect>();
  const constraints = new Set(point.canonicalFact.constraints.map((item) => item.kind));
  const scopes = point.canonicalFact.scopes;
  const vector = testCase.parameterContext?.boundaryVector;

  if (point.dimension === 'UI') aspects.add('UI_INTERACTION');
  if (point.dimension === 'FUNCTIONAL') aspects.add('CORE_FUNCTION');
  if (point.dimension === 'API' || point.apiBinding) aspects.add('API_CONTRACT');
  if (point.dimension === 'AUTH') aspects.add('AUTHENTICATION');
  if (point.dimension === 'PERMISSION') aspects.add('ROLE_PERMISSION');
  if (point.dimension === 'BOUNDARY') aspects.add('BOUNDARY_VALUE');
  if (point.dimension === 'ERROR' || testCase.parameterContext?.expectedOutcome === 'REJECT') aspects.add('NEGATIVE_PATH');

  if (vector === 'MISSING') aspects.add('PARAMETER_REQUIRED');
  if (vector === 'NULL' || vector === 'EMPTY') aspects.add('PARAMETER_NULL');
  if (vector === 'INVALID_TYPE' || vector === 'DECIMAL') aspects.add('PARAMETER_TYPE');
  if (vector === 'FORMAT_INVALID' || vector === 'ENUM_INVALID') aspects.add('PARAMETER_FORMAT');
  if (['MIN_MINUS', 'MIN', 'MIN_PLUS', 'MAX_MINUS', 'MAX', 'MAX_PLUS', 'EXTREME'].includes(vector ?? '')) {
    aspects.add('BOUNDARY_VALUE');
  }
  if (point.dimension === 'PARAMETER_VALIDATION' && !vector) {
    if (constraints.has('REQUIRED')) aspects.add('PARAMETER_REQUIRED');
    if (constraints.has('NULLABLE')) aspects.add('PARAMETER_NULL');
    if (constraints.has('TYPE')) aspects.add('PARAMETER_TYPE');
    if (constraints.has('FORMAT') || constraints.has('ENUM')) aspects.add('PARAMETER_FORMAT');
  }

  if (scopes.some((scope) => scope.dimension === 'USER')) aspects.add('USER_ISOLATION');
  if (scopes.some((scope) => scope.dimension === 'TENANT')) aspects.add('TENANT_ISOLATION');
  if (scopes.some((scope) => scope.dimension === 'PROJECT')) aspects.add('PROJECT_ISOLATION');
  if (constraints.has('STATE_TRANSITION') || point.dimension === 'STATE') aspects.add('STATE_TRANSITION');
  if (constraints.has('IDEMPOTENT')) {
    aspects.add('IDEMPOTENCY');
    aspects.add('DUPLICATE_SUBMISSION');
  }
  if (constraints.has('UNIQUE')) aspects.add('DUPLICATE_SUBMISSION');
  if (constraints.has('CONCURRENCY')) aspects.add('CONCURRENCY');
  if (constraints.has('FRONTEND_BACKEND_CONSISTENCY')) aspects.add('FRONTEND_BACKEND_CONSISTENCY');
  if (constraints.has('CONSISTENCY') || constraints.has('FRONTEND_BACKEND_CONSISTENCY')
    || constraints.has('ATOMIC') || point.dimension === 'STATE') aspects.add('DATA_CONSISTENCY');
  if (point.canonicalFact.sideEffects.length || point.dimension === 'SIDE_EFFECT') aspects.add('SIDE_EFFECT');
  if (point.dimension === 'CLEANUP') aspects.add('CROSS_CASE_SIDE_EFFECT');
  if (point.preconditions.length || ['STATE', 'SIDE_EFFECT', 'CLEANUP'].includes(point.dimension)
    || ['UNCHANGED', 'STATE_CHANGED'].includes(point.canonicalFact.expected.kind)) {
    aspects.add('PRE_POST_CONDITION');
  }
  if (constraints.has('ATOMIC') || constraints.has('RECOVERY')
    || point.canonicalFact.action.kind === 'ROLLBACK'
    || point.canonicalFact.sideEffects.some((item) => item.action === 'ROLLBACK')) {
    aspects.add('ROLLBACK_RECOVERY');
  }
  if (!aspects.size) aspects.add('CORE_FUNCTION');
  return [...aspects];
}

function assertionChannel(assertion: AssertionDefinition): NonNullable<AssertionDefinition['channel']> {
  if (assertion.target === 'billing') return 'SIDE_EFFECT';
  if (assertion.target === 'metrics' || assertion.target === 'env') return 'SYSTEM';
  if (assertion.type) return assertion.type === 'DESIGN_EXPECTATION' ? 'SYSTEM' : 'RESPONSE';
  return assertion.target === 'response' || assertion.target === 'submit' ? 'RESPONSE' : 'STATE';
}

function evidenceChannelForAssertion(assertion: AssertionDefinition): TestEvidenceRequirement['channel'][] {
  const channel = assertionChannel(assertion);
  if (channel === 'RESPONSE' || channel === 'API') return ['API_RESPONSE'];
  if (channel === 'UI') return ['UI_STATE', 'UI_SCREENSHOT'];
  if (channel === 'STATE' || channel === 'DATA') return ['DATABASE_STATE', 'STATE_CHANGE', 'DATA_DIFF'];
  if (channel === 'SIDE_EFFECT' || channel === 'AUDIT') return ['LOG', 'DATABASE_STATE', 'STATE_CHANGE', 'DATA_DIFF'];
  return [];
}

function structuredExpected(point: TestPoint, testCase: TestCase): NonNullable<TestCase['expected']> {
  const fieldsValue = point.canonicalFact.expected.value;
  const fields = fieldsValue && typeof fieldsValue === 'object' && !Array.isArray(fieldsValue)
    && 'fields' in fieldsValue && fieldsValue.fields && typeof fieldsValue.fields === 'object'
    ? fieldsValue.fields as Record<string, unknown> : undefined;
  const stateCandidates = testCase.evidenceRequirements ?? [];
  const stateRequirement = stateCandidates.find((item) => item.channel === 'STATE_CHANGE' || item.channel === 'DATA_DIFF')
    ?? stateCandidates.find((item) => item.channel === 'DATABASE_STATE');
  return {
    ...testCase.expected,
    description: point.outcomeStatus === 'KNOWN'
      ? point.expectedOutcome
      : 'UNKNOWN：需求未声明可判定的 Expected Result，需确认后才能执行',
    response: point.canonicalFact.expected.status !== undefined || fields
      ? {
        status: point.canonicalFact.expected.status,
        fields,
        description: point.canonicalFact.expected.expression,
      }
      : undefined,
    state: stateRequirement ? {
      expectation: stateRequirement.expectation ?? 'PRESENT',
      description: stateRequirement.description,
    } : undefined,
    sideEffects: point.canonicalFact.sideEffects.map((item) => ({
      kind: item.kind,
      action: item.action,
      description: item.expression,
      expectation: item.action === 'UNKNOWN' ? 'UNKNOWN'
        : item.action === 'UNCHANGED' || item.action === 'ROLLBACK' ? 'UNCHANGED' : 'REQUIRED',
    })),
  };
}

function businessScenarioKind(point: TestPoint, aspects: readonly TestAspect[]): TestBusinessScenario['kind'] {
  if (aspects.includes('CONCURRENCY')) return 'CONCURRENCY';
  if (aspects.includes('IDEMPOTENCY') || aspects.includes('DUPLICATE_SUBMISSION')) return 'IDEMPOTENCY';
  if (aspects.includes('ROLLBACK_RECOVERY')) return 'RECOVERY';
  if (aspects.includes('STATE_TRANSITION')) return 'STATE_TRANSITION';
  if (aspects.includes('TENANT_ISOLATION') || aspects.includes('PROJECT_ISOLATION')) return 'DATA_ISOLATION';
  if (aspects.includes('USER_ISOLATION')) return 'RESOURCE_OWNERSHIP';
  if (aspects.includes('ROLE_PERMISSION')) return 'PERMISSION';
  if (aspects.some((item) => item.startsWith('PARAMETER_') || item === 'BOUNDARY_VALUE')) return 'PARAMETER_RULE';
  if (aspects.includes('FRONTEND_BACKEND_CONSISTENCY') || aspects.includes('DATA_CONSISTENCY')) return 'CONSISTENCY';
  if (aspects.includes('SIDE_EFFECT')) return 'SIDE_EFFECT';
  return point.canonicalFact.action.kind === 'UNKNOWN' ? 'UNKNOWN' : 'CORE_FLOW';
}

function riskCategory(point: TestPoint, aspects: readonly TestAspect[]): TestBusinessScenario['risks'][number]['category'] {
  if (aspects.some((item) => ['ROLE_PERMISSION', 'USER_ISOLATION', 'TENANT_ISOLATION', 'PROJECT_ISOLATION'].includes(item))) return 'SECURITY';
  if (point.canonicalFact.sideEffects.some((item) => item.kind === 'BILLING')) return 'FINANCIAL';
  if (aspects.includes('CONCURRENCY')) return 'CONCURRENCY';
  if (aspects.includes('ROLLBACK_RECOVERY')) return 'RECOVERY';
  if (aspects.some((item) => ['DATA_CONSISTENCY', 'STATE_TRANSITION', 'IDEMPOTENCY', 'DUPLICATE_SUBMISSION'].includes(item))) return 'DATA_INTEGRITY';
  if (point.canonicalFact.sideEffects.some((item) => item.kind === 'EXTERNAL')) return 'DEPENDENCY';
  return point.risk ? 'BUSINESS_CONTINUITY' : 'UNKNOWN';
}

function configuredActorForCanonical(
  requirement: AcceptanceRequirement,
  actor: TestPoint['canonicalFact']['actor'] | undefined,
): ActorSpec | undefined {
  if (!actor) return undefined;
  if (actor.id) return requirement.actors.find((candidate) => candidate.id === actor.id);
  if (actor.role) {
    const matches = requirement.actors.filter((candidate) => candidate.role.toLowerCase() === actor.role!.toLowerCase());
    if (matches.length === 1) return matches[0];
  }
  return undefined;
}

function buildBusinessScenario(
  requirement: AcceptanceRequirement,
  point: TestPoint,
  testCase: TestCase,
  provenance: NonNullable<TestCase['source']>['provenance'] & string,
  factIds: string[],
  acceptanceCriteriaIds: string[],
): TestBusinessScenario {
  const canonical = point.canonicalFact;
  const aspects = testCase.testAspects ?? [];
  const subject = configuredActorForCanonical(requirement, canonical.actor);
  const target = configuredActorForCanonical(requirement, canonical.targetActor);
  const scope = canonical.scopes[0];
  const owner = scope?.relation === 'OTHER' || scope?.relation === 'CROSS' ? target : subject;
  const actorLabel = canonical.actor?.id ?? canonical.actor?.role
    ?? (canonical.actor?.kind !== 'UNKNOWN' ? canonical.actor?.kind : undefined);
  const actionLabel = canonical.action.kind !== 'UNKNOWN' ? canonical.action.kind : undefined;
  const resourceLabel = canonical.resource.kind !== 'UNKNOWN' ? canonical.resource.kind : 'UNKNOWN';
  const idRef = Object.values(canonical.resource.identifiers)[0]
    ?? (testCase.data?.targetId === undefined ? undefined : String(testCase.data.targetId));
  const stateRule = requirement.stateRules.find((rule) => {
    const linkedFacts = requirement.factLedger.filter((fact) => factIds.includes(fact.id));
    return linkedFacts.some((fact) => fact.entityRefs.items.some((ref) => ref.type === 'STATE_RULE' && ref.id === rule.id));
  });
  const stateExpression = canonical.constraints.find((item) => item.kind === 'STATE_TRANSITION')?.expression
    ?? canonical.conditions.find((item) => item.kind === 'STATE')?.expression;
  const permissionDecision = canonical.expected.kind === 'ALLOW' ? 'ALLOW'
    : canonical.expected.kind === 'DENY' ? 'DENY'
      : aspects.some((item) => ['ROLE_PERMISSION', 'USER_ISOLATION', 'TENANT_ISOLATION', 'PROJECT_ISOLATION'].includes(item))
        ? 'UNKNOWN' : 'NOT_APPLICABLE';
  const permissionScope = canonical.scopes.map((item) => `${item.dimension}:${item.relation}`).join(', ') || undefined;
  const relation: TestBusinessScenario['ownership']['relation'] = scope?.dimension === 'TENANT' && scope.relation === 'CROSS'
    ? 'CROSS_TENANT' : scope?.dimension === 'TENANT' && scope.relation === 'SAME'
      ? 'SAME_TENANT' : scope?.relation === 'OTHER' ? 'OTHER_USER'
        : scope?.relation === 'SELF' || scope?.relation === 'OWNER_ONLY' ? 'SELF'
          : aspects.some((item) => ['USER_ISOLATION', 'TENANT_ISOLATION', 'PROJECT_ISOLATION'].includes(item))
            ? 'UNKNOWN' : 'NOT_APPLICABLE';
  const actorContexts: TestBusinessScenario['actors'] = [];
  if (subject || canonical.actor) actorContexts.push({
    id: subject?.id ?? canonical.actor?.id,
    role: subject?.role ?? canonical.actor?.role,
    tenantId: subject?.tenantId,
    relation: 'SUBJECT',
    provenance: subject ? 'CONFIGURED' : provenance,
  });
  if (target && target.id !== subject?.id) actorContexts.push({
    id: target.id, role: target.role, tenantId: target.tenantId,
    relation: scope?.dimension === 'TENANT' && scope.relation === 'CROSS' ? 'OTHER_TENANT' : 'TARGET',
    provenance: 'CONFIGURED',
  });
  if (owner && !actorContexts.some((item) => item.id === owner.id && item.relation === 'OWNER')) actorContexts.push({
    id: owner.id, role: owner.role, tenantId: owner.tenantId, relation: 'OWNER', provenance: 'CONFIGURED',
  });
  const mode: TestBusinessScenario['flow']['mode'] = testCase.steps.some((step) => step.concurrencyGroup)
    ? 'PARALLEL' : aspects.includes('ROLLBACK_RECOVERY') && testCase.steps.length > 1 ? 'RECOVERY'
      : relation === 'CROSS_TENANT' ? 'CROSS_TENANT' : relation === 'OTHER_USER' ? 'CROSS_ACTOR'
        : testCase.steps.length > 1 ? 'SEQUENCE' : 'SINGLE_OPERATION';
  const flowSteps = testCase.steps.map((step, index) => ({
    id: step.id ?? `STEP-${String(index + 1).padStart(3, '0')}`,
    action: step.action ?? step.type ?? 'PLANNED',
    actorRef: step.actor?.id ?? testCase.actor?.id,
    resourceRef: idRef,
    operationRef: step.method && step.url ? `${step.method} ${step.url}` : step.action,
    fromState: index === 0 ? stateRule?.from : undefined,
    toState: index === testCase.steps.length - 1 ? stateRule?.to : undefined,
    dependsOn: step.dependsOn ?? [],
  }));
  return {
    title: point.objective,
    goal: `${actorLabel ?? '需求指定的业务参与者'} ${actionLabel ?? '执行已声明动作'} ${resourceLabel}，业务结果必须满足已声明的验收条件`,
    actor: actorLabel,
    action: actionLabel,
    resource: resourceLabel,
    kind: businessScenarioKind(point, aspects),
    actors: actorContexts,
    resourceContext: { type: resourceLabel, idRef, provenance: resourceLabel === 'UNKNOWN' ? 'UNKNOWN' : provenance },
    ownership: {
      relation, ownerActorId: owner?.id, tenantId: owner?.tenantId,
      provenance: relation === 'UNKNOWN' ? 'UNKNOWN' : relation === 'NOT_APPLICABLE' ? provenance : provenance,
    },
    state: {
      status: stateRule || stateExpression ? 'KNOWN' : aspects.includes('STATE_TRANSITION') ? 'UNKNOWN' : 'NOT_APPLICABLE',
      before: stateRule?.from, after: stateRule?.to, expression: stateExpression ?? stateRule?.action,
      provenance: stateRule || stateExpression ? provenance : aspects.includes('STATE_TRANSITION') ? 'UNKNOWN' : provenance,
    },
    permission: {
      decision: permissionDecision, role: subject?.role ?? canonical.actor?.role,
      action: actionLabel, scope: permissionScope,
      provenance: permissionDecision === 'UNKNOWN' ? 'UNKNOWN' : provenance,
    },
    flow: {
      id: point.scenarioId ?? `FLOW-${point.id}`,
      name: point.objective,
      mode,
      steps: flowSteps.length ? flowSteps : [{ id: 'STEP-001', action: 'PLANNED', dependsOn: [] }],
    },
    dependencies: [],
    risks: point.risk || point.priority === 'P0' || aspects.some((item) => [
      'ROLE_PERMISSION', 'USER_ISOLATION', 'TENANT_ISOLATION', 'PROJECT_ISOLATION', 'STATE_TRANSITION',
      'DATA_CONSISTENCY', 'IDEMPOTENCY', 'CONCURRENCY', 'ROLLBACK_RECOVERY', 'SIDE_EFFECT',
    ].includes(item)) ? [{
      id: `RISK-${point.id}`,
      level: point.priority,
      category: riskCategory(point, aspects),
      description: point.risk ?? `该场景承担 ${aspects.join(', ')} 业务证明义务`,
      source: point.sourceType === 'CONTRACT' ? 'CONTRACT' : point.risk ? 'REQUIREMENT' : 'TEST_STRATEGY',
    }] : [],
    expectedBusinessOutcome: point.outcomeStatus === 'KNOWN'
      ? point.expectedOutcome : 'UNKNOWN：需求需补充成功/失败判定条件',
    provenance,
    factIds,
    acceptanceCriteriaIds,
  };
}

function buildExecutionContract(testCase: TestCase, point: TestPoint): TestExecutionContract {
  const httpSteps = testCase.steps.filter((step) => step.type === 'HTTP_REQUEST');
  const containsReference = (value: unknown, ref: string): boolean => {
    if (value === ref) return true;
    if (Array.isArray(value)) return value.some((item) => containsReference(item, ref));
    return Boolean(value && typeof value === 'object'
      && Object.values(value as Record<string, unknown>).some((item) => containsReference(item, ref)));
  };
  const kind: TestExecutionContract['executor']['kind'] = testCase.steps.length > 1
    ? 'COMPOSITE' : point.executionTarget === 'UI' ? 'BROWSER'
      : point.executionTarget === 'DATA' ? 'DATA' : httpSteps.length === 1 ? 'HTTP'
        : point.executionTarget === 'FUNCTIONAL' ? 'FUNCTIONAL' : 'NONE';
  const status: TestExecutionContract['executor']['status'] = kind === 'HTTP'
    ? 'AVAILABLE' : kind === 'BROWSER' ? 'RUNTIME_REQUIRED' : 'UNAVAILABLE';
  const observers = (testCase.evidenceRequirements ?? [])
    .filter((evidence) => !['API_REQUEST', 'API_RESPONSE'].includes(evidence.channel))
    .map((evidence) => ({
      channel: evidence.channel,
      ref: `runtime.observer.${evidence.channel}`,
      phase: evidence.phase,
      required: evidence.required,
      status: 'RUNTIME_REQUIRED' as const,
    }));
  const preflight: TestExecutionContract['preflight'] = [{
    kind: 'ENVIRONMENT', ref: kind === 'BROWSER' ? 'runtime.browser' : 'runtime.baseUrl', required: true,
  }];
  if (testCase.source?.apiSpecId) preflight.push({ kind: 'CONTRACT', ref: testCase.source.apiSpecId, required: true });
  if (testCase.actor) preflight.push({ kind: 'IDENTITY', ref: testCase.actor.tokenRef ?? testCase.actor.id ?? 'runtime.actor', required: true });
  const resourceContext = testCase.businessScenario?.resourceContext;
  // An EXPLICIT/CONFIGURED resource id is already a deterministic part of the
  // Case request contract. Requiring a second, unbound RESOURCE resolver would
  // prevent the HTTP Processor from ever observing it. Only unresolved
  // resource identity needs a runtime preflight provider; operation safety and
  // mutation cleanup remain enforced by their independent gates.
  const resourceBoundToRequest = Boolean(resourceContext?.idRef && httpSteps.some((step) =>
    containsReference({ pathParams: step.pathParams, query: step.query, body: step.body }, resourceContext.idRef!)));
  if (resourceContext?.idRef && !resourceBoundToRequest
    && testCase.businessScenario?.ownership.relation !== 'NOT_APPLICABLE') {
    preflight.push({ kind: 'RESOURCE', ref: resourceContext.idRef, required: true });
  }
  if (testCase.businessScenario?.state.status === 'KNOWN') preflight.push({ kind: 'STATE', ref: 'runtime.statePreflight', required: true });
  return {
    executor: {
      kind,
      ref: kind === 'HTTP' ? 'acceptance.apiProcessor' : kind === 'BROWSER' ? 'devtest.browserProcessor'
        : kind === 'COMPOSITE' ? 'acceptance.scenarioRunner' : `runtime.executor.${kind}`,
      status,
      supports: httpSteps.map((step) => `${step.method ?? 'UNKNOWN'} ${step.url ?? 'UNKNOWN'}`),
    },
    observers,
    preflight,
    lifecycleHooks: [
      ...(testCase.prepare ?? []).map((hook) => ({ phase: 'PREPARE' as const, hookId: hook.id, required: hook.required, evidenceRequired: hook.required })),
      ...(testCase.cleanup ?? []).map((hook) => ({ phase: 'CLEANUP' as const, hookId: hook.id, required: hook.required, evidenceRequired: hook.required })),
    ],
  };
}

/**
 * 将 canonical Fact/Objectives 编译为 TEST_CASE_V2 模板。这里只做结构投影，
 * 不重读自然语言、不补产品规则；不完整能力通过 Readiness/Oracle fail-close。
 */
function completeGeneratedCase(
  requirement: AcceptanceRequirement,
  point: TestPoint,
  testCase: TestCase,
  api?: ApiSpec,
  relatedPoints: TestPoint[] = [point],
): TestCase {
  const factIds = [...new Set(testCase.source?.factIds ?? point.factIds)];
  const acceptanceCriteriaIds = [...new Set(testCase.source?.acceptanceCriteriaIds ?? point.acceptanceCriteriaIds)];
  const provenance = testCase.source?.provenance ?? point.provenance;
  const resourceLabel = point.canonicalFact.resource.kind !== 'UNKNOWN' ? point.canonicalFact.resource.kind : undefined;

  testCase.schemaVersion = 'TEST_CASE_V2';
  testCase.requirementStatus = point.outcomeStatus === 'UNKNOWN'
    ? (provenance === 'UNKNOWN' ? 'UNKNOWN' : 'NEED_CONFIRMATION')
    : point.sourceType === 'HEURISTIC' ? 'NEED_CONFIRMATION' : 'CONFIRMED';

  if (!testCase.steps.length) {
    const plannedActions = testCase.design?.actions?.length ? testCase.design.actions : [point.objective];
    testCase.steps = plannedActions.map((description, index) => ({
      id: `STEP-${String(index + 1).padStart(3, '0')}`,
      channel: point.executionTarget === 'UI' ? 'UI'
        : point.executionTarget === 'DATA' ? 'DATA'
          : point.executionTarget === 'API' || point.executionTarget === 'HYBRID' ? 'API' : 'FUNCTIONAL',
      action: 'PLAN',
      description,
      execution: 'PLANNED',
      dependsOn: index ? [`STEP-${String(index).padStart(3, '0')}`] : [],
      acceptanceCriteriaIds,
      factIds,
    }));
  } else {
    testCase.steps = testCase.steps.map((step, index) => ({
      ...step,
      id: step.id ?? `STEP-${String(index + 1).padStart(3, '0')}`,
      channel: step.channel ?? (step.type === 'HTTP_REQUEST' ? 'API' : 'FUNCTIONAL'),
      description: step.description ?? (step.type === 'HTTP_REQUEST'
        ? `${step.method ?? 'UNKNOWN'} ${step.url ?? 'UNKNOWN'}` : step.action ?? point.objective),
      execution: step.execution ?? (testCase.executionMode === 'EXECUTABLE' ? 'EXECUTABLE' : 'PLANNED'),
      dependsOn: step.dependsOn ?? (index ? [`STEP-${String(index).padStart(3, '0')}`] : []),
      acceptanceCriteriaIds: step.acceptanceCriteriaIds ?? acceptanceCriteriaIds,
      factIds: step.factIds ?? factIds,
    }));
  }

  const request = testCase.steps.find((step) => step.type === 'HTTP_REQUEST');
  const mutates = Boolean((request?.method ?? api?.method)
    && ['POST', 'PUT', 'PATCH', 'DELETE'].includes((request?.method ?? api?.method)!));
  testCase.testAspects = [...new Set(relatedPoints.flatMap((related) => testAspectsFor(related, testCase)))];
  testCase.businessScenario = buildBusinessScenario(
    requirement,
    point,
    testCase,
    provenance,
    factIds,
    acceptanceCriteriaIds,
  );
  testCase.preconditions ??= [];
  const explicitConditions = point.canonicalFact.conditions
    .filter((condition) => condition.kind !== 'AFTER')
    // “若实际返回 200 必须判 FAIL” describes the Oracle, not setup state.
    .filter((condition) => !/(?:实际|actual).*(?:返回|response|status)|(?:判定|assert).*(?:pass|fail|通过|失败)/i.test(condition.expression));
  testCase.preconditions = [...new Set([
    ...testCase.preconditions,
    ...explicitConditions.map((condition) => condition.expression),
  ])];
  testCase.preconditionPlan = testCase.preconditions.map((description, index) => {
    const explicitCondition = explicitConditions.find((condition) => condition.expression === description);
    return {
    id: `PRE-${String(index + 1).padStart(3, '0')}`,
    kind: explicitCondition ? 'STATE' : testCase.actor ? 'IDENTITY' : request ? 'ENVIRONMENT'
      : point.executionTarget === 'DATA' ? 'DATA' : 'OTHER',
    description,
    required: true,
    // Explicit IF/WHEN/BEFORE business state needs a real state/data resolver.
    // Leaving checkRef absent deliberately makes the quality/runner gate block.
    checkRef: explicitCondition ? undefined
      : testCase.actor ? `runtime.actor.${testCase.actor.id ?? testCase.actor.role ?? 'configured'}`
        : request ? 'runtime.preflight.api' : `runtime.preflight.${point.executionTarget.toLowerCase()}`,
  };
  });
  const requestData = request ? {
    pathParams: request.pathParams,
    query: request.query,
    body: request.body,
  } : undefined;
  testCase.data ??= {};
  const hasRequestData = requestData && Object.values(requestData).some((value) => value !== undefined);
  const plannedData = hasRequestData ? requestData
    : testCase.parameterContext ? {
      parameter: testCase.parameterContext.parameter,
      value: testCase.parameterContext.testData,
      constraint: testCase.parameterContext.constraint,
    } : Object.keys(testCase.data ?? {}).length ? testCase.data : undefined;
  testCase.testData = plannedData === undefined ? [] : [{
    id: 'DATA-001',
    source: testCase.parameterContext ? 'GENERATED' : testCase.actor ? 'CONFIGURATION' : 'GENERATED',
    value: plannedData,
    resourceType: resourceLabel,
    resourceOwnerId: testCase.businessScenario.ownership.ownerActorId,
    tenantId: testCase.businessScenario.ownership.tenantId,
    mutable: mutates,
    sensitive: false,
    cleanupHookId: mutates ? 'CLEANUP-001' : undefined,
  }];

  testCase.assertions = testCase.assertions.map((assertion, index) => ({
    ...assertion,
    id: assertion.id ?? `AS-${String(index + 1).padStart(3, '0')}`,
    channel: assertion.channel ?? assertionChannel(assertion),
    acceptanceCriteriaIds: assertion.acceptanceCriteriaIds ?? acceptanceCriteriaIds,
  }));
  testCase.evidenceRequirements ??= [];
  testCase.evidenceRequirements = testCase.evidenceRequirements.map((evidence, index) => ({
    ...evidence,
    id: evidence.id ?? `EV-${String(index + 1).padStart(3, '0')}`,
    sourceStepId: evidence.sourceStepId
      ?? testCase.steps.find((step) => step.execution === 'EXECUTABLE')?.id
      ?? testCase.steps[0]?.id,
    assertionIds: evidence.assertionIds ?? testCase.assertions
      .filter((assertion) => evidenceChannelForAssertion(assertion).includes(evidence.channel)
        && (!assertion.factIds?.length || assertion.factIds.some((id) => evidence.factIds.includes(id))))
      .map((assertion) => assertion.id!)
      .filter(Boolean),
  }));
  for (const assertion of testCase.assertions) {
    assertion.evidenceRequirementIds = assertion.evidenceRequirementIds ?? testCase.evidenceRequirements
      .filter((evidence) => evidence.assertionIds?.includes(assertion.id!))
      .map((evidence) => evidence.id!)
      .filter(Boolean);
  }

  testCase.expected = structuredExpected(point, testCase);
  testCase.prepare = [];
  testCase.cleanup = mutates ? [{
    id: 'CLEANUP-001',
    phase: 'CLEANUP',
    handler: 'runtime.caseCleanup',
    input: { caseRef: 'SELF' },
    required: true,
    produces: ['cleanupStatus', 'afterCleanupSnapshot'],
  }] : [];

  const dependencies: NonNullable<TestCase['dependencies']> = [];
  const addDependency = (dependency: NonNullable<TestCase['dependencies']>[number]): void => {
    if (!dependencies.some((item) => item.kind === dependency.kind && item.ref === dependency.ref)) dependencies.push(dependency);
  };
  if (request || point.executionTarget === 'API' || point.executionTarget === 'HYBRID') addDependency({
    id: 'DEP-ENV-API', kind: 'ENVIRONMENT', ref: 'runtime.baseUrl',
    description: '目标 API 环境通过 Preflight', required: true, resolution: 'RUNTIME_REQUIRED',
  });
  if (point.executionTarget === 'UI') addDependency({
    id: 'DEP-ENV-UI', kind: 'ENVIRONMENT', ref: 'runtime.browser',
    description: 'Browser Executor 与目标页面通过 Preflight', required: true, resolution: 'RUNTIME_REQUIRED',
  });
  if (api) addDependency({
    id: 'DEP-CONTRACT-001', kind: 'CONTRACT', ref: api.id,
    description: `${api.method} ${api.path} Contract`, required: true, resolution: 'STATIC',
  });
  if (testCase.actor) addDependency({
    id: 'DEP-IDENTITY-001', kind: 'IDENTITY',
    ref: testCase.actor.tokenRef ?? testCase.actor.id ?? testCase.actor.role ?? 'runtime.actor',
    description: 'Actor 身份与凭据引用必须在运行时解析', required: true, resolution: 'RUNTIME_REQUIRED',
  });
  for (const evidence of testCase.evidenceRequirements.filter((item) =>
    !['API_REQUEST', 'API_RESPONSE'].includes(item.channel))) addDependency({
      id: `DEP-OBSERVER-${evidence.id}`,
      kind: 'OBSERVER', ref: `runtime.observer.${evidence.channel}`,
      description: `采集 ${evidence.channel} 证据`, required: evidence.required, resolution: 'RUNTIME_REQUIRED',
    });
  if (mutates) addDependency({
    id: 'DEP-LIFECYCLE-CLEANUP', kind: 'LIFECYCLE', ref: 'runtime.caseCleanup',
    description: '写操作必须配置隔离 Cleanup 并验证清理结果', required: true, resolution: 'RUNTIME_REQUIRED',
  });
  testCase.dependencies = dependencies;
  testCase.businessScenario.dependencies = point.canonicalFact.sideEffects
    .filter((effect) => effect.kind === 'EXTERNAL')
    .map((effect) => effect.expression);
  testCase.executionContract = buildExecutionContract(testCase, point);

  const runtimeAssertions = testCase.assertions.filter((assertion) => assertion.type !== 'DESIGN_EXPECTATION');
  const requiredEvidence = testCase.evidenceRequirements.filter((item) => item.required);
  const missingCapabilities = [
    ...(testCase.executionContract.executor.status === 'AVAILABLE'
      ? [] : [testCase.executionContract.executor.ref]),
    // RUNTIME_REQUIRED is a declared execution-time dependency, not a
    // generation failure. The unified quality gate and Processor both verify
    // that a provider is actually bound before any request can be dispatched.
    // Only a statically unavailable capability makes the generated candidate
    // non-executable at this stage.
    ...testCase.executionContract.observers
      .filter((observer) => observer.required && observer.status === 'UNAVAILABLE')
      .map((observer) => observer.ref),
    ...testCase.preconditionPlan
      .filter((precondition) => precondition.required && !precondition.checkRef)
      .map((precondition) => `preflight.${precondition.id}`),
    ...dependencies
      .filter((dependency) => dependency.required && dependency.resolution === 'UNRESOLVED')
      .map((dependency) => dependency.ref),
  ];
  const candidateExecutable = testCase.executionMode === 'EXECUTABLE';
  const deterministicOracleReady = candidateExecutable
    && runtimeAssertions.length > 0
    && runtimeAssertions.every((assertion) => assertion.evidenceRequirementIds?.length)
    && requiredEvidence.length > 0
    && missingCapabilities.length === 0;
  const readinessReason = testCase.design?.reason ?? testCase.metadata?.reason;
  const needsConfirmation = testCase.requirementStatus !== 'CONFIRMED';
  const blockedReason = missingCapabilities.length
    ? `缺少 Executor/Observer/Preflight 能力：${missingCapabilities.join(', ')}`
    : String(readinessReason ?? '确定性 Assertion/Evidence/Executor 契约不完整');
  testCase.oracle = {
    mode: 'ALL',
    deterministic: true,
    status: needsConfirmation ? 'NEED_CONFIRMATION' : deterministicOracleReady ? 'READY' : 'BLOCKED',
    assertionIds: runtimeAssertions.map((assertion) => assertion.id!),
    evidenceRequirementIds: requiredEvidence.map((item) => item.id!),
    reason: needsConfirmation
      ? '需求未提供完整、明确的可判定结果'
      : deterministicOracleReady ? undefined : blockedReason,
  };
  testCase.readiness = {
    status: needsConfirmation ? 'NEED_CONFIRMATION' : deterministicOracleReady ? 'READY' : 'BLOCKED',
    reasons: needsConfirmation ? ['REQUIREMENT_EXPECTED_OUTCOME_UNKNOWN']
      : deterministicOracleReady ? [] : [blockedReason],
    missingCapabilities: deterministicOracleReady ? [] : [...new Set(missingCapabilities)],
  };
  if (!deterministicOracleReady) {
    testCase.executionMode = 'DESIGNED_ONLY';
    testCase.protocol = undefined;
    testCase.steps = testCase.steps.map((step) => ({ ...step, execution: 'PLANNED' as const }));
    if (testCase.design) {
      testCase.design.executability = 'DESIGNED_ONLY';
      testCase.design.reason ??= needsConfirmation ? 'REQUIREMENT_EXPECTED_OUTCOME_UNKNOWN' : blockedReason;
    }
  }
  testCase.tags = [...new Set([
    ...testCase.tags,
    ...testCase.testAspects.map((aspect) => aspect.toLowerCase().replaceAll('_', '-')),
    testCase.requirementStatus.toLowerCase(),
  ])];
  return testCase;
}

type RiskCombinationKind = 'IDEMPOTENCY' | 'CONCURRENCY' | 'STATE_TRANSITION' | 'CROSS_SCOPE' | 'RECOVERY';

function riskCombinationKind(point: TestPoint): RiskCombinationKind | undefined {
  if (point.strategies.includes('CONCURRENT_REQUEST')) return 'CONCURRENCY';
  if (point.strategies.includes('REPEAT')) return 'IDEMPOTENCY';
  if (point.strategies.includes('RECOVERY_CHECK') || point.strategies.includes('PARTIAL_FAILURE')) return 'RECOVERY';
  if (point.canonicalFact.scopes.some((scope) => scope.relation === 'OTHER' || scope.relation === 'CROSS')) return 'CROSS_SCOPE';
  if (point.strategies.includes('VALID_INVALID_TRANSITION')
    || point.canonicalFact.constraints.some((constraint) => constraint.kind === 'STATE_TRANSITION')) return 'STATE_TRANSITION';
  return undefined;
}

function clonePlannedHttpStep(
  step: TestStep,
  id: string,
  action: string,
  dependsOn: string[],
  concurrencyGroup?: string,
): TestStep {
  return {
    ...step,
    id,
    action,
    description: `${action}：${step.method ?? 'UNKNOWN'} ${step.url ?? 'UNKNOWN'}`,
    execution: 'PLANNED',
    dependsOn,
    concurrencyGroup,
    headers: step.headers ? { ...step.headers } : undefined,
    pathParams: step.pathParams ? { ...step.pathParams } : undefined,
    query: step.query ? { ...step.query } : undefined,
    body: step.body && typeof step.body === 'object' && !Array.isArray(step.body)
      ? { ...step.body } : step.body,
  };
}

function combinationSteps(kind: RiskCombinationKind, request?: TestStep): TestStep[] {
  const planned = (
    id: string,
    channel: NonNullable<TestStep['channel']>,
    action: string,
    description: string,
    dependsOn: string[] = [],
  ): TestStep => ({ id, channel, action, description, execution: 'PLANNED', dependsOn });
  if (kind === 'IDEMPOTENCY') return request ? [
    clonePlannedHttpStep(request, 'STEP-001', 'FIRST_SUBMIT', []),
    clonePlannedHttpStep(request, 'STEP-002', 'REPEAT_SAME_SUBMIT', ['STEP-001']),
    planned('STEP-003', 'DATA', 'OBSERVE_FINAL_STATE', '比较单次执行与重复执行后的实体、状态和副作用', ['STEP-002']),
  ] : [
    planned('STEP-001', 'FUNCTIONAL', 'FIRST_SUBMIT', '按需求声明的幂等身份首次提交'),
    planned('STEP-002', 'FUNCTIONAL', 'REPEAT_SAME_SUBMIT', '使用完全相同的幂等身份重复提交', ['STEP-001']),
    planned('STEP-003', 'DATA', 'OBSERVE_FINAL_STATE', '验证最终实体、状态和副作用没有重复', ['STEP-002']),
  ];
  if (kind === 'CONCURRENCY') return request ? [
    planned('STEP-001', 'DATA', 'OBSERVE_STATE_BEFORE', '采集并发操作前业务状态'),
    clonePlannedHttpStep(request, 'STEP-002', 'CONCURRENT_OPERATION_A', ['STEP-001'], 'CG-001'),
    clonePlannedHttpStep(request, 'STEP-003', 'CONCURRENT_OPERATION_B', ['STEP-001'], 'CG-001'),
    planned('STEP-004', 'DATA', 'OBSERVE_FINAL_STATE', '并发屏障完成后采集最终业务状态', ['STEP-002', 'STEP-003']),
  ] : [
    planned('STEP-001', 'DATA', 'OBSERVE_STATE_BEFORE', '采集并发操作前业务状态'),
    { ...planned('STEP-002', 'FUNCTIONAL', 'CONCURRENT_OPERATION_A', '并发执行需求声明的操作 A', ['STEP-001']), concurrencyGroup: 'CG-001' },
    { ...planned('STEP-003', 'FUNCTIONAL', 'CONCURRENT_OPERATION_B', '并发执行需求声明的操作 B', ['STEP-001']), concurrencyGroup: 'CG-001' },
    planned('STEP-004', 'DATA', 'OBSERVE_FINAL_STATE', '并发屏障完成后采集最终业务状态', ['STEP-002', 'STEP-003']),
  ];
  if (kind === 'CROSS_SCOPE') return [
    planned('STEP-001', 'DATA', 'PREPARE_OWNED_RESOURCE', '由需求声明的 Owner/Tenant 准备归属明确的业务资源'),
    ...(request ? [clonePlannedHttpStep(request, 'STEP-002', 'CROSS_SCOPE_ACCESS', ['STEP-001'])] : [
      planned('STEP-002', 'FUNCTIONAL', 'CROSS_SCOPE_ACCESS', '由另一 Actor/Tenant 访问该资源', ['STEP-001']),
    ]),
    planned('STEP-003', 'DATA', 'VERIFY_NO_CROSS_SCOPE_MUTATION', '独立验证响应与资源状态均符合隔离规则', ['STEP-002']),
  ];
  if (kind === 'RECOVERY') return [
    planned('STEP-001', 'DATA', 'OBSERVE_STATE_BEFORE', '采集失败路径前业务状态'),
    ...(request ? [clonePlannedHttpStep(request, 'STEP-002', 'EXECUTE_DECLARED_FAILURE_PATH', ['STEP-001'])] : [
      planned('STEP-002', 'FUNCTIONAL', 'EXECUTE_DECLARED_FAILURE_PATH', '执行需求明确声明的失败/部分失败路径', ['STEP-001']),
    ]),
    planned('STEP-003', 'DATA', 'OBSERVE_RECOVERED_STATE', '验证回滚、补偿或恢复后的业务状态与副作用', ['STEP-002']),
  ];
  return [
    planned('STEP-001', 'DATA', 'OBSERVE_STATE_BEFORE', '采集状态流转前业务状态'),
    ...(request ? [clonePlannedHttpStep(request, 'STEP-002', 'EXECUTE_STATE_TRANSITION', ['STEP-001'])] : [
      planned('STEP-002', 'FUNCTIONAL', 'EXECUTE_STATE_TRANSITION', '执行需求声明的状态流转动作', ['STEP-001']),
    ]),
    planned('STEP-003', 'DATA', 'OBSERVE_STATE_AFTER', '验证目标状态、禁止状态和相关副作用', ['STEP-002']),
  ];
}

function combinationEvidence(point: TestPoint, steps: readonly TestStep[]): TestEvidenceRequirement[] {
  const base = evidenceRequirementsFor(point);
  const httpSteps = steps.filter((step) => step.type === 'HTTP_REQUEST');
  const beforeStep = steps.find((step) => step.action?.includes('BEFORE')) ?? steps[0];
  const afterStep = [...steps].reverse().find((step) => step.channel === 'DATA') ?? steps.at(-1);
  const output: TestEvidenceRequirement[] = [];
  for (const requirement of base) {
    if (requirement.channel === 'API_REQUEST' || requirement.channel === 'API_RESPONSE') {
      for (const step of httpSteps) output.push({
        ...requirement,
        id: undefined,
        sourceStepId: step.id,
        assertionIds: undefined,
        description: `${step.action ?? step.id}：${requirement.description}`,
      });
      continue;
    }
    output.push({
      ...requirement,
      id: undefined,
      sourceStepId: requirement.phase === 'BEFORE' ? beforeStep?.id : afterStep?.id,
      assertionIds: undefined,
    });
  }
  return output;
}

function buildRiskCombinationCase(input: {
  requirement: AcceptanceRequirement;
  point: TestPoint;
  kind: RiskCombinationKind;
  id: string;
  anchor?: TestCase;
}): TestCase {
  const { requirement, point, kind, id, anchor } = input;
  const request = anchor?.steps.find((step) => step.type === 'HTTP_REQUEST');
  const steps = combinationSteps(kind, request);
  // A composite plan cannot cure a missing business oracle. Preserve the
  // earliest blocking reason so every derived Case tells users which
  // requirement/evidence gap must be closed first.
  const businessOracleMissing = ['BUSINESS_RULE', 'STATE', 'HYBRID'].includes(point.category)
    && explicitFieldAssertions(requirement, point).length === 0;
  const reason = businessOracleMissing
    ? 'BUSINESS_OBSERVABILITY_MISSING：需求没有声明可执行的状态探针、字段或后置查询，禁止用 HTTP Status 代替业务验证'
    : `COMPOSITE_EXECUTION_REQUIRED：${kind} 为高风险组合场景，必须绑定 Scenario Runner、所需 Observer 与逐步 Evidence 后执行`;
  const testCase = designedOnlyCase(requirement, point, id, reason, steps.map((step) => step.description ?? step.action ?? step.id!));
  testCase.name = `${point.objective} [${kind}]`;
  testCase.actor = anchor?.actor ? { ...anchor.actor } : undefined;
  testCase.data = anchor?.data ? { ...anchor.data } : {};
  testCase.steps = steps;
  // Without an executable HTTP anchor the composite is a pure design plan.
  // Keep its sourced design oracle, but do not expose a runtime STATUS/JSON
  // assertion that has no API step or evidence source to satisfy it.
  testCase.assertions = [
    ...(request ? anchor?.assertions ?? [] : []),
    ...designAssertion(point).filter((assertion) => request || assertion.type === 'DESIGN_EXPECTATION'),
  ]
    .filter((assertion, index, all) => all.findIndex((candidate) => candidate.type === assertion.type
      && candidate.path === assertion.path && candidate.header === assertion.header
      && JSON.stringify(candidate.expected) === JSON.stringify(assertion.expected)) === index)
    .map((assertion) => ({ ...assertion, id: undefined, evidenceRequirementIds: undefined }));
  testCase.evidenceRequirements = combinationEvidence(point, steps);
  if (anchor?.source) testCase.source = {
    ...testCase.source!,
    apiSpecId: anchor.source.apiSpecId,
    apiOperationKey: anchor.source.apiOperationKey,
    contractRef: anchor.source.contractRef,
    contractVersion: anchor.source.contractVersion,
    contractFingerprint: anchor.source.contractFingerprint,
    objectiveIds: [...new Set([...(testCase.source?.objectiveIds ?? []), ...(anchor.source.objectiveIds ?? [])])],
  };
  testCase.metadata = { ...testCase.metadata, combinationKind: kind, riskDriven: true };
  return testCase;
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
  return /(?:^|\/)(?:users?|profiles?|accounts?|members?)(?:\/|$)/i.test(api.path)
    && /^(?:id|userId|accountId|profileId|memberId)$/i.test(parameter);
}

function actorOwnedPathTarget(
  api: ApiSpec,
  point: TestPoint,
  actor: ActorSpec | undefined,
  configuredDefaultHasDeclaredOwnership = false,
): string | undefined {
  if (api.pathParams.length !== 1) return undefined;
  return explicitPathTarget(api, point)
    // A documented/configured path value is business test data. It is safe to
    // use only when the Requirement explicitly relates it to this target
    // actor; a default value alone does not prove resource ownership.
    ?? (configuredDefaultHasDeclaredOwnership ? api.pathParams[0].default?.toString() : undefined)
    // The actor identifier is only a valid fallback for identity resources.
    ?? (actorCanProvidePathTarget(api, point) ? actorTarget(actor) : undefined);
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
    expected: {
      description: point.outcomeStatus === 'KNOWN'
        ? point.expectedOutcome : 'UNKNOWN：需求未声明可判定的 Expected Result，需确认后才能执行',
    },
    evidenceRequirements: evidenceRequirementsFor(point),
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
    for (const requirement of testCase.evidenceRequirements ?? []) {
      const same = (existing.evidenceRequirements ??= []).find((candidate) =>
        candidate.channel === requirement.channel && candidate.phase === requirement.phase
        && (candidate.expectation ?? 'PRESENT') === (requirement.expectation ?? 'PRESENT'));
      if (!same) existing.evidenceRequirements.push({ ...requirement, factIds: [...requirement.factIds] });
      else {
        same.required = same.required || requirement.required;
        same.factIds = mergeUnique(same.factIds, requirement.factIds);
        if (!same.description.includes(requirement.description)) same.description = `${same.description}；${requirement.description}`;
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
          false,
          input.point,
        ),
        ...explicitFieldAssertions(requirement, input.point),
        ...(input.extraAssertions ?? []),
      ].filter((assertion, index, all) => all.findIndex((candidate) => candidate.type === assertion.type
        && candidate.path === assertion.path && candidate.header === assertion.header
        && JSON.stringify(candidate.expected) === JSON.stringify(assertion.expected)) === index),
      expected: { status: String(input.status), description: input.point.expectedOutcome },
      evidenceRequirements: evidenceRequirementsFor(input.point),
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
        ? 'UI_RUNTIME_BINDING_REQUIRED：UI 业务动作已结构化，运行时必须唯一绑定页面、稳定 Locator 与 Browser Processor'
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
      const unavailable = unavailableBaselineParameters(api);
      if (unavailable.length) {
        cases.push(designedOnlyCase(requirement, point, nextId(), `TEST_DATA_UNAVAILABLE：无法从显式 Contract 构造必填字段 ${unavailable.map((item) => item.name).join(', ')}`));
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
      const validationErrorResponses = api.responses.filter((response) => response.status === 400 || response.status === 422);
      const invalidStatus = explicitStatusNumber !== undefined && explicitStatusNumber >= 400
        ? explicitStatusNumber
        : validationErrorResponses.length === 1 ? validationErrorResponses[0].status : undefined;
      const parameterVectors = parameters.map((parameter) => ({
        parameter,
        vectors: vectorsForStrategy(vectorsFor(parameter, successStatus, invalidStatus), point),
      }));
      if (parameterVectors.every(({ vectors }) => vectors.length === 0)) {
        cases.push(designedOnlyCase(requirement, point, nextId(), 'TEST_DATA_UNAVAILABLE：参数 Contract 不足以构造可验证的正向或负向输入'));
        continue;
      }
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
        const unavailable = unavailableBaselineParameters(api, parameter);
        for (const vector of vectors) {
          if (unavailable.length) {
            const designed = designedOnlyCase(
              requirement,
              point,
              nextId(),
              `TEST_DATA_UNAVAILABLE：无法为其他必填字段构造合法基线 ${unavailable.map((item) => item.name).join(', ')}`,
            );
            designed.name = `${point.acceptanceCriteriaIds[0] ?? point.id} ${parameter.name} ${vector.label}`;
            designed.parameterContext = {
              parameter: parameter.name, constraint: vector.constraint, testData: vector.value,
              expectedResponse: vector.expectedStatus, expectedOutcome: vector.expectedOutcome,
              boundaryVector: vector.kind,
            };
            cases.push(designed);
            continue;
          }
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
    const unavailable = unavailableBaselineParameters(api);
    if (unavailable.length) {
      cases.push(designedOnlyCase(requirement, point, nextId(), `TEST_DATA_UNAVAILABLE：无法从显式 Contract 构造必填字段 ${unavailable.map((item) => item.name).join(', ')}`));
      continue;
    }
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
      const denial = point.canonicalFact.expected.kind === 'DENY' || defaultStatus === 403;
      const ownerOnly = point.canonicalFact.constraints.some((constraint) => constraint.kind === 'OWNER_ONLY')
        || point.canonicalFact.scopes.some((scope) => scope.relation === 'OWNER_ONLY' || scope.relation === 'SELF');
      const targetActor = explicitlyRelatedTarget
        // A positive permission fact such as “admin may update a target user”
        // does not prove that the source actor owns a generic business resource.
        // Only SELF/OWNER_ONLY semantics make the source a valid implicit target;
        // otherwise the target context must remain unresolved and fail closed.
        ?? (denial ? isolationTargetActor(requirement, point, sourceActor) : ownerOnly ? sourceActor : undefined);
      const declaredTargetOwnership = Boolean(explicitlyRelatedTarget
        && targetActor && explicitlyRelatedTarget.id === targetActor.id);
      const targetResourceId = actorOwnedPathTarget(api, point, targetActor, declaredTargetOwnership);
      if (!sourceActor || !targetActor) {
        cases.push(designedOnlyCase(requirement, point, nextId(), 'ISOLATION_CONTEXT_INCOMPLETE：需要至少两个 EXPLICIT/CONFIGURED Actor/Scope 与资源归属，禁止硬编码 A/B'));
      } else if (api.pathParams.length && !targetResourceId) {
        cases.push(designedOnlyCase(requirement, point, nextId(), 'TEST_DATA_UNAVAILABLE：缺少归属于目标 Actor/Tenant 的显式业务资源 ID，禁止用用户 ID 代替订单/项目/通用资源 ID'));
      } else if (denial
        && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(api.method)) {
        const designed = designedOnlyCase(requirement, point, nextId(), 'NON_MUTATION_EVIDENCE_UNAVAILABLE：隔离写操作不能只断言拒绝状态；缺少后置状态证据证明未发生跨范围修改');
        designed.actor = actorOf(sourceActor);
        designed.data = { targetId: targetResourceId! };
        cases.push(designed);
      } else {
        cases.push(buildCase({ point, api, name: `${point.acceptanceCriteriaIds[0] ?? point.id} ${api.method} ${api.path} 跨数据范围`, actor: sourceActor, targetId: targetResourceId ?? 'no-target', body, status: defaultStatus }));
      }
    } else if (point.canonicalFact.actor?.kind === 'ADMIN') {
      const admin = configuredActor?.role.toUpperCase() === 'ADMIN'
        ? configuredActor
        : actorWithUniqueRole(requirement, 'ADMIN');
      const target = explicitlyRelatedTarget ?? otherActor(requirement, admin);
      const targetResourceId = actorOwnedPathTarget(api, point, target, Boolean(explicitlyRelatedTarget));
      if (!admin || !target) {
        cases.push(designedOnlyCase(requirement, point, nextId(), 'ACTOR_CONTEXT_INCOMPLETE：需求提到管理员，但没有对应 CONFIGURED Actor/目标资源'));
      } else if (api.pathParams.length && !targetResourceId) {
        cases.push(designedOnlyCase(requirement, point, nextId(), 'TEST_DATA_UNAVAILABLE：管理员场景缺少归属已知的显式业务资源 ID'));
      } else {
        cases.push(buildCase({ point, api, name: `${point.acceptanceCriteriaIds[0] ?? point.id} ${api.method} ${api.path} 管理员`, actor: admin, targetId: targetResourceId ?? 'no-target', body, status: defaultStatus }));
      }
    } else if (point.canonicalFact.expected.kind === 'DENY') {
      const sourceActor = configuredActor;
      const crossTenant = point.canonicalFact.scopes.some((scope) => scope.dimension === 'TENANT' && scope.relation === 'CROSS');
      const target = explicitlyRelatedTarget ?? otherActor(requirement, sourceActor, crossTenant);
      const targetResourceId = actorOwnedPathTarget(api, point, target, Boolean(explicitlyRelatedTarget));
      if (!sourceActor || !target) {
        cases.push(designedOnlyCase(requirement, point, nextId(), 'ACTOR_CONTEXT_INCOMPLETE：拒绝语义缺少明确 Subject/Target Actor 与资源归属'));
      } else if (api.pathParams.length && !targetResourceId) {
        cases.push(designedOnlyCase(requirement, point, nextId(), 'TEST_DATA_UNAVAILABLE：权限拒绝场景缺少归属目标 Actor 的显式业务资源 ID'));
      } else if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(api.method)) {
        const designed = designedOnlyCase(requirement, point, nextId(), 'NON_MUTATION_EVIDENCE_UNAVAILABLE：拒绝写操作不能只断言 403；缺少后置查询/DB/Event 证据证明资源未被修改');
        designed.actor = actorOf(sourceActor);
        designed.data = { targetId: targetResourceId! };
        cases.push(designed);
      } else {
        cases.push(buildCase({ point, api, name: `${point.acceptanceCriteriaIds[0] ?? point.id} ${api.method} ${api.path} 无权限`, actor: sourceActor, targetId: targetResourceId ?? 'no-target', body, status: defaultStatus }));
      }
    } else if (point.canonicalFact.expected.status === 403) {
      cases.push(designedOnlyCase(requirement, point, nextId(), 'AUTH_SCENARIO_AMBIGUOUS：403 未说明角色、Scope、Tenant 或目标资源，禁止推断身份场景'));
    } else if (defaultStatus >= 400) {
      cases.push(designedOnlyCase(requirement, point, nextId(), `ERROR_SCENARIO_UNSUPPORTED：期望 ${defaultStatus}，但需求没有提供当前 Runner 可确定性准备的错误前置条件`));
    } else {
      const ownerOnly = point.canonicalFact.scopes.some((scope) => scope.relation === 'OWNER_ONLY');
      const ownedTarget = ownerOnly ? actorOwnedPathTarget(api, point, configuredActor) : undefined;
      if (apiRequiresActor(api) && !configuredActor) {
        cases.push(designedOnlyCase(requirement, point, nextId(), 'ACTOR_CONTEXT_INCOMPLETE：认证接口没有可唯一选择的 CONFIGURED Actor'));
      } else if (ownerOnly && api.pathParams.length && !ownedTarget) {
        cases.push(designedOnlyCase(requirement, point, nextId(), 'TEST_DATA_UNAVAILABLE：Owner-only 成功场景缺少归属于当前 Actor 的显式业务资源 ID'));
      } else if (api.pathParams.length && !configuredTarget) {
        cases.push(designedOnlyCase(requirement, point, nextId(), 'TEST_DATA_UNAVAILABLE：资源 Path Parameter 没有 EXPLICIT/CONFIGURED 值'));
      } else {
        cases.push(buildCase({ point, api, name: `${point.acceptanceCriteriaIds[0] ?? point.id} ${api.method} ${api.path}`, actor: configuredActor, targetId: ownedTarget ?? configuredTarget ?? 'no-target', body, status: defaultStatus }));
      }
    }
  }
  const finalized = coalesceCoveredOperationDesignCases(
    failCloseAmbiguousExecutableOracles(deduplicateAcceptanceCases(cases)),
  );
  const pointById = new Map(points.map((point) => [point.id, point]));
  for (const testCase of finalized) {
    const point = pointById.get(testCase.source?.testPointId ?? '');
    if (!point) continue;
    const objectiveIds = new Set(testCase.source?.objectiveIds ?? []);
    const relatedPoints = points.filter((candidate) => objectiveIds.has(candidate.objectiveId));
    completeGeneratedCase(requirement, point, testCase,
      point.apiBinding ? apiById.get(point.apiBinding.apiSpecId) : undefined,
      relatedPoints.length ? relatedPoints : [point]);
  }
  const generatedCombinationKeys = new Set<string>();
  for (const point of points) {
    const kind = riskCombinationKind(point);
    if (!kind || point.priority !== 'P0') continue;
    const key = `${kind}:${[...point.factIds].sort().join(',')}`;
    if (generatedCombinationKeys.has(key)) continue;
    generatedCombinationKeys.add(key);
    const sameObjective = (candidate: TestCase): boolean => Boolean(
      candidate.source?.objectiveIds?.includes(point.objectiveId),
    );
    const sameFact = (candidate: TestCase): boolean => Boolean(
      candidate.source?.factIds?.some((id) => point.factIds.includes(id)),
    );
    const anchor = finalized.find((candidate) => sameObjective(candidate)
      && candidate.steps.some((step) => step.type === 'HTTP_REQUEST'))
      ?? finalized.find(sameObjective)
      ?? finalized.find((candidate) => sameFact(candidate)
        && candidate.steps.some((step) => step.type === 'HTTP_REQUEST'))
      ?? finalized.find(sameFact);
    const combination = buildRiskCombinationCase({
      requirement,
      point,
      kind,
      id: nextId(),
      anchor,
    });
    const relatedPoints = points.filter((candidate) => candidate.factIds.some((id) => point.factIds.includes(id)));
    const apiSpecId = anchor?.source?.apiSpecId ?? point.apiBinding?.apiSpecId;
    completeGeneratedCase(
      requirement,
      point,
      combination,
      apiSpecId ? apiById.get(apiSpecId) : undefined,
      relatedPoints.length ? relatedPoints : [point],
    );
    finalized.push(combination);
  }
  return assignStableAcceptanceCaseIds(finalized);
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
    const explicitRequirementCases = group.filter((testCase) => testCase.source?.sourceType === 'REQUIREMENT'
      && testCase.source.provenance === 'EXPLICIT');
    const explicitStatuses = new Set(explicitRequirementCases.flatMap((testCase) => testCase.assertions
      .filter((assertion) => assertion.type === 'STATUS_CODE')
      .map((assertion) => Number(assertion.expected))));
    // A generic Operation-contract happy path can accidentally resolve to the
    // same configured resource as a more specific AC (for example, Alice
    // reading Bob's configured order). The explicit AC owns that request
    // oracle; demote only the weaker conflicting contract case. Conflicting
    // explicit ACs remain a hard fail-close for every case in the group.
    const authoritativeStatus = explicitStatuses.size === 1 ? [...explicitStatuses][0] : undefined;
    const casesToBlock = authoritativeStatus !== undefined
      ? group.filter((testCase) => !explicitRequirementCases.includes(testCase)
        && testCase.assertions.some((assertion) => assertion.type === 'STATUS_CODE'
          && Number(assertion.expected) !== authoritativeStatus))
      : group;
    for (const testCase of casesToBlock) {
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
    // 该 Case 只是在陈述已有 Operation Contract，真实 AC Case 已覆盖同一请求。
    // 可以隐藏重复展示，但绝不能把 UNKNOWN/BINDING_INCOMPLETE Fact 合并进可执行
    // Assertion，否则一个 2xx 结果会把未验证 Fact 错标为 VERIFIED。
    return false;
  });
}
