import type {
  ActorSpec,
  ApiSpec,
  BusinessRule,
  CanonicalAction,
  CanonicalActor,
  CanonicalCondition,
  CanonicalConstraint,
  CanonicalExpectedOutcome,
  CanonicalRequirementFact,
  CanonicalResource,
  CanonicalScope,
  CanonicalSideEffect,
  IsolationRule,
  ParameterSpec,
  PermissionSpec,
  RequirementFactCategory,
  RequirementFactEntityRef,
  ResponseSpec,
  StateRule,
} from './requirement-ir.js';
import { accessPolarity, hasAccessControlSemantics } from './requirement-semantics.js';

export interface RequirementNormalizationContext {
  statement: string;
  category: RequirementFactCategory;
  entityRefs: RequirementFactEntityRef[];
  actors: ActorSpec[];
  apis: ApiSpec[];
  permissions: PermissionSpec[];
  isolationRules: IsolationRule[];
  stateRules: StateRule[];
  businessRules: BusinessRule[];
}

const ACTION_PATTERNS: ReadonlyArray<[CanonicalAction['kind'], RegExp]> = [
  ['DELETE', /(?:删除|移除|delete|remove)/i],
  ['UPDATE', /(?:修改|编辑|更新|保存|update|edit|modify|save)/i],
  ['CREATE', /(?:创建|新增|添加|create|add)/i],
  ['READ', /(?:访问|查看|查询|读取|获取|access|view|query|read|fetch|get)/i],
  ['SUBMIT', /(?:提交|submit)/i],
  ['TRANSITION', /(?:流转|转换|转为|变为|transition)/i],
  ['VALIDATE', /(?:校验|验证|validate)/i],
  ['DISPLAY', /(?:显示|展示|刷新|跳转|display|show|render|refresh)/i],
  ['NOTIFY', /(?:通知|发送.*(?:邮件|短信|消息)|notify|send\s+(?:email|sms|message))/i],
  ['CHARGE', /(?:扣费|扣款|计费|收费|charge|bill|payment)/i],
  ['ROLLBACK', /(?:回滚|rollback|roll\s+back)/i],
  ['CLEANUP', /(?:清理|清除|cleanup|clean\s+up|teardown)/i],
];

const RESOURCE_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ['TASK', /(?:任务|tasks?)/i],
  ['USER_PROFILE', /(?:用户资料|个人资料|profile)/i],
  ['ORDER', /(?:订单|orders?)/i],
  ['INVENTORY', /(?:库存|inventory|stock)/i],
  ['WORKSPACE', /(?:工作区|workspace)/i],
  ['PROJECT', /(?:项目|projects?)/i],
  ['ORGANIZATION', /(?:组织|organi[sz]ations?)/i],
  ['TENANT_DATA', /(?:租户数据|tenant\s+data)/i],
  ['USER_DATA', /(?:用户数据|user\s+data)/i],
  ['ACCOUNT', /(?:账户|账号|accounts?)/i],
  ['DATABASE', /(?:数据库|数据表|\bdb\b|database|\bsql\b)/i],
  ['RESOURCE', /(?:资源|resources?)/i],
  ['RECORD', /(?:记录|records?)/i],
  ['DATA', /(?:数据|data)/i],
  ['PAGE', /(?:页面|page)/i],
];

function methodAction(method: ApiSpec['method']): CanonicalAction['kind'] {
  if (method === 'POST') return 'CREATE';
  if (method === 'PUT' || method === 'PATCH') return 'UPDATE';
  if (method === 'DELETE') return 'DELETE';
  return 'READ';
}

function actorKind(role: string | undefined): CanonicalActor['kind'] {
  const value = role?.toUpperCase();
  if (value === 'ADMIN' || value === 'ADMINISTRATOR') return 'ADMIN';
  if (value === 'GUEST') return 'GUEST';
  if (value === 'SYSTEM') return 'SYSTEM';
  if (value === 'SERVICE') return 'SERVICE';
  if (value === 'ANONYMOUS') return 'ANONYMOUS';
  if (value && value !== 'UNSPECIFIED') return 'USER';
  return 'UNKNOWN';
}

