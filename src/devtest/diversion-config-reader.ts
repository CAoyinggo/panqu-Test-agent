/**
 * DiversionConfigReader — 只读读取 NewAPI 分流「运行时资格」配置并桥接判定模块
 * =============================================================================
 * 闭环最后一环：`pq_aivideo_diversion_config`(line=10) 的 `newapi_route_rules` /
 * `newapi_route_group_rules` / `newapi_route_mode` / `newapi_global_api_key` +
 * `pq_model_config`(is_newapi_global/newapi_model_alias) 才是运行时资格真源。
 * 本模块经可注入执行器（默认 `scripts/read-diversion-config.py` 走 SSH 隧道，只读）拉取，
 * fail-closed；测试注入假执行器即可 100% 离线覆盖成功/失败/脱敏分支。
 * 复用 `database-evidence-producer` 的凭据定位与脱敏，seam 与 DB 取证一致。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveDatabaseCredentialsPath,
  sanitizeErrorMessage,
  type DbScriptRunner,
} from './database-evidence-producer.js';
import type { RouteRules, GroupedRouteRules, RouteMode } from './newapi-route-eligibility.js';

const execFileAsync = promisify(execFile);

export interface DiversionConfigRawCollection {
  status: 'VERIFIED' | 'UNVERIFIED';
  routeMode: string | null;
  routeRules: RouteRules;
  groupRules: GroupedRouteRules;
  globalApiKeyConfigured: boolean;
  globalModelIds: number[];
  aliasMap: Record<string, string>;
  reason?: string;
  error?: string;
  credPath?: string;
  queriedAt?: string;
}

export interface DiversionConfigReadOptions {
  credPath?: string;
  scriptPath?: string;
  timeoutMs?: number;
}

function resolveConfigScriptPath(explicit?: string): string | undefined {
  if (explicit && existsSync(explicit)) return explicit;
  const currentDir = typeof __dirname !== 'undefined' ? __dirname : fileURLToPath(new URL('.', import.meta.url));
  const candidates = [
    join(process.cwd(), 'scripts', 'read-diversion-config.py'),
    join(currentDir, '..', '..', 'scripts', 'read-diversion-config.py'),
    join(currentDir, '..', '..', '..', 'scripts', 'read-diversion-config.py'),
    '/Users/mac/agents/test-flow/scripts/read-diversion-config.py',
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return undefined;
}

const EMPTY = (): Pick<
  DiversionConfigRawCollection,
  'routeMode' | 'routeRules' | 'groupRules' | 'globalApiKeyConfigured' | 'globalModelIds' | 'aliasMap'
> => ({
  routeMode: null,
  routeRules: {},
  groupRules: {},
  globalApiKeyConfigured: false,
  globalModelIds: [],
  aliasMap: {},
});

// APPEND_READER

/** 只读拉取分流资格配置（可注入执行器）。fail-closed：任何缺失/失败→UNVERIFIED，绝不臆造规则。 */
export async function readDiversionConfig(
  options: DiversionConfigReadOptions = {},
  runner: DbScriptRunner = (file, args, opts) => execFileAsync(file, args, opts),
): Promise<DiversionConfigRawCollection> {
  const queriedAt = new Date().toISOString();
  const credPath = resolveDatabaseCredentialsPath(options.credPath);
  if (!credPath) {
    return {
      status: 'UNVERIFIED',
      reason: 'MISSING_CREDENTIALS',
      error: '找不到 db-credentials.json，无法读取分流资格配置 [UNVERIFIED]',
      ...EMPTY(),
      queriedAt,
    };
  }
  const scriptPath = resolveConfigScriptPath(options.scriptPath);
  if (!scriptPath || !existsSync(scriptPath)) {
    return {
      status: 'UNVERIFIED',
      reason: 'SCRIPT_NOT_FOUND',
      error: `读取脚本不存在: ${scriptPath || 'scripts/read-diversion-config.py'} [UNVERIFIED]`,
      ...EMPTY(),
      credPath,
      queriedAt,
    };
  }
  const args = [scriptPath, '--cred-path', credPath, '--json'];
  try {
    const { stdout } = await runner('python3', args, {
      timeout: options.timeoutMs ?? 15000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout.trim()) as Partial<DiversionConfigRawCollection>;
    return {
      status: parsed.status === 'VERIFIED' ? 'VERIFIED' : 'UNVERIFIED',
      routeMode: parsed.routeMode ?? null,
      routeRules: parsed.routeRules ?? {},
      groupRules: parsed.groupRules ?? {},
      globalApiKeyConfigured: Boolean(parsed.globalApiKeyConfigured),
      globalModelIds: Array.isArray(parsed.globalModelIds) ? parsed.globalModelIds.map(Number) : [],
      aliasMap: parsed.aliasMap ?? {},
      reason: parsed.reason,
      error: parsed.error ? sanitizeErrorMessage(parsed.error) : undefined,
      credPath,
      queriedAt,
    };
  } catch (err) {
    const sanitized = sanitizeErrorMessage(err instanceof Error ? err.message : String(err));
    return {
      status: 'UNVERIFIED',
      reason: 'CONFIG_READ_FAILED',
      error: `分流资格配置读取失败: ${sanitized} [UNVERIFIED]`,
      ...EMPTY(),
      credPath,
      queriedAt,
    };
  }
}

/**
 * 桥接：把配置快照转成 `evaluate*Diversion` 所需的规则/模型上下文。
 * modelId 用于解析 `is_newapi_global` 与别名（别名空=模型不分流）。
 */
export function toEligibilityRules(
  cfg: DiversionConfigRawCollection,
  modelId: number,
): {
  routeMode: RouteMode;
  routeRules: RouteRules;
  groupRules: GroupedRouteRules;
  isGlobalModel: boolean;
  alias: string;
  hasGlobalApiKey: boolean;
} {
  const mode = (cfg.routeMode ?? 'newapi').toLowerCase();
  const routeMode: RouteMode = mode === 'legacy' || mode === 'off' ? mode : 'newapi';
  return {
    routeMode,
    routeRules: cfg.routeRules ?? {},
    groupRules: cfg.groupRules ?? {},
    isGlobalModel: cfg.globalModelIds.includes(modelId),
    alias: cfg.aliasMap?.[String(modelId)] ?? '',
    hasGlobalApiKey: cfg.globalApiKeyConfigured,
  };
}
