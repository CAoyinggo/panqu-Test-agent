// Phase 45：Benchmark Registry（benchmark/registry.ts）单元测试
// 覆盖：register / get / list、parseBenchmarkName 解析 <DOMAIN>_BENCHMARK_vN、
// 版本化校验（命名规范 / domain 一致 / 同名升版本）。

import { describe, it, expect } from 'vitest';
import {
  BenchmarkRegistry,
  parseBenchmarkName,
  type BenchmarkDefinition,
} from '../../src/eval/benchmark/registry.js';
import type { EvaluationCase, EvaluationDomain } from '../../src/eval/contract.js';

function makeCase(id: string, domain: EvaluationDomain): EvaluationCase {
  return { id, domain, input: {}, groundTruth: {} };
}

function makeDef(name: string, domain: EvaluationDomain, cases: EvaluationCase[] = []): BenchmarkDefinition {
  return {
    name,
    version: name.split('_BENCHMARK_')[1] ?? 'v1',
    domain,
    description: `${domain} 测试基准`,
    cases,
  };
}

describe('BenchmarkRegistry register / get / list', () => {
  it('register 后 has / get / list 均可访问', () => {
    const reg = new BenchmarkRegistry();
    reg.register(makeDef('REQUIREMENT_BENCHMARK_v1', 'REQUIREMENT', [makeCase('r-1', 'REQUIREMENT')]));
    expect(reg.has('REQUIREMENT_BENCHMARK_v1')).toBe(true);
    expect(reg.get('REQUIREMENT_BENCHMARK_v1')?.domain).toBe('REQUIREMENT');
    expect(reg.get('REQUIREMENT_BENCHMARK_v1')?.cases).toHaveLength(1);
    expect(reg.list()).toHaveLength(1);
    expect(reg.size).toBe(1);
  });

  it('get / list 返回副本，修改不影响注册表内部', () => {
    const reg = new BenchmarkRegistry();
    reg.register(makeDef('RISK_BENCHMARK_v1', 'RISK', [makeCase('risk-1', 'RISK')]));
    const fetched = reg.get('RISK_BENCHMARK_v1')!;
    fetched.cases.push(makeCase('hack', 'RISK'));
    expect(reg.get('RISK_BENCHMARK_v1')!.cases).toHaveLength(1);

    const listed = reg.list()[0];
    listed.cases.length = 0;
    expect(reg.get('RISK_BENCHMARK_v1')!.cases).toHaveLength(1);
  });

  it('未注册名 → get undefined / has false', () => {
    const reg = new BenchmarkRegistry();
    expect(reg.get('REQUIREMENT_BENCHMARK_v9')).toBeUndefined();
    expect(reg.has('REQUIREMENT_BENCHMARK_v9')).toBe(false);
  });
});

describe('parseBenchmarkName 解析 <DOMAIN>_BENCHMARK_vN', () => {
  it('合法名称解析为 { domain, version }', () => {
    expect(parseBenchmarkName('REQUIREMENT_BENCHMARK_v1')).toEqual({ domain: 'REQUIREMENT', version: 'v1' });
    expect(parseBenchmarkName('RISK_BENCHMARK_v2')).toEqual({ domain: 'RISK', version: 'v2' });
    expect(parseBenchmarkName('TEST_DESIGN_BENCHMARK_v10')).toEqual({ domain: 'TEST_DESIGN', version: 'v10' });
  });

  it('非法名称返回 null', () => {
    expect(parseBenchmarkName('REQUIREMENT_BENCHMARK')).toBeNull(); // 缺版本
    expect(parseBenchmarkName('REQUIREMENT_BENCHMARK_1')).toBeNull(); // 版本非 vN
    expect(parseBenchmarkName('requirement_benchmark_v1')).toBeNull(); // 小写
    expect(parseBenchmarkName('REQUIREMENT_v1')).toBeNull(); // 缺 _BENCHMARK_
    expect(parseBenchmarkName('REQUIREMENT_BENCHMARK_v1_extra')).toBeNull(); // 多余后缀
    expect(parseBenchmarkName('')).toBeNull();
  });
});

describe('版本化校验（register 校验）', () => {
  it('命名非法抛错（缺少 _BENCHMARK_ / 版本）', () => {
    const reg = new BenchmarkRegistry();
    expect(() => reg.register(makeDef('REQUIREMENT_BENCHMARK', 'REQUIREMENT'))).toThrow(/命名必须为/);
    expect(() => reg.register(makeDef('REQUIREMENT_BENCHMARK_1', 'REQUIREMENT'))).toThrow(/命名必须为/);
  });

  it('name 的 domain 与声明 domain 不一致抛错', () => {
    const reg = new BenchmarkRegistry();
    expect(() => reg.register(makeDef('REQUIREMENT_BENCHMARK_v1', 'RISK'))).toThrow(/domain 一致/);
  });

  it('同名重复注册抛错（必须升版本）', () => {
    const reg = new BenchmarkRegistry();
    reg.register(makeDef('REQUIREMENT_BENCHMARK_v1', 'REQUIREMENT'));
    expect(() => reg.register(makeDef('REQUIREMENT_BENCHMARK_v1', 'REQUIREMENT'))).toThrow(/已存在/);
  });

  it('缺 name / cases 抛错', () => {
    const reg = new BenchmarkRegistry();
    expect(() => reg.register({ name: '', version: 'v1', domain: 'REQUIREMENT', cases: [] } as BenchmarkDefinition)).toThrow(/缺少 name\/cases/);
  });
});

describe('latest：按领域取最新版本', () => {
  it('同一领域注册 v1 / v2 → latest 返回 v2', () => {
    const reg = new BenchmarkRegistry();
    reg.register(makeDef('REQUIREMENT_BENCHMARK_v1', 'REQUIREMENT', [makeCase('r1', 'REQUIREMENT')]));
    reg.register(makeDef('REQUIREMENT_BENCHMARK_v2', 'REQUIREMENT', [makeCase('r2', 'REQUIREMENT')]));
    const latest = reg.latest('REQUIREMENT');
    expect(latest?.name).toBe('REQUIREMENT_BENCHMARK_v2');
    expect(latest?.version).toBe('v2');
    expect(reg.size).toBe(2);
  });

  it('无该领域注册 → latest undefined', () => {
    const reg = new BenchmarkRegistry();
    reg.register(makeDef('RELEASE_BENCHMARK_v1', 'RELEASE'));
    expect(reg.latest('RCA')).toBeUndefined();
  });
});
