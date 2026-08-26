import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import type { AcceptanceRequirement } from '../acceptance/requirement-ir.js';
import type {
  DevTestCapabilityStatus,
  DevTestEnvironmentCandidate,
  DevTestEnvironmentPreflight,
} from './types.js';

const LOCAL_DEFAULTS = ['http://127.0.0.1:3000', 'http://localhost:3000'];
const CONFIG_NAMES = new Set(['environments.json', 'acceptance.config.json', 'acceptance.config.example.json', '.env', '.env.local', '.env.test']);

function origin(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
    return url.origin;
  } catch { return undefined; }
}

function urlsFromText(content: string, environment: string): string[] {
  const urls = new Set<string>();
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const visit = (value: unknown, key = ''): void => {
      if (typeof value === 'string' && /(?:base.?url|test.?url|origin)/i.test(key)) {
        const normalized = origin(value);
        if (normalized) urls.add(normalized);
      } else if (value && typeof value === 'object') {
        for (const [childKey, child] of Object.entries(value as object)) {
          if (key === 'environments' && childKey !== environment) continue;
          visit(child, childKey);
        }
      }
    };
    visit(parsed);
  } catch {
    for (const match of content.matchAll(/^\s*(?:DEVTEST_BASE_URL|TESTFLOW_BASE_URL|TEST_BASE_URL|BASE_URL)\s*=\s*['"]?([^'"\s#]+)['"]?/gmi)) {
      const normalized = origin(match[1]);
      if (normalized) urls.add(normalized);
    }
  }
  return [...urls];
}

async function projectConfigCandidates(root: string, environment: string): Promise<Array<{ url: string; ref: string }>> {
  const candidates: Array<{ url: string; ref: string }> = [];
  const directories = [root, path.join(root, 'config'), path.join(root, 'config', 'env'), path.join(root, 'tests')];
  for (const directory of directories) {
    let names: string[];
    try { names = await readdir(directory); } catch { continue; }
    for (const name of names) {
      if (!CONFIG_NAMES.has(name) && !/^acceptance\..*\.json$/i.test(name)) continue;
      const file = path.join(directory, name);
      try {
        const content = await readFile(file, 'utf8');
        for (const url of urlsFromText(content, environment)) candidates.push({ url, ref: path.relative(root, file) });
      } catch { /* unreadable config is not an address candidate */ }
    }
  }
  return candidates.filter((item, index, all) => all.findIndex((candidate) => candidate.url === item.url) === index);
}

async function fetchWithTimeout(fetchImpl: typeof fetch, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('ENVIRONMENT_PROBE_TIMEOUT')), timeoutMs);
  try { return await fetchImpl(url, { ...init, signal: controller.signal, redirect: 'manual' }); }
  finally { clearTimeout(timer); }
}

async function probeCandidate(
  candidate: Omit<DevTestEnvironmentCandidate, 'reachable'>,
  requirement: AcceptanceRequirement,
  fetchImpl: typeof fetch,
): Promise<DevTestEnvironmentCandidate> {
  const safeApi = requirement.apis.find((api) => api.method === 'GET' || api.method === 'HEAD');
  let healthStatus: number | undefined;
  let apiStatus: number | undefined;
  const errors: string[] = [];
  for (const healthPath of ['/health', '/healthz', '/api/health']) {
    try {
      const response = await fetchWithTimeout(fetchImpl, new URL(healthPath, candidate.url).href, { method: 'GET' }, 800);
      healthStatus = response.status;
      if (response.status !== 404) break;
    } catch (error) { errors.push((error as Error).message); }
  }
  if (safeApi) {
    const probePath = safeApi.path.replace(/\{[^}]+\}/g, '__devtest_missing__');
    if (healthStatus !== undefined && ['/health', '/healthz', '/api/health'].includes(probePath)) apiStatus = healthStatus;
    else try {
      const response = await fetchWithTimeout(fetchImpl, new URL(probePath, candidate.url).href, { method: safeApi.method }, 1000);
      apiStatus = response.status;
    } catch (error) { errors.push((error as Error).message); }
  }
  const reachable = healthStatus !== undefined || apiStatus !== undefined;
  return { ...candidate, reachable, healthStatus, apiStatus, error: reachable ? undefined : [...new Set(errors)].join('；') || 'NETWORK_UNREACHABLE' };
}

