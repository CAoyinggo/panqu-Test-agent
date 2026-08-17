// Watch 模式：监听源码文件变更，自动重新编译并执行匹配的用例
// 将「修改 → 验证」循环从分钟级缩短到秒级
import chokidar from 'chokidar';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { logger } from '../utils/logger.js';

/** 执行回调返回值（由 engine 提供） */
export interface WatchSummary {
  exitCode: number;
  passed: number;
  failed: number;
  pending: number;
  reports: string[];
}

type WatchExecuteFn = () => Promise<WatchSummary>;

export class Watcher {
  private executeFn: WatchExecuteFn;
  private watchPaths: string[];
  private delay: number;
  private ci: boolean;
  private running: boolean = false;

  constructor(executeFn: WatchExecuteFn, opts: {
    watchPaths: string[];
    delay: number;
    ci: boolean;
  }) {
    this.executeFn = executeFn;
    this.watchPaths = opts.watchPaths;
    this.delay = opts.delay;
    this.ci = opts.ci;
  }

  /** 启动 watch 循环：先执行一次，然后监听文件变更 */
  async start(): Promise<number> {
    // 首次执行
    await this.cycle('初始执行');

    // 监听源码变更
    const cwd = process.cwd();
    const globs = this.watchPaths.map((p) => path.join(p, '**/*.{ts,json}'));
    const watcher = chokidar.watch(globs, {
      cwd,
      persistent: true,
      ignoreInitial: true,
      ignored: /node_modules|dist|\.d\.ts$/,
    });

    let timer: NodeJS.Timeout | null = null;

    watcher.on('ready', () => {
      logger.info(`\n👁 Watch 模式已启动，监听 ${globs.length} 个路径（防抖 ${this.delay}ms）`);
      logger.info('   按 Ctrl+C 退出\n');
    });

    watcher.on('all', (event, filePath) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        await this.cycle(`文件变更：${event} ${filePath}`);
      }, this.delay);
    });

    // 等待直到 Ctrl+C（永远不 resolve）
    await new Promise<void>(() => {
      process.on('SIGINT', () => {
        logger.info('\n👋 退出 Watch 模式');
        watcher.close();
        process.exit(0);
      });
    });

    return 0;
  }

  /** 单次执行循环：清屏 → 编译 → 执行 → 输出摘要 */
  private async cycle(trigger: string): Promise<void> {
    // 防止并发执行（上一次还没跑完就触发下一次）
    if (this.running) {
      logger.debug('上一次执行尚未完成，跳过本次触发');
      return;
    }
    this.running = true;

    // 清屏（非 CI 模式）
    if (!this.ci) {
      process.stdout.write('\x1Bc');
    }

    logger.step(`========== Watch 触发：${trigger} ==========`);
    const t0 = Date.now();

    // 重新编译（增量）
    try {
      execSync('npx tsc --incremental', {
        cwd: process.cwd(),
        stdio: 'pipe',
        timeout: 30000,
      });
      logger.info('✅ 编译成功');
    } catch (e: any) {
      const stderr = e.stderr?.toString() || e.stdout?.toString() || e.message;
      logger.error(`❌ 编译失败：\n${stderr}`);
      logger.info('等待文件修改后重试...');
      this.running = false;
      return;
    }

    // 执行用例
    try {
      const summary = await this.executeFn();
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      logger.step(`\n========== 执行完成（${elapsed}s）==========`);
      logger.info(`📊 结果：✅ 通过 ${summary.passed}  ❌ 失败 ${summary.failed}  ⏳ 待人工 ${summary.pending}  退出码 ${summary.exitCode}`);
      if (summary.reports.length > 0) {
        logger.info(`📄 报告：${summary.reports[0]}`);
      }
      logger.info('\n👁 等待文件变更...');
    } catch (e: any) {
      logger.error(`执行出错：${e.message}`);
      logger.info('\n👁 等待文件变更...');
    }

    this.running = false;
  }
}

/**
 * 计算需要监听的源码路径列表
 */
export function defaultWatchPaths(): string[] {
  return [
    'src/cases',
    'src/assertions',
    'src/plugins',
  ];
}
