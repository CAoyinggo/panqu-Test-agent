import { readdir, readFile, stat } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import type { HttpMethod } from './requirement-ir.js';
import type {
  BlockedReasonCode,
  ScenarioAssertionChannel,
  ScenarioAssertionOperator,
  ScenarioEvidenceKind,
  ScenarioExecutionMode,
  ScenarioOperationChannel,
} from './scenario-contract.js';
import {
  parseScenarioMarkdown,
  SCENARIO_AUTHORING_EXECUTION_MODES,
  SCENARIO_BLOCKED_REASON_CODES,
  SCENARIO_EVIDENCE_KINDS,
  type ScenarioMarkdownParseResult,
} from './scenario-markdown-parser.js';
import { TEST_PATTERN_IDS, type TestPatternId } from './test-pattern-registry.js';

export interface ScenarioExpectedOperation {
  id: string;
  method?: HttpMethod | null;
  path?: string | null;
  channel?: ScenarioOperationChannel;
  processor?: string | null;
  purpose?: string;
  intent?: string;
  observer?: unknown;
  binding?: unknown;
  bindingRequired?: boolean;
  realExecutionAllowed?: boolean;
}

export interface ScenarioExpectedAssertion {
  id: string;
  ac: string | string[];
  operation?: string;
  channel?: ScenarioAssertionChannel;
  target?: string;
  operator?: ScenarioAssertionOperator;
  expected?: unknown;
  expectedFrom?: string;
  oracle?: string;
  resolution?: 'REQUIRED' | 'OPTIONAL';
}

/** expected.json 是可执行资产的独立预期契约，不接受开放式任意字段。 */
export interface ScenarioExpectedContract {
  scenarioId: string;
  mode: Extract<ScenarioExecutionMode, 'EXECUTABLE' | 'DESIGNED_ONLY' | 'BLOCKED'>;
  patterns: TestPatternId[];
  operations: ScenarioExpectedOperation[];
  assertions: ScenarioExpectedAssertion[];
  requiredEvidenceKinds: ScenarioEvidenceKind[];
  blockedCodes: BlockedReasonCode[];
}

export interface ScenarioAssetPack {
  directory: string;
  requirementPath: string;
  expectedPath: string;
  configExamplePath?: string;
  serverScenarioPath?: string;
  markdown: string;
  expected: ScenarioExpectedContract;
  configExample?: Record<string, unknown>;
  parse: ScenarioMarkdownParseResult;
}

type JsonRecord = Record<string, unknown>;

