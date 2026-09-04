import { createHash } from 'node:crypto';
import type {
  AcceptanceCriterion,
  ActorSpec,
  ApiSpec,
  BusinessRule,
  IsolationRule,
  PageSpec,
  PermissionSpec,
  RequirementEpistemicType,
  RequirementFact,
  RequirementFactCategory,
  RequirementFactEntityRef,
  RequirementFactEntityRefs,
  RequirementFactProvenance,
  RequirementFactStatus,
  RequirementNormativity,
  RequirementParseWarning,
  RequirementSource,
  RequirementSourceSpan,
  StateRule,
} from './requirement-ir.js';
import { hasAccessControlSemantics } from './requirement-semantics.js';
import { normalizeRequirementFact } from './canonical-requirement.js';

export interface RequirementFactLedgerLine {
  number: number;
  text: string;
  section?: string;
}

export interface RequirementFactLedgerInput {
  lines: RequirementFactLedgerLine[];
  documentId?: string;
  actors: ActorSpec[];
  pages: PageSpec[];
  apis: ApiSpec[];
  permissions: PermissionSpec[];
  isolationRules: IsolationRule[];
  stateRules: StateRule[];
  acceptanceCriteria: AcceptanceCriterion[];
  businessRules: BusinessRule[];
  warnings: RequirementParseWarning[];
}

type StatementKind = 'HEADING' | 'TABLE_HEADER' | 'TABLE_ROW' | 'PROSE';

interface FactDraft {
  source: RequirementSourceSpan;
  category: RequirementFactCategory;
  statement: string;
  epistemicType: RequirementEpistemicType;
  provenance: RequirementFactProvenance;
  normativity: RequirementNormativity;
  status?: RequirementFactStatus;
  confidence?: number;
  entityRefs?: RequirementFactEntityRef[];
  reason?: string;
}

const NORMATIVE_SECTION = /(?:acceptance\s*criteria|验收(?:标准|条件)|业务规则|business\s*rules?|权限|permission|数据隔离|isolation|状态|state|接口|\bapi\b|endpoint|参数|parameter|request\s*(?:body|header)|请求(?:体|头)|响应|response|错误|error|边界|boundary|安全|security|清理|cleanup)/i;
const CONTRACT_SECTION = /(?:接口|\bapi\b|endpoint|参数|parameter|request\s*(?:body|header)|请求(?:体|头)|响应|response|actor|role|tenant|身份|角色|租户)/i;
const NORMATIVE_MODAL = /(?:必须|需要|只能|不得|禁止|允许|应当|应该|需(?:要)?|不可|不能|支持|确保|要求|must|shall|required|may\s+only|must\s+not|cannot|can\s+only|is\s+required\s+to)/i;
const NORMATIVE_BEHAVIOR = /(?:返回|显示|创建|更新|修改|删除|查询|查看|访问|提交|保存|进入|刷新|发送|通知|扣减|扣除|回滚|拒绝|校验|验证|转换|转为|变为|失败|成功|returns?|responds?|display|show|create|update|delete|query|read|access|submit|save|refresh|send|notify|deduct|rollback|reject|validate|transition)/i;
const CONDITIONAL_BEHAVIOR = /(?:当.+时|如果.+则|一旦|之后|以后|成功后|失败时|when\b|if\b.+\bthen\b|after\b|before\b)/i;
/** 测试装配/执行元数据只作为上下文消费，不得独立扩增业务 Case 或需求歧义。 */
const SUPPORTING_ONLY_SECTION = /^(?:scenario\s*id|priority|patterns?|actor|role|tenant|project|authentication|preconditions?|test\s*data|execution\s*steps?|assertions?|evidence|prepare|cleanup|final\s*rule|blocked\s*reasons?|mutation\s*policy|execution(?:\s*mode)?|risks?|dependencies?|场景编号|优先级|模式|角色|租户|项目|认证|鉴权配置|前置条件|测试数据|执行步骤|断言|证据|准备|清理|最终规则|阻断原因|变更策略|执行模式|风险|依赖)$/i;

