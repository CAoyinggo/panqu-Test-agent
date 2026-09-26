/**
 * probe-enforcement — 探活结果的 opt-in 强制门禁（R4）
 *
 * 背景（已证实的漏洞面）：
 *   env-probe 的 `ok` 只由「端点可达 + modelReadiness 无 issue」决定，
 *   完全不看鉴权状态与候选渠道数（见 env-probe.ts:918,929）。
 *   于是「鉴权 MISSING 但端点都通」「candidateChannelCount===0」这类
 *   "看着绿、实则真实派发必然失败" 的状态，今天会以 ok=true / HEALTHY 蒙混过关。
 *
 * 设计（四可原则 · 纯增量）：
 *   - 纯函数、零网络、只消费**已采集**的探活事实，可离线穷举测试；
 *   - 默认关闭（enforce=false）→ 完全不改变既有 probe 行为与退出码；
 *   - 仅在操作者显式 `--enforce` 时，用更严格的 fail-closed 规则把
 *     降级信号收敛为「阻断」。它只影响诊断命令 probe 的退出码，
 *     不触碰 CanonicalVerdict 的唯一裁决权，不改变任何 PASS/FAIL 语义。
 */

export interface ProbeEnforcementFacts {
  status?: 'HEALTHY' | 'DEGRADED' | 'BLOCKED';
  auth?: { status?: 'VALID' | 'EXPIRED' | 'MISSING' };
  candidateChannelCount?: number;
  endpoints?: Array<{ name?: string; reachable?: boolean }>;
}

export interface ProbeEnforcementVerdict {
  /** 是否处于强制门禁模式（即操作者是否传了 --enforce） */
  enforced: boolean;
  /** 在强制模式下是否判定为阻断（存在任一违规即 true） */
  blocked: boolean;
  /** 逐条可读的违规原因（用于 CLI 展示与诊断，绝不泄露凭据值） */
  violations: string[];
}

/**
 * 依据已采集的探活事实评估强制门禁。
 *
 * @param facts   probe 返回结果中的相关字段（缺省一律按最不利/fail-closed 处理）
 * @param enforce 是否启用强制门禁（对应 CLI 的 --enforce）
 */
export function evaluateProbeEnforcement(
  facts: ProbeEnforcementFacts | undefined,
  enforce: boolean,
): ProbeEnforcementVerdict {
  if (!enforce) {
    return { enforced: false, blocked: false, violations: [] };
  }

  const violations: string[] = [];

  // 1) 鉴权必须 VALID —— MISSING / EXPIRED 都无法通过网关真实鉴权。
  const authStatus = facts?.auth?.status ?? 'MISSING';
  if (authStatus !== 'VALID') {
    violations.push(`鉴权凭据非 VALID (当前: ${authStatus}) — 真实测试无法通过网关鉴权，强制门禁阻断`);
  }

  // 2) 候选渠道数必须 > 0 —— 为 0 表示无任何可分流渠道，真实派发必然失败。
  const channels = facts?.candidateChannelCount ?? 0;
  if (channels <= 0) {
    violations.push(`可用渠道数为 ${channels} — 无候选分流渠道，真实派发必然失败，强制门禁阻断`);
  }

  // 3) 任一关键端点不可达 —— fail-closed：宁可误阻断，绝不放行不可达环境。
  const unreachable = (facts?.endpoints ?? []).filter((e) => e && e.reachable === false);
  for (const u of unreachable) {
    violations.push(`关键端点不可达: ${u?.name ?? '未命名端点'} — 强制门禁阻断`);
  }

  // 4) 探活总体状态已是 BLOCKED，但上面未能列出具体项时，仍必须阻断（兜底）。
  if ((facts?.status ?? 'BLOCKED') === 'BLOCKED' && violations.length === 0) {
    violations.push('探活总体状态为 BLOCKED — 强制门禁阻断');
  }

  return { enforced: true, blocked: violations.length > 0, violations };
}
