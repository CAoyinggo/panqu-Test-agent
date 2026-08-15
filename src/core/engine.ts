// 核心引擎：加载配置/会话/任务 → 匹配场景处理器 → 执行 pipeline → 生成报告
import path from 'node:path';
import type { AppConfig, TaskDef, ReportData } from './types.js';
import { HookRegistry } from './hooks.js';
import type { SceneHandler } from './scene-handler.js';
import { Pipeline, PipelineResult } from './pipeline.js';
import { Http } from '../integrations/http.js';
import { loadConfig, parseArgs, CliArgs } from '../config/config.js';
import { getReporters } from '../reports/factory.js';
import { outputDir } from '../utils/fs-utils.js';
import { logger } from '../utils/logger.js';
import { loadCases, LoadedCase } from '../cases/loader.js';

// 场景处理器注册表（插件式：新模块在此登记）
import { VideoSceneHandler } from '../plugins/scenes/video.js';

export const SCENES: Record<string, SceneHandler> = {
  video: new VideoSceneHandler(),
};

export function registerScene(name: string, handler: SceneHandler): void {
  SCENES[name] = handler;
}

export function findHandler(scene: string): SceneHandler | null {
  for (const h of Object.values(SCENES)) {
    if (h.match(scene)) return h;
  }
  return null;
}

export interface EngineOptions {
  hooks?: HookRegistry;
}

export class Engine {
  private hooks: HookRegistry;

  constructor(opts: EngineOptions = {}) {
    this.hooks = opts.hooks || new HookRegistry();
  }

  /** 加载任务定义（文件或目录，支持 JSON / TS 编译产物） */
  private async loadTask(taskArg: string): Promise<LoadedCase[]> {
    const cases = await loadCases(path.resolve(process.cwd(), taskArg));
    if (!cases.length) throw new Error(`未加载到任何任务定义：${taskArg}`);
    return cases;
  }

  /** 运行单个任务，返回报告文件路径列表 */
  async runTask(cfg: AppConfig, taskDef: TaskDef, env: string, func?: string, reporter?: string | null): Promise<string[]> {
    const handler = findHandler(taskDef.scene);
    const session = Http.loadSession(cfg.session_cookies_path, env);
    session.env = env;

    const pipeline = new Pipeline({ cfg, session, taskDef, handler, func }, this.hooks);
    const result: PipelineResult = await pipeline.run();

    // 组装报告数据
    const reportData: ReportData = {
      title: taskDef.name + ' 测试报告',
      env,
      taskDef: { ...taskDef, project_id: session.project_id, account: session.account || session.nickname },
      submit: result.submit,
      billingData: result.billingData,
      impact: result.impact,
      checks: result.checks,
      responses: result.responses,
      manual: result.manual,
      issues: result.issues,
      passRate: result.passRate,
      assetInfo: result.assetInfo,
    };

    const dir = outputDir(func);
    const reporters = getReporters(reporter);
    const files: string[] = [];
    for (const r of reporters) {
      files.push(...r.write(dir, taskDef.name, reportData));
    }
    return files;
  }

  /** CLI 主入口：解析参数 → 加载配置/任务 → 执行 → 输出报告路径 */
  async main(argv: string[]): Promise<void> {
    const args: CliArgs = parseArgs(argv);

    if (args.help) {
      console.log(`用法：
  node dist/bin/run-test.js --task <任务定义> [--env=test|preonline] [--func=<功能名>] [--reporter=html,json,junit]

参数：
  --task      任务定义路径（必填）。支持单个文件（.json 或 TS 编译的 .js）或目录（批量执行全部用例），示例见 tasks/ 与 src/cases/tasks/
  --env       执行环境，默认 test，可选 preonline
  --func      功能名称（归档目录 output/<日期>/<功能名>/，强制约定）
  --reporter  报告格式，默认 html，可选 html,json,junit（逗号分隔多份）
  --help      显示帮助`);
      return;
    }

    if (!args.task) {
      logger.error('缺少 --task 参数（任务定义 JSON 路径）');
      process.exit(1);
    }

    const cfg = loadConfig(args.env);
    const cases = await this.loadTask(args.task!);
    const env = args.env || cfg.default_env;

    let allFiles: string[] = [];
    for (const c of cases) {
      logger.step(`---- 加载用例：${c.name}（${c.file}） ----`);
      try {
        const files = await this.runTask(cfg, c.def, env, args.func || undefined, args.reporter);
        allFiles.push(...files);
      } catch (e: any) {
        logger.error(`用例执行失败：${c.name} - ${e.message}`);
      }
    }

    logger.step('========== 执行完成 ==========');
    for (const f of allFiles) logger.info('报告已生成：' + f);
  }
}

/** 便捷单例入口 */
export const engine = new Engine();
