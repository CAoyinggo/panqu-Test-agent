import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import { RoutingOracle, DEFAULT_KNOWN_GATEWAY_CHANNELS, validateTrustedGatewaySnapshot, type TrustedGatewaySnapshot } from "../../../src/devtest/routing.js";
import { plan, execute, verify } from "../../../src/devtest/core-kernel.js";
import { createSyntheticValidMp4 } from "../../../src/devtest/media-inspector.js";
import { queryTaskRuntimeDetails } from "../../../src/devtest/media-flow.js";
import * as mediaFlow from "../../../src/devtest/media-flow.js";
import { PANQU_FAILURE_PATTERNS } from "../../../src/devtest/domain-knowledge.js";
import { runDevTestCli } from "../../../bin/devtest-cli.js";
import { DevTestMcpService } from "../../../src/devtest/mcp-service.js";

describe("Routing Disambiguation & Gateway Channel Regression Tests", () => {
  const service = new DevTestMcpService(path.resolve("."));

  describe("1. 核心路由消歧门禁 (RoutingOracle.disambiguateTarget)", () => {
    it("#54 歧义输入阻断：纯数字 #54 或 modelId=54 自动识别为渠道，并阻断提交", () => {
      // 传入 modelId: 54
      const res1 = RoutingOracle.disambiguateTarget({ modelId: 54 });
      expect(res1.ok).toBe(false);
      expect(res1.targetKind).toBe("channel");
      expect(res1.channelId).toBe(54);
      expect(res1.error).toContain("BLOCKED_AMBIGUOUS_ID");
      expect(res1.error).toContain("是网关渠道");

      // 传入 rawTarget: "#54"
      const res2 = RoutingOracle.disambiguateTarget({ rawTarget: "#54" });
      expect(res2.ok).toBe(false);
      expect(res2.targetKind).toBe("channel");
      expect(res2.channelId).toBe(54);
      expect(res2.error).toContain("BLOCKED_AMBIGUOUS_CHANNEL");
    });

    it("channel 54 + model 15 放行 (MOCK/OFFLINE 静态契约模式)", () => {
      const res = RoutingOracle.disambiguateTarget({
        channelId: 54,
        modelId: 15,
        mode: "mock",
      });
      expect(res.ok).toBe(true);
      expect(res.targetKind).toBe("channel");
      expect(res.channelId).toBe(54);
      expect(res.channelName).toBe("TD_国际");
      expect(res.modelId).toBe(15);
      expect(res.modelAlias).toBe("seedance-2.0");
      expect(res.channelSource).toBe("SOURCE_STATIC_CONTRACT");
    });

    it("channel 54 + model 78 放行 (MOCK/OFFLINE 静态契约模式)", () => {
      const res = RoutingOracle.disambiguateTarget({
        channelId: 54,
        modelId: 78,
        mode: "mock",
      });
      expect(res.ok).toBe(true);
      expect(res.targetKind).toBe("channel");
      expect(res.channelId).toBe(54);
      expect(res.channelName).toBe("TD_国际");
      expect(res.modelId).toBe(78);
      expect(res.modelAlias).toBe("seedance-2.5");
      expect(res.channelSource).toBe("SOURCE_STATIC_CONTRACT");
    });

    it("channel 54 + model 84 阻断：渠道不支持 Wan3.0 模型", () => {
      const res = RoutingOracle.disambiguateTarget({
        channelId: 54,
        modelId: 84,
        mode: "mock",
      });
      expect(res.ok).toBe(false);
      expect(res.targetKind).toBe("channel");
      expect(res.channelId).toBe(54);
      expect(res.error).toContain("BLOCKED_CHANNEL_MODEL_MISMATCH");
      expect(res.error).toContain("不支持模型 #84");
    });

    it("未知渠道阻断：未识别的渠道标识安全拦截", () => {
      const res = RoutingOracle.disambiguateTarget({
        channelId: 9999,
        modelId: 15,
      });
      expect(res.ok).toBe(false);
      expect(res.targetKind).toBe("channel");
      expect(res.error).toContain("BLOCKED_UNKNOWN_CHANNEL");
    });

    it("渠道缺少 model 时阻断：承接多个模型的渠道必须显式指定 modelId", () => {
      const res = RoutingOracle.disambiguateTarget({
        channelId: 54,
      });
      expect(res.ok).toBe(false);
      expect(res.targetKind).toBe("channel");
      expect(res.channelId).toBe(54);
      expect(res.error).toContain("BLOCKED_AMBIGUOUS_CHANNEL");
      expect(res.error).toContain("承接多个模型");
    });
  });

  describe("2. DEFAULT_KNOWN_GATEWAY_CHANNELS 与 REAL 模式静态表安全门禁", () => {
    it("DEFAULT_KNOWN_GATEWAY_CHANNELS 只能标记为 SOURCE_STATIC_CONTRACT", () => {
      expect(DEFAULT_KNOWN_GATEWAY_CHANNELS.length).toBeGreaterThan(0);
      for (const ch of DEFAULT_KNOWN_GATEWAY_CHANNELS) {
        expect(ch.sourceMode).toBe("SOURCE_STATIC_CONTRACT");
      }
    });

    it("REAL 模式没有实时渠道数据时消歧成功但标记为 SOURCE_STATIC_CONTRACT 并产生警告", () => {
      const res = RoutingOracle.disambiguateTarget({
        channelId: 54,
        modelId: 15,
        mode: "real",
      });
      expect(res.ok).toBe(true);
      expect(res.channelSource).toBe("SOURCE_STATIC_CONTRACT");
      expect(res.warning).toContain("SOURCE_STATIC_CONTRACT");
    });

    it("REAL 模式提供线上真实渠道快照时准予放行并标记 SOURCE_REAL_GATEWAY", () => {
      const realSnapshot = [
        { id: 54, name: "TD_国际", group: "panqu_test", models: ["seedance-2.0", "seedance-2.5"], status: 1, weight: 10, dailyQuotaLimit: 0, usedQuota: 0, sourceMode: "SOURCE_REAL_GATEWAY" as const },
      ];
      const res = RoutingOracle.disambiguateTarget({
        channelId: 54,
        modelId: 15,
        mode: "real",
      }, realSnapshot);
      expect(res.ok).toBe(true);
      expect(res.channelSource).toBe("SOURCE_REAL_GATEWAY");
      expect(res.modelId).toBe(15);
    });

    it("不允许仅凭未提供真实快照标记 SOURCE_REAL_GATEWAY", () => {
      const res = RoutingOracle.disambiguateTarget({
        channelId: 54,
        modelId: 15,
        mode: "real",
      });
      expect(res.channelSource).not.toBe("SOURCE_REAL_GATEWAY");
      expect(res.channelSource).toBe("SOURCE_STATIC_CONTRACT");
    });
  });

  describe("3. CLI 参数透传校验", () => {
    it("CLI plan 命令透传 --channel 54 --model 15 正常解析", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const exitCode = await runDevTestCli(["plan", "--channel", "54", "--model", "15", "--media", "video", "--json"]);
        expect(exitCode).toBe(0);
        const output = JSON.parse(logSpy.mock.calls[0][0]);
        expect(output.ok).toBe(true);
        expect(output.disambiguation?.channelId).toBe(54);
        expect(output.disambiguation?.modelId).toBe(15);
      } finally {
        logSpy.mockRestore();
      }
    });

    it("CLI plan 命令遇到 channel 54 与 model 84 冲突拦截并退出非零码", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const exitCode = await runDevTestCli(["plan", "--channel", "54", "--model", "84", "--media", "video", "--json"]);
        expect(exitCode).toBe(1);
        const output = JSON.parse(logSpy.mock.calls[0][0]);
        expect(output.ok).toBe(false);
        expect(output.reason).toContain("BLOCKED_CHANNEL_MODEL_MISMATCH");
      } finally {
        logSpy.mockRestore();
      }
    });

    it("CLI execute 命令透传 --channel 54 --model 15 在受控 mock 模式执行", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const exitCode = await runDevTestCli([
          "execute",
          "--channel", "54",
          "--model", "15",
          "--media", "video",
          "--mode", "mock",
          "--price", "14",
          "--json",
        ]);
        expect(exitCode).toBe(0);
        const output = JSON.parse(logSpy.mock.calls[0][0]);
        expect(output.ok).toBe(true);
        expect(output.modelId).toBe(15);
        expect(output.mode).toBe("mock");
        expect(output.disambiguation?.channelId).toBe(54);
      } finally {
        logSpy.mockRestore();
      }
    });
  });

  describe("4. MCP 参数透传校验", () => {
    it("MCP plan 动作正确解析 channel_id 与 model_id", async () => {
      const res = await service.call({
        action: "plan",
        channel_id: 54,
        model_id: 15,
        media_type: "video",
      });
      expect(res.ok).toBe(true);
      expect(res.data.disambiguation?.channelId).toBe(54);
      expect(res.data.disambiguation?.modelId).toBe(15);
      expect(res.data.disambiguation?.modelAlias).toBe("seedance-2.0");
    });

    it("MCP plan 动作在 channel_id 54 与 model_id 84 冲突时准确阻断", async () => {
      const res = await service.call({
        action: "plan",
        channel_id: 54,
        model_id: 84,
        media_type: "video",
      });
      expect(res.ok).toBe(false);
      expect(res.data.disambiguation?.error).toContain("BLOCKED_CHANNEL_MODEL_MISMATCH");
    });

    it("MCP execute 动作正确透传 channel_id, model_id 并执行受控仿真", async () => {
      const res = await service.call({
        action: "execute",
        channel_id: 54,
        model_id: 15,
        media_type: "video",
        mode: "mock",
        price: 14,
      });
      expect(res.ok).toBe(true);
      expect(res.data.mode).toBe("mock");
      expect(res.data.disambiguation?.channelId).toBe(54);
      expect(res.data.disambiguation?.modelId).toBe(15);
    });
  });

  describe("5. 真实模式门禁阻断与零网络提交保护 (Real Execution Gate & Zero Side-effect)", () => {
    it("execute(mode=real, channel=54, model=15) 主动阻断为 BLOCKED_CANNOT_ENFORCE_CHANNEL 且零网络请求", async () => {
      const fetchSpy = vi.spyOn(global, "fetch");
      try {
        const res = await execute({
          mode: "real",
          channelId: 54,
          modelId: 15,
          mediaType: "video",
        });
        expect(res.ok).toBe(false);
        expect(res.status).toBe("BLOCKED");
        expect(res.blockerCode).toBe("BLOCKED_CANNOT_ENFORCE_CHANNEL");
        expect(res.message).toContain("BLOCKED_CANNOT_ENFORCE_CHANNEL");
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("CLI 在 real 模式下缺少实时渠道数据时被阻断且退出码为 1，零网络请求", async () => {
      const fetchSpy = vi.spyOn(global, "fetch");
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const exitCode = await runDevTestCli([
          "execute",
          "--mode", "real",
          "--channel", "54",
          "--model", "15",
          "--media", "video",
          "--json",
        ]);
        expect(exitCode).toBe(1);
        const output = JSON.parse(logSpy.mock.calls[0][0]);
        expect(output.ok).toBe(false);
        expect(output.status).toBe("BLOCKED");
        expect(output.blockerCode).toBe("BLOCKED_CANNOT_ENFORCE_CHANNEL");
        expect(output.message).toContain("BLOCKED_CANNOT_ENFORCE_CHANNEL");
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
        logSpy.mockRestore();
      }
    });

    it("MCP 在 real 模式下缺少实时渠道数据时被阻断且零网络请求", async () => {
      const fetchSpy = vi.spyOn(global, "fetch");
      try {
        const res = await service.call({
          action: "execute",
          mode: "real",
          channel_id: 54,
          model_id: 15,
          media_type: "video",
        });
        expect(res.passed).toBe(false);
        expect(res.status).toBe("BLOCKED");
        expect(res.error).toContain("BLOCKED_CANNOT_ENFORCE_CHANNEL");
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  describe("6. RH-国际 (Channel 2) 静态名单注册与消歧门禁", () => {
    it("DEFAULT_KNOWN_GATEWAY_CHANNELS 包含 Channel 2 (RH-国际) 且承接 seedance 2.0/2.5", () => {
      const ch2 = DEFAULT_KNOWN_GATEWAY_CHANNELS.find((c) => c.id === 2);
      expect(ch2).toBeDefined();
      expect(ch2?.name).toBe("RH-国际");
      expect(ch2?.models).toContain("seedance-2.0");
      expect(ch2?.models).toContain("seedance-2.5");
      expect(ch2?.sourceMode).toBe("SOURCE_STATIC_CONTRACT");
    });

    it("channelId=2 + modelId=78 在 mock 模式下消歧成功", () => {
      const res = RoutingOracle.disambiguateTarget({
        channelId: 2,
        modelId: 78,
        mode: "mock",
      });
      expect(res.ok).toBe(true);
      expect(res.targetKind).toBe("channel");
      expect(res.channelId).toBe(2);
      expect(res.channelName).toBe("RH-国际");
      expect(res.modelId).toBe(78);
      expect(res.modelAlias).toBe("seedance-2.5");
    });

    it("channelName='RH-国际' + modelId=15 在 mock 模式下消歧成功", () => {
      const res = RoutingOracle.disambiguateTarget({
        channelName: "RH-国际",
        modelId: 15,
        mode: "mock",
      });
      expect(res.ok).toBe(true);
      expect(res.targetKind).toBe("channel");
      expect(res.channelId).toBe(2);
      expect(res.modelId).toBe(15);
      expect(res.modelAlias).toBe("seedance-2.0");
    });

    it("纯输入 modelId=2 触发歧义拦截，识别为网关渠道 #2 并阻断回退未知模型", () => {
      const res = RoutingOracle.disambiguateTarget({
        modelId: 2,
      });
      expect(res.ok).toBe(false);
      expect(res.targetKind).toBe("channel");
      expect(res.channelId).toBe(2);
      expect(res.error).toContain("BLOCKED_AMBIGUOUS_ID");
      expect(res.error).toContain("#2 是网关渠道 'RH-国际'");
    });

    it("channel 2 与不支持的模型 (如 #84) 冲突时阻断", () => {
      const res = RoutingOracle.disambiguateTarget({
        channelId: 2,
        modelId: 84,
        mode: "mock",
      });
      expect(res.ok).toBe(false);
      expect(res.error).toContain("BLOCKED_CHANNEL_MODEL_MISMATCH");
      expect(res.error).toContain("不支持模型 #84");
    });
  });

  describe("7. REAL 模式下指定渠道的主动阻断门禁 (BLOCKED_CANNOT_ENFORCE_CHANNEL)", () => {
    it("即使拥有真实渠道快照，REAL execute 指定目标渠道也会主动阻断，因为主站接口不支持锁定渠道", async () => {
      const realSnapshot = [
        { id: 2, name: "RH-国际", group: "panqu_test", models: ["seedance-2.0", "seedance-2.5"], status: 1, weight: 10, dailyQuotaLimit: 0, usedQuota: 0, sourceMode: "SOURCE_REAL_GATEWAY" as const },
      ];
      const fetchSpy = vi.spyOn(global, "fetch");
      try {
        const res = await execute({
          mode: "real",
          channelId: 2,
          channels: realSnapshot,
          modelId: 78,
          mediaType: "video",
          price: 21,
          duration: 4,
          sessionFile: "nonexistent.json",
        });
        expect(res.ok).toBe(false);
        expect(res.status).toBe("BLOCKED");
        expect(res.blockerCode).toBe("BLOCKED_CANNOT_ENFORCE_CHANNEL");
        expect(res.message).toContain("BLOCKED_CANNOT_ENFORCE_CHANNEL");
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  describe("8. verify 目标渠道核验、渠道不匹配与兜底防线 (Channel Attribution & Fallback Defense)", () => {
    const validMp4 = createSyntheticValidMp4({ width: 854, height: 480, durationSeconds: 4 });

    it("目标渠道不匹配时拒绝通过：预期 RH (#2) 实际 TD (#54)，判定 FAIL / REJECTED", async () => {
      const res = await verify({
        taskId: 239467,
        modelId: 78,
        mediaType: "video",
        channelId: 2,
        actualChannelId: 54,
        actualChannelName: "TD_国际",
        terminalStatus: "SUCCESS",
        artifactBuffer: validMp4,
        expectedPoints: 84,
        price: 21,
        duration: 4,
        scoreLogs: [{ task_id: 239467, type: 2, score: -84, memo: "预扣" }],
        extra: { diversion: 10 },
      });

      // 技术检验合格 (成片物理结构与账单满足)
      expect(res.evidence.media.status).toBe("PASS");
      expect(res.evidence.billing.status).toBe("PASS");
      expect(res.businessValidation?.technicalSuccess).toBe(true);

      // 业务目标未达成 (目标渠道不匹配)
      expect(res.businessValidation?.businessSuccess).toBe(false);
      expect(res.businessValidation?.status).toBe("FAIL");
      expect(res.businessValidation?.verdictDetail.channelMatched).toBe(false);

      // 核心裁决必须为 FAIL / REJECTED，零假 PASS
      expect(res.passed).toBe(false);
      expect(res.verdict).toBe("FAIL");
      expect(res.acceptance).toBe("REJECTED");
      expect(res.reasons.some((r) => r.includes("CHANNEL_MISMATCH") || r.includes("目标渠道不匹配"))).toBe(true);
    });

    it("兜底成片不被误判为目标渠道合格：目标 RH (#2) 发生兜底 fallback (volc_new)，判定 FAIL / REJECTED", async () => {
      const res = await verify({
        taskId: 239467,
        modelId: 78,
        mediaType: "video",
        channelId: 2,
        actualChannelId: 2, // 假定即便实际渠道标为 2，但产物由兜底生成
        fallbackChannel: "volc_new",
        retryProvider: "volc_new",
        terminalStatus: "SUCCESS",
        artifactBuffer: validMp4,
        expectedPoints: 84,
        price: 21,
        duration: 4,
        scoreLogs: [{ task_id: 239467, type: 2, score: -84, memo: "预扣" }],
        extra: { diversion: 10 },
      });

      expect(res.businessValidation?.technicalSuccess).toBe(true);
      expect(res.businessValidation?.businessSuccess).toBe(false);
      expect(res.businessValidation?.status).toBe("FAIL");
      expect(res.businessValidation?.verdictDetail.fallbackAvoided).toBe(false);

      expect(res.passed).toBe(false);
      expect(res.verdict).toBe("FAIL");
      expect(res.acceptance).toBe("REJECTED");
      expect(res.reasons.some((r) => r.includes("FALLBACK_ARTIFACT_NOT_ACCEPTED") || r.includes("兜底通道"))).toBe(true);
    });

    it("指定目标渠道但缺少服务端执行渠道数据时，裁决 UNVERIFIED 而非假 PASS", async () => {
      const res = await verify({
        taskId: 239467,
        modelId: 78,
        mediaType: "video",
        channelId: 2,
        // 未提供 actualChannelId 或 retryLog
        terminalStatus: "SUCCESS",
        artifactBuffer: validMp4,
        expectedPoints: 84,
        price: 21,
        duration: 4,
        scoreLogs: [{ task_id: 239467, type: 2, score: -84, memo: "预扣" }],
        extra: { diversion: 10 },
      });

      expect(res.passed).toBe(false);
      expect(res.verdict).toBe("UNVERIFIED");
      expect(["UNVERIFIED", "BLOCKED"]).toContain(res.acceptance);
      expect(res.reasons.some((r) => r.includes("缺少服务端执行渠道证据") || r.includes("UNVERIFIED"))).toBe(true);
    });

    it("目标渠道真实履约、无兜底、成片及账单均合格时，准予全线 PASS / ACCEPTED", async () => {
      const res = await verify({
        taskId: 239467,
        modelId: 78,
        mediaType: "video",
        channelId: 2,
        actualChannelId: 2,
        actualChannelName: "RH-国际",
        terminalStatus: "SUCCESS",
        artifactBuffer: validMp4,
        expectedPoints: 84,
        price: 21,
        duration: 4,
        scoreLogs: [{ task_id: 239467, type: 2, score: -84, memo: "预扣" }],
        extra: { diversion: 10 },
        gatewayChannelConfirmed: true,
      });

      expect(res.businessValidation?.technicalSuccess).toBe(true);
      expect(res.businessValidation?.businessSuccess).toBe(true);
      expect(res.businessValidation?.status).toBe("PASS");
      expect(res.businessValidation?.verdictDetail.channelMatched).toBe(true);
      expect(res.businessValidation?.verdictDetail.fallbackAvoided).toBe(true);

      expect(res.passed).toBe(true);
      expect(res.verdict).toBe("PASS");
      expect(res.acceptance).toBe("ACCEPTED");
    });
  });

  describe("9. 只读 HTTP extra 证据链与去 DB 依赖校验", () => {
    it("传入只读 HTTP extra (如 extra.diversion=10) 时，extraSnapshot 状态为 VERIFIED，无需手动 DB 查询", async () => {
      const res = await verify({
        taskId: 239467,
        modelId: 78,
        mediaType: "video",
        terminalStatus: "SUCCESS",
        extra: { diversion: 10, newapi_org_id: 54 },
      });

      expect(res.expectedVsActual?.evidenceStatus.extraSnapshot).toBe("VERIFIED");
      const extraDiff = res.expectedVsActual?.diffs.find((d) => d.field === "diversionExtra");
      expect(extraDiff?.status).toBe("PASS");
      expect(extraDiff?.diff).toBe("MATCH");
      expect(res.expectedVsActual?.manualVerificationGuide?.notice).toContain("无需手动查询数据库");
    });
  });

  describe("10. 阶段七：反证回归测试与证据权威性校验 (7 大问题逐项核验)", () => {
    const validMp4 = createSyntheticValidMp4({ width: 854, height: 480, durationSeconds: 4 });

    it("【用例 1: 反证用例】实际渠道为 54、兜底为 volc_new 时，即使入参覆盖声称 --actual-channel-id 2，结果必须为 FAIL/REJECTED 且包含 EVIDENCE_CONFLICT", async () => {
      const mockSession = {
        env: "test" as const,
        base_url: "https://test.panqu.com",
        cookie_string: "PHPSESSID=mock_session_val",
        project_id: 365,
      };

      const fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async (url: any) => {
        const urlStr = String(url);
        if (urlStr.includes("/aivideo/v2/task_status/apiGetStatus")) {
          return new Response(JSON.stringify({ code: 1, data: [{ id: 239467, status: 2, task_status: 2, progress: 100, video_url: "https://example.com/mock.mp4" }] }), { status: 200 });
        }
        if (urlStr.includes("mock.mp4")) {
          return new Response(new Uint8Array(validMp4), { status: 200, headers: { "content-type": "video/mp4" } });
        }
        if (urlStr.includes("/aivideo/v2/video/getEditData")) {
          return new Response(JSON.stringify({ code: 1, data: { extra: JSON.stringify({ diversion: 10, newapi_org_id: 54 }) } }), { status: 200 });
        }
        if (urlStr.includes("/aivideo/diversion/retrylog")) {
          return new Response(JSON.stringify({ total: 1, rows: [{ id: 18010, source_id: 239467, newapi_channel_id: 54, newapi_provider_name: "TD_国际", fallback_channel: "volc_new", task_id: 18010 }] }), { status: 200 });
        }
        if (urlStr.includes("/aivideo/exceptionaltaskdata/index")) {
          return new Response(JSON.stringify({ total: 1, rows: [{ id: 18010, source_id: 239467, line_name: "NewApi(TD_国际)", extra: JSON.stringify({ retry_provider: "volc_new" }) }] }), { status: 200 });
        }
        return new Response(JSON.stringify({ code: 0, msg: "not found" }), { status: 404 });
      });

      try {
        const res = await verify({
          taskId: 239467,
          modelId: 78,
          mediaType: "video",
          projectId: 365,
          channelId: 2,
          // 故意传入覆盖参数
          actualChannelId: 2,
          actualChannelName: "RH-国际",
          fallbackChannel: "none",
          retryProvider: "none",
          terminalStatus: "SUCCESS",
          artifactBuffer: validMp4,
          expectedPoints: 84,
          price: 21,
          duration: 4,
          scoreLogs: [{ task_id: 239467, type: 2, score: -84, memo: "预扣" }],
          session: mockSession,
        });

        // 核心断言：检测到冲突，服务端事实胜出，判定 FAIL / REJECTED
        expect(res.hasEvidenceConflict).toBe(true);
        expect(res.passed).toBe(false);
        expect(res.verdict).toBe("FAIL");
        expect(res.acceptance).toBe("REJECTED");
        expect(res.businessValidation?.status).toBe("FAIL");
        expect(res.businessValidation?.credibility).toBe("SUSPICIOUS");
        expect(res.businessValidation?.matchedFailurePatterns).toContain(PANQU_FAILURE_PATTERNS.PATTERN_EVIDENCE_CONFLICT.id);
        expect(res.reasons.some((r) => r.includes("EVIDENCE_CONFLICT") || r.includes("冲突"))).toBe(true);

        // 审计字段保持服务端事实 (54 / volc_new)，而非被调用的 2 覆盖
        expect(res.channelDetail?.actualChannelId).toBe(54);
        expect(res.channelDetail?.fallbackChannel).toBe("volc_new");
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("【用例 2: 手填存疑】仅有入参断言、无服务端渠道记录时，可信度最高只能为 PROVISIONAL/OBSERVED，禁止标记为 CONFIRMED", async () => {
      const mockSession = {
        env: "test" as const,
        base_url: "https://test.panqu.com",
        cookie_string: "PHPSESSID=mock_session_val",
        project_id: 365,
      };

      const fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async (url: any) => {
        const urlStr = String(url);
        if (urlStr.includes("/aivideo/v2/task_status/apiGetStatus")) {
          return new Response(JSON.stringify({ code: 1, data: [{ id: 239467, status: 2, task_status: 2, progress: 100, video_url: "https://example.com/mock.mp4" }] }), { status: 200 });
        }
        if (urlStr.includes("mock.mp4")) {
          return new Response(new Uint8Array(validMp4), { status: 200, headers: { "content-type": "video/mp4" } });
        }
        // 服务端返回空 rows，无法查得真实渠道
        if (urlStr.includes("/aivideo/diversion/retrylog")) {
          return new Response(JSON.stringify({ total: 0, rows: [] }), { status: 200 });
        }
        if (urlStr.includes("/aivideo/exceptionaltaskdata/index")) {
          return new Response(JSON.stringify({ total: 0, rows: [] }), { status: 200 });
        }
        if (urlStr.includes("/aivideo/v2/video/getEditData")) {
          return new Response(JSON.stringify({ code: 1, data: { extra: "{}" } }), { status: 200 });
        }
        return new Response(JSON.stringify({ code: 0 }), { status: 404 });
      });

      try {
        const res = await verify({
          taskId: 239467,
          modelId: 78,
          mediaType: "video",
          projectId: 365,
          channelId: 2,
          actualChannelId: 2,
          actualChannelName: "RH-国际",
          fallbackChannel: "none",
          retryProvider: "none",
          terminalStatus: "SUCCESS",
          artifactBuffer: validMp4,
          expectedPoints: 84,
          price: 21,
          duration: 4,
          scoreLogs: [{ task_id: 239467, type: 2, score: -84, memo: "预扣" }],
          session: mockSession,
        });

        expect(res.isActualChannelAssertedOnly).toBe(true);
        expect(res.businessValidation?.credibility).not.toBe("CONFIRMED");
        expect(["PROVISIONAL", "OBSERVED"]).toContain(res.businessValidation?.credibility);
        expect(res.provenance?.actualChannelId).toContain("CLI_ASSERTED_INPUT");
        expect(res.provenance?.actualChannelId).not.toBe("HTTP_API:retrylog");
        expect(res.businessValidation?.verdictDetail.channelMatched).toBeUndefined();
        expect(res.channelDetail?.channelMatched).toBeUndefined();
        expect(res.channelDetail?.status).toBe("UNVERIFIED");
        expect(res.verdict).toBe("UNVERIFIED");
        expect(res.acceptance).toBe("BLOCKED");
        expect(res.evidenceCompleteness.availableEvidence).not.toContain("targetChannelFulfilled");
        expect(res.evidenceCompleteness.missingEvidence).toContain("targetChannelFulfilled:UNVERIFIED");
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("【用例 3: getEditData 错误捕获】当未带 project_id 或接口返回 404 时，记录具体错误，不得静默吞错", async () => {
      const mockSession = {
        env: "test" as const,
        base_url: "https://test.panqu.com",
        cookie_string: "PHPSESSID=mock_session_val",
      };

      // 1. 未带 projectId
      const resWithoutProj = await queryTaskRuntimeDetails(239467, mockSession, { projectId: undefined });
      expect(resWithoutProj.endpoints.getEditData.queryStatus).toBe("UNVERIFIED_MISSING_PROJECT_ID");
      expect(resWithoutProj.endpoints.getEditData.missingFields).toContain("projectId");
      expect(resWithoutProj.endpoints.getEditData.error).toContain("缺少 projectId");

      // 2. HTTP 404
      const fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async () => {
        return new Response("Not Found", { status: 404 });
      });

      try {
        const res404 = await queryTaskRuntimeDetails(239467, { ...mockSession, project_id: 365 }, { projectId: 365 });
        expect(res404.endpoints.getEditData.httpStatus).toBe(404);
        expect(res404.endpoints.getEditData.queryStatus).toBe("FAILED");
        expect(res404.endpoints.getEditData.error).toContain("404");
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("【用例 4: 来源不冒充】exceptional-task 查出的字段，extraSource 必须为 HTTP_API:exceptional-task，不得冒充 HTTP_API:getEditData", async () => {
      const mockSession = {
        env: "test" as const,
        base_url: "https://test.panqu.com",
        cookie_string: "PHPSESSID=mock_session_val",
        project_id: 365,
      };

      const fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async (url: any) => {
        const urlStr = String(url);
        if (urlStr.includes("/aivideo/v2/video/getEditData")) {
          return new Response(JSON.stringify({ code: 0, msg: "no extra here" }), { status: 200 });
        }
        if (urlStr.includes("/aivideo/diversion/retrylog")) {
          return new Response(JSON.stringify({ total: 0, rows: [] }), { status: 200 });
        }
        if (urlStr.includes("/aivideo/exceptionaltaskdata/index")) {
          return new Response(JSON.stringify({
            total: 1,
            rows: [{
              id: 18010,
              source_id: 239467,
              line_name: "NewApi(TD_国际)",
              extra: JSON.stringify({ retry_provider: "volc_new", video_provider: "volc" })
            }]
          }), { status: 200 });
        }
        return new Response("404", { status: 404 });
      });

      try {
        const res = await queryTaskRuntimeDetails(239467, mockSession, { projectId: 365 });
        expect(res.extraSource).toBe("HTTP_API:exceptional-task");
        expect(res.extraSource).not.toBe("HTTP_API:getEditData");
        expect(res.endpoints.exceptionaltask.dataSource).toBe("HTTP_API:exceptional-task");
        expect(res.retryProvider).toBe("volc_new");
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("【用例 5: Channel 2 Plan 阻断且无 Channel 1】plan(--channel 2) 的 blocked 必须非空，executable 为 false，blockerCode 包含 BLOCKED_CANNOT_ENFORCE_CHANNEL，candidateChannels 绝不包含 Channel 1", async () => {
      const res = await plan({
        channelId: 2,
        modelId: 78,
        mediaType: "video",
      });

      expect(res.executable).toBe(false);
      expect(res.blockerCode).toBe("BLOCKED_CANNOT_ENFORCE_CHANNEL");
      expect(res.acceptanceForecast).toBe("BLOCKED");
      expect(res.testPlan.blocked.some((b) => b.field === "channel_enforcement")).toBe(true);

      // candidateChannels 绝不包含主渠道 (Channel 1)
      expect(res.candidateChannels).toBeDefined();
      expect(res.candidateChannels?.some((c) => c.includes("主渠道") || c.includes("#1"))).toBe(false);
      expect(res.candidateChannels?.some((c) => c.includes("RH-国际") || c.includes("2"))).toBe(true);
    });

    it("【用例 6: 定价冲突 UNVERIFIED】Channel 2 + Seedance-2.5 在未指定 price 时，pricingStatus 必须为 UNVERIFIED，expectedPoints 为 0，testPlan.blocked 必须非空", async () => {
      const res = await plan({
        channelId: 2,
        modelId: 78,
        mediaType: "video",
      });

      expect(res.contract.pricing.isPricingDetermined).toBe(false);
      expect(res.contract.pricing.source).toBe("MANUAL_REQUIRED");
      expect(res.pricingStatus).toBe("UNVERIFIED");
      expect(res.expectedPoints).toBe(0);
      expect(res.testPlan.blocked.some((b) => b.field === "pricing")).toBe(true);
    });

    it("【用例 7: 定价显式覆盖】在指定 --price 21 或 --price 28 时，pricingStatus 允许确定，但仍因渠道不可强制而保持 BLOCKED", async () => {
      const res = await plan({
        channelId: 2,
        modelId: 78,
        mediaType: "video",
        price: 21,
        duration: 4,
      });

      expect(res.contract.pricing.isPricingDetermined).toBe(true);
      expect(res.expectedPoints).toBe(84);
      expect(res.pricingStatus).toBe("DETERMINED");
      // 仍然不可执行，保持阻断
      expect(res.executable).toBe(false);
      expect(res.acceptanceForecast).toBe("BLOCKED");
      expect(res.blockerCode).toBe("BLOCKED_CANNOT_ENFORCE_CHANNEL");
      expect(res.testPlan.blocked.some((b) => b.field === "channel_enforcement")).toBe(true);
    });

    it("【用例 8: REAL Execute 阻断】execute(--channel 2, mode=real) 必须返回 BLOCKED_CANNOT_ENFORCE_CHANNEL，零网络真实提交", async () => {
      const fetchSpy = vi.spyOn(global, "fetch");
      try {
        const res = await execute({
          channelId: 2,
          modelId: 78,
          mediaType: "video",
          mode: "real",
          price: 21,
          duration: 4,
        });

        expect(res.ok).toBe(false);
        expect(res.status).toBe("BLOCKED");
        expect(res.blockerCode).toBe("BLOCKED_CANNOT_ENFORCE_CHANNEL");
        expect(res.message).toContain("BLOCKED_CANNOT_ENFORCE_CHANNEL");
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("【用例 9: 正向通过用例】构造 mock：实际渠道为 2、无兜底、无重试、视频校验通过、计费一致，结果必须为 PASS", async () => {
      const res = await verify({
        taskId: 239467,
        modelId: 78,
        mediaType: "video",
        channelId: 2,
        actualChannelId: 2,
        actualChannelName: "RH-国际",
        fallbackChannel: "none",
        retryProvider: "none",
        terminalStatus: "SUCCESS",
        artifactBuffer: validMp4,
        expectedPoints: 84,
        price: 21,
        duration: 4,
        scoreLogs: [{ task_id: 239467, type: 2, score: -84, memo: "预扣" }],
        extra: { diversion: 10 },
        gatewayChannelConfirmed: true,
      });

      expect(res.passed).toBe(true);
      expect(res.verdict).toBe("PASS");
      expect(res.acceptance).toBe("ACCEPTED");
      expect(res.businessValidation?.status).toBe("PASS");
      expect(res.businessValidation?.verdictDetail.channelMatched).toBe(true);
      expect(res.businessValidation?.verdictDetail.fallbackAvoided).toBe(true);
      expect(res.hasEvidenceConflict).toBe(false);
    });

    it("【用例 10: 兜底成片拒收】构造 mock：实际渠道为 2，但 fallbackChannel 为 volc_new，结果必须为 FAIL，命中 PATTERN_FALLBACK_ARTIFACT_NOT_ACCEPTED", async () => {
      const res = await verify({
        taskId: 239467,
        modelId: 78,
        mediaType: "video",
        channelId: 2,
        actualChannelId: 2,
        actualChannelName: "RH-国际",
        fallbackChannel: "volc_new",
        retryProvider: "volc_new",
        terminalStatus: "SUCCESS",
        artifactBuffer: validMp4,
        expectedPoints: 84,
        price: 21,
        duration: 4,
        scoreLogs: [{ task_id: 239467, type: 2, score: -84, memo: "预扣" }],
        extra: { diversion: 10 },
      });

      expect(res.passed).toBe(false);
      expect(res.verdict).toBe("FAIL");
      expect(res.acceptance).toBe("REJECTED");
      expect(res.businessValidation?.status).toBe("FAIL");
      expect(res.businessValidation?.matchedFailurePatterns).toContain(PANQU_FAILURE_PATTERNS.PATTERN_FALLBACK_ARTIFACT_NOT_ACCEPTED.id);
      expect(res.reasons.some((r) => r.includes("FALLBACK_ARTIFACT_NOT_ACCEPTED"))).toBe(true);
    });
  });

  describe("11. Phase 0 可信度收口与网关渠道验证强化", () => {
    const validMp4 = createSyntheticValidMp4({ width: 854, height: 480, durationSeconds: 4 });
    const mockSession = {
      env: "test" as const,
      base_url: "https://test.panqu.com",
      cookie_string: "PHPSESSID=mock_closure_session",
      project_id: 365,
    };

    it("REAL + CLI asserted actualChannelId + no server actualChannelId: channelMatched 必须为 undefined 且验收为 BLOCKED", async () => {
      const fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async (url: any) => {
        const urlStr = String(url);
        if (urlStr.includes("/aivideo/v2/task_status/apiGetStatus")) {
          return new Response(JSON.stringify({ code: 1, data: [{ id: 239467, status: 2, task_status: 2, progress: 100, video_url: "https://example.com/mock.mp4" }] }), { status: 200 });
        }
        if (urlStr.includes("mock.mp4")) {
          return new Response(new Uint8Array(validMp4), { status: 200, headers: { "content-type": "video/mp4" } });
        }
        if (urlStr.includes("/aivideo/diversion/retrylog")) {
          return new Response(JSON.stringify({ total: 0, rows: [] }), { status: 200 });
        }
        if (urlStr.includes("/aivideo/exceptionaltaskdata/index")) {
          return new Response(JSON.stringify({ total: 0, rows: [] }), { status: 200 });
        }
        if (urlStr.includes("/aivideo/v2/video/getEditData")) {
          return new Response(JSON.stringify({ code: 1, data: { extra: "{}" } }), { status: 200 });
        }
        return new Response(JSON.stringify({ code: 0 }), { status: 404 });
      });

      try {
        const res = await verify({
          taskId: 239467,
          modelId: 78,
          mediaType: "video",
          projectId: 365,
          channelId: 2,
          actualChannelId: 2,
          actualChannelName: "RH-国际",
          terminalStatus: "SUCCESS",
          artifactBuffer: validMp4,
          expectedPoints: 84,
          price: 21,
          duration: 4,
          scoreLogs: [{ task_id: 239467, type: 2, score: -84, memo: "预扣" }],
          session: mockSession,
        });

        expect(res.isActualChannelAssertedOnly).toBe(true);
        expect(res.channelDetail?.channelMatched).toBeUndefined();
        expect(res.businessValidation?.verdictDetail.channelMatched).toBeUndefined();
        expect(res.channelDetail?.status).toBe("UNVERIFIED");
        expect(res.verdict).toBe("UNVERIFIED");
        expect(res.acceptance).toBe("BLOCKED");
        expect(res.provenance?.actualChannelId).toBe("CLI_ASSERTED_INPUT (UNVERIFIED_FOR_REAL)");
        expect(res.evidenceCompleteness.availableEvidence).not.toContain("targetChannelFulfilled");
        expect(res.evidenceCompleteness.missingEvidence).toContain("targetChannelFulfilled:UNVERIFIED");
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("静态渠道列表 (SOURCE_STATIC_CONTRACT) 不得将 gatewayChannelConfirmed 置为 true", async () => {
      const staticChannels = [
        { id: 2, name: "RH-国际", group: "panqu_test", models: ["seedance-2.0", "seedance-2.5"], status: 1, weight: 10, dailyQuotaLimit: 0, usedQuota: 0, sourceMode: "SOURCE_STATIC_CONTRACT" as const },
        { id: 54, name: "TD_国际", group: "panqu_test", models: ["seedance-2.0", "seedance-2.5"], status: 1, weight: 10, dailyQuotaLimit: 0, usedQuota: 0, sourceMode: "SOURCE_STATIC_CONTRACT" as const },
      ];

      const res = await verify({
        taskId: 239467,
        modelId: 78,
        mediaType: "video",
        channels: staticChannels,
        terminalStatus: "SUCCESS",
        artifactBuffer: validMp4,
        expectedPoints: 84,
        price: 21,
        duration: 4,
        scoreLogs: [{ task_id: 239467, type: 2, score: -84, memo: "预扣" }],
        extra: { diversion: 10 },
      });

      expect(res.evidenceCompleteness.availableEvidence).not.toContain("gatewayChannelConfirmed");
      expect(res.evidenceCompleteness.missingEvidence).toContain("MANUAL_GATEWAY_CHANNEL_REQUIRED:gatewayChannel");
      expect(res.expectedVsActual?.diffs.some((d) => d.field === "gatewayChannel" && d.status === "MANUAL_REQUIRED")).toBe(true);
    });

    it("SOURCE_REAL_GATEWAY 快照能够满足网关渠道验证，进入 availableEvidence", async () => {
      const realGatewayChannels = [
        { id: 2, name: "RH-国际", group: "panqu_test", models: ["seedance-2.0", "seedance-2.5"], status: 1, weight: 10, dailyQuotaLimit: 0, usedQuota: 0, sourceMode: "SOURCE_REAL_GATEWAY" as const },
      ];

      const res = await verify({
        taskId: 239467,
        modelId: 78,
        mediaType: "video",
        channels: realGatewayChannels,
        terminalStatus: "SUCCESS",
        artifactBuffer: validMp4,
        expectedPoints: 84,
        price: 21,
        duration: 4,
        scoreLogs: [{ task_id: 239467, type: 2, score: -84, memo: "预扣" }],
        extra: { diversion: 10 },
      });

      expect(res.evidenceCompleteness.availableEvidence).toContain("gatewayChannelConfirmed");
      expect(res.evidenceCompleteness.missingEvidence).not.toContain("MANUAL_GATEWAY_CHANNEL_REQUIRED:gatewayChannel");
      expect(res.expectedVsActual?.diffs.some((d) => d.field === "gatewayChannel" && d.status === "PASS")).toBe(true);
    });

    it("getEditData 提示与报告文本统一为 /aivideo/v2/video/getEditData，不留历史残留路径", async () => {
      const res = await verify({
        taskId: 239467,
        modelId: 78,
        mediaType: "video",
        terminalStatus: "SUCCESS",
        artifactBuffer: validMp4,
        expectedPoints: 84,
        price: 21,
        duration: 4,
        scoreLogs: [{ task_id: 239467, type: 2, score: -84, memo: "预扣" }],
      });

      const notice = res.expectedVsActual?.manualVerificationGuide?.notice || "";
      expect(notice).toContain("/aivideo/v2/video/getEditData");
      expect(notice).not.toContain("/aivideo/videonew/getEditData");

      const reasonsText = res.reasons.join("\n");
      expect(reasonsText).toContain("/aivideo/v2/video/getEditData");
      expect(reasonsText).not.toContain("/aivideo/videonew/getEditData");
    });

    it("反证门禁：REAL + gatewayChannelConfirmed=true 但无真实快照且无服务端渠道事实，只有静态 channels 时，gatewayChannelConfirmed 绝不进入 availableEvidence，验收必为 BLOCKED", async () => {
      const staticChannels = [
        { id: 2, name: "RH-国际", group: "panqu_test", models: ["seedance-2.0", "seedance-2.5"], status: 1, weight: 10, dailyQuotaLimit: 0, usedQuota: 0, sourceMode: "SOURCE_STATIC_CONTRACT" as const },
        { id: 54, name: "TD_国际", group: "panqu_test", models: ["seedance-2.0", "seedance-2.5"], status: 1, weight: 10, dailyQuotaLimit: 0, usedQuota: 0, sourceMode: "SOURCE_STATIC_CONTRACT" as const },
      ];

      const fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async (url: any) => {
        const urlStr = String(url);
        if (urlStr.includes("/aivideo/v2/task_status/apiGetStatus")) {
          return new Response(JSON.stringify({ code: 1, data: [{ id: 239467, status: 2, task_status: 2, progress: 100, video_url: "https://example.com/mock.mp4" }] }), { status: 200 });
        }
        if (urlStr.includes("mock.mp4")) {
          return new Response(new Uint8Array(validMp4), { status: 200, headers: { "content-type": "video/mp4" } });
        }
        if (urlStr.includes("/aivideo/diversion/retrylog")) {
          return new Response(JSON.stringify({ total: 0, rows: [] }), { status: 200 });
        }
        if (urlStr.includes("/aivideo/exceptionaltaskdata/index")) {
          return new Response(JSON.stringify({ total: 0, rows: [] }), { status: 200 });
        }
        if (urlStr.includes("/aivideo/v2/video/getEditData")) {
          return new Response(JSON.stringify({ code: 1, data: { extra: JSON.stringify({ diversion: 10 }) } }), { status: 200 });
        }
        return new Response(JSON.stringify({ code: 0 }), { status: 404 });
      });

      try {
        const res = await verify({
          taskId: 239467,
          modelId: 78,
          mediaType: "video",
          channels: staticChannels,
          gatewayChannelConfirmed: true, // 调用者手工传 true
          session: mockSession,          // REAL 模式
          expectedPoints: 84,
          price: 21,
          duration: 4,
          scoreLogs: [{ task_id: 239467, type: 2, score: -84, memo: "预扣" }],
        });

        // 1. 绝不进入 availableEvidence
        expect(res.evidenceCompleteness.availableEvidence).not.toContain("gatewayChannelConfirmed");
        // 2. 必须记录在 missingEvidence
        expect(res.evidenceCompleteness.missingEvidence).toContain("MANUAL_GATEWAY_CHANNEL_REQUIRED:gatewayChannel");
        // 3. 验收必须为 BLOCKED，严禁 ACCEPTED
        expect(res.acceptance).toBe("BLOCKED");
        expect(res.acceptance).not.toBe("ACCEPTED");
        expect(res.acceptanceReport.acceptance).toBe("BLOCKED");
        // 4. 来源与 diff 证据标记为 REJECTED / MANUAL_REQUIRED，不得标记为 SERVER_API
        const gatewayDiff = res.expectedVsActual?.diffs.find((d) => d.field === "gatewayChannel");
        expect(gatewayDiff).toBeDefined();
        expect(gatewayDiff?.status).toBe("MANUAL_REQUIRED");
        expect(gatewayDiff?.evidence).not.toBe("SERVER_API");
        expect(gatewayDiff?.evidence).toBe("USER_ASSERTION_REJECTED");
        expect(res.provenance?.gatewayChannel).toBe("CLI_ASSERTED_INPUT (UNVERIFIED_FOR_REAL)");
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("CLI 契约测试：调用者手工传入 --gateway-channel-confirmed 不能让 REAL 验收 PASS，验收依然为 BLOCKED", async () => {
      const fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async (url: any) => {
        const urlStr = String(url);
        if (urlStr.includes("/aivideo/v2/task_status/apiGetStatus")) {
          return new Response(JSON.stringify({ code: 1, data: [{ id: 239467, status: 2, task_status: 2, progress: 100, video_url: "https://example.com/mock.mp4" }] }), { status: 200 });
        }
        if (urlStr.includes("mock.mp4")) {
          return new Response(new Uint8Array(validMp4), { status: 200, headers: { "content-type": "video/mp4" } });
        }
        if (urlStr.includes("/aivideo/diversion/retrylog") || urlStr.includes("/aivideo/exceptionaltaskdata/index")) {
          return new Response(JSON.stringify({ total: 0, rows: [] }), { status: 200 });
        }
        if (urlStr.includes("/aivideo/v2/video/getEditData")) {
          return new Response(JSON.stringify({ code: 1, data: { extra: JSON.stringify({ diversion: 10 }) } }), { status: 200 });
        }
        return new Response(JSON.stringify({ code: 0 }), { status: 404 });
      });

      const sessionSpy = vi.spyOn(mediaFlow, "loadPanquSession").mockResolvedValue(mockSession);
      const querySpy = vi.spyOn(mediaFlow, "queryTaskBillingLogs").mockResolvedValue({
        scoreLogs: [{ task_id: 239467, type: 2, score: -84 }],
        status: "QUERY_SUCCESS",
        source: "api_query",
        total: 1,
      });

      const logs: string[] = [];
      const consoleSpy = vi.spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));

      try {
        const exitCode = await runDevTestCli([
          "verify",
          "--task", "239467",
          "--model", "78",
          "--media", "video",
          "--session-file", "/dummy/session.json",
          "--gateway-channel-confirmed",
          "--db-extra-confirmed",
          "--price", "21",
          "--duration", "4",
          "--json",
        ]);

        const json = JSON.parse(logs.join(""));
        expect(json.acceptance).toBe("BLOCKED");
        expect(json.acceptance).not.toBe("ACCEPTED");
        expect(json.acceptanceReport.acceptance).toBe("BLOCKED");
        expect(json.evidenceCompleteness.availableEvidence).not.toContain("gatewayChannelConfirmed");
        expect(json.evidenceCompleteness.missingEvidence).toContain("MANUAL_GATEWAY_CHANNEL_REQUIRED:gatewayChannel");
      } finally {
        fetchSpy.mockRestore();
        sessionSpy.mockRestore();
        querySpy.mockRestore();
        consoleSpy.mockRestore();
      }
    });

    it("MCP 契约测试：调用者手工传入 gateway_channel_confirmed: true 不能让 REAL 验收 PASS，验收依然为 BLOCKED", async () => {
      const fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async (url: any) => {
        const urlStr = String(url);
        if (urlStr.includes("/aivideo/v2/task_status/apiGetStatus")) {
          return new Response(JSON.stringify({ code: 1, data: [{ id: 239467, status: 2, task_status: 2, progress: 100, video_url: "https://example.com/mock.mp4" }] }), { status: 200 });
        }
        if (urlStr.includes("mock.mp4")) {
          return new Response(new Uint8Array(validMp4), { status: 200, headers: { "content-type": "video/mp4" } });
        }
        if (urlStr.includes("/aivideo/diversion/retrylog") || urlStr.includes("/aivideo/exceptionaltaskdata/index")) {
          return new Response(JSON.stringify({ total: 0, rows: [] }), { status: 200 });
        }
        if (urlStr.includes("/aivideo/v2/video/getEditData")) {
          return new Response(JSON.stringify({ code: 1, data: { extra: JSON.stringify({ diversion: 10 }) } }), { status: 200 });
        }
        return new Response(JSON.stringify({ code: 0 }), { status: 404 });
      });

      const sessionSpy = vi.spyOn(mediaFlow, "loadPanquSession").mockResolvedValue(mockSession);
      const querySpy = vi.spyOn(mediaFlow, "queryTaskBillingLogs").mockResolvedValue({
        scoreLogs: [{ task_id: 239467, type: 2, score: -84 }],
        status: "QUERY_SUCCESS",
        source: "api_query",
        total: 1,
      });

      try {
        const res = await service.call({
          action: "verify",
          task_id: 239467,
          model_id: 78,
          media_type: "video",
          session_file: "/dummy/session.json",
          gateway_channel_confirmed: true,
          db_extra_confirmed: true,
          price: 21,
          duration: 4,
        });

        expect(res.acceptance).toBe("BLOCKED");
        expect(res.acceptance).not.toBe("ACCEPTED");
        expect(res.summary).toContain("生产验收 <BLOCKED>");
        expect(res.missingInputs).toContain("MANUAL_GATEWAY_CHANNEL_REQUIRED:gatewayChannel");
      } finally {
        fetchSpy.mockRestore();
        sessionSpy.mockRestore();
        querySpy.mockRestore();
      }
    });
  });

  describe("12. SOURCE_REAL_GATEWAY 可信采集路径与快照信封校验门禁", () => {
    const validSnapshotChannels = [
      { id: 2, name: "RH-国际", group: "panqu_test", models: ["seedance-2.0", "seedance-2.5"], status: 1, weight: 10, dailyQuotaLimit: 0, usedQuota: 0, sourceMode: "SOURCE_REAL_GATEWAY" as const },
    ];
    const mockSession = {
      env: "test" as const,
      base_url: "https://test-main.example.com",
      cookies: "PHPSESSID=mock_session_123",
      cookie_string: "PHPSESSID=mock_session_123",
    };
    const validMp4 = createSyntheticValidMp4({ width: 854, height: 480, durationSeconds: 4 });

    let fetchSpy: any;
    beforeEach(() => {
      fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async (url: any) => {
        const urlStr = String(url);
        if (urlStr.includes("/aivideo/v2/task_status/apiGetStatus")) {
          return new Response(JSON.stringify({ code: 1, data: [{ id: 239467, status: 2, task_status: 2, progress: 100, video_url: "https://example.com/mock.mp4" }] }), { status: 200 });
        }
        if (urlStr.includes("mock.mp4")) {
          return new Response(new Uint8Array(validMp4), { status: 200, headers: { "content-type": "video/mp4" } });
        }
        if (urlStr.includes("/aivideo/diversion/retrylog") || urlStr.includes("/aivideo/exceptionaltaskdata/index")) {
          return new Response(JSON.stringify({ total: 0, rows: [] }), { status: 200 });
        }
        if (urlStr.includes("/aivideo/v2/video/getEditData")) {
          return new Response(JSON.stringify({ code: 1, data: { extra: JSON.stringify({ diversion: 10 }) } }), { status: 200 });
        }
        return new Response(JSON.stringify({ code: 0 }), { status: 404 });
      });
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    it("快照校验器: 缺失、采集失败、来源不明、过期快照必须 fail-closed", () => {
      // 1. 缺失快照
      const r1 = validateTrustedGatewaySnapshot(undefined);
      expect(r1.valid).toBe(false);
      expect(r1.reason).toContain("MISSING_SNAPSHOT");

      // 2. 采集失败
      const r2 = validateTrustedGatewaySnapshot({
        environment: "test",
        capturedAt: new Date().toISOString(),
        sourceEndpoint: "/aivideo/channel/index",
        collectionStatus: "FAILED",
        provenance: "API_READONLY_COLLECTOR",
        channels: validSnapshotChannels,
      });
      expect(r2.valid).toBe(false);
      expect(r2.reason).toContain("COLLECTION_FAILED");

      // 3. 来源不明 (非 API_READONLY_COLLECTOR)
      const r3 = validateTrustedGatewaySnapshot({
        environment: "test",
        capturedAt: new Date().toISOString(),
        sourceEndpoint: "/aivideo/channel/index",
        collectionStatus: "SUCCESS",
        provenance: "USER_ASSERTION" as any,
        channels: validSnapshotChannels,
      });
      expect(r3.valid).toBe(false);
      expect(r3.reason).toContain("UNTRUSTED_PROVENANCE");

      // 4. 过期快照 (2小时前)
      const expiredTime = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const r4 = validateTrustedGatewaySnapshot({
        environment: "test",
        capturedAt: expiredTime,
        sourceEndpoint: "/aivideo/channel/index",
        collectionStatus: "SUCCESS",
        provenance: "API_READONLY_COLLECTOR",
        channels: validSnapshotChannels,
      });
      expect(r4.valid).toBe(false);
      expect(r4.reason).toContain("SNAPSHOT_EXPIRED");

      // 5. 合法快照
      const r5 = validateTrustedGatewaySnapshot({
        environment: "test",
        capturedAt: new Date().toISOString(),
        sourceEndpoint: "/aivideo/channel/index",
        collectionStatus: "SUCCESS",
        provenance: "API_READONLY_COLLECTOR",
        channels: validSnapshotChannels,
      });
      expect(r5.valid).toBe(true);
    });

    it("反证测试：REAL 模式下调用者手工在 channels 中传入 sourceMode=SOURCE_REAL_GATEWAY，但无可信采集记录，验收必须为 BLOCKED", async () => {
      const res = await verify({
        taskId: 239467,
        modelId: 78,
        mediaType: "video",
        session: mockSession, // REAL 模式
        channels: [
          { id: 2, name: "RH-国际", group: "panqu_test", models: ["seedance-2.0", "seedance-2.5"], status: 1, weight: 10, dailyQuotaLimit: 0, usedQuota: 0, sourceMode: "SOURCE_REAL_GATEWAY" as const },
        ],
        terminalStatus: "SUCCESS",
        artifactBuffer: validMp4,
        expectedPoints: 84,
        price: 21,
        duration: 4,
        scoreLogs: [{ task_id: 239467, type: 2, score: -84, memo: "预扣" }],
        extra: { diversion: 10 },
      });

      // 1. 绝不计入 availableEvidence
      expect(res.evidenceCompleteness.availableEvidence).not.toContain("gatewayChannelConfirmed");
      // 2. 必须记录在 missingEvidence
      expect(res.evidenceCompleteness.missingEvidence).toContain("MANUAL_GATEWAY_CHANNEL_REQUIRED:gatewayChannel");
      // 3. 验收必须为 BLOCKED，严禁 ACCEPTED
      expect(res.acceptance).toBe("BLOCKED");
      expect(res.acceptance).not.toBe("ACCEPTED");
      // 4. 来源与证据标记为 USER_ASSERTION_REJECTED，diff 包含 BLOCKED_MISSING_TRUSTED_COLLECTOR
      const diff = res.expectedVsActual?.diffs.find((d) => d.field === "gatewayChannel");
      expect(diff).toBeDefined();
      expect(diff?.status).toBe("MANUAL_REQUIRED");
      expect(diff?.evidence).toBe("USER_ASSERTION_REJECTED");
      expect(diff?.diff).toContain("BLOCKED_MISSING_TRUSTED_COLLECTOR");
      expect(res.provenance?.gatewayChannel).toContain("BLOCKED_MISSING_TRUSTED_COLLECTOR");
    });

    it("快照异常 (过期/失败) 在 verify 中导致 REAL 模式 fail-closed 阻断", async () => {
      const expiredSnapshot: TrustedGatewaySnapshot = {
        environment: "test",
        capturedAt: new Date(Date.now() - 7200 * 1000).toISOString(),
        sourceEndpoint: "/aivideo/channel/index",
        collectionStatus: "SUCCESS",
        provenance: "API_READONLY_COLLECTOR",
        channels: validSnapshotChannels,
      };

      const res = await verify({
        taskId: 239467,
        modelId: 78,
        mediaType: "video",
        session: mockSession,
        gatewaySnapshot: expiredSnapshot,
        terminalStatus: "SUCCESS",
        artifactBuffer: validMp4,
        expectedPoints: 84,
        price: 21,
        duration: 4,
        scoreLogs: [{ task_id: 239467, type: 2, score: -84, memo: "预扣" }],
        extra: { diversion: 10 },
      });

      expect(res.acceptance).toBe("BLOCKED");
      expect(res.evidenceCompleteness.availableEvidence).not.toContain("gatewayChannelConfirmed");
      const diff = res.expectedVsActual?.diffs.find((d) => d.field === "gatewayChannel");
      expect(diff?.status).toBe("MANUAL_REQUIRED");
      expect(diff?.evidence).toBe("INVALID_GATEWAY_SNAPSHOT");
      expect(diff?.diff).toContain("SNAPSHOT_EXPIRED");
    });

    it("合法只读快照可信通过验证并进入 availableEvidence", async () => {
      const validSnapshot: TrustedGatewaySnapshot = {
        environment: "test",
        capturedAt: new Date().toISOString(),
        sourceEndpoint: "/aivideo/channel/index",
        collectionStatus: "SUCCESS",
        provenance: "API_READONLY_COLLECTOR",
        channels: validSnapshotChannels,
      };

      const res = await verify({
        taskId: 239467,
        modelId: 78,
        mediaType: "video",
        session: mockSession,
        gatewaySnapshot: validSnapshot,
        terminalStatus: "SUCCESS",
        artifactBuffer: validMp4,
        expectedPoints: 84,
        price: 21,
        duration: 4,
        scoreLogs: [{ task_id: 239467, type: 2, score: -84, memo: "预扣" }],
        extra: { diversion: 10 },
      });

      expect(res.evidenceCompleteness.availableEvidence).toContain("gatewayChannelConfirmed");
      expect(res.evidenceCompleteness.missingEvidence).not.toContain("MANUAL_GATEWAY_CHANNEL_REQUIRED:gatewayChannel");
      const diff = res.expectedVsActual?.diffs.find((d) => d.field === "gatewayChannel");
      expect(diff?.status).toBe("PASS");
      expect(diff?.evidence).toBe("SOURCE_REAL_GATEWAY");
      expect(res.provenance?.gatewayChannel).toBe("API_READONLY_COLLECTOR (/aivideo/channel/index)");
    });
  });
});

