/**
 * Legacy（概率）分流资格单元测试 — 只覆盖可确定性部分（忠实镜像 LegacyDiversionService）。
 * 随机 bucket / 积分上限 / Redis 限速锁属运行时，不在此断言（见模块头 runtimeGated 说明）。100% 离线。
 */
import { describe, it, expect } from 'vitest';
import {
  passesLegacyCommonRules,
  matchLegacyLineByRatio,
  isLegacyRoleAllowed,
  isLegacyTimeAllowed,
  evaluateLegacyDiversion,
} from '../../../src/devtest/legacy-diversion-eligibility.js';

describe('passesLegacyCommonRules', () => {
  it('线路2 支持首尾帧(29)，其余线路只支持全能参考(28)', () => {
    expect(passesLegacyCommonRules({ taskType: 29, selmodelsId: 15 }, 2)).toBe(true);
    expect(passesLegacyCommonRules({ taskType: 29, selmodelsId: 15 }, 5)).toBe(false);
    expect(passesLegacyCommonRules({ taskType: 28, selmodelsId: 15 }, 5)).toBe(true);
  });
  it('模型支持：线路7 只 [15,78]（排除16）；线路5 含 78', () => {
    expect(passesLegacyCommonRules({ selmodelsId: 16 }, 7)).toBe(false);
    expect(passesLegacyCommonRules({ selmodelsId: 78 }, 7)).toBe(true);
    expect(passesLegacyCommonRules({ selmodelsId: 78 }, 5)).toBe(true);
    expect(passesLegacyCommonRules({ selmodelsId: 78 }, 2)).toBe(false); // 默认 [15,16]
  });
  it('线路6：仅支持模型[15,16]（78 不在内→false）；model15 画幅需白名单；mov 直接否', () => {
    // 注：PHP 里 line6 有 model78 画幅规则，但 line6 支持模型是 [15,16]，78 先被模型门槛挡下 → 那段是死代码
    expect(passesLegacyCommonRules({ selmodelsId: 78, videoAspectRatio: '16:9' }, 6)).toBe(false);
    expect(passesLegacyCommonRules({ selmodelsId: 15, videoAspectRatio: '4:3' }, 6)).toBe(true);
    expect(passesLegacyCommonRules({ selmodelsId: 15, videoAspectRatio: '2:3' }, 6)).toBe(false); // 2:3 不在 model15 白名单
    expect(passesLegacyCommonRules({ selmodelsId: 15, videoAspectRatio: '16:9', outputFormat: 'MOV' }, 6)).toBe(false);
  });
  it('线路5 model78 分辨率白名单收窄为 [720p,480p]', () => {
    expect(passesLegacyCommonRules({ selmodelsId: 78, videoResolution: '720p' }, 5)).toBe(true);
    expect(passesLegacyCommonRules({ selmodelsId: 78, videoResolution: '1080p' }, 5)).toBe(false);
    expect(passesLegacyCommonRules({ selmodelsId: 15, videoResolution: '1080p' }, 5)).toBe(true);
  });
  it('参考视频 / cueword>5000 一票否决', () => {
    expect(passesLegacyCommonRules({ selmodelsId: 15, refVideos: true }, 2)).toBe(false);
    expect(passesLegacyCommonRules({ selmodelsId: 15, cuewordLength: 5001 }, 2)).toBe(false);
  });
});

describe('matchLegacyLineByRatio (累计区间)', () => {
  const lines = [
    { line: 2, ratio: 30 },
    { line: 5, ratio: 20 },
    { line: 6, ratio: 0 },
    { line: 7, ratio: 50 },
  ];
  it('落点命中对应区间；ratio=0 跳过', () => {
    expect(matchLegacyLineByRatio(lines, 10)).toBe(2); // [0,30)
    expect(matchLegacyLineByRatio(lines, 40)).toBe(5); // [30,50)
    expect(matchLegacyLineByRatio(lines, 60)).toBe(7); // [50,100)，跳过 line6
    expect(matchLegacyLineByRatio(lines, 99)).toBe(7);
  });
  it('总占比不足且落点超出 → 0', () => {
    expect(matchLegacyLineByRatio([{ line: 2, ratio: 40 }], 60)).toBe(0);
  });
});

describe('isLegacyRoleAllowed / isLegacyTimeAllowed', () => {
  it('角色：空放行、命中、未命中', () => {
    expect(isLegacyRoleAllowed('', [1])).toBe(true);
    expect(isLegacyRoleAllowed('12,34', [34])).toBe(true);
    expect(isLegacyRoleAllowed('12', [99])).toBe(false);
  });
  it('时间：区间内 true、区间外 false、空 false', () => {
    expect(isLegacyTimeAllowed('09:00-18:00', 600)).toBe(true); // 10:00
    expect(isLegacyTimeAllowed('09:00-18:00', 1200)).toBe(false); // 20:00
    expect(isLegacyTimeAllowed('', 600)).toBe(false);
  });
});

describe('evaluateLegacyDiversion (确定性裁决 + runtimeGated 标注)', () => {
  const base = {
    orderedLines: [{ line: 5, ratio: 100 }],
    bucket: 10,
    groupIds: [1] as number[],
    currentMinutes: 600,
    lineConfig: { 5: { role: '', time_interval: '00:00-23:59' } },
  };
  it('LEGACY_HIT 并标注 runtimeGated（积分上限/限速锁）', () => {
    const r = evaluateLegacyDiversion({ ...base, req: { selmodelsId: 15, videoResolution: '720p' } });
    expect(r.decision).toBe('LEGACY_HIT');
    expect(r.line).toBe(5);
    expect(r.runtimeGated).toEqual(
      expect.arrayContaining([expect.stringContaining('score_limit'), expect.stringContaining('speed_lock')]),
    );
  });
  it('RATIO_MISS / COMMON_RULES_FAIL / TIME_DENIED', () => {
    expect(evaluateLegacyDiversion({ ...base, bucket: 100, req: { selmodelsId: 15 } }).decision).toBe('RATIO_MISS');
    expect(
      evaluateLegacyDiversion({
        ...base,
        req: { selmodelsId: 16, videoResolution: '1080p' },
        orderedLines: [{ line: 7, ratio: 100 }],
      }).decision,
    ).toBe('COMMON_RULES_FAIL');
    expect(
      evaluateLegacyDiversion({
        ...base,
        currentMinutes: 100,
        lineConfig: { 5: { time_interval: '09:00-18:00' } },
        req: { selmodelsId: 15 },
      }).decision,
    ).toBe('TIME_DENIED');
  });
});
