// 单元测试：环境策略跨层一致性（DEBT-01，Phase 33）
// 校验三层环境策略模型（agent 层启用守卫 / 平台层动作分级 / 安全模块运行模式加固）
// 的互操作契约与纵深防御不变量，防止任一层单独演进造成安全漂移。
import { describe, it, expect, afterEach } from 'vitest';
import {
  resolveEnvironmentTier,
  isProductionTier,
  guardProductionAction,
  PRODUCTION_FORBIDDEN_ACTIONS,
} from '../../src/config/environment-policy.js';
import {
  resolveEnvironmentDecision,
  isProductionLike,
  environmentTypeToTier,
  environmentTypeToMode,
  PRODUCTION_LIKE_GUARD_TIERS,
  type ToolActionLevel,
  type PolicyDecision,
} from '../../src/platform/projects/environment-policy.js';
import {
  resolvePlatformMode,
  isProductionLike as isModeProductionLike,
} from '../../src/platform/security/index.js';
import type { EnvironmentType } from '../../src/platform/projects/project-schema.js';

const ALL_TYPES: EnvironmentType[] = ['dev', 'test', 'staging', 'preprod', 'production'];
const ALL_ACTIONS: ToolActionLevel[] = ['read', 'safe', 'risky', 'dangerous'];

describe('跨层映射契约（environmentTypeToTier / environmentTypeToMode）', () => {
  it('平台环境类型 → agent 守卫档位：dev/test→test、staging/preprod→preonline、production→production', () => {
    expect(environmentTypeToTier('dev')).toBe('test');
    expect(environmentTypeToTier('test')).toBe('test');
    expect(environmentTypeToTier('staging')).toBe('preonline');
    expect(environmentTypeToTier('preprod')).toBe('preonline');
    expect(environmentTypeToTier('production')).toBe('production');
  });

  it('映射与 agent resolveEnvironmentTier 对同一环境名解析一致（防漂移）', () => {
    for (const type of ALL_TYPES) {
      expect(environmentTypeToTier(type)).toBe(resolveEnvironmentTier(type));
    }
  });

  it('平台环境类型 → 平台运行模式：dev→development、test→test、staging/preprod→staging、production→production', () => {
    expect(environmentTypeToMode('dev')).toBe('development');
    expect(environmentTypeToMode('test')).toBe('test');
    expect(environmentTypeToMode('staging')).toBe('staging');
    expect(environmentTypeToMode('preprod')).toBe('staging');
    expect(environmentTypeToMode('production')).toBe('production');
  });
});

describe('生产类环境三模型一致（staging/preprod/production）', () => {
  it('平台 isProductionLike 只对 staging/preprod/production 为 true', () => {
    for (const type of ALL_TYPES) {
      expect(isProductionLike(type)).toBe(type === 'staging' || type === 'preprod' || type === 'production');
    }
  });

  it('生产类类型的 agent 守卫档位落在生产类档位集合（preonline/production 均拒绝危险动作）', () => {
    for (const type of ALL_TYPES) {
      if (!isProductionLike(type)) continue;
      expect(PRODUCTION_LIKE_GUARD_TIERS).toContain(environmentTypeToTier(type));
    }
  });

  it('生产类类型的映射运行模式均被安全模块视为生产安全模式（staging/production）', () => {
    for (const type of ALL_TYPES) {
      if (!isProductionLike(type)) continue;
      expect(isModeProductionLike(environmentTypeToMode(type))).toBe(true);
    }
    // 非生产类类型不得误判为生产安全模式
    expect(isModeProductionLike(environmentTypeToMode('dev'))).toBe(false);
    expect(isModeProductionLike(environmentTypeToMode('test'))).toBe(false);
  });

  it('平台 isProductionTier 语义（production 档位最强）', () => {
    expect(isProductionTier('production')).toBe(true);
    expect(isProductionTier('preonline')).toBe(false);
  });
});

