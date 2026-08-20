// Benchmark Registry（Phase 45 / 42.13）
// 统一 Benchmark / Benchmark Version / Benchmark Case / Ground Truth / Result / Score。
// Benchmark 必须版本化（如 REQUIREMENT_BENCHMARK_v1、RISK_BENCHMARK_v1）。
// 名称规范：`<DOMAIN>_BENCHMARK_<version>`（version 形如 v1/v2）。

import type { EvaluationCase, EvaluationDomain } from '../contract.js';

export interface BenchmarkDefinition {
  /** 注册名：`<DOMAIN>_BENCHMARK_<version>` */
  name: string;
  /** 版本号：v1 / v2 ... */
  version: string;
  domain: EvaluationDomain;
  description?: string;
  /** 用例集（每条已内置 groundTruth；tracking 由 GroundTruthRegistry 决定） */
  cases: EvaluationCase[];
}

/** 解析 Benchmark 名 → { domain, version }；非法返回 null */
export function parseBenchmarkName(name: string): { domain: string; version: string } | null {
  const m = /^([A-Z_]+)_BENCHMARK_((?:v)\d+)$/.exec(name);
  if (!m) return null;
  return { domain: m[1], version: m[2] };
}

export class BenchmarkRegistry {
  private defs = new Map<string, BenchmarkDefinition>();

  constructor(initial?: BenchmarkDefinition[]) {
    for (const d of initial ?? []) this.register(d);
  }

  register(def: BenchmarkDefinition): this {
    if (!def || !def.name || !def.cases) throw new Error('Benchmark 缺少 name/cases');
    const parsed = parseBenchmarkName(def.name);
    if (!parsed || parsed.domain !== def.domain) {
      throw new Error(`Benchmark 命名必须为 <DOMAIN>_BENCHMARK_<vN> 且 domain 一致：${def.name} / ${def.domain}`);
    }
    if (this.defs.has(def.name)) {
      throw new Error(`Benchmark 已存在：${def.name}（同名必须升版本）`);
    }
    this.defs.set(def.name, { ...def, cases: [...def.cases] });
    return this;
  }

  has(name: string): boolean {
    return this.defs.has(name);
  }

  get(name: string): BenchmarkDefinition | undefined {
    const d = this.defs.get(name);
    return d ? { ...d, cases: [...d.cases] } : undefined;
  }

  /** 按领域取该领域最新版本 Benchmark */
  latest(domain: EvaluationDomain): BenchmarkDefinition | undefined {
    const candidates = [...this.defs.values()].filter((d) => d.domain === domain);
    if (candidates.length === 0) return undefined;
    candidates.sort((a, b) => versionRank(b.version) - versionRank(a.version));
    return { ...candidates[0], cases: [...candidates[0].cases] };
  }

  list(): BenchmarkDefinition[] {
    return [...this.defs.values()].map((d) => ({ ...d, cases: [...d.cases] }));
  }

  get size(): number {
    return this.defs.size;
  }
}

function versionRank(v: string): number {
  const m = /^v(\d+)$/.exec(v);
  return m ? Number(m[1]) : 0;
}

/** 全局默认注册表（各领域基准在此登记） */
export const benchmarkRegistry = new BenchmarkRegistry();
