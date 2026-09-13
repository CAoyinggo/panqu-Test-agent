/**
  * 可执行 DAG 步骤规划器（Execution Planner）
  *
  * 将业务测试场景（Scenario）转换为具备明确数据流依赖（Step Dependency）
  * 的有向无环图（DAG），消除固定硬编码与步骤孤岛。
  *
  * 关键约束：
  * 1. 严格主键透传（submit.output.taskId -> poll/routing/billing.input.taskId）
  * 2. 严格产物透传（poll.output.assetUrl -> media.input.assetUrl）
  * 3. 严禁 Planner 自行伪造或随机生成 taskId
  */

import type {
  DevTestExecutableStep,
  DevTestExecutionDag,
  DevTestScenario,
} from './types.js';

export class ExecutionPlanner {
  /**
   * 将一组测试场景转换为可执行 DAG
   */
  static planDags(scenarios: DevTestScenario[]): DevTestExecutionDag[] {
    return scenarios.map((scenario) => this.planDagForScenario(scenario));
  }

  /**
   * 为单个场景规划步骤依赖 DAG
   */
  static planDagForScenario(scenario: DevTestScenario): DevTestExecutionDag {
    const steps: DevTestExecutableStep[] = [];
    const prefix = scenario.id;

    // 步骤 1: 准备测试身份与凭据
    const stepPrepareId: DevTestExecutableStep = {
      id: `${prefix}_STEP_PREPARE_IDENTITY`,
      name: '准备测试账号会话与安全凭证',
      operation: 'AUTH_PREPARE',
      dependsOn: [],
      inputFrom: [],
      output: ['sessionCookie', 'csrfToken', 'userId'],
      requiredEvidence: ['SESSION_COOKIE_VALID', 'CSRF_TOKEN_ACQUIRED'],
      oracle: 'EnvironmentPreflight',
      failurePolicy: 'ABORT',
    };
    steps.push(stepPrepareId);

    // 步骤 2: 准备项目上下文与生命周期追踪
    const stepPrepareProj: DevTestExecutableStep = {
      id: `${prefix}_STEP_PREPARE_PROJECT`,
      name: '初始化测试项目上下文与数据隔离域',
      operation: 'PROJECT_PREPARE',
      dependsOn: [stepPrepareId.id],
      inputFrom: [
        { fromStepId: stepPrepareId.id, fromField: 'sessionCookie', toField: 'sessionCookie' },
      ],
      output: ['projectId', 'runId'],
      requiredEvidence: ['PROJECT_INITIALIZED'],
      oracle: 'TestDataLifecycleManager',
      failurePolicy: 'ABORT',
    };
    steps.push(stepPrepareProj);

    // 步骤 3: 提交生成任务
    const isImage = scenario.name.includes('生图') || scenario.name.includes('IMAGE');
    const submitOperation = isImage ? 'POST /aivideo/scene/add' : 'POST /aivideo/videonew/add';
    const stepSubmit: DevTestExecutableStep = {
      id: `${prefix}_STEP_SUBMIT_TASK`,
      name: `向主站提交${isImage ? '生图' : '视频生成'}任务`,
      operation: submitOperation,
      dependsOn: [stepPrepareProj.id],
      inputFrom: [
        { fromStepId: stepPrepareId.id, fromField: 'sessionCookie', toField: 'sessionCookie' },
        { fromStepId: stepPrepareId.id, fromField: 'csrfToken', toField: 'csrfToken' },
        { fromStepId: stepPrepareProj.id, fromField: 'projectId', toField: 'projectId' },
      ],
      output: ['taskId', 'clientToken', 'submitTimestamp'],
      requiredEvidence: ['HTTP_200_RESPONSE', 'TASK_ID_CAPTURED'],
      oracle: 'ApiProcessor',
      failurePolicy: scenario.kind === 'INVALID_INPUT_BOUNDARY' ? 'BRANCH' : 'ABORT',
    };

    if (scenario.kind === 'DIVERSION_FALLBACK_DIRECT') {
      stepSubmit.name = `提交不满足分流资格的${isImage ? '生图' : '视频'}任务（测试降级回退）`;
      stepSubmit.requiredEvidence = ['HTTP_200_RESPONSE', 'TASK_ID_CAPTURED', 'EXTRA_DIVERSION_NOT_NEWAPI'];
    } else if (scenario.kind === 'INVALID_INPUT_BOUNDARY') {
      stepSubmit.name = `提交非法规格参数${isImage ? '生图' : '视频'}任务（验证前置拦截）`;
      stepSubmit.requiredEvidence = ['CLIENT_VALIDATION_ERROR', 'NO_CHARGE_INCURRED'];
    }

    steps.push(stepSubmit);

    if (scenario.kind === 'DIRECT_SPEC_MATRIX') {
      // 新模型全规格矩阵校验步骤
      const stepSpecMatrix: DevTestExecutableStep = {
        id: `${prefix}_STEP_SPEC_MATRIX_VALIDATION`,
        name: '遍历测试新模型全规格矩阵参数（分辨率/画幅/时长）上游兼容性',
        operation: 'SPEC_VALIDATION',
        dependsOn: [stepSubmit.id],
        inputFrom: [
          { fromStepId: stepSubmit.id, fromField: 'taskId', toField: 'sampleTaskId' },
        ],
        output: ['matrixResults', 'specsAccepted'],
        requiredEvidence: ['SPEC_PARAMS_NORMALIZED', 'HTTP_200_RESPONSE'],
        oracle: 'TestOracle',
        failurePolicy: 'CONTINUE',
      };
      steps.push(stepSpecMatrix);
    }

    if (scenario.kind === 'RETRY_IDEMPOTENCY') {
      // 幂等去重场景：重发同一任务
      const stepReSubmit: DevTestExecutableStep = {
        id: `${prefix}_STEP_RESUBMIT_IDEMPOTENCY`,
        name: '携带相同 clientToken 模拟网络抖动重发任务',
        operation: submitOperation,
        dependsOn: [stepSubmit.id],
        inputFrom: [
          { fromStepId: stepSubmit.id, fromField: 'clientToken', toField: 'clientToken' },
          { fromStepId: stepPrepareProj.id, fromField: 'projectId', toField: 'projectId' },
        ],
        output: ['reSubmitTaskId'],
        requiredEvidence: ['SAME_TASK_ID_RETURNED_OR_BLOCKED'],
        oracle: 'IdempotencyOracle',
        failurePolicy: 'CONTINUE',
      };
      steps.push(stepReSubmit);
    }

    // 步骤 4: 轮询任务状态
    const expectFailure = scenario.kind === 'FAILURE_REFUND';
    const stepPoll: DevTestExecutableStep = {
      id: `${prefix}_STEP_POLL_STATUS`,
      name: `轮询任务至终态（预期：${expectFailure ? 'FAILED' : 'SUCCESS'}）`,
      operation: 'POST /aivideo/v2/task_status/apiGetStatus',
      dependsOn: [stepSubmit.id],
      inputFrom: [
        { fromStepId: stepSubmit.id, fromField: 'taskId', toField: 'taskId' },
        { fromStepId: stepPrepareId.id, fromField: 'sessionCookie', toField: 'sessionCookie' },
      ],
      output: ['terminalStatus', 'assetUrl', 'pollDurationMs'],
      requiredEvidence: [expectFailure ? 'TASK_STATUS_FAILED' : 'TASK_STATUS_SUCCESS'],
      oracle: 'TestOracle',
      failurePolicy: 'BRANCH',
    };
    steps.push(stepPoll);

    // 步骤 5: 验真路由分流快照
    const stepRouting: DevTestExecutableStep = {
      id: `${prefix}_STEP_INSPECT_ROUTING`,
      name: scenario.kind === 'DIVERSION_FALLBACK_DIRECT'
        ? '核验任务未命中 NewAPI 分流且安全回退至原直连链路快照'
        : '核验主站 Extra 字段中的 NewAPI 分流标记与渠道快照',
      operation: isImage ? 'GET /aivideo/scene/index' : 'GET /aivideo/videonew/index',
      dependsOn: [stepSubmit.id],
      inputFrom: [
        { fromStepId: stepSubmit.id, fromField: 'taskId', toField: 'taskId' },
        { fromStepId: stepPrepareProj.id, fromField: 'projectId', toField: 'projectId' },
      ],
      output: ['diversionLine', 'newapiModel', 'routeGroupId'],
      requiredEvidence: scenario.kind === 'DIVERSION_FALLBACK_DIRECT'
        ? ['EXTRA_DIVERSION_NOT_NEWAPI', 'TASK_FALLBACK_SUCCESS']
        : scenario.kind === 'PERMISSION_ISOLATION'
          ? ['ORG_BINDING_VERIFIED', 'CROSS_ORG_ACCESS_DENIED']
          : ['ROUTING_SNAPSHOT_CAPTURED', 'DIVERSION_RULE_VERIFIED'],
      oracle: 'RoutingOracle',
      failurePolicy: 'CONTINUE',
    };
    steps.push(stepRouting);

    // 步骤 6: 账务与对账核验
    const stepBilling: DevTestExecutableStep = {
      id: `${prefix}_STEP_INSPECT_BILLING`,
      name: '从账单中心提取扣费/退款对账流水并核销净扣额',
      operation: 'GET /billing/personal?section=records',
      dependsOn: [stepSubmit.id, stepPoll.id],
      inputFrom: [
        { fromStepId: stepSubmit.id, fromField: 'taskId', toField: 'taskId' },
        { fromStepId: stepPrepareId.id, fromField: 'sessionCookie', toField: 'sessionCookie' },
      ],
      output: ['billingEntries', 'pointsCharged', 'pointsRefunded', 'netPoints'],
      requiredEvidence: ['BILLING_LOGS_RETRIEVED', 'POINTS_RECONCILED'],
      oracle: 'BillingOracle',
      failurePolicy: 'CONTINUE',
    };
    steps.push(stepBilling);

    // 步骤 7: 介质物理容器与元数据校验（仅针对成功产物）
    if (!expectFailure) {
      const stepMedia: DevTestExecutableStep = {
        id: `${prefix}_STEP_INSPECT_MEDIA`,
        name: `下载生成的${isImage ? '图片' : '视频'}文件并校验二进制容器与元数据`,
        operation: 'MEDIA_INSPECT',
        dependsOn: [stepPoll.id],
        inputFrom: [
          { fromStepId: stepPoll.id, fromField: 'assetUrl', toField: 'assetUrl' },
        ],
        output: ['mediaContainerValid', 'mediaMetadata'],
        requiredEvidence: isImage ? ['PNG_IHDR_OR_JPEG_SOF0'] : ['MP4_ISO_BMFF_BOX_TREE'],
        oracle: 'MediaInspector',
        failurePolicy: 'CONTINUE',
      };
      steps.push(stepMedia);
    }

    // 步骤 8: 跨步骤一致性审计
    const stepAudit: DevTestExecutableStep = {
      id: `${prefix}_STEP_CROSS_STEP_AUDIT`,
      name: '跨步骤 task_id, project_id, user_id, asset_url 强一致性与因果时序审计',
      operation: 'CROSS_STEP_AUDIT',
      dependsOn: [stepSubmit.id, stepPoll.id, stepRouting.id, stepBilling.id],
      inputFrom: [
        { fromStepId: stepSubmit.id, fromField: 'taskId', toField: 'submitTaskId' },
        { fromStepId: stepPrepareProj.id, fromField: 'projectId', toField: 'submitProjectId' },
        { fromStepId: stepPoll.id, fromField: 'assetUrl', toField: 'pollAssetUrl' },
      ],
      output: ['crossStepAuditPassed', 'causalChain'],
      requiredEvidence: ['PRIMARY_KEYS_MATCHED', 'TIMELINE_CAUSALITY_VALID'],
      oracle: 'CrossStepAudit',
      failurePolicy: 'CONTINUE',
    };
    steps.push(stepAudit);

    // 步骤 9: 测试数据安全清理
    const stepCleanup: DevTestExecutableStep = {
      id: `${prefix}_STEP_CLEANUP`,
      name: '释放临时测试任务数据，严防测试数据污染',
      operation: 'CLEANUP_LIFECYCLE',
      dependsOn: [stepAudit.id],
      inputFrom: [
        { fromStepId: stepSubmit.id, fromField: 'taskId', toField: 'taskId' },
        { fromStepId: stepPrepareProj.id, fromField: 'projectId', toField: 'projectId' },
      ],
      output: ['cleanupStatus'],
      requiredEvidence: ['ENTITIES_CLEANED_UP'],
      oracle: 'TestDataLifecycleManager',
      failurePolicy: 'CONTINUE',
    };
    steps.push(stepCleanup);

    return {
      scenarioId: scenario.id,
      steps,
      entryStepId: stepPrepareId.id,
      terminalStepId: stepCleanup.id,
    };
  }
}
