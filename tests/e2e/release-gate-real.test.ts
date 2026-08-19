// Phase 26.5 Release Gate Drill — E2E
// 验证真实发布门禁：
// - PASS（exit=0）：sanity 真实 Run → decision=PASS → 部署执行
// - REVIEW（exit=2）：regression 真实 Run → decision=REVIEW → 创建审批，未批准不部署；批准后部署
// - BLOCK（exit=1）：sanity + 故障注入 P0 FAIL → decision=BLOCK → CI FAILED、Deployment NOT EXECUTED
// - 安全验证：Autonomous Agent 在存在 P0 Failure 时尝试绕过 Gate → 必须被拦截（不能绕过）
// 决策由真实执行统计（computeReleaseDecision 同款规则）计算，BLOCK 由故障注入真实触发。

import { describe, it, expect } from 'vitest';
import { createPlatformService } from '../../src/platform/service/index.js';
import type { PlatformBundle } from '../../src/platform/service/index.js';
import {
  runReleaseGateDrill,
  enforceReleaseGate,
  gateDrillSummary,
} from '../../src/platform/ops/release-gate-drill.js';

const FIXED_ISO = '2026-08-18T00:00:00.000Z';

function makeBundle(): PlatformBundle {
  return createPlatformService({ seedProject: true, now: () => FIXED_ISO });
}

describe('26.5.1 GATE-PASS（sanity 真实 Run → 允许发布）', () => {
  it('decision=PASS、exit=0、Deployment EXECUTED、无需审批', async () => {
    const b = makeBundle();
    const r = await runReleaseGateDrill(b, { environment: 'test', profile: 'sanity' });
    expect(r.decision).toBe('PASS');
    expect(r.exitCode).toBe(0);
    expect(r.deployment.executed).toBe(true);
    expect(r.deployment.reason).toContain('允许发布');
    expect(r.approvalRequired).toBe(false);
    expect(r.bypassBlocked).toBe(false);
    expect(r.audit.result).toBe('success');
    expect(r.pass).toBe(10);
  });
});

describe('26.5.2 GATE-REVIEW（regression 真实 Run → 需审批，未批准不部署）', () => {
  it('decision=REVIEW、exit=2、Approval PENDING、Deployment NOT EXECUTED、Agent 不能绕过', async () => {
    const b = makeBundle();
    const r = await runReleaseGateDrill(b, { environment: 'test', profile: 'regression' });
    expect(r.decision).toBe('REVIEW');
    expect(r.exitCode).toBe(2);
    expect(r.approvalRequired).toBe(true);
    expect(r.approvalId).toBeTruthy();
    expect(r.approvalStatus).toBe('PENDING');
    expect(r.deployment.executed).toBe(false);
    expect(r.deployment.reason).toContain('未批准');
    // 未批准状态下 Agent 绕过 → 拦截
    expect(r.bypassBlocked).toBe(true);
    expect(r.audit.result).toBe('pending');
    expect(r.totalCases).toBe(50);
  });

  it('REVIEW 批准后 → Deployment EXECUTED（人工审批通过才能发布）', async () => {
    const b = makeBundle();
    const r = await runReleaseGateDrill(b, { environment: 'test', profile: 'regression', approveReview: true });
    expect(r.decision).toBe('REVIEW');
    expect(r.approvalStatus).toBe('APPROVED');
    expect(r.deployment.executed).toBe(true);
  });
});

describe('26.5.3 GATE-BLOCK（故障注入 P0 FAIL → 阻断发布）', () => {
  it('decision=BLOCK、exit=1、CI FAILED、Deployment NOT EXECUTED、Agent 不能绕过', async () => {
    const b = makeBundle();
    const r = await runReleaseGateDrill(b, {
      environment: 'test', profile: 'sanity',
      failCases: ['WAN3-CORE-001'], failReason: '故障注入（release gate drill）：P0 核心链路回归',
    });
    expect(r.decision).toBe('BLOCK');
    expect(r.exitCode).toBe(1);
    expect(r.p0Fail).toBe(1);
    expect(r.deployment.executed).toBe(false);
    expect(r.deployment.reason).toContain('NOT EXECUTED');
    // Autonomous Agent 在 P0 Failure 时尝试绕过 → 必须被 Gate 拦截
    expect(r.bypassBlocked).toBe(true);
    // 审计 denied：real-run 的 release denied + Agent 绕过 denied
    expect(r.audit.result).toBe('denied');
    expect(r.audit.deniedCount).toBeGreaterThanOrEqual(2);
  });
});

describe('26.5.4 enforceReleaseGate 规则（统一入口，不可绕过）', () => {
  it('BLOCK 无论审批状态都不允许发布', () => {
    expect(enforceReleaseGate({ decision: 'BLOCK', environment: 'staging' }).allowed).toBe(false);
    expect(enforceReleaseGate({ decision: 'BLOCK', approvalStatus: 'APPROVED', environment: 'staging' }).allowed).toBe(false);
  });

  it('REVIEW 仅 APPROVED 允许，PENDING/REJECTED 不允许', () => {
    expect(enforceReleaseGate({ decision: 'REVIEW', environment: 'staging' }).allowed).toBe(false);
    expect(enforceReleaseGate({ decision: 'REVIEW', approvalStatus: 'PENDING', environment: 'staging' }).allowed).toBe(false);
    expect(enforceReleaseGate({ decision: 'REVIEW', approvalStatus: 'REJECTED', environment: 'staging' }).allowed).toBe(false);
    expect(enforceReleaseGate({ decision: 'REVIEW', approvalStatus: 'APPROVED', environment: 'staging' }).allowed).toBe(true);
  });

  it('PASS 允许发布', () => {
    expect(enforceReleaseGate({ decision: 'PASS', environment: 'staging' }).allowed).toBe(true);
  });
});

describe('26.5.5 gateDrillSummary 汇总', () => {
  it('PASS/REVIEW/BLOCK 组合 → 汇总计数正确、allPass=true', async () => {
    const b = makeBundle();
    const results = [
      await runReleaseGateDrill(b, { environment: 'test', profile: 'sanity' }),
      await runReleaseGateDrill(b, { environment: 'test', profile: 'regression' }),
      await runReleaseGateDrill(b, {
        environment: 'test', profile: 'sanity',
        failCases: ['WAN3-CORE-001'], failReason: '故障注入（release gate drill）：P0 核心链路回归',
      }),
    ];
    const s = gateDrillSummary(results);
    expect(s.total).toBe(3);
    expect(s.pass).toBe(1);
    expect(s.review).toBe(1);
    expect(s.block).toBe(1);
    expect(s.deploymentNotExecuted).toBe(2); // REVIEW 未批准 + BLOCK
    expect(s.bypassBlocked).toBe(2); // REVIEW 未批准 + BLOCK
    expect(s.allPass).toBe(true);
  });
});
