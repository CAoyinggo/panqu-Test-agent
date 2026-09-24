/**
 * AbsettingPriceReader — 读取 pq_absetting 刊例/成本价（运行时计费真源）
 * =============================================================================
 * 刊例价的运行时真源是 `pq_absetting`（AB 库，`PointsService::getPointsFromAbSetting` 据此取价）。
 * 分流《渠道表》只覆盖视频规划口径、图片刊例价不在其中——本读取器补上「任意模型（含图片）的
 * 真实刊例/成本价」这一权威源。经可注入执行器跑 `scripts/read-absetting-price.py`（只读 SSH 隧道），
 * fail-closed、脱敏；测试注入假执行器即 100% 离线覆盖。
 *
 * ⚠️ 诚实边界：`resolveAbsettingListPrice` 只做「(task_type,resolution 整数码) 精确匹配」，
 * **不复刻** getPointsFromAbSetting 的 extend_field/quality/sound_type/billing_type 分块选取——
 * 多行歧义时返回 null 交调用方按 task_type 收窄；分辨率整数码是媒体相关的（视频 1=480p/2=720p/3=1080p，
 * 图片 4/5/6=1K/2K/4K，实测），映射请以 SUT 为准，勿硬编码到断言里。
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

const execFileAsync = promisify(execFile);

export interface AbsettingRow {
  model_config_id: number;
  task_type: number | null;
  resolution: number | null; // 整数码（媒体相关）
  billing_type: number | null; // 1=按次/张, 2=按秒
  list_price_points: number | null;
  cost_price: number | null;
  model_name?: string | null;
  extend_field?: string | null;
}

export interface AbsettingPriceRawCollection {
  status: 'VERIFIED' | 'UNVERIFIED';
  abSchema: string | null;
  model: number;
  rows: AbsettingRow[];
  reason?: string;
  error?: string;
  credPath?: string;
  queriedAt?: string;
}

export interface AbsettingReadOptions {
  model: number;
  abDb?: string;
  credPath?: string;
  scriptPath?: string;
  timeoutMs?: number;
}

// APPEND_ABSETTING

function resolveAbScriptPath(explicit?: string): string | undefined {
  if (explicit && existsSync(explicit)) return explicit;
  const currentDir = typeof __dirname !== 'undefined' ? __dirname : fileURLToPath(new URL('.', import.meta.url));
  const candidates = [
    join(process.cwd(), 'scripts', 'read-absetting-price.py'),
    join(currentDir, '..', '..', 'scripts', 'read-absetting-price.py'),
    join(currentDir, '..', '..', '..', 'scripts', 'read-absetting-price.py'),
    '/Users/mac/agents/test-flow/scripts/read-absetting-price.py',
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return undefined;
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeRow(r: Record<string, unknown>): AbsettingRow {
  return {
    model_config_id: Number(r.model_config_id),
    task_type: toNum(r.task_type),
    resolution: toNum(r.resolution),
    billing_type: toNum(r.billing_type),
    list_price_points: toNum(r.list_price_points),
    cost_price: toNum(r.cost_price),
    model_name: (r.model_name as string) ?? null,
    extend_field: (r.extend_field as string) ?? null,
  };
}

/** 只读拉取某模型的 pq_absetting 计价行（可注入执行器）。fail-closed、脱敏。 */
export async function readAbsettingPrices(
  options: AbsettingReadOptions,
  runner: DbScriptRunner = (file, args, opts) => execFileAsync(file, args, opts),
): Promise<AbsettingPriceRawCollection> {
  const queriedAt = new Date().toISOString();
  const base: AbsettingPriceRawCollection = { status: 'UNVERIFIED', abSchema: null, model: options.model, rows: [], queriedAt };
  const credPath = resolveDatabaseCredentialsPath(options.credPath);
  if (!credPath) return { ...base, reason: 'MISSING_CREDENTIALS', error: '找不到 db-credentials.json' };
  const scriptPath = resolveAbScriptPath(options.scriptPath);
  if (!scriptPath || !existsSync(scriptPath)) {
    return { ...base, reason: 'SCRIPT_NOT_FOUND', error: `读取脚本不存在: ${scriptPath || 'scripts/read-absetting-price.py'}`, credPath };
  }
  const args = [scriptPath, '--model', String(options.model), '--cred-path', credPath, '--json'];
  if (options.abDb) args.push('--ab-db', options.abDb);
  try {
    const { stdout } = await runner('python3', args, { timeout: options.timeoutMs ?? 15000, maxBuffer: 4 * 1024 * 1024 });
    const parsed = JSON.parse(stdout.trim()) as Partial<AbsettingPriceRawCollection> & { rows?: Record<string, unknown>[] };
    return {
      status: parsed.status === 'VERIFIED' ? 'VERIFIED' : 'UNVERIFIED',
      abSchema: parsed.abSchema ?? null,
      model: options.model,
      rows: Array.isArray(parsed.rows) ? parsed.rows.map(normalizeRow) : [],
      reason: parsed.reason,
      error: parsed.error ? sanitizeErrorMessage(parsed.error) : undefined,
      credPath,
      queriedAt,
    };
  } catch (err) {
    return { ...base, reason: 'ABSETTING_READ_FAILED', error: sanitizeErrorMessage(err instanceof Error ? err.message : String(err)), credPath };
  }
}

/**
 * 精确匹配取刊例价：按 resolution 整数码（+可选 task_type）过滤，唯一则返回，歧义/缺失返回 null。
 * 不复刻 getPointsFromAbSetting 的 extend_field/quality/sound_type 选取——歧义时交调用方用 task_type 收窄。
 */
export function resolveAbsettingListPrice(
  rows: AbsettingRow[],
  q: { taskType?: number; resolutionCode: number },
): number | null {
  const matched = rows.filter(
    (r) => r.resolution === q.resolutionCode && (q.taskType === undefined || r.task_type === q.taskType),
  );
  const vals = new Set<number>();
  for (const r of matched) if (typeof r.list_price_points === 'number') vals.add(r.list_price_points);
  return vals.size === 1 ? [...vals][0] : null;
}

