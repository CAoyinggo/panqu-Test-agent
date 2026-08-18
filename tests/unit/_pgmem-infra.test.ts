// 基础设施测试：pg-mem 能力验证与已知局限记录（Phase 25.2）
// pg-mem 是内存版 PostgreSQL 模拟器，用作 PostgresRepository 测试基础设施。
// 本文件验证其核心能力，并记录已知局限，避免后续误用。
import { describe, it, expect } from 'vitest';
import { newDb } from 'pg-mem';

describe('pg-mem 基础设施', () => {
  it('支持单行 CREATE TABLE + INSERT + SELECT（真实 SQL 解析）', async () => {
    const mem = newDb();
    const { Pool } = mem.adapters.createPg();
    const pool = new Pool();
    await pool.query('CREATE TABLE IF NOT EXISTS "widgets" (id TEXT PRIMARY KEY, data JSONB NOT NULL)');
    await pool.query('INSERT INTO widgets VALUES ($1, $2)', ['a', JSON.stringify({ x: 1 })]);
    const { rows } = await pool.query('SELECT data FROM widgets');
    expect(rows[0].data).toEqual({ x: 1 });
    await pool.end();
  });

  it('已知局限：已存在表再次 CREATE IF NOT EXISTS 时 AST planner 抛错（真实 Postgres 幂等）', async () => {
    const mem = newDb();
    const { Pool } = mem.adapters.createPg();
    const pool = new Pool();
    await pool.query('CREATE TABLE IF NOT EXISTS "t" (id TEXT PRIMARY KEY, data JSONB NOT NULL)');
    // pg-mem 3.x 局限：重复建表（表已存在）时 constraints AST 未被 planner 读取。
    // 注意：真实 PostgreSQL 完全幂等，此局限仅影响 pg-mem 模拟。
    // 因此 ensureCollection 的幂等性测试不依赖 pg-mem 的 IF NOT EXISTS 重复路径，
    // 而在集成测试中验证「先建表后用同连接读写」的实际可用性。
    let threw = false;
    try {
      await pool.query('CREATE TABLE IF NOT EXISTS "t" (id TEXT PRIMARY KEY, data JSONB NOT NULL)');
    } catch {
      threw = true;
    }
    expect(threw).toBe(true); // 记录局限：pg-mem 对已存在表的重复 DDL 抛错
    await pool.end();
  });

  it('pg-mem 可用于 PostgresRepository 的 CRUD 语义验证', async () => {
    const mem = newDb();
    const { Pool } = mem.adapters.createPg();
    const pool = new Pool();
    await pool.query('CREATE TABLE IF NOT EXISTS "w" (id TEXT PRIMARY KEY, data JSONB NOT NULL)');
    await pool.query('INSERT INTO w VALUES ($1, $2)', ['1', JSON.stringify({ id: '1', n: 1 })]);
    await pool.query('UPDATE w SET data = $1 WHERE id = $2', [JSON.stringify({ id: '1', n: 2 }), '1']);
    const { rows } = await pool.query('SELECT data FROM w WHERE id = $1', ['1']);
    expect(rows[0].data.n).toBe(2);
    await pool.query('DELETE FROM w WHERE id = $1', ['1']);
    const { rows: after } = await pool.query('SELECT COUNT(*)::int AS c FROM w');
    expect(after[0].c).toBe(0);
    await pool.end();
  });
});