function configuredActor(actor: ActorSpec): CanonicalActor {
  return { id: actor.id, role: actor.role, kind: actorKind(actor.role), source: 'CONFIGURED' };
}

function explicitRole(statement: string): CanonicalActor | undefined {
  if (/(?:管理员|administrator|\badmin\b)/i.test(statement)) {
    return { role: 'ADMIN', kind: 'ADMIN', source: 'EXPLICIT' };
  }
  if (/(?:普通用户|standard\s+user|normal\s+user)/i.test(statement)) {
    return { role: 'USER', kind: 'USER', source: 'EXPLICIT' };
  }
  if (/(?:访客|\bguest\b)/i.test(statement)) {
    return { role: 'GUEST', kind: 'GUEST', source: 'EXPLICIT' };
  }
  if (/(?:未登录|未认证|匿名|unauthenticated|anonymous)/i.test(statement)) {
    return { role: 'ANONYMOUS', kind: 'ANONYMOUS', source: 'EXPLICIT' };
  }
  // Generic “用户/user” is still an explicit USER role when it is the
  // grammatical subject. Identity selection remains a later fail-close step.
  if (/(?:^|[\s，。；;])(?:用户|user)\s*(?=(?:可以|可|只能|必须|应当|应该|不得|不能|访问|查看|读取|修改|删除|创建|提交|\bcan\b|\bmust\b|\bmay\b))/iu.test(statement)) {
    return { role: 'USER', kind: 'USER', source: 'EXPLICIT' };
  }
  return undefined;
}

function identityPosition(statement: string, actor: ActorSpec): number {
  const values = [actor.id, actor.userId, actor.name].filter((value): value is string => Boolean(value));
  return Math.min(...values.map((value) => {
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^A-Za-z0-9_-])${escaped}(?:$|[^A-Za-z0-9_-])`, 'i').exec(statement)?.index ?? Infinity;
  }));
}

function actorRelation(statement: string, actors: ActorSpec[], allowConfiguredDefault = false): { actor?: CanonicalActor; targetActor?: CanonicalActor } {
  const mentioned = actors
    .map((actor) => ({ actor, position: identityPosition(statement, actor) }))
    .filter((entry) => Number.isFinite(entry.position))
    .sort((a, b) => a.position - b.position);
  if (mentioned.length >= 2) {
    const first = mentioned[0];
    const second = mentioned[1];
    const relation = statement.slice(first.position, second.position + second.actor.id.length);
    const passive = /(?:被|\bby\b|accessed\s+by|modified\s+by|deleted\s+by|read\s+by|viewed\s+by)/i.test(relation);
    const ownerFirst = /(?:的(?:数据|订单|资源|记录|资料|账户)|owns?\s+(?:the\s+)?(?:data|order|resource|record|account))/i.test(relation);
    return passive || ownerFirst
      ? { actor: configuredActor(second.actor), targetActor: configuredActor(first.actor) }
      : { actor: configuredActor(first.actor), targetActor: configuredActor(second.actor) };
  }
  if (mentioned.length === 1) return { actor: configuredActor(mentioned[0].actor) };
  const role = explicitRole(statement);
  if (!role?.role) return allowConfiguredDefault && actors.length === 1 ? { actor: configuredActor(actors[0]) } : { actor: role };
  const roleMatches = actors.filter((actor) => actor.role.toUpperCase() === role.role);
  return roleMatches.length === 1 ? { actor: configuredActor(roleMatches[0]) } : { actor: role };
}

function parameterFromRef(ref: RequirementFactEntityRef, apis: ApiSpec[]): ParameterSpec | undefined {
  if (ref.type !== 'PARAMETER' || !ref.apiSpecId || !ref.field) return undefined;
  const api = apis.find((candidate) => candidate.id === ref.apiSpecId);
  return [...api?.headers ?? [], ...api?.query ?? [], ...api?.pathParams ?? [], ...api?.body ?? []]
    .find((parameter) => parameter.name.toLowerCase() === ref.field!.toLowerCase());
}

function responseFromRef(ref: RequirementFactEntityRef, apis: ApiSpec[]): ResponseSpec | undefined {
  if (ref.type !== 'RESPONSE' || !ref.apiSpecId || !ref.field) return undefined;
  return apis.find((api) => api.id === ref.apiSpecId)?.responses.find((response) => response.status === Number(ref.field));
}

function operationFromRefs(refs: RequirementFactEntityRef[], apis: ApiSpec[]): ApiSpec | undefined {
  const apiId = refs.find((ref) => ref.apiSpecId)?.apiSpecId;
  return apiId ? apis.find((api) => api.id === apiId) : undefined;
}

function explicitStatus(statement: string): number | undefined {
  const withoutOperation = statement.replace(/\b(?:GET|HEAD|POST|PUT|PATCH|DELETE)\s+\/[^\s|`，。,;；]+/gi, ' ');
  for (const match of withoutOperation.matchAll(/(?:返回|响应(?:状态码)?|状态码|returns?|responds?\s+with|status(?:\s+code)?\s*[:=]?)\s*(?:HTTP\s*)?([1-5]\d{2})/gi)) {
    const before = withoutOperation.slice(Math.max(0, match.index! - 16), match.index);
    const after = withoutOperation.slice(match.index! + match[0].length, match.index! + match[0].length + 24);
    if (/(?:若|如果|当|实际|观察到|unexpected|actual|observed|if|when)/i.test(before)
      && /(?:失败|缺陷|错误|不通过|fail|defect|error)/i.test(after)) continue;
    if (/(?:不得|不能|不应|禁止|must\s+not|should\s+not|cannot|never)\s*$/i.test(before)) continue;
    return Number(match[1]);
  }
  return undefined;
}

