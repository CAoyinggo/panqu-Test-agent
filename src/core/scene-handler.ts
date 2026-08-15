// 场景处理器（插件）统一接口
// 新模块接入：实现本接口，注册到 plugins/scenes/，在 engine 的 SCENES 注册表登记
import type { RunContext, SubmitResult, BillingData } from './types.js';

export interface SceneHandler {
  /** 处理器标识（如 'video'） */
  name: string;
  /** 支持的 scene 值（用于 match 匹配） */
  scenes: string[];
  /** 是否匹配该场景 */
  match(scene: string): boolean;
  /** 提交任务，返回 { taskId, submit } */
  submit(ctx: RunContext): Promise<{ taskId: number | null; submit: Partial<SubmitResult> }>;
  /** 查询详情（落库核对），更新 ctx.submit.detail */
  detail(ctx: RunContext): Promise<void>;
  /** 查询状态，更新 ctx.submit.status/progress/videoUrl/err */
  status(ctx: RunContext): Promise<void>;
  /** 计费分析：从通用 billingData 提取模型趋势与净消耗 */
  analyzeBilling(billingData: BillingData, session: any): BillingData;
}