async function browserStatus(required: boolean): Promise<DevTestCapabilityStatus> {
  if (!required) return 'NOT_REQUIRED';
  try {
    const playwright = await import('playwright');
    const browser = await playwright.chromium.launch({ headless: true });
    await browser.close();
    return 'READY';
  } catch { return 'BLOCKED'; }
}

export async function discoverDevTestEnvironment(input: {
  explicitBaseUrl?: string;
  environment: string;
  projectRoot: string;
  requirement: AcceptanceRequirement;
  actorHeaders?: Record<string, Record<string, string>>;
  fetchImpl?: typeof fetch;
  /** DRY_RUN 只解析候选地址和能力需求，禁止发出 Health/API 探针。 */
  probeNetwork?: boolean;
}): Promise<DevTestEnvironmentPreflight> {
  const raw: Array<Omit<DevTestEnvironmentCandidate, 'reachable'>> = [];
  const add = (value: string | undefined, source: DevTestEnvironmentCandidate['source'], sourceRef: string): void => {
    if (!value) return;
    const url = origin(value);
    if (url && !raw.some((item) => item.url === url)) raw.push({ url, source, sourceRef });
  };
  if (input.explicitBaseUrl) add(input.explicitBaseUrl, 'CLI', '--base-url');
  else {
    for (const name of ['DEVTEST_BASE_URL', 'TESTFLOW_BASE_URL', 'TEST_BASE_URL']) add(process.env[name], 'ENV', name);
    for (const item of await projectConfigCandidates(input.projectRoot, input.environment)) add(item.url, 'PROJECT_CONFIG', item.ref);
    if (!raw.length || input.environment === 'local') for (const value of LOCAL_DEFAULTS) add(value, 'LOCAL_DEFAULT', 'local convention');
  }
  if (!raw.length) throw new Error('DEVTEST_ENVIRONMENT_NO_CANDIDATE：没有显式、环境变量、项目配置或本机候选地址');
  const probeNetwork = input.probeNetwork !== false;
  const candidates = probeNetwork
    ? await Promise.all(raw.map((candidate) => probeCandidate(candidate, input.requirement, input.fetchImpl ?? fetch)))
    : raw.map((candidate) => ({ ...candidate, reachable: false, error: 'DRY_RUN_ENVIRONMENT_NOT_PROBED' }));
  const reachable = candidates.filter((candidate) => candidate.reachable);
  const explicit = candidates.find((candidate) => candidate.source === 'CLI');
  const ambiguous = probeNetwork && !explicit && reachable.length > 1;
  const selected = explicit ?? (probeNetwork && reachable.length === 1 ? reachable[0] : undefined);
  const uiRequired = input.requirement.pages.length > 0 || input.requirement.factLedger.some((fact) => fact.category === 'UI');
  const authRequired = input.requirement.apis.some((api) => api.authPolicy === 'AUTH_REQUIRED');
  const isolationRequired = input.requirement.isolationRules.length > 0 || input.requirement.permissions.length > 0;
  const availableIdentities = Object.keys(input.actorHeaders ?? {}).length;
  const requiredIdentities = isolationRequired ? 2 : authRequired ? 1 : 0;
  const authReady: DevTestCapabilityStatus = requiredIdentities === 0 ? 'NOT_REQUIRED'
    : availableIdentities >= requiredIdentities ? 'READY' : 'BLOCKED';
  const apiStatus: DevTestCapabilityStatus = !input.requirement.apis.length ? 'NOT_REQUIRED'
    : selected?.apiStatus !== undefined && selected.apiStatus !== 404 ? 'READY' : selected?.reachable ? 'UNKNOWN' : 'BLOCKED';
  const health: DevTestCapabilityStatus = selected?.healthStatus !== undefined && selected.healthStatus !== 404 ? 'READY'
    : selected?.reachable ? 'UNKNOWN' : 'BLOCKED';
  const browser = probeNetwork ? await browserStatus(uiRequired) : uiRequired ? 'UNKNOWN' : 'NOT_REQUIRED';
  const database: DevTestCapabilityStatus = process.env.DATABASE_URL ? 'UNKNOWN' : 'BLOCKED';
  const parameterRequired = input.requirement.apis.some((api) => [
    ...api.headers, ...api.query, ...api.pathParams, ...api.body,
  ].some((parameter) => parameter.required || parameter.min !== undefined || parameter.max !== undefined
    || parameter.minLength !== undefined || parameter.maxLength !== undefined || parameter.enum !== undefined || parameter.pattern !== undefined));
  const applicable = new Set<DevTestEnvironmentPreflight['executableDimensions'][number]>();
  if (input.requirement.apis.length) applicable.add('API');
  if (input.requirement.factLedger.some((fact) => ['FUNCTIONAL', 'BUSINESS_RULE', 'STATE', 'SIDE_EFFECT'].includes(fact.category))) applicable.add('FUNCTIONAL');
  if (uiRequired) applicable.add('UI');
  if (isolationRequired) applicable.add('DATA_ISOLATION');
  if (parameterRequired || input.requirement.factLedger.some((fact) => ['VALIDATION', 'BOUNDARY'].includes(fact.category))) applicable.add('PARAMETER_VALIDATION');
  const blockedDimensions: DevTestEnvironmentPreflight['blockedDimensions'] = [];
  if (!probeNetwork) {
    for (const dimension of applicable) blockedDimensions.push({ dimension, reason: 'DRY_RUN_ENVIRONMENT_NOT_PROBED' });
  } else if (!selected || ambiguous) {
    for (const dimension of applicable) {
      blockedDimensions.push({ dimension, reason: ambiguous ? 'AMBIGUOUS_ENVIRONMENT' : 'NETWORK_UNREACHABLE' });
    }
  }
  if (uiRequired && browser !== 'READY' && !blockedDimensions.some((item) => item.dimension === 'UI')) {
    blockedDimensions.push({ dimension: 'UI', reason: 'BROWSER_UNAVAILABLE' });
  }
  if (requiredIdentities > 0 && authReady !== 'READY' && applicable.has('DATA_ISOLATION')
    && !blockedDimensions.some((item) => item.dimension === 'DATA_ISOLATION')) {
    blockedDimensions.push({ dimension: 'DATA_ISOLATION', reason: 'AUTH_CONTEXT_INCOMPLETE' });
  }
  const executableDimensions = [...applicable].filter((dimension) => !blockedDimensions.some((item) => item.dimension === dimension));
  const criticalReady = probeNetwork && Boolean(selected?.reachable) && !ambiguous;
  const hasCapabilityGaps = blockedDimensions.length > 0 || health !== 'READY' || apiStatus === 'UNKNOWN'
    || !(['READY', 'NOT_REQUIRED'] as DevTestCapabilityStatus[]).includes(database);
  const status = !criticalReady ? 'BLOCKED' : hasCapabilityGaps ? 'PARTIAL' : 'READY';
  return {
    status,
    selectedBaseUrl: selected?.url,
    reason: !probeNetwork ? 'DRY_RUN_ENVIRONMENT_NOT_PROBED：DRY_RUN 禁止 Health/API 网络探针'
      : ambiguous ? `AMBIGUOUS_ENVIRONMENT：多个候选可访问：${reachable.map((item) => item.url).join(', ')}`
        : !selected ? 'NETWORK_UNREACHABLE：没有候选地址可访问' : undefined,
    ambiguous,
    candidates,
    checks: { baseUrl: selected && !ambiguous ? 'READY' : 'BLOCKED', health, authentication: authReady, api: apiStatus, browser, database },
    executableDimensions: [...executableDimensions],
    blockedDimensions,
  };
}
