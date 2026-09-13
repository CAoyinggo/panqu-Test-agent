import { describe, expect, it } from 'vitest';
import { SelfTestPlanner } from '../../../src/devtest/self-test-planner.js';

describe('SelfTestPlanner (开发者自助测试规划智能体)', () => {
  it('从自然语言需求描述中自动识别业务领域、目标模型、风险与执行规划', () => {
    const plan = SelfTestPlanner.plan({
      requirement: '针对 Wan 3.0 视频模型（ID 84）接入 NewAPI 分流进行测试，包含扣费与产物核验',
      environment: 'test',
    });

    expect(plan.domain).toBe('VIDEO');
    expect(plan.targetModels).toHaveLength(1);
    expect(plan.targetModels[0].id).toBe(84);
    expect(plan.targetModels[0].alias).toBe('wan3.0-video');
    expect(plan.executionMode).toBe('API_INTEGRATION');
    expect(plan.scenarios.length).toBeGreaterThanOrEqual(6);
    expect(plan.executionDags.length).toBe(plan.scenarios.length);
    expect(plan.requiredOracles).toContain('RoutingOracle');
    expect(plan.requiredOracles).toContain('BillingOracle');
    expect(plan.requiredOracles).toContain('MediaInspector');
    expect(plan.requiredOracles).toContain('QualityGateEngine');
  });

  it('支持传入新模型规格（NewapiModelOnboardingSpec）自动规划全套上线测试', () => {
    const plan = SelfTestPlanner.plan({
      modelSpec: {
        modelId: 999,
        modelType: 'video',
        alias: 'custom-video-v1',
        isGlobal: true,
        taskType: 28,
        resolutions: ['1080p'],
        aspectRatios: ['16:9'],
      },
      environment: 'test',
    });

    expect(plan.domain).toBe('VIDEO');
    expect(plan.targetModels[0].id).toBe(999);
    expect(plan.targetModels[0].alias).toBe('custom-video-v1');
    expect(plan.targetModels[0].isGlobal).toBe(true);

    const happyPath = plan.scenarios.find((s) => s.kind === 'MAIN_HAPPY_PATH');
    expect(happyPath?.modelId).toBe(999);
    expect(happyPath?.payloadProfile?.prompt).toContain('999');
  });

  it('当需求指定 UI 交互且浏览器可用时自主选择 UI_E2E 模式', () => {
    const plan = SelfTestPlanner.plan({
      requirement: '通过浏览器页面表单点击提交生图任务并核查 UI 页面结果展示',
      browserAvailable: true,
    });

    expect(plan.executionMode).toBe('UI_E2E');
    expect(plan.modeReason).toContain('真实 UI_E2E');
  });

  it('当需求指定 UI 但环境无可用浏览器时安全降级为 API_INTEGRATION 且说明原因', () => {
    const plan = SelfTestPlanner.plan({
      requirement: '通过浏览器页面表单点击提交生图任务',
      browserAvailable: false,
    });

    expect(plan.executionMode).toBe('API_INTEGRATION');
    expect(plan.modeReason).toContain('缺少可用浏览器');
  });

  it('自动将含“分流”、“降级”关键字的需求推导为 DIVERSION 流程并生成双向决策场景', () => {
    const plan = SelfTestPlanner.plan({
      requirement: '针对旧模型接入 NewAPI 分流，若不满足准入条件则降级回退直连原链路',
    });

    expect(plan.flowType).toBe('DIVERSION');
    expect(plan.scope).toContain('已有模型分流测试');
    expect(plan.mandatoryBranches).toContain('ROUTING_DIVERSION');
    expect(plan.mandatoryBranches).toContain('DIVERSION_FALLBACK_DIRECT');
    expect(plan.scenarios.some((s) => s.kind === 'DIVERSION_FALLBACK_DIRECT')).toBe(true);
    expect(plan.scenarios.some((s) => s.kind === 'DIRECT_SPEC_MATRIX')).toBe(false);
  });

  it('自动将含“直接接入”、“新模型”关键字的需求推导为 DIRECT 流程并生成全规格参数矩阵场景', () => {
    const plan = SelfTestPlanner.plan({
      requirement: '直接接入新模型 Wan 2.5 视频模型，验证所有画幅与分辨率规格，代码写死直连',
    });

    expect(plan.flowType).toBe('DIRECT');
    expect(plan.scope).toContain('新模型直接接入测试');
    expect(plan.preconditions).toContain(
      '新接入模型白名单与直连路由分发逻辑已部署上线 (代码写死直连，免路由组配置)',
    );
    expect(plan.mandatoryBranches).toContain('DIRECT_SPEC_MATRIX');
    expect(plan.mandatoryBranches).not.toContain('DIVERSION_FALLBACK_DIRECT');
    expect(plan.scenarios.some((s) => s.kind === 'DIRECT_SPEC_MATRIX')).toBe(true);
    expect(plan.scenarios.some((s) => s.kind === 'INVALID_INPUT_BOUNDARY')).toBe(true);
    // 直连模式无需验证企业路由组鉴权隔离
    expect(plan.scenarios.some((s) => s.kind === 'PERMISSION_ISOLATION')).toBe(false);
  });

  it('支持开发者显式指定 flowType 覆盖推导结果', () => {
    const plan = SelfTestPlanner.plan({
      requirement: '测试 Wan 3.0',
      flowType: 'DIRECT',
    });

    expect(plan.flowType).toBe('DIRECT');
    expect(plan.scenarios.some((s) => s.kind === 'DIRECT_SPEC_MATRIX')).toBe(true);
  });
});
