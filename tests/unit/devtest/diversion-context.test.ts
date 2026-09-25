/**
 * diversion-context 单元测试：统一分流预测（grounded vs provisional，媒体感知标记）。100% 离线纯函数。
 */
import { describe, it, expect } from 'vitest';
import {
  predictDiversion,
  diversionMarkerKey,
  diversionMarkerExpectedValue,
} from '../../../src/devtest/diversion-context.js';
import type { RouteRules, GroupedRouteRules } from '../../../src/devtest/newapi-route-eligibility.js';

const routeRules: RouteRules = {
  video: { '78': { resolutions: ['720p'], aspect_ratios: ['16:9'] } },
  image: { '12': { channels: [{ resolutions: ['1k', '2k'], aspect_ratios: ['1:1'] }] } },
};
const groupRules: GroupedRouteRules = {
  video: { default: { '78': { resolutions: ['720p'], aspect_ratios: ['16:9'] } } },
  image: { default: { '12': { channels: [{ resolutions: ['1k'], aspect_ratios: ['1:1'] }] } } },
};

describe('diversion-context · 媒体感知标记', () => {
  it('视频=diversion/10，图片=newapi_image/1', () => {
    expect(diversionMarkerKey('video')).toBe('diversion');
    expect(diversionMarkerKey('image')).toBe('newapi_image');
    expect(diversionMarkerExpectedValue('video')).toBe(10);
    expect(diversionMarkerExpectedValue('image')).toBe(1);
  });
});

// APPEND_DIVERSION_CONTEXT_TESTS

describe('predictDiversion · grounded（有真实路由规则）', () => {
  it('视频命中规则→willDivert true / GROUNDED', () => {
    const p = predictDiversion({
      mediaType: 'video',
      modelId: 78,
      alias: 'seedance-2.5',
      isGlobalModel: false,
      resolution: '720p',
      aspect: '16:9',
      routeMode: 'newapi',
      routeRules,
      groupRules,
      routeGroup: { newapi_group: 'default', usable: true },
    });
    expect(p.willDivert).toBe(true);
    expect(p.line).toBe(10);
    expect(p.provenance).toBe('GROUNDED_ROUTE_RULES');
    expect(p.marker).toBe('diversion');
  });

  it('视频分辨率不在规则内→willDivert false / GROUNDED（按真实规则回退，不再乐观假设）', () => {
    const p = predictDiversion({
      mediaType: 'video',
      modelId: 78,
      alias: 'seedance-2.5',
      isGlobalModel: false,
      resolution: '4k',
      aspect: '16:9',
      routeMode: 'newapi',
      routeRules,
      groupRules,
      routeGroup: { newapi_group: 'default', usable: true },
    });
    expect(p.willDivert).toBe(false);
    expect(p.provenance).toBe('GROUNDED_ROUTE_RULES');
    expect(p.decision).toContain('FALLBACK');
  });

  it('图片命中分组规则→diverted / GROUNDED / marker=newapi_image', () => {
    const p = predictDiversion({
      mediaType: 'image',
      modelId: 12,
      alias: 'pan-banana-pro',
      isGlobalModel: false,
      resolution: '1k',
      aspect: '1:1',
      serviceline: 'r',
      routeMode: 'newapi',
      routeRules,
      groupRules,
      routeGroup: { newapi_group: 'default', usable: true },
    });
    expect(p.willDivert).toBe(true);
    expect(p.marker).toBe('newapi_image');
    expect(p.markerExpectedValue).toBe(1);
    expect(p.provenance).toBe('GROUNDED_ROUTE_RULES');
  });
});

describe('predictDiversion · provisional（无规则/非 newapi）', () => {
  it('无路由规则→PROVISIONAL_ASSUMPTION，不作硬判', () => {
    const p = predictDiversion({
      mediaType: 'video',
      modelId: 78,
      alias: 'seedance-2.5',
      isGlobalModel: false,
      resolution: '720p',
      aspect: '16:9',
    });
    expect(p.provenance).toBe('PROVISIONAL_ASSUMPTION');
  });
  it('routeMode=off→provisional 且不分流', () => {
    const p = predictDiversion({
      mediaType: 'video',
      modelId: 78,
      alias: 'seedance-2.5',
      isGlobalModel: false,
      resolution: '720p',
      routeMode: 'off',
      routeRules,
    });
    expect(p.provenance).toBe('PROVISIONAL_ASSUMPTION');
    expect(p.willDivert).toBe(false);
  });
});
