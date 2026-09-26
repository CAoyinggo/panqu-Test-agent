/**
 * DB 取证工具链预检 + 失败分类（诚实性硬化）
 * =============================================================================
 * 问题：真实运行「强制连库取证」一旦 Python 工具链不兼容（如 paramiko/sshtunnel 版本冲突）
 * 或跳板机不可达，会静默 fail-closed 成 UNVERIFIED——与「库里没这条记录」长得一样，
 * 把"根本没连上"伪装成"查无此任务"。
 *
 * 本模块把 DB 取证失败**显式分类**（凭据缺失 / 工具链或连通性 / 记录确实不存在），
 * 并提供一次性**预检** `checkDbToolchain`（跑 test-db-connection.py），让会话在跑真实
 * 取证前就知道链路是否畅通。纯分类函数零 I/O；预检执行器可注入，100% 离线可测。
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

/** DB 取证结果的诚实分类。 */
export type DbForensicsCategory =
  | 'OK' // 已连库且拿到记录
  | 'MISSING_CREDENTIALS' // 没配 db-credentials.json
  | 'TOOLCHAIN_OR_CONNECTIVITY' // 依赖缺失/版本冲突/SSH/网络——根本没连上（≠记录缺失！）
  | 'RECORD_ABSENT' // 连上了，但库里确实没这条记录
  | 'UNKNOWN';

export interface DbForensicsClassification {
  category: DbForensicsCategory;
  actionable: string; // 一句话可执行建议
}

/**
 * 纯函数：把 DatabaseRawCollection 风格的原始取证结果分类。
 * 关键：把「工具链/连通性失败」与「记录确实不存在」区分开，避免误报。
 */
export function classifyDbForensics(
  raw: { status?: string; reason?: string; error?: string; recordsFound?: Record<string, unknown> } | null | undefined,
): DbForensicsClassification {
  if (!raw) return { category: 'UNKNOWN', actionable: '无 DB 取证结果（未启用或未提供 dbRawCollection）' };
  const hasRecords = !!raw.recordsFound && Object.keys(raw.recordsFound).length > 0;
  if (raw.status === 'VERIFIED' && hasRecords) {
    return { category: 'OK', actionable: '已连库并取到物理记录' };
  }
  const reason = String(raw.reason || '').toUpperCase();
  if (reason === 'MISSING_CREDENTIALS') {
    return {
      category: 'MISSING_CREDENTIALS',
      actionable: '配置 db-credentials.json（host/user/password/database + ssh_tunnel）后重试',
    };
  }
  if (
    ['DB_CONNECT_FAILED', 'DB_QUERY_FAILED', 'CONFIG_READ_FAILED', 'SCRIPT_NOT_FOUND', 'MISSING_DEPENDENCY'].includes(
      reason,
    )
  ) {
    return {
      category: 'TOOLCHAIN_OR_CONNECTIVITY',
      actionable:
        '跑 `checkDbToolchain`/test-db-connection.py 预检：核对 paramiko/sshtunnel/pymysql 版本与跳板机可达性——这不是「记录缺失」',
    };
  }
  // 显式 NO_RECORD_FOUND 才是「已连库但查无记录」。
  if (reason === 'NO_RECORD_FOUND') {
    return { category: 'RECORD_ABSENT', actionable: '已连库但查无此任务记录：确认 taskId 与环境是否正确' };
  }
  // 存在 error 但 reason 未识别 = 取证路径抛异常（隧道/连接/查询失败），根本没连上；
  // 绝不据此误标 RECORD_ABSENT（否则把"连不上"伪装成"查无此记录"）。
  if (raw.error) {
    return {
      category: 'TOOLCHAIN_OR_CONNECTIVITY',
      actionable:
        '取证过程抛出异常（连接/隧道/查询失败）：跑 `checkDbToolchain`/test-db-connection.py 预检链路可达性——这不是「记录缺失」',
    };
  }
  // 无 error、非 VERIFIED、且无记录：保守判为记录缺失。
  if (raw.status !== 'VERIFIED' && !hasRecords) {
    return { category: 'RECORD_ABSENT', actionable: '已连库但查无此任务记录：确认 taskId 与环境是否正确' };
  }
  return { category: 'UNKNOWN', actionable: `未识别的取证状态 (status=${raw.status}, reason=${raw.reason})` };
}

// APPEND_PREFLIGHT

/** 预检各阶段（与 test-db-connection.py --json 的 stage 对齐）。 */
export type DbPreflightStage = 'credentials' | 'deps' | 'ssh' | 'mysql' | 'connected' | 'unknown';

export interface DbPreflightResult {
  ok: boolean;
  stage: DbPreflightStage;
  tables?: number;
  error?: string;
  credPath?: string;
}

function resolvePreflightScriptPath(explicit?: string): string | undefined {
  if (explicit && existsSync(explicit)) return explicit;
  const currentDir = typeof __dirname !== 'undefined' ? __dirname : fileURLToPath(new URL('.', import.meta.url));
  const candidates = [
    join(process.cwd(), 'scripts', 'test-db-connection.py'),
    join(currentDir, '..', '..', 'scripts', 'test-db-connection.py'),
    join(currentDir, '..', '..', '..', 'scripts', 'test-db-connection.py'),
    '/Users/mac/agents/test-flow/scripts/test-db-connection.py',
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return undefined;
}

/**
 * 一次性 DB 取证链路预检（跑 test-db-connection.py --json）。fail-closed、脱敏。
 * 执行器可注入 → 测试无需真实库/SSH 即可覆盖 connected/deps/ssh 各分支。
 */
export async function checkDbToolchain(
  options: { credPath?: string; scriptPath?: string; timeoutMs?: number } = {},
  runner: DbScriptRunner = (file, args, opts) => execFileAsync(file, args, opts),
): Promise<DbPreflightResult> {
  const credPath = resolveDatabaseCredentialsPath(options.credPath);
  if (!credPath) return { ok: false, stage: 'credentials', error: '找不到 db-credentials.json' };
  const scriptPath = resolvePreflightScriptPath(options.scriptPath);
  if (!scriptPath || !existsSync(scriptPath)) {
    return { ok: false, stage: 'deps', error: `预检脚本不存在: ${scriptPath || 'scripts/test-db-connection.py'}` };
  }
  try {
    const { stdout } = await runner('python3', [scriptPath, '--cred-path', credPath, '--json'], {
      timeout: options.timeoutMs ?? 15000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout.trim()) as Partial<DbPreflightResult>;
    return {
      ok: Boolean(parsed.ok),
      stage: (parsed.stage as DbPreflightStage) ?? 'unknown',
      tables: typeof parsed.tables === 'number' ? parsed.tables : undefined,
      error: parsed.error ? sanitizeErrorMessage(parsed.error) : undefined,
      credPath,
    };
  } catch (err) {
    return {
      ok: false,
      stage: 'unknown',
      error: sanitizeErrorMessage(err instanceof Error ? err.message : String(err)),
      credPath,
    };
  }
}
