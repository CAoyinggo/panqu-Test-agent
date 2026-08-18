// 密码哈希（Phase 25.3）：node:crypto scrypt（内置、无需外部依赖）
// 存储格式：scrypt:<salt hex>:<derived hex>；校验用 timingSafeEqual 防时序攻击。

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

const KEYLEN = 64;

/** 计算密码哈希 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEYLEN);
  return `scrypt:${salt.toString('hex')}:${derived.toString('hex')}`;
}

/** 校验密码（格式非法返回 false，不抛错） */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  try {
    const salt = Buffer.from(parts[1], 'hex');
    const expected = Buffer.from(parts[2], 'hex');
    const derived = await scrypt(password, salt, expected.length);
    return expected.length === derived.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}
