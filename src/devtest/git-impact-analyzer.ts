import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type GitImpactLevel = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface AffectedModelSummary {
  modelId: number;
  modelName: string;
  flowType: 'DIRECT' | 'DIVERSION';
  reason: string;
}

export interface GitImpactOptions {
  repoPath?: string;
  changedFiles?: string[];
  stagedOnly?: boolean;
  baseRef?: string;
}

export interface GitImpactReport {
  ok: boolean;
  repoPath: string;
  changedFiles: string[];
  impactLevel: GitImpactLevel;
  affectedModels: AffectedModelSummary[];
  recommendedScenarios: string[];
  suggestedTestCommands: string[];
  summary: string;
}

interface ImpactRule {
  name: string;
  pattern: RegExp;
  level: GitImpactLevel;
  models: AffectedModelSummary[];
  scenarios: string[];
}

const IMPACT_RULES: ImpactRule[] = [
  {
    name: '核心账务与积分变动',
    pattern: /(Score\.php|User\.php|score_log|finance|billing)/i,
    level: 'CRITICAL',
    models: [
      { modelId: 84, modelName: 'Wan 3.0 (视频分流)', flowType: 'DIVERSION', reason: '修改积分结算核心逻辑，触发全量计费核销' },
      { modelId: 901, modelName: 'Image 2.5 Flare Economy (图片直连)', flowType: 'DIRECT', reason: '修改积分结算核心逻辑，触发全量计费核销' },
    ],
    scenarios: ['BILLING_RECONCILIATION', 'FAILURE_REFUND', 'RETRY_IDEMPOTENCY'],
  },
  {
    name: '分流配置与路由决策',
    pattern: /(ModelDiversion|diversion_config|pq_aivideo_diversion|RouteGroup)/i,
    level: 'HIGH',
    models: [
      { modelId: 84, modelName: 'Wan 3.0', flowType: 'DIVERSION', reason: '修改已有模型分流规则或路由组映射表' },
      { modelId: 78, modelName: 'Seedance 2.5', flowType: 'DIVERSION', reason: '修改已有模型分流规则或路由组映射表' },
    ],
    scenarios: ['ROUTING_DIVERSION', 'DIVERSION_FALLBACK_DIRECT', 'PERMISSION_ISOLATION'],
  },
  {
    name: 'Image 2.5 图片直连服务',
    pattern: /Image25(Service|Model)?\.php/i,
    level: 'MEDIUM',
    models: [
      { modelId: 901, modelName: 'Image 2.5 Flare Economy', flowType: 'DIRECT', reason: '修改 Image 2.5 规格画幅、分辨率或白名单映射' },
      { modelId: 902, modelName: 'Image 2.5 Flare Stable', flowType: 'DIRECT', reason: '修改 Image 2.5 规格画幅、分辨率或白名单映射' },
    ],
    scenarios: ['DIRECT_SPEC_MATRIX', 'MAIN_HAPPY_PATH', 'BILLING_RECONCILIATION'],
  },
  {
    name: '视频生成与分流调度',
    pattern: /(PlotService\.php|Videonew\.php|VideoService\.php|ModelConfig\.php)/i,
    level: 'MEDIUM',
    models: [
      { modelId: 84, modelName: 'Wan 3.0', flowType: 'DIVERSION', reason: '修改视频提交控制器或时长分辨率限制' },
      { modelId: 88, modelName: 'Wan 3.0 Prime', flowType: 'DIRECT', reason: '修改视频提交控制器或新视频模型映射' },
      { modelId: 78, modelName: 'Seedance 2.5', flowType: 'DIVERSION', reason: '修改视频时长或提交参数结构' },
    ],
    scenarios: ['ROUTING_DIVERSION', 'DIVERSION_FALLBACK_DIRECT', 'MEDIA_ASSET_VERIFICATION'],
  },
  {
    name: '前端 Nuxt 业务组件',
    pattern: /(web\/components\/aiVideo|web\/pages|components\/aiVideo)/i,
    level: 'LOW',
    models: [
      { modelId: 84, modelName: 'Wan 3.0 (前端生成入口)', flowType: 'DIVERSION', reason: '修改前端生视频参数收集与接口提交' },
      { modelId: 901, modelName: 'Image 2.5 (前端生图入口)', flowType: 'DIRECT', reason: '修改前端生图画幅选择或参数绑定' },
    ],
    scenarios: ['MAIN_HAPPY_PATH', 'INVALID_INPUT_BOUNDARY'],
  },
];

