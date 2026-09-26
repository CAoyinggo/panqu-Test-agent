/**
 * probe-enforcement 单元测试（R4）：opt-in 强制门禁纯函数 · 100% 离线 · 零网络
 */
import { describe, it, expect } from 'vitest';
import { evaluateProbeEnforcement } from '../../../src/devtest/probe-enforcement.js';

const healthy = {
  status: 'HEALTHY' as const,
  auth: { status: 'VALID' as const },
  candidateChannelCount: 2,
  endpoints: [
    { name: '主站', reachable: true },
    { name: '网关', reachable: true },
  ],
};

describe('evaluateProbeEnforcement (默认关闭 → 零行为改变)', () => {
  it('enforce=false → enforced=false 且永不阻断（即便事实很糟）', () => {
    const v = evaluateProbeEnforcement(
      { status: 'BLOCKED', auth: { status: 'MISSING' }, candidateChannelCount: 0, endpoints: [] },
      false,
    );
    expect(v.enforced).toBe(false);
    expect(v.blocked).toBe(false);
    expect(v.violations).toHaveLength(0);
  });
});

describe('evaluateProbeEnforcement (启用 → fail-closed)', () => {
  it('全部健康 → enforced=true, blocked=false', () => {
    const v = evaluateProbeEnforcement(healthy, true);
    expect(v.enforced).toBe(true);
    expect(v.blocked).toBe(false);
    expect(v.violations).toHaveLength(0);
  });
  it('鉴权 MISSING（端点全通也阻断，堵住 ok=true 蒙混）', () => {
    const v = evaluateProbeEnforcement({ ...healthy, auth: { status: 'MISSING' } }, true);
    expect(v.blocked).toBe(true);
    expect(v.violations.join('\n')).toMatch(/鉴权/);
  });
  it('鉴权 EXPIRED → 阻断', () => {
    expect(evaluateProbeEnforcement({ ...healthy, auth: { status: 'EXPIRED' } }, true).blocked).toBe(true);
  });
  it('candidateChannelCount=0 → 阻断（无候选分流渠道）', () => {
    const v = evaluateProbeEnforcement({ ...healthy, candidateChannelCount: 0 }, true);
    expect(v.blocked).toBe(true);
    expect(v.violations.join('\n')).toMatch(/渠道/);
  });
  it('端点不可达 → 阻断且点名该端点', () => {
    const v = evaluateProbeEnforcement({ ...healthy, endpoints: [{ name: '网关', reachable: false }] }, true);
    expect(v.blocked).toBe(true);
    expect(v.violations.join('\n')).toMatch(/网关/);
  });
  it('status=BLOCKED 但其余项合规 → 兜底阻断', () => {
    const v = evaluateProbeEnforcement({ ...healthy, status: 'BLOCKED' }, true);
    expect(v.blocked).toBe(true);
    expect(v.violations.join('\n')).toMatch(/BLOCKED/);
  });
  it('facts=undefined → fail-closed 阻断（默认按最不利处理）', () => {
    const v = evaluateProbeEnforcement(undefined, true);
    expect(v.enforced).toBe(true);
    expect(v.blocked).toBe(true);
  });
});
