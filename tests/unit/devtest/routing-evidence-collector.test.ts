import { describe, expect, it } from 'vitest';
import { RoutingEvidenceCollector } from '../../../src/devtest/routing-evidence-collector.js';
import type { MainSiteRoutingVerdict, GatewayRoutingVerdict } from '../../../src/devtest/routing-oracle.js';

describe('RoutingEvidenceCollector - 跨系统路由证据对齐与核查器', () => {
  const expectedMainPass: MainSiteRoutingVerdict = {
    willDivert: true,
    decision: 'NEWAPI_GLOBAL',
    line: 10,
    reason: '全量模型',
    expectedSnapshot: {
      orgId: 0,
      routeGroupId: 0,
      newapiGroup: '',
      newapiModel: 'wan3.0-video',
    },
  };

  const expectedGateway: GatewayRoutingVerdict = {
    isBlockedByQuota: false,
    candidateChannelIds: [36],
    allowedChannels: ['万相—yhuo'],
    probabilities: { 36: 1 },
    rejectedReasons: {},
  };

  it('缺少底层 extra 路由快照直接证据时，严格标记 UNVERIFIED 并阻断通过 (BLOCKED)', () => {
    const result = RoutingEvidenceCollector.correlateAndVerify({
      taskId: 12345,
      mediaType: 'video',
      expectedMainSite: expectedMainPass,
      mainSiteRow: undefined,
    });

    expect(result.hasDirectProof).toBe(false);
    expect(result.evidenceState).toBe('UNVERIFIED');
    expect(result.verificationStatus).toBe('BLOCKED');
    expect(result.reasons[0]).toContain('缺少主站底层 extra 路由快照直接证据');
  });

  it('任务 ID 冲突时拒绝强行归属证据', () => {
    const result = RoutingEvidenceCollector.correlateAndVerify({
      taskId: 12345,
      mediaType: 'video',
      expectedMainSite: expectedMainPass,
      mainSiteRow: {
        id: 99999, // 冲突 ID
        line: 10,
        extra: JSON.stringify({ diversion: 10 }),
      },
    });

    expect(result.evidenceState).toBe('UNVERIFIED');
    expect(result.verificationStatus).toBe('BLOCKED');
  });

  it('网关日志与主任务 ID 未对齐时拒绝猜测归属', () => {
    const result = RoutingEvidenceCollector.correlateAndVerify({
      taskId: 12345,
      mediaType: 'video',
      expectedMainSite: expectedMainPass,
      mainSiteRow: {
        id: 12345,
        line: 10,
        extra: JSON.stringify({
          diversion: 10,
          newapi_log_id: 101,
          newapi_org_id: 0,
          newapi_group: '',
          newapi_model: 'wan3.0-video',
          channel_name: '万相—yhuo',
          channel_id: 36,
        }),
      },
      gatewayLog: {
        id: 999, // logId 999 与主站 newapi_log_id 101 不匹配
        ai_task_id: 88888, // 且与主任务 ID 12345 不匹配
        newapi_task_id: 'task_abc',
      },
    });

    expect(result.reasons.some((r) => r.includes('未建立显式 ID 绑定'))).toBe(true);
    expect(result.verificationStatus).toBe('FAIL');
  });

  it('预期分流但主站实际走直连 (diversion=0) 时，精准识别 MISMATCH 与 FAIL', () => {
    const result = RoutingEvidenceCollector.correlateAndVerify({
      taskId: 12345,
      mediaType: 'video',
      expectedMainSite: expectedMainPass,
      mainSiteRow: {
        id: 12345,
        line: 0,
        extra: JSON.stringify({ diversion: 0 }),
      },
    });

    expect(result.evidenceState).toBe('MISMATCH');
    expect(result.verificationStatus).toBe('FAIL');
    expect(result.reasons[0]).toContain('主站路由不匹配');
  });

  it('实际网关渠道不在合法候选集合内时，精准判定非法渠道并 FAIL', () => {
    const result = RoutingEvidenceCollector.correlateAndVerify({
      taskId: 12345,
      mediaType: 'video',
      expectedMainSite: expectedMainPass,
      expectedGateway,
      mainSiteRow: {
        id: 12345,
        line: 10,
        extra: JSON.stringify({
          diversion: 10,
          newapi_org_id: 0,
          newapi_group: '',
          newapi_model: 'wan3.0-video',
          channel_name: '未授权渠道-X',
          channel_id: 99,
        }),
      },
      gatewayLog: {
        ai_task_id: 12345,
        newapi_task_id: 'task_123',
        channel_id: 99,
        channel_name: '未授权渠道-X',
      },
    });

    expect(result.verificationStatus).toBe('FAIL');
    expect(result.reasons.some((r) => r.includes('网关调度渠道非法'))).toBe(true);
  });

  it('主站快照、网关日志与预期完全匹配时判定 VERIFIED 与 PASS，并建立完整跨系统 ID 映射', () => {
    const result = RoutingEvidenceCollector.correlateAndVerify({
      taskId: 12345,
      mediaType: 'video',
      expectedMainSite: expectedMainPass,
      expectedGateway,
      mainSiteRow: {
        id: 12345,
        line: 10,
        extra: JSON.stringify({
          diversion: 10,
          newapi_log_id: 202,
          newapi_org_id: 0,
          newapi_group: '',
          newapi_model: 'wan3.0-video',
          channel_name: '万相—yhuo',
          channel_id: 36,
        }),
      },
      gatewayLog: {
        id: 202,
        ai_task_id: 12345,
        newapi_task_id: 'task_wan_001',
        upstream_task_id: 'ali_task_999',
        channel_id: 36,
        channel_name: '万相—yhuo',
      },
    });

    expect(result.hasDirectProof).toBe(true);
    expect(result.evidenceState).toBe('VERIFIED');
    expect(result.verificationStatus).toBe('PASS');
    expect(result.idMap).toEqual({
      mainTaskId: 12345,
      newapiLogId: 202,
      newapiTaskId: 'task_wan_001',
      upstreamTaskId: 'ali_task_999',
      fallbackTaskId: undefined,
    });
  });
});
