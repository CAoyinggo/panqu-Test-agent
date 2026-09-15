import { describe, expect, it } from 'vitest';
import {
  RoutingOracle,
  type MainSiteConfigSnapshot,
  type MainSiteRoutingVerdict,
  type GatewayChannelConfig,
} from '../../../src/devtest/routing.js';

describe('Routing - 独立分流真理判定与证据采集', () => {
  const baseConfig: MainSiteConfigSnapshot = {
    routeMode: 'newapi',
    globalModelIds: [84, 88, 12],
    globalApiKey: 'test-global',
    globalRouteRules: {
      video: {
        84: { resolutions: ['480p', '720p', '1080p'], aspect_ratios: ['auto', '16:9', '9:16', '1:1', '4:3', '3:4'] },
        88: { resolutions: ['480p', '720p', '1080p'], aspect_ratios: ['auto', '16:9', '9:16', '1:1', '4:3', '3:4'] },
        15: { resolutions: ['480p', '720p', '1080p', '4k'], aspect_ratios: ['auto', '16:9', '9:16', '1:1', '4:3', '3:4'] },
      },
    },
    groupRouteRules: {
      video: {
        panqu_test: {
          15: { resolutions: ['480p', '720p'], aspect_ratios: ['16:9', '9:16'] },
        },
      },
    },
    orgBindings: {
      10: { routeGroupId: 1, newapiGroup: 'panqu_test', status: 1, apiKey: 'test-org' },
    },
    modelAliases: {
      84: 'wan3.0-video',
      88: 'wan3.0-video-prime',
      15: 'seedance-2.0',
      12: 'pan-banana-pro',
    },
  };

  describe('1. 视频分流决策推导', () => {
    it('分流总开关为 off 时，全部任务回归直连链路 (line=0)', () => {
      const verdict = RoutingOracle.evaluateVideoMainSite(
        { videoType: 105, modelId: 84 },
        { ...baseConfig, routeMode: 'off' },
      );
      expect(verdict.willDivert).toBe(false);
      expect(verdict.decision).toBe('FALLBACK_DIRECT');
      expect(verdict.line).toBe(0);
      expect(verdict.reason).toContain('总开关为 off');
    });

    it('分流模式为 legacy 时，回退原手动概率分流线路 (line=6)', () => {
      const verdict = RoutingOracle.evaluateVideoMainSite(
        { videoType: 105, modelId: 84 },
        { ...baseConfig, routeMode: 'legacy' },
      );
      expect(verdict.willDivert).toBe(false);
      expect(verdict.decision).toBe('FALLBACK_LEGACY');
      expect(verdict.line).toBe(6);
    });

    it('全量开放模型 (is_newapi_global=1) 绕过组织直接使用全局Key分流 (orgId=0, line=10)', () => {
      const verdict = RoutingOracle.evaluateVideoMainSite(
        { videoType: 105, modelId: 84 },
        baseConfig,
      );
      expect(verdict.willDivert).toBe(true);
      expect(verdict.decision).toBe('NEWAPI_GLOBAL');
      expect(verdict.line).toBe(10);
      expect(verdict.expectedSnapshot?.newapiModel).toBe('wan3.0-video');
    });

    it('真人人像硬性拦截回退直连链路', () => {
      const verdict = RoutingOracle.evaluateVideoMainSite(
        { videoType: 105, modelId: 84, hasRealHuman: true },
        baseConfig,
      );
      expect(verdict.willDivert).toBe(false);
      expect(verdict.decision).toBe('FALLBACK_DIRECT');
      expect(verdict.reason).toContain('真人人像');
    });

    it('提示词超过 5000 字触发前置拦截', () => {
      const longCueword = 'a'.repeat(5001);
      const verdict = RoutingOracle.evaluateVideoMainSite(
        { videoType: 105, modelId: 84, cueword: longCueword },
        baseConfig,
      );
      expect(verdict.willDivert).toBe(false);
      expect(verdict.decision).toBe('BLOCKED_ILLEGAL');
      expect(verdict.reason).toContain('超过 5000 字上限');
    });

    it('MOV 输出格式不支持分流，回退直连', () => {
      const verdict = RoutingOracle.evaluateVideoMainSite(
        { videoType: 105, modelId: 84, outputFormat: 'mov' },
        baseConfig,
      );
      expect(verdict.willDivert).toBe(false);
      expect(verdict.decision).toBe('FALLBACK_DIRECT');
      expect(verdict.reason).toContain('MOV');
    });

    it('非全量模型满足组织配置与能力并集命中 NEWAPI_ORG_GROUP 分流', () => {
      const verdict = RoutingOracle.evaluateVideoMainSite(
        {
          videoType: 6,
          modelId: 15,
          taskType: 28,
          resolution: '720p',
          aspectRatio: '16:9',
          userGroupIds: [10],
        },
        baseConfig,
      );
      expect(verdict.willDivert).toBe(true);
      expect(verdict.decision).toBe('NEWAPI_ORG_GROUP');
      expect(verdict.line).toBe(10);
      expect(verdict.expectedSnapshot).toEqual({
        orgId: 10,
        routeGroupId: 1,
        newapiGroup: 'panqu_test',
        newapiModel: 'seedance-2.0',
      });
    });
  });

  describe('2. 图片分流决策推导', () => {
    it('服务线路非 r 时静默走原渠道', () => {
      const verdict = RoutingOracle.evaluateImageMainSite(
        { selmodelsId: 12, serviceline: 't', userGroupIds: [10] },
        baseConfig,
      );
      expect(verdict.willDivert).toBe(false);
      expect(verdict.reason).toContain('非 r');
    });

    it('满足图片分流条件时正确命中 NewAPI 图片分流', () => {
      const verdict = RoutingOracle.evaluateImageMainSite(
        { selmodelsId: 12, serviceline: 'r', imageList: ['http://img1.png'], userGroupIds: [10] },
        baseConfig,
      );
      expect(verdict.willDivert).toBe(true);
      expect(verdict.decision).toBe('NEWAPI_IMAGE');
      expect(verdict.line).toBe(10);
      expect(verdict.expectedSnapshot?.newapiModel).toBe('pan-banana-pro');
    });
  });

  describe('3. 网关层渠道筛选与加权推导', () => {
    const channels: GatewayChannelConfig[] = [
      { id: 36, name: '万相—yhuo', group: 'panqu_test', models: ['wan3.0-video'], status: 1, weight: 8, dailyQuotaLimit: 1000, usedQuota: 200 },
      { id: 37, name: '万相-备用', group: 'panqu_test', models: ['wan3.0-video'], status: 1, weight: 2, dailyQuotaLimit: 1000, usedQuota: 100 },
      { id: 38, name: '停用渠道', group: 'panqu_test', models: ['wan3.0-video'], status: 0, weight: 10, dailyQuotaLimit: 1000, usedQuota: 0 },
    ];

    it('正确过滤停用渠道并计算加权概率', () => {
      const result = RoutingOracle.evaluateGatewayRouting('panqu_test', 'wan3.0-video', 10, channels);
      expect(result.isBlockedByQuota).toBe(false);
      expect(result.candidateChannelIds).toEqual([36, 37]);
      expect(result.probabilities[36]).toBeCloseTo(0.8);
      expect(result.probabilities[37]).toBeCloseTo(0.2);
    });

    it('降级决策：Seedance 派发火山兜底，Wan3 直接失败', () => {
      expect(RoutingOracle.evaluateFallback(15).fallbackAction).toBe('VOLCENGINE_RETRY_QUEUE');
      expect(RoutingOracle.evaluateFallback(84).fallbackAction).toBe('DIRECT_FAIL_NO_RETRY');
    });
  });
});

