import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { DevTestMcpService, DEVTEST_MCP_TOOL } from '../../../src/devtest/mcp-service.js';
import { processMcpRequest } from '../../../bin/devtest-mcp.js';
import { createSyntheticValidMp4 } from '../../../src/devtest/media-inspector.js';

describe('DevTest MCP Service - 纯净双模 MCP 服务', () => {
  const service = new DevTestMcpService(path.resolve('.'));

  describe('1. DEVTEST_MCP_TOOL Schema 规范', () => {
    it('仅暴露单个 devtest 工具，支持 probe, plan, execute, verify', () => {
      expect(DEVTEST_MCP_TOOL.name).toBe('devtest');
      const actionProp = DEVTEST_MCP_TOOL.inputSchema.properties.action;
      expect(actionProp.enum).toEqual(['probe', 'plan', 'execute', 'verify']);
    });
  });

  describe('2. MCP Action 路由与执行', () => {
    it('action: probe 返回环境探活结果', async () => {
      const res = await service.call({ action: 'probe', mock: true, env: 'test' });
      expect(res.ok).toBe(true);
      expect(res.action).toBe('probe');
      expect(res.summary).toContain('环境探活回执');
      expect(res.data.env).toBe('test');
    });

    it('action: plan 返回分流推导规划结果', async () => {
      const res = await service.call({
        action: 'plan',
        model_id: 84,
        media_type: 'video',
        resolution: '720p',
        duration: 4,
      });
      expect(res.ok).toBe(true);
      expect(res.action).toBe('plan');
      expect(res.summary).toContain('分流推导回执');
      expect(res.data.modelId).toBe(84);
      expect(res.data.willDivert).toBe(true);
    });

    it('action: execute 返回任务派发回执', async () => {
      const res = await service.call({
        action: 'execute',
        model_id: 84,
        media_type: 'video',
        mode: 'mock',
        prompt: 'test',
      });
      expect(res.ok).toBe(true);
      expect(res.action).toBe('execute');
      expect(res.data.taskId).toBeGreaterThan(0);
      expect(res.data.mode).toBe('mock');
    });

    it('action: verify 返回物理验真与对账回执（无凭据时如实返回 UNVERIFIED）', async () => {
      const res = await service.call({
        action: 'verify',
        task_id: 12345,
        model_id: 84,
        media_type: 'video',
        terminal_status: 'SUCCESS',
      });
      expect(res.ok).toBe(true);
      expect(res.action).toBe('verify');
      expect(res.verdict).toBe('UNVERIFIED');
      expect(typeof res.report).toBe('string');
      expect(res.report).toContain('🔬 DevTest 物理验真与防资损对账明细');
      expect(res.summary).toContain('🔍 验真');
      expect(res.data.passed).toBe(false);
      expect(res.data.status).toBe('UNVERIFIED');
      expect(res.data.billingAudit).toBe('SKIPPED_NO_LOGS');
    });

    it('action: verify 在提供有效二进制 Buffer 与流水时核验通过', async () => {
      const validMp4 = createSyntheticValidMp4({ width: 1280, height: 720, durationSeconds: 4 });
      const res = await service.call({
        action: 'verify',
        task_id: 12345,
        model_id: 84,
        media_type: 'video',
        expected_points: 28,
        terminal_status: 'SUCCESS',
        score_logs: [{ task_id: 12345, type: 2, score: -28 }],
        artifact_buffer: validMp4,
      });
      expect(res.ok).toBe(true);
      expect(res.data.passed).toBe(true);
      expect(res.data.artifact.decodable).toBe(true);
      expect(res.data.invariants.antiDoubleBilling).toBe(true);
    });

    it('未知 action 返回不支持错误', async () => {
      const res = await service.call({ action: 'invalid_action' });
      expect(res.ok).toBe(false);
      expect(res.error).toContain('Unsupported action');
    });
  });

  describe('3. PROCESSING / UNVERIFIED / BLOCKED / FAIL 业务状态与 MCP 协议解耦', () => {
    it('execute(wait=true) 在返回 PROCESSING 时，isError 为 false，passed 为 false，status/verdict 为 PROCESSING', async () => {
      const rpcReq = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'devtest',
          arguments: {
            action: 'execute',
            model_id: 84,
            media_type: 'video',
            mode: 'mock',
            wait: true,
            terminal_status: 'PROCESSING',
          },
        },
      };
      const rpcRes = await processMcpRequest(service, rpcReq);
      expect(rpcRes?.result).toBeDefined();
      const res = rpcRes?.result as any;
      expect(res.isError).toBe(false);
      expect(res.structuredContent.ok).toBe(true);
      expect(res.structuredContent.passed).toBe(false);
      expect(res.structuredContent.status).toBe('PROCESSING');
      expect(res.structuredContent.verdict).toBe('PROCESSING');
      expect(res.structuredContent.acceptance).toBe('BLOCKED');
    });

    it('execute(wait=true) 在返回 UNVERIFIED 时，isError 为 false，passed 为 false，status 为 UNVERIFIED', async () => {
      const rpcReq = {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'devtest',
          arguments: {
            action: 'execute',
            model_id: 84,
            media_type: 'video',
            mode: 'mock',
            wait: true,
          },
        },
      };
      const rpcRes = await processMcpRequest(service, rpcReq);
      const res = rpcRes?.result as any;
      expect(res.isError).toBe(false);
      expect(res.structuredContent.ok).toBe(true);
      expect(res.structuredContent.passed).toBe(false);
      expect(res.structuredContent.status).toBe('UNVERIFIED');
      expect(res.structuredContent.verdict).toBe('UNVERIFIED');
    });

    it('业务 FAIL 时，isError 为 false，passed 为 false，verdict 为 FAIL', async () => {
      const rpcReq = {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'devtest',
          arguments: {
            action: 'execute',
            model_id: 84,
            media_type: 'video',
            mode: 'mock',
            wait: true,
            terminal_status: 'FAILED',
          },
        },
      };
      const rpcRes = await processMcpRequest(service, rpcReq);
      const res = rpcRes?.result as any;
      expect(res.isError).toBe(false);
      expect(res.structuredContent.ok).toBe(true);
      expect(res.structuredContent.passed).toBe(false);
      expect(res.structuredContent.verdict).toBe('FAIL');
    });

    it('execute 缺少 model_id / media_type / mode 时返回 BLOCKED_MISSING_INPUT 及 missingInputs', async () => {
      const rpcReq = {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'devtest',
          arguments: {
            action: 'execute',
          },
        },
      };
      const rpcRes = await processMcpRequest(service, rpcReq);
      const res = rpcRes?.result as any;
      expect(res.isError).toBe(false);
      expect(res.structuredContent.ok).toBe(true);
      expect(res.structuredContent.status).toBe('BLOCKED_MISSING_INPUT');
      expect(res.structuredContent.missingInputs).toEqual(['model_id', 'media_type', 'mode']);
    });

    it('verify 缺少 task_id 时返回 BLOCKED_MISSING_INPUT 及 missingInputs: ["task_id"]', async () => {
      const rpcReq = {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'devtest',
          arguments: {
            action: 'verify',
          },
        },
      };
      const rpcRes = await processMcpRequest(service, rpcReq);
      const res = rpcRes?.result as any;
      expect(res.isError).toBe(false);
      expect(res.structuredContent.ok).toBe(true);
      expect(res.structuredContent.status).toBe('BLOCKED_MISSING_INPUT');
      expect(res.structuredContent.missingInputs).toEqual(['task_id']);
    });

    it('plan 缺少 model_id / media_type 且无法推导时返回 BLOCKED_MISSING_INPUT 及 missingInputs', async () => {
      const rpcReq = {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'devtest',
          arguments: {
            action: 'plan',
          },
        },
      };
      const rpcRes = await processMcpRequest(service, rpcReq);
      const res = rpcRes?.result as any;
      expect(res.isError).toBe(false);
      expect(res.structuredContent.ok).toBe(true);
      expect(res.structuredContent.status).toBe('BLOCKED_MISSING_INPUT');
      expect(res.structuredContent.missingInputs).toEqual(['model_id', 'media_type']);
    });

    it('上下文继承：execute(wait=false) 包含 model_id 与 media_type 指令，verify 正确接收并继承', async () => {
      const execRes = await service.call({
        action: 'execute',
        model_id: 84,
        media_type: 'video',
        mode: 'mock',
        wait: false,
      });
      expect(execRes.ok).toBe(true);
      expect(execRes.summary).toContain('model_id=84');
      expect(execRes.summary).toContain("media_type='video'");
      expect(execRes.data.taskId).toBeGreaterThan(0);

      const verifyRes = await service.call({
        action: 'verify',
        task_id: execRes.data.taskId,
        model_id: execRes.data.modelId,
        media_type: execRes.data.mediaType,
      });
      expect(verifyRes.ok).toBe(true);
      expect(verifyRes.data.taskId).toBe(execRes.data.taskId);
      expect(verifyRes.data.modelId).toBe(84);
      expect(verifyRes.data.mediaType).toBe('video');
    });

    it('真实执行会话门禁：无 session 情况下调用 mode="real"，返回 BLOCKED 状态，isError 为 false', async () => {
      const rpcReq = {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: {
          name: 'devtest',
          arguments: {
            action: 'execute',
            model_id: 84,
            media_type: 'video',
            mode: 'real',
            session_file: '/non/existent/session.json',
          },
        },
      };
      const rpcRes = await processMcpRequest(service, rpcReq);
      const res = rpcRes?.result as any;
      expect(res.isError).toBe(false);
      expect(res.structuredContent.ok).toBe(true);
      expect(res.structuredContent.status).toBe('BLOCKED');
      expect(res.structuredContent.verdict).toBe('BLOCKED');
      expect(res.structuredContent.acceptance).toBe('BLOCKED');
    });

    it('probe BLOCKED 时，isError 为 false，passed 为 false，status/verdict/acceptance 均为 BLOCKED', async () => {
      const probeSpy = vi.spyOn(
        await import('../../../src/devtest/core-kernel.js'),
        'probe'
      ).mockResolvedValueOnce({
        ok: false,
        status: 'BLOCKED',
        env: 'test',
        baseUrl: 'https://test.panqu.com',
        gatewayUrl: 'https://gateway.panqu.com',
        probedAt: new Date().toISOString(),
        auth: { status: 'MISSING', details: '缺少会话凭据', hasSession: false },
        endpoints: [],
        candidateChannelCount: 0,
        recommendations: ['请配置合法 session'],
      });

      const rpcReq = {
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: {
          name: 'devtest',
          arguments: {
            action: 'probe',
            env: 'test',
          },
        },
      };
      const rpcRes = await processMcpRequest(service, rpcReq);
      probeSpy.mockRestore();

      expect(rpcRes?.result).toBeDefined();
      const res = rpcRes?.result as any;
      expect(res.isError).toBe(false);
      expect(res.structuredContent.ok).toBe(true);
      expect(res.structuredContent.passed).toBe(false);
      expect(res.structuredContent.status).toBe('BLOCKED');
      expect(res.structuredContent.verdict).toBe('BLOCKED');
      expect(res.structuredContent.acceptance).toBe('BLOCKED');
    });

    it('缺少 action 时不得默认 probe，必须返回协议/参数错误且 isError=true', async () => {
      const probeSpy = vi.spyOn(
        await import('../../../src/devtest/core-kernel.js'),
        'probe'
      );

      // 1. Direct service.call without action
      const directRes = await service.call({});
      expect(directRes.ok).toBe(false);
      expect(directRes.isError).toBe(true);
      expect(directRes.error).toContain('Missing required argument "action"');

      // 2. MCP JSON-RPC call without action
      const rpcReq = {
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: {
          name: 'devtest',
          arguments: {},
        },
      };
      const rpcRes = await processMcpRequest(service, rpcReq);
      const res = rpcRes?.result as any;
      expect(res.isError).toBe(true);
      expect(res.structuredContent.ok).toBe(false);
      expect(res.structuredContent.error).toContain('Missing required argument "action"');

      // 3. Ensure probe was NEVER called
      expect(probeSpy).not.toHaveBeenCalled();
      probeSpy.mockRestore();
    });

    it('execute(wait=false) SUBMITTED 时 ok=true、isError=false、passed=false、status=SUBMITTED (明确断言 SUBMITTED !== PASS)', async () => {
      const rpcReq = {
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: {
          name: 'devtest',
          arguments: {
            action: 'execute',
            model_id: 84,
            media_type: 'video',
            mode: 'mock',
            wait: false,
          },
        },
      };
      const rpcRes = await processMcpRequest(service, rpcReq);
      const res = rpcRes?.result as any;
      expect(res.isError).toBe(false);
      expect(res.structuredContent.ok).toBe(true);
      expect(res.structuredContent.passed).toBe(false);
      expect(res.structuredContent.status).toBe('SUBMITTED');
      expect(res.structuredContent.verdict).toBe('SUBMITTED');
      expect(res.structuredContent.acceptance).toBe('IN_FLIGHT');
      // 明确断言 SUBMITTED !== PASS
      expect(res.structuredContent.passed).not.toBe(true);
    });

    it('未知 action 时 isError 为 true，ok 为 false', async () => {
      const rpcReq = {
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: {
          name: 'devtest',
          arguments: {
            action: 'unknown_action',
          },
        },
      };
      const rpcRes = await processMcpRequest(service, rpcReq);
      const res = rpcRes?.result as any;
      expect(res.isError).toBe(true);
      expect(res.structuredContent.ok).toBe(false);
      expect(res.structuredContent.error).toContain('Unsupported action "unknown_action"');
    });
  });
});
