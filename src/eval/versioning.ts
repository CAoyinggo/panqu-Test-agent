// Eval Versioning（Phase 45 / 42.18）
// 任何 AI 评测必须记录 model / modelVersion / promptVersion / toolVersion / agentVersion，
// 才能判断「到底是代码变了，还是模型变了」。
// 当前评测链路全部为确定性规则（Deterministic First），model=rules；
// 未来接入 LLM 评测时经环境变量覆盖即可（EVAL_MODEL / EVAL_MODEL_VERSION / ...）。

/** 评测运行所属的系统版本信息（模型 + 提示词 + 工具 + Agent） */
export interface EvalVersionInfo {
  /** 被评测的模型（rules=确定性规则引擎；LLM 时为模型名） */
  model: string;
  modelVersion: string;
  promptVersion: string;
  toolVersion: string;
  agentVersion: string;
}

/** 确定性规则评测默认版本信息 */
export const DEFAULT_EVAL_VERSION_INFO: EvalVersionInfo = {
  model: 'rules',
  modelVersion: '1.0.0',
  promptVersion: 'n/a',
  toolVersion: 'eval-tool-v1',
  agentVersion: 'eval-agent-v1',
};

/** 当前运行时版本信息（可被环境变量覆盖，供 LLM 评测 / 对比模型用） */
export const RUNTIME_EVAL_VERSION_INFO: EvalVersionInfo = {
  model: process.env.EVAL_MODEL ?? DEFAULT_EVAL_VERSION_INFO.model,
  modelVersion: process.env.EVAL_MODEL_VERSION ?? DEFAULT_EVAL_VERSION_INFO.modelVersion,
  promptVersion: process.env.EVAL_PROMPT_VERSION ?? DEFAULT_EVAL_VERSION_INFO.promptVersion,
  toolVersion: process.env.EVAL_TOOL_VERSION ?? DEFAULT_EVAL_VERSION_INFO.toolVersion,
  agentVersion: process.env.EVAL_AGENT_VERSION ?? DEFAULT_EVAL_VERSION_INFO.agentVersion,
};

/** 序列化（JSON 可持久化） */
export function toPlainVersionInfo(info: EvalVersionInfo): EvalVersionInfo {
  return { ...info };
}
