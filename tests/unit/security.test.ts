// 单元测试：生产安全模式（Phase 27.1）
// 覆盖：模式解析 / 生产安全判断 / 不安全密钥识别 / 生产密钥强制 / 默认口令策略 /
//       静态身份来源开关 / Preflight 安全检查项（securityChecks）级别与内容。

import { describe, it, expect, vi } from 'vitest';
import {
  resolvePlatformMode,
  isProductionLike,
  isKnownInsecureJwtSecret,
  requireSecureJwtSecret,
  resolveAllowDefaultCredentials,
  allowHeaderIdentity,
  allowStaticToken,
  securityChecks,
  DEV_FALLBACK_JWT_SECRET,
} from '../../src/platform/security/index.js';

describe('resolvePlatformMode：运行模式解析', () => {
  it('缺省 development；大小写不敏感；prod 别名 → production', () => {
    expect(resolvePlatformMode()).toBe('development');
    expect(resolvePlatformMode('TEST')).toBe('test');
    expect(resolvePlatformMode('prod')).toBe('production');
    expect(resolvePlatformMode('Staging')).toBe('staging');
  });

  it('未知显式模式 → 抛错拒绝启动（禁止「未知值 → development」静默降级）', () => {
    expect(() => resolvePlatformMode('bogus')).toThrow(/未知 PLATFORM_MODE/);
    expect(() => resolvePlatformMode('producation')).toThrow(/未知 PLATFORM_MODE/);
    expect(() => resolvePlatformMode('stagingg')).toThrow(/未知 PLATFORM_MODE/);
  });

  it('前导/尾随空白与混合大小写被规范化（trim + toLowerCase，Phase 32）', () => {
    expect(resolvePlatformMode('  production  ')).toBe('production');
    expect(resolvePlatformMode('  PROD  ')).toBe('production');
    expect(resolvePlatformMode(' Staging ')).toBe('staging');
  });

  it('PLATFORM_MODE 优先，缺省时兼容 PLATFORM_ENVIRONMENT，避免生产模板降级为 development', () => {
    try {
      vi.stubEnv('PLATFORM_ENVIRONMENT', 'production');
      vi.stubEnv('PLATFORM_MODE', '');
      expect(resolvePlatformMode()).toBe('production');
      vi.stubEnv('PLATFORM_MODE', 'test');
      expect(resolvePlatformMode()).toBe('test');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('isProductionLike / isKnownInsecureJwtSecret', () => {
  it('production 与 staging 均为生产安全模式', () => {
    expect(isProductionLike('production')).toBe(true);
    expect(isProductionLike('staging')).toBe(true);
    expect(isProductionLike('development')).toBe(false);
    expect(isProductionLike('test')).toBe(false);
  });

  it('缺失或开发默认值均为不安全密钥', () => {
    expect(isKnownInsecureJwtSecret(undefined)).toBe(true);
    expect(isKnownInsecureJwtSecret('')).toBe(true);
    expect(isKnownInsecureJwtSecret(DEV_FALLBACK_JWT_SECRET)).toBe(true);
    expect(isKnownInsecureJwtSecret('real-secret')).toBe(false);
  });
});

describe('requireSecureJwtSecret：生产安全模式密钥强制（fail fast）', () => {
  it('production/staging 缺失或默认值 → 抛错拒绝启动', () => {
    expect(() => requireSecureJwtSecret('production', undefined)).toThrow(/JWT_SECRET/);
    expect(() => requireSecureJwtSecret('production', DEV_FALLBACK_JWT_SECRET)).toThrow(/JWT_SECRET/);
    expect(() => requireSecureJwtSecret('staging', undefined)).toThrow(/JWT_SECRET/);
    expect(() => requireSecureJwtSecret('staging', DEV_FALLBACK_JWT_SECRET)).toThrow(/JWT_SECRET/);
  });

  it('production/staging 显式非默认密钥 → 通过', () => {
    expect(requireSecureJwtSecret('production', 'strong-secret')).toBe('strong-secret');
    expect(requireSecureJwtSecret('staging', 'strong-secret')).toBe('strong-secret');
  });

  it('development/test 缺失时回退开发密钥（不阻断开发）', () => {
    expect(requireSecureJwtSecret('development', undefined)).toBe(DEV_FALLBACK_JWT_SECRET);
    expect(requireSecureJwtSecret('test', 'custom')).toBe('custom');
  });
});

describe('resolveAllowDefaultCredentials：默认种子口令策略', () => {
  it('production/staging 强制禁用（显式 true 亦被覆盖）', () => {
    expect(resolveAllowDefaultCredentials('production')).toBe(false);
    expect(resolveAllowDefaultCredentials('production', true)).toBe(false);
    expect(resolveAllowDefaultCredentials('staging')).toBe(false);
    expect(resolveAllowDefaultCredentials('staging', true)).toBe(false);
  });

  it('非生产类模式：显式值优先，缺省 true', () => {
    expect(resolveAllowDefaultCredentials('development')).toBe(true);
    expect(resolveAllowDefaultCredentials('test', false)).toBe(false);
  });
});

describe('allowHeaderIdentity / allowStaticToken：静态身份来源', () => {
  it('staging/production 一律禁止 X-Actor/X-Role 与静态 Token（含 dev-token）；仅 development/test 允许', () => {
    expect(allowHeaderIdentity('production')).toBe(false);
    expect(allowHeaderIdentity('staging')).toBe(false);
    expect(allowHeaderIdentity('development')).toBe(true);
    expect(allowHeaderIdentity('test')).toBe(true);
    expect(allowStaticToken('production')).toBe(false);
    expect(allowStaticToken('staging')).toBe(false);
    expect(allowStaticToken('development')).toBe(true);
    expect(allowStaticToken('test')).toBe(true);
  });
});

describe('securityChecks：Preflight 安全检查项', () => {
  it('development（无密钥）→ 无 BLOCK，JWT 与静态身份为 WARN', () => {
    const items = securityChecks('development', { jwtSecret: undefined });
    expect(items.some((i) => i.level === 'BLOCK')).toBe(false);
    const jwt = items.find((i) => i.name === 'JWT 密钥');
    expect(jwt?.level).toBe('WARN');
    const identity = items.find((i) => i.name === '静态身份来源');
    expect(identity?.level).toBe('WARN');
  });

  it('production 缺密钥 → JWT 密钥 BLOCK（阻断）', () => {
    const items = securityChecks('production', { jwtSecret: undefined });
    const jwt = items.find((i) => i.name === 'JWT 密钥');
    expect(jwt?.level).toBe('BLOCK');
  });

  it('production 默认口令允许 → 默认口令 BLOCK（阻断）', () => {
    const items = securityChecks('production', { jwtSecret: 'strong', allowDefaultCredentials: true });
    const cred = items.find((i) => i.name === '默认口令');
    expect(cred?.level).toBe('BLOCK');
  });

  it('production 全合规 → 全部 PASS，静态身份 PASS', () => {
    const items = securityChecks('production', { jwtSecret: 'strong', allowDefaultCredentials: false });
    expect(items.every((i) => i.level === 'PASS')).toBe(true);
    const identity = items.find((i) => i.name === '静态身份来源');
    expect(identity?.level).toBe('PASS');
  });

  it('staging 与 production 同策略：缺密钥 → BLOCK；静态身份 PASS（已关闭，强制 JWT）', () => {
    const missing = securityChecks('staging', { jwtSecret: undefined });
    expect(missing.find((i) => i.name === 'JWT 密钥')?.level).toBe('BLOCK');
    const ok = securityChecks('staging', { jwtSecret: 'strong', allowDefaultCredentials: false });
    expect(ok.find((i) => i.name === '静态身份来源')?.level).toBe('PASS');
  });

  it('静态身份来源 detail：staging/production 关闭伪造（强制 JWT），development 提示可用', () => {
    const prod = securityChecks('production', { jwtSecret: 'strong', allowDefaultCredentials: false });
    const prodId = prod.find((i) => i.name === '静态身份来源')!;
    expect(prodId.level).toBe('PASS');
    expect(prodId.detail).toContain('已关闭');
    const staging = securityChecks('staging', { jwtSecret: 'strong', allowDefaultCredentials: false });
    expect(staging.find((i) => i.name === '静态身份来源')!.detail).toContain('已关闭');
    const dev = securityChecks('development', { jwtSecret: undefined });
    const devId = dev.find((i) => i.name === '静态身份来源')!;
    expect(devId.detail).toContain('静态身份可用');
    expect(devId.detail).toContain('development');
  });
});
