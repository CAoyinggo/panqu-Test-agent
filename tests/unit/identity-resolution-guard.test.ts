// Phase 36（DEBT-12 已解决）：身份解析统一 + 结构性守护测试
// 1. resolveStaticIdentity 功能（生产关闭 / 各模式解析 / 默认值 / 数组首项 / 空字符串回退）；
// 2. 结构性守护：X-Actor/X-Role 请求头读取仅存在于 security 模块（防新 API 入口绕过生产关闭）；
// 3. resolvePrincipal 身份解析唯一实现（防重复实现残留回归）；
// 4. 集成语义：isProductionLike / allowHeaderIdentity / resolveStaticIdentity 三者一致（生产关闭）。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveStaticIdentity,
  allowHeaderIdentity,
  isProductionLike,
} from '../../src/platform/security/index.js';

describe('resolveStaticIdentity（Phase 36，DEBT-12）', () => {
  it('生产模式返回 null（身份伪造关闭，不可回退静态身份）', () => {
    expect(resolveStaticIdentity('production', { 'x-actor': 'admin', 'x-role': 'ADMIN' })).toBeNull();
  });

  it('development/test/staging 模式解析 X-Actor/X-Role', () => {
    for (const m of ['development', 'test', 'staging'] as const) {
      expect(resolveStaticIdentity(m, { 'x-actor': 'tester', 'x-role': 'TESTER' })).toEqual({
        actor: 'tester',
        role: 'TESTER',
      });
    }
  });

  it('缺省回退：无 actor 默认 api，无 role 默认 VIEWER', () => {
    expect(resolveStaticIdentity('test', {})).toEqual({ actor: 'api', role: 'VIEWER' });
    expect(resolveStaticIdentity('development', { 'x-actor': 'u' })).toEqual({ actor: 'u', role: 'VIEWER' });
    expect(resolveStaticIdentity('staging', { 'x-role': 'ADMIN' })).toEqual({ actor: 'api', role: 'ADMIN' });
  });

  it('数组头取首项；空字符串回退默认值；非字符串被字符串化', () => {
    expect(resolveStaticIdentity('test', { 'x-actor': ['a', 'b'], 'x-role': ['R1', 'R2'] })).toEqual({
      actor: 'a',
      role: 'R1',
    });
    expect(resolveStaticIdentity('test', { 'x-actor': '', 'x-role': '' })).toEqual({ actor: 'api', role: 'VIEWER' });
    expect(resolveStaticIdentity('test', { 'x-actor': 42, 'x-role': null })).toEqual({ actor: '42', role: 'VIEWER' });
  });
});

describe('身份解析结构性守护（Phase 36，DEBT-12 回归防）', () => {
  const platformRoot = fileURLToPath(new URL('../../src/platform', import.meta.url));
  const allTs = (dir: string, acc: string[] = []): string[] => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) allTs(full, acc);
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) acc.push(full);
    }
    return acc;
  };
  const files = allTs(platformRoot);

  it(`X-Actor/X-Role 请求头读取仅存在于 security 模块（${files.length} 个平台源文件）`, () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      if (/headers\['x-actor'\]|headers\['x-role'\]|getHeader\('x-actor'\)|getHeader\('x-role'\)/.test(src)) {
        const rel = path.relative(platformRoot, f);
        if (!rel.endsWith('security/index.ts')) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it(`resolvePrincipal 身份解析唯一实现（仅 api/server.ts）`, () => {
    const srcRoot = fileURLToPath(new URL('../../src', import.meta.url));
    const all = allTs(srcRoot);
    const defs = all.filter((f) => fs.readFileSync(f, 'utf8').match(/function\s+resolvePrincipal\s*\(/));
    expect(defs).toHaveLength(1);
    expect(path.relative(srcRoot, defs[0])).toBe(path.join('platform', 'api', 'server.ts'));
  });
});

describe('身份解析集成语义（生产关闭不可绕过）', () => {
  it('production：isProductionLike=true 且 allowHeaderIdentity=false 且 resolveStaticIdentity=null', () => {
    expect(isProductionLike('production')).toBe(true);
    expect(allowHeaderIdentity('production')).toBe(false);
    expect(resolveStaticIdentity('production', { 'x-actor': 'root', 'x-role': 'OWNER' })).toBeNull();
  });

  it('非生产模式允许静态身份（staging 为生产演练模式，安全约束强但允许 X-Header 身份）', () => {
    for (const m of ['development', 'test', 'staging'] as const) {
      expect(isProductionLike(m)).toBe(m === 'staging'); // 仅 staging 视为生产类
      expect(allowHeaderIdentity(m)).toBe(true);
      expect(resolveStaticIdentity(m, { 'x-actor': 'u' })).not.toBeNull();
    }
  });
});