function resourceFromPath(path: string): CanonicalResource | undefined {
  const part = path.split('/').filter((item) => item && !item.startsWith('{') && item.toLowerCase() !== 'api').at(-1);
  if (!part) return undefined;
  const singular = part.replace(/ies$/i, 'y').replace(/s$/i, '');
  return { kind: singular.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase() || 'UNKNOWN', expression: part, identifiers: {} };
}

function resource(statement: string, operation: ApiSpec | undefined, permission: PermissionSpec | undefined): CanonicalResource {
  const identifiers: Record<string, string> = {};
  for (const match of statement.matchAll(/\b([A-Za-z_][\w-]*Id)\s*(?:=|:|：|为)\s*([A-Za-z0-9._~-]+)/gi)) {
    const value = match[2];
    const remainder = statement.slice((match.index ?? 0) + match[0].length);
    const schemaToken = /^(?:type|required|nullable|min|max|minLength|maxLength|pattern|enum|default|location|string|integer|number|boolean|body|path|query|header)$/i.test(value);
    // Contract projections such as `itemId：type=string` describe a schema;
    // `type` is not a real resource id and must never become `/items/type`.
    if (schemaToken || /^\s*=/.test(remainder)) continue;
    identifiers[match[1]] = match[2];
  }
  const pathResource = operation ? resourceFromPath(operation.path) : permission?.resource.startsWith('/')
    ? resourceFromPath(permission.resource.split('#')[0]) : undefined;
  if (pathResource) return { ...pathResource, identifiers };
  const matched = RESOURCE_PATTERNS.find(([, pattern]) => pattern.test(statement));
  return { kind: matched?.[0] ?? 'UNKNOWN', expression: matched?.[0] ? statement : undefined, identifiers };
}

