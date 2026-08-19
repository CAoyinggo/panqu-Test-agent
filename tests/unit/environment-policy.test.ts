// 单元测试：生产环境安全策略（Phase 20.8）
// 覆盖：环境档位解析 / 生产显式开关 / 环境动作守卫（test/preonline/production 三档）
import { describe, it, expect, afterEach } from 'vitest';
import {
  resolveEnvironmentTier,
  isProductionTier,
  productionAllowed,
  guardProductionAction,
  describeEnvironmentPolicy,
  PRODUCTION_FORBIDDEN_ACTIONS,
} from '../../src/config/environment-policy.js';

const SAVED = process.env.TESTFLOW_ALLOW_PRODUCTION;

afterEach(() => {
  if (SAVED === undefined) delete process.env.TESTFLOW_ALLOW_PRODUCTION;
  else process.env.TESTFLOW_ALLOW_PRODUCTION = SAVED;
});

describe('resolveEnvironmentTier 档位解析', () => {
  it('test / 空 → test 档', () => {
    expect(resolveEnvironmentTier('test')).toBe('test');
    expect(resolveEnvironmentTier(undefined)).toBe('test');
    expect(resolveEnvironmentTier('')).toBe('test');
  });
  it('preonline / pre / staging / preprod → preonline 档', () => {
    expect(resolveEnvironmentTier('preonline')).toBe('preonline');
    expect(resolveEnvironmentTier('staging')).toBe('preonline');
    expect(resolveEnvironmentTier('pre')).toBe('preonline');
    expect(resolveEnvironmentTier('preprod')).toBe('preonline');
  });
  it('production / prod → production 档（大小写不敏感）', () => {
    expect(resolveEnvironmentTier('production')).toBe('production');
    expect(resolveEnvironmentTier('Production')).toBe('production');
    expect(resolveEnvironmentTier('prod')).toBe('production');
    expect(isProductionTier('prod')).toBe(true);
    expect(isProductionTier('test')).toBe(false);
  });
});

describe('guardProductionAction 环境动作守卫', () => {
  it('test 环境放行任意动作（审批策略继续分级）', () => {
    for (const a of PRODUCTION_FORBIDDEN_ACTIONS) {
      expect(guardProductionAction('test', a).allowed).toBe(true);
    }
  });

  it('preonline 环境拒绝危险动作', () => {
    expect(guardProductionAction('preonline', 'real-billing').allowed).toBe(false);
    expect(guardProductionAction('preonline', 'delete-data').allowed).toBe(false);
    expect(guardProductionAction('preonline', 'db-modify').allowed).toBe(false);
  });

  it('preonline 环境放行非危险动作', () => {
    expect(guardProductionAction('preonline', 'create-defect').allowed).toBe(true);
    expect(guardProductionAction('preonline', 'apply-healing').allowed).toBe(true);
  });

  it('production 未显式启用 → 拒绝（含读取类动作）', () => {
    delete process.env.TESTFLOW_ALLOW_PRODUCTION;
    expect(guardProductionAction('production', 'read-only').allowed).toBe(false);
    expect(guardProductionAction('production', 'run-production').reason).toContain('TESTFLOW_ALLOW_PRODUCTION');
  });

  it('production 显式启用且危险动作 → 仍拒绝', () => {
    process.env.TESTFLOW_ALLOW_PRODUCTION = 'true';
    expect(productionAllowed()).toBe(true);
    expect(guardProductionAction('production', 'real-billing').allowed).toBe(false);
    expect(guardProductionAction('production', 'payment').allowed).toBe(false);
    expect(guardProductionAction('production', 'stress-test').allowed).toBe(false);
  });

  it('production 显式启用且非危险动作 → 放行', () => {
    process.env.TESTFLOW_ALLOW_PRODUCTION = 'true';
    expect(guardProductionAction('production', 'create-defect').allowed).toBe(true);
    expect(guardProductionAction('production', 'read-only').allowed).toBe(true);
  });

  it('describeEnvironmentPolicy 摘要包含三档与危险动作', () => {
    const p = describeEnvironmentPolicy();
    expect(p.tiers).toEqual(['test', 'preonline', 'production']);
    expect(p.forbidden).toContain('real-billing');
    expect(p.productionEnabled).toBe(productionAllowed());
  });
});
