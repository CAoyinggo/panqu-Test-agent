// 单元测试：Platform Project / Environment（Phase 24.1）
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ProjectRegistry,
  ProjectService,
  standardEnvironments,
  validateEnvironments,
  findEnvironment,
  ENVIRONMENT_ACTION_POLICY,
  resolveEnvironmentDecision,
  isProductionLike,
} from '../../src/platform/projects/index.js';

/** 临时目录 + 关闭持久化，避免测试间污染 */
function makeRegistry(): { reg: ProjectRegistry; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p24-'));
  const reg = new ProjectRegistry({ file: path.join(dir, 'projects.json'), persist: true, now: () => '2026-08-18T00:00:00.000Z' });
  return { reg, dir };
}

describe('Project 生命周期', () => {
  it('create / get / list / update / delete', () => {
    const { reg } = makeRegistry();
    const p = reg.create({ id: 'wan3', name: 'WAN3 平台' });
    expect(reg.get('wan3')!.name).toBe('WAN3 平台');
    expect(reg.list()).toHaveLength(1);
    const updated = reg.update('wan3', { name: 'WAN3 平台 v2', businesses: ['biz-a'] });
    expect(updated.name).toBe('WAN3 平台 v2');
    expect(updated.businesses).toEqual(['biz-a']);
    expect(reg.get('wan3')!.updatedAt).toBe('2026-08-18T00:00:00.000Z');
    reg.delete('wan3');
    expect(reg.get('wan3')).toBeNull();
  });

  it('id 重复创建抛错', () => {
    const { reg } = makeRegistry();
    reg.create({ id: 'x', name: 'X' });
    expect(() => reg.create({ id: 'x', name: 'X2' })).toThrow(/已存在/);
  });

  it('默认环境必须存在，否则抛错', () => {
    const { reg } = makeRegistry();
    expect(() =>
      reg.create({
        id: 'y',
        name: 'Y',
        environments: [{ id: 'dev', name: 'dev', type: 'dev', enabled: true }],
        defaultEnvironment: 'missing',
      }),
    ).toThrow(/默认环境不存在/);
  });

  it('环境类型非法 / id 重复校验', () => {
    expect(validateEnvironments([{ id: 'a', name: 'a', type: 'dev' as const, enabled: true }])).toHaveLength(0);
    expect(
      validateEnvironments([
        { id: 'a', name: 'a', type: 'dev' as const, enabled: true },
        { id: 'a', name: 'a2', type: 'dev' as const, enabled: true },
        { id: 'b', name: 'b', type: 'weird' as never, enabled: true },
      ]),
    ).toHaveLength(2);
  });

  it('standardEnvironments 生成五档环境', () => {
    const envs = standardEnvironments();
    expect(envs.map((e) => e.type)).toEqual(['dev', 'test', 'staging', 'preprod', 'production']);
    expect(envs.every((e) => e.enabled)).toBe(true);
  });
});

describe('环境查找与隔离', () => {
  it('findEnvironment 按 id 或 name', () => {
    const { reg } = makeRegistry();
    const p = reg.create({ id: 'wan3', name: 'WAN3', defaultEnvironment: 'test' });
    expect(findEnvironment(p, 'test')!.type).toBe('test');
    expect(findEnvironment(p, 'staging')!.id).toBe('staging');
    expect(findEnvironment(p, 'nope')).toBeNull();
    expect(reg.getEnvironment('wan3', 'production')!.type).toBe('production');
    expect(reg.getEnvironment('other', 'test')).toBeNull();
  });

  it('updateEnvironments 保持默认环境有效', () => {
    const { reg } = makeRegistry();
    reg.create({ id: 'wan3', name: 'WAN3', defaultEnvironment: 'test' });
    const p = reg.updateEnvironments('wan3', [{ id: 'test', name: 'test', type: 'test', enabled: true }]);
    expect(p.defaultEnvironment).toBe('test');
    const p2 = reg.updateEnvironments('wan3', [{ id: 'dev', name: 'dev', type: 'dev', enabled: true }]);
    expect(p2.defaultEnvironment).toBe('dev');
  });
});

describe('环境安全策略（单一策略源）', () => {
  it('策略表符合任务书：dev/test 允许 risky、dangerous 需审批；staging/preprod/production 拒绝 dangerous、risky 需审批', () => {
    for (const t of ['dev', 'test'] as const) {
      expect(ENVIRONMENT_ACTION_POLICY[t].risky).toBe('allow');
      expect(ENVIRONMENT_ACTION_POLICY[t].dangerous).toBe('approval');
      expect(ENVIRONMENT_ACTION_POLICY[t].read).toBe('allow');
    }
    for (const t of ['staging', 'preprod', 'production'] as const) {
      expect(ENVIRONMENT_ACTION_POLICY[t].risky).toBe('approval');
      expect(ENVIRONMENT_ACTION_POLICY[t].dangerous).toBe('deny');
    }
  });

  it('isProductionLike 判定 staging/preprod/production', () => {
    expect(isProductionLike('staging')).toBe(true);
    expect(isProductionLike('preprod')).toBe(true);
    expect(isProductionLike('production')).toBe(true);
    expect(isProductionLike('test')).toBe(false);
  });

  it('resolveEnvironmentDecision：safetyPolicy 覆盖优先于单一策略源', () => {
    expect(resolveEnvironmentDecision({ type: 'test' }, 'dangerous')).toBe('approval');
    expect(resolveEnvironmentDecision({ type: 'production' }, 'dangerous')).toBe('deny');
    // 覆盖：production 将 dangerous 提升为 approval（需要额外审批，而非永远 deny）
    const override = {
      type: 'production' as const,
      safetyPolicy: { actions: { dangerous: 'approval' as const } },
    };
    expect(resolveEnvironmentDecision(override, 'dangerous')).toBe('approval');
  });

  it('ProjectService.checkAction 解析环境动作决策', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p24-'));
    const svc = new ProjectService({ file: path.join(dir, 'p.json'), persist: false });
    svc.createProject({ id: 'wan3', name: 'WAN3' });
    expect(svc.checkAction('wan3', 'test', 'risky').decision).toBe('allow');
    expect(svc.checkAction('wan3', 'production', 'dangerous').decision).toBe('deny');
    expect(svc.checkAction('wan3', 'production', 'risky').decision).toBe('approval');
    expect(svc.checkAction('wan3', 'production', 'risky').productionLike).toBe(true);
    expect(() => svc.checkAction('wan3', 'missing', 'read')).toThrow(/无环境/);
  });
});

describe('持久化', () => {
  it('save / load 往返一致', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p24-'));
    const file = path.join(dir, 'projects.json');
    const a = new ProjectRegistry({ file, persist: true });
    a.create({ id: 'wan3', name: 'WAN3', businesses: ['biz'], defaultEnvironment: 'staging' });
    const b = new ProjectRegistry({ file, persist: true });
    const p = b.get('wan3')!;
    expect(p.name).toBe('WAN3');
    expect(p.businesses).toEqual(['biz']);
    expect(p.defaultEnvironment).toBe('staging');
    expect(p.environments).toHaveLength(5);
  });
});