function parameterConstraints(parameter: ParameterSpec): CanonicalConstraint[] {
  const result: CanonicalConstraint[] = [
    { kind: 'TYPE', field: parameter.name, expression: `type=${parameter.type}` },
    { kind: 'NULLABLE', field: parameter.name, expression: `nullable=${parameter.nullable}`, values: [parameter.nullable] },
  ];
  if (parameter.required) result.push({ kind: 'REQUIRED', field: parameter.name, expression: 'required=true', values: [true] });
  if (parameter.min !== undefined || parameter.max !== undefined) result.push({
    kind: 'RANGE', field: parameter.name, expression: `min=${parameter.min ?? 'UNBOUNDED'} max=${parameter.max ?? 'UNBOUNDED'}`,
    min: parameter.min, max: parameter.max,
  });
  if (parameter.minLength !== undefined || parameter.maxLength !== undefined) result.push({
    kind: 'LENGTH', field: parameter.name,
    expression: `minLength=${parameter.minLength ?? 'UNBOUNDED'} maxLength=${parameter.maxLength ?? 'UNBOUNDED'}`,
    minLength: parameter.minLength, maxLength: parameter.maxLength,
  });
  if (parameter.pattern) result.push({ kind: 'FORMAT', field: parameter.name, expression: `pattern=${parameter.pattern}`, pattern: parameter.pattern });
  if (parameter.enum?.length) result.push({ kind: 'ENUM', field: parameter.name, expression: `enum=${JSON.stringify(parameter.enum)}`, values: parameter.enum });
  return result;
}

function proseConstraints(statement: string): CanonicalConstraint[] {
  const constraints: CanonicalConstraint[] = [];
  const range = statement.match(/(-?\d+(?:\.\d+)?)\s*(?:~|～|至|到)\s*(-?\d+(?:\.\d+)?)/);
  if (range) constraints.push({ kind: 'RANGE', expression: range[0], min: Number(range[1]), max: Number(range[2]) });
  if (/(?:原子|atomic)/i.test(statement)) constraints.push({ kind: 'ATOMIC', expression: statement });
  if (/(?:唯一|unique)/i.test(statement)) constraints.push({ kind: 'UNIQUE', expression: statement });
  if (/(?:幂等|idempotent)/i.test(statement)) constraints.push({ kind: 'IDEMPOTENT', expression: statement });
  if (/(?:并发|concurren(?:t|cy)|同时修改|同时提交)/i.test(statement)) {
    constraints.push({ kind: 'CONCURRENCY', expression: statement });
  }
  if (/(?:前后端(?:数据)?(?:必须|应当|应该|保持|需)?一致|ui\s*(?:and|\/|-)\s*api.*consistent|frontend.*backend.*consistent)/i.test(statement)) {
    constraints.push({ kind: 'FRONTEND_BACKEND_CONSISTENCY', expression: statement });
  } else if (/(?:数据一致性|保持一致|必须一致|一致性|data\s+consisten)/i.test(statement)) {
    constraints.push({ kind: 'CONSISTENCY', expression: statement });
  }
  if (/(?:失败恢复|失败后恢复|恢复到|回滚|rollback|failure\s+recovery|recover\s+after)/i.test(statement)) {
    constraints.push({ kind: 'RECOVERY', expression: statement });
  }
  if (/(?:顺序|ordering|reorder)/i.test(statement)) constraints.push({ kind: 'ORDERING', expression: statement });
  if (/(?:必填|不能为空|不可为空|mandatory|required(?!\s*[:=]\s*(?:false|no)))/i.test(statement)) {
    constraints.push({ kind: 'REQUIRED', expression: statement });
  }
  if (/(?:无需|不需要|免)(?:鉴权|认证|登录)|公开接口|auth(?:entication)?\s+not\s+required|without\s+(?:auth|authentication|token|credentials)/i.test(statement)) {
    constraints.push({ kind: 'AUTH_NOT_REQUIRED', expression: statement });
  }
  if (/(?:格式|正则|pattern|format)/i.test(statement)) constraints.push({ kind: 'FORMAT', expression: statement });
  if (/(?:枚举|enum)/i.test(statement)) constraints.push({ kind: 'ENUM', expression: statement });
  if (/(?:状态|state).*(?:从|from).*(?:变为|转为|到|to)/i.test(statement)) constraints.push({ kind: 'STATE_TRANSITION', expression: statement });
  if (/(?:loading|disabled|加载中|禁用|按钮状态|ui\s+state)/i.test(statement)) constraints.push({ kind: 'UI_STATE', expression: statement });
  if (/(?:失败|错误|异常|fail|error|exception)/i.test(statement)) constraints.push({ kind: 'EXPECTED_ERROR', expression: statement });
  return constraints;
}