const HTTP_METHODS = new Set<HttpMethod>(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const OPERATION_CHANNELS = new Set<ScenarioOperationChannel>(['API', 'UI', 'DATA', 'QUEUE', 'PROVIDER']);
const ASSERTION_CHANNELS = new Set<ScenarioAssertionChannel>([
  'API', 'UI', 'DATA', 'QUEUE', 'PROVIDER', 'RESPONSE', 'STATE', 'SIDE_EFFECT', 'AUDIT', 'SYSTEM',
]);
const ASSERTION_OPERATORS = new Set<ScenarioAssertionOperator>([
  'EQUALS', 'NOT_EQUALS', 'EXISTS', 'NOT_EXISTS', 'CONTAINS', 'NOT_CONTAINS',
  'GREATER_THAN', 'GREATER_THAN_OR_EQUAL', 'LESS_THAN', 'LESS_THAN_OR_EQUAL',
  'MATCHES', 'TYPE_IS', 'COUNT_EQUALS', 'UNCHANGED', 'TRANSITIONED_TO', 'CUSTOM',
]);
const AUTHORING_MODES = new Set<string>(SCENARIO_AUTHORING_EXECUTION_MODES);
const EVIDENCE_KINDS = new Set<string>(SCENARIO_EVIDENCE_KINDS);
const BLOCKED_CODES = new Set<string>(SCENARIO_BLOCKED_REASON_CODES);
const PATTERN_IDS = new Set<string>(TEST_PATTERN_IDS);

const EXPECTED_KEYS = [
  'scenarioId', 'mode', 'patterns', 'operations', 'assertions', 'requiredEvidenceKinds', 'blockedCodes',
] as const;
const OPERATION_KEYS = [
  'id', 'method', 'path', 'channel', 'processor', 'purpose', 'intent', 'observer', 'binding',
  'bindingRequired', 'realExecutionAllowed',
] as const;
const ASSERTION_KEYS = [
  'id', 'ac', 'operation', 'channel', 'target', 'operator', 'expected', 'expectedFrom', 'oracle', 'resolution',
] as const;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function own(value: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function schemaFailure(location: string, message: string): never {
  throw new Error(`EXPECTED_SCHEMA_INVALID：${location}：${message}`);
}

function exactKeys(value: JsonRecord, allowed: readonly string[], location: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length) schemaFailure(location, `未知字段 ${unknown.join(', ')}`);
}

function requiredFields(value: JsonRecord, fields: readonly string[], location: string): void {
  const missing = fields.filter((field) => !own(value, field));
  if (missing.length) schemaFailure(location, `缺少字段 ${missing.join(', ')}`);
}

function nonEmptyString(value: unknown, location: string): string {
  if (typeof value !== 'string' || !value.trim()) schemaFailure(location, '必须是非空字符串');
  return value.trim();
}

function optionalString(value: JsonRecord, key: string, location: string): string | undefined {
  if (!own(value, key)) return undefined;
  return nonEmptyString(value[key], `${location}.${key}`);
}

function enumString<T extends string>(value: unknown, allowed: ReadonlySet<string>, location: string): T {
  const result = nonEmptyString(value, location);
  if (!allowed.has(result)) schemaFailure(location, `非法枚举值 ${result}`);
  return result as T;
}

function uniqueStringArray<T extends string>(
  value: unknown,
  location: string,
  allowed?: ReadonlySet<string>,
  allowEmpty = false,
): T[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) schemaFailure(location, `必须是${allowEmpty ? '' : '非空'}字符串数组`);
  const result = value.map((item, index) => nonEmptyString(item, `${location}[${index}]`));
  if (new Set(result).size !== result.length) schemaFailure(location, '不允许重复值');
  const invalid = allowed ? result.filter((item) => !allowed.has(item)) : [];
  if (invalid.length) schemaFailure(location, `非法枚举值 ${invalid.join(', ')}`);
  return result as T[];
}

function nullableString(value: unknown, location: string): string | null {
  return value === null ? null : nonEmptyString(value, location);
}

function validateOpaqueBinding(value: unknown, location: string): void {
  if (value === null || typeof value === 'string' || isRecord(value)) return;
  schemaFailure(location, '必须是 null、字符串或对象');
}

function validateExpectedOperation(value: unknown, index: number): ScenarioExpectedOperation {
  const location = `operations[${index}]`;
  if (!isRecord(value)) schemaFailure(location, '必须是对象');
  exactKeys(value, OPERATION_KEYS, location);
  requiredFields(value, ['id'], location);
  const operation: ScenarioExpectedOperation = { id: nonEmptyString(value.id, `${location}.id`) };
  if (own(value, 'method')) {
    operation.method = value.method === null ? null : enumString<HttpMethod>(value.method, HTTP_METHODS, `${location}.method`);
  }
  if (own(value, 'path')) operation.path = nullableString(value.path, `${location}.path`);
  if (own(value, 'channel')) operation.channel = enumString<ScenarioOperationChannel>(value.channel, OPERATION_CHANNELS, `${location}.channel`);
  if (own(value, 'processor')) operation.processor = nullableString(value.processor, `${location}.processor`);
  if (own(value, 'purpose')) operation.purpose = optionalString(value, 'purpose', location);
  if (own(value, 'intent')) operation.intent = optionalString(value, 'intent', location);
  if (own(value, 'observer')) {
    validateOpaqueBinding(value.observer, `${location}.observer`);
    operation.observer = value.observer;
  }
  if (own(value, 'binding')) {
    validateOpaqueBinding(value.binding, `${location}.binding`);
    operation.binding = value.binding;
  }
  for (const key of ['bindingRequired', 'realExecutionAllowed'] as const) {
    if (!own(value, key)) continue;
    if (typeof value[key] !== 'boolean') schemaFailure(`${location}.${key}`, '必须是 boolean');
    operation[key] = value[key] as boolean;
  }
  if (!operation.purpose && !operation.intent && !own(value, 'method') && !own(value, 'channel') && !own(value, 'binding')) {
    schemaFailure(location, '除 id 外至少声明 purpose/intent/method/channel/binding 之一');
  }
  return operation;
}

