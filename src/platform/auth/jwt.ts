// JWT（Phase 25.3）：HS256（HMAC-SHA256），node:crypto 内置实现（RFC 7519）
// 无外部依赖；提供 sign / verify / decode；支持访问令牌与刷新令牌类型、过期与签名校验。

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface JwtPayload {
  /** 用户 id */
  sub: string;
  username: string;
  roles: string[];
  scopes?: { projects?: string[]; environments?: string[]; businesses?: string[] };
  iss: string;
  /** 签发时间（秒） */
  iat: number;
  /** 过期时间（秒） */
  exp: number;
  /** token id（登出吊销用） */
  jti: string;
  type: 'access' | 'refresh';
}

export interface JwtVerifyOptions {
  allowType?: JwtPayload['type'];
  /** 时间源（秒；测试确定性） */
  nowSeconds?: () => number;
}

const HEADER = { alg: 'HS256', typ: 'JWT' };

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(data: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(data).digest();
}

function randomId(): string {
  return `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`;
}

/** 签发 JWT */
export function signJwt(
  payload: Omit<JwtPayload, 'iat' | 'jti' | 'exp'> & { iat?: number; jti?: string },
  secret: string,
  ttlSeconds: number,
): string {
  const iat = payload.iat ?? Math.floor(Date.now() / 1000);
  const jti = payload.jti ?? randomId();
  const body: JwtPayload = { ...payload, iat, jti, exp: iat + ttlSeconds };
  const headerB64 = base64url(JSON.stringify(HEADER));
  const payloadB64 = base64url(JSON.stringify(body));
  const signature = sign(`${headerB64}.${payloadB64}`, secret).toString('base64url');
  return `${headerB64}.${payloadB64}.${signature}`;
}

/** 校验 JWT（结构 / 签名 / 过期 / 类型）；失败抛错 */
export function verifyJwt(token: string, secret: string, opts: JwtVerifyOptions = {}): JwtPayload {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('JWT 结构非法');
  const [headerB64, payloadB64, sig] = parts;
  const expected = sign(`${headerB64}.${payloadB64}`, secret);
  const actual = Buffer.from(sig, 'base64url');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error('JWT 签名无效');
  }
  let payload: JwtPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as JwtPayload;
  } catch {
    throw new Error('JWT payload 非法');
  }
  if (opts.allowType && payload.type !== opts.allowType) {
    throw new Error(`JWT 类型不符：${String(payload.type)}`);
  }
  const now = opts.nowSeconds ? opts.nowSeconds() : Math.floor(Date.now() / 1000);
  if (payload.exp <= now) throw new Error('JWT 已过期');
  if (payload.iat > now) throw new Error('JWT 尚未生效');
  return payload;
}

/** 解码（不校验签名；测试 / 调试用） */
export function decodeJwt(token: string): { header: unknown; payload: JwtPayload } {
  const [headerB64, payloadB64] = token.split('.');
  return {
    header: JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8')),
    payload: JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as JwtPayload,
  };
}