function scopes(statement: string, isolation: IsolationRule | undefined, permission: PermissionSpec | undefined): CanonicalScope[] {
  if (isolation) return [{
    dimension: isolation.dimension,
    relation: isolation.expected === 'ALLOW' ? 'SAME' : 'CROSS',
    expression: statement,
  }];
  const result: CanonicalScope[] = [];
  if (/(?:自己的|本人|自身|当前用户|own\s+(?:data|resource|record|order)|belong.*current)/i.test(statement)
    || permission?.resource.endsWith('#SELF')) {
    result.push({ dimension: 'USER', relation: 'OWNER_ONLY', expression: statement });
  }
  if (/(?:其他用户|跨用户|other\s+user|cross[-\s]?user)/i.test(statement) || permission?.resource.endsWith('#OTHER')) {
    result.push({ dimension: 'USER', relation: 'OTHER', expression: statement });
  }
  const dimensions: Array<[CanonicalScope['dimension'], RegExp]> = [
    ['TENANT', /(?:租户|tenant)/i], ['PROJECT', /(?:项目|project)/i],
    ['WORKSPACE', /workspace/i], ['ORGANIZATION', /(?:组织|organi[sz]ation)/i],
  ];
  for (const [dimension, pattern] of dimensions) {
    if (!pattern.test(statement)) continue;
    const relation = /(?:跨|不同|other|cross)/i.test(statement) ? 'CROSS'
      : /(?:同一|相同|same|属于|belong)/i.test(statement) ? 'SAME' : 'UNKNOWN';
    // 只出现资源名或 Path（例如 /tenants/{id}）不是隔离约束。
    if (relation !== 'UNKNOWN') result.push({ dimension, relation, expression: statement });
  }
  return result;
}

function sideEffects(statement: string): CanonicalSideEffect[] {
  const result: CanonicalSideEffect[] = [];
  if (/(?:库存|inventory|stock)/i.test(statement)) result.push({
    kind: 'INVENTORY', action: /(?:不得|不能|不应|must\s+not|should\s+not).*(?:库存|inventory|stock)/i.test(statement)
      ? 'UNCHANGED' : /(?:回滚|恢复|rollback|restore)/i.test(statement)
        ? 'ROLLBACK' : /(?:扣减|扣除|decrease|deduct)/i.test(statement) ? 'DECREASE' : 'UPDATE',
    expression: statement, observation: 'DATA',
  });
  if (/(?:邮件|短信|消息|通知|webhook|email|sms|message|notify)/i.test(statement)) result.push({
    kind: 'MESSAGE', action: /(?:不得|不能|不应|must\s+not|should\s+not).*(?:邮件|短信|消息|通知|webhook|email|sms|message|notify)/i.test(statement)
      ? 'UNCHANGED' : 'SEND', expression: statement, observation: 'EVENT',
  });
  if (/(?:扣费|扣款|计费|收费|扣除积分|billing|charge|payment)/i.test(statement)) result.push({
    kind: 'BILLING', action: /(?:不得|不能|不应|失败.{0,12}(?:不|免)|must\s+not|should\s+not).*(?:扣费|扣款|计费|收费|扣除积分|billing|charge|payment)/i.test(statement)
      ? 'UNCHANGED' : /(?:退款|退回|回退|回滚|refund|rollback)/i.test(statement)
        ? 'ROLLBACK' : /(?:扣|charge)/i.test(statement) ? 'DECREASE' : 'UPDATE', expression: statement, observation: 'EXTERNAL',
  });
  if (/(?:审计记录|audit\s+(?:record|log))/i.test(statement)) result.push({
    kind: 'AUDIT', action: 'CREATE', expression: statement, observation: 'DATA',
  });
  return result;
}