function validateAcceptanceCriteria(value: unknown, location: string): string | string[] {
  if (typeof value === 'string') return nonEmptyString(value, location);
  return uniqueStringArray<string>(value, location);
}

function validateExpectedAssertion(value: unknown, index: number): ScenarioExpectedAssertion {
  const location = `assertions[${index}]`;
  if (!isRecord(value)) schemaFailure(location, '必须是对象');
  exactKeys(value, ASSERTION_KEYS, location);
  requiredFields(value, ['id', 'ac'], location);
  const assertion: ScenarioExpectedAssertion = {
    id: nonEmptyString(value.id, `${location}.id`),
    ac: validateAcceptanceCriteria(value.ac, `${location}.ac`),
  };
  if (own(value, 'operation')) assertion.operation = optionalString(value, 'operation', location);
  if (own(value, 'channel')) assertion.channel = enumString<ScenarioAssertionChannel>(value.channel, ASSERTION_CHANNELS, `${location}.channel`);
  if (own(value, 'target')) assertion.target = optionalString(value, 'target', location);
  if (own(value, 'operator')) assertion.operator = enumString<ScenarioAssertionOperator>(value.operator, ASSERTION_OPERATORS, `${location}.operator`);
  if (own(value, 'expected')) assertion.expected = value.expected;
  if (own(value, 'expectedFrom')) assertion.expectedFrom = optionalString(value, 'expectedFrom', location);
  if (own(value, 'oracle')) assertion.oracle = optionalString(value, 'oracle', location);
  if (own(value, 'resolution')) {
    assertion.resolution = enumString<'REQUIRED' | 'OPTIONAL'>(value.resolution, new Set(['REQUIRED', 'OPTIONAL']), `${location}.resolution`);
  }
  const structured = Boolean(assertion.target && assertion.operator);
  const descriptive = Boolean(assertion.oracle && assertion.resolution);
  if (!structured && !descriptive) schemaFailure(location, '必须声明 target+operator 或 oracle+resolution');
  if (Boolean(assertion.target) !== Boolean(assertion.operator)) schemaFailure(location, 'target 与 operator 必须成对声明');
  if (Boolean(assertion.oracle) !== Boolean(assertion.resolution)) schemaFailure(location, 'oracle 与 resolution 必须成对声明');
  return assertion;
}

