/**
 * Panqu AI DevTest — Absorbed Capabilities Maturity Audit
 *
 * 真实成熟度四级模型 (Strict 4-Level Maturity Model):
 * - IMPLEMENTED: 已有真实输入输出和测试 (可在本代码库零依赖离线执行并验证)
 * - CONTRACT_ONLY: 只有接口/协议 (定义了数据结构与契约，但未连接真实服务或未实现具体执行器)
 * - BLOCKED_DATA_MISSING: 缺真实数据 (核心评测逻辑已就绪，但缺少外部被测样本或独立黄金预期)
 * - DEFERRED_EXTERNAL_RUNTIME: 必须依赖外部运行时 (不自制 CDP 浏览器框架或视觉大模型，真实执行依外部基础设施演进)
 *
 * 交付范围独立维度 (Delivery Scope - Orthogonal Dimension):
 * - IN_ZERO_DEPENDENCY_SCOPE: 属于零依赖交付范围
 * - NOT_IN_ZERO_DEPENDENCY_SCOPE: 不在零依赖交付范围 (可选外部运行时依赖)
 */

export type CapabilityMaturityLevel =
  | 'IMPLEMENTED'
  | 'CONTRACT_ONLY'
  | 'BLOCKED_DATA_MISSING'
  | 'DEFERRED_EXTERNAL_RUNTIME';

export const CAPABILITY_MATURITY_LEVELS: readonly CapabilityMaturityLevel[] = Object.freeze([
  'IMPLEMENTED',
  'CONTRACT_ONLY',
  'BLOCKED_DATA_MISSING',
  'DEFERRED_EXTERNAL_RUNTIME',
] as const);

export type DeliveryScope = 'IN_ZERO_DEPENDENCY_SCOPE' | 'NOT_IN_ZERO_DEPENDENCY_SCOPE';

export interface AbsorbedCapabilityAudit {
  readonly capabilityName: 'Playwright' | 'Midscene' | 'Promptfoo' | 'ReportPortal' | 'wardenIQ';
  readonly maturity: CapabilityMaturityLevel;
  readonly scope: DeliveryScope;
  readonly whatWeHave: string; // 实际拥有了什么
  readonly whatWeDoNotHave: string; // 没有什么 (禁止夸大)
  readonly runtimeDependencyStatus: string;
}

export const ABSORBED_CAPABILITIES_AUDIT: readonly AbsorbedCapabilityAudit[] = Object.freeze([
  {
    capabilityName: 'Playwright',
    maturity: 'DEFERRED_EXTERNAL_RUNTIME',
    scope: 'NOT_IN_ZERO_DEPENDENCY_SCOPE',
    whatWeHave: 'DOM/Network/Screenshot 证据信封规范、确定性时间戳/证据ID契约、只读与预算门禁、PNG二进制尺寸解析',
    whatWeDoNotHave: '真实浏览器启动与控制、CDP 连接、真实的页面导航与交互执行器（不自制 CDP 框架，NOT_IN_ZERO_DEPENDENCY_SCOPE）',
    runtimeDependencyStatus: '未安装 playwright，依赖外部独立浏览器运行时，不在零依赖交付范围，禁止写为已接入',
  },
  {
    capabilityName: 'Midscene',
    maturity: 'DEFERRED_EXTERNAL_RUNTIME',
    scope: 'NOT_IN_ZERO_DEPENDENCY_SCOPE',
    whatWeHave: 'AI_OBSERVATION 证据信封契约、绝对不变量门禁（AI 不能单独放行 PASS、不可覆盖确定性失败）',
    whatWeDoNotHave: '真实多模态视觉大模型推理引擎、真实 UI 界面元素视觉定位执行器（NOT_IN_ZERO_DEPENDENCY_SCOPE）',
    runtimeDependencyStatus: '未安装 @midscene/web，依赖外部视觉大模型运行时，不在零依赖交付范围，禁止写为已接入',
  },
  {
    capabilityName: 'Promptfoo',
    maturity: 'BLOCKED_DATA_MISSING',
    scope: 'IN_ZERO_DEPENDENCY_SCOPE',
    whatWeHave: '工具无关的纯函数 Agent 评测引擎、八类核心漏洞代码检测、独立黄金预期比对逻辑、样本导入契约',
    whatWeDoNotHave: '被测智能体真实回答样本库（缺真实数据时严格返回 BLOCKED_DATA_MISSING，零虚假指标）',
    runtimeDependencyStatus: '零外部依赖，纯函数已就绪，但生产运行受限于真实样本供给',
  },
  {
    capabilityName: 'ReportPortal',
    maturity: 'IMPLEMENTED',
    scope: 'IN_ZERO_DEPENDENCY_SCOPE',
    whatWeHave: '标准 ExportableVerdictRecord 递归深冻结纯映射、ResultSink 最小只写不读端口、本地 NDJSON 单向结果追加导出器',
    whatWeDoNotHave: 'ReportPortal 远程服务客户端、网络上报协议栈、双向状态同步与回写能力（只写不读，禁止回写）',
    runtimeDependencyStatus: '零外部依赖，本地 NDJSON 单向导出完全可用，远程上报保持 CONTRACT_ONLY',
  },
  {
    capabilityName: 'wardenIQ',
    maturity: 'BLOCKED_DATA_MISSING',
    scope: 'IN_ZERO_DEPENDENCY_SCOPE',
    whatWeHave: '真实 Git 变更收集器 (collectGitChangedPaths)、纯函数变更影响分析 (analyzeImpact)、需求追踪关联验证',
    whatWeDoNotHave: '仓库权威需求映射文件 (devtest-requirements.json)（Git 变更可读但缺真实映射时严格标记 BLOCKED_DATA_MISSING，禁止创建虚假映射）',
    runtimeDependencyStatus: '零外部依赖，Git 变更收集与分析已就绪，受限于权威需求映射数据供给',
  },
]);

export function getCapabilityAudit(
  capability: 'Playwright' | 'Midscene' | 'Promptfoo' | 'ReportPortal' | 'wardenIQ'
): AbsorbedCapabilityAudit {
  const item = ABSORBED_CAPABILITIES_AUDIT.find((c) => c.capabilityName === capability);
  if (!item) {
    throw new Error(`未知能力: ${capability}`);
  }
  return item;
}
