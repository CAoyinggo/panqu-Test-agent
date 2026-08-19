// Phase 35（DEBT-11 已解决）：失败分类共享模型唯一权威源守护测试
// 1. core 层 FAILURE_CATEGORIES 完整性与守卫正反例；
// 2. core 与 agents re-export 同一权威源（同一数组引用，杜绝双源漂移）；
// 3. core 分类清单与 RCA JSON Schema enum 完全一致（防分类改动漂移）；
// 4. 结构性依赖守护：src/platform/** 不得依赖 agents 域（消除类型级反向依赖回归）。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAILURE_CATEGORIES, isFailureCategory } from '../../src/core/failure-category.js';
import {
  FAILURE_CATEGORIES as AGENTS_FAILURE_CATEGORIES,
  isFailureCategory as agentsIsFailureCategory,
  ROOT_CAUSE_JSON_SCHEMA,
  type FailureCategory as AgentsFailureCategory,
} from '../../src/agents/analysis/root-cause-schema.js';
import type { FailureCategory } from '../../src/core/failure-category.js';

const ALL_CATEGORIES: readonly FailureCategory[] = [
  'ASSERTION', 'TIMEOUT', 'MODEL_ERROR', 'DATA_ERROR', 'ENVIRONMENT_ERROR',
  'NETWORK_ERROR', 'AUTH_ERROR', 'BILLING_ERROR', 'CONCURRENCY_ERROR',
  'RATE_LIMIT_ERROR', 'DEPENDENCY_ERROR', 'TEST_CODE_ERROR', 'UNKNOWN',
];

describe('core/failure-category（Phase 35，DEBT-11）', () => {
  it('FAILURE_CATEGORIES 完整 13 项、无重复、与类型字面量一一对应', () => {
    expect(FAILURE_CATEGORIES).toHaveLength(ALL_CATEGORIES.length);
    expect(new Set(FAILURE_CATEGORIES).size).toBe(FAILURE_CATEGORIES.length);
    for (const c of ALL_CATEGORIES) expect(FAILURE_CATEGORIES).toContain(c);
  });

  it('isFailureCategory 正反例（合法分类 / 大小写敏感 / 非字符串）', () => {
    expect(isFailureCategory('ASSERTION')).toBe(true);
    expect(isFailureCategory('UNKNOWN')).toBe(true);
    expect(isFailureCategory('DEPENDENCY_ERROR')).toBe(true);
    expect(isFailureCategory('assertion')).toBe(false);
    expect(isFailureCategory('ASSERTION ')).toBe(false);
    expect(isFailureCategory('NOPE')).toBe(false);
    expect(isFailureCategory(null)).toBe(false);
    expect(isFailureCategory(undefined)).toBe(false);
    expect(isFailureCategory(123)).toBe(false);
    expect(isFailureCategory({})).toBe(false);
  });

  it('core 与 agents re-export 为同一权威源（同一数组引用，无双源漂移）', () => {
    expect(AGENTS_FAILURE_CATEGORIES).toBe(FAILURE_CATEGORIES);
    expect(agentsIsFailureCategory).toBe(isFailureCategory);
  });

  it('agents re-export 兼容：经 root-cause-schema 导入的类型与函数可用', () => {
    const cat: AgentsFailureCategory = 'TIMEOUT';
    expect(agentsIsFailureCategory(cat)).toBe(true);
    expect(agentsIsFailureCategory('TEST_CODE_ERROR')).toBe(true);
  });

  it('core 分类清单与 RCA JSON Schema enum 完全一致（防分类改动漂移）', () => {
    const schemaEnum = (ROOT_CAUSE_JSON_SCHEMA.properties as { category: { enum: readonly string[] } }).category.enum;
    expect([...schemaEnum]).toEqual(FAILURE_CATEGORIES as unknown as string[]);
    expect([...schemaEnum]).toEqual(ALL_CATEGORIES as unknown as string[]);
  });
});

describe('结构性依赖守护：src/platform 不得依赖 agents 域（DEBT-11 回归防），Phase 35', () => {
  const root = fileURLToPath(new URL('../../src/platform', import.meta.url));
  const allFiles: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) allFiles.push(full);
    }
  };
  walk(root);

  it(`平台层 ${allFiles.length} 个源文件均无 agents 域 import`, () => {
    expect(allFiles.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const f of allFiles) {
      const src = fs.readFileSync(f, 'utf8');
      // 匹配 import ... from '...agents/...' 或动态 import('...agents/...') 或 require('...agents/...')
      if (/from\s+['"][^'"]*\/agents\/[^'"]*['"]/.test(src) || /import\s*\(\s*['"][^'"]*\/agents\/[^'"]*['"]\s*\)/.test(src) || /require\s*\(\s*['"][^'"]*\/agents\/[^'"]*['"]\s*\)/.test(src)) {
        offenders.push(path.relative(root, f));
      }
    }
    expect(offenders).toEqual([]);
  });
});
