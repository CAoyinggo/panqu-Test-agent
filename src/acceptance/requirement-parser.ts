import { createHash } from 'node:crypto';
import type {
  AcceptanceCriterion,
  AcceptanceRequirement,
  ActorSpec,
  ApiSpec,
  ParameterLocation,
  ParameterSpec,
  ParameterType,
  RequirementSource,
  RequirementParseWarning,
  ResponseSpec,
} from './requirement-ir.js';
import { buildRequirementFactLedger } from './requirement-fact-ledger.js';

interface ParsedLine {
  number: number;
  text: string;
  section?: string;
}

const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);

function sourceOf(line: ParsedLine, documentId?: string): RequirementSource {
  const text = line.text.trim();
  return {
    documentId,
    section: line.section,
    line: line.number,
    lineStart: line.number,
    lineEnd: line.number,
    content: text,
    text,
  };
}

function cells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

function normalizedHeader(value: string): string {
  const v = value.toLowerCase().replace(/[\s_-]+/g, '');
  const aliases: Record<string, string> = {
    方法: 'method', httpmethod: 'method', method: 'method',
    路径: 'path', url: 'path', path: 'path', endpoint: 'path',
    参数: 'name', 参数名: 'name', 字段: 'name', 字段名: 'name', name: 'name', parameter: 'name',
    类型: 'type', type: 'type',
    位置: 'location', in: 'location', location: 'location',
    必填: 'required', 是否必填: 'required', required: 'required',
    可空: 'nullable', nullable: 'nullable',
    最小值: 'min', min: 'min', 最大值: 'max', max: 'max',
    最小长度: 'minLength', minlength: 'minLength', 最大长度: 'maxLength', maxlength: 'maxLength',
    范围: 'range', range: 'range', 格式: 'pattern', pattern: 'pattern',
    枚举: 'enum', enum: 'enum', 默认值: 'default', default: 'default',
    描述: 'description', 说明: 'description', description: 'description',
    状态码: 'status', httpstatus: 'status', status: 'status', code: 'status', 错误码: 'status',
    actorid: 'actorId', actor: 'actorId', 身份: 'actorId', id: 'actorId',
    角色: 'role', role: 'role', 用户: 'userId', 用户id: 'userId', userid: 'userId',
    租户: 'tenantId', 租户id: 'tenantId', tenant: 'tenantId', tenantid: 'tenantId',
    名称: 'actorName', name2: 'actorName', tokenref: 'tokenRef', 凭据: 'tokenRef',
  };
  return aliases[v] ?? value.trim();
}

function rowRecord(headers: string[], values: string[]): Record<string, string> {
  return Object.fromEntries(headers.map((header, index) => [normalizedHeader(header), values[index] ?? '']));
}

function boolValue(value: string, fallback = false): boolean {
  if (!value.trim()) return fallback;
  return /^(true|yes|y|1|是|必填|required)$/i.test(value.trim());
}

function parameterType(value: string): ParameterType {
  const v = value.toLowerCase().trim();
  if (/^(int|integer|整数)$/.test(v)) return 'integer';
  if (/^(number|float|double|数字|数值)$/.test(v)) return 'number';
  if (/^(string|str|字符串|文本)$/.test(v)) return 'string';
  if (/^(bool|boolean|布尔)$/.test(v)) return 'boolean';
  if (/^(array|数组|list)$/.test(v)) return 'array';
  if (/^(object|对象|json)$/.test(v)) return 'object';
  return 'unknown';
}

function parameterLocation(value: string): ParameterLocation {
  const v = value.toLowerCase().trim();
  if (/header|请求头/.test(v)) return 'header';
  if (/query|查询/.test(v)) return 'query';
  if (/path|路径/.test(v)) return 'path';
  return 'body';
}

