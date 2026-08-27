import { execFile } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { AcceptanceRequirement } from '../acceptance/requirement-ir.js';
import { discoverOpenApi, discoverFrontendNetworkFromSource, discoverRoutesFromSource, mergeOperations } from '../discovery/api/source-scanners.js';
import type { DiscoveredOperation } from '../discovery/types.js';
import type { DevTestDiscoveryResult, DevTestUiElement } from './types.js';

const execFileAsync = promisify(execFile);
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.php', '.java', '.kt', '.py', '.go', '.rb', '.json']);
const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', 'output', 'devtest-results', '.next', '.nuxt', 'vendor']);
const MAX_FILES = 1500;
const MAX_FILE_BYTES = 2_000_000;

interface InspectedFile { relative: string; content: string }

function eligible(file: string): boolean {
  return SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase())
    && !file.split(/[\\/]/).some((part) => IGNORED_DIRECTORIES.has(part));
}

async function changedFiles(root: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
    });
    const entries = stdout.split('\0').filter(Boolean);
    const files: string[] = [];
    for (const entry of entries) {
      const raw = entry.slice(3);
      const file = raw.includes(' -> ') ? raw.split(' -> ').at(-1)! : raw;
      if (eligible(file)) files.push(file);
    }
    return [...new Set(files)];
  } catch {
    return [];
  }
}

async function walk(root: string, current = root, output: string[] = []): Promise<string[]> {
  if (output.length >= MAX_FILES) return output;
  let entries;
  try { entries = await readdir(current, { withFileTypes: true }); } catch { return output; }
  for (const entry of entries) {
    if (output.length >= MAX_FILES) break;
    if (entry.isSymbolicLink() || IGNORED_DIRECTORIES.has(entry.name)) continue;
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) await walk(root, absolute, output);
    else if (entry.isFile()) {
      const relative = path.relative(root, absolute);
      if (eligible(relative)) output.push(relative);
    }
  }
  return output;
}

async function inspectFiles(root: string, files: readonly string[]): Promise<{ inspected: InspectedFile[]; warnings: string[] }> {
  const inspected: InspectedFile[] = [];
  const warnings: string[] = [];
  for (const relative of files.slice(0, MAX_FILES)) {
    const absolute = path.resolve(root, relative);
    if (!absolute.startsWith(`${path.resolve(root)}${path.sep}`)) continue;
    try {
      const info = await stat(absolute);
      if (!info.isFile() || info.size > MAX_FILE_BYTES) continue;
      inspected.push({ relative, content: await readFile(absolute, 'utf8') });
    } catch (error) {
      warnings.push(`DISCOVERY_FILE_UNREADABLE：${relative}：${(error as Error).message}`);
    }
  }
  return { inspected, warnings };
}

function openApiOperations(file: InspectedFile): DiscoveredOperation[] {
  if (!/(?:openapi|swagger)/i.test(file.relative) || path.extname(file.relative).toLowerCase() !== '.json') return [];
  try {
    const document = JSON.parse(file.content) as { paths?: Record<string, Record<string, unknown>> };
    return document.paths ? discoverOpenApi(document, file.relative) : [];
  } catch {
    return [];
  }
}