function explicitResponseFields(statement: string): Record<string, unknown> | undefined {
  if (!/(?:响应(?:体)?|返回(?:体|字段|数据)|response(?:\s+body)?|body\s+field)/i.test(statement)) return undefined;
  const fields: Record<string, unknown> = {};
  for (const match of statement.matchAll(/\b([A-Za-z_][\w.-]*)\s*(?:=|必须为|应为|为)\s*(true|false|null|-?\d+(?:\.\d+)?|"[^"]*"|'[^']*')/gi)) {
    const raw = match[2].replace(/[，。,;；]+$/, '');
    fields[match[1]] = /^true$/i.test(raw) ? true : /^false$/i.test(raw) ? false : /^null$/i.test(raw) ? null
      : /^-?\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : raw.slice(1, -1);
  }
  return Object.keys(fields).length ? fields : undefined;
}

function expectedOutcome(input: RequirementNormalizationContext, response: ResponseSpec | undefined, permission: PermissionSpec | undefined, isolation: IsolationRule | undefined): CanonicalExpectedOutcome {
  const declaredStatus = response?.status ?? explicitStatus(input.statement);
  const fields = explicitResponseFields(input.statement);
  const value = fields ? { fields } : undefined;
  if (permission) return { kind: permission.effect, status: declaredStatus, value, expression: input.statement, explicit: true };
  if (isolation) return { kind: isolation.expected, status: declaredStatus, value, expression: input.statement, explicit: true };
  // “不得返回过期报表”描述错误响应的禁止结果，不是 Actor 权限拒绝。
  // 只有明确的访问控制 Fact 才允许 DENY/ALLOW 驱动下游身份场景。
  const polarity = input.category === 'AUTH' || input.category === 'PERMISSION' || input.category === 'DATA_ISOLATION'
    || hasAccessControlSemantics(input.statement)
    ? accessPolarity(input.statement)
    : 'UNKNOWN';
  const status = declaredStatus;
  if (polarity !== 'UNKNOWN') return { kind: polarity, status, value, expression: input.statement, explicit: true };
  if ((input.category === 'AUTH' || input.category === 'PERMISSION' || input.category === 'DATA_ISOLATION')
    && (status === 401 || status === 403)) {
    return { kind: 'DENY', status, value, expression: input.statement, explicit: true };
  }
  if ((input.category === 'PERMISSION' || input.category === 'DATA_ISOLATION')
    && /(?:只能|仅可|只允许).*(?:自己的|本人|自身)|(?:may|can)\s+only.*\bown\b/i.test(input.statement)) {
    return { kind: 'ALLOW', status, value, expression: input.statement, explicit: true };
  }
  if (/(?:不存在|未找到|not\s+found)/i.test(input.statement)) return { kind: 'NOT_FOUND', status, value, expression: input.statement, explicit: true };
  if (/(?:无需|不需要|免)(?:鉴权|认证|登录)|公开接口|auth(?:entication)?\s+not\s+required|without\s+(?:auth|authentication|token|credentials)/i.test(input.statement)) {
    return { kind: 'ALLOW', value, expression: input.statement, explicit: true };
  }
  if (/(?:保持不变|不得改变|unchanged|must\s+not\s+change)/i.test(input.statement)) return { kind: 'UNCHANGED', value, expression: input.statement, explicit: true };
  const transition = input.statement.match(/(?:从\s*(?:[^，。；]*?\s的\s)?([^，。；\s]+)\s*(?:变为|变成|转为|转换到|流转到|到)\s*(?:[^，。；]*?\s的\s)?([^，。；\s]+)|(?:transition(?:s|ed)?\s+from\s+([^,.;\s]+)\s+to\s+([^,.;\s]+)))/i);
  if (transition && status === undefined) return {
    kind: 'STATE_CHANGED',
    value: { from: transition[1] ?? transition[3], to: transition[2] ?? transition[4] },
    expression: input.statement,
    explicit: true,
  };
  const terminalState = input.category === 'STATE'
    ? input.statement.match(/(?:返回|达到|终态(?:为)?)[^，。；]*?\b([A-Z][A-Z0-9_]{2,})\b/) : undefined;
  if (terminalState && status === undefined) return {
    kind: 'STATE_CHANGED', value: { to: terminalState[1] }, expression: input.statement, explicit: true,
  };
  if (/(?:显示|展示|可见|display|show|visible)/i.test(input.statement)) return { kind: 'VISIBLE', value, expression: input.statement, explicit: true };
  if (/(?:失败|错误|异常|拒绝|fail|error|exception|reject)/i.test(input.statement)) return { kind: 'FAILURE', status, value, expression: input.statement, explicit: true };
  if (status !== undefined) return { kind: 'STATUS', status, value, expression: input.statement, explicit: true };
  if (/(?:成功|可以|允许|必须|需要|应当|应该|支持|非空|存在|等于|一致|均为|只创建|只有|success|shall|must|should|required|non[-\s]?empty|exists?|equals?|can\s+)/i.test(input.statement)) {
    return { kind: 'SUCCESS', value, expression: input.statement, explicit: true };
  }
  return { kind: 'UNKNOWN', explicit: false };
}

function conditions(statement: string): CanonicalCondition[] {
  const result: CanonicalCondition[] = [];
  const patterns: Array<[CanonicalCondition['kind'], RegExp]> = [
    ['IF', /(?:如果|若|if)\s*([^，。；;]+)/i],
    // 避免把“应当被阻止”中的“当”误识别成 WHEN 前置条件。
    ['WHEN', /(?:(?<!应)当|when)\s*([^，。；;]+)/i],
    ['AFTER', /([^，。；;]*(?:后|之后|after)[^，。；;]*)/i],
    ['BEFORE', /([^，。；;]*(?:前|before)[^，。；;]*)/i],
  ];
  for (const [kind, pattern] of patterns) {
    const match = statement.match(pattern);
    if (match) result.push({ kind, expression: match[0].trim(), explicit: true });
  }
  return result;
}

function action(input: RequirementNormalizationContext, operation: ApiSpec | undefined, permission: PermissionSpec | undefined, state: StateRule | undefined): CanonicalAction {
  const explicitOperation = input.statement.match(/\b(GET|HEAD|POST|PUT|PATCH|DELETE)\s+(\/[^\s|`，。,;；]+)/i);
  const explicitOperationKey = explicitOperation
    ? `${explicitOperation[1].toUpperCase()} ${explicitOperation[2].replace(/[，。,;；.]+$/, '')}`
    : undefined;
  if (permission) return {
    kind: permission.action as CanonicalAction['kind'],
    expression: permission.action,
    operationKey: explicitOperationKey ?? operation?.operationKey,
  };
  if (state) return { kind: 'TRANSITION', expression: state.action, operationKey: explicitOperationKey ?? operation?.operationKey };
  if (explicitOperation) {
    const method = explicitOperation[1].toUpperCase() as ApiSpec['method'];
    return {
      kind: methodAction(method),
      expression: explicitOperation[0],
      operationKey: explicitOperationKey,
    };
  }
  if (operation) return { kind: methodAction(operation.method), expression: operation.method, operationKey: operation.operationKey };
  const matched = ACTION_PATTERNS.find(([, pattern]) => pattern.test(input.statement));
  return { kind: matched?.[0] ?? (input.category === 'AUTH' || input.category === 'PERMISSION' || input.category === 'DATA_ISOLATION' ? 'ACCESS' : 'UNKNOWN'), expression: matched ? input.statement : undefined };
}

/**
 * 将一个 Ledger Fact 标准化一次。这里允许集中、可测试的文本识别；下游不得再
 * 通过业务关键词改变 Actor/Action/Expected/Scope。
 */
export function normalizeRequirementFact(input: RequirementNormalizationContext): CanonicalRequirementFact {
  const permissionRef = input.entityRefs.find((ref) => ref.type === 'PERMISSION');
  const isolationRef = input.entityRefs.find((ref) => ref.type === 'ISOLATION_RULE');
  const stateRef = input.entityRefs.find((ref) => ref.type === 'STATE_RULE');
  const businessRef = input.entityRefs.find((ref) => ref.type === 'BUSINESS_RULE');
  const permission = permissionRef ? input.permissions.find((item) => item.id === permissionRef.id) : undefined;
  const isolation = isolationRef ? input.isolationRules.find((item) => item.id === isolationRef.id) : undefined;
  const state = stateRef ? input.stateRules.find((item) => item.id === stateRef.id) : undefined;
  const business = businessRef ? input.businessRules.find((item) => item.id === businessRef.id) : undefined;
  const operation = operationFromRefs(input.entityRefs, input.apis);
  const parameter = input.entityRefs.map((ref) => parameterFromRef(ref, input.apis)).find(Boolean);
  const response = input.entityRefs.map((ref) => responseFromRef(ref, input.apis)).find(Boolean);
  const allowConfiguredDefault = operation?.authPolicy === 'AUTH_REQUIRED'
    || (!operation && input.apis.length > 0 && input.apis.every((api) => api.authPolicy === 'AUTH_REQUIRED'));
  const relation = actorRelation(input.statement, input.actors, allowConfiguredDefault);
  const canonicalScopes = scopes(input.statement, isolation, permission);
  if (relation.actor?.id && relation.targetActor?.id
    && !canonicalScopes.some((scope) => scope.dimension === 'USER')) {
    canonicalScopes.push({ dimension: 'USER', relation: 'OTHER', expression: input.statement });
  }
  // 结构化 ParameterSpec 与 AC 正文是互补来源。例如表格给出 type/min/max，
  // AC 可能用“18 到 60”再次声明业务边界或补充错误语义，不能二选一。
  const canonicalConstraints = [
    ...(parameter ? parameterConstraints(parameter) : []),
    ...proseConstraints(input.statement),
  ];
  if (permission?.actorRole && permission.actorRole !== 'UNSPECIFIED') canonicalConstraints.push({
    kind: 'ROLE_REQUIRED', expression: `role=${permission.actorRole}`, values: [permission.actorRole],
  });
  if (canonicalScopes.some((scope) => scope.relation === 'OWNER_ONLY')) canonicalConstraints.push({ kind: 'OWNER_ONLY', expression: input.statement });
  if (canonicalScopes.some((scope) => scope.dimension !== 'UNKNOWN')) canonicalConstraints.push({ kind: 'SCOPE_ISOLATION', expression: input.statement });
  if (state && !canonicalConstraints.some((constraint) => constraint.kind === 'STATE_TRANSITION')) canonicalConstraints.push({ kind: 'STATE_TRANSITION', expression: state.action });
  const canonicalExpected = expectedOutcome(input, response, permission, isolation);
  const canonicalAction = action(input, operation, permission, state);
  const canonicalResource = resource(input.statement, operation, permission);
  const canonicalSideEffects = sideEffects(business?.description ?? input.statement);
  const unresolved: string[] = [];
  const needsActor = input.category === 'PERMISSION' || input.category === 'DATA_ISOLATION';
  if (needsActor && !relation.actor) unresolved.push('ACTOR_UNRESOLVED');
  if (input.category === 'DATA_ISOLATION' && !relation.targetActor && !canonicalScopes.length) unresolved.push('TARGET_OR_SCOPE_UNRESOLVED');
  if (canonicalAction.kind === 'UNKNOWN') unresolved.push('ACTION_UNRESOLVED');
  if (canonicalResource.kind === 'UNKNOWN') unresolved.push('RESOURCE_UNRESOLVED');
  if (canonicalExpected.kind === 'UNKNOWN') unresolved.push('EXPECTED_OUTCOME_UNRESOLVED');
  const requiredUnresolved = unresolved.filter((item) => item === 'EXPECTED_OUTCOME_UNRESOLVED'
    || needsActor && item === 'ACTOR_UNRESOLVED');
  return {
    actor: relation.actor,
    targetActor: relation.targetActor,
    resource: canonicalResource,
    action: canonicalAction,
    conditions: conditions(input.statement),
    constraints: canonicalConstraints.filter((constraint, index, all) => all.findIndex((candidate) =>
      candidate.kind === constraint.kind && candidate.field === constraint.field && candidate.expression === constraint.expression) === index),
    expected: canonicalExpected,
    scopes: canonicalScopes,
    sideEffects: canonicalSideEffects,
    normalizationStatus: requiredUnresolved.length ? 'UNRESOLVED' : unresolved.length ? 'PARTIAL' : 'COMPLETE',
    unresolved,
  };
}
