/**
 * NewAPI 分流「运行时资格」判定单元测试（model × resolution × aspect × enabled）
 * 忠实镜像 NewapiDiversionRuleService / NewapiImageDiversionService / check_diversion。
 * fixture 对齐截图：PanGemini 图片渠道(pan-banana-pro/2 + gemini-3-pro-image, 1K/2K/4K + 1:1…4:5)。
 * 100% 离线纯函数。
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeAspectRatio,
  isVideoModelRoutable,
  isVideoModelRoutableForGroup,
  matchesImageCapability,
  isImageModelRoutable,
  isVideoRequestEligible,
  evaluateVideoDiversion,
  evaluateImageDiversion,
  type RouteRules,
  type GroupedRouteRules,
} from '../../../src/devtest/newapi-route-eligibility.js';

// 视频模型 78=Seedance2.5；图片模型 1201/1202/1203 对齐截图三模型
const IMG_ASPECTS = ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '5:4', '4:5'];
const routeRules: RouteRules = {
  video: {
    '78': { resolutions: ['480p', '720p', '1080p'], aspect_ratios: ['16:9', '9:16', '1:1', 'adaptive'] },
  },
  image: {
    '1201': { channels: [{ resolutions: ['1K', '2K', '4K'], aspect_ratios: IMG_ASPECTS }] },
    // 1202: 分辨率与画面比例分属不同渠道（用于验证「须同一渠道」）
    '1202': {
      channels: [
        { resolutions: ['1K', '2K', '4K'], aspect_ratios: ['16:9'] },
        { resolutions: ['1K'], aspect_ratios: ['4:5'] },
      ],
    },
  },
};
const groupRules: GroupedRouteRules = {
  video: { default: { '78': { resolutions: ['720p'], aspect_ratios: ['16:9'] } } },
  image: { vip: { '1201': { channels: [{ resolutions: ['2K'], aspect_ratios: ['1:1'] }] } } },
};

describe('newapi-route-eligibility · 基础谓词', () => {
  it('normalizeAspectRatio: adaptive/auto→auto，其余小写去空格', () => {
    expect(normalizeAspectRatio('adaptive')).toBe('auto');
    expect(normalizeAspectRatio(' AUTO ')).toBe('auto');
    expect(normalizeAspectRatio('16:9')).toBe('16:9');
  });

  it('isVideoModelRoutable: 分辨率+画面比例都命中才 true', () => {
    expect(isVideoModelRoutable(routeRules, { modelId: 78, resolution: '720p', aspect: '16:9' })).toBe(true);
    expect(isVideoModelRoutable(routeRules, { modelId: 78, resolution: '720P', aspect: 'adaptive' })).toBe(true); // 大小写/auto 归一
    expect(isVideoModelRoutable(routeRules, { modelId: 78, resolution: '4k', aspect: '16:9' })).toBe(false); // 分辨率不在
    expect(isVideoModelRoutable(routeRules, { modelId: 78, resolution: '720p', aspect: '21:9' })).toBe(false); // 画面比例不在
    expect(isVideoModelRoutable(routeRules, { modelId: 999, resolution: '720p', aspect: '16:9' })).toBe(false); // 模型不在
    expect(isVideoModelRoutable(null, { modelId: 78, resolution: '720p', aspect: '16:9' })).toBe(false); // 规则缺失
  });

  it('isVideoModelRoutableForGroup: group 空/规则空→放行；否则精确匹配', () => {
    expect(
      isVideoModelRoutableForGroup(groupRules, { modelId: 78, resolution: '720p', aspect: '16:9', group: '' }),
    ).toBe(true);
    expect(isVideoModelRoutableForGroup(null, { modelId: 78, resolution: '720p', aspect: '16:9', group: 'x' })).toBe(
      true,
    );
    expect(
      isVideoModelRoutableForGroup(groupRules, { modelId: 78, resolution: '720p', aspect: '16:9', group: 'default' }),
    ).toBe(true);
    expect(
      isVideoModelRoutableForGroup(groupRules, { modelId: 78, resolution: '1080p', aspect: '16:9', group: 'default' }),
    ).toBe(false);
  });

  it('matchesImageCapability: 同一渠道须同时支持分辨率与画面比例', () => {
    expect(matchesImageCapability(routeRules.image!['1201'], { resolution: '2k', aspect: '9:16' })).toBe(true);
    // 1202: 4:5 只在「仅 1K」的渠道 → 2K+4:5 跨渠道，不通过
    expect(matchesImageCapability(routeRules.image!['1202'], { resolution: '2k', aspect: '4:5' })).toBe(false);
    expect(matchesImageCapability(routeRules.image!['1202'], { resolution: '1k', aspect: '4:5' })).toBe(true);
    expect(matchesImageCapability(routeRules.image!['1202'], { resolution: '2k', aspect: '16:9' })).toBe(true);
  });

  it('isImageModelRoutable: 默认 2k/1:1', () => {
    expect(isImageModelRoutable(routeRules, { modelId: 1201 })).toBe(true); // 默认 2k+1:1 命中
    expect(isImageModelRoutable(routeRules, { modelId: 1201, resolution: '4k', aspect: '4:5' })).toBe(true);
    expect(isImageModelRoutable(routeRules, { modelId: 999 })).toBe(false);
  });
});

// APPEND_TESTS

describe('newapi-route-eligibility · 视频硬性资格', () => {
  it('wan3 绕过 type6/task_type 限制；非 wan3 须 type=6 且模型/任务型合法', () => {
    expect(isVideoRequestEligible({ isWan3: true, videoType: 99, selmodelsId: 84 })).toBe(true);
    expect(isVideoRequestEligible({ isWan3: false, videoType: 3, selmodelsId: 78 })).toBe(false); // 非6
    expect(isVideoRequestEligible({ isWan3: false, videoType: 6, selmodelsId: 16 })).toBe(false); // 排除模型
    expect(isVideoRequestEligible({ isWan3: false, videoType: 6, selmodelsId: 78, taskType: 999 })).toBe(false); // 任务型不允
    expect(isVideoRequestEligible({ isWan3: false, videoType: 6, selmodelsId: 78, taskType: 28 })).toBe(true);
  });

  it('真人人像 / cueword>5000 / output=mov 一票否决', () => {
    expect(isVideoRequestEligible({ isWan3: true, videoType: 6, selmodelsId: 84, hasRealHumanPortrait: true })).toBe(
      false,
    );
    expect(isVideoRequestEligible({ isWan3: true, videoType: 6, selmodelsId: 84, cuewordLength: 5001 })).toBe(false);
    expect(isVideoRequestEligible({ isWan3: true, videoType: 6, selmodelsId: 84, outputFormat: 'MOV' })).toBe(false);
  });
});

describe('newapi-route-eligibility · 视频分流决策(check_diversion 镜像)', () => {
  const base = {
    modelId: 78,
    alias: 'seedance-2.5',
    hasGlobalApiKey: true,
    resolution: '720p',
    aspect: '16:9',
    routeRules,
    groupRules,
  };

  it('off/legacy/ineligible', () => {
    expect(evaluateVideoDiversion({ ...base, routeMode: 'off', eligible: true, isGlobalModel: false }).decision).toBe(
      'OFF',
    );
    expect(
      evaluateVideoDiversion({ ...base, routeMode: 'legacy', eligible: true, isGlobalModel: false, legacyResult: 5 })
        .line,
    ).toBe(5);
    expect(
      evaluateVideoDiversion({ ...base, routeMode: 'newapi', eligible: false, isGlobalModel: false }).decision,
    ).toBe('INELIGIBLE');
  });

  it('全量模型跳过分辨率/画面比例校验（即便画面比例非法也命中）', () => {
    const r = evaluateVideoDiversion({
      ...base,
      routeMode: 'newapi',
      eligible: true,
      isGlobalModel: true,
      aspect: '21:9',
    });
    expect(r.line).toBe(10);
    expect(r.decision).toBe('NEWAPI_GLOBAL');
  });

  it('全量模型缺全局Key → CONFIG_ERROR(hardError)', () => {
    const r = evaluateVideoDiversion({
      ...base,
      routeMode: 'newapi',
      eligible: true,
      isGlobalModel: true,
      hasGlobalApiKey: false,
    });
    expect(r.decision).toBe('CONFIG_ERROR');
    expect(r.hardError).toBe(true);
  });

  it('分组模型：能力并集不含→回退；命中路由组→NEWAPI_ORG_GROUP', () => {
    expect(
      evaluateVideoDiversion({
        ...base,
        routeMode: 'newapi',
        eligible: true,
        isGlobalModel: false,
        aspect: '21:9',
        routeGroup: { newapi_group: 'default', usable: true },
      }).decision,
    ).toBe('FALLBACK_NOT_ROUTABLE');
    expect(
      evaluateVideoDiversion({ ...base, routeMode: 'newapi', eligible: true, isGlobalModel: false, routeGroup: null })
        .decision,
    ).toBe('FALLBACK_NO_ROUTE_GROUP');
    const ok = evaluateVideoDiversion({
      ...base,
      routeMode: 'newapi',
      eligible: true,
      isGlobalModel: false,
      routeGroup: { newapi_group: 'default', usable: true },
    });
    expect(ok.line).toBe(10);
    expect(ok.decision).toBe('NEWAPI_ORG_GROUP');
  });
});

describe('newapi-route-eligibility · 图片分流决策', () => {
  const base = {
    selmodelsId: 1201,
    alias: 'gemini-3-pro-image',
    hasGlobalApiKey: true,
    serviceline: 'r',
    resolution: '2k',
    aspect: '1:1',
    routeRules,
    groupRules,
  };

  it('图片全量模型仍校验分辨率/画面比例（与视频不同）', () => {
    expect(evaluateImageDiversion({ ...base, isGlobalModel: true, aspect: '21:9' }).decision).toBe(
      'FALLBACK_NOT_ROUTABLE',
    );
    expect(evaluateImageDiversion({ ...base, isGlobalModel: true }).decision).toBe('NEWAPI_IMAGE_GLOBAL');
  });

  it('serviceline≠r / size_type=pixels 静默回退', () => {
    expect(evaluateImageDiversion({ ...base, isGlobalModel: true, serviceline: 't' }).decision).toBe(
      'FALLBACK_SERVICELINE',
    );
    expect(evaluateImageDiversion({ ...base, isGlobalModel: true, sizeType: 'pixels' }).decision).toBe(
      'FALLBACK_PIXELS',
    );
  });

  it('Image2.5 无渠道→抛错(hardError)；MJ v8.2 无条件分流', () => {
    expect(
      evaluateImageDiversion({ ...base, modelClass: 'image25', isGlobalModel: true, aspect: '21:9' }),
    ).toMatchObject({ decision: 'IMAGE25_NO_CHANNEL', hardError: true });
    expect(
      evaluateImageDiversion({ ...base, modelClass: 'mj_v82', isGlobalModel: false, aspect: '21:9' }).decision,
    ).toBe('NEWAPI_MJ_V82');
  });

  it('分组图片命中', () => {
    const r = evaluateImageDiversion({
      ...base,
      isGlobalModel: false,
      resolution: '2k',
      aspect: '1:1',
      routeGroup: { newapi_group: 'vip', usable: true },
    });
    expect(r.diverted).toBe(true);
    expect(r.decision).toBe('NEWAPI_IMAGE_ORG_GROUP');
  });
});