function normalizedText(value: string): string {
  return value
    .trim()
    .replace(/^#{1,6}\s+/, '')
    .replace(/^>\s*/, '')
    .replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, '')
    .replace(/^`([^`]*)`$/, '$1')
    .trim();
}

function normalizedIdentity(value: string): string {
  return normalizedText(value).replace(/\s+/g, ' ').toLowerCase();
}

function sourceSpan(source: RequirementSource | undefined, fallback: string, documentId?: string): RequirementSourceSpan {
  const lineStart = source?.lineStart ?? source?.line ?? 1;
  const lineEnd = source?.lineEnd ?? source?.line ?? lineStart;
  const text = source?.text ?? source?.content ?? fallback;
  return {
    documentId: source?.documentId ?? documentId,
    section: source?.section,
    line: source?.line ?? lineStart,
    lineStart,
    lineEnd,
    content: source?.content ?? text,
    text,
  };
}

function sourceKey(source: RequirementSource | undefined, documentId?: string): string {
  return `${source?.documentId ?? documentId ?? ''}:${source?.lineStart ?? source?.line ?? 1}:${source?.lineEnd ?? source?.line ?? source?.lineStart ?? 1}`;
}

function factId(draft: FactDraft): string {
  const refs = (draft.entityRefs ?? []).map((ref) => `${ref.type}:${ref.id}:${ref.field ?? ''}`).sort().join('|');
  const identity = [
    draft.source.documentId ?? '', draft.source.section ?? '', draft.source.lineStart, draft.source.lineEnd,
    draft.category, normalizedIdentity(draft.statement), refs,
  ].join('\u001f');
  return `FACT-${createHash('sha256').update(identity).digest('hex').slice(0, 16).toUpperCase()}`;
}

function classifyEpistemicType(statement: string): RequirementEpistemicType {
  if (/(?:建议|推荐|最好|倾向于|认为|意见|偏好|recommend|opinion|prefer|ideally)/i.test(statement)) return 'OPINION';
  if (/(?:假设|假定|可能|也许|或许|预计|猜测|hypothesis|assum(?:e|ption)|maybe|might|possibly)/i.test(statement)) return 'HYPOTHESIS';
  if (/(?:因此|所以|由此可见|推断|意味着|据此|therefore|thus|implies?|infer(?:red|ence)?)/i.test(statement)) return 'INFERENCE';
  return 'FACT';
}

export function classifyRequirementFactCategory(statement: string, _section?: string): RequirementFactCategory {
  // Category follows the statement itself. Markdown's current section can be
  // a feature name (for example "Cleanup") and must not relabel every child
  // API/Auth/Response fact. Structured tables are projected separately.
  const text = statement;
  if (/(?:清理|清除测试数据|回收测试数据|teardown|clean\s*up|cleanup)/i.test(text)) return 'CLEANUP';
  // Parameter names such as `page` are not UI evidence. Prefer the explicit
  // validation meaning when the sentence describes a field/parameter contract.
  if (/(?:参数|字段|必填|可空|为空|不能为空|长度|范围|格式|类型|枚举|整数|字符串|正则|required|nullable|length|range|format|pattern|enum|integer|string)/i.test(text)) return 'VALIDATION';
  if (/(?:页面|按钮|输入框|弹窗|提示|loading|加载中|点击|列表刷新|刷新列表|跳转|展示|显示|page|button|modal|toast|spinner|click|render)/i.test(text)) return 'UI';
  if (/(?:跨租户|跨项目|跨组织|跨\s*workspace|自己的|本人|当前用户|其他用户.*数据|属于当前用户|tenant|workspace|organi[sz]ation|data\s+isolation|own\s+(?:order|record|resource))/i.test(text)) return 'DATA_ISOLATION';
  if (/(?:未登录|认证|鉴权|登录态|token|jwt|cookie|api\s*key|anonymous|unauthenticated|authentication)/i.test(text)) return 'AUTH';
  if (/(?:权限|角色|管理员|普通用户|访客|无权限|无权|没有权利|不允许|越权|forbidden|permission|role|admin|rbac)/i.test(text)
    || hasAccessControlSemantics(text)) return 'PERMISSION';
  if (/(?:状态.{0,24}(?:从|变为|转为|转换|流转)|从\s*\S+\s*(?:变为|转为|到)|state\s+(?:change|transition)|transition\s+from|\b(?:PAID|PENDING|SHIPPED|CANCELLED|COMPLETED)\b)/i.test(text)) return 'STATE';
  if (/(?:响应时间|延迟|吞吐|每秒|并发量|性能|p9[059]|latency|throughput|requests?\s+per\s+second|response\s+time)/i.test(text)) return 'PERFORMANCE';
  if (/(?:注入|敏感信息|加密|脱敏|漏洞|攻击|xss|csrf|sql\s*injection|security|secret|sensitive)/i.test(text)) return 'SECURITY';
  if (/(?:兼容|旧版本|旧数据|不同浏览器|向后兼容|backward\s+compat|legacy\s+data|browser\s+compat)/i.test(text)) return 'COMPATIBILITY';
  if (/(?:边界|临界|最小值|最大值|极值|min(?:imum)?|max(?:imum)?|lower\s+bound|upper\s+bound)/i.test(text)) return 'BOUNDARY';
  if (/(?:错误|异常|失败|拒绝|不存在|未找到|冲突|超时|限流|非法|缺失|4\d{2}|5\d{2}|error|exception|fail|reject|not\s+found|conflict|timeout|invalid|missing)/i.test(text)) return 'ERROR';
  if (/(?:原子|唯一|幂等|顺序|一致性|金额|库存|回滚|重复提交|不得创建第二|atomic|unique|idempoten|ordering|consisten|inventory|rollback)/i.test(text)) return 'BUSINESS_RULE';
  if (/(?:发送(?:短信|邮件|消息|通知)|通知|短信|邮件|webhook|扣费|扣款|计费|扣除积分|审计记录|外部副作用|send\s+(?:email|sms|message)|notify|billing|charge|payment|audit\s+(?:record|log)|external\s+side\s+effect)/i.test(text)) return 'SIDE_EFFECT';
  if (/\b(?:GET|HEAD|POST|PUT|PATCH|DELETE)\s+\//i.test(text)
    || /(?:接口|\bapi\b|endpoint|响应|response|状态码|http\s+status|返回\s*[1-5]\d{2})/i.test(text)) return 'API';
  if (NORMATIVE_BEHAVIOR.test(statement)) return 'FUNCTIONAL';
  return 'OTHER';
}

function classifyNormativity(
  statement: string,
  section: string | undefined,
  kind: StatementKind,
  epistemicType: RequirementEpistemicType,
): RequirementNormativity {
  if (kind === 'HEADING' || kind === 'TABLE_HEADER') return 'NON_NORMATIVE';
  if (epistemicType === 'OPINION' || epistemicType === 'HYPOTHESIS') return 'NON_NORMATIVE';
  if (SUPPORTING_ONLY_SECTION.test((section ?? '').trim())) return 'NON_NORMATIVE';
  if (kind === 'TABLE_ROW') return 'NORMATIVE';
  if (/\bAC-\d+\b/i.test(statement)) return 'NORMATIVE';
  if (/\b(?:GET|HEAD|POST|PUT|PATCH|DELETE)\s+\//i.test(statement)) return 'NORMATIVE';
  if (/(?:返回\s*[1-5]\d{2}|[1-5]\d{2}\s*(?:状态码|响应)|returns?\s+[1-5]\d{2})/i.test(statement)) return 'NORMATIVE';
  if (NORMATIVE_SECTION.test(section ?? '')) return 'NORMATIVE';
  if (NORMATIVE_MODAL.test(statement) || CONDITIONAL_BEHAVIOR.test(statement)) return 'NORMATIVE';
  // 对高信号领域语句采取 fail-close：即使没有“必须”，也不能把
  // “订单属于当前用户 / 库存与订单保持一致”降成背景说明。
  if (['VALIDATION', 'AUTH', 'PERMISSION', 'DATA_ISOLATION', 'BUSINESS_RULE', 'STATE', 'ERROR',
    'BOUNDARY', 'PERFORMANCE', 'SECURITY', 'COMPATIBILITY', 'SIDE_EFFECT', 'CLEANUP']
    .includes(classifyRequirementFactCategory(statement, section))) return 'NORMATIVE';
  // “用户提交订单后创建订单”一类行为句没有情态词，但仍是可观察的规范性行为。
  if (NORMATIVE_BEHAVIOR.test(statement) && /(?:用户|系统|接口|页面|服务|订单|资源|请求|响应|user|system|api|page|service|order|request|response)/i.test(statement)) {
    return 'NORMATIVE';
  }
  return 'NON_NORMATIVE';
}

function classifyProvenance(statement: string, _section: string | undefined, kind: StatementKind): RequirementFactProvenance {
  // Structured tables and explicit Operation declarations are contract facts.
  // Free prose remains EXPLICIT even when it follows an Actors/API table: a
  // lingering Markdown section must not relabel a business rule as configuration.
  if (/\b(?:GET|HEAD|POST|PUT|PATCH|DELETE)\s+\//i.test(statement) || kind === 'TABLE_ROW') {
    return 'CONTRACT';
  }
  return 'EXPLICIT';
}

function statementKind(lines: RequirementFactLedgerLine[], index: number): StatementKind | null {
  const text = lines[index].text.trim();
  if (!text || /^```/.test(text) || /^<!--|-->$/.test(text)) return null;
  if (/^#{1,6}\s+/.test(text)) return 'HEADING';
  if (/^\|?\s*:?-{3,}/.test(text)) return null;
  if (/^\s*\|/.test(text)) {
    const next = lines[index + 1]?.text.trim() ?? '';
    return /^\|?\s*:?-{3,}/.test(next) ? 'TABLE_HEADER' : 'TABLE_ROW';
  }
  return 'PROSE';
}

