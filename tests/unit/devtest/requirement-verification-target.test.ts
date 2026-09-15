import { describe, expect, it } from "vitest";
import {
  deriveVerificationTargets,
  evaluateRequirementCoverage,
} from "../../../src/devtest/verification-target.js";
import { plan, verify, type VerifyKernelResult } from "../../../src/devtest/core-kernel.js";
import { createSyntheticValidMp4 } from "../../../src/devtest/media-inspector.js";

describe("DevTest 需求驱动质量验证闭环 (Requirement-to-Evidence)", () => {
  it("1. 正确推导具备 P0/P1 等级与副作用约束的业务验证目标集", () => {
    const targets = deriveVerificationTargets(84, "video");
    expect(targets.length).toBeGreaterThanOrEqual(4);
    expect(targets.some((t) => t.id.includes("CONTAINER_INTEGRITY") && t.priority === "P0")).toBe(true);
    expect(targets.some((t) => t.id.includes("FAIL_NET_CHARGE_ZERO") && t.priority === "P0")).toBe(true);
    expect(targets.some((t) => t.sideEffect?.includes("WALLET"))).toBe(true);
  });

  it("2. 真实 Evidence 满足时，目标状态被确定性评定为 VERIFIED", () => {
    const targets = deriveVerificationTargets(84, "video");
    const mockSuccess: VerifyKernelResult = {
      ok: true, passed: true, taskId: 991, modelId: 84, mediaType: "video", status: "SUCCESS", mode: "real",
      billingAudit: "AUDITED",
      artifact: {
        decodable: true, containerIdentified: true, format: "mp4", width: 1280, height: 720, durationSeconds: 5,
        boxesFound: ["ftyp", "moov", "mdat"], reasons: [],
      } as any,
      invariants: { antiDoubleBilling: true, netChargeZero: true, refundIdempotency: true },
      reasons: [],
    };

    const report = evaluateRequirementCoverage(targets, mockSuccess);
    expect(report.verifiedCount).toBeGreaterThanOrEqual(3);
    expect(report.p0PassRate).toBe(100);
    expect(report.summaryText).toContain("[VERIFIED]");
  });

  it("3. 资损不变量被破坏时，评定为 FAILED 并给出具体拦截根因", () => {
    const targets = deriveVerificationTargets(84, "video");
    const mockFinancialLeak: VerifyKernelResult = {
      ok: true, passed: false, taskId: 992, modelId: 84, mediaType: "video", status: "FAILED", mode: "real",
      billingAudit: "AUDITED",
      invariants: { antiDoubleBilling: true, netChargeZero: false, refundIdempotency: true }, // 失败未退款
      reasons: ["失败任务净扣不为 0"],
    };

    const report = evaluateRequirementCoverage(targets, mockFinancialLeak);
    expect(report.failedCount).toBeGreaterThan(0);
    const failTarget = report.verdicts.find((v) => v.target.id.includes("FAIL_NET_CHARGE_ZERO"));
    expect(failTarget?.status).toBe("FAILED");
    expect(failTarget?.reason).toContain("资损");
  });

  it("4. 缺少真实流水证据时，严格标记为 INCONCLUSIVE 而非假 PASS", () => {
    const targets = deriveVerificationTargets(84, "video");
    const mockNoLogs: VerifyKernelResult = {
      ok: true, passed: false, taskId: 993, modelId: 84, mediaType: "video", status: "UNVERIFIED", mode: "mock",
      billingAudit: "SKIPPED_NO_LOGS",
      reasons: ["未提供流水"],
    };

    const report = evaluateRequirementCoverage(targets, mockNoLogs);
    expect(report.inconclusiveCount).toBeGreaterThan(0);
    const billingTarget = report.verdicts.find((v) => v.target.id.includes("FAIL_NET_CHARGE_ZERO"));
    expect(billingTarget?.status).toBe("INCONCLUSIVE");
  });

  it("5. 前置执行异常阻断时，精准标记为 BLOCKED", () => {
    const targets = deriveVerificationTargets(84, "video");
    const mockBlocked: VerifyKernelResult = {
      ok: false, passed: false, taskId: 0, modelId: 84, mediaType: "video", status: "ERROR", mode: "real",
      billingAudit: "SKIPPED_NO_LOGS",
      reasons: ["网络超时，无法连接主站"],
    };

    const report = evaluateRequirementCoverage(targets, mockBlocked);
    expect(report.blockedCount).toBe(targets.length);
  });

  it("6. 端到端 plan() 与 verify() 自动输出需求覆盖报告", async () => {
    const planRes = await plan({ modelId: 84, mediaType: "video" });
    expect(planRes.targets.length).toBeGreaterThan(0);

    const validMp4 = createSyntheticValidMp4({ width: 1280, height: 720, durationSeconds: 4 });
    const verifyRes = await verify({
      taskId: 12300,
      modelId: 84,
      mediaType: "video",
      artifactBuffer: validMp4,
      terminalStatus: "SUCCESS",
      expectedPoints: 56,
      scoreLogs: [{ task_id: 12300, type: 2, score: -56, memo: "预扣" }],
    });

    expect(verifyRes.coverageReport).toBeDefined();
    expect(verifyRes.coverageReport?.verifiedCount).toBeGreaterThan(0);
    expect(verifyRes.coverageReport?.summaryText).toContain("Requirement Coverage:");
  });
});
