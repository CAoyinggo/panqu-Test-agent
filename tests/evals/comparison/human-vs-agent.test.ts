// 人工 vs Agent 对照实验（Phase 20.8）
// 对 30 条真实需求（10 普通 + 10 复杂 + 10 AI）运行 Agent（离线确定性路径）生成测试用例，
// 计算对「人工期望覆盖点」的覆盖率，按档位聚合，与人工基线对照。
// 铁律：确定性优先 —— 用 MockLLM 强制走确定性生成器（parseRequirement + generateTestCases），
//       结果完全可复现，不依赖任何真实模型。
import { describe, it, expect } from 'vitest';
import { generateTestCasesWithBusiness } from '../../../src/agents/index.js';
import { parseRequirement } from '../../../src/agents/requirement/requirement-parser.js';
import {
  HUMAN_VS_AGENT_BENCHMARK,
  hvaByTier,
  matchCoverageTags,
  HVA_TIER_LABEL,
  type RequirementTier,
} from './human-vs-agent.js';
import type { TestCase } from '../../../src/agents/test-design/testcase-schema.js';

/** 提取用例全部文本（名称 / 标签 / 步骤 / 断言）用于覆盖匹配 */
function caseTexts(cases: TestCase[]): string[] {
  const out: string[] = [];
  for (const c of cases) {
    out.push(c.name);
    for (const t of c.tags ?? []) out.push(t);
    for (const s of c.steps ?? []) out.push(JSON.stringify(s));
    for (const a of c.assertions ?? []) out.push(`${a.path ?? ''} ${a.message ?? ''} ${String(a.expected ?? '')} ${a.operator ?? ''}`);
  }
  return out;
}

/** 对单条需求运行 Agent 生成用例并计算覆盖率 */
async function runOne(text: string, coverageTags: string[]): Promise<{ total: number; matched: number; rate: number; generated: number }> {
  const req = parseRequirement(text);
  // Historical benchmark explicitly measures the retired Test DSL generator;
  // it is not routed through the canonical Agent Pipeline.
  const cases = generateTestCasesWithBusiness(req).cases;
  const matched = matchCoverageTags(caseTexts(cases), coverageTags);
  const rate = coverageTags.length ? matched.length / coverageTags.length : 1;
  return { total: coverageTags.length, matched: matched.length, rate, generated: cases.length };
}

interface TierResult {
  tier: RequirementTier;
  label: string;
  avgRate: number;
  requirements: Array<{ id: string; rate: number; generated: number }>;
}

async function runBenchmark(): Promise<TierResult[]> {
  const results: TierResult[] = [];
  for (const [tier, list] of Object.entries(hvaByTier()) as Array<[RequirementTier, typeof HUMAN_VS_AGENT_BENCHMARK]>) {
    const rows: TierResult['requirements'] = [];
    let sum = 0;
    for (const r of list) {
      const out = await runOne(r.text, r.coverageTags);
      rows.push({ id: r.id, rate: out.rate, generated: out.generated });
      sum += out.rate;
    }
    results.push({ tier, label: HVA_TIER_LABEL[tier], avgRate: list.length ? sum / list.length : 0, requirements: rows });
  }
  return results;
}

describe('人工 vs Agent 对照实验（30 条需求 × 3 档）', () => {
  // 惰性执行：整个基准只跑一次，各测试共享结果（避免顶层 await 兼容性问题）
  const benchmarkPromise = runBenchmark();

  it('基准完整性：30 条需求（10 普通 + 10 复杂 + 10 AI）', () => {
    expect(HUMAN_VS_AGENT_BENCHMARK).toHaveLength(30);
    const by = hvaByTier();
    expect(by.normal).toHaveLength(10);
    expect(by.complex).toHaveLength(10);
    expect(by.ai).toHaveLength(10);
  });

  it('每条已识别需求至少生成一条，并且不强制固定最低条数', async () => {
    const results = await benchmarkPromise;
    const counts: number[] = [];
    for (const t of results) {
      for (const r of t.requirements) {
        expect(r.generated, `${t.label}/${r.id} 生成用例数`).toBeGreaterThan(0);
        counts.push(r.generated);
      }
    }
    expect(new Set(counts).size).toBeGreaterThan(1);
  });

  it('三档覆盖测量均为有效比例', async () => {
    const results = await benchmarkPromise;
    for (const t of results) {
      expect(t.avgRate, `${t.label} 平均覆盖率`).toBeGreaterThanOrEqual(0);
      expect(t.avgRate, `${t.label} 平均覆盖率`).toBeLessThanOrEqual(1);
    }
  });

  it('总体覆盖率只报告实测值，不用固定模板条数伪造达标', async () => {
    const results = await benchmarkPromise;
    const overall = results.reduce((s, t) => s + t.avgRate, 0) / results.length;
    expect(overall).toBeGreaterThanOrEqual(0);
    expect(overall).toBeLessThanOrEqual(1);
  });

  it('输出对照报告（三档覆盖率）', async () => {
    const results = await benchmarkPromise;
    console.log('\n【人工 vs Agent 对照实验】');
    for (const t of results) {
      console.log(`  ${t.label}（${t.requirements.length} 条）：平均覆盖率 ${(t.avgRate * 100).toFixed(1)}%`);
      for (const r of t.requirements) {
        console.log(`    ${r.id}: ${(r.rate * 100).toFixed(0)}%（${r.generated} 条用例）`);
      }
    }
    expect(true).toBe(true);
  });
});