function warningReasonBySource(input: RequirementFactLedgerInput): Map<string, string> {
  const conflicts = new Map<string, string>();
  for (const warning of input.warnings) {
    if (warning.code !== 'REQUIREMENT_CONFLICT' || !warning.source) continue;
    const key = sourceKey(warning.source, input.documentId);
    conflicts.set(key, [conflicts.get(key), warning.message].filter(Boolean).join('；'));
  }
  return conflicts;
}

function parameterRef(api: ApiSpec, location: string, name: string): RequirementFactEntityRef {
  return {
    type: 'PARAMETER',
    id: `${api.id}:${location.toUpperCase()}:${name.toLowerCase()}`,
    apiSpecId: api.id,
    operationKey: api.operationKey,
    field: name,
  };
}

function entityRefs(refs: RequirementFactEntityRef[]): RequirementFactEntityRefs {
  return {
    items: refs,
    apiSpecIds: [...new Set(refs.flatMap((ref) => ref.apiSpecId ? [ref.apiSpecId] : ref.type === 'API' ? [ref.id] : []))],
    parameterNames: [...new Set(refs.filter((ref) => ref.type === 'PARAMETER').map((ref) => ref.field).filter((field): field is string => Boolean(field)))],
  };
}

function statementFromSource(source: RequirementSource | undefined, fallback: string): string {
  return normalizedText(source?.text ?? source?.content ?? fallback) || fallback;
}

