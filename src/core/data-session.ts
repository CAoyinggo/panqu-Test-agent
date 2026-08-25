// DataSession：测试数据生命周期的唯一所有者（setup → Execution → teardown）。
//
// 解决的问题（DataContext 生命周期打通）：
//   1. 数据准备结果真正传给 Runner：编排层 setup 一次，Execution 消费 session.context，
//      不再由 Pipeline 重复准备一套数据；
//   2. 不重复准备：setup 幂等（once），外部会话进入 Pipeline 后只读不建；
//   3. setup 失败是否阻断执行：策略显式化 —— 'block'（默认，fail-closed：清理部分产出后抛错，
//      阻断执行）/ 'continue'（降级为空上下文继续，与旧行为一致）；
//   4. teardown 必须执行：幂等且不抛错（清理失败记录日志，不掩盖执行结果）；
//      'block' 策略下 setup 失败也会先尽力清理再抛出；
//   5. 归属明确：谁创建会话谁负责 teardown（编排层 adopt/forFactory + try/finally；
//      Pipeline 内部会话由 Pipeline 自己收尾）。
//
// 状态机：pending → ready → torn-down；setup 失败（block）→ setup-failed → torn-down。
import type { DataContext, DataFactory, RunContext, TaskDef } from './types.js';
import { resolveDataFactory } from './data-factory.js';
import { logger } from '../utils/logger.js';

/** 会话状态（生命周期归属与幂等保障的依据） */
export type DataSessionState = 'pending' | 'ready' | 'setup-failed' | 'torn-down';

/** setup 失败策略：block = 阻断执行（默认，fail-closed）；continue = 降级继续（空上下文） */
export type DataSetupFailurePolicy = 'block' | 'continue';

/** setup 失败（block 策略）抛出的错误类型：调用方据此把用例判为阻断而非普通失败 */
export class DataSessionSetupError extends Error {
  constructor(
    message: string,
    /** 已尽力清理的部分产出摘要（原样保留失败现场信息） */
    public readonly partialContext: DataContext | null,
  ) {
    super(message);
    this.name = 'DataSessionSetupError';
  }
}

export interface DataSessionOptions {
  /** setup 失败策略（默认 block：数据没准备好就执行只会产出垃圾结果） */
  setupFailurePolicy?: DataSetupFailurePolicy;
  /** 逻辑名称（日志/审计） */
  name?: string;
}

/**
 * 数据会话：封装 DataFactory 的 setup/teardown 对，保证幂等与「teardown 必须执行」。
 * - forFactory：经典 setup/teardown 生命周期（Pipeline autoSetup / CLI 路径）
 * - adopt：数据已在外部准备好（如 data.prepare Tool 的 generate()），仅接管 teardown
 */
export class DataSession {
  private state: DataSessionState = 'pending';
  private _context: DataContext | null = null;
  private _setupError: Error | null = null;
  private teardownPromise: Promise<void> | null = null;
  private lastCtx: Partial<RunContext> | undefined;

  private constructor(
    private readonly factory: DataFactory | null,
    private readonly factoryName: string,
    private readonly policy: DataSetupFailurePolicy,
    private readonly adopted: boolean,
    private readonly preparedContext?: DataContext,
  ) {}

  /** 创建 setup/teardown 生命周期会话（数据尚未准备） */
  static forFactory(factory: DataFactory, factoryName: string, opts: DataSessionOptions = {}): DataSession {
    return new DataSession(factory, factoryName, opts.setupFailurePolicy ?? 'block', false);
  }

  /** 按 TaskDef.dataFactory 解析工厂创建会话（未注册自定义工厂时为 Noop：setup 返回空） */
  static forTaskDef(taskDef: TaskDef, opts: DataSessionOptions = {}): DataSession {
    const { factory, name } = resolveDataFactory(taskDef);
    const policy = resolveSetupFailurePolicy(taskDef, opts);
    return new DataSession(factory, name, policy, false);
  }

  /**
   * 接管外部已准备好的数据（如 Agent 链路 data.prepare 的产出）：
   * 会话进入 ready，不重复 setup；teardown 仍调用工厂清理（若提供）。
   */
  static adopt(context: DataContext, factory?: DataFactory | null, factoryName = 'adopted', opts: DataSessionOptions = {}): DataSession {
    const session = new DataSession(factory ?? null, factoryName, opts.setupFailurePolicy ?? 'block', true, context);
    session.state = 'ready';
    session._context = context;
    return session;
  }

  /** 当前状态 */
  get currentState(): DataSessionState {
    return this.state;
  }

  /** 数据是否已就绪（ready 且有上下文） */
  get isReady(): boolean {
    return this.state === 'ready';
  }

