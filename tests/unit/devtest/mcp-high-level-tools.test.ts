import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { DevTestMcpService, DEVTEST_MCP_TOOL } from '../../../src/devtest/mcp-service.js';
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
});