function explicitApiRefs(statement: string, apis: ApiSpec[]): RequirementFactEntityRef[] {
  const operation = statement.match(/\b(GET|HEAD|POST|PUT|PATCH|DELETE)\s+(\/[^\s|`，。,;；]+)/i);
  if (!operation) return [];
  const operationKey = `${operation[1].toUpperCase()} ${operation[2].replace(/[，。,;；.]+$/, '')}`;
  const api = apis.find((candidate) => candidate.operationKey === operationKey);
  return api ? [{ type: 'API', id: api.id, apiSpecId: api.id, operationKey: api.operationKey }] : [];
}

/** AC/Prose 中显式出现的参数名在 Fact 阶段绑定；Generator 不再扫描文本猜参数。 */
function explicitParameterRefs(statement: string, apis: ApiSpec[], apiRefs: RequirementFactEntityRef[]): RequirementFactEntityRef[] {
  const candidates = apiRefs.length === 1
    ? apis.filter((api) => api.id === apiRefs[0].apiSpecId)
    : apis.length === 1 ? apis : [];
  if (candidates.length !== 1) return [];
  const api = candidates[0];
  return [...api.headers, ...api.query, ...api.pathParams, ...api.body]
    .filter((parameter) => {
      const escaped = parameter.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(?:^|[^A-Za-z0-9_-])${escaped}(?:$|[^A-Za-z0-9_-])`, 'i').test(statement);
    })
    .map((parameter) => parameterRef(api, parameter.location, parameter.name));
}

/**
 * 建立 Parser 阶段的完整 Requirement Fact Ledger。
 * Parser 不得提前宣称消费完成：所有规范性事实默认 UNVERIFIED，只有来源冲突为 BLOCKED。
 */
