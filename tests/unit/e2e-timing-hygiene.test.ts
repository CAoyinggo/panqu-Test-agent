// Phase 37（DEBT-13 已解决）：E2E / 集成测试时序卫生守护测试
// 固化「慢 / 易碎测试」治理防线，防止未来引入时序敏感用例：
// 1. 禁止硬编码监听端口（必须 listen() 无参 / listen(0) 随机端口）；
// 2. 禁止对时间字段断言固定 ISO 字面量（允许 FIXED_ISO 固定时钟注入 —— 固定输入→固定输出，非 flaky）；
// 3. 禁止无轮询的固定长 sleep（≥1000ms 硬等，应为轮询 + 超时模式）。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCOPES = ['e2e', 'integration'].map((d) => fileURLToPath(new URL(`../../tests/${d}`, import.meta.url)));

const TIME_FIELD = 'createdAt|updatedAt|timestamp|startedAt|finishedAt|decidedAt|first_failed_at|created_at|submittedAt|approvedAt|triggeredAt|lastSeenAt';

function collectFiles(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) collectFiles(full, acc);
    else if (e.name.endsWith('.test.ts')) acc.push(full);
  }
  return acc;
}

describe('E2E / 集成时序卫生守护（Phase 37，DEBT-13 回归防）', () => {
  const files = SCOPES.flatMap((d) => collectFiles(d));

  it(`全部 ${files.length} 个 E2E/集成测试文件均无硬编码监听端口`, () => {
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      // listen(<100+ 数字>) —— 非随机端口
      if (/\blisten\(\s*[1-9]\d{2,}\b/.test(src)) offenders.push(path.basename(f));
    }
    expect(offenders).toEqual([]);
  });

  it(`全部测试文件均无对时间字段的固定 ISO 字面量断言（FIXED_ISO 注入除外）`, () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      // expect(...createdAt|timestamp|...).toBe('20xx-...' / toEqual('20xx-...
      const re = new RegExp(`\\b(?:${TIME_FIELD})\\b[^;]{0,120}\\.(?:toBe|toEqual)\\s*\\(\\s*['"]\\d{4}-`, 'g');
      if (re.test(src)) offenders.push(path.basename(f));
    }
    expect(offenders).toEqual([]);
  });

  it(`全部测试文件均无 ≥1000ms 固定 sleep（应为轮询 + 超时）`, () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      if (/setTimeout\([^,]*,\s*\d{4,}\s*\)/.test(src)) offenders.push(path.basename(f));
    }
    expect(offenders).toEqual([]);
  });
});

describe('审计确认（Phase 37，DEBT-13）：健壮模式已在 E2E/集成中采用', () => {
  it('随机端口 + FIXED_ISO 固定时钟注入 + 超时轮询模式存在（现状基线）', () => {
    const all = SCOPES.flatMap((d) => collectFiles(d)).map((f) => fs.readFileSync(f, 'utf8'));
    const joined = all.join('\n');
    expect(joined).toMatch(/server\.listen\(\)|listen\(0/); // 随机端口
    expect(joined).toMatch(/FIXED_ISO/);                      // 固定时钟注入
    expect(joined).toMatch(/Date\.now\(\) - start|Date\.now\(\) - t0/); // 轮询超时
  });
});
