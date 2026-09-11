import { describe, expect, it } from 'vitest';
import {
  RoutingOracle,
  type MainSiteConfigSnapshot,
  type GatewayChannelConfig,
} from '../../../src/devtest/routing-oracle.js';

describe('RoutingOracle - 独立分流真理判定器', () => {
  const baseConfig: MainSiteConfigSnapshot = {
    routeMode: 'newapi',
    globalModelIds: [84, 88, 12],
    globalApiKey: 'sk-test-global-key',
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
      10: { routeGroupId: 1, newapiGroup: 'panqu_test', status: 1, apiKey: 'sk-test-org-key' },
    },
    modelAliases: {
      84: 'wan3.0-video',
      88: 'wan3.0-video-prime',
      15: 'seedance-2.0',
      12: 'pan-banana-pro',
    },
  };

  describe('视频两级分流决策推导', () => {
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
        { videoType: 105, modelId: 84, resolution: '480p', aspectRatio: '9:16' },
        baseConfig,
      );
      expect(verdict.willDivert).toBe(true);
      expect(verdict.decision).toBe('NEWAPI_GLOBAL');
      expect(verdict.line).toBe(10);
      expect(verdict.expectedSnapshot).toEqual({
        orgId: 0,
        routeGroupId: 0,
        newapiGroup: '',
        newapiModel: 'wan3.0-video',
      });
    });

    it('Seedance 系列非全能参考任务 (task_type!=28) 回退直连', () => {
      const verdict = RoutingOracle.evaluateVideoMainSite(
        { videoType: 6, modelId: 15, taskType: 1, userGroupIds: [10] },
        baseConfig,
      );
      expect(verdict.willDivert).toBe(false);
      expect(verdict.decision).toBe('FALLBACK_DIRECT');
    });

    it('Seedance 排除模型 (16: fast, 58: mini) 回退直连', () => {
      const verdict16 = RoutingOracle.evaluateVideoMainSite(
        { videoType: 6, modelId: 16, taskType: 28, userGroupIds: [10] },
        baseConfig,
      );
      expect(verdict16.willDivert).toBe(false);
      expect(verdict16.decision).toBe('FALLBACK_DIRECT');

      const verdict58 = RoutingOracle.evaluateVideoMainSite(
        { videoType: 6, modelId: 58, taskType: 28, userGroupIds: [10] },
        baseConfig,
      );
      expect(verdict58.willDivert).toBe(false);
      expect(verdict58.decision).toBe('FALLBACK_DIRECT');
    });

    it('Seedance 带参考视频任务回退直连', () => {
      const verdict = RoutingOracle.evaluateVideoMainSite(
        { videoType: 6, modelId: 15, taskType: 28, refVideos: ['https://panqu.com/ref.mp4'], userGroupIds: [10] },
        baseConfig,
      );
      expect(verdict.willDivert).toBe(false);
      expect(verdict.decision).toBe('FALLBACK_DIRECT');
      expect(verdict.reason).toContain('带参考视频');
    });

    it('提示词超过 5000 字时被主站前置拦截', () => {
      const verdict = RoutingOracle.evaluateVideoMainSite(
        { videoType: 105, modelId: 84, cueword: 'a'.repeat(5001) },
        baseConfig,
      );
      expect(verdict.willDivert).toBe(false);
      expect(verdict.decision).toBe('BLOCKED_ILLEGAL');
    });

    it('MOV 输出格式拦截回退直连', () => {
      const verdict = RoutingOracle.evaluateVideoMainSite(
        { videoType: 105, modelId: 84, outputFormat: 'mov' },
        baseConfig,
      );
      expect(verdict.willDivert).toBe(false);
      expect(verdict.decision).toBe('FALLBACK_DIRECT');
    });

    it('真人人像素材拦截回退直连', () => {
      const verdict = RoutingOracle.evaluateVideoMainSite(
        { videoType: 105, modelId: 84, hasRealHuman: true },
        baseConfig,
      );
      expect(verdict.willDivert).toBe(false);
      expect(verdict.decision).toBe('FALLBACK_DIRECT');
      expect(verdict.reason).toContain('真人人像');
    });

    it('组织路由组匹配成功，并且分组能力匹配时正常分流 (line=10)', () => {
      const verdict = RoutingOracle.evaluateVideoMainSite(
        {
          videoType: 6,
          modelId: 15,
          taskType: 28,
          resolution: '480p',
          aspectRatio: '9:16',
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

    it('组织路由组分组内无该分辨率时前置拦截回退直连', () => {
      const verdict = RoutingOracle.evaluateVideoMainSite(
        {
          videoType: 6,
          modelId: 15,
          taskType: 28,
          resolution: '1080p', // groupRouteRules 中 panqu_test 仅配置 480p/720p
          aspectRatio: '9:16',
          userGroupIds: [10],
        },
        baseConfig,
      );
      expect(verdict.willDivert).toBe(false);
      expect(verdict.decision).toBe('FALLBACK_DIRECT');
      expect(verdict.reason).toContain('当前路由分组 panqu_test 无承接分辨率 1080p');
    });
  });

  describe('图片分流决策推导', () => {
    it('图片服务线路非 r 时静默走原渠道', () => {
      const verdict = RoutingOracle.evaluateImageMainSite(
        { selmodelsId: 12, serviceline: 't', userGroupIds: [10] },
        baseConfig,
      );
      expect(verdict.willDivert).toBe(false);
      expect(verdict.reason).toContain('非 r');
    });

    it('图片自定义像素 (pixels) 时静默走原渠道', () => {
      const verdict = RoutingOracle.evaluateImageMainSite(
        { selmodelsId: 12, serviceline: 'r', sizeType: 'pixels', userGroupIds: [10] },
        baseConfig,
      );
      expect(verdict.willDivert).toBe(false);
      expect(verdict.reason).toContain('自定义像素尺寸');
    });

    it('参考图数量超过 10 张时静默走原渠道', () => {
      const verdict = RoutingOracle.evaluateImageMainSite(
        { selmodelsId: 12, serviceline: 'r', imageList: Array(11).fill('http://img.png'), userGroupIds: [10] },
        baseConfig,
      );
      expect(verdict.willDivert).toBe(false);
      expect(verdict.reason).toContain('超过上限 10 张');
    });

    it('满足图片分流条件时正确命中 NewAPI 图片分流', () => {
      const verdict = RoutingOracle.evaluateImageMainSite(
        { selmodelsId: 12, serviceline: 'r', imageList: ['http://img1.png', 'http://img2.png'], userGroupIds: [10] },
        baseConfig,
      );
      expect(verdict.willDivert).toBe(true);
      expect(verdict.decision).toBe('NEWAPI_IMAGE');
      expect(verdict.line).toBe(10);
      expect(verdict.expectedSnapshot).toEqual({
        orgId: 10,
        routeGroupId: 1,
        newapiGroup: 'panqu_test',
        newapiModel: 'pan-banana-pro',
      });
    });
  });

  describe('网关层渠道筛选与加权集合', () => {
    const channels: GatewayChannelConfig[] = [
      { id: 36, name: '万相—yhuo', group: 'panqu_test', models: ['wan3.0-video'], status: 1, weight: 8, dailyQuotaLimit: 1000, usedQuota: 200 },
      { id: 37, name: '万相-备用', group: 'panqu_test', models: ['wan3.0-video'], status: 1, weight: 2, dailyQuotaLimit: 1000, usedQuota: 100 },
      { id: 38, name: '停用渠道', group: 'panqu_test', models: ['wan3.0-video'], status: 0, weight: 10, dailyQuotaLimit: 1000, usedQuota: 0 },
      { id: 39, name: '异组渠道', group: 'other_group', models: ['wan3.0-video'], status: 1, weight: 10, dailyQuotaLimit: 1000, usedQuota: 0 },
      { id: 40, name: '超额渠道', group: 'panqu_test', models: ['wan3.0-video'], status: 1, weight: 10, dailyQuotaLimit: 1000, usedQuota: 995 },
    ];

    it('正确过滤渠道并推导候选集合与理论概率', () => {
      const result = RoutingOracle.evaluateGatewayRouting('panqu_test', 'wan3.0-video', 10, channels);
      expect(result.isBlockedByQuota).toBe(false);
      expect(result.candidateChannelIds).toEqual([36, 37]);
      expect(result.allowedChannels).toEqual(['万相—yhuo', '万相-备用']);
      expect(result.probabilities[36]).toBeCloseTo(0.8);
      expect(result.probabilities[37]).toBeCloseTo(0.2);
      expect(result.rejectedReasons[38]).toContain('未启用');
      expect(result.rejectedReasons[39]).toContain('不匹配');
      expect(result.rejectedReasons[40]).toContain('超出每日限额');
    });

    it('批量加权样本统计在容差内通过', () => {
      const testChannels: GatewayChannelConfig[] = [
        { id: 1, name: 'A', group: 'g', models: ['m'], status: 1, weight: 6, dailyQuotaLimit: 10000, usedQuota: 0 },
        { id: 2, name: 'B', group: 'g', models: ['m'], status: 1, weight: 4, dailyQuotaLimit: 10000, usedQuota: 0 },
      ];
      // 模拟 100 次抽样，A 命中 62 次，B 命中 38 次
      const samples = [...Array(62).fill(1), ...Array(38).fill(2)];
      const result = RoutingOracle.evaluateBatchDistribution(samples, testChannels, 0.1);
      expect(result.passed).toBe(true);
      expect(result.sufficientSamples).toBe(true);
      expect(result.maxDeviation).toBeCloseTo(0.02);
    });

    it('批量加权样本不足 20 时不作确定性失败判决', () => {
      const testChannels: GatewayChannelConfig[] = [
        { id: 1, name: 'A', group: 'g', models: ['m'], status: 1, weight: 5, dailyQuotaLimit: 10000, usedQuota: 0 },
        { id: 2, name: 'B', group: 'g', models: ['m'], status: 1, weight: 5, dailyQuotaLimit: 10000, usedQuota: 0 },
      ];
      const samples = [1, 1, 1, 2, 2];
      const result = RoutingOracle.evaluateBatchDistribution(samples, testChannels, 0.1);
      expect(result.passed).toBe(true);
      expect(result.sufficientSamples).toBe(false);
      expect(result.reason).toContain('样本数量 (5 < 20) 不足');
    });
  });

  describe('故障重试与降级决策推导', () => {
    it('Seedance 模型 (15, 78) 故障应派发火山兜底队列', () => {
      const fallback15 = RoutingOracle.evaluateFallback(15);
      expect(fallback15.fallbackAction).toBe('VOLCENGINE_RETRY_QUEUE');
      expect(fallback15.targetLine).toBe(1);
      expect(fallback15.targetQueue).toBe('ai_volcengine_video_submit_queue');
      expect(fallback15.recordRetryLog).toBe(true);

      const fallback78 = RoutingOracle.evaluateFallback(78);
      expect(fallback78.fallbackAction).toBe('VOLCENGINE_RETRY_QUEUE');
    });

    it('Wan 3.0 等非 Seedance 模型故障直接失败，不进入兜底队列', () => {
      const fallback84 = RoutingOracle.evaluateFallback(84);
      expect(fallback84.fallbackAction).toBe('DIRECT_FAIL_NO_RETRY');
      expect(fallback84.recordRetryLog).toBe(false);
    });
  });
});
