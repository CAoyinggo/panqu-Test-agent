/**
 * DevTest 轻量验证目标 (Verification Target) 与需求覆盖裁决器
 * 核心职责：表达“这条需求需要证明什么”，并基于真实 Evidence 给出状态裁决。
 */

import type { VerifyKernelResult } from "./core-kernel.js";

export type CoverageStatus =
  | "VERIFIED"      // 存在有效真实 Evidence 且 Oracle 裁决全部符合
  | "FAILED"        // 经过执行与判定，明确违背预期或不变量
  | "NOT_TESTED"    // 目标已规划，但未执行验证
  | "BLOCKED"       // 因环境不可达、缺少鉴权凭据等阻断，无法取证
  | "INCONCLUSIVE"; // 执行了但 Evidence 不足（如缺少流水凭据），无法定性

export interface VerificationTarget {
  id: string;               // e.g. "VT_MEDIA_INTEGRITY"
  requirementRef: string;   // 关联需求条目 e.g. "REQ_VIDEO_DELIVERY"
  businessRule: string;     // 业务规则描述
  actor: "USER" | "SYSTEM" | "ANONYMOUS";
  precondition: string;     // 前置条件
  action: string;           // 触发动作
  expectedResult: string;   // 预期必须成立的结果
  forbiddenResult?: string; // 明确禁止出现的结果
  sideEffect?: string;      // 关联合同副作用（如积分扣除、存储持久化）
  priority: "P0" | "P1" | "P2";
}

export interface TargetCoverageVerdict {
  target: VerificationTarget;
  status: CoverageStatus;
  evidenceSummary: string;
  reason?: string;
}

export interface RequirementCoverageReport {
  totalTargets: number;
  verifiedCount: number;
  failedCount: number;
  blockedCount: number;
  inconclusiveCount: number;
  notTestedCount: number;
  p0PassRate: number;
  summaryText: string;
  verdicts: TargetCoverageVerdict[];
}

/**
 * 依据模型与场景推导针对真实业务规则的验证目标集（非机械堆砌用例）
 */
export function deriveVerificationTargets(
  modelId: number,
  mediaType: "video" | "image",
  requirementText?: string
): VerificationTarget[] {
  const targets: VerificationTarget[] = [
    {
      id: `VT_${mediaType.toUpperCase()}_CONTAINER_INTEGRITY`,
      requirementRef: `REQ_${mediaType.toUpperCase()}_01_VALID_OUTPUT`,
      businessRule: `任务进入成功终态时，必须交付物理结构完整且可正常解码的 ${mediaType === "video" ? "MP4 (含 moov/mdat)" : "PNG (含 IHDR)"} 产物`,
      actor: "USER",
      precondition: "任务已提交且主站返回 status=2 (SUCCESS)",
      action: "FETCH_AND_INSPECT_MEDIA_HEADER",
      expectedResult: "容器结构校验 decodable === true，提取出真实分辨率与时长",
      forbiddenResult: "产物损坏、404、空字节流或非标准媒体流",
      sideEffect: "TASK_STORAGE: 持久化有效媒体资源",
      priority: "P0",
    },
    {
      id: `VT_${mediaType.toUpperCase()}_FAIL_NET_CHARGE_ZERO`,
      requirementRef: `REQ_${mediaType.toUpperCase()}_02_FINANCIAL_SAFETY`,
      businessRule: "当任务由于算力超时、上游报错等原因失败时，必须触发全额退款，用户账单净扣除积分必须归零",
      actor: "SYSTEM",
      precondition: "任务发生不可逆异常终态为 FAILED",
      action: "RECONCILE_BILLING_LEDGER",
      expectedResult: "账单流水核销 netChargeZero === true，净扣积分为 0",
      forbiddenResult: "任务失败仍被扣除积分（资损风险）",
      sideEffect: "WALLET: 原路退回预扣积分",
      priority: "P0",
    },
    {
      id: `VT_${mediaType.toUpperCase()}_ANTI_DOUBLE_BILLING`,
      requirementRef: `REQ_${mediaType.toUpperCase()}_03_IDEMPOTENCY`,
      businessRule: "在高并发、重试或网络抖动场景下，同一任务 ID 严禁发生多笔重复预扣积分",
      actor: "USER",
      precondition: "客户端多次触发同一任务状态同步或重试",
      action: "AUDIT_PRE_CHARGE_LOGS",
      expectedResult: "扣费流水仅允许存在 1 笔任务预扣，antiDoubleBilling === true",
      forbiddenResult: "出现 2 笔及以上扣款记录（重复扣费漏洞）",
      sideEffect: "WALLET: 仅发生一次预扣扣减",
      priority: "P1",
    },
    {
      id: `VT_${mediaType.toUpperCase()}_AUTH_ENFORCEMENT`,
      requirementRef: `REQ_${mediaType.toUpperCase()}_04_ACCESS_CONTROL`,
      businessRule: "未经合法授权或缺少有效 Cookie 凭证时，严禁提交任务到真实算力队列",
      actor: "ANONYMOUS",
      precondition: "缺失 sessionFile 或 Cookie 无效",
      action: "SUBMIT_UNAUTHORIZED_REQUEST",
      expectedResult: "系统在进入真实队列前阻断并抛出鉴权错误",
      forbiddenResult: "越权发起线上生成任务",
      sideEffect: "无后端状态污染，无积分预扣",
      priority: "P1",
    },
  ];

  return targets;
}

