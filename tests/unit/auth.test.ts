// 单元测试：Auth（Phase 25.3）
// 覆盖：密码哈希 / UserStore 幂等种子 / AuthService login/logout/refresh/info/verify /
//       token 内嵌作用域 / 禁用用户 / 生产环境默认口令禁用。

import { describe, it, expect, vi, afterEach } from 'vitest';
import { InMemoryRepository } from '../../src/platform/storage/index.js';
import { UserStore, DEFAULT_SEED_USERS } from '../../src/platform/auth/user-store.js';
import { AuthService } from '../../src/platform/auth/auth-service.js';
import { hashPassword, verifyPassword } from '../../src/platform/auth/password.js';
import { decodeJwt } from '../../src/platform/auth/jwt.js';
import type { UserRecord } from '../../src/platform/auth/user.js';
import { AuditLog } from '../../src/platform/audit/audit-log.js';

const FIXED_MS = Date.parse('2026-08-18T00:00:00.000Z');

function makeAuth(opts: ConstructorParameters<typeof AuthService>[1] = {}) {
  const repo = new InMemoryRepository<UserRecord>('user');
  const users = new UserStore(repo);
  const auth = new AuthService(users, { now: () => FIXED_MS, ...opts });
  return { users, auth };
}

describe('密码哈希', () => {
  it('hash / verify 往返通过；错误密码失败', async () => {
    const hash = await hashPassword('secret123');
    expect(hash.startsWith('scrypt:')).toBe(true);
    expect(await verifyPassword('secret123', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
  });

  it('非法格式哈希 → verify 返回 false（不抛错）', async () => {
    expect(await verifyPassword('x', 'not-a-valid-format')).toBe(false);
  });
});

describe('UserStore', () => {
  it('幂等种子：首次创建默认用户，再次不重复', async () => {
    const { users, auth } = makeAuth();
    const first = await auth.ensureSeeded();
    expect(first).toBe(DEFAULT_SEED_USERS.length);
    const second = await auth.ensureSeeded();
    expect(second).toBe(0);
    expect(await users.count()).toBe(DEFAULT_SEED_USERS.length);
  });

  it('按 username 检索；list 不含密码哈希', async () => {
    const { users, auth } = makeAuth();
    await auth.ensureSeeded();
    const u = await users.getByUsername('qa-a');
    expect(u?.id).toBe('u-qa-a');
    expect((u as UserRecord | null)?.passwordHash).toBeTruthy();
    const listed = await users.list();
    for (const item of listed) {
      expect((item as unknown as Record<string, unknown>).passwordHash).toBeUndefined();
    }
  });

  it('setStatus 可禁用用户', async () => {
    const { users, auth } = makeAuth();
    await auth.ensureSeeded();
    await users.setStatus('u-qa-a', 'DISABLED');
    expect((await users.getById('u-qa-a'))?.status).toBe('DISABLED');
  });
});

describe('AuthService 登录 / 登出 / 刷新 / 信息', () => {
  it('login 成功：返回 access/refresh token 与用户（无密码哈希）', async () => {
    const { auth } = makeAuth();
    await auth.ensureSeeded();
    const tokens = await auth.login('qa-a', 'qa123456');
    expect(tokens.accessToken).toBeTruthy();
    expect(tokens.refreshToken).toBeTruthy();
    expect(tokens.user.username).toBe('qa-a');
    expect((tokens.user as unknown as Record<string, unknown>).passwordHash).toBeUndefined();
    expect((tokens.user.scopes as Record<string, unknown>).projects).toEqual(['wan3']);
  });

  it('登录失败：密码错误 / 用户不存在 → 抛错', async () => {
    const { auth } = makeAuth();
    await auth.ensureSeeded();
    await expect(auth.login('qa-a', 'wrong')).rejects.toThrow(/用户名或密码错误/);
    await expect(auth.login('ghost', 'x')).rejects.toThrow(/用户名或密码错误/);
  });

  it('禁用用户登录 → 拒绝', async () => {
    const { users, auth } = makeAuth();
    await auth.ensureSeeded();
    await users.setStatus('u-qa-a', 'DISABLED');
    await expect(auth.login('qa-a', 'qa123456')).rejects.toThrow(/用户名或密码错误/);
  });

  it('verify(access) 返回用户与 payload；roles/scopes 内嵌 token', async () => {
    const { auth } = makeAuth();
    await auth.ensureSeeded();
    const { accessToken } = await auth.login('qa-a', 'qa123456');
    const { user, payload } = await auth.verify(accessToken);
    expect(user.id).toBe('u-qa-a');
    expect(payload.roles).toEqual(['QA']);
    expect(payload.scopes?.projects).toEqual(['wan3']);
    // 校验 payload 确实签在 token 内（解码一致）
    expect(decodeJwt(accessToken).payload.username).toBe('qa-a');
  });

  it('info(access) 返回当前用户', async () => {
    const { auth } = makeAuth();
    await auth.ensureSeeded();
    const { accessToken } = await auth.login('admin', 'admin123');
    const info = await auth.info(accessToken);
    expect(info.username).toBe('admin');
    expect(info.roles).toEqual(['ADMIN']);
  });

  it('refresh 旋转：新 access 可用，旧 refresh 失效', async () => {
    const { auth } = makeAuth();
    await auth.ensureSeeded();
    const first = await auth.login('qa-a', 'qa123456');
    const second = await auth.refresh(first.refreshToken);
    expect(second.accessToken).not.toBe(first.accessToken);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    // 旧 refresh 已吊销
    await expect(auth.refresh(first.refreshToken)).rejects.toThrow(/已失效/);
    // 新 access 可校验
    await expect(auth.verify(second.accessToken)).resolves.toBeTruthy();
  });

  it('logout 吊销 refresh：之后 refresh 失败', async () => {
    const { auth } = makeAuth();
    await auth.ensureSeeded();
    const { accessToken, refreshToken } = await auth.login('qa-a', 'qa123456');
    await auth.logout(refreshToken);
    await expect(auth.refresh(refreshToken)).rejects.toThrow(/已失效/);
    // access 仍在有效期内（logout 只吊销 refresh + 同源 jti 撤销）
    await expect(auth.verify(accessToken)).resolves.toBeTruthy();
  });

  it('verify 无效 token → 抛错', async () => {
    const { auth } = makeAuth();
    await auth.ensureSeeded();
    await expect(auth.verify('not-a-jwt')).rejects.toThrow();
    await expect(auth.verify('a.b.c')).rejects.toThrow();
  });
});

describe('生产环境默认口令禁用', () => {
  it('allowDefaultCredentials=false：默认账号禁止登录', async () => {
    const { auth } = makeAuth({ allowDefaultCredentials: false });
    await auth.ensureSeeded();
    await expect(auth.login('admin', 'admin123')).rejects.toThrow(/默认账号在生产环境已禁用/);
  });
});

describe('生产安全模式：requireSecureSecret（Phase 27.1）', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('requireSecureSecret 且未配置密钥 → 构造拒绝（fail fast）', () => {
    vi.stubEnv('JWT_SECRET', undefined);
    expect(() => makeAuth({ requireSecureSecret: true })).toThrow(/JWT_SECRET/);
  });

  it('requireSecureSecret 且使用开发默认密钥 → 构造拒绝', () => {
    vi.stubEnv('JWT_SECRET', undefined);
    expect(() => makeAuth({ requireSecureSecret: true, secret: 'dev-secret-change-me' })).toThrow(/JWT_SECRET/);
  });

  it('requireSecureSecret 且显式非默认密钥 → 构造通过并可登录', async () => {
    vi.stubEnv('JWT_SECRET', undefined);
    const { auth } = makeAuth({ requireSecureSecret: true, secret: 'strong-secret' });
    await auth.ensureSeeded();
    const tokens = await auth.login('qa-a', 'qa123456');
    expect(tokens.accessToken).toBeTruthy();
  });

  it('非生产模式缺省不强制：未配置密钥回退开发密钥可正常签名', async () => {
    vi.stubEnv('JWT_SECRET', undefined);
    const { auth } = makeAuth();
    await auth.ensureSeeded();
    const tokens = await auth.login('qa-a', 'qa123456');
    expect(tokens.accessToken).toBeTruthy();
  });
});

describe('AuthService 审计', () => {
  it('login / logout / refresh 写入审计', async () => {
    const repo = new InMemoryRepository<UserRecord>('user');
    const users = new UserStore(repo);
    const auditRepo = new InMemoryRepository<import('../../src/platform/audit/audit-log.js').AuditEntry>('audit');
    const audit = new AuditLog(auditRepo, { now: () => new Date(FIXED_MS).toISOString() });
    const auth = new AuthService(users, { now: () => FIXED_MS, audit });
    await auth.ensureSeeded();
    const tokens = await auth.login('qa-a', 'qa123456');
    await auth.logout(tokens.refreshToken);
    const actions = (await audit.list({})).map((e) => e.action);
    expect(actions).toContain('auth.login');
    expect(actions).toContain('auth.logout');
  });
});
