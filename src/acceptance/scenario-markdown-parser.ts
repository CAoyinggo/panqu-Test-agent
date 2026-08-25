import type { HttpMethod } from './requirement-ir.js';
import type {
  BlockedReason,
  BlockedReasonCode,
  EvidenceRequirement,
  Scenario,
  ScenarioActorKind,
  ScenarioAssertion,
  ScenarioAssertionChannel,
  ScenarioAssertionOperator,
  ScenarioAuthenticationType,
  ScenarioEvidenceKind,
  ScenarioExecutionMode,
  ScenarioHook,
  ScenarioOperation,
  ScenarioOperationChannel,
  ScenarioPrecondition,
  ScenarioRisk,
  ScenarioTestData,
  ScenarioTestDataSource,
} from './scenario-contract.js';

export type ScenarioParserIssueCode =
  | 'INVALID_SCENARIO_DOCUMENT'
  | 'MISSING_SECTION'
  | 'INVALID_SECTION'
  | 'INVALID_TABLE'
  | 'MISSING_SCENARIO_ID'
  | 'MISSING_ACCEPTANCE_CRITERIA'
  | 'INVALID_PRIORITY'
  | 'INVALID_EXECUTION_MODE'
  | 'INVALID_ACTOR'
  | 'INVALID_AUTHENTICATION'
  | 'MISSING_METHOD'
  | 'MISSING_PATH'
  | 'INVALID_METHOD'
  | 'INVALID_CHANNEL'
  | 'MISSING_PROCESSOR'
  | 'MISSING_ASSERTION'
  | 'INVALID_ASSERTION'
  | 'MISSING_EVIDENCE'
  | 'INVALID_EVIDENCE_KIND'
  | 'INVALID_BLOCKED_REASON'
  | 'MISSING_BLOCKED_REASON';

export interface ScenarioParserIssue {
  code: ScenarioParserIssueCode;
  severity: 'ERROR' | 'WARNING';
  message: string;
  section?: string;
  line?: number;
}

export interface ScenarioMarkdownParseResult {
  scenario: Scenario;
  issues: ScenarioParserIssue[];
  valid: boolean;
}

export interface ScenarioMarkdownParserOptions {
  documentId?: string;
  domain?: string;
}

interface MarkdownSection {
  name: string;
  content: string;
  line: number;
}