function numberValue(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseScalar(value: string): unknown {
  const v = value.trim();
  if (/^null$/i.test(v)) return null;
  if (/^(true|false)$/i.test(v)) return v.toLowerCase() === 'true';
  const number = Number(v);
  return v !== '' && Number.isFinite(number) ? number : v;
}

function parameterFromRow(row: Record<string, string>, line: ParsedLine, documentId?: string): ParameterSpec | null {
  const name = row.name?.trim();
  if (!name) return null;
  const type = parameterType(row.type ?? '');
  const parameter: ParameterSpec = {
    name,
    type,
    required: boolValue(row.required ?? ''),
    nullable: boolValue(row.nullable ?? ''),
    location: parameterLocation(row.location ?? ''),
    description: row.description?.trim() || undefined,
    source: sourceOf(line, documentId),
  };
  parameter.min = numberValue(row.min ?? '');
  parameter.max = numberValue(row.max ?? '');
  parameter.minLength = numberValue(row.minLength ?? '');
  parameter.maxLength = numberValue(row.maxLength ?? '');
  const range = (row.range ?? '').match(/(-?\d+(?:\.\d+)?)\s*(?:~|～|-|至)\s*(-?\d+(?:\.\d+)?)/);
  if (range) {
    const low = Number(range[1]);
    const high = Number(range[2]);
    if (type === 'string') {
      parameter.minLength ??= low;
      parameter.maxLength ??= high;
    } else {
      parameter.min ??= low;
      parameter.max ??= high;
    }
  }
  parameter.pattern = row.pattern?.trim() || undefined;
  if (row.enum?.trim()) parameter.enum = row.enum.split(/[,，/]/).map(parseScalar);
  if (row.default?.trim()) parameter.default = parseScalar(row.default);
  return parameter;
}

function addParameter(api: ApiSpec, parameter: ParameterSpec): 'ADDED' | 'DUPLICATE' | 'CONFLICT' {
  const target = parameter.location === 'header' ? api.headers
    : parameter.location === 'query' ? api.query
      : parameter.location === 'path' ? api.pathParams
        : api.body;
  const existing = target.find((item) => item.name.toLowerCase() === parameter.name.toLowerCase());
  if (existing) {
    const contract = (item: ParameterSpec): unknown => ({
      type: item.type, required: item.required, nullable: item.nullable,
      min: item.min, max: item.max, minLength: item.minLength, maxLength: item.maxLength,
      pattern: item.pattern, enum: item.enum, default: item.default,
    });
    return JSON.stringify(contract(existing)) === JSON.stringify(contract(parameter)) ? 'DUPLICATE' : 'CONFLICT';
  }
  target.push(parameter);
  return 'ADDED';
}

function addParameterWarning(
  warnings: RequirementParseWarning[],
  api: ApiSpec,
  parameter: ParameterSpec,
  result: ReturnType<typeof addParameter>,
  source: RequirementSource,
): void {
  const invalidRange = (parameter.min !== undefined && parameter.max !== undefined && parameter.min > parameter.max)
    || (parameter.minLength !== undefined && parameter.maxLength !== undefined && parameter.minLength > parameter.maxLength);
  if (invalidRange) warnings.push({
    code: 'REQUIREMENT_CONFLICT',
    stage: 'PARSER',
    blocking: true,
    message: `${api.operationKey} 的 ${parameter.location} 参数 ${parameter.name} 最小约束大于最大约束`,
    source,
  });
  if (result === 'ADDED') return;
  warnings.push({
    code: result === 'CONFLICT' ? 'REQUIREMENT_CONFLICT' : 'DUPLICATE_PARAMETER',
    stage: 'PARSER',
    blocking: result === 'CONFLICT' || undefined,
    message: result === 'CONFLICT'
      ? `${api.operationKey} 的 ${parameter.location} 参数 ${parameter.name} 存在冲突契约，不能选择性保留其中一个`
      : `${api.operationKey} 的 ${parameter.location} 参数 ${parameter.name} 重复定义，已保留首次定义`,
    source,
  });
}

function addResponse(api: ApiSpec, response: ResponseSpec): void {
  if (!api.responses.some((item) => item.status === response.status)) api.responses.push(response);
}

function declaredResponseStatuses(text: string, section?: string): number[] {
  const statuses = new Set<number>();
  const listPattern = /(?:返回|响应(?:状态码)?|状态码|returns?|responds?\s+with|status(?:\s+code)?\s*[:=]?)\s*((?:[1-5]\d{2})(?:\s*(?:、|,|，|\/|和|或|and|or)\s*[1-5]\d{2})*)/gi;
  for (const match of text.matchAll(listPattern)) {
    for (const status of match[1].matchAll(/\b([1-5]\d{2})\b/g)) statuses.add(Number(status[1]));
  }
  for (const match of text.matchAll(/\b([1-5]\d{2})\s*(?:状态码|响应|response)\b/gi)) statuses.add(Number(match[1]));
  // A plain leading status is accepted only inside an explicit Response/Error
  // section. Embedded resource ids such as ord-200 must never become statuses.
  if (/(?:响应|错误码|response|errors?)/i.test(section ?? '')) {
    const leading = text.match(/^\s*(?:[-*]\s*)?([1-5]\d{2})\b/);
    if (leading) statuses.add(Number(leading[1]));
  }
  return [...statuses];
}

function indexLines(markdown: string): { lines: ParsedLine[]; title: string } {
  let section: string | undefined;
  let title = '';
  const lines = markdown.split(/\r?\n/).map((text, index) => {
    const heading = text.match(/^\s*(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      const value = heading[2].trim();
      if (heading[1].length === 1 && !title) title = value;
      section = value;
    }
    return { number: index + 1, text, section };
  });
  return { lines, title: title || '未命名开发验收需求' };
}

function parseTables(lines: ParsedLine[]): Array<{ headers: string[]; rows: Array<{ line: ParsedLine; data: Record<string, string> }> }> {
  const tables: Array<{ headers: string[]; rows: Array<{ line: ParsedLine; data: Record<string, string> }> }> = [];
  for (let i = 0; i < lines.length - 1; i++) {
    if (!/^\s*\|/.test(lines[i].text) || !/^\s*\|?\s*:?-{3,}/.test(lines[i + 1].text)) continue;
    const headers = cells(lines[i].text);
    const rows: Array<{ line: ParsedLine; data: Record<string, string> }> = [];
    i += 2;
    while (i < lines.length && /^\s*\|/.test(lines[i].text)) {
      // Markdown allows adjacent tables without a blank line. A new header
      // followed by a separator starts another table; it is not a data row of
      // the previous table.
      if (i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1].text)) break;
      rows.push({ line: lines[i], data: rowRecord(headers, cells(lines[i].text)) });
      i++;
    }
    i--;
    tables.push({ headers, rows });
  }
  return tables;
}

function apiKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

function stableApiId(operationKey: string): string {
  return `API-${createHash('sha256').update(operationKey).digest('hex').slice(0, 12).toUpperCase()}`;
}

/** 将开发需求 Markdown 解析为保留来源行的 Acceptance Requirement IR。 */
export function parseAcceptanceRequirement(markdown: string, options: { documentId?: string } = {}): AcceptanceRequirement {
  if (!markdown.trim()) throw new Error('开发验收需求文档为空');
  const { lines, title } = indexLines(markdown);
  const documentId = options.documentId;
  const requirementId = `REQ-${createHash('sha256').update(markdown).digest('hex').slice(0, 12)}`;
  const apis: ApiSpec[] = [];
  const apiByKey = new Map<string, ApiSpec>();
  const actors: ActorSpec[] = [];
  const warnings: RequirementParseWarning[] = [];

  const ensureApi = (method: string, path: string, line: ParsedLine): ApiSpec | undefined => {
    if (!/^\/(?!\/)/.test(path) || /[\\?#\u0000-\u001f]/.test(path)) {
      warnings.push({
        code: 'INVALID_API_PATH', stage: 'PARSER', blocking: true,
        message: `${method.toUpperCase()} ${path} 不是 single-leading-slash 相对 API Path，禁止改变配置的 Origin`,
        source: sourceOf(line, documentId),
      });
      return undefined;
    }
    const key = apiKey(method, path);
    const existing = apiByKey.get(key);
    if (existing) {
      if (existing.source?.line !== line.number) warnings.push({
        code: 'DUPLICATE_API_OPERATION', stage: 'PARSER',
        message: `${key} 重复声明；当前身份策略无法表达不同 Server/Version/Content-Type 的同路径操作`,
        source: sourceOf(line, documentId),
      });
      return existing;
    }
    const api: ApiSpec = {
      id: stableApiId(key),
      operationKey: key,
      authPolicy: 'AUTH_UNKNOWN',
      method: method.toUpperCase() as ApiSpec['method'],
      path,
      headers: [], query: [], pathParams: [], body: [], responses: [],
      source: sourceOf(line, documentId),
    };
    apis.push(api);
    apiByKey.set(key, api);
    return api;
  };

  // 非表格 API 声明，例如 `PUT /api/users/{id}`。
  for (const line of lines) {
    // Acceptance Criterion 中的 Method + Path 是操作引用，不是新的 API 定义。
    // 否则 `AC-2 DELETE ...` 会凭空扩充 ApiSpec，并让不存在的操作通过 Binding。
    if (/\bAC-\d+\b/i.test(line.text)) continue;
    const match = line.text.match(/\b(GET|HEAD|POST|PUT|PATCH|DELETE)\s+(\/[^\s|`]+)/i);
    if (match) ensureApi(match[1], match[2].replace(/[，。,;；.]+$/, ''), line);
  }

  for (const table of parseTables(lines)) {
    const normalized = table.headers.map(normalizedHeader);
    const isApiTable = normalized.includes('method') && normalized.includes('path');
    const isParameterTable = normalized.includes('name') && normalized.includes('type');
    const isActorTable = normalized.includes('role') && (normalized.includes('actorId') || normalized.includes('userId'));
    const isResponseTable = normalized.includes('status');

    for (const row of table.rows) {
      if (isActorTable) {
        const id = row.data.actorId || row.data.userId;
        if (id) actors.push({
          id,
          name: row.data.actorName || id,
          userId: row.data.userId || id,
          role: row.data.role || 'USER',
          tenantId: row.data.tenantId || undefined,
          tokenRef: row.data.tokenRef || id,
          source: sourceOf(row.line, documentId),
        });
        continue;
      }

      let api: ApiSpec | undefined;
      if (isApiTable) {
        const method = row.data.method?.toUpperCase();
        const path = row.data.path;
        if (method && path && HTTP_METHODS.has(method)) api = ensureApi(method, path, row.line);
      }
      if (!api) {
        const sectionCandidates = apis.filter((item) => item.source?.section === row.line.section);
        api = apis.length === 1 ? apis[0] : sectionCandidates.length === 1 ? sectionCandidates[0] : undefined;
      }
      if (api && isParameterTable) {
        const parameter = parameterFromRow(row.data, row.line, documentId);
        if (parameter) addParameterWarning(warnings, api, parameter, addParameter(api, parameter), sourceOf(row.line, documentId));
      } else if (!api && isParameterTable && parameterFromRow(row.data, row.line, documentId)) {
        warnings.push({
          code: 'PARAMETER_WITHOUT_API_CONTEXT', stage: 'PARSER', blocking: true,
          message: `参数 ${row.data.name} 无法确定归属 API，已停止自动绑定`,
          source: sourceOf(row.line, documentId),
        });
      }
      if (api && isResponseTable && row.data.status) {
        const status = Number(row.data.status);
        if (Number.isInteger(status)) addResponse(api, { status, description: row.data.description || undefined, source: sourceOf(row.line, documentId) });
      }
    }
  }

  // 兼容真实 PRD/Scenario 常见的分节键值写法；只保存凭据引用，不接收明文 Token。
  // 单一全局 Actor 会在 canonical normalization 中作为未另行指定 AC 的默认执行者。
  const linesInSection = (pattern: RegExp): ParsedLine[] => lines.filter((line) => pattern.test((line.section ?? '').trim()));
  const field = (sectionLines: ParsedLine[], name: RegExp): { value: string; line: ParsedLine } | undefined => {
    for (const line of sectionLines) {
      const cleaned = line.text.trim().replace(/^[-*+]\s*/, '');
      const match = cleaned.match(/^([^:：]+)\s*[:：]\s*(.+)$/);
      if (match && name.test(match[1].trim())) return { value: match[2].trim(), line };
    }
    return undefined;
  };
  const actorSection = linesInSection(/^(?:actor|actors|角色)$/i);
  const actorIdField = field(actorSection, /^(?:id|actor\s*id|user\s*id|编号)$/i);
  if (actorIdField && !actors.some((actor) => actor.id === actorIdField.value)) {
    const actorType = field(actorSection, /^(?:type|类型)$/i)?.value;
    const roleLine = linesInSection(/^(?:role|角色类型)$/i).find((line) => line.text.trim() && !/^#/.test(line.text));
    const tenantField = field(linesInSection(/^(?:tenant|租户)$/i), /^(?:id|tenant\s*id|编号)$/i);
    const tokenField = field(linesInSection(/^(?:authentication|auth|认证|鉴权配置)$/i), /^(?:reference|token\s*ref|credential\s*ref|引用)$/i);
    actors.push({
      id: actorIdField.value,
      name: actorIdField.value,
      userId: actorIdField.value,
      role: roleLine?.text.trim().replace(/^[-*+]\s*/, '') || actorType || 'USER',
      tenantId: tenantField?.value,
      tokenRef: tokenField?.value,
      source: sourceOf(actorIdField.line, documentId),
    });
  }

  // 解析紧邻 API 的 prose 参数，如 `nickname: string required 2~20`。
  for (const line of lines) {
    const match = line.text.match(/^\s*[-*]?\s*([A-Za-z_][\w-]*)\s*[:：]\s*(string|integer|number|boolean)\b(.*)$/i);
    if (!match) continue;
    if (!/api|参数|body|请求/i.test(line.section ?? '') || apis.length !== 1) {
      warnings.push({
        code: 'PARAMETER_WITHOUT_API_CONTEXT', stage: 'PARSER', blocking: true,
        message: `参数 ${match[1]} 使用了可识别语法，但无法确定唯一 API 上下文，未进入 IR`,
        source: sourceOf(line, documentId),
      });
      continue;
    }
    const row: Record<string, string> = { name: match[1], type: match[2], location: 'body' };
    const tail = match[3];
    if (/required|必填/i.test(tail)) row.required = 'true';
    if (/nullable|可空/i.test(tail)) row.nullable = 'true';
    const range = tail.match(/-?\d+(?:\.\d+)?\s*(?:~|～|-|至)\s*-?\d+(?:\.\d+)?/);
    if (range) row.range = range[0];
    const parameter = parameterFromRow(row, line, documentId);
    if (parameter) addParameterWarning(warnings, apis[0], parameter, addParameter(apis[0], parameter), sourceOf(line, documentId));
  }

  // 从路径模板补充必填 Path Parameter。
  for (const api of apis) {
    for (const match of api.path.matchAll(/\{([^}]+)\}/g)) {
      if (!api.pathParams.some((item) => item.name === match[1])) {
        api.pathParams.push({
          name: match[1], type: 'string', required: true, nullable: false, location: 'path',
          description: '由 URL Path 模板推导', source: api.source,
        });
      }
    }
  }

  // 文档中的 HTTP 状态码进入响应契约。
  if (apis.length === 1) {
    for (const line of lines) {
      const responseContext = /响应|错误码|status|response/i.test(line.section ?? '')
        || /返回\s*[1-5]\d{2}|[1-5]\d{2}\s*(?:状态码|响应)/i.test(line.text);
      if (!responseContext) continue;
      const declaredOperation = line.text.match(/\b(GET|HEAD|POST|PUT|PATCH|DELETE)\s+(\/[^\s|`，。,;；]+)/i);
      if (declaredOperation
        && apiKey(declaredOperation[1], declaredOperation[2].replace(/[，。,;；.]+$/, '')) !== apis[0].operationKey) {
        // A status attached to another explicit Operation belongs to that
        // unresolved requirement fact. Never contaminate the sole ApiSpec.
        continue;
      }
      for (const status of declaredResponseStatuses(line.text, line.section)) {
        addResponse(apis[0], { status, description: line.text.trim(), source: sourceOf(line, documentId) });
      }
    }
  }

  const acceptanceCriteria: AcceptanceCriterion[] = [];
  const acceptanceCriterionById = new Map<string, AcceptanceCriterion>();
  const registerAcceptanceCriterion = (criterionId: string, objective: string, line: ParsedLine): void => {
    const existing = acceptanceCriterionById.get(criterionId);
    if (!existing) {
      const criterion = { criterionId, objective, source: sourceOf(line, documentId) };
      acceptanceCriteria.push(criterion);
      acceptanceCriterionById.set(criterionId, criterion);
      return;
    }
    const same = existing.objective.replace(/\s+/g, '').toLowerCase() === objective.replace(/\s+/g, '').toLowerCase();
    warnings.push({
      code: same ? 'DUPLICATE_AC' : 'REQUIREMENT_CONFLICT', stage: 'PARSER', blocking: same ? undefined : true,
      message: same
        ? `${criterionId} 重复定义，已保留首次定义`
        : `${criterionId} 存在冲突定义，系统不会选择性保留其中一个`,
      source: sourceOf(line, documentId),
    });
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    // AC 只能在行首（允许 Markdown 标题/列表前缀）声明。API/Assertion/Evidence
    // 表格中的 “AC-001, AC-004” 只是引用，绝不能被解析成内容为逗号的新需求。
    if (!/^\s*(?:[-*+]\s+)?(?:#{1,6}\s+)?AC-\d+\b/i.test(line.text)) continue;
    const matches = [...line.text.matchAll(/\b(AC-\d+)\b\s*[:：-]?\s*([^|]*?)(?=\s+AC-\d+\b|$)/gi)];
    for (const match of matches) {
      const criterionId = match[1].toUpperCase();
      let objective = match[2].trim().replace(/^[-–—]\s*/, '');
      let objectiveLine = line;
      if (!objective && matches.length === 1) {
        const next = lines.slice(index + 1).find((candidate) => candidate.text.trim());
        if (next && next.section?.toUpperCase() === criterionId && !/^\s*(?:#|\|)/.test(next.text)) {
          objective = next.text.trim().replace(/^\s*[-*+]\s*/, '');
          objectiveLine = next;
        }
      }
      if (!objective) continue;
      registerAcceptanceCriterion(criterionId, objective, objectiveLine);
    }
  }

  const pages = lines
    .filter((line) => /页面|page|入口/i.test(line.section ?? '') || /页面/.test(line.text))
    .flatMap((line) => [...line.text.matchAll(/(^|\s|`)(\/(?!api\b)[A-Za-z][\w\-/{}/]*)/g)].map((match) => ({ line, path: match[2] })))
    .filter((item, index, all) => all.findIndex((other) => other.path === item.path) === index)
    .map((item, index) => ({ id: `PAGE-${String(index + 1).padStart(3, '0')}`, path: item.path, source: sourceOf(item.line, documentId) }));

  const permissions = lines
    // “订单只能从 PAID 转为 SHIPPED”不是权限规则。只有出现明确 Actor/Role/Auth
    // 上下文时才投影 PermissionSpec，避免凭情态词虚构 USER 角色。
    .filter((line) => !/^\s*(?:#|\|)/.test(line.text)
      && /权限|角色|管理员|普通用户|访客|未登录|无权限|越权|\b(?:user|admin|role|actor)\b/i.test(line.text)
      && /只能|可以|允许|不能|不得|禁止|拒绝|无权限|访问|查看|查询|创建|修改|更新|删除|read|write|access|allow|deny|forbid/i.test(line.text))
    .map((line, index) => {
      const explicitOperation = line.text.match(/\b(GET|HEAD|POST|PUT|PATCH|DELETE)\s+(\/[^\s|`，。,;；]+)/i);
      const operation = explicitOperation
        ? apiByKey.get(apiKey(explicitOperation[1], explicitOperation[2].replace(/[，。,;；.]+$/, '')))
        : apis.length === 1 ? apis[0] : undefined;
      return {
      id: `PERM-${String(index + 1).padStart(3, '0')}`,
      actorRole: /管理员|\badmin\b/i.test(line.text) ? 'ADMIN'
        : /普通用户|\buser\b/i.test(line.text) ? 'USER'
          : /访客|\bguest\b/i.test(line.text) ? 'GUEST' : 'UNSPECIFIED',
      action: /删除/.test(line.text) ? 'DELETE'
        : /创建|新增/.test(line.text) ? 'CREATE'
          : /修改|更新/.test(line.text) ? 'UPDATE'
            : /查看|查询|读取/.test(line.text) ? 'READ' : 'ACCESS',
      resource: `${operation?.path ?? 'UNSPECIFIED'}#${/自己的|本人|self/i.test(line.text)
        ? 'SELF' : /其他用户|目标用户|other\s+user/i.test(line.text)
          ? 'OTHER' : /跨租户|tenant\s*[ab]/i.test(line.text) ? 'CROSS_TENANT' : 'ANY'}`,
      // Permission 语句中的任意明确 4xx 都表示动作被拒绝。过去只识别
      // 401/403，会把“受保护字段返回 422”误投影成 ALLOW，并与同一 AC 的
      // 原子拒绝事实制造虚假的 ALLOW/DENY 冲突。
      effect: (/不能|不得|禁止|拒绝|无权限|\b4\d{2}\b/.test(line.text) ? 'DENY' : 'ALLOW') as 'ALLOW' | 'DENY',
      source: sourceOf(line, documentId),
      };
    });

  const isolationRules = lines
    .filter((line) => /跨租户|tenant\s*a.*tenant\s*b|跨项目|其他用户.*数据|scoped\s+to.*(?:caller|tenant|organi[sz]ation|workspace)|belong(?:s|ing)?\s+to.*(?:current|caller).*(?:tenant|organi[sz]ation|workspace)|same\s+(?:tenant|organi[sz]ation|workspace)/i.test(line.text))
    .map((line, index) => ({
      id: `ISO-${String(index + 1).padStart(3, '0')}`,
      subject: 'request-actor', resource: 'target-resource',
      dimension: (/tenant|租户/i.test(line.text) ? 'TENANT' : /项目/.test(line.text) ? 'PROJECT' : 'USER') as 'TENANT' | 'PROJECT' | 'USER',
      expected: 'DENY' as const,
      source: sourceOf(line, documentId),
    }));
  const businessRules = lines
    .filter((line) => /业务规则|business\s*rules?/i.test(line.section ?? '') && line.text.trim() && !/^#/.test(line.text))
    .map((line, index) => ({ id: `BR-${String(index + 1).padStart(3, '0')}`, description: line.text.replace(/^\s*[-*]\s*/, '').trim(), source: sourceOf(line, documentId) }));
  const stateRules = lines
    .filter((line) => /(?:状态|订单|资源).{0,20}(?:从\s*[^，。；]+\s*(?:变为|变成|转为|到)\s*[^，。；]+|(?:变为|变成|转为)\s*[^，。；]+)|state\s+(?:changes?|transitions?)\s+(?:from|to)/i.test(line.text))
    .map((line, index) => ({ id: `STATE-${String(index + 1).padStart(3, '0')}`, action: line.text.trim(), source: sourceOf(line, documentId) }));

  if (!apis.length) warnings.push({ code: 'NO_API', message: '未识别到可执行 API 定义', source: { documentId, section: title, line: 1 } });
  for (const api of apis) {
    if (!api.responses.length) warnings.push({ code: 'NO_RESPONSE', message: `${api.method} ${api.path} 未识别到 API Response 定义`, source: api.source });
  }
  if (!acceptanceCriteria.length) warnings.push({ code: 'NO_ACCEPTANCE_CRITERIA', message: '未识别到 Acceptance Criteria，测试覆盖只能按 API 契约估算', source: { documentId, section: title, line: 1 } });
  for (const api of apis) {
    const hasRequiredAuthHeader = api.headers.some((header) =>
      header.required && /^(?:authorization|cookie|x-api-key|api-key)$/i.test(header.name),
    );
    const explicitlyPublic = lines.some((line) => {
      if (!/(?:无需|不需要|免)(?:鉴权|认证|登录)|公开接口|public\s+(?:api|endpoint)|auth(?:entication)?\s+not\s+required/i.test(line.text)) return false;
      return apis.length === 1 || (line.text.includes(api.path) && new RegExp(`\\b${api.method}\\b`, 'i').test(line.text));
    });
    const globalAuthentication = lines.some((line) => /^(?:authentication|auth|认证|鉴权配置)$/i.test((line.section ?? '').trim())
      && /(?:TOKEN|Bearer|JWT|API\s*Key|Cookie|认证|鉴权)/i.test(line.text));
    if ((hasRequiredAuthHeader || globalAuthentication) && explicitlyPublic) warnings.push({
      code: 'REQUIREMENT_CONFLICT', stage: 'PARSER', blocking: true,
      message: `${api.operationKey} 同时声明必须认证和无需认证`, source: api.source,
    });
    api.authPolicy = hasRequiredAuthHeader || globalAuthentication ? 'AUTH_REQUIRED'
      : explicitlyPublic ? 'AUTH_NOT_REQUIRED' : 'AUTH_UNKNOWN';
  }
  if (!actors.length && !apis.length) {
    warnings.push({ code: 'NO_ACTOR', message: '未识别到 Actor / Role / Tenant', source: { documentId, section: title, line: 1 } });
  }
  for (const api of apis) {
    if (api.authPolicy === 'AUTH_REQUIRED' && !actors.length) {
      warnings.push({
        code: 'AUTH_REQUIRED_NO_ACTOR', stage: 'PARSER', blocking: true,
        message: `${api.operationKey} 要求认证，但未识别到可执行 Actor / 凭据引用`, source: api.source,
      });
    } else if (api.authPolicy === 'AUTH_UNKNOWN') {
      warnings.push({
        code: 'AUTH_UNKNOWN', stage: 'PARSER', blocking: true,
        message: `${api.operationKey} 未显式声明 AUTH_REQUIRED 或 AUTH_NOT_REQUIRED，anonymous 执行不能证明该接口为 public`, source: api.source,
      });
    }
  }
  for (const criterion of acceptanceCriteria) {
    if (!/成功|失败|允许|拒绝|禁止|返回|显示|保存|更新|创建|删除|可以|必须|应当|不得|[1-5]\d{2}/i.test(criterion.objective)) {
      warnings.push({ code: 'AMBIGUOUS_CRITERION', message: `${criterion.criterionId} 缺少明确可判定的预期结果`, source: criterion.source });
    }
  }

  const representedParameterLines = new Set(apis.flatMap((api) => [
    ...api.pathParams, ...api.query, ...api.headers, ...api.body,
  ]).map((parameter) => parameter.source?.line).filter((line): line is number => line !== undefined));
  const hasAuthContract = apis.some((api) => api.headers.some((header) =>
    /^(?:authorization|cookie|x-api-key|api-key)$/i.test(header.name),
  ));
  for (const line of lines) {
    const text = line.text.trim();
    if (!text || /^#|^\||^```|\bAC-\d+\b/i.test(text) || representedParameterLines.has(line.number)) continue;
    if (/"(?:properties|required|requestBody|schema)"\s*:/i.test(text)) {
      warnings.push({
        code: 'UNPARSED_CONTRACT_HINT', stage: 'PARSER', blocking: true,
        message: '检测到 JSON/OpenAPI Schema 片段，但 Markdown Parser 未将其编译为 ApiSpec 参数', source: sourceOf(line, documentId),
      });
      continue;
    }
    if (/(?:Bearer|JWT|API\s*Key|鉴权|认证|登录态|access\s*token)/i.test(text)
      && !/(?:无需|不需要|免)(?:鉴权|认证|登录)|公开接口|public\s+(?:api|endpoint)|auth(?:entication)?\s+not\s+required/i.test(text)
      && !hasAuthContract) {
      warnings.push({
        code: 'AUTH_CONTRACT_UNRESOLVED', stage: 'PARSER', blocking: true,
        message: '检测到认证约束，但未能结构化为 Auth Header 与 Actor 契约', source: sourceOf(line, documentId),
      });
      continue;
    }
    if (/(?:请求头|request\s*header|header|query|查询参数|请求体|request\s*body|body|参数).*(?:必填|required|mandatory|must\s+be\s+(?:present|provided|an?\s+integer|string|boolean)|类型|整数|字符串|boolean|范围|不可为空|必须携带)/i.test(text)
      || /(?:请求必须携带|必须传递)\s*[A-Za-z_][\w-]*/i.test(text)) {
      warnings.push({
        code: 'UNPARSED_CONTRACT_HINT', stage: 'PARSER', blocking: true,
        message: '检测到参数约束，但未能结构化到唯一 ApiSpec 参数', source: sourceOf(line, documentId),
      });
      continue;
    }
    if (/(?:响应|response).*(?:字段|包含|必须返回)\s*[A-Za-z_][\w.\[\]-]*/i.test(text)) {
      warnings.push({
        code: 'UNPARSED_RESPONSE_CONTRACT', stage: 'PARSER', blocking: true,
        message: '检测到响应字段约束，但当前 Response IR 未能完整表达', source: sourceOf(line, documentId),
      });
    }
  }
  const categories = acceptanceCriteria.map((criterion) => criterion.objective);
  const permissionGroups = new Map<string, Set<'ALLOW' | 'DENY'>>();
  const reportedPermissionConflicts = new Set<string>();
  for (const permission of permissions) {
    const key = `${permission.actorRole}|${permission.action}|${permission.resource}`;
    const effects = permissionGroups.get(key) ?? new Set<'ALLOW' | 'DENY'>();
    effects.add(permission.effect);
    permissionGroups.set(key, effects);
    if (effects.size > 1 && !reportedPermissionConflicts.has(key)) warnings.push({
      code: 'REQUIREMENT_CONFLICT', stage: 'PARSER', blocking: true,
      message: `${permission.actorRole} 对 ${permission.resource} 的 ${permission.action} 同时声明 ALLOW 与 DENY`, source: permission.source,
    });
    if (effects.size > 1) reportedPermissionConflicts.add(key);
  }
  if (isolationRules.length && !categories.some((objective) => /跨租户|跨项目|数据隔离|tenant|organi[sz]ation|workspace|scoped\s+to/i.test(objective))) {
    warnings.push({
      code: 'UNMAPPED_REQUIREMENT_RULE', stage: 'PARSER', blocking: true,
      message: '数据隔离规则没有对应 Acceptance Criterion，不能计为已验收', source: isolationRules[0].source,
    });
  }
  if (permissions.length && !categories.some((objective) => /权限|未登录|401|403|管理员|其他用户|角色/i.test(objective))) {
    warnings.push({
      code: 'UNMAPPED_REQUIREMENT_RULE', stage: 'PARSER', blocking: true,
      message: '权限规则没有对应 Acceptance Criterion，不能计为已验收', source: permissions[0].source,
    });
  }
  for (const rule of businessRules) {
    // 只有能和请求 Body 确定映射的“返回更新/创建后的数据”语义才由当前 Generator 支持。
    // “响应包含数据字段”并没有声明 data.id，不能据此虚构 JSON_PATH 断言。
    const supportedByGenerator = /返回.*(?:更新后|创建后|请求中).*(?:资料|数据|字段)/i.test(rule.description);
    if (!supportedByGenerator) warnings.push({
      code: 'UNMAPPED_REQUIREMENT_RULE', stage: 'PARSER', blocking: true,
      message: `业务规则 ${rule.id} 尚未映射为确定性 Test Point / Assertion，不能计为已验收`, source: rule.source,
    });
  }
  for (const rule of stateRules) warnings.push({
    code: 'UNVERIFIED_REQUIREMENT_FACT', stage: 'PARSER', blocking: true,
    message: `状态迁移 ${rule.id} 尚未映射为确定性 Assertion，不能仅凭 HTTP 状态判定通过`, source: rule.source,
  });
  const representedBusinessLines = new Set([
    ...businessRules.map((rule) => rule.source?.line),
    ...stateRules.map((rule) => rule.source?.line),
  ].filter((line): line is number => line !== undefined));
  for (const line of lines) {
    if (representedBusinessLines.has(line.number)) continue;
    const text = line.text.trim();
    if (!text || /^#|^\|/.test(text)) continue;
    if (/(?:发送|通知|短信|邮件|webhook|扣费|扣款|计费|收费|扣除积分|外部副作用|第三方调用|保留.*审计|审计记录|audit\s+(?:record|log)|send\s+(?:email|sms)|external\s+side\s+effect)/i.test(text)) {
      warnings.push({
        code: 'UNVERIFIED_REQUIREMENT_FACT', stage: 'PARSER', blocking: true,
        message: '检测到副作用、计费或审计语义，但当前执行链无法证明该语义', source: sourceOf(line, documentId),
      });
    } else if (/(?:名为|called|named).{0,30}(?:可选|最长|最短|不超过|格式|optional|max(?:imum)?\s+length|min(?:imum)?\s+length)/i.test(text)) {
      warnings.push({
        code: 'UNPARSED_CONTRACT_HINT', stage: 'PARSER', blocking: true,
        message: '检测到未结构化的参数约束，无法确认其 API 与参数位置', source: sourceOf(line, documentId),
      });
    }
  }

  const rootLine = lines[0] ?? { number: 1, text: title, section: title };
  const rootSource = sourceOf(rootLine, documentId);
  const features = [{ id: 'FEATURE-001', name: title, description: acceptanceCriteria[0]?.objective, source: rootSource }];
  const factLedger = buildRequirementFactLedger({
    lines,
    documentId,
    actors,
    pages,
    apis,
    permissions,
    isolationRules,
    stateRules,
    acceptanceCriteria,
    businessRules,
    warnings,
  });

  return {
    id: requirementId,
    title,
    source: rootSource,
    features,
    actors,
    pages,
    apis,
    dataModels: [],
    permissions,
    isolationRules,
    stateRules,
    acceptanceCriteria,
    businessRules,
    factLedger,
    warnings,
  };
}