function validateExpectedContract(value: unknown): ScenarioExpectedContract {
  if (!isRecord(value)) schemaFailure('expected.json', '根节点必须是对象');
  exactKeys(value, EXPECTED_KEYS, 'expected.json');
  requiredFields(value, EXPECTED_KEYS, 'expected.json');
  const operations = (Array.isArray(value.operations) ? value.operations : schemaFailure('operations', '必须是数组'))
    .map(validateExpectedOperation);
  const assertions = (Array.isArray(value.assertions) ? value.assertions : schemaFailure('assertions', '必须是数组'))
    .map(validateExpectedAssertion);
  if (!operations.length) schemaFailure('operations', '至少需要一个 Operation');
  if (!assertions.length) schemaFailure('assertions', '至少需要一个 Assertion');
  if (new Set(operations.map((item) => item.id)).size !== operations.length) schemaFailure('operations', 'Operation ID 必须唯一');
  if (new Set(assertions.map((item) => item.id)).size !== assertions.length) schemaFailure('assertions', 'Assertion ID 必须唯一');
  return {
    scenarioId: nonEmptyString(value.scenarioId, 'scenarioId'),
    mode: enumString<ScenarioExpectedContract['mode']>(value.mode, AUTHORING_MODES, 'mode'),
    patterns: uniqueStringArray<TestPatternId>(value.patterns, 'patterns', PATTERN_IDS),
    operations,
    assertions,
    requiredEvidenceKinds: uniqueStringArray<ScenarioEvidenceKind>(value.requiredEvidenceKinds, 'requiredEvidenceKinds', EVIDENCE_KINDS),
    blockedCodes: uniqueStringArray<BlockedReasonCode>(value.blockedCodes, 'blockedCodes', BLOCKED_CODES, true),
  };
}

function printable(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

function contractMismatch(location: string, expected: unknown, actual: unknown): never {
  throw new Error(`SCENARIO_EXPECTED_CONTRACT_MISMATCH：${location}：expected=${printable(expected)} actual=${printable(actual)}`);
}

function compareField(location: string, expected: unknown, actual: unknown): void {
  if (!isDeepStrictEqual(expected, actual)) contractMismatch(location, expected, actual);
}

function normalizedNullable(value: unknown): unknown {
  return value === null ? undefined : value;
}

function acceptanceCriteriaList(value: string | string[]): string[] {
  return Array.isArray(value) ? value : [value];
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort();
}

/** 精确核对 expected 的可观察契约；purpose/intent/oracle 是人工说明，不伪造成 Scenario 字段。 */
function reconcileExpectedContract(expected: ScenarioExpectedContract, parse: ScenarioMarkdownParseResult): void {
  const scenario = parse.scenario;
  if (expected.scenarioId !== scenario.id) {
    throw new Error(`SCENARIO_EXPECTED_ID_MISMATCH：Markdown=${scenario.id} expected.json=${expected.scenarioId}`);
  }
  compareField('mode', expected.mode, scenario.executionMode);
  compareField('patterns', expected.patterns, scenario.patternIds);
  compareField('operations.length', expected.operations.length, scenario.operations.length);
  expected.operations.forEach((contract, index) => {
    const operation = scenario.operations[index];
    compareField(`operations[${index}].id`, contract.id, operation?.id);
    for (const [expectedKey, actualKey] of [
      ['method', 'method'], ['path', 'path'], ['channel', 'channel'], ['processor', 'processor'],
    ] as const) {
      if (!Object.prototype.hasOwnProperty.call(contract, expectedKey)) continue;
      compareField(`operations[${index}].${expectedKey}`, normalizedNullable(contract[expectedKey]), operation?.[actualKey]);
    }
  });
  compareField('assertions.length', expected.assertions.length, scenario.assertions.length);
  expected.assertions.forEach((contract, index) => {
    const assertion = scenario.assertions[index];
    compareField(`assertions[${index}].id`, contract.id, assertion?.id);
    compareField(`assertions[${index}].ac`, acceptanceCriteriaList(contract.ac), assertion?.acceptanceCriteriaIds);
    for (const [expectedKey, actualKey] of [
      ['operation', 'operationId'], ['channel', 'channel'], ['target', 'target'],
      ['operator', 'operator'], ['expected', 'expected'], ['expectedFrom', 'expectedFrom'],
    ] as const) {
      if (!Object.prototype.hasOwnProperty.call(contract, expectedKey)) continue;
      compareField(`assertions[${index}].${expectedKey}`, contract[expectedKey], assertion?.[actualKey]);
    }
  });
  const actualEvidenceKinds = sortedUnique(scenario.evidenceRequirements
    .filter((item) => item.requiredForPass)
    .map((item) => item.kind));
  compareField('requiredEvidenceKinds', sortedUnique(expected.requiredEvidenceKinds), actualEvidenceKinds);

  // expected.blockedCodes 描述作者在 Markdown 表中显式声明的契约；Parser 派生诊断另由 issues 精确保留。
  const declaredBlockedCodes = sortedUnique(scenario.blockedReasons
    .filter((reason) => reason.source?.section === 'Blocked Reason')
    .map((reason) => reason.code));
  compareField('blockedCodes', sortedUnique(expected.blockedCodes), declaredBlockedCodes);
}

async function optionalJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!isRecord(parsed)) throw new Error('JSON 根节点必须是对象');
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`INVALID_SCENARIO_JSON：${file}：${(error as Error).message}`);
  }
}

