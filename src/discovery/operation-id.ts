import { createHash } from 'node:crypto';

export function normalizeHttpMethod(value: string): string {
  return value.trim().toUpperCase();
}

export function normalizeOperationPath(value: string): string {
  const trimmed = value.trim().replace(/^https?:\/\/[^/]+/i, '');
  const path = trimmed.split(/[?#]/, 1)[0] || '/';
  return (`/${path}`).replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
}

export function operationId(method: string, path: string): string {
  const normalized = `${normalizeHttpMethod(method)} ${normalizeOperationPath(path)}`;
  const readable = normalizeOperationPath(path).replace(/[{}:]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'root';
  return `api.${normalizeHttpMethod(method).toLowerCase()}.${readable}.${createHash('sha256').update(normalized).digest('hex').slice(0, 10)}`;
}
