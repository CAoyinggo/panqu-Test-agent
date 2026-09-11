import { describe, expect, it } from 'vitest';
import {
  TestDataLifecycleManager,
  type TestDataScope,
} from '../../../src/devtest/test-data-lifecycle.js';

describe('TestDataLifecycleManager', () => {
  const defaultScope: TestDataScope = {
    runId: 'run-test-001',
    owner: 'tester-alice',
    tenantId: 'tenant-a',
    projectId: 'proj-100',
    resource: 'DATABASE',
    environment: 'STAGING',
  };

  describe('setup 准备阶段', () => {
    it('无 initializer 时标记 NOT_REQUIRED', async () => {
      const manager = new TestDataLifecycleManager(defaultScope);
      await manager.setup();

      const snap = manager.snapshot();
      expect(snap.prepareStatus).toBe('NOT_REQUIRED');
    });

    it('初始化函数成功执行后标记 READY', async () => {
      const manager = new TestDataLifecycleManager(defaultScope);
      let executed = false;
      await manager.setup(async () => {
        executed = true;
      });

      expect(executed).toBe(true);
      const snap = manager.snapshot();
      expect(snap.prepareStatus).toBe('READY');
      expect(snap.createdBy).toBe('DEVTEST');
    });

    it('初始化函数抛出异常时标记 FAILED 并记录错误', async () => {
      const manager = new TestDataLifecycleManager(defaultScope);
      await expect(
        manager.setup(() => {
          throw new Error('Connection refused');
        })
      ).rejects.toThrow('TEST_DATA_SETUP_FAILED');

      const snap = manager.snapshot();
      expect(snap.prepareStatus).toBe('FAILED');
      expect(snap.cleanupIssues).toBeDefined();
      expect(snap.cleanupIssues![0]).toContain('SETUP_FAILED: Connection refused');
    });
  });

  describe('trackEntity 实体追踪与隔离性检查', () => {
    it('能够正确追踪创建的 Task 和 Asset 实体', () => {
      const manager = new TestDataLifecycleManager(defaultScope);
      manager.trackEntity('TASK', 'task_101');
      manager.trackEntity('ASSET', 'asset_202');

      const snap = manager.snapshot();
      expect(snap.entitiesCreated).toHaveLength(2);
      expect(snap.entitiesCreated).toEqual([
        { type: 'TASK', id: 'task_101', runId: 'run-test-001' },
        { type: 'ASSET', id: 'asset_202', runId: 'run-test-001' },
      ]);
    });

    it('在安全隔离范围内时 verifyIsolation 返回 true', () => {
      const manager = new TestDataLifecycleManager(defaultScope);
      manager.trackEntity('TASK', 'task_101');

      const isolated = manager.verifyIsolation(['tenant-other'], ['proj-other']);
      expect(isolated).toBe(true);
    });

    it('检测到跨租户/跨项目越权时 verifyIsolation 返回 false 并在 cleanupIssues 记入告警', () => {
      const manager = new TestDataLifecycleManager({
        ...defaultScope,
        tenantId: 'tenant-forbidden',
      });
      manager.trackEntity('TASK', 'task_breached');

      const isolated = manager.verifyIsolation(['tenant-forbidden'], []);
      expect(isolated).toBe(false);

      const snap = manager.snapshot();
      expect(snap.cleanupIssues).toBeDefined();
      expect(snap.cleanupIssues![0]).toContain('DATA_ISOLATION_BREACH');
    });
  });

  describe('cleanup 清理与审计', () => {
    it('无实体且无清理钩子时返回 NOT_REQUIRED 且无问题', async () => {
      const manager = new TestDataLifecycleManager(defaultScope);
      const result = await manager.cleanup();

      expect(result.record.cleanupStatus).toBe('NOT_REQUIRED');
      expect(result.problems).toHaveLength(0);
    });

    it('清理钩子全部成功执行时标记 CLEANED', async () => {
      const manager = new TestDataLifecycleManager(defaultScope);
      manager.trackEntity('TASK', 'task_101');
      let cleaned = false;
      manager.registerCleanup('cancelTask', async () => {
        cleaned = true;
      });

      const result = await manager.cleanup();

      expect(cleaned).toBe(true);
      expect(result.record.cleanupStatus).toBe('CLEANED');
      expect(result.problems).toHaveLength(0);
    });

    it('清理钩子失败时绝不静默忽略，必须标记 FAILED 并生成结构化 Problem', async () => {
      const manager = new TestDataLifecycleManager(defaultScope);
      manager.trackEntity('TASK', 'task_orphan');
      manager.registerCleanup('deleteStorageFile', () => {
        throw new Error('S3 Access Denied');
      });

      const result = await manager.cleanup();

      expect(result.record.cleanupStatus).toBe('FAILED');
      expect(result.record.cleanupIssues).toBeDefined();
      expect(result.record.cleanupIssues![0]).toContain('CLEANUP_HANDLER_FAILED [deleteStorageFile]: S3 Access Denied');

      expect(result.problems).toHaveLength(1);
      const problem = result.problems[0];
      expect(problem.type).toBe('DATA_PREP_FAILED');
      expect(problem.severity).toBe('HIGH');
      expect(problem.reasonCode).toBe('CLEANUP_FAILED');
      expect(problem.message).toContain('deleteStorageFile');
      expect(problem.judgement).toBe('CONFIRMED_BUG');
    });
  });
});