const SEVERITY_ORDER: Record<GitImpactLevel, number> = {
  NONE: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};

export class GitImpactAnalyzer {
  public static async analyze(options: GitImpactOptions = {}): Promise<GitImpactReport> {
    const repoPath = options.repoPath || process.cwd();
    let changedFiles: string[] = [];

    if (Array.isArray(options.changedFiles)) {
      changedFiles = [...options.changedFiles];
    } else {
      changedFiles = await this.detectChangedFiles(repoPath, options.stagedOnly, options.baseRef);
    }

    if (changedFiles.length === 0) {
      return {
        ok: true,
        repoPath,
        changedFiles: [],
        impactLevel: 'NONE',
        affectedModels: [],
        recommendedScenarios: [],
        suggestedTestCommands: [],
        summary: '未检测到代码改动，无需触发针对性回归自测。',
      };
    }

    let maxLevel: GitImpactLevel = 'LOW';
    const modelMap = new Map<number, AffectedModelSummary>();
    const scenarioSet = new Set<string>();

    for (const file of changedFiles) {
      for (const rule of IMPACT_RULES) {
        if (rule.pattern.test(file)) {
          if (SEVERITY_ORDER[rule.level] > SEVERITY_ORDER[maxLevel]) {
            maxLevel = rule.level;
          }
          for (const m of rule.models) {
            if (!modelMap.has(m.modelId)) {
              modelMap.set(m.modelId, m);
            }
          }
          for (const s of rule.scenarios) {
            scenarioSet.add(s);
          }
        }
      }
    }

    const affectedModels = Array.from(modelMap.values());
    const recommendedScenarios = Array.from(scenarioSet);

    // 如果未命中任何专门规则，但有变更文件，标记为通用影响
    if (affectedModels.length === 0) {
      maxLevel = 'LOW';
      modelMap.set(84, {
        modelId: 84,
        modelName: 'Wan 3.0 (兜底分流基准)',
        flowType: 'DIVERSION',
        reason: '改动公共代码或未分类文件，建议使用基线分流模型进行健康度探测',
      });
      scenarioSet.add('MAIN_HAPPY_PATH');
    }

    const finalModels = Array.from(modelMap.values());
    const finalScenarios = Array.from(scenarioSet);

    // 推荐测试命令
    const suggestedTestCommands: string[] = [];
    for (const m of finalModels) {
      if (m.flowType === 'DIRECT') {
        suggestedTestCommands.push(`node dist/src/devtest/run-playwright-cli.js --flow direct --model ${m.modelId} --mock`);
      } else {
        suggestedTestCommands.push(`node dist/src/devtest/run-playwright-cli.js --flow diversion --model ${m.modelId} --mock`);
      }
    }

    const summary = `检测到 ${changedFiles.length} 个文件变更，影响等级 [${maxLevel}]。波及 ${finalModels.length} 个模型 (${finalModels.map((m) => `${m.modelName}#${m.modelId}`).join(', ')})，建议针对性回归 ${finalScenarios.length} 项核心场景。`;

    return {
      ok: true,
      repoPath,
      changedFiles,
      impactLevel: maxLevel,
      affectedModels: finalModels,
      recommendedScenarios: finalScenarios,
      suggestedTestCommands,
      summary,
    };
  }

  private static async detectChangedFiles(repoPath: string, stagedOnly = false, baseRef?: string): Promise<string[]> {
    try {
      if (baseRef) {
        try {
          const { stdout } = await execFileAsync('git', ['diff', '--name-only', `${baseRef}...HEAD`], { cwd: repoPath, timeout: 5000 });
          if (stdout && stdout.trim()) {
            return stdout.split('\n').map((l) => l.trim()).filter(Boolean);
          }
        } catch {
          // baseRef 无法解析或不存在时降级回常规检测
        }
      }

      const gitArgs = stagedOnly
        ? ['diff', '--name-only', '--cached']
        : ['status', '--porcelain'];

      const { stdout } = await execFileAsync('git', gitArgs, { cwd: repoPath, timeout: 5000 });
      if (!stdout || !stdout.trim()) return [];

      if (stagedOnly) {
        return stdout.split('\n').map((l) => l.trim()).filter(Boolean);
      }

      // 解析 git status --porcelain 输出: ' M path/to/file'
      return stdout
        .split('\n')
        .map((line) => {
          const trimmed = line.trim();
          if (!trimmed) return '';
          const parts = trimmed.split(/\s+/);
          return parts.slice(1).join(' ').replace(/^"|"$/g, '');
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }
}
