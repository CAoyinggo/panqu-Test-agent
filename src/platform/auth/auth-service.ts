// AuthService（Phase 25.3）：JWT 认证服务
// 提供 login / logout / refresh / info / verify；refresh token 可吊销与旋转，
// access token 通过 jti 黑名单在登出时失效。生产环境拒绝默认口令（allowDefaultCredentials=false）。

import { verifyPassword } from './password.js';
import { DEFAULT_SEED_USERS, type UserStore } from './user-store.js';
import { signJwt, verifyJwt, type JwtPayload } from './jwt.js';
import { toPublicUser, type User } from './user.js';
import type { AuditLog } from '../audit/audit-log.js';
import { DEV_FALLBACK_JWT_SECRET, isKnownInsecureJwtSecret } from '../security/index.js';
import { CodedError, ErrorCode } from '../../core/errors.js';

/** 默认种子用户用户名（生产环境 allowDefaultCredentials=false 时禁止登录） */
const DEFAULT_USERNAMES = new Set(DEFAULT_SEED_USERS.map((u) => u.username));

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  /** access token 有效秒数 */
  expiresIn: number;
  user: User;
}

export interface AuthServiceOptions {
  /** JWT 签名密钥（缺省用 JWT_SECRET 或开发默认值） */
  secret?: string;
  accessTtlSeconds?: number;
  refreshTtlSeconds?: number;
  issuer?: string;
  /** 时间源（毫秒；测试确定性） */
  now?: () => number;
  /** 是否允许默认种子用户口令登录（production 必须 false） */
  allowDefaultCredentials?: boolean;
  /** 强制安全密钥（Phase 27.1）：生产/预发模式禁止使用缺失或开发默认 JWT_SECRET，否则拒绝装配 */
  requireSecureSecret?: boolean;
  /** 审计（可选）：登录 / 登出 / 刷新记录 */
  audit?: AuditLog;
}

interface RefreshRecord {
  userId: string;
  expiresAt: number;
}

export class AuthService {
  private readonly secret: string;
  private readonly accessTtl: number;
  private readonly refreshTtl: number;
  private readonly issuer: string;
  private readonly nowMs: () => number;
  private readonly refreshStore = new Map<string, RefreshRecord>();
  private readonly revokedAccess = new Set<string>();

  constructor(
    private readonly users: UserStore,
    private readonly opts: AuthServiceOptions = {},
  ) {
    const rawSecret = opts.secret ?? process.env.JWT_SECRET;
    if (isKnownInsecureJwtSecret(rawSecret)) {
      if (opts.requireSecureSecret) {
        throw new Error(`[security] 生产/预发模式必须显式配置非默认 JWT_SECRET（当前缺失或使用开发默认值 ${DEV_FALLBACK_JWT_SECRET}）`);
      }
      this.secret = DEV_FALLBACK_JWT_SECRET;
    } else {
      this.secret = rawSecret;
    }
    this.accessTtl = opts.accessTtlSeconds ?? 3600;
    this.refreshTtl = opts.refreshTtlSeconds ?? 30 * 24 * 3600;
    this.issuer = opts.issuer ?? 'panqu-test-platform';
    this.nowMs = opts.now ?? (() => Date.now());
  }

  private nowSec(): number {
    return Math.floor(this.nowMs() / 1000);
  }

  /** 幂等种子用户（启动 / 测试调用） */
  async ensureSeeded(specs?: Parameters<UserStore['seed']>[0]): Promise<number> {
    return this.users.seed(specs);
  }

  /** 登录：用户名 + 密码 → access + refresh token */
  async login(username: string, password: string): Promise<AuthTokens> {
    if (this.opts.allowDefaultCredentials === false && DEFAULT_USERNAMES.has(username)) {
      throw new CodedError(ErrorCode.AUTH_FAILED, '默认账号在生产环境已禁用，请使用运维配置的用户', { expose: false });
    }
    const user = await this.users.getByUsername(username);
    if (!user || user.status !== 'ACTIVE') throw new CodedError(ErrorCode.AUTH_FAILED, '用户名或密码错误', { expose: false });
    if (!(await verifyPassword(password, user.passwordHash))) throw new CodedError(ErrorCode.AUTH_FAILED, '用户名或密码错误', { expose: false });
    const scopes = user.scopes;
    const accessToken = signJwt(
      {
        sub: user.id,
        username: user.username,
        roles: user.roles,
        scopes: scopes ? { projects: scopes.projects, environments: scopes.environments, businesses: scopes.businesses } : undefined,
        iss: this.issuer,
        type: 'access',
        iat: this.nowSec(),
      },
      this.secret,
      this.accessTtl,
    );
    const refreshToken = signJwt(
      { sub: user.id, username: user.username, roles: user.roles, iss: this.issuer, type: 'refresh', iat: this.nowSec() },
      this.secret,
      this.refreshTtl,
    );
    const rp = verifyJwt(refreshToken, this.secret, { allowType: 'refresh', nowSeconds: () => this.nowSec() });
    this.refreshStore.set(rp.jti, { userId: user.id, expiresAt: rp.exp });
    if (this.opts.audit) {
      await this.opts.audit.record({
        actor: user.username, role: user.roles.join(','), action: 'auth.login',
        resource: `auth:login:${user.id}`, result: 'success', traceId: `auth-${rp.jti}`,
      });
    }
    return { accessToken, refreshToken, expiresIn: this.accessTtl, user: toPublicUser(user) };
  }