export function buildRequirementFactLedger(input: RequirementFactLedgerInput): RequirementFact[] {
  const conflicts = warningReasonBySource(input);
  const facts: RequirementFact[] = [];
  const dedupe = new Map<string, RequirementFact>();
  const representedLineCategories = new Set<string>();
  const representedStructuredLines = new Set<string>();
  const acceptanceCriterionLines = new Set(input.acceptanceCriteria.map((criterion) => (
    sourceKey(sourceSpan(criterion.source, criterion.objective, input.documentId), input.documentId)
  )));

  const add = (draft: FactDraft, structured = false): RequirementFact => {
    const conflictReason = conflicts.get(sourceKey(draft.source, input.documentId));
    const status: RequirementFactStatus = draft.status
      ?? (draft.normativity === 'NON_NORMATIVE' ? 'NON_NORMATIVE' : conflictReason ? 'BLOCKED' : 'UNVERIFIED');
    const reason = draft.reason
      ?? (status === 'BLOCKED' ? conflictReason : status === 'UNVERIFIED' ? 'PARSER_FACT_NOT_YET_CONSUMED' : undefined);
    const refs = [...(draft.entityRefs ?? [])]
      .filter((ref, index, all) => all.findIndex((candidate) => candidate.type === ref.type && candidate.id === ref.id && candidate.field === ref.field) === index);
    const semanticKey = [
      sourceKey(draft.source, input.documentId), draft.category, normalizedIdentity(draft.statement),
      refs.map((ref) => `${ref.type}:${ref.id}:${ref.field ?? ''}`).sort().join('|'),
    ].join('\u001f');
    const existing = dedupe.get(semanticKey);
    if (existing) {
      const merged = [...existing.entityRefs.items, ...refs]
        .filter((ref, index, all) => all.findIndex((candidate) => candidate.type === ref.type && candidate.id === ref.id && candidate.field === ref.field) === index);
      existing.entityRefs = entityRefs(merged);
      existing.canonical = normalizeRequirementFact({
        statement: existing.statement,
        category: existing.category,
        entityRefs: merged,
        actors: input.actors,
        apis: input.apis,
        permissions: input.permissions,
        isolationRules: input.isolationRules,
        stateRules: input.stateRules,
        businessRules: input.businessRules,
      });
      if (status === 'BLOCKED') {
        existing.status = 'BLOCKED';
        existing.statusReason = reason;
      }
      return existing;
    }
    const fact: RequirementFact = {
      id: factId({ ...draft, entityRefs: refs }),
      source: draft.source,
      category: draft.category,
      statement: draft.statement,
      epistemicType: draft.epistemicType,
      provenance: draft.provenance,
      normativity: draft.normativity,
      status,
      confidence: draft.confidence,
      entityRefs: entityRefs(refs),
      canonical: normalizeRequirementFact({
        statement: draft.statement,
        category: draft.category,
        entityRefs: refs,
        actors: input.actors,
        apis: input.apis,
        permissions: input.permissions,
        isolationRules: input.isolationRules,
        stateRules: input.stateRules,
        businessRules: input.businessRules,
      }),
      linkedObjectiveIds: [],
      statusReason: reason,
    };
    facts.push(fact);
    dedupe.set(semanticKey, fact);
    if (structured) {
      representedLineCategories.add(`${sourceKey(draft.source, input.documentId)}:${draft.category}`);
      representedStructuredLines.add(sourceKey(draft.source, input.documentId));
    }
    return fact;
  };

  const structured = (
    source: RequirementSource | undefined,
    fallback: string,
    category: RequirementFactCategory,
    provenance: RequirementFactProvenance,
    refs: RequirementFactEntityRef[],
    epistemicType: RequirementEpistemicType = 'FACT',
    statement = statementFromSource(source, fallback),
  ): void => {
    add({
      source: sourceSpan(source, fallback, input.documentId),
      category,
      statement,
      epistemicType,
      provenance,
      normativity: 'NORMATIVE',
      confidence: provenance === 'INFERRED' ? 0.8 : 1,
      entityRefs: refs,
    }, true);
  };

  for (const actor of input.actors) {
    structured(actor.source, `${actor.id} role=${actor.role}`, 'AUTH', 'CONFIGURED', [{ type: 'ACTOR', id: actor.id }]);
  }
  for (const page of input.pages) {
    structured(page.source, page.path, 'UI', 'EXPLICIT', [{ type: 'PAGE', id: page.id, field: page.path }]);
  }
  for (const api of input.apis) {
    structured(api.source, api.operationKey, 'API', 'CONTRACT', [{ type: 'API', id: api.id, apiSpecId: api.id, operationKey: api.operationKey }], 'FACT', api.operationKey);
    const parameters = [...api.headers, ...api.query, ...api.pathParams, ...api.body];
    for (const parameter of parameters) {
      const inferred = /URL Path 模板推导/i.test(parameter.description ?? '');
      const constraints = [
        `type=${parameter.type}`, `required=${parameter.required}`, `nullable=${parameter.nullable}`,
        parameter.min !== undefined ? `min=${parameter.min}` : '',
        parameter.max !== undefined ? `max=${parameter.max}` : '',
        parameter.minLength !== undefined ? `minLength=${parameter.minLength}` : '',
        parameter.maxLength !== undefined ? `maxLength=${parameter.maxLength}` : '',
        parameter.pattern ? `pattern=${parameter.pattern}` : '',
        parameter.enum?.length ? `enum=${JSON.stringify(parameter.enum)}` : '',
      ].filter(Boolean).join(' ');
      structured(
        parameter.source,
        `${api.operationKey} ${parameter.location} ${parameter.name} ${constraints}`,
        'VALIDATION',
        inferred ? 'INFERRED' : 'CONTRACT',
        [parameterRef(api, parameter.location, parameter.name)],
        inferred ? 'INFERENCE' : 'FACT',
        `${api.operationKey} ${parameter.location} 参数 ${parameter.name}：${constraints}`,
      );
    }
    for (const response of api.responses) {
      structured(
        response.source,
        `${api.operationKey} 返回 ${response.status}`,
        response.status >= 400 ? 'ERROR' : 'API',
        'CONTRACT',
        [{ type: 'RESPONSE', id: `${api.id}:RESPONSE:${response.status}`, apiSpecId: api.id, operationKey: api.operationKey, field: String(response.status) }],
        'FACT',
        `${api.operationKey} 返回 ${response.status}${response.description ? `：${response.description}` : ''}`,
      );
    }
  }
  for (const criterion of input.acceptanceCriteria) {
    const apiRefs = explicitApiRefs(criterion.objective, input.apis);
    structured(
      criterion.source,
      criterion.objective,
      classifyRequirementFactCategory(criterion.objective, criterion.source.section),
      'EXPLICIT',
      [{ type: 'ACCEPTANCE_CRITERION', id: criterion.criterionId }, ...apiRefs,
        ...explicitParameterRefs(criterion.objective, input.apis, apiRefs)],
      'FACT',
      criterion.objective,
    );
  }
  for (const permission of input.permissions) {
    structured(permission.source, permission.action, 'PERMISSION', 'EXPLICIT', [{ type: 'PERMISSION', id: permission.id }]);
  }
  for (const isolation of input.isolationRules) {
    structured(isolation.source, `${isolation.dimension} ${isolation.expected}`, 'DATA_ISOLATION', 'EXPLICIT', [{ type: 'ISOLATION_RULE', id: isolation.id }]);
  }
  for (const rule of input.businessRules) {
    structured(rule.source, rule.description, 'BUSINESS_RULE', 'EXPLICIT', [{ type: 'BUSINESS_RULE', id: rule.id }], 'FACT', rule.description);
  }
  for (const rule of input.stateRules) {
    structured(rule.source, rule.action, 'STATE', 'EXPLICIT', [{ type: 'STATE_RULE', id: rule.id }]);
  }

  // Inventory 在结构化投影之后补齐：同一来源/分类已经有实体 Fact 时不重复，
  // 但同一行包含另一类规范性语义（例如 API AC 同时声明原子性）仍会保留。
  for (let index = 0; index < input.lines.length; index++) {
    const line = input.lines[index];
    const kind = statementKind(input.lines, index);
    if (!kind) continue;
    const statement = normalizedText(line.text);
    if (!statement) continue;
    const epistemicType = classifyEpistemicType(statement);
    const normativity = classifyNormativity(statement, line.section, kind, epistemicType);
    const category = classifyRequirementFactCategory(statement, line.section);
    const source = sourceSpan({
      documentId: input.documentId,
      section: line.section,
      line: line.number,
      lineStart: line.number,
      lineEnd: line.number,
      content: line.text.trim(),
      text: line.text.trim(),
    }, line.text.trim(), input.documentId);
    const sourceIdentity = sourceKey(source, input.documentId);
    if ((kind === 'TABLE_ROW' || acceptanceCriterionLines.has(sourceIdentity))
      && representedStructuredLines.has(sourceIdentity)) continue;
    if (representedLineCategories.has(`${sourceKey(source, input.documentId)}:${category}`)) continue;
    add({
      source,
      category,
      statement,
      epistemicType,
      provenance: classifyProvenance(statement, line.section, kind),
      normativity,
      confidence: normativity === 'NORMATIVE' ? 0.9 : 1,
      entityRefs: [],
    });
  }

  return facts.sort((a, b) => a.source.lineStart - b.source.lineStart || a.id.localeCompare(b.id));
}
