import { describe, expect, it } from 'vitest';
import { ConfigDriftAuditor } from '../../../src/devtest/config-drift-auditor.js';

describe('ConfigDriftAuditor - 多环境配置与刊例价差异动审计器', () => {
  it('同环境比对且业务模型已配刊例价时，判定为 CONSISTENT', async () => {
    const report = await ConfigDriftAuditor.audit({
      env: 'test',
      compareEnv: 'test',
      checkUnpricedModels: true,
      mock: true,
    });

    expect(report.ok).toBe(true);
    expect(report.status).toBe('CONSISTENT');
    expect(report.driftCount).toBe(0);
  });

  it('对比 test 与 online 环境时，能准确捕获 Wan 3.0 等分流开关的状态漂移', async () => {
    const report = await ConfigDriftAuditor.audit({
      env: 'test',
      compareEnv: 'online',
      checkUnpricedModels: true,
      mock: true,
    });

    expect(report.ok).toBe(true);
    expect(report.status).toBe('DRIFT_DETECTED');
    expect(report.driftCount).toBeGreaterThanOrEqual(1);

    const wanDrift = report.issues.find((i) => i.modelId === 84 && i.category === 'DIVERSION_FLAG_MISMATCH');
    expect(wanDrift).toBeDefined();
    expect(wanDrift?.severity).toBe('MEDIUM');
    expect(wanDrift?.suggestedAction).toContain('is_newapi_global');
  });
});