  /** 登出：吊销 refresh token（同源 access jti 一并失效） */
  async logout(refreshToken?: string): Promise<void> {
    if (!refreshToken) return;
    try {
      const payload = verifyJwt(refreshToken, this.secret, { allowType: 'refresh', nowSeconds: () => this.nowSec() });
      this.refreshStore.delete(payload.jti);
      this.revokedAccess.add(payload.jti);
      if (this.opts.audit) {
        await this.opts.audit.record({
          actor: payload.username, role: payload.roles.join(','), action: 'auth.logout',
          resource: `auth:logout:${payload.sub}`, result: 'success', traceId: `auth-${payload.jti}`,
        });
      }
    } catch {
      /* 无效 token：视为已登出 */
    }
  }

  /** 刷新：校验 refresh token → 旋转签发新 access + refresh */
  async refresh(refreshToken: string): Promise<AuthTokens> {
    let payload: JwtPayload;
    try {
      payload = verifyJwt(refreshToken, this.secret, { allowType: 'refresh', nowSeconds: () => this.nowSec() });
    } catch (cause) {
      throw new CodedError(ErrorCode.AUTH_FAILED, 'refresh token 无效', { cause, expose: false });
    }
    const record = this.refreshStore.get(payload.jti);
    if (!record || record.userId !== payload.sub) throw new CodedError(ErrorCode.AUTH_FAILED, 'refresh token 已失效', { expose: false });
    const user = await this.users.getById(payload.sub);
    if (!user || user.status !== 'ACTIVE') throw new CodedError(ErrorCode.AUTH_FAILED, '用户不可用', { expose: false });
    // 旋转：旧 refresh 吊销，签发新对
    this.refreshStore.delete(payload.jti);
    const scopes = user.scopes;
    const accessToken = signJwt(
      {
        sub: user.id,
        username: user.username,
        roles: user.roles,
        scopes: scopes ? { projects: scopes.projects, environments: scopes.environments, businesses: scopes.businesses } : undefined,
        iss: this.issuer,
        type: 'access',
        iat: this.nowSec(),
      },
      this.secret,
      this.accessTtl,
    );
    const newRefresh = signJwt(
      { sub: user.id, username: user.username, roles: user.roles, iss: this.issuer, type: 'refresh', iat: this.nowSec() },
      this.secret,
      this.refreshTtl,
    );
    const nr = verifyJwt(newRefresh, this.secret, { allowType: 'refresh', nowSeconds: () => this.nowSec() });
    this.refreshStore.set(nr.jti, { userId: user.id, expiresAt: nr.exp });
    if (this.opts.audit) {
      await this.opts.audit.record({
        actor: user.username, role: user.roles.join(','), action: 'auth.refresh',
        resource: `auth:refresh:${user.id}`, result: 'success', traceId: `auth-${nr.jti}`,
      });
    }
    return { accessToken, refreshToken: newRefresh, expiresIn: this.accessTtl, user: toPublicUser(user) };
  }

  /** 校验 access token → 用户（API 中间件用） */
  async verify(token: string): Promise<{ user: User; payload: JwtPayload }> {
    let payload: JwtPayload;
    try {
      payload = verifyJwt(token, this.secret, { allowType: 'access', nowSeconds: () => this.nowSec() });
    } catch (cause) {
      throw new CodedError(ErrorCode.AUTH_FAILED, 'access token 无效', { cause, expose: false });
    }
    if (this.revokedAccess.has(payload.jti)) throw new CodedError(ErrorCode.AUTH_FAILED, 'token 已注销', { expose: false });
    const user = await this.users.getById(payload.sub);
    if (!user || user.status !== 'ACTIVE') throw new CodedError(ErrorCode.AUTH_FAILED, '用户不可用', { expose: false });
    return { user: toPublicUser(user), payload };
  }

  /** 当前登录用户信息（info） */
  async info(token: string): Promise<User> {
    const { user } = await this.verify(token);
    return user;
  }
}
