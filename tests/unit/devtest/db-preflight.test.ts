/**
 * db-preflight 单元测试：DB 取证失败诚实分类 + 工具链预检（注入执行器 · 100% 离线）
 */
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { classifyDbForensics, checkDbToolchain } from '../../../src/devtest/db-preflight.js';
import { verify } from '../../../src/devtest/core-kernel.js';
import type { DbScriptRunner } from '../../../src/devtest/database-evidence-producer.js';

const existingPath = fileURLToPath(import.meta.url);

describe('classifyDbForensics (区分工具链/连通性 vs 记录缺失)', () => {
  it('VERIFIED + 有记录 → OK', () => {
    expect(classifyDbForensics({ status: 'VERIFIED', recordsFound: { pq_aivideo_new: {} } }).category).toBe('OK');
  });
  it('MISSING_CREDENTIALS', () => {
    expect(classifyDbForensics({ status: 'UNVERIFIED', reason: 'MISSING_CREDENTIALS' }).category).toBe('MISSING_CREDENTIALS');
  });
  it('DB_QUERY_FAILED → TOOLCHAIN_OR_CONNECTIVITY（不是记录缺失）', () => {
    const c = classifyDbForensics({ status: 'UNVERIFIED', reason: 'DB_QUERY_FAILED' });
    expect(c.category).toBe('TOOLCHAIN_OR_CONNECTIVITY');
    expect(c.actionable).toMatch(/预检|paramiko|sshtunnel/);
  });
  it('NO_RECORD_FOUND → RECORD_ABSENT', () => {
    expect(classifyDbForensics({ status: 'UNVERIFIED', reason: 'NO_RECORD_FOUND' }).category).toBe('RECORD_ABSENT');
  });
  it('UNVERIFIED 无 reason 无记录 → RECORD_ABSENT', () => {
    expect(classifyDbForensics({ status: 'UNVERIFIED', recordsFound: {} }).category).toBe('RECORD_ABSENT');
  });
  it('空输入 → UNKNOWN', () => {
    expect(classifyDbForensics(undefined).category).toBe('UNKNOWN');
  });
});

describe('checkDbToolchain (注入执行器)', () => {
  const opts = { credPath: existingPath, scriptPath: existingPath };
  it('执行器返回 connected JSON → ok=true, stage=connected, tables', async () => {
    const runner: DbScriptRunner = async () => ({ stdout: JSON.stringify({ ok: true, stage: 'connected', tables: 219 }) });
    const r = await checkDbToolchain(opts, runner);
    expect(r.ok).toBe(true);
    expect(r.stage).toBe('connected');
    expect(r.tables).toBe(219);
  });
  it('执行器返回 deps 失败 JSON → ok=false, stage=deps', async () => {
    const runner: DbScriptRunner = async () => ({ stdout: JSON.stringify({ ok: false, stage: 'deps', error: 'MISSING_DEPENDENCY: sshtunnel' }) });
    const r = await checkDbToolchain(opts, runner);
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('deps');
  });
  it('执行器抛错(含密码) → fail-closed 且脱敏', async () => {
    const runner: DbScriptRunner = async () => {
      throw new Error('ssh failed password=Secret999');
    };
    const r = await checkDbToolchain(opts, runner);
    expect(r.ok).toBe(false);
    expect(r.error || '').not.toContain('Secret999');
  });
});

describe('verify() 结果携带 dbForensicsCategory', () => {
  it('VERIFIED + 记录 → OK', async () => {
    const result = await verify({
      taskId: 700,
      modelId: 78,
      mediaType: 'video',
      dbRawCollection: {
        status: 'VERIFIED',
        taskId: '700',
        recordsFound: { pq_aivideo_new: { id: 700 }, pq_volcengine_ai_task: { id: 7, source_id: 700 } },
      } as never,
    });
    expect(result.dbForensicsCategory).toBe('OK');
  });
  it('UNVERIFIED NO_RECORD_FOUND → RECORD_ABSENT（不误报为工具链问题）', async () => {
    const result = await verify({
      taskId: 701,
      modelId: 78,
      mediaType: 'video',
      dbRawCollection: { status: 'UNVERIFIED', taskId: '701', reason: 'NO_RECORD_FOUND', recordsFound: {} } as never,
    });
    expect(result.dbForensicsCategory).toBe('RECORD_ABSENT');
  });
});
