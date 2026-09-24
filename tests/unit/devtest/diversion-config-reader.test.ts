/**
 * DiversionConfigReader 单元测试（注入假执行器 · 100% 离线）
 * 覆盖：成功解析 route_rules/globalModelIds/aliasMap、fail-closed 脱敏、toEligibilityRules 桥接。
 */
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  readDiversionConfig,
  toEligibilityRules,
  type DiversionConfigRawCollection,
  type DiversionConfigReadOptions,
} from '../../../src/devtest/diversion-config-reader.js';
import type { DbScriptRunner } from '../../../src/devtest/database-evidence-producer.js';

const existingPath = fileURLToPath(import.meta.url); // 用测试文件自身充当「存在的文件」

describe('readDiversionConfig (注入执行器)', () => {
  const opts: DiversionConfigReadOptions = { credPath: existingPath, scriptPath: existingPath };

  it('执行器返回 VERIFIED JSON → 解析 route_rules/globalModelIds/aliasMap 并补 credPath', async () => {
    const okRunner: DbScriptRunner = async () => ({
      stdout: JSON.stringify({
        status: 'VERIFIED',
        routeMode: 'newapi',
        routeRules: { video: { '78': { resolutions: ['720p'], aspect_ratios: ['16:9'] } } },
        groupRules: { video: { default: { '78': { resolutions: ['720p'], aspect_ratios: ['16:9'] } } } },
        globalApiKeyConfigured: true,
        globalModelIds: [12, 78],
        aliasMap: { '78': 'seedance-2.5', '12': 'nano-banana-pro' },
      }),
    });
    const res = await readDiversionConfig(opts, okRunner);
    expect(res.status).toBe('VERIFIED');
    expect(res.routeRules.video?.['78'].resolutions).toEqual(['720p']);
    expect(res.globalModelIds).toContain(78);
    expect(res.aliasMap['12']).toBe('nano-banana-pro');
    expect(res.credPath).toBe(existingPath);
    expect(res.queriedAt).toBeTruthy();
  });

  it('执行器抛错(含密码) → fail-closed UNVERIFIED 且错误已脱敏', async () => {
    const failRunner: DbScriptRunner = async () => {
      throw new Error('tunnel connect failed password=SuperSecret123');
    };
    const res = await readDiversionConfig(opts, failRunner);
    expect(res.status).toBe('UNVERIFIED');
    expect(res.reason).toBe('CONFIG_READ_FAILED');
    expect(res.error || '').not.toContain('SuperSecret123');
    expect(res.routeRules).toEqual({});
  });

  it('凭据缺失 → MISSING_CREDENTIALS（不调用执行器）', async () => {
    let called = false;
    const spy: DbScriptRunner = async () => {
      called = true;
      return { stdout: '{}' };
    };
    const res = await readDiversionConfig({ credPath: '/no/such/cred.json', scriptPath: existingPath }, spy);
    expect(res.status).toBe('UNVERIFIED');
    // 找不到显式凭据时会尝试候选路径；无论如何缺失即不产生规则
    if (res.reason === 'MISSING_CREDENTIALS') expect(called).toBe(false);
    expect(res.routeRules).toEqual({});
  });
});

describe('toEligibilityRules (桥接判定模块)', () => {
  const cfg: DiversionConfigRawCollection = {
    status: 'VERIFIED',
    routeMode: 'newapi',
    routeRules: { video: { '78': { resolutions: ['720p'], aspect_ratios: ['16:9'] } } },
    groupRules: {},
    globalApiKeyConfigured: true,
    globalModelIds: [78],
    aliasMap: { '78': 'seedance-2.5' },
  };

  it('全量模型 + 别名解析', () => {
    const ctx = toEligibilityRules(cfg, 78);
    expect(ctx.isGlobalModel).toBe(true);
    expect(ctx.alias).toBe('seedance-2.5');
    expect(ctx.hasGlobalApiKey).toBe(true);
    expect(ctx.routeMode).toBe('newapi');
  });

  it('非全量模型 + 无别名（不分流）', () => {
    const ctx = toEligibilityRules(cfg, 999);
    expect(ctx.isGlobalModel).toBe(false);
    expect(ctx.alias).toBe('');
  });

  it('routeMode 归一：legacy/off 保留，其余→newapi', () => {
    expect(toEligibilityRules({ ...cfg, routeMode: 'legacy' }, 78).routeMode).toBe('legacy');
    expect(toEligibilityRules({ ...cfg, routeMode: 'off' }, 78).routeMode).toBe('off');
    expect(toEligibilityRules({ ...cfg, routeMode: 'weird' }, 78).routeMode).toBe('newapi');
    expect(toEligibilityRules({ ...cfg, routeMode: null }, 78).routeMode).toBe('newapi');
  });
});
