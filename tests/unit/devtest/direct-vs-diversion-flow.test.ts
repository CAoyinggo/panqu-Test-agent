import { describe, expect, it } from 'vitest';
import { SelfTestPlanner } from '../../../src/devtest/self-test-planner.js';
import { ScenarioPlanner } from '../../../src/devtest/scenario-planner.js';
import { ExecutionPlanner } from '../../../src/devtest/execution-planner.js';
import { parseCliArgs, main } from '../../../src/devtest/run-playwright-cli.js';

describe('Direct vs Diversion Flow (新模型直接接入 vs 已有模型分流)', () => {
  describe('1. 场景规划差异性验证 (ScenarioPlanner)', () => {
    it('【直接接入模式 (DIRECT)】生成规格矩阵与边界防御，不生成分流回退与路由组鉴权', () => {
      const { scenarios, risks } = ScenarioPlanner.plan({
        domain: 'VIDEO',
        flowType: 'DIRECT',
        targetModels: [
          {
            id: 99,
            type: 'video',
            alias: 'wan2.5-direct',
            isGlobal: false, // 即使是非全量，直连模式也无需走企业路由组
          },
        ],
      });

      const kinds = scenarios.map((s) => s.kind);
      expect(kinds).toContain('MAIN_HAPPY_PATH');
      expect(kinds).toContain('DIRECT_SPEC_MATRIX');
      expect(kinds).toContain('MEDIA_ASSET_VERIFICATION');
      expect(kinds).toContain('BILLING_RECONCILIATION');
      expect(kinds).toContain('FAILURE_REFUND');
      expect(kinds).toContain('RETRY_IDEMPOTENCY');
      expect(kinds).toContain('INVALID_INPUT_BOUNDARY');

      // 关键差异：直连模式绝不应该包含已有模型的分流回退或路由组鉴权场景
      expect(kinds).not.toContain('ROUTING_DIVERSION');
      expect(kinds).not.toContain('DIVERSION_FALLBACK_DIRECT');
      expect(kinds).not.toContain('PERMISSION_ISOLATION');
    });

    it('【已有模型分流模式 (DIVERSION)】生成路由快照、反向降级回退与企业路由组鉴权', () => {
      const { scenarios, risks } = ScenarioPlanner.plan({
        domain: 'VIDEO',
        flowType: 'DIVERSION',
        targetModels: [
          {
            id: 84,
            type: 'video',
            alias: 'wan3.0-diversion',
            isGlobal: false, // 非全量分流模型需验证企业组
          },
        ],
      });

      const kinds = scenarios.map((s) => s.kind);
      expect(kinds).toContain('MAIN_HAPPY_PATH');
      expect(kinds).toContain('ROUTING_DIVERSION');
      expect(kinds).toContain('DIVERSION_FALLBACK_DIRECT');
      expect(kinds).toContain('BILLING_RECONCILIATION');
      expect(kinds).toContain('FAILURE_REFUND');
      expect(kinds).toContain('RETRY_IDEMPOTENCY');
      expect(kinds).toContain('MEDIA_ASSET_VERIFICATION');
      expect(kinds).toContain('PERMISSION_ISOLATION');

      // 关键差异：分流模式无需新模型上线规格矩阵
      expect(kinds).not.toContain('DIRECT_SPEC_MATRIX');
      expect(kinds).not.toContain('INVALID_INPUT_BOUNDARY');

      // 验证反向降级回退场景设置了 simulateIneligible
      const fallbackScenario = scenarios.find((s) => s.kind === 'DIVERSION_FALLBACK_DIRECT');
      expect(fallbackScenario?.payloadProfile?.simulateIneligible).toBe(true);
      expect(fallbackScenario?.requiredEvidence).toContain('EXTRA_DIVERSION_NOT_NEWAPI');
    });
  });

  describe('2. 可执行 DAG 编排差异性验证 (ExecutionPlanner)', () => {
    it('【直接接入模式 (DIRECT)】DAG 正确编排全规格覆盖步骤与数据流输入输出', () => {
      const { scenarios } = ScenarioPlanner.plan({
        domain: 'IMAGE',
        flowType: 'DIRECT',
        targetModels: [
          {
            id: 201,
            type: 'image',
            alias: 'gpt-image-2.5',
            isGlobal: true,
          },
        ],
      });

      const dags = ExecutionPlanner.planDags(scenarios);
      expect(dags.length).toBe(scenarios.length);

      const specDag = dags.find((d) => d.scenarioId.includes('DIRECT_SPEC_MATRIX'));
      expect(specDag).toBeDefined();
      expect(specDag?.steps.some((s) => s.operation === 'SPEC_VALIDATION')).toBe(true);

      // 验证 DAG 首尾步骤闭环
      for (const dag of dags) {
        expect(dag.entryStepId).toBe(dag.steps[0].id);
        expect(dag.terminalStepId).toBe(dag.steps[dag.steps.length - 1].id);
        // 依赖有向无环校验：除首步骤外，所有步骤均依赖前序步骤
        dag.steps.slice(1).forEach((step) => {
          expect(step.dependsOn.length).toBeGreaterThan(0);
        });
      }
    });

    it('【已有模型分流模式 (DIVERSION)】DAG 正确编排资格不符回退步骤与快照校验', () => {
      const { scenarios } = ScenarioPlanner.plan({
        domain: 'VIDEO',
        flowType: 'DIVERSION',
        targetModels: [
          {
            id: 84,
            type: 'video',
            alias: 'wan3.0-diversion',
            isGlobal: true,
          },
        ],
      });

      const dags = ExecutionPlanner.planDags(scenarios);
      const fallbackDag = dags.find((d) => d.scenarioId.includes('FALLBACK_DIRECT'));
      expect(fallbackDag).toBeDefined();

      const submitStep = fallbackDag?.steps.find((s) => s.id.includes('SUBMIT_TASK'));
      expect(submitStep).toBeDefined();
      expect(submitStep?.requiredEvidence).toContain('EXTRA_DIVERSION_NOT_NEWAPI');
    });
  });

  describe('3. CLI 与自主测试规划集成验证 (Playwright CLI)', () => {
    it('CLI 正确解析 --flow direct 与 --flow diversion 参数', () => {
      const directOpts = parseCliArgs(['--flow', 'direct', '--model', '99']);
      expect(directOpts.flowType).toBe('DIRECT');
      expect(directOpts.modelId).toBe(99);

      const diversionOpts = parseCliArgs(['--flow', 'diversion', '--model', '84']);
      expect(diversionOpts.flowType).toBe('DIVERSION');
      expect(diversionOpts.modelId).toBe(84);

      // 非法 flowType 参数报错防御
      expect(() => parseCliArgs(['--flow', 'invalid'])).toThrow(/PLAYWRIGHT_ARG_INVALID/);
    });

    it('CLI 运行 --flow direct 模式输出正确规划', async () => {
      const exitCode = await main([
        '--flow', 'direct',
        '--model', '99',
        '--media', 'video',
        '--alias', 'test-new-video',
        '--plan-only',
      ]);

      expect(exitCode).toBe(0);
    });

    it('CLI 运行 --flow diversion 模式输出正确规划', async () => {
      const exitCode = await main([
        '--flow', 'diversion',
        '--model', '84',
        '--media', 'video',
        '--plan-only',
      ]);

      expect(exitCode).toBe(0);
    });
  });
});
