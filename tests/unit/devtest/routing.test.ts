import { describe, expect, it } from 'vitest';
import { RoutingOracle, type MainSiteConfigSnapshot, type GatewayChannelConfig } from '../../../src/devtest/routing.js';

describe('Routing - 独立分流真理判定与证据采集', () => {
  const baseConfig: MainSiteConfigSnapshot = {
    routeMode: 'newapi',
    globalModelIds: [84, 88, 12],
    globalApiKey: 'test-global',
    globalRouteRules: {
      video: {
        84: { resolutions: ['480p', '720p', '1080p'], aspect_ratios: ['auto', '16:9', '9:16', '1:1', '4:3', '3:4'] },
        88: { resolutions: ['480p', '720p', '1080p'], aspect_ratios: ['auto', '16:9', '9:16', '1:1', '4:3', '3:4'] },
        15: {
          resolutions: ['480p', '720p', '1080p', '4k'],
          aspect_ratios: ['auto', '16:9', '9:16', '1:1', '4:3', '3:4'],
        },
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
      const verdict = RoutingOracle.evaluateVideoMainSite({ videoType: 105, modelId: 84 }, baseConfig);
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

    it('分组渠道规格不匹配回退：当前路由分组无承接该分辨率/画幅渠道时回退直连 (line=0)', () => {
      // panqu_test 分组只配置了 15 号模型的 480p 与 720p，请求 1080p 应回退直连
      const verdict = RoutingOracle.evaluateVideoMainSite(
        {
          videoType: 6,
          modelId: 15,
          taskType: 28,
          resolution: '1080p',
          aspectRatio: '16:9',
          userGroupIds: [10],
        },
        baseConfig,
      );
      expect(verdict.willDivert).toBe(false);
      expect(verdict.decision).toBe('FALLBACK_DIRECT');
      expect(verdict.line).toBe(0);
      expect(verdict.reason).toContain('无承接分辨率 1080p 的渠道，回退直连');
    });

    it('多租户组织隔离：用户所属角色组未绑定任何 NewAPI 企业路由组时不分流', () => {
      const verdict = RoutingOracle.evaluateVideoMainSite(
        {
          videoType: 6,
          modelId: 15,
          taskType: 28,
          resolution: '720p',
          aspectRatio: '16:9',
          userGroupIds: [99999], // 未绑定组织
        },
        baseConfig,
      );
      expect(verdict.willDivert).toBe(false);
      expect(verdict.decision).toBe('FALLBACK_DIRECT');
      expect(verdict.line).toBe(0);
      expect(verdict.reason).toContain('未绑定任何有效的 NewAPI 路由组');
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

    it('网关准入门禁校验：自定义像素尺寸 (pixels) 或参考图超限 (>10张) 拦截回退直连', () => {
      // 1. 自定义像素尺寸 (pixels) 拦截回退直连
      const pixelVerdict = RoutingOracle.evaluateImageMainSite(
        { selmodelsId: 12, serviceline: 'r', sizeType: 'pixels', userGroupIds: [10] },
        baseConfig,
      );
      expect(pixelVerdict.willDivert).toBe(false);
      expect(pixelVerdict.decision).toBe('FALLBACK_DIRECT');
      expect(pixelVerdict.reason).toContain('自定义像素尺寸 (pixels) 不支持');

      // 2. 参考图数量超限 (>10张) 拦截回退直连
      const overflowImages = Array.from({ length: 11 }, (_, i) => `http://img_${i}.png`);
      const refVerdict = RoutingOracle.evaluateImageMainSite(
        { selmodelsId: 12, serviceline: 'r', imageList: overflowImages, userGroupIds: [10] },
        baseConfig,
      );
      expect(refVerdict.willDivert).toBe(false);
      expect(refVerdict.decision).toBe('FALLBACK_DIRECT');
      expect(refVerdict.reason).toContain('参考图数量 (11) 超过上限 10 张');
    });
  });

  describe('3. 网关层渠道筛选与加权推导', () => {
    const channels: GatewayChannelConfig[] = [
      {
        id: 36,
        name: '万相—yhuo',
        group: 'panqu_test',
        models: ['wan3.0-video'],
        status: 1,
        weight: 8,
        dailyQuotaLimit: 1000,
        usedQuota: 200,
      },
      {
        id: 37,
        name: '万相-备用',
        group: 'panqu_test',
        models: ['wan3.0-video'],
        status: 1,
        weight: 2,
        dailyQuotaLimit: 1000,
        usedQuota: 100,
      },
      {
        id: 38,
        name: '停用渠道',
        group: 'panqu_test',
        models: ['wan3.0-video'],
        status: 0,
        weight: 10,
        dailyQuotaLimit: 1000,
        usedQuota: 0,
      },
    ];

    it('正确过滤停用渠道并计算加权概率', () => {
      const result = RoutingOracle.evaluateGatewayRouting('panqu_test', 'wan3.0-video', 10, channels);
      expect(result.isBlockedByQuota).toBe(false);
      expect(result.candidateChannelIds).toEqual([36, 37]);
      expect(result.probabilities[36]).toBeCloseTo(0.8);
      expect(result.probabilities[37]).toBeCloseTo(0.2);
    });

    it('配额耗尽与模型不匹配熔断：渠道额度超限或模型未覆盖时触发拒绝并标记 isBlockedByQuota', () => {
      const quotaLimitedChannels: GatewayChannelConfig[] = [
        {
          id: 41,
          name: '限额渠道',
          group: 'panqu_test',
          models: ['wan3.0-video'],
          status: 1,
          weight: 10,
          dailyQuotaLimit: 100,
          usedQuota: 95,
        },
        {
          id: 42,
          name: '异构模型渠道',
          group: 'panqu_test',
          models: ['seedance-2.0'],
          status: 1,
          weight: 10,
          dailyQuotaLimit: 1000,
          usedQuota: 0,
        },
      ];

      // 请求 10 积分，渠道 41 额度不足 (95+10 > 100)，渠道 42 模型不匹配
      const result = RoutingOracle.evaluateGatewayRouting('panqu_test', 'wan3.0-video', 10, quotaLimitedChannels);
      expect(result.candidateChannelIds).toEqual([]);
      expect(result.isBlockedByQuota).toBe(true);
      expect(result.rejectedReasons[41]).toContain('超出每日限额');
      expect(result.rejectedReasons[42]).toContain('渠道不承接模型 wan3.0-video');
    });

    it('降级决策：Seedance 派发火山兜底，Wan3 直接失败', () => {
      expect(RoutingOracle.evaluateFallback(15).fallbackAction).toBe('VOLCENGINE_RETRY_QUEUE');
      expect(RoutingOracle.evaluateFallback(84).fallbackAction).toBe('DIRECT_FAIL_NO_RETRY');
    });
  });
});
