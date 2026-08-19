// 单元测试：JWT（Phase 25.3）
// 覆盖：签发/校验往返、签名篡改、错误密钥、过期、类型校验、解码、时间确定性。

import { describe, it, expect } from 'vitest';
import { signJwt, verifyJwt, decodeJwt } from '../../src/platform/auth/jwt.js';

const SECRET = 'unit-test-secret';

const base = {
  sub: 'u-admin',
  username: 'admin',
  roles: ['ADMIN'],
  iss: 'panqu-test-platform',
  type: 'access' as const,
};

describe('JWT 签发 / 校验', () => {
  it('签名往返：payload 字段完整保留（含 scopes）', () => {
    const token = signJwt(
      { ...base, scopes: { projects: ['wan3'], environments: ['test', 'staging'] } },
      SECRET,
      3600,
    );
    const payload = verifyJwt(token, SECRET);
    expect(payload.sub).toBe('u-admin');
    expect(payload.username).toBe('admin');
    expect(payload.roles).toEqual(['ADMIN']);
    expect(payload.scopes?.projects).toEqual(['wan3']);
    expect(payload.scopes?.environments).toEqual(['test', 'staging']);
    expect(payload.jti).toBeTruthy();
    expect(payload.exp).toBe(payload.iat + 3600);
  });

  it('篡改 payload → 签名校验失败', () => {
    const token = signJwt({ ...base }, SECRET, 3600);
    const [h, , s] = token.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ ...base, sub: 'u-attacker' })).toString('base64url');
    expect(() => verifyJwt(`${h}.${forgedPayload}.${s}`, SECRET)).toThrow(/签名无效/);
  });

  it('错误密钥 → 校验失败', () => {
    const token = signJwt({ ...base }, SECRET, 3600);
    expect(() => verifyJwt(token, 'wrong-secret')).toThrow(/签名无效/);
  });

  it('过期 token → 校验失败', () => {
    const iat = 1_700_000_000;
    const token = signJwt({ ...base, iat }, SECRET, 60); // exp = iat + 60
    expect(() => verifyJwt(token, SECRET, { nowSeconds: () => iat + 61 })).toThrow(/已过期/);
  });

  it('尚未生效（iat 在未来）→ 校验失败', () => {
    const iat = 1_700_000_000;
    const token = signJwt({ ...base, iat }, SECRET, 60);
    expect(() => verifyJwt(token, SECRET, { nowSeconds: () => iat - 1 })).toThrow(/尚未生效/);
  });

  it('类型校验：access token 不能当 refresh 用', () => {
    const token = signJwt({ ...base, type: 'access' }, SECRET, 3600);
    expect(() => verifyJwt(token, SECRET, { allowType: 'refresh' })).toThrow(/类型不符/);
  });

  it('结构非法（段数不对 / 非 base64）→ 校验失败', () => {
    expect(() => verifyJwt('a.b', SECRET)).toThrow(/结构非法/);
    expect(() => verifyJwt('a.b.c.d', SECRET)).toThrow(/结构非法/);
  });

  it('decode 返回 header 与 payload（不校验签名）', () => {
    const token = signJwt({ ...base }, SECRET, 3600);
    const { header, payload } = decodeJwt(token);
    expect((header as { alg: string }).alg).toBe('HS256');
    expect(payload.sub).toBe('u-admin');
  });

  it('27.3 decodeJwt 加固：结构非法 / 非法 JSON → 抛错（不静默返回）', () => {
    expect(() => decodeJwt('a.b')).toThrow(/结构非法/);
    expect(() => decodeJwt('a.b.c.d')).toThrow(/结构非法/);
    // 合法段数但 payload 非 JSON → 抛错
    expect(() => decodeJwt('eyJhbGciOiJIUzI1NiJ9.not-json.c2ln')).toThrow(/payload 非法/);
  });

  it('时间确定性：注入 iat 与 nowSeconds 后结果稳定', () => {
    const iat = 1_700_000_000;
    const token = signJwt({ ...base, iat }, SECRET, 300);
    const payload = verifyJwt(token, SECRET, { nowSeconds: () => iat + 100 });
    expect(payload.iat).toBe(iat);
    expect(payload.exp).toBe(iat + 300);
  });
});
