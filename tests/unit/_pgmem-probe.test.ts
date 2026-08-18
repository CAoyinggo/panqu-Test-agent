import { describe, it, expect } from 'vitest';
import { newDb } from 'pg-mem';

describe('pg-mem isolation', () => {
  it('create table in vitest', async () => {
    const mem = newDb();
    const { Pool } = mem.adapters.createPg();
    const pool = new Pool();
    await pool.query('CREATE TABLE IF NOT EXISTS "widgets" (id TEXT PRIMARY KEY, data JSONB NOT NULL)');
    await pool.query('INSERT INTO widgets VALUES ($1, $2)', ['a', JSON.stringify({ x: 1 })]);
    const { rows } = await pool.query('SELECT data FROM widgets');
    expect(rows[0].data).toEqual({ x: 1 });
  });
});