const METHODS = new Set<HttpMethod>(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const CHANNELS = new Set<ScenarioOperationChannel>(['API', 'UI', 'DATA', 'QUEUE', 'PROVIDER']);
const ASSERTION_CHANNELS = new Set<ScenarioAssertionChannel>([
  'API', 'UI', 'DATA', 'QUEUE', 'PROVIDER', 'RESPONSE', 'STATE', 'SIDE_EFFECT', 'AUDIT', 'SYSTEM',
]);
const OPERATORS = new Set<ScenarioAssertionOperator>([
  'EQUALS', 'NOT_EQUALS', 'EXISTS', 'NOT_EXISTS', 'CONTAINS', 'NOT_CONTAINS',
  'GREATER_THAN', 'GREATER_THAN_OR_EQUAL', 'LESS_THAN', 'LESS_THAN_OR_EQUAL',
  'MATCHES', 'TYPE_IS', 'COUNT_EQUALS', 'UNCHANGED', 'TRANSITIONED_TO', 'CUSTOM',
]);
/** Markdown 是设计资产；NOT_EXECUTED/TIMEOUT/CANCELLED 只能由运行实例产生。 */
export const SCENARIO_AUTHORING_EXECUTION_MODES = ['EXECUTABLE', 'DESIGNED_ONLY', 'BLOCKED'] as const satisfies readonly ScenarioExecutionMode[];
export const SCENARIO_EVIDENCE_KINDS = [
  'REQUEST', 'RESPONSE', 'STATE_BEFORE', 'STATE_AFTER', 'DATABASE', 'RESOURCE', 'EVENT',
  'QUEUE_MESSAGE', 'PROVIDER_CALL', 'BILLING_RECORD', 'AUDIT_RECORD', 'CACHE_ENTRY',
  'FILE', 'LOG', 'TRACE', 'METRIC', 'SCREENSHOT', 'OTHER',
] as const satisfies readonly ScenarioEvidenceKind[];
export const SCENARIO_BLOCKED_REASON_CODES = [
  'REQUIREMENT_CONFLICT', 'MISSING_ACCEPTANCE_CRITERIA', 'MISSING_API_CONTRACT',
  'MISSING_OPERATION_BINDING', 'AMBIGUOUS_OPERATION_BINDING', 'MISSING_METHOD',
  'MISSING_PATH', 'MISSING_PROCESSOR', 'MISSING_EXECUTOR', 'UNSUPPORTED_OPERATION',
  'MISSING_ACTOR', 'MISSING_AUTHENTICATION', 'MISSING_TENANT', 'MISSING_PROJECT',
  'MISSING_RESOURCE_OWNER', 'MISSING_TEST_DATA', 'MISSING_PRECONDITION',
  'MISSING_ASSERTION', 'MISSING_RESPONSE_ASSERTION', 'MISSING_STATE_ASSERTION',
  'MISSING_SIDE_EFFECT_ASSERTION', 'MISSING_EVIDENCE', 'MISSING_STATE_OBSERVER',
  'MISSING_SIDE_EFFECT_OBSERVER', 'MISSING_ENVIRONMENT', 'MISSING_DEPENDENCY',
  'MISSING_PREPARE', 'MISSING_CLEANUP', 'AMBIGUOUS_ORACLE', 'POLICY_BLOCKED',
  'INVALID_SCENARIO', 'EXECUTION_ABORTED',
] as const satisfies readonly BlockedReasonCode[];
export const SCENARIO_BLOCKED_REASON_STAGES = [
  'PARSER', 'REQUIREMENT', 'DESIGN', 'PATTERN_SELECTION', 'BINDING', 'GATE',
  'POLICY', 'PREPARE', 'EXECUTION', 'ASSERTION', 'EVIDENCE', 'CLEANUP', 'REPORT',
] as const satisfies readonly BlockedReason['stage'][];
const EXECUTION_MODES = new Set<ScenarioExecutionMode>(SCENARIO_AUTHORING_EXECUTION_MODES);
const EVIDENCE_KINDS: ReadonlySet<string> = new Set(SCENARIO_EVIDENCE_KINDS);
const BLOCKED_REASON_CODES: ReadonlySet<string> = new Set(SCENARIO_BLOCKED_REASON_CODES);
const BLOCKED_REASON_STAGES: ReadonlySet<string> = new Set(SCENARIO_BLOCKED_REASON_STAGES);

function isEvidenceKind(value: string): value is ScenarioEvidenceKind {
  return EVIDENCE_KINDS.has(value);
}

function isBlockedReasonCode(value: string): value is BlockedReasonCode {
  return BLOCKED_REASON_CODES.has(value);
}

function isBlockedReasonStage(value: string): value is BlockedReason['stage'] {
  return BLOCKED_REASON_STAGES.has(value);
}

interface MarkdownTable {
  headers: string[];
  rows: Array<Record<string, string>>;
}

interface TableSchema {
  section: string;
  requiredHeaders: readonly string[];
  optionalHeaders?: readonly string[];
  requireRows?: boolean;
}

function normalizeCell(value: string | undefined): string {
  const cell = (value ?? '').trim();
  if ((cell.startsWith('`') && cell.endsWith('`')) || (cell.startsWith('"') && cell.endsWith('"'))) {
    return cell.slice(1, -1).trim();
  }
  return cell;
}

function isEmptyCell(value: string | undefined): boolean {
  const normalized = normalizeCell(value).toUpperCase();
  return !normalized || normalized === '-' || normalized === 'NONE' || normalized === 'NOT_APPLICABLE' || normalized === 'N/A';
}

function splitList(value: string | undefined): string[] {
  if (isEmptyCell(value)) return [];
  return normalizeCell(value).split(/\s*[,，;；]\s*/).map((item) => item.trim()).filter(Boolean);
}

function parseLiteral(value: string | undefined): unknown {
  if (isEmptyCell(value)) return undefined;
  const normalized = normalizeCell(value);
  try {
    return JSON.parse(normalized) as unknown;
  } catch {
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
    if (normalized === 'null') return null;
    if (/^-?\d+(?:\.\d+)?$/.test(normalized)) return Number(normalized);
    return normalized;
  }
}

function splitSections(markdown: string): {
  title: string;
  sections: Map<string, MarkdownSection>;
  duplicates: MarkdownSection[];
} {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const title = lines.find((line) => /^#\s+/.test(line))?.replace(/^#\s+/, '').trim() ?? '';
  const sections = new Map<string, MarkdownSection>();
  const duplicates: MarkdownSection[] = [];
  let current: MarkdownSection | undefined;
  const buffers = new Map<string, string[]>();
  lines.forEach((line, index) => {
    const match = line.match(/^##\s+(.+?)\s*$/);
    if (match) {
      current = { name: match[1].trim(), content: '', line: index + 1 };
      const key = current.name.toLowerCase();
      if (sections.has(key)) {
        duplicates.push(current);
        current = undefined;
        return;
      }
      sections.set(key, current);
      buffers.set(key, []);
      return;
    }
    if (current) buffers.get(current.name.toLowerCase())!.push(line);
  });
  for (const [key, section] of sections) section.content = (buffers.get(key) ?? []).join('\n').trim();
  return { title, sections, duplicates };
}

function section(sections: Map<string, MarkdownSection>, name: string): MarkdownSection | undefined {
  return sections.get(name.toLowerCase());
}

function plainContent(value: string): string {
  return value
    .replace(/<!--[^]*?-->/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^\|?\s*:?-{3,}/.test(line))
    .join('\n')
    .trim();
}

function firstValue(value: string): string {
  const clean = plainContent(value);
  const line = clean.split('\n').find((item) => item && !item.startsWith('|')) ?? '';
  return line.replace(/^[-*]\s*/, '').trim();
}

function bulletMap(value: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of plainContent(value).split('\n')) {
    const match = line.match(/^[-*]\s*([^:：]+)[:：]\s*(.*)$/);
    if (match) result.set(match[1].trim().toLowerCase(), match[2].trim());
  }
  return result;
}

function bullets(value: string): string[] {
  return plainContent(value).split('\n')
    .map((line) => line.match(/^[-*]\s+(.+)$/)?.[1]?.trim())
    .filter((item): item is string => typeof item === 'string' && item.length > 0)
    .filter((item) => !/^(?:NONE|NOT_APPLICABLE|N\/A)$/i.test(item));
}

function parseTable(value: string): MarkdownTable {
  const rows = value.split('\n').map((line) => line.trim()).filter((line) => /^\|.*\|$/.test(line));
  if (rows.length < 2) return { headers: [], rows: [] };
  const cells = (line: string) => line.slice(1, -1).split('|').map((item) => item.trim());
  const headers = cells(rows[0]).map((header) => header.toLowerCase().replace(/\s+/g, ''));
  return {
    headers,
    rows: rows.slice(2)
    .filter((line) => !/^\|\s*:?-{3,}/.test(line))
    .map((line) => {
      const values = cells(line);
      return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']));
    }),
  };
}

function canonicalHeader(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '');
}

function validatedTable(value: string, schema: TableSchema, issues: ScenarioParserIssue[]): MarkdownTable {
  const lines = value.split('\n').map((line) => line.trim()).filter((line) => /^\|.*\|$/.test(line));
  const table = parseTable(value);
  if (lines.length < 2 || !table.headers.length) {
    issues.push({ code: 'INVALID_TABLE', severity: 'ERROR', section: schema.section, message: `${schema.section} 必须包含 canonical Markdown 表头和分隔行` });
    return table;
  }
  const cells = (line: string) => line.slice(1, -1).split('|').map((item) => item.trim());
  const separator = cells(lines[1]);
  if (separator.length !== table.headers.length || separator.some((cell) => !/^:?-{3,}:?$/.test(cell))) {
    issues.push({ code: 'INVALID_TABLE', severity: 'ERROR', section: schema.section, message: `${schema.section} 的 Markdown 表格分隔行无效` });
  }
  if (new Set(table.headers).size !== table.headers.length) {
    issues.push({ code: 'INVALID_TABLE', severity: 'ERROR', section: schema.section, message: `${schema.section} 包含重复列名` });
  }
  const required = schema.requiredHeaders.map(canonicalHeader);
  const allowed = new Set([...required, ...(schema.optionalHeaders ?? []).map(canonicalHeader)]);
  const missing = required.filter((header) => !table.headers.includes(header));
  const unknown = table.headers.filter((header) => !allowed.has(header));
  if (missing.length) {
    issues.push({ code: 'INVALID_TABLE', severity: 'ERROR', section: schema.section, message: `${schema.section} 缺少列：${missing.join(', ')}` });
  }
  if (unknown.length) {
    issues.push({ code: 'INVALID_TABLE', severity: 'ERROR', section: schema.section, message: `${schema.section} 包含未知列：${unknown.join(', ')}` });
  }
  for (const [index, line] of lines.slice(2).entries()) {
    if (cells(line).length !== table.headers.length) {
      issues.push({ code: 'INVALID_TABLE', severity: 'ERROR', section: schema.section, message: `${schema.section} 第 ${index + 1} 行列数与表头不一致` });
    }
  }
  if (schema.requireRows !== false && !table.rows.length) {
    issues.push({ code: 'INVALID_TABLE', severity: 'ERROR', section: schema.section, message: `${schema.section} 至少需要一条数据行` });
  }
  return table;
}

function acceptanceCriteria(value: string): Array<{ id: string; description: string }> {
  const chunks = value.split(/^###\s+/gm).slice(1);
  return chunks.map((chunk) => {
    const [heading, ...body] = chunk.split('\n');
    return { id: heading.trim().toUpperCase(), description: plainContent(body.join('\n')) };
  }).filter((item) => /^AC-[A-Z0-9_-]+$/.test(item.id));
}

function mapDataSource(value: string): ScenarioTestDataSource {
  const source = value.toUpperCase().replace(/[\s-]+/g, '_');
  if (source.includes('FIXTURE')) return 'FIXTURE';
  if (source.includes('PREPARE') || source.includes('HOOK')) return 'PREPARE_HOOK';
  if (source.includes('CONFIG')) return 'CONFIGURATION';
  if (source.includes('CAPTURE')) return 'CAPTURED';
  if (source.includes('GENERAT')) return 'GENERATED';
  return 'EXPLICIT';
}

function blockedReason(code: BlockedReasonCode, stage: BlockedReason['stage'], message: string, documentId?: string): BlockedReason {
  return { code, stage, message, details: {}, recoverable: true, source: documentId ? { documentId } : undefined };
}

function parserReason(issue: ScenarioParserIssue, documentId?: string): BlockedReason {
  const codeByIssue: Partial<Record<ScenarioParserIssueCode, BlockedReasonCode>> = {
    MISSING_ACCEPTANCE_CRITERIA: 'MISSING_ACCEPTANCE_CRITERIA',
    MISSING_METHOD: 'MISSING_METHOD',
    MISSING_PATH: 'MISSING_PATH',
    INVALID_METHOD: 'MISSING_METHOD',
    MISSING_PROCESSOR: 'MISSING_PROCESSOR',
    MISSING_ASSERTION: 'MISSING_ASSERTION',
    INVALID_ASSERTION: 'MISSING_ASSERTION',
    MISSING_EVIDENCE: 'MISSING_EVIDENCE',
    INVALID_EVIDENCE_KIND: 'MISSING_EVIDENCE',
    INVALID_ACTOR: 'MISSING_ACTOR',
    INVALID_AUTHENTICATION: 'MISSING_AUTHENTICATION',
    MISSING_BLOCKED_REASON: 'INVALID_SCENARIO',
    INVALID_BLOCKED_REASON: 'INVALID_SCENARIO',
  };
  return blockedReason(codeByIssue[issue.code] ?? 'INVALID_SCENARIO', 'PARSER', issue.message, documentId);
}

function parseOperations(rows: Array<Record<string, string>>, issues: ScenarioParserIssue[]): ScenarioOperation[] {
  const ids = new Set<string>();
  return rows.map((row, index) => {
    const declaredId = normalizeCell(row.step);
    const id = declaredId || `STEP-${String(index + 1).padStart(3, '0')}`;
    if (!declaredId) issues.push({ code: 'INVALID_TABLE', severity: 'ERROR', section: 'API Contract', message: `API Contract 第 ${index + 1} 行缺少 Step ID` });
    if (ids.has(id)) issues.push({ code: 'INVALID_TABLE', severity: 'ERROR', section: 'API Contract', message: `API Contract 包含重复 Step ID：${id}` });
    ids.add(id);
    const channelText = normalizeCell(row.channel).toUpperCase();
    const channel = CHANNELS.has(channelText as ScenarioOperationChannel)
      ? channelText as ScenarioOperationChannel : 'API';
    if (!CHANNELS.has(channelText as ScenarioOperationChannel)) {
      issues.push({ code: 'INVALID_CHANNEL', severity: 'ERROR', section: 'API Contract', message: `${id} 的 Channel 无效：${channelText || '<empty>'}` });
    }
    const methodText = normalizeCell(row.method).toUpperCase();
    const method = METHODS.has(methodText as HttpMethod) ? methodText as HttpMethod : undefined;
    const path = isEmptyCell(row.path) ? undefined : normalizeCell(row.path);
    const processor = isEmptyCell(row.processor) ? undefined : normalizeCell(row.processor);
    if (channel === 'API' && !method) {
      issues.push({ code: isEmptyCell(row.method) ? 'MISSING_METHOD' : 'INVALID_METHOD', severity: 'ERROR', section: 'API Contract', message: `${id} 缺少有效 HTTP Method` });
    }
    if (channel !== 'API' && !isEmptyCell(row.method) && !method) {
      issues.push({ code: 'INVALID_METHOD', severity: 'ERROR', section: 'API Contract', message: `${id} 的 HTTP Method 无效：${methodText}` });
    }
    if (channel === 'API' && !path) issues.push({ code: 'MISSING_PATH', severity: 'ERROR', section: 'API Contract', message: `${id} 缺少 API Path` });
    if (!processor) issues.push({ code: 'MISSING_PROCESSOR', severity: 'ERROR', section: 'API Contract', message: `${id} 缺少 Processor` });
    const captureItems = splitList(row.capture);
    const captures = Object.fromEntries(captureItems.map((item) => {
      const [name, ...pathParts] = item.split('=');
      return [name.trim(), pathParts.join('=').trim()];
    }).filter(([name, pathValue]) => Boolean(name && pathValue)));
    if (Object.keys(captures).length !== captureItems.length) {
      issues.push({ code: 'INVALID_TABLE', severity: 'ERROR', section: 'API Contract', message: `${id} 的 Capture 必须使用 name=path 格式` });
    }
    const acceptanceCriteriaIds = splitList(row.ac).map((item) => item.toUpperCase());
    if (!acceptanceCriteriaIds.length) {
      issues.push({ code: 'INVALID_TABLE', severity: 'ERROR', section: 'API Contract', message: `${id} 必须绑定至少一个 AC` });
    }
    if (!splitList(row.evidence).length) {
      issues.push({ code: 'MISSING_EVIDENCE', severity: 'ERROR', section: 'API Contract', message: `${id} 必须绑定至少一个 Evidence ID` });
    }
    const serialized = JSON.stringify([row.request, row.path, row.capture]);
    const dependsOn = [...new Set([...serialized.matchAll(/\b(STEP-[A-Za-z0-9_-]+)/g)].map((match) => match[1]).filter((step) => step !== id))];
    return {
      id,
      channel,
      description: normalizeCell(row.description) || `${method ?? channel} ${path ?? id}`,
      processor,
      method,
      path,
      input: parseLiteral(row.request),
      capture: Object.keys(captures).length ? captures : undefined,
      acceptanceCriteriaIds,
      dependsOn: dependsOn.length ? dependsOn : undefined,
    };
  });
}

function normalizeOperator(value: string): ScenarioAssertionOperator | undefined {
  const normalized = value.toUpperCase().replace(/[\s-]+/g, '_');
  const aliases: Record<string, ScenarioAssertionOperator> = { TYPE: 'TYPE_IS', TRANSITION: 'TRANSITIONED_TO' };
  const operator = aliases[normalized] ?? normalized;
  return OPERATORS.has(operator as ScenarioAssertionOperator) ? operator as ScenarioAssertionOperator : undefined;
}

function parseAssertions(rows: Array<Record<string, string>>, issues: ScenarioParserIssue[]): ScenarioAssertion[] {
  if (!rows.length) issues.push({ code: 'MISSING_ASSERTION', severity: 'ERROR', section: 'Assertions', message: 'Assertions 必须至少包含一条结构化业务断言' });
  const ids = new Set<string>();
  return rows.flatMap((row, index) => {
    const declaredId = normalizeCell(row.id);
    const id = declaredId || `AS-${String(index + 1).padStart(3, '0')}`;
    if (!declaredId) issues.push({ code: 'INVALID_ASSERTION', severity: 'ERROR', section: 'Assertions', message: `Assertions 第 ${index + 1} 行缺少 ID` });
    if (ids.has(id)) issues.push({ code: 'INVALID_ASSERTION', severity: 'ERROR', section: 'Assertions', message: `Assertions 包含重复 ID：${id}` });
    ids.add(id);
    const channelText = normalizeCell(row.channel).toUpperCase();
    const channel = ASSERTION_CHANNELS.has(channelText as ScenarioAssertionChannel) ? channelText as ScenarioAssertionChannel : undefined;
    const operator = normalizeOperator(normalizeCell(row.operator));
    const target = normalizeCell(row.target);
    if (!channel || !operator || !target || !splitList(row.ac).length) {
      issues.push({ code: 'INVALID_ASSERTION', severity: 'ERROR', section: 'Assertions', message: `${id} 缺少有效 AC、Channel、Target 或 Operator` });
      return [];
    }
    return [{
      id,
      channel,
      target,
      operator,
      expected: parseLiteral(row.expected),
      expectedFrom: isEmptyCell(row.expectedfrom) ? undefined : normalizeCell(row.expectedfrom),
      acceptanceCriteriaIds: splitList(row.ac).map((item) => item.toUpperCase()),
      operationId: isEmptyCell(row.step) ? undefined : normalizeCell(row.step),
      evidenceRequirementIds: [],
    } satisfies ScenarioAssertion];
  });
}

function parseEvidence(rows: Array<Record<string, string>>, assertions: ScenarioAssertion[], issues: ScenarioParserIssue[]): EvidenceRequirement[] {
  const ids = new Set<string>();
  const result = rows.flatMap((row, index) => {
    const declaredId = normalizeCell(row.id);
    const id = declaredId || `EV-${String(index + 1).padStart(3, '0')}`;
    if (!declaredId) issues.push({ code: 'MISSING_EVIDENCE', severity: 'ERROR', section: 'Evidence', message: `Evidence 第 ${index + 1} 行缺少 ID` });
    if (ids.has(id)) issues.push({ code: 'MISSING_EVIDENCE', severity: 'ERROR', section: 'Evidence', message: `Evidence 包含重复 ID：${id}` });
    ids.add(id);
    const channelText = normalizeCell(row.channel).toUpperCase();
    const channel = ASSERTION_CHANNELS.has(channelText as ScenarioAssertionChannel) ? channelText as ScenarioAssertionChannel : undefined;
    if (!channel) {
      issues.push({ code: 'MISSING_EVIDENCE', severity: 'ERROR', section: 'Evidence', message: `${id} 缺少有效 Evidence Channel` });
      return [];
    }
    const kindText = normalizeCell(row.kind).toUpperCase();
    if (!isEvidenceKind(kindText)) {
      issues.push({ code: 'INVALID_EVIDENCE_KIND', severity: 'ERROR', section: 'Evidence', message: `${id} 的 Evidence Kind 无效：${kindText || '<empty>'}` });
      return [];
    }
    const kind = kindText;
    const assertionIds = splitList(row.assertions);
    if (!assertionIds.length || isEmptyCell(row.sourcestep)) {
      issues.push({ code: 'MISSING_EVIDENCE', severity: 'ERROR', section: 'Evidence', message: `${id} 必须声明 Source Step 和至少一个 Assertion` });
    }
    return [{
      id,
      channel,
      kind,
      description: normalizeCell(row.description) || `${channel} evidence`,
      requiredForPass: true,
      operationId: isEmptyCell(row.sourcestep) ? undefined : normalizeCell(row.sourcestep),
      sourceRef: isEmptyCell(row.sourcestep) ? undefined : normalizeCell(row.sourcestep),
      assertionIds,
    } satisfies EvidenceRequirement];
  });
  if (!result.length) issues.push({ code: 'MISSING_EVIDENCE', severity: 'ERROR', section: 'Evidence', message: 'Evidence 必须至少包含一个可采集证据源' });
  for (const assertion of assertions) {
    assertion.evidenceRequirementIds = result.filter((evidence) => evidence.assertionIds.includes(assertion.id)).map((evidence) => evidence.id);
  }
  return result;
}

function parseHooks(rows: Array<Record<string, string>>, phase: ScenarioHook['phase'], issues: ScenarioParserIssue[]): ScenarioHook[] {
  const handlers = new Set<string>();
  return rows.filter((row) => !isEmptyCell(row.hook)).map((row, index) => {
    const handler = normalizeCell(row.hook);
    const requiredText = normalizeCell(row.required);
    if (!/^(?:true|false|yes|no|required|optional)$/i.test(requiredText)) {
      issues.push({ code: 'INVALID_TABLE', severity: 'ERROR', section: phase === 'PREPARE' ? 'Prepare' : 'Cleanup', message: `${handler} 的 Required 必须是 true/false/required/optional` });
    }
    if (handlers.has(handler)) {
      issues.push({ code: 'INVALID_TABLE', severity: 'ERROR', section: phase === 'PREPARE' ? 'Prepare' : 'Cleanup', message: `重复 Hook handler：${handler}` });
    }
    handlers.add(handler);
    return {
      id: `${phase}-${String(index + 1).padStart(3, '0')}`,
      phase,
      handler,
      required: /^(?:true|yes|required)$/i.test(requiredText),
      input: undefined,
      produces: splitList(row.produces).length ? splitList(row.produces) : undefined,
    };
  });
}

/**
 * 将严格的 Scenario Markdown 编译成 canonical Scenario。它不会放宽旧 Requirement
 * Parser；只有显式使用本入口的场景资产才应用本 Schema。
 */
export function parseScenarioMarkdown(markdown: string, options: ScenarioMarkdownParserOptions = {}): ScenarioMarkdownParseResult {
  const { title, sections, duplicates } = splitSections(markdown);
  const issues: ScenarioParserIssue[] = [];
  if (title.toLowerCase() !== 'scenario') {
    issues.push({ code: 'INVALID_SCENARIO_DOCUMENT', severity: 'ERROR', line: 1, message: 'Scenario 资产必须以 “# Scenario” 开始' });
  }
  for (const duplicate of duplicates) {
    issues.push({ code: 'INVALID_SECTION', severity: 'ERROR', section: duplicate.name, line: duplicate.line, message: `章节重复：${duplicate.name}` });
  }
  const requiredSections = [
    'Scenario ID', 'Requirement', 'Acceptance Criteria', 'Priority', 'Patterns', 'Actor',
    'Role', 'Tenant', 'Project', 'Authentication', 'Preconditions', 'Test Data',
    'API Contract', 'Execution Steps', 'Expected Response', 'Expected State',
    'Expected Side Effects', 'Assertions', 'Evidence', 'Prepare', 'Cleanup',
    'Execution Mode', 'Blocked Reason', 'Risk', 'Dependencies',
  ];
  for (const name of requiredSections) {
    if (!section(sections, name)) issues.push({ code: 'MISSING_SECTION', severity: 'ERROR', section: name, message: `缺少必需章节：${name}` });
  }
  const nonEmptySections = [
    'Scenario ID', 'Requirement', 'Acceptance Criteria', 'Priority', 'Patterns', 'Actor',
    'Authentication', 'Execution Steps', 'Expected Response', 'Expected State',
    'Expected Side Effects', 'Execution Mode',
  ];
  for (const name of nonEmptySections) {
    const current = section(sections, name);
    if (current && !plainContent(current.content)) {
      issues.push({ code: 'INVALID_SECTION', severity: 'ERROR', section: name, line: current.line, message: `${name} 章节不能为空` });
    }
  }

  const table = (
    name: string,
    requiredHeaders: readonly string[],
    optionalHeaders: readonly string[] = [],
  ): MarkdownTable => {
    const current = section(sections, name);
    return current
      ? validatedTable(current.content, { section: name, requiredHeaders, optionalHeaders }, issues)
      : { headers: [], rows: [] };
  };
  const preconditionTable = table('Preconditions', ['ID', 'Condition', 'Evidence Channel']);
  const testDataTable = table('Test Data', ['ID', 'Owner', 'Value', 'Source']);
  const operationTable = table('API Contract', ['Step', 'Channel', 'Processor', 'Method', 'Path', 'Request', 'Capture', 'AC', 'Evidence']);
  const assertionTable = table('Assertions', ['ID', 'AC', 'Step', 'Channel', 'Target', 'Operator', 'Expected', 'Expected From']);
  const evidenceTable = table('Evidence', ['ID', 'Kind', 'Channel', 'Source Step', 'Assertions', 'Description']);
  const prepareTable = table('Prepare', ['Hook', 'Required', 'Description'], ['Produces']);
  const cleanupTable = table('Cleanup', ['Hook', 'Required', 'Description'], ['Produces']);
  const blockedReasonTable = table('Blocked Reason', ['Code', 'Stage', 'Recoverable', 'Message']);

  const idSection = section(sections, 'Scenario ID');
  const id = idSection ? firstValue(idSection.content) : '';
  if (!id) issues.push({ code: 'MISSING_SCENARIO_ID', severity: 'ERROR', section: 'Scenario ID', message: 'Scenario ID 不能为空' });
  const requirement = plainContent(section(sections, 'Requirement')?.content ?? '');
  const criteria = acceptanceCriteria(section(sections, 'Acceptance Criteria')?.content ?? '');
  if (!criteria.length) issues.push({ code: 'MISSING_ACCEPTANCE_CRITERIA', severity: 'ERROR', section: 'Acceptance Criteria', message: '至少需要一个 AC-xxx 验收条件' });
  if (new Set(criteria.map((item) => item.id)).size !== criteria.length) {
    issues.push({ code: 'MISSING_ACCEPTANCE_CRITERIA', severity: 'ERROR', section: 'Acceptance Criteria', message: 'Acceptance Criteria ID 必须唯一' });
  }

  const priorityText = firstValue(section(sections, 'Priority')?.content ?? '').toUpperCase();
  const priority = /^(P0|P1|P2|P3)$/.test(priorityText) ? priorityText as Scenario['priority'] : 'P0';
  if (!/^(P0|P1|P2|P3)$/.test(priorityText)) issues.push({ code: 'INVALID_PRIORITY', severity: 'ERROR', section: 'Priority', message: `Priority 无效：${priorityText || '<empty>'}` });

  const actorFields = bulletMap(section(sections, 'Actor')?.content ?? '');
  const actorKindText = (actorFields.get('type') ?? firstValue(section(sections, 'Actor')?.content ?? '')).toUpperCase();
  const allowedActors = new Set<ScenarioActorKind>(['USER', 'ADMIN', 'GUEST', 'ANONYMOUS', 'SYSTEM', 'SERVICE', 'PROVIDER', 'UNKNOWN']);
  const actorKind = allowedActors.has(actorKindText as ScenarioActorKind) ? actorKindText as ScenarioActorKind : 'UNKNOWN';
  const actorId = actorFields.get('id') ?? (actorKind === 'ANONYMOUS' ? 'anonymous' : '');
  if (!allowedActors.has(actorKindText as ScenarioActorKind)) {
    issues.push({ code: 'INVALID_ACTOR', severity: 'ERROR', section: 'Actor', message: `Actor Type 无效：${actorKindText || '<empty>'}` });
  }
  if (!actorId) issues.push({ code: 'INVALID_ACTOR', severity: 'ERROR', section: 'Actor', message: 'Actor 必须声明 ID（ANONYMOUS 除外）' });
  const role = firstValue(section(sections, 'Role')?.content ?? '');
  const tenantFields = bulletMap(section(sections, 'Tenant')?.content ?? '');
  const projectFields = bulletMap(section(sections, 'Project')?.content ?? '');
  const authFields = bulletMap(section(sections, 'Authentication')?.content ?? '');
  const authTypeText = (authFields.get('type') ?? firstValue(section(sections, 'Authentication')?.content ?? '')).toUpperCase().replace(/[\s-]+/g, '_');
  const authTypes = new Set<ScenarioAuthenticationType>(['NONE', 'TOKEN', 'SESSION', 'API_KEY', 'BASIC', 'MTLS', 'CUSTOM']);
  const authType = authTypes.has(authTypeText as ScenarioAuthenticationType) ? authTypeText as ScenarioAuthenticationType : 'CUSTOM';
  if (!authTypes.has(authTypeText as ScenarioAuthenticationType)) {
    issues.push({ code: 'INVALID_AUTHENTICATION', severity: 'ERROR', section: 'Authentication', message: `Authentication Type 无效：${authTypeText || '<empty>'}` });
  }
  if (authType !== 'NONE' && isEmptyCell(authFields.get('reference'))) {
    issues.push({ code: 'INVALID_AUTHENTICATION', severity: 'ERROR', section: 'Authentication', message: `${authType} Authentication 必须声明 credential Reference` });
  }

  const preconditionIds = new Set<string>();
  const preconditions: ScenarioPrecondition[] = preconditionTable.rows.map((row, index) => {
    const declaredId = normalizeCell(row.id);
    const id = declaredId || `PRE-${String(index + 1).padStart(3, '0')}`;
    if (!declaredId || isEmptyCell(row.condition) || isEmptyCell(row.evidencechannel)) {
      issues.push({ code: 'INVALID_TABLE', severity: 'ERROR', section: 'Preconditions', message: `Preconditions 第 ${index + 1} 行必须声明 ID、Condition 和 Evidence Channel` });
    }
    if (preconditionIds.has(id)) issues.push({ code: 'INVALID_TABLE', severity: 'ERROR', section: 'Preconditions', message: `Preconditions 包含重复 ID：${id}` });
    preconditionIds.add(id);
    return { id, kind: 'OTHER', description: normalizeCell(row.condition), required: true };
  });
  const testDataIds = new Set<string>();
  const testData: ScenarioTestData[] = testDataTable.rows.map((row, index) => {
    const declaredId = normalizeCell(row.id);
    const id = declaredId || `DATA-${String(index + 1).padStart(3, '0')}`;
    if (!declaredId || isEmptyCell(row.owner) || isEmptyCell(row.value) || isEmptyCell(row.source)) {
      issues.push({ code: 'INVALID_TABLE', severity: 'ERROR', section: 'Test Data', message: `Test Data 第 ${index + 1} 行必须声明 ID、Owner、Value 和 Source` });
    }
    if (testDataIds.has(id)) issues.push({ code: 'INVALID_TABLE', severity: 'ERROR', section: 'Test Data', message: `Test Data 包含重复 ID：${id}` });
    testDataIds.add(id);
    return {
      id,
      source: mapDataSource(normalizeCell(row.source)),
      value: parseLiteral(row.value),
      resourceOwnerId: isEmptyCell(row.owner) ? undefined : normalizeCell(row.owner),
      tenantId: tenantFields.get('id'),
      projectId: projectFields.get('id'),
    };
  });
  const operations = parseOperations(operationTable.rows, issues);
  const assertions = parseAssertions(assertionTable.rows, issues);
  const evidenceRequirements = parseEvidence(evidenceTable.rows, assertions, issues);

  const declaredModeText = firstValue(section(sections, 'Execution Mode')?.content ?? '').toUpperCase().replace(/[\s-]+/g, '_');
  const declaredMode = EXECUTION_MODES.has(declaredModeText as ScenarioExecutionMode) ? declaredModeText as ScenarioExecutionMode : 'BLOCKED';
  if (!EXECUTION_MODES.has(declaredModeText as ScenarioExecutionMode)) issues.push({ code: 'INVALID_EXECUTION_MODE', severity: 'ERROR', section: 'Execution Mode', message: `Execution Mode 无效：${declaredModeText || '<empty>'}` });

  const explicitBlockedCodes = new Set<BlockedReasonCode>();
  const explicitBlockedReasons = blockedReasonTable.rows.flatMap((row): BlockedReason[] => {
    const codeText = normalizeCell(row.code).toUpperCase();
    if (isEmptyCell(codeText)) return [];
    const stageText = normalizeCell(row.stage).toUpperCase();
    const codeValid = isBlockedReasonCode(codeText);
    const stageValid = isBlockedReasonStage(stageText);
    if (!codeValid || !stageValid) {
      issues.push({
        code: 'INVALID_BLOCKED_REASON',
        severity: 'ERROR',
        section: 'Blocked Reason',
        message: `Blocked Reason 无效：code=${codeText || '<empty>'}, stage=${stageText || '<empty>'}`,
      });
      return [];
    }
    const recoverableText = normalizeCell(row.recoverable);
    if (!/^(?:true|false|yes|no)$/i.test(recoverableText) || isEmptyCell(row.message)) {
      issues.push({
        code: 'INVALID_BLOCKED_REASON',
        severity: 'ERROR',
        section: 'Blocked Reason',
        message: `${codeText} 必须声明 boolean Recoverable 和非空 Message`,
      });
      return [];
    }
    // Runtime guards above establish both enums before constructing the typed reason.
    const allowedCode = codeText;
    if (explicitBlockedCodes.has(allowedCode)) {
      issues.push({ code: 'INVALID_BLOCKED_REASON', severity: 'ERROR', section: 'Blocked Reason', message: `Blocked Reason code 重复：${allowedCode}` });
      return [];
    }
    explicitBlockedCodes.add(allowedCode);
    return [{
      code: allowedCode,
      stage: stageText,
      recoverable: /^(?:true|yes)$/i.test(recoverableText),
      message: normalizeCell(row.message),
      details: {},
      source: options.documentId ? { documentId: options.documentId, section: 'Blocked Reason' } : undefined,
    }];
  });
  if (declaredMode === 'BLOCKED' && !explicitBlockedReasons.length) {
    issues.push({ code: 'MISSING_BLOCKED_REASON', severity: 'ERROR', section: 'Blocked Reason', message: 'Execution Mode=BLOCKED 时必须声明结构化 Blocked Reason' });
  }

  const criterionIds = new Set(criteria.map((item) => item.id));
  const operationIds = new Set(operations.map((item) => item.id));
  const assertionIds = new Set(assertions.map((item) => item.id));
  const evidenceIds = new Set(evidenceRequirements.map((item) => item.id));
  for (const operation of operations) {
    const unknownCriteria = operation.acceptanceCriteriaIds.filter((criterionId) => !criterionIds.has(criterionId));
    if (unknownCriteria.length) issues.push({ code: 'INVALID_TABLE', severity: 'ERROR', section: 'API Contract', message: `${operation.id} 引用了未知 AC：${unknownCriteria.join(', ')}` });
  }
  operationTable.rows.forEach((row, index) => {
    const operationId = operations[index]?.id ?? (normalizeCell(row.step) || `row-${index + 1}`);
    const unknownEvidence = splitList(row.evidence).filter((evidenceId) => !evidenceIds.has(evidenceId));
    if (unknownEvidence.length) issues.push({ code: 'MISSING_EVIDENCE', severity: 'ERROR', section: 'API Contract', message: `${operationId} 引用了未知 Evidence：${unknownEvidence.join(', ')}` });
  });
  for (const assertion of assertions) {
    const unknownCriteria = assertion.acceptanceCriteriaIds.filter((criterionId) => !criterionIds.has(criterionId));
    if (unknownCriteria.length) issues.push({ code: 'INVALID_ASSERTION', severity: 'ERROR', section: 'Assertions', message: `${assertion.id} 引用了未知 AC：${unknownCriteria.join(', ')}` });
    if (assertion.operationId && !operationIds.has(assertion.operationId)) {
      issues.push({ code: 'INVALID_ASSERTION', severity: 'ERROR', section: 'Assertions', message: `${assertion.id} 引用了未知 Step：${assertion.operationId}` });
    }
    if (!assertion.evidenceRequirementIds.length) {
      issues.push({ code: 'MISSING_EVIDENCE', severity: 'ERROR', section: 'Assertions', message: `${assertion.id} 未绑定任何 Evidence Requirement` });
    }
  }
  for (const evidence of evidenceRequirements) {
    const unknownAssertions = evidence.assertionIds.filter((assertionId) => !assertionIds.has(assertionId));
    if (unknownAssertions.length) issues.push({ code: 'MISSING_EVIDENCE', severity: 'ERROR', section: 'Evidence', message: `${evidence.id} 引用了未知 Assertion：${unknownAssertions.join(', ')}` });
  }

  const patternIds = bullets(section(sections, 'Patterns')?.content ?? '').map((item) => item.toUpperCase().replace(/[\s-]+/g, '_'));
  if (!patternIds.length) issues.push({ code: 'INVALID_SECTION', severity: 'ERROR', section: 'Patterns', message: 'Patterns 必须至少声明一个 Test Pattern' });
  const prepare = parseHooks(prepareTable.rows, 'PREPARE', issues);
  const cleanup = parseHooks(cleanupTable.rows, 'CLEANUP', issues);

  const parserBlockedReasons = issues.filter((issue) => issue.severity === 'ERROR').map((issue) => parserReason(issue, options.documentId));
  const allBlockedReasons = [...explicitBlockedReasons, ...parserBlockedReasons];
  const errors = issues.some((issue) => issue.severity === 'ERROR');
  const intent = bulletMap(section(sections, 'Requirement')?.content ?? '').get('intent');
  const riskBullets = bullets(section(sections, 'Risk')?.content ?? '');
  const risks: ScenarioRisk[] = riskBullets.map((description, index) => ({
    id: `RISK-${String(index + 1).padStart(3, '0')}`,
    level: priority === 'P0' ? 'HIGH' : priority === 'P1' ? 'MEDIUM' : 'LOW',
    category: 'SCENARIO',
    description,
  }));

  const scenario: Scenario = {
    schemaVersion: '1.0',
    id: id || 'INVALID-SCENARIO',
    title: intent || id || 'Invalid Scenario',
    domain: options.domain,
    requirement,
    sources: options.documentId ? [{ documentId: options.documentId, section: 'Scenario' }] : [],
    acceptanceCriteriaIds: criteria.map((item) => item.id),
    patternIds,
    actor: actorId ? {
      id: actorId,
      kind: actorKind,
      role: isEmptyCell(role) ? undefined : role,
      tenantId: tenantFields.get('id'),
      projectId: projectFields.get('id'),
      credentialRef: authFields.get('reference'),
      provenance: 'EXPLICIT',
    } : undefined,
    role: isEmptyCell(role) ? undefined : role,
    scope: {
      tenantId: tenantFields.get('id'),
      projectId: projectFields.get('id'),
      resourceOwnerId: testData.find((item) => item.resourceOwnerId)?.resourceOwnerId,
    },
    authentication: {
      type: authType,
      required: authType !== 'NONE',
      credentialRef: authFields.get('reference'),
    },
    preconditions,
    testData,
    operations,
    assertions,
    evidenceRequirements,
    prepare,
    cleanup,
    executionMode: errors ? 'BLOCKED' : declaredMode,
    blockedReasons: allBlockedReasons,
    risks,
    priority,
    dependencies: bullets(section(sections, 'Dependencies')?.content ?? ''),
    metadata: {
      declaredExecutionMode: declaredMode,
      acceptanceCriteria: criteria,
      executionSteps: plainContent(section(sections, 'Execution Steps')?.content ?? ''),
      expectedResponse: bullets(section(sections, 'Expected Response')?.content ?? ''),
      expectedState: bullets(section(sections, 'Expected State')?.content ?? ''),
      expectedSideEffects: bullets(section(sections, 'Expected Side Effects')?.content ?? ''),
      parserIssueCount: issues.length,
    },
  };
  return { scenario, issues, valid: !errors };
}
