/**
 * Diversion Pricing Authority 单元测试
 * 以飞书《分流渠道表》本地快照为权威，验证：刊例价跨渠道不变量、
 * 成本价（含折扣公式解析）、调度接入状态、可分流资格与能力门槛、成本升序排序。
 * 100% 离线：读取已提交的 feishu-live-pricing-cache.json，零网络。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadDiversionPricing,
  __resetPricingCache,
  normalizeResolution,
  normalizeModel,
  resolveListPrice,
  resolveChannelCost,
  channelStatus,
  isDiversionEligible,
  eligibleResolutions,
  rankChannelsByCost,
} from '../../../src/devtest/diversion-pricing-authority.js';

describe('diversion-pricing-authority (飞书分流渠道表权威)', () => {
  beforeEach(() => __resetPricingCache());

  it('加载快照并具备核心结构', () => {
    const c = loadDiversionPricing();
    expect(c.domesticVideo.length).toBeGreaterThan(50);
    expect(c.lineMapping.length).toBeGreaterThan(10);
  });

  it('normalizeResolution / normalizeModel 归一化', () => {
    expect(normalizeResolution('720p/无参考视频')).toBe('720p');
    expect(normalizeResolution('480P')).toBe('480p');
    expect(normalizeResolution('4K')).toBe('4kp'.replace('kp', 'k')); // '4k'
    expect(normalizeResolution('4K')).toBe('4k');
    expect(normalizeModel('Seedance 2.0')).toBe('seedance2.0');
    expect(normalizeModel('Seedance2.5')).toBe('seedance2.5');
  });

  it('铁律1：刊例价跨渠道唯一（Seedance2.0@720p = 30 积分/秒）', () => {
    const c = loadDiversionPricing();
    expect(resolveListPrice(c, { model: 'Seedance2.0', resolution: '720p' })).toBe(30);
    expect(resolveListPrice(c, { model: 'Seedance2.5', resolution: '1080p' })).toBe(115);
    expect(resolveListPrice(c, { model: 'Seedance2.0', resolution: '480p' })).toBe(15);
  });

  it('成本价：火山原厂基准 + RunningHub 折扣公式(J8*0.8)正确解析', () => {
    const c = loadDiversionPricing();
    expect(resolveChannelCost(c, { model: 'Seedance2.5', resolution: '480p', channel: '火山' })).toBeCloseTo(0.672, 4);
    // RunningHub Seedance2.5 480p = 火山0.672 × 0.8 = 0.5376
    expect(resolveChannelCost(c, { model: 'Seedance2.5', resolution: '480p', channel: 'RunningHub' })).toBeCloseTo(
      0.5376,
      4,
    );
  });

  it('调度接入状态四态：星辰=下线，火山=已接入，TD-CN=待分流', () => {
    const c = loadDiversionPricing();
    expect(channelStatus(c, '星辰')).toBe('offline');
    expect(channelStatus(c, '火山')).toBe('active');
    expect(channelStatus(c, 'TD-CN')).toBe('pending');
  });

  it('铁律3：可分流资格 + 能力门槛（全能参考）', () => {
    const c = loadDiversionPricing();
    // 星辰已下线 → 不可分流
    expect(isDiversionEligible(c, { model: 'Seedance2.0', resolution: '720p', channel: '星辰' }).eligible).toBe(false);
    // RunningHub「只支持无参考」→ 要求全能参考时不合格
    const rh = isDiversionEligible(c, {
      model: 'Seedance2.5',
      resolution: '480p',
      channel: 'RunningHub',
      require: { universalRef: true },
    });
    expect(rh.eligible).toBe(false);
    expect(rh.reason).toContain('全能参考');
    // 火山原厂支持全能参考 → 合格
    expect(
      isDiversionEligible(c, {
        model: 'Seedance2.5',
        resolution: '480p',
        channel: '火山',
        require: { universalRef: true },
      }).eligible,
    ).toBe(true);
  });

  it('可分流分辨率集合（火山 Seedance2.0 覆盖 480p/720p/1080p/4k）', () => {
    const c = loadDiversionPricing();
    const res = eligibleResolutions(c, { model: 'Seedance2.0', channel: '火山' });
    for (const r of ['480p', '720p', '1080p', '4k']) expect(res).toContain(r);
  });

  it('成本升序排序：onlyActive 剔除已下线星辰；含全部时星辰最优', () => {
    const c = loadDiversionPricing();
    const active = rankChannelsByCost(c, { model: 'Seedance2.0', resolution: '720p', onlyActive: true });
    expect(active.length).toBeGreaterThan(0);
    // 已下线的星辰不得出现在「当前可承接」排序中
    expect(active.some((x) => x.channel.includes('星辰'))).toBe(false);
    // 最优 active = 腾讯云 (¥0.636)
    expect(active[0].cost).toBeCloseTo(0.636, 3);

    const all = rankChannelsByCost(c, { model: 'Seedance2.0', resolution: '720p', onlyActive: false });
    // 含全部渠道时，成本最低者是星辰 (¥0.58)
    expect(all[0].channel).toContain('星辰');
    expect(all[0].cost).toBeCloseTo(0.58, 3);
  });
});