function uiElements(file: InspectedFile): DevTestUiElement[] {
  if (!/\.(?:tsx|jsx|vue|svelte|ts|js)$/i.test(file.relative)) return [];
  const result: DevTestUiElement[] = [];
  const add = (kind: DevTestUiElement['kind'], name: string, confidence: number, selector?: string): void => {
    const normalized = name.trim();
    if (!normalized || result.some((item) => item.kind === kind && item.name === normalized)) return;
    result.push({ kind, name: normalized, source: file.relative, confidence, selector });
  };
  for (const match of file.content.matchAll(/(?:<Route[^>]*\bpath|\bpath)\s*(?:=|:)\s*["'{`]([^"'`}]+)["'}`]/gi)) add('PAGE', match[1], 0.86);
  const nextPage = file.relative.match(/(?:^|\/)app\/(.+?)\/page\.(?:tsx|jsx|ts|js)$/i);
  if (nextPage) add('PAGE', `/${nextPage[1].replace(/\([^/]+\)\//g, '').replace(/\[([^\]]+)\]/g, '{$1}')}`, 0.9);
  for (const match of file.content.matchAll(/<([A-Za-z][\w.-]*)[^>]*data-testid=["']([^"']+)["'][^>]*>/gi)) {
    const tag = match[1].toLowerCase();
    const kind: DevTestUiElement['kind'] = tag === 'button' ? 'BUTTON' : ['input', 'textarea', 'select'].includes(tag) ? 'INPUT'
      : tag === 'form' ? 'FORM' : /dialog|modal/.test(tag) ? 'DIALOG' : 'DETAIL';
    add(kind, match[2], 0.98, `[data-testid=${JSON.stringify(match[2])}]`);
  }
  for (const match of file.content.matchAll(/<button[^>]*(?:name|id)=["']([^"']+)["'][^>]*>/gi)) {
    const attribute = /\bname=/.test(match[0]) ? 'name' : 'id';
    add('BUTTON', match[1], 0.94, `[${attribute}=${JSON.stringify(match[1])}]`);
  }
  for (const match of file.content.matchAll(/<button[^>]*(?:aria-label|title)=["']([^"']+)["'][^>]*>|<button[^>]*>([^<{]{1,80})/gi)) add('BUTTON', match[1] ?? match[2], 0.82);
  if (/<form\b/i.test(file.content)) add('FORM', path.basename(file.relative), 0.8);
  for (const match of file.content.matchAll(/<(?:input|textarea|select)[^>]*name=["']([^"']+)["']/gi)) add('INPUT', match[1], 0.94, `[name=${JSON.stringify(match[1])}]`);
  for (const match of file.content.matchAll(/<(?:input|textarea|select)[^>]*aria-label=["']([^"']+)["']/gi)) add('INPUT', match[1], 0.82);
  if (/<(?:dialog|Modal|Dialog)\b/i.test(file.content)) add('DIALOG', path.basename(file.relative), 0.78);
  if (/\b(?:Table|List|v-for|\.map\s*\()\b/i.test(file.content)) add('LIST', path.basename(file.relative), 0.7);
  if (/\b(?:Detail|详情)\b/i.test(file.content)) add('DETAIL', path.basename(file.relative), 0.72);
  return result;
}

const TRANSLATIONS: ReadonlyArray<[RegExp, string[]]> = [
  [/用户|个人/, ['user']], [/资料|档案/, ['profile']], [/订单/, ['order']], [/任务/, ['task']],
  [/项目/, ['project']], [/租户/, ['tenant']], [/支付|付款/, ['payment', 'billing']],
  [/通知|消息/, ['notification', 'message']], [/列表/, ['list']], [/详情/, ['detail']],
  [/创建|新增/, ['create', 'post']], [/修改|更新|编辑/, ['update', 'patch', 'put']],
  [/删除/, ['delete']], [/查询|查看|获取/, ['get', 'read']],
];

function semanticTokens(requirement: AcceptanceRequirement): string[] {
  const text = [requirement.title, ...requirement.acceptanceCriteria.map((item) => item.objective),
    ...requirement.factLedger.map((item) => `${item.statement} ${item.canonical.resource.kind}`)].join(' ').toLowerCase();
  const tokens = new Set(text.match(/[a-z][a-z0-9_-]{2,}/g) ?? []);
  for (const [pattern, values] of TRANSLATIONS) if (pattern.test(text)) values.forEach((value) => tokens.add(value));
  return [...tokens].filter((token) => !['api', 'the', 'and', 'with', 'must', 'should', 'return'].includes(token));
}

function operationScore(operation: DiscoveredOperation, tokens: readonly string[], requirement: AcceptanceRequirement): number {
  const haystack = `${operation.method} ${operation.path} ${operation.source.map((item) => item.ref).join(' ')}`.toLowerCase();
  let score = tokens.filter((token) => haystack.includes(token)).length;
  const actions = new Set(requirement.factLedger.map((fact) => fact.canonical.action.kind));
  if ((operation.method === 'POST' && (actions.has('CREATE') || actions.has('SUBMIT')))
    || (['PUT', 'PATCH'].includes(operation.method) && actions.has('UPDATE'))
    || (operation.method === 'DELETE' && actions.has('DELETE'))
    || (['GET', 'HEAD'].includes(operation.method) && actions.has('READ'))) score += 2;
  return score;
}

function mapOperations(
  operations: readonly DiscoveredOperation[], requirement: AcceptanceRequirement, scope: DevTestDiscoveryResult['scope'],
): { mapped: DiscoveredOperation[]; reasons: string[] } {
  const backend = operations.filter((operation) => operation.source.some((source) => ['ROUTE', 'CONTROLLER', 'OPENAPI'].includes(source.type)));
  const frontend = operations.filter((operation) => operation.source.some((source) => source.type === 'FRONTEND'));
  const sourceLabel = (operation: DiscoveredOperation): string => operation.source
    .map((source) => `${source.type}:${source.ref}@${source.confidence.toFixed(2)}`).join(', ');
  if (requirement.apis.length) {
    const explicit = new Set(requirement.apis.map((api) => api.operationKey));
    const backendMatches = backend.filter((operation) => explicit.has(`${operation.method} ${operation.path}`));
    const mapped = backendMatches.length
      ? backendMatches
      : frontend.filter((operation) => explicit.has(`${operation.method} ${operation.path}`));
    return {
      mapped,
      reasons: mapped.map((item) => `${item.method} ${item.path} 与 Requirement 显式 Operation 精确匹配；推导契约来源 ${sourceLabel(item)}`),
    };
  }
  const tokens = semanticTokens(requirement);
  const select = (pool: readonly DiscoveredOperation[]): DiscoveredOperation[] => {
    if (!pool.length) return [];
    const scored = pool.map((operation) => ({ operation, score: operationScore(operation, tokens, requirement) }));
    // Changed-files 中的唯一候选可作为当前功能线索；全项目唯一但语义无关的接口仍保持 UNKNOWN。
    if (scope === 'CHANGED_FILES' && pool.length === 1) return [pool[0]];
    const high = scored.filter((item) => item.score >= 3);
    if (!high.length) return [];
    const best = Math.max(...high.map((item) => item.score));
    return high.filter((item) => item.score >= best - 1).map((item) => item.operation).slice(0, 8);
  };
  // 后端 Route/Controller/OpenAPI 优先；只有无法建立足够强的语义映射时才回退前端实际调用。
  const backendMapped = select(backend);
  const mapped = backendMapped.length ? backendMapped : select(frontend);
  if (!mapped.length) return {
    mapped: [],
    reasons: ['代码/前端中存在 API 候选，但没有精确或足够强的 Requirement 语义映射；保持 UNKNOWN'],
  };
  return {
    mapped,
    reasons: mapped.map((item) => `${item.method} ${item.path} 与 Feature/Resource/Action 语义匹配；推导契约来源 ${sourceLabel(item)}`),
  };
}

function mapUi(elements: readonly DevTestUiElement[], requirement: AcceptanceRequirement, scope: DevTestDiscoveryResult['scope']): DevTestUiElement[] {
  const uiRequired = requirement.factLedger.some((fact) => fact.category === 'UI') || requirement.pages.length > 0
    || /页面|按钮|表单|弹窗|列表|详情|\bui\b/i.test(requirement.title);
  if (!uiRequired) return [];
  const pages = elements.filter((item) => item.kind === 'PAGE');
  if (scope === 'CHANGED_FILES' || pages.length === 1) return elements.slice(0, 50);
  const tokens = semanticTokens(requirement);
  const sources = new Set(pages.filter((item) => tokens.some((token) => `${item.name} ${item.source}`.toLowerCase().includes(token)))
    .map((item) => item.source));
  return elements.filter((item) => sources.has(item.source)).slice(0, 50);
}

export async function discoverDevTestProject(input: {
  projectRoot: string; requirement: AcceptanceRequirement; enabled?: boolean;
}): Promise<DevTestDiscoveryResult> {
  const root = path.resolve(input.projectRoot);
  if (input.enabled === false) return {
    projectRoot: root, scope: 'DISABLED', inspectedFiles: 0, operations: [], mappedOperations: [],
    ui: [], mappedUi: [], warnings: [], mappingReasons: ['项目发现被显式关闭'],
  };
  const changed = await changedFiles(root);
  let scope: DevTestDiscoveryResult['scope'] = changed.length ? 'CHANGED_FILES' : 'PROJECT_FILES';
  let files = changed;
  if (!files.length) files = await walk(root);
  let inspectedResult = await inspectFiles(root, files);
  let operations = mergeOperations(inspectedResult.inspected.flatMap((file) => [
    ...discoverRoutesFromSource(file.content, file.relative),
    ...discoverFrontendNetworkFromSource(file.content, file.relative),
    ...openApiOperations(file),
  ]));
  // A dirty tree may contain only docs/config. Fall back to project scope when no discoverable API/UI signal exists.
  let ui = inspectedResult.inspected.flatMap(uiElements);
  if (scope === 'CHANGED_FILES' && !operations.length && !ui.length) {
    scope = 'PROJECT_FILES';
    files = await walk(root);
    inspectedResult = await inspectFiles(root, files);
    operations = mergeOperations(inspectedResult.inspected.flatMap((file) => [
      ...discoverRoutesFromSource(file.content, file.relative),
      ...discoverFrontendNetworkFromSource(file.content, file.relative),
      ...openApiOperations(file),
    ]));
    ui = inspectedResult.inspected.flatMap(uiElements);
  }
  let mapping = mapOperations(operations, input.requirement, scope);
  // Changed-files 优先用于“本次功能”定位；显式 API 未命中时必须继续全项目精确查找，不能提前停止。
  if (scope === 'CHANGED_FILES' && input.requirement.apis.length > 0 && mapping.mapped.length === 0) {
    scope = 'PROJECT_FILES';
    files = await walk(root);
    inspectedResult = await inspectFiles(root, files);
    operations = mergeOperations(inspectedResult.inspected.flatMap((file) => [
      ...discoverRoutesFromSource(file.content, file.relative),
      ...discoverFrontendNetworkFromSource(file.content, file.relative),
      ...openApiOperations(file),
    ]));
    ui = inspectedResult.inspected.flatMap(uiElements);
    mapping = mapOperations(operations, input.requirement, scope);
  }
  const mappedUi = mapUi(ui, input.requirement, scope);
  return {
    projectRoot: root, scope, inspectedFiles: inspectedResult.inspected.length,
    operations, mappedOperations: mapping.mapped, ui, mappedUi,
    warnings: inspectedResult.warnings, mappingReasons: mapping.reasons,
  };
}

function responseStatuses(operation: DiscoveredOperation): number[] {
  if (operation.observed) return [operation.observed.status];
  if (!operation.responseSchema || typeof operation.responseSchema !== 'object' || Array.isArray(operation.responseSchema)) return [];
  return Object.keys(operation.responseSchema as object).filter((key) => /^[1-5]\d{2}$/.test(key)).map(Number);
}

function authRequired(operation: DiscoveredOperation): boolean | undefined {
  if (!operation.auth || typeof operation.auth !== 'object') return undefined;
  const value = (operation.auth as { required?: unknown }).required;
  return typeof value === 'boolean' ? value : undefined;
}

/** 仅把权威且已映射的源码 Contract 投影为 Parser 可消费的结构化附录；不补猜参数或响应。 */
export function appendDiscoveredContracts(markdown: string, discovery: DevTestDiscoveryResult, hasExplicitApis: boolean): string {
  const sections: string[] = [];
  if (!hasExplicitApis) {
    for (const operation of discovery.mappedOperations) {
      sections.push(`### Discovered Contract ${operation.method} ${operation.path}`);
      sections.push(`\`${operation.method} ${operation.path}\``);
      sections.push(`<!-- source: ${operation.source.map((item) => `${item.type}:${item.ref}`).join(', ')} -->`);
      sections.push(`> 推导契约；来源：${operation.source.map((item) => `${item.type}:${item.ref}`).join(', ')}；置信度：${operation.confidence.toFixed(2)}。`);
      const auth = authRequired(operation);
      if (auth === false) sections.push('公开接口，无需认证。');
      else if (auth === true) sections.push('| 参数 | 类型 | 位置 | 必填 |\n| --- | --- | --- | --- |\n| Authorization | string | header | true |');
      const body = inlineBodySchema(operation);
      if (body) {
        const rows = Object.entries(body.properties).map(([name, schema]) => {
          const range = schema.minLength !== undefined || schema.maxLength !== undefined
            ? `${schema.minLength ?? ''}~${schema.maxLength ?? ''}` : schema.minimum !== undefined || schema.maximum !== undefined
              ? `${schema.minimum ?? ''}~${schema.maximum ?? ''}` : '';
          return `| ${name} | body | ${String(schema.type ?? 'unknown')} | ${body.required.includes(name)} | ${range} | ${Array.isArray(schema.enum) ? schema.enum.join(',') : ''} |`;
        });
        sections.push(`| 参数 | 位置 | 类型 | 必填 | 范围 | 枚举 |\n| --- | --- | --- | --- | --- | --- |\n${rows.join('\n')}`);
      }
      const statuses = responseStatuses(operation);
      if (statuses.length) sections.push(`| 状态码 | 描述 |\n| --- | --- |\n${statuses.map((status) => `| ${status} | 来自发现 Contract |`).join('\n')}`);
    }
  }
  if (!/\/(?!api\b)[A-Za-z][\w\-/{}/]*/.test(markdown)) {
    const page = discovery.mappedUi.find((item) => item.kind === 'PAGE' && item.name.startsWith('/'));
    if (page) sections.push(`## 页面\n\n- 页面入口 ${page.name}\n<!-- source: ${page.source} -->`);
  }
  return sections.length ? `${markdown.trimEnd()}\n\n## DevTest Discovery Contracts\n\n${sections.join('\n\n')}\n` : markdown;
}

function inlineBodySchema(operation: DiscoveredOperation): { properties: Record<string, Record<string, unknown>>; required: string[] } | undefined {
  if (!operation.requestSchema || typeof operation.requestSchema !== 'object') return undefined;
  const request = operation.requestSchema as Record<string, unknown>;
  const content = request.content as Record<string, unknown> | undefined;
  const media = content && (content['application/json'] ?? Object.values(content)[0]);
  const schema = media && typeof media === 'object' ? (media as Record<string, unknown>).schema : request.schema ?? request;
  if (!schema || typeof schema !== 'object') return undefined;
  const record = schema as Record<string, unknown>;
  if (!record.properties || typeof record.properties !== 'object') return undefined;
  return {
    properties: record.properties as Record<string, Record<string, unknown>>,
    required: Array.isArray(record.required) ? record.required.map(String) : [],
  };
}

/** Requirement 与权威 OpenAPI 参数冲突时只报告冲突，不自动选择任一值。 */
export function discoverParameterContractConflicts(
  requirement: AcceptanceRequirement,
  discovery: DevTestDiscoveryResult,
): Array<{ code: string; message: string }> {
  const conflicts: Array<{ code: string; message: string }> = [];
  for (const api of requirement.apis) {
    const operation = discovery.mappedOperations.find((item) => `${item.method} ${item.path}` === api.operationKey);
    const schema = operation && inlineBodySchema(operation);
    if (!schema) continue;
    for (const parameter of api.body) {
      const discovered = schema.properties[parameter.name];
      if (!discovered) continue;
      const comparisons: Array<[string, unknown, unknown]> = [
        ['type', parameter.type === 'integer' ? 'integer' : parameter.type, discovered.type],
        ['min', parameter.min, discovered.minimum], ['max', parameter.max, discovered.maximum],
        ['minLength', parameter.minLength, discovered.minLength], ['maxLength', parameter.maxLength, discovered.maxLength],
        ['enum', parameter.enum, discovered.enum],
        ['required', parameter.required, schema.required.includes(parameter.name)],
      ];
      for (const [name, expected, actual] of comparisons) {
        if (expected === undefined || actual === undefined || JSON.stringify(expected) === JSON.stringify(actual)) continue;
        conflicts.push({
          code: 'PARAMETER_CONTRACT_CONFLICT',
          message: `${api.operationKey} 参数 ${parameter.name}.${name} 冲突：Requirement=${JSON.stringify(expected)} OpenAPI=${JSON.stringify(actual)}`,
        });
      }
    }
  }
  return conflicts;
}