async function exists(file: string): Promise<boolean> {
  try { return (await stat(file)).isFile(); } catch { return false; }
}

/**
 * 加载静态 Scenario Pack。server-scenario.ts 只作为路径返回，绝不由 Loader
 * 动态 import；运行时辅助代码必须经过显式 allowlist/构建流程。
 */
export async function loadScenarioAssetPack(directory: string): Promise<ScenarioAssetPack> {
  const resolvedDirectory = path.resolve(directory);
  const requirementPath = path.join(resolvedDirectory, 'requirement.md');
  const expectedPath = path.join(resolvedDirectory, 'expected.json');
  const configExamplePath = path.join(resolvedDirectory, 'acceptance.config.example.json');
  const serverScenarioPath = path.join(resolvedDirectory, 'server-scenario.ts');
  const markdown = await readFile(requirementPath, 'utf8');
  let expected: ScenarioExpectedContract;
  try {
    const raw: unknown = JSON.parse(await readFile(expectedPath, 'utf8'));
    expected = validateExpectedContract(raw);
  } catch (error) {
    throw new Error(`INVALID_SCENARIO_EXPECTED：${expectedPath}：${(error as Error).message}`);
  }
  const parse = parseScenarioMarkdown(markdown, {
    documentId: requirementPath,
    domain: path.basename(path.dirname(resolvedDirectory)),
  });
  if (!parse.valid) {
    const errors = parse.issues.filter((issue) => issue.severity === 'ERROR');
    const declaredContractGap = expected.blockedCodes.includes('MISSING_API_CONTRACT')
      || expected.blockedCodes.includes('MISSING_PROCESSOR');
    // BLOCKED assets may intentionally preserve unknown Method/Path/Processor as the
    // auditable contract gap. Syntax/schema/enum/reference errors are never waived.
    const intentionalBlockedGap = expected.mode === 'BLOCKED'
      && declaredContractGap
      && errors.every((issue) => ['MISSING_METHOD', 'MISSING_PATH', 'MISSING_PROCESSOR'].includes(issue.code));
    if (!intentionalBlockedGap) {
      const descriptions = errors.map((issue) => `${issue.code}${issue.section ? `@${issue.section}` : ''}`);
      throw new Error(`INVALID_SCENARIO_MARKDOWN：${requirementPath}：${descriptions.join(', ')}`);
    }
  }
  reconcileExpectedContract(expected, parse);
  return {
    directory: resolvedDirectory,
    requirementPath,
    expectedPath,
    configExamplePath: await exists(configExamplePath) ? configExamplePath : undefined,
    serverScenarioPath: await exists(serverScenarioPath) ? serverScenarioPath : undefined,
    markdown,
    expected,
    configExample: await optionalJson(configExamplePath),
    parse,
  };
}

async function findRequirementFiles(directory: string, output: string[]): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await findRequirementFiles(target, output);
    else if (entry.isFile() && entry.name === 'requirement.md') output.push(target);
  }
}

export async function discoverScenarioAssetPacks(root: string): Promise<ScenarioAssetPack[]> {
  const requirementFiles: string[] = [];
  await findRequirementFiles(path.resolve(root), requirementFiles);
  return await Promise.all(requirementFiles.sort().map((file) => loadScenarioAssetPack(path.dirname(file))));
}
