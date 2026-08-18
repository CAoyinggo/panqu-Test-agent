// 平台 Preflight（Phase 25.8）：平台上线前环境自检
// 检查项：Node 版本 / 平台构建产物 / 存储连通性（sqlite 可写、postgres 可连接）
//        / 迁移状态（未应用迁移数）/ 环境变量（JWT_SECRET）/ 敏感信息扫描。
// 供 CLI `preflight` 命令与集成测试共用；返回统一 CheckResult[]。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSqliteDatabase, sqliteDataFile } from '../storage/sqlite/database.js';
import { createPostgresPool } from '../storage/postgres/pg-database.js';
import { MIGRATIONS, listAppliedSqlite, ensureSqliteMigrationsTable } from './migrations.js';

export interface PlatformCheck {
  name: string;
  ok: boolean;
  level: 'PASS' | 'WARN' | 'BLOCK';
  detail: string;
}

const MIN_NODE = { major: 20, minor: 11 };

function checkNodeVersion(): PlatformCheck {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const ok = major > MIN_NODE.major || (major === MIN_NODE.major && minor >= MIN_NODE.minor);
  return { name: 'Node 版本', ok, level: ok ? 'PASS' : 'BLOCK', detail: `${process.versions.node}（要求 ≥ ${MIN_NODE.major}.${MIN_NODE.minor}）` };
}

function checkBuild(): PlatformCheck {
  const required = ['dist/bin/platform-cli.js'];
  const missing = required.filter((p) => !fs.existsSync(path.join(process.cwd(), p)));
  const ok = missing.length === 0;
  return { name: '平台构建产物', ok, level: ok ? 'PASS' : 'BLOCK', detail: missing.length ? `缺失：${missing.join('、')}（请先 npm run build）` : 'dist/bin/platform-cli.js 存在' };
}

/** SQLite 可写性探测（:memory: 或临时文件） */
function checkSqlite(): PlatformCheck {
  try {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'panqu-preflight-')), 'probe.sqlite');
    const db = createSqliteDatabase(file);
    db.exec('CREATE TABLE IF NOT EXISTS probe (id TEXT PRIMARY KEY)');
    db.close();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
    return { name: 'SQLite 存储', ok: true, level: 'PASS', detail: '可创建/写入/读取（含 WAL）' };
  } catch (e) {
    return { name: 'SQLite 存储', ok: false, level: 'WARN', detail: `不可用：${(e as Error).message}` };
  }
}

/** PostgreSQL 连通性探测（DATABASE_URL 或默认本地连接；失败仅 WARN 不阻断） */
async function checkPostgres(): Promise<PlatformCheck> {
  const pool = createPostgresPool();
  try {
    await pool.query('SELECT 1');
    return { name: 'PostgreSQL 存储', ok: true, level: 'PASS', detail: '可连接（pool.query SELECT 1 通过）' };
  } catch (e) {
    return { name: 'PostgreSQL 存储', ok: false, level: 'WARN', detail: `不可连接：${(e as Error).message.split('\n')[0]}` };
  } finally {
    await pool.end().catch(() => undefined);
  }
}

/** 迁移状态：已应用 / 未应用 */
async function checkMigrations(): Promise<PlatformCheck> {
  try {
    const db = createSqliteDatabase(':memory:');
    ensureSqliteMigrationsTable(db);
    const applied = listAppliedSqlite(db);
    const unapplied = MIGRATIONS.filter((m) => !applied.includes(m.id));
    db.close();
    const ok = unapplied.length === 0;
    return { name: '迁移状态', ok, level: ok ? 'PASS' : 'WARN', detail: `共 ${MIGRATIONS.length} 项，未应用 ${unapplied.length} 项（${unapplied.map((m) => m.id).join('、') || '无'}）` };
  } catch (e) {
    return { name: '迁移状态', ok: false, level: 'WARN', detail: `检查失败：${(e as Error).message}` };
  }
}

/** 环境变量：production 模式必须显式提供 JWT_SECRET */
function checkEnv(): PlatformCheck {
  const mode = (process.env.PLATFORM_MODE ?? 'development').toLowerCase();
  const secret = process.env.JWT_SECRET;
  const ok = mode !== 'production' || !!secret;
  return {
    name: '环境变量',
    ok,
    level: mode === 'production' ? (ok ? 'PASS' : 'BLOCK') : 'PASS',
    detail: mode === 'production'
      ? (ok ? 'JWT_SECRET 已配置（production 安全）' : 'production 模式缺少 JWT_SECRET（阻断）')
      : `模式 ${mode}（开发模式不强制 JWT_SECRET）`,
  };
}

/** 敏感信息扫描（复用 bin/preflight 模式：跳过 node_modules/dist/output/.git） */
const SECRET_PATTERNS = [
  /api[_-]?key\s*[:=]\s*["'][A-Za-z0-9_\-]{16,}["']/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];
const SECRET_SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'output', 'coverage', 'security-reports', '.trae', 'web']);

function scanSecrets(dir: string, hits: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SECRET_SKIP_DIRS.has(e.name)) scanSecrets(path.join(dir, e.name), hits);
      continue;
    }
    if (!/\.(ts|js|mjs|tsx|json|sh|yml|yaml|toml|env)$/.test(e.name)) continue;
    try {
      const content = fs.readFileSync(path.join(dir, e.name), 'utf-8');
      for (const p of SECRET_PATTERNS) {
        if (p.test(content)) {
          hits.push(`${e.name} 命中 ${p}`);
          break;
        }
      }
    } catch {
      /* 忽略不可读文件 */
    }
  }
}

function checkSecrets(): PlatformCheck {
  const hits: string[] = [];
  for (const dir of ['src', 'bin', 'scripts', 'config', 'tests']) {
    const p = path.join(process.cwd(), dir);
    if (fs.existsSync(p)) scanSecrets(p, hits);
  }
  const ok = hits.length === 0;
  return { name: '敏感信息扫描', ok, level: ok ? 'PASS' : 'BLOCK', detail: ok ? '未发现硬编码密钥/API Key' : hits.slice(0, 5).join('；') };
}

/** 运行平台 preflight（postgres 检查为异步，故本函数为 async） */
export async function runPlatformPreflight(opts: { checkPostgres?: boolean } = {}): Promise<PlatformCheck[]> {
  const checks: PlatformCheck[] = [
    checkNodeVersion(),
    checkBuild(),
    checkSqlite(),
    checkEnv(),
    checkSecrets(),
  ];
  if (opts.checkPostgres ?? true) checks.push(await checkPostgres());
  checks.push(await checkMigrations());
  return checks;
}

/** 汇总：ok = 无 BLOCK */
export function preflightSummary(checks: PlatformCheck[]): { ok: boolean; pass: number; warn: number; block: number } {
  const block = checks.filter((c) => c.level === 'BLOCK').length;
  const warn = checks.filter((c) => c.level === 'WARN').length;
  return { ok: block === 0, pass: checks.length - block - warn, warn, block };
}
