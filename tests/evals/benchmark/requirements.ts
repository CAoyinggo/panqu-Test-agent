// Agent Evaluation Benchmark：需求解析基准（Phase 18）
// 30 条需求：10 正常 + 10 边界 + 10 异常。
// expected 为确定性解析器（requirement-parser）应产出的 ground truth 关键字段。
export interface BenchmarkRequirement {
  id: string;
  kind: 'normal' | 'boundary' | 'abnormal';
  text: string;
  expected: {
    feature: string;
    capabilities: string[];
    inputs: string[];
    businessRules: string[];
    risks: string[];
  };
}

export const REQUIREMENT_BENCHMARK: BenchmarkRequirement[] = [
  // ── 10 正常需求 ──
  { id: 'req-001', kind: 'normal', text: '测试文生视频功能，覆盖正常生成、超长 prompt、1080P、10 秒视频、积分扣费和并发场景。', expected: { feature: 'wan3', capabilities: ['text-to-video', 'video'], inputs: ['prompt', 'resolution', 'duration'], businessRules: ['积分正确扣除', '任务提交成功', '任务状态最终成功', '并发执行正常', '超长输入处理'], risks: ['concurrency', 'billing', 'exception'] } },
  { id: 'req-002', kind: 'normal', text: '验证图生视频完整链路，输入参考图与提示词，覆盖 4K 分辨率和 5 秒时长，确保任务提交成功与最终成功。', expected: { feature: 'wan3', capabilities: ['image-to-video', 'video'], inputs: ['prompt', 'resolution', 'duration', 'reference'], businessRules: ['任务提交成功', '任务状态最终成功', '时长校验'], risks: [] } },
  { id: 'req-003', kind: 'normal', text: '测试首尾帧视频生成能力，覆盖 720P、3 秒与 8 秒时长，验证任务提交成功和积分扣除正确。', expected: { feature: 'wan3', capabilities: ['first-last-frame', 'video'], inputs: ['resolution', 'duration'], businessRules: ['积分正确扣除', '任务提交成功', '任务状态最终成功', '时长校验'], risks: ['billing', 'exception'] } },
  { id: 'req-004', kind: 'normal', text: '验证文生视频生成任务在并发 100 下的稳定性，确保任务提交成功、最终成功且超时处理正常。', expected: { feature: 'wan3', capabilities: ['text-to-video', 'video'], inputs: ['prompt'], businessRules: ['任务提交成功', '任务状态最终成功', '并发执行正常', '超时处理正常'], risks: ['concurrency', 'timeout', 'exception'] } },
  { id: 'req-005', kind: 'normal', text: '测试文生视频长 prompt（2000 字）场景，覆盖 1080P、10 秒，验证任务最终成功与积分扣除正确。', expected: { feature: 'wan3', capabilities: ['text-to-video', 'video'], inputs: ['prompt', 'resolution', 'duration'], businessRules: ['积分正确扣除', '任务提交成功', '任务状态最终成功'], risks: ['billing', 'exception'] } },
  { id: 'req-006', kind: 'normal', text: '验证视频生成功能在 4K 分辨率下 15 秒视频的正常生成，确保任务提交成功与状态最终成功。', expected: { feature: 'wan3', capabilities: ['video'], inputs: ['resolution', 'duration'], businessRules: ['任务提交成功', '任务状态最终成功'], risks: [] } },
  { id: 'req-007', kind: 'normal', text: '测试文生视频的积分扣除与余额校验链路，覆盖余额充足与不足两种场景，确保积分扣除正确且任务提交成功。', expected: { feature: 'wan3', capabilities: ['text-to-video', 'video'], inputs: [], businessRules: ['积分正确扣除', '任务提交成功', '余额不足拒绝'], risks: ['billing'] } },
  { id: 'req-008', kind: 'normal', text: '验证文生视频生成失败后的重试机制，覆盖网络异常重试，确保任务最终成功。', expected: { feature: 'wan3', capabilities: ['text-to-video', 'video'], inputs: ['prompt'], businessRules: ['任务状态最终成功', '重试机制正常'], risks: ['exception'] } },
  { id: 'req-009', kind: 'normal', text: '测试视频生成任务超时场景，覆盖 60 秒长任务，确保超时处理正常且任务提交成功。', expected: { feature: 'wan3', capabilities: ['video'], inputs: ['duration'], businessRules: ['任务提交成功', '超时处理正常'], risks: ['timeout'] } },
  { id: 'req-010', kind: 'normal', text: '验证用户登录后创建视频生成任务的完整流程，确保任务提交成功与最终成功。', expected: { feature: 'wan3', capabilities: ['video'], inputs: [], businessRules: ['任务提交成功', '任务状态最终成功'], risks: [] } },

  // ── 10 边界需求 ──
  { id: 'req-011', kind: 'boundary', text: '测试文生视频最小 prompt（1 字符），覆盖 480P、1 秒视频，确保任务最终成功。', expected: { feature: 'wan3', capabilities: ['text-to-video', 'video'], inputs: ['prompt', 'resolution', 'duration'], businessRules: ['任务提交成功', '任务状态最终成功'], risks: [] } },
  { id: 'req-012', kind: 'boundary', text: '验证文生视频最大时长 60 秒与 8K 分辨率组合，确保任务提交成功与最终成功。', expected: { feature: 'wan3', capabilities: ['text-to-video', 'video'], inputs: ['prompt', 'resolution', 'duration'], businessRules: ['任务提交成功', '任务状态最终成功', '时长校验'], risks: [] } },
  { id: 'req-013', kind: 'boundary', text: '测试提示词全角标点与表情符号场景，覆盖 720P、5 秒，验证任务最终成功。', expected: { feature: 'wan3', capabilities: ['text-to-video', 'video'], inputs: ['prompt', 'resolution', 'duration'], businessRules: ['任务提交成功', '任务状态最终成功'], risks: [] } },
  { id: 'req-014', kind: 'boundary', text: '验证余额临界值（0 余额、1 积分）下的视频生成，确保积分扣除正确。', expected: { feature: 'wan3', capabilities: ['video'], inputs: [], businessRules: ['积分正确扣除'], risks: ['billing'] } },
  { id: 'req-015', kind: 'boundary', text: '测试并发 0 与并发 1 的边界，确保任务提交成功与并发执行正常。', expected: { feature: 'wan3', capabilities: ['video'], inputs: [], businessRules: ['任务提交成功', '并发执行正常'], risks: ['concurrency'] } },
  { id: 'req-016', kind: 'boundary', text: '验证空 prompt 与仅空格 prompt 的视频生成，确保任务提交成功与最终成功。', expected: { feature: 'wan3', capabilities: ['video'], inputs: ['prompt'], businessRules: ['任务提交成功', '任务状态最终成功'], risks: [] } },
  { id: 'req-017', kind: 'boundary', text: '测试 0 秒与 120 秒超长视频边界，确保超时处理正常且任务提交成功。', expected: { feature: 'wan3', capabilities: ['video'], inputs: ['duration'], businessRules: ['任务提交成功', '超时处理正常', '超长输入处理'], risks: ['timeout'] } },
  { id: 'req-018', kind: 'boundary', text: '验证 480P 最低分辨率与 8K 最高分辨率边界，确保任务最终成功。', expected: { feature: 'wan3', capabilities: ['video'], inputs: ['resolution'], businessRules: ['任务状态最终成功'], risks: [] } },
  { id: 'req-019', kind: 'boundary', text: '测试提示词含非法字符与 SQL 注入字符串，确保任务提交成功与最终成功。', expected: { feature: 'wan3', capabilities: ['text-to-video', 'video'], inputs: ['prompt'], businessRules: ['任务提交成功', '任务状态最终成功', '安全注入防护'], risks: ['exception'] } },
  { id: 'req-020', kind: 'boundary', text: '验证视频生成在积分不足时给出明确错误，确保积分扣除正确。', expected: { feature: 'wan3', capabilities: ['video'], inputs: [], businessRules: ['积分正确扣除'], risks: ['billing'] } },

  // ── 10 异常需求 ──
  { id: 'req-021', kind: 'abnormal', text: '测试模型服务返回 503 时视频生成失败，确保错误信息明确且可重试。', expected: { feature: 'wan3', capabilities: ['video'], inputs: [], businessRules: ['重试机制正常'], risks: ['exception'] } },
  { id: 'req-022', kind: 'abnormal', text: '验证网络超时导致任务失败，确保超时处理正常。', expected: { feature: 'wan3', capabilities: ['video'], inputs: [], businessRules: ['超时处理正常'], risks: ['timeout', 'exception'] } },
  { id: 'req-023', kind: 'abnormal', text: '测试积分服务不可用时视频生成降级，确保积分扣除正确。', expected: { feature: 'wan3', capabilities: ['video'], inputs: [], businessRules: ['积分正确扣除'], risks: ['billing'] } },
  { id: 'req-024', kind: 'abnormal', text: '验证并发超限 1000 时的系统表现，确保并发执行正常。', expected: { feature: 'wan3', capabilities: ['video'], inputs: [], businessRules: ['并发执行正常'], risks: ['concurrency'] } },
  { id: 'req-025', kind: 'abnormal', text: '测试视频生成服务磁盘满导致失败，确保错误信息明确。', expected: { feature: 'wan3', capabilities: ['video'], inputs: [], businessRules: ['任务状态最终成功'], risks: ['exception'] } },
  { id: 'req-026', kind: 'abnormal', text: '验证鉴权失败 401 时视频生成被拒绝，确保安全边界。', expected: { feature: 'wan3', capabilities: ['video'], inputs: [], businessRules: [], risks: ['security'] } },
  { id: 'req-027', kind: 'abnormal', text: '测试数据库连接异常导致任务失败，确保任务最终成功。', expected: { feature: 'wan3', capabilities: ['video'], inputs: [], businessRules: ['任务状态最终成功'], risks: ['exception'] } },
  { id: 'req-028', kind: 'abnormal', text: '验证 CDN 回源失败导致视频无法生成，确保错误信息明确。', expected: { feature: 'wan3', capabilities: ['video'], inputs: [], businessRules: [], risks: ['exception'] } },
  { id: 'req-029', kind: 'abnormal', text: '测试模型服务偶发 5xx 时自动重试成功，确保重试机制正常。', expected: { feature: 'wan3', capabilities: ['video'], inputs: [], businessRules: ['重试机制正常'], risks: ['exception'] } },
  { id: 'req-030', kind: 'abnormal', text: '验证环境异常（依赖服务未启动）时视频生成失败，确保错误信息明确。', expected: { feature: 'wan3', capabilities: ['video'], inputs: [], businessRules: [], risks: ['environment', 'exception'] } },
];
