// 单元测试：Model Router（Phase 17 模型路由 / Phase 20.1 环境变量档位）
// 覆盖：默认路由（高/中/小档位）、档位解析、自定义覆盖、配置优先级、环境变量档位加载
import { describe, it, expect, beforeEach } from 'vitest';
import {
  ModelRouter,
  modelRouter,
  loadTiersFromEnv,
  applyTiersFromEnv,
} from '../../src/llm/index.js';

describe('model-router - 默认路由', () => {
  it('Requirement/Analysis/RCA → 高能力模型', () => {
    const r = new ModelRouter();
    expect(r.route('requirement').model).toBe('gpt-4o');
    expect(r.route('analysis').model).toBe('gpt-4o');
    expect(r.route('rca').model).toBe('gpt-4o');
  });

  it('Test Design → 中高能力模型', () => {
    const r = new ModelRouter();
    expect(r.route('test-design').model).toBe('gpt-4o-mini');
  });

  it('Risk/简单分类 → 小模型', () => {
    const r = new ModelRouter();
    expect(r.route('risk').model).toBe('gpt-4o-mini');
    expect(r.route('classification').model).toBe('gpt-4o-mini');
  });

  it('fallbackModel 解析为具体模型', () => {
    const r = new ModelRouter();
    expect(r.route('requirement').fallbackModel).toBe('gpt-4o-mini');
  });

  it('temperature 与 timeout 随任务配置', () => {
    const r = new ModelRouter();
    expect(r.route('test-design').temperature).toBe(0.3);
    expect(r.route('risk').timeoutMs).toBe(10000);
    expect(r.route('classification').timeoutMs).toBe(8000);
  });
});

describe('model-router - 自定义', () => {
  it('自定义档位映射生效', () => {
    const r = new ModelRouter({ tiers: { high: 'deepseek-r1', medium: 'deepseek-v3', small: 'deepseek-v3-lite' } });
    expect(r.route('rca').model).toBe('deepseek-r1');
    expect(r.route('risk').model).toBe('deepseek-v3-lite');
  });

  it('configure 覆盖单任务路由', () => {
    const r = new ModelRouter();
    r.configure('rca', { model: 'deepseek-r1', maxTokens: 4000 });
    expect(r.route('rca').model).toBe('deepseek-r1');
    expect(r.route('rca').maxTokens).toBe(4000);
    // 不影响其他任务
    expect(r.route('risk').model).toBe('gpt-4o-mini');
  });

  it('具体模型名不被档位覆盖', () => {
    const r = new ModelRouter();
    r.configure('risk', { model: 'custom-llama' });
    expect(r.route('risk').model).toBe('custom-llama');
  });

  it('单例可复用', () => {
    expect(modelRouter.route('rca').model.length).toBeGreaterThan(0);
  });
});

describe('model-router - 环境变量档位（Phase 20.1）', () => {
  beforeEach(() => {
    for (const k of ['LLM_HIGH_MODEL', 'LLM_MEDIUM_MODEL', 'LLM_SMALL_MODEL']) delete process.env[k];
  });

  it('loadTiersFromEnv 读取高/中/小档位', () => {
    process.env.LLM_HIGH_MODEL = 'deepseek-r1';
    process.env.LLM_MEDIUM_MODEL = 'deepseek-v3';
    process.env.LLM_SMALL_MODEL = 'deepseek-v3-lite';
    const tiers = loadTiersFromEnv();
    expect(tiers).toEqual({ high: 'deepseek-r1', medium: 'deepseek-v3', small: 'deepseek-v3-lite' });
  });

  it('未设置任何档位时返回 undefined', () => {
    expect(loadTiersFromEnv()).toBeUndefined();
  });

  it('部分档位缺失时回填默认值', () => {
    process.env.LLM_HIGH_MODEL = 'deepseek-r1';
    const tiers = loadTiersFromEnv();
    expect(tiers).toEqual({ high: 'deepseek-r1', medium: 'gpt-4o-mini', small: 'gpt-4o-mini' });
  });

  it('applyTiersFromEnv 应用档位到 Router，并返回是否应用', () => {
    process.env.LLM_HIGH_MODEL = 'deepseek-r1';
    const router = new ModelRouter();
    const applied = applyTiersFromEnv(router);
    expect(applied).toBe(true);
    expect(router.route('rca').model).toBe('deepseek-r1');
    expect(router.route('risk').model).toBe('gpt-4o-mini');
  });

  it('无环境变量时 applyTiersFromEnv 返回 false 且不改动路由', () => {
    const router = new ModelRouter();
    expect(applyTiersFromEnv(router)).toBe(false);
    expect(router.route('rca').model).toBe('gpt-4o');
  });

  it('applyTiersFromEnv 可作用于单例', () => {
    process.env.LLM_HIGH_MODEL = 'glm-4-plus';
    process.env.LLM_SMALL_MODEL = 'glm-4-flash';
    expect(applyTiersFromEnv()).toBe(true);
    expect(modelRouter.route('requirement').model).toBe('glm-4-plus');
    expect(modelRouter.route('risk').model).toBe('glm-4-flash');
    // 清理，避免影响其他测试
    delete process.env.LLM_HIGH_MODEL;
    delete process.env.LLM_SMALL_MODEL;
    applyTiersFromEnv(); // 无档位，恢复默认映射失败 → 不应用，单例维持当前值（不影响本次断言）
  });
});