describe('危险动作跨层拒绝一致（禁止动作清单全覆盖）', () => {
  it('每个生产类环境：平台 dangerous → deny，且 agent 守卫拒绝全部禁止动作', () => {
    for (const type of ALL_TYPES) {
      if (!isProductionLike(type)) continue;
      expect(resolveEnvironmentDecision({ type }, 'dangerous')).toBe('deny');
      for (const action of PRODUCTION_FORBIDDEN_ACTIONS) {
        expect(guardProductionAction(type, action).allowed).toBe(false);
      }
    }
  });

  it('每个非生产类环境（dev/test）：平台 dangerous → approval（需审批），agent 守卫放行交给审批分级', () => {
    for (const type of ALL_TYPES) {
      if (isProductionLike(type)) continue;
      expect(resolveEnvironmentDecision({ type }, 'dangerous')).toBe('approval');
      for (const action of PRODUCTION_FORBIDDEN_ACTIONS) {
        expect(guardProductionAction(type, action).allowed).toBe(true);
      }
    }
  });

  it('risky 分级一致：staging/preprod/production → approval；dev/test → allow', () => {
    for (const type of ALL_TYPES) {
      const expected: PolicyDecision = isProductionLike(type) ? 'approval' : 'allow';
      expect(resolveEnvironmentDecision({ type }, 'risky')).toBe(expected);
    }
  });
});

describe('纵深防御不变量（agent 守卫不弱于平台策略）', () => {
  it('平台 deny ⇒ agent 守卫对同一环境必拒绝（任意禁止动作）', () => {
    for (const type of ALL_TYPES) {
      for (const action of ALL_ACTIONS) {
        const decision = resolveEnvironmentDecision({ type }, action);
        if (decision !== 'deny') continue;
        for (const forbidden of PRODUCTION_FORBIDDEN_ACTIONS) {
          expect(guardProductionAction(type, forbidden).allowed).toBe(false);
        }
      }
    }
  });

  it('平台 production 类型对 read/safe 允许，但 agent 守卫档位为 production（需显式启用才放行）——职责边界：平台项目环境由管理员显式配置即视为授权，agent 执行环境需 TESTFLOW_ALLOW_PRODUCTION', () => {
    expect(resolveEnvironmentDecision({ type: 'production' }, 'read')).toBe('allow');
    expect(resolveEnvironmentDecision({ type: 'production' }, 'safe')).toBe('allow');
    expect(environmentTypeToTier('production')).toBe('production');
    // 边界文档化的当前行为（两模型故意不同：平台策略只管分级，启用由 agent 守卫/运维配置决定）
    expect(isProductionTier(environmentTypeToTier('production'))).toBe(true);
  });
});

describe('禁止动作清单完整性（PRODUCTION_FORBIDDEN_ACTIONS 均为危险级）', () => {
  it('禁止动作在 preonline 档全部拒绝、test 档全部放行（与既有限定行为一致）', () => {
    for (const action of PRODUCTION_FORBIDDEN_ACTIONS) {
      expect(guardProductionAction('preonline', action).allowed).toBe(false);
      expect(guardProductionAction('test', action).allowed).toBe(true);
    }
  });

  it('每个禁止动作对应生产类平台环境的 dangerous 级 deny 决策', () => {
    // 禁止动作即「危险级」操作：在生产类环境被 agent 守卫拒绝，与平台 dangerous→deny 对齐
    for (const action of PRODUCTION_FORBIDDEN_ACTIONS) {
      for (const type of ['staging', 'preprod', 'production'] as EnvironmentType[]) {
        expect(guardProductionAction(type, action).allowed).toBe(false);
        expect(resolveEnvironmentDecision({ type }, 'dangerous')).toBe('deny');
      }
    }
  });
});

describe('安全模块运行模式解析与映射对齐（防别名漂移）', () => {
  afterEach(() => {
    delete process.env.PLATFORM_MODE;
  });

  it('resolvePlatformMode 别名与跨层映射一致（prod→production，未知值拒绝启动）', () => {
    expect(resolvePlatformMode('prod')).toBe('production');
    expect(resolvePlatformMode('staging')).toBe('staging');
    expect(resolvePlatformMode('test')).toBe('test');
    expect(resolvePlatformMode('development')).toBe('development');
    // 平台环境类型 preprod 不在 PlatformMode 已知集合，映射契约显式归入 staging（生产安全约束）
    expect(environmentTypeToMode('preprod')).toBe('staging');
    expect(environmentTypeToMode('preprod')).toBe(resolvePlatformMode('staging'));
  });
});