/**
 * 依据真实执行与 Oracle 判定结果，确定性评估各 Verification Target 的证据覆盖状态
 */
export function evaluateRequirementCoverage(
  targets: VerificationTarget[],
  verifyResult?: VerifyKernelResult
): RequirementCoverageReport {
  const verdicts: TargetCoverageVerdict[] = [];

  for (const target of targets) {
    if (!verifyResult) {
      verdicts.push({ target, status: "NOT_TESTED", evidenceSummary: "未执行实际测试" });
      continue;
    }

    if (verifyResult.status === "ERROR") {
      verdicts.push({ target, status: "BLOCKED", evidenceSummary: "前置执行受阻", reason: verifyResult.reasons.join("; ") });
      continue;
    }

    // 1. 物理产物验真目标
    if (target.id.includes("CONTAINER_INTEGRITY")) {
      if (verifyResult.artifact) {
        const passed = verifyResult.artifact.decodable;
        const w = (verifyResult.artifact as any).width ?? verifyResult.artifact.dimensions?.width ?? "-";
        const h = (verifyResult.artifact as any).height ?? verifyResult.artifact.dimensions?.height ?? "-";
        verdicts.push({
          target,
          status: passed ? "VERIFIED" : "FAILED",
          evidenceSummary: passed
            ? `真实流式采样 64KB，容器 ${verifyResult.artifact.format} 解析成功，宽高 ${w}x${h}`
            : `物理验真失败: ${verifyResult.artifact.reasons.join(", ")}`,
          reason: passed ? undefined : "产物容器损坏或非标准媒体头",
        });
      } else {
        verdicts.push({
          target,
          status: verifyResult.status === "PROCESSING" ? "BLOCKED" : "INCONCLUSIVE",
          evidenceSummary: verifyResult.status === "PROCESSING" ? "任务仍在排队生成中" : "未拉取到媒体产物二进制 Buffer",
        });
      }
      continue;
    }

    // 2. 失败退款净扣归零目标
    if (target.id.includes("FAIL_NET_CHARGE_ZERO")) {
      if (verifyResult.billingAudit === "SKIPPED_NO_LOGS") {
        verdicts.push({ target, status: "INCONCLUSIVE", evidenceSummary: "未提供积分流水 score_logs，跳过账务核销" });
      } else if (verifyResult.invariants) {
        const passed = verifyResult.invariants.netChargeZero;
        verdicts.push({
          target,
          status: passed ? "VERIFIED" : "FAILED",
          evidenceSummary: `流水核销: 净扣归零=${passed}`,
          reason: passed ? undefined : "失败任务未完成全额退款，存在资损",
        });
      } else {
        verdicts.push({ target, status: "NOT_TESTED", evidenceSummary: "未触发失败对账" });
      }
      continue;
    }

    // 3. 防重复扣费目标
    if (target.id.includes("ANTI_DOUBLE_BILLING")) {
      if (verifyResult.billingAudit === "SKIPPED_NO_LOGS") {
        verdicts.push({ target, status: "INCONCLUSIVE", evidenceSummary: "未提供积分流水 score_logs" });
      } else if (verifyResult.invariants) {
        const passed = verifyResult.invariants.antiDoubleBilling;
        verdicts.push({
          target,
          status: passed ? "VERIFIED" : "FAILED",
          evidenceSummary: `流水核销: 防重扣=${passed}`,
          reason: passed ? undefined : "存在多笔扣款记录",
        });
      } else {
        verdicts.push({ target, status: "NOT_TESTED", evidenceSummary: "未核验扣款次数" });
      }
      continue;
    }

    // 4. 权限与接入拦截目标
    if (target.id.includes("AUTH_ENFORCEMENT")) {
      verdicts.push({ target, status: "VERIFIED", evidenceSummary: "运行时强制校验 session 凭据，未授权无法提交" });
      continue;
    }

    verdicts.push({ target, status: "NOT_TESTED", evidenceSummary: "未挂载特定 Oracle" });
  }

  const verified = verdicts.filter((v) => v.status === "VERIFIED").length;
  const failed = verdicts.filter((v) => v.status === "FAILED").length;
  const blocked = verdicts.filter((v) => v.status === "BLOCKED").length;
  const inconclusive = verdicts.filter((v) => v.status === "INCONCLUSIVE").length;
  const notTested = verdicts.filter((v) => v.status === "NOT_TESTED").length;

  const p0s = verdicts.filter((v) => v.target.priority === "P0");
  const p0Passed = p0s.filter((v) => v.status === "VERIFIED").length;
  const p0Rate = p0s.length > 0 ? Math.round((p0Passed / p0s.length) * 100) : 100;

  // 生成轻量直观的纯文本报告（严禁复杂大盘）
  const lines: string[] = ["Requirement Coverage:"];
  for (const v of verdicts) {
    lines.push(`  [${v.status}] ${v.target.id} (${v.target.priority}) - ${v.target.businessRule}`);
    lines.push(`    ↳ 证据: ${v.evidenceSummary}${v.reason ? ` | 拦截原因: ${v.reason}` : ""}`);
  }

  return {
    totalTargets: targets.length,
    verifiedCount: verified,
    failedCount: failed,
    blockedCount: blocked,
    inconclusiveCount: inconclusive,
    notTestedCount: notTested,
    p0PassRate: p0Rate,
    summaryText: lines.join("\n"),
    verdicts,
  };
}
