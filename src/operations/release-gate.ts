// Release Gate：发布门禁（Phase 21.8）
// 规则：P0 = PASS（全部通过）、P1 通过率 ≥ 98%、Coverage ≥ 90%、Critical Defect = 0
//       → RELEASE = PASS，任一不满足 → BLOCK。

/** 优先级执行统计 */
export interface PriorityRunStats {
  total: number;
  passed: number;
}

/** Release Gate 输入 */
export interface ReleaseGateInput {
  p0: PriorityRunStats;
  p1: PriorityRunStats;
  /** 覆盖率 0~1 */
  coverage: number;
  /** 未关闭的严重缺陷数 */
  criticalDefects: number;
  thresholds?: {
    /** P1 最低通过率（默认 0.98） */
    p1PassRate?: number;
    /** 最低覆盖率（默认 0.9） */
    minCoverage?: number;
  };
}

/** 单项门禁检查 */
export interface ReleaseGateCheck {
  name: string;
  pass: boolean;
  actual: string;
  expected: string;
}

/** Release Gate 结果 */
export interface ReleaseGateResult {
  release: 'PASS' | 'BLOCK';
  checks: ReleaseGateCheck[];
  blockReasons: string[];
  summary: string;
}

/** 评估发布门禁 */
export function evaluateReleaseGate(input: ReleaseGateInput): ReleaseGateResult {
  const p1Threshold = input.thresholds?.p1PassRate ?? 0.98;
  const minCoverage = input.thresholds?.minCoverage ?? 0.9;

  const p0Pass = input.p0.total > 0 && input.p0.passed === input.p0.total;
  const p1Rate = input.p1.total > 0 ? input.p1.passed / input.p1.total : 0;
  const p1Pass = input.p1.total > 0 && p1Rate >= p1Threshold;
  const coveragePass = input.coverage >= minCoverage;
  const criticalPass = input.criticalDefects === 0;

  const checks: ReleaseGateCheck[] = [
    {
      name: 'P0 全部通过',
      pass: p0Pass,
      actual: `${input.p0.passed}/${input.p0.total}`,
      expected: `${input.p0.total}/${input.p0.total}`,
    },
    {
      name: `P1 通过率 ≥ ${(p1Threshold * 100).toFixed(0)}%`,
      pass: p1Pass,
      actual: `${(p1Rate * 100).toFixed(1)}%`,
      expected: `≥ ${(p1Threshold * 100).toFixed(0)}%`,
    },
    {
      name: `Coverage ≥ ${(minCoverage * 100).toFixed(0)}%`,
      pass: coveragePass,
      actual: `${(input.coverage * 100).toFixed(1)}%`,
      expected: `≥ ${(minCoverage * 100).toFixed(0)}%`,
    },
    {
      name: 'Critical Defect = 0',
      pass: criticalPass,
      actual: String(input.criticalDefects),
      expected: '0',
    },
  ];

  const blockReasons = checks.filter((c) => !c.pass).map((c) => `${c.name}：实际 ${c.actual}（期望 ${c.expected}）`);
  const release = blockReasons.length === 0 ? 'PASS' : 'BLOCK';

  return {
    release,
    checks,
    blockReasons,
    summary:
      release === 'PASS'
        ? 'RELEASE=PASS：P0 全过、P1/Coverage/严重缺陷均达标，允许发布'
        : `RELEASE=BLOCK：${blockReasons.join('；')}`,
  };
}
