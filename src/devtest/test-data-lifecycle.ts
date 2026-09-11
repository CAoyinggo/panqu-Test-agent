/**
 * 测试数据生命周期管理与审计（Test Data Lifecycle Manager）
 *
 * 规范完整闭环：setup → execute → verify → cleanup
 * 1. 明确测试数据归属（owner, tenantId, projectId, runId）
 * 2. 隔离性保护（任务隔离、资产隔离、账单隔离）
 * 3. 清理策略（软删、取消、释放配额）
 * 4. 严格错误上报：清理失败必须记录进 Evidence 与 Problem，严禁静默忽略
 */

import type {
  DevTestDataLifecycleRecord,
  DevTestProblem,
  DevTestProblemSeverity,
} from './types.js';

export interface TestDataScope {
  runId: string;
  owner?: string;
  tenantId?: string;
  projectId?: string | number;
  userId?: string | number;
  resource?: string;
  environment?: string;
}

export interface ManagedEntity {
  type: 'TASK' | 'ASSET' | 'PROJECT' | 'USER' | 'QUOTA' | 'FILE';
  id: string | number;
  scope: TestDataScope;
  createdAt: string;
  cleanedUp?: boolean;
  cleanupError?: string;
}

export interface CleanupHandler {
  name: string;
  execute: () => Promise<void> | void;
}

export class TestDataLifecycleManager {
  private scope: TestDataScope;
  private entities: ManagedEntity[] = [];
  private cleanupHandlers: CleanupHandler[] = [];
  private prepareStatus: DevTestDataLifecycleRecord['prepareStatus'] = 'NOT_REQUIRED';
  private cleanupStatus: DevTestDataLifecycleRecord['cleanupStatus'] = 'NOT_REQUIRED';
  private cleanupIssues: string[] = [];

  constructor(scope: TestDataScope) {
    this.scope = scope;
  }

  /**
   * 1. SETUP: 预置测试环境、身份与配额
   */
  async setup(initializer?: () => Promise<void> | void): Promise<void> {
    if (!initializer) {
      this.prepareStatus = 'NOT_REQUIRED';
      return;
    }
    try {
      await initializer();
      this.prepareStatus = 'READY';
    } catch (err) {
      this.prepareStatus = 'FAILED';
      const msg = (err as Error).message || String(err);
      this.cleanupIssues.push(`SETUP_FAILED: ${msg}`);
      throw new Error(`TEST_DATA_SETUP_FAILED: ${msg}`);
    }
  }

  /**
   * 2. EXECUTE: 登记执行过程中创建的业务实体
   */
  trackEntity(type: ManagedEntity['type'], id: string | number): void {
    this.entities.push({
      type,
      id,
      scope: { ...this.scope },
      createdAt: new Date().toISOString(),
      cleanedUp: false,
    });
  }

  /**
   * 注册清理钩子
   */
  registerCleanup(name: string, handler: () => Promise<void> | void): void {
    this.cleanupHandlers.push({ name, execute: handler });
  }

  /**
   * 3. VERIFY: 检查数据隔离性
   */
  verifyIsolation(otherTenants: string[] = [], otherProjects: (string | number)[] = []): boolean {
    // 检查是否存在跨租户/跨项目泄露
    const leakedTenants = this.entities.filter((e) =>
      e.scope.tenantId && otherTenants.includes(e.scope.tenantId)
    );
    const leakedProjects = this.entities.filter((e) =>
      e.scope.projectId && otherProjects.includes(e.scope.projectId)
    );

    if (leakedTenants.length > 0 || leakedProjects.length > 0) {
      const issue = `DATA_ISOLATION_BREACH: 检测到实体跨隔离域泄露 (tenants=${leakedTenants.length}, projects=${leakedProjects.length})`;
      this.cleanupIssues.push(issue);
      return false;
    }
    return true;
  }

  /**
   * 4. CLEANUP: 执行清理，清理失败产生结构化 Problem
   */
  async cleanup(): Promise<{
    record: DevTestDataLifecycleRecord;
    problems: DevTestProblem[];
  }> {
    const problems: DevTestProblem[] = [];

    if (this.cleanupHandlers.length === 0 && this.entities.length === 0) {
      this.cleanupStatus = 'NOT_REQUIRED';
      return {
        record: this.snapshot(),
        problems: [],
      };
    }

    let hasFailure = false;
    for (const handler of this.cleanupHandlers) {
      try {
        await handler.execute();
      } catch (err) {
        hasFailure = true;
        const msg = (err as Error).message || String(err);
        const errorDesc = `CLEANUP_HANDLER_FAILED [${handler.name}]: ${msg}`;
        this.cleanupIssues.push(errorDesc);

        problems.push({
          id: 'P_CLEANUP_001',
          type: 'DATA_PREP_FAILED',
          severity: 'HIGH' as DevTestProblemSeverity,
          dimension: 'EXECUTION',
          message: errorDesc,
          reasonCode: 'CLEANUP_FAILED',
          category: 'Environment Block',
          affectedCases: [],
          rootCause: `CLEANUP:${handler.name}`,
          failureClass: 'TEST_ISSUE',
          judgement: 'CONFIRMED_BUG',
          reproducible: true,
          evidence: { handler: handler.name, error: msg },
          remediation: '检查测试资源销毁接口或清理权限，确保临时产生的测试数据完全回滚或软删。',
        });
      }
    }

    // 标记已清理实体
    for (const entity of this.entities) {
      if (!hasFailure) {
        entity.cleanedUp = true;
      }
    }

    this.cleanupStatus = hasFailure ? 'FAILED' : 'CLEANED';

    return {
      record: this.snapshot(),
      problems,
    };
  }

  /**
   * 导出生命周期快照记录
   */
  snapshot(): DevTestDataLifecycleRecord {
    return {
      runId: this.scope.runId,
      owner: this.scope.owner,
      tenant: this.scope.tenantId,
      project: this.scope.projectId !== undefined ? String(this.scope.projectId) : undefined,
      resource: this.scope.resource,
      createdBy: this.prepareStatus === 'READY' ? 'DEVTEST' : 'EXISTING_FIXTURE',
      prepareStatus: this.prepareStatus,
      cleanupStatus: this.cleanupStatus,
      traceable: Boolean(this.scope.projectId && this.scope.runId),
      cleanupIssues: this.cleanupIssues.length > 0 ? [...this.cleanupIssues] : undefined,
      entitiesCreated: this.entities.map((e) => ({ type: e.type, id: e.id, runId: e.scope.runId })),
      isolatedProjects: this.scope.projectId !== undefined ? [String(this.scope.projectId)] : undefined,
      isolatedTenants: this.scope.tenantId !== undefined ? [this.scope.tenantId] : undefined,
    };
  }
}