  /** 会话是否由外部准备（adopt）：Pipeline 据此跳过自身 setup（不重复准备） */
  get isAdopted(): boolean {
    return this.adopted;
  }

  /** 工厂逻辑名 */
  get name(): string {
    return this.factoryName;
  }

  /** 数据上下文（ready 后可用；未 ready 返回 null，不静默给空对象掩盖状态） */
  get context(): DataContext | null {
    return this.state === 'ready' ? this._context : null;
  }

  /** setup 失败时的原始错误（block 策略下已抛出；此处供诊断） */
  get setupError(): Error | null {
    return this._setupError;
  }

  /**
   * 准备数据（幂等：ready 后重复调用直接返回既有上下文，绝不重复准备）。
   * - block：失败 → 先尽力 teardown 部分产出 → 抛 DataSessionSetupError（阻断执行）
   * - continue：失败 → 记录警告，降级为空上下文继续（兼容旧降级行为）
   */
  async setup(ctx?: Partial<RunContext>): Promise<DataContext> {
    if (this.state === 'ready') return this._context!;
    if (this.state === 'torn-down') throw new Error(`数据会话已 teardown，不能重新 setup：${this.factoryName}`);
    if (this.state === 'setup-failed') {
      throw new DataSessionSetupError(`数据准备已失败（不重复尝试）：${this._setupError?.message}`, this._context);
    }
    if (!this.factory) throw new Error('数据会话没有工厂，无法 setup');

    this.lastCtx = ctx;
    try {
      const data = await this.factory.setup((ctx ?? {}) as RunContext);
      this._context = data;
      this.state = 'ready';
      logger.info(`数据会话 ready：${this.factoryName}（任务=${data.taskIds?.length ?? 0}，素材=${data.assets?.length ?? 0}）`);
      return data;
    } catch (e) {
      this._setupError = e as Error;
      this.state = 'setup-failed';
      if (this.policy === 'continue') {
        logger.warn(`数据准备失败（policy=continue，降级为空上下文继续执行）：${(e as Error).message}`);
        this._context = {};
        this.state = 'ready';
        return {};
      }
      // block：清理部分产出后再抛错（数据没准备好就执行 = 用垃圾数据跑用例）
      await this.teardown(ctx).catch(() => undefined);
      throw new DataSessionSetupError(`数据准备失败（policy=block，阻断执行）：${(e as Error).message}`, this._context);
    }
  }

  /**
   * 清理数据（幂等且必须可达：编排方在 finally 中调用；清理失败只记录不抛出，
   * 不掩盖执行结果）。setup 失败（block）时 teardown 已在内部尽力执行过 —— 再次调用为 no-op。
   */
  async teardown(ctx?: Partial<RunContext>): Promise<void> {
    if (this.teardownPromise) return this.teardownPromise;
    if (this.state === 'torn-down' || this.state === 'pending') {
      this.state = this.state === 'pending' ? 'torn-down' : this.state;
      return;
    }
    const targetCtx = (ctx ?? this.lastCtx ?? {}) as RunContext;
    this.teardownPromise = (async () => {
      try {
        if (this.factory) {
          await this.factory.teardown(targetCtx, this._context ?? {});
        }
        this.state = 'torn-down';
        logger.info(`数据会话已清理：${this.factoryName}`);
      } catch (e) {
        // 清理失败不抛出：数据可能残留（记录待人工处理），但不得掩盖执行结果
        this.state = 'torn-down';
        logger.warn(`数据清理失败（会话 ${this.factoryName}，可能有残留数据需人工核对）：${(e as Error).message}`);
      }
    })();
    return this.teardownPromise;
  }
}

/** setup 失败策略解析：TaskDef.extra.dataSetupFailure 显式声明 > 默认 block */
function resolveSetupFailurePolicy(taskDef: TaskDef, opts: DataSessionOptions): DataSetupFailurePolicy {
  const extra = taskDef.extra as Record<string, unknown> | undefined;
  const declared = extra?.dataSetupFailure;
  if (declared === 'continue' || declared === 'block') return declared;
  return opts.setupFailurePolicy ?? 'block';
}

/**
 * 标准生命周期编排（推荐入口）：
 *   try { await session.setup(); return await fn(session); } finally { await session.teardown(); }
 * 保证 teardown 必须执行 —— 即使执行阶段抛错 / 中止。
 */
export async function runWithDataSession<T>(
  session: DataSession,
  fn: (session: DataSession) => Promise<T>,
  ctx?: Partial<RunContext>,
): Promise<T> {
  try {
    await session.setup(ctx);
    return await fn(session);
  } finally {
    await session.teardown(ctx);
  }
}
