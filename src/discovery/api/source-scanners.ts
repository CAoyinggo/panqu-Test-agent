import { operationId, normalizeHttpMethod, normalizeOperationPath } from '../operation-id.js';
import type { DiscoveredOperation, DiscoverySource, DiscoverySourceType } from '../types.js';

const HTTP_METHOD = '(get|head|options|post|put|patch|delete)';

function source(type: DiscoverySourceType, ref: string, confidence: number): DiscoverySource {
  return { type, ref, confidence };
}

function operation(method: string, path: string, discoveredSource: DiscoverySource, extra: Partial<DiscoveredOperation> = {}): DiscoveredOperation {
  const normalizedMethod = normalizeHttpMethod(method);
  const normalizedPath = normalizeOperationPath(path);
  return {
    id: operationId(normalizedMethod, normalizedPath), method: normalizedMethod, path: normalizedPath,
    source: [discoveredSource], confidence: discoveredSource.confidence,
    safeProbe: ['GET', 'HEAD', 'OPTIONS'].includes(normalizedMethod), ...extra,
  };
}

/** Express/Fastify/Koa-like routes and common PHP route declarations. */
export function discoverRoutesFromSource(content: string, ref: string): DiscoveredOperation[] {
  const found: DiscoveredOperation[] = [];
  const patterns = [
    new RegExp(`(?:app|router|server|route)\\s*\\.\\s*${HTTP_METHOD}\\s*\\(\\s*['\"]([^'\"]+)['\"]`, 'gi'),
    new RegExp(`Route\\s*::\\s*${HTTP_METHOD}\\s*\\(\\s*['\"]([^'\"]+)['\"]`, 'gi'),
    new RegExp(`@(Get|Head|Options|Post|Put|Patch|Delete)(?:Mapping)?\\s*\\(\\s*['\"]([^'\"]+)['\"]`, 'gi'),
  ];
  for (const [index, pattern] of patterns.entries()) {
    for (const match of content.matchAll(pattern)) {
      const method = match[1];
      const path = match[2];
      if (!method || !path) continue;
      found.push(operation(method, path, source(index === 2 ? 'CONTROLLER' : 'ROUTE', ref, index === 2 ? 0.84 : 0.9)));
    }
  }
  return mergeOperations(found);
}

/** fetch/axios/client calls are candidates, never authoritative runtime truth. */
export function discoverFrontendNetworkFromSource(content: string, ref: string): DiscoveredOperation[] {
  const found: DiscoveredOperation[] = [];
  for (const match of content.matchAll(/fetch\s*\(\s*['"`]([^'"`]+)['"`](?:\s*,\s*\{([\s\S]{0,500}?)\})?/gi)) {
    const method = /method\s*:\s*['"](GET|HEAD|OPTIONS|POST|PUT|PATCH|DELETE)['"]/i.exec(match[2] ?? '')?.[1] ?? 'GET';
    found.push(operation(method, match[1], source('FRONTEND', ref, 0.72)));
  }
  for (const match of content.matchAll(/axios\s*\.\s*(get|head|options|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/gi)) {
    found.push(operation(match[1], match[2], source('FRONTEND', ref, 0.75)));
  }
  for (const match of content.matchAll(/axios\s*\(\s*\{([\s\S]{0,800}?)\}\s*\)/gi)) {
    const url = /url\s*:\s*['"`]([^'"`]+)['"`]/i.exec(match[1])?.[1];
    if (!url) continue;
    const method = /method\s*:\s*['"](GET|HEAD|OPTIONS|POST|PUT|PATCH|DELETE)['"]/i.exec(match[1])?.[1] ?? 'GET';
    found.push(operation(method, url, source('FRONTEND', ref, 0.72)));
  }
  return mergeOperations(found);
}

export interface OpenApiDocument {
  paths?: Record<string, Record<string, unknown>>;
  components?: unknown;
}

export function discoverOpenApi(document: OpenApiDocument, ref: string): DiscoveredOperation[] {
  const found: DiscoveredOperation[] = [];
  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    for (const [method, raw] of Object.entries(pathItem)) {
      if (!/^(get|head|options|post|put|patch|delete)$/i.test(method) || !raw || typeof raw !== 'object') continue;
      const spec = raw as Record<string, unknown>;
      const security = spec.security;
      const responses = spec.responses;
      const requestBody = spec.requestBody;
      const sideEffects = ['post', 'put', 'patch', 'delete'].includes(method.toLowerCase()) ? ['DATA_MUTATION_POSSIBLE'] : [];
      found.push(operation(method, path, source('OPENAPI', `${ref}#${method.toUpperCase()} ${path}`, 0.82), {
        requestSchema: requestBody, responseSchema: responses,
        auth: security === undefined ? undefined : { required: Array.isArray(security) ? security.length > 0 : true, security },
        sideEffects,
        safeProbe: ['get', 'head', 'options'].includes(method.toLowerCase()),
      }));
    }
  }
  return mergeOperations(found);
}

export function mergeOperations(operations: readonly DiscoveredOperation[]): DiscoveredOperation[] {
  const grouped = new Map<string, DiscoveredOperation>();
  for (const item of operations) {
    const existing = grouped.get(item.id);
    if (!existing) {
      grouped.set(item.id, { ...item, source: [...item.source], sideEffects: [...(item.sideEffects ?? [])] });
      continue;
    }
    existing.source = [...existing.source, ...item.source].filter((candidate, index, all) => (
      all.findIndex((other) => other.type === candidate.type && other.ref === candidate.ref) === index
    ));
    existing.confidence = Math.max(existing.confidence, item.confidence);
    existing.requestSchema ??= item.requestSchema;
    existing.responseSchema ??= item.responseSchema;
    existing.auth ??= item.auth;
    existing.sideEffects = [...new Set([...(existing.sideEffects ?? []), ...(item.sideEffects ?? [])])];
    existing.safeProbe = existing.safeProbe === true || item.safeProbe === true;
    existing.observed ??= item.observed;
  }
  return [...grouped.values()].sort((left, right) => `${left.path}:${left.method}`.localeCompare(`${right.path}:${right.method}`));
}
