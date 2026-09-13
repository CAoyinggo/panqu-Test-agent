import { describe, expect, it } from 'vitest';
import { ScenarioPlanner } from '../../../src/devtest/scenario-planner.js';

describe('ScenarioPlanner (风险驱动场景规划器)', () => {
  it('为新视频模型规划时生成包含视频专属介质、路由与退款的全套场景', () => {
    const { scenarios, risks } = ScenarioPlanner.plan({
      domain: 'VIDEO',
      targetModels: [
        {
          id: 84,
          type: 'video',
          alias: 'wan3.0-video',
          isGlobal: true,
          capabilities: { resolutions: ['720p'], aspectRatios: ['16:9'] },
        },
      ],
      hasBilling: true,
      hasFailureRefund: true,
      hasRouting: true,
      hasMediaAsset: true,
      hasIdempotency: true,
    });

    expect(scenarios.length).toBeGreaterThanOrEqual(6);
    expect(risks.length).toBeGreaterThanOrEqual(5);

    const happyPath = scenarios.find((s) => s.kind === 'MAIN_HAPPY_PATH');
    expect(happyPath).toBeDefined();
    expect(happyPath?.requiredOracles).toContain('RoutingOracle');
    expect(happyPath?.requiredOracles).toContain('MediaInspector');

    const routingScenario = scenarios.find((s) => s.kind === 'ROUTING_DIVERSION');
    expect(routingScenario).toBeDefined();
    expect(routingScenario?.requiredEvidence).toContain('EXTRA_DIVERSION_10');

    const refundScenario = scenarios.find((s) => s.kind === 'FAILURE_REFUND');
    expect(refundScenario).toBeDefined();
    expect(refundScenario?.payloadProfile?.expectFailure).toBe(true);

    const mediaScenario = scenarios.find((s) => s.kind === 'MEDIA_ASSET_VERIFICATION');
    expect(mediaScenario).toBeDefined();
    expect(mediaScenario?.requiredEvidence).toContain('BOX_FTYP_MOOV_MDAT');
  });

  it('为非全量企业分组图片模型规划时生成企业隔离权限场景', () => {
    const { scenarios, risks } = ScenarioPlanner.plan({
      domain: 'IMAGE',
      targetModels: [
        {
          id: 12,
          type: 'image',
          alias: 'runninghub-nano-banana-2',
          isGlobal: false, // 分组模型
        },
      ],
    });

    const permScenario = scenarios.find((s) => s.kind === 'PERMISSION_ISOLATION');
    expect(permScenario).toBeDefined();
    expect(permScenario?.whySelected).toContain('企业/未绑定路由组');

    const mediaScenario = scenarios.find((s) => s.kind === 'MEDIA_ASSET_VERIFICATION');
    expect(mediaScenario).toBeDefined();
    expect(mediaScenario?.requiredEvidence).toContain('IHDR_OR_SOF0_HEADER');

    const routingScenario = scenarios.find((s) => s.kind === 'ROUTING_DIVERSION');
    expect(routingScenario?.requiredEvidence).toContain('EXTRA_NEWAPI_IMAGE_1');
  });
});
