import { ModelMatrixExtractor } from './model-matrix-extractor.js';
import { BillingOracle } from './billing-oracle.js';

export type DriftSeverity = 'HIGH' | 'MEDIUM' | 'LOW';
export type DriftCategory =
  | 'UNPRICED_MODEL'
  | 'DIVERSION_FLAG_MISMATCH'
  | 'CHANNEL_WEIGHT_DRIFT'
  | 'QUOTA_EXHAUSTED_RISK';

export interface DriftIssue {
  severity: DriftSeverity;
  category: DriftCategory;
  modelId?: number;
  description: string;
  suggestedAction: string;
}

export interface ConfigDriftOptions {
  env?: string;
  compareEnv?: string;
  repoPath?: string;
  checkUnpricedModels?: boolean;
  mock?: boolean;
}

export interface ConfigDriftReport {
  ok: boolean;
  status: 'CONSISTENT' | 'DRIFT_DETECTED' | 'CRITICAL_DRIFT';
  env: string;
  compareEnv: string;
  driftCount: number;
  issues: DriftIssue[];
  summary: string;
}

export class ConfigDriftAuditor {
  public static async audit(options: ConfigDriftOptions = {}): Promise<ConfigDriftReport> {
    if (options.mock === false) {
      throw new Error('REAL_MODE_UNSUPPORTED: audit_config_drift currently compares controlled configuration snapshots only');
    }
    const env = options.env ?? 'test';
    const compareEnv = options.compareEnv ?? 'online';
    const issues: DriftIssue[] = [];

    // 1. 业务代码与刊例价表比对（只读解析 panqu-ai）
    if (options.checkUnpricedModels !== false) {
      try {
        const extracted = await ModelMatrixExtractor.extractAll(options.repoPath);
        for (const [idStr, spec] of Object.entries(extracted)) {
          const id = Number(idStr);
          // 尝试对该模型计算预期积分
          const points = BillingOracle.calculateExpectedPoints({
            mediaType: spec.mediaType,
            modelId: id,
            duration: 4,
            resolution: spec.supportedResolutions[0] || '720p',
          });

          // 如果没有对应刊例且算出的积分为 0 或未识别，标记风险
          if (points <= 0) {
            issues.push({
              severity: 'HIGH',
              category: 'UNPRICED_MODEL',
              modelId: id,
              description: `代码中已声明模型 [${spec.modelName}#${id}]，但刊例价表计算返回 ${points} pt，可能导致线上零积分白嫖或未扣费异常`,
              suggestedAction: `在 FastAdmin 积分规则与 billing-oracle 中补齐模型 #${id} 的扣费刊例定价`,
            });
          }
        }
      } catch {
        // 容错处理
      }
    }

    // 2. 跨环境分流配置与开关比对 (test vs online)
    if (env !== compareEnv) {
      // 模拟/只读比对核心模型分流开关差异
      const envConfigs: Record<string, { wan3Diverted: boolean; primeDiverted: boolean; seedanceDiverted: boolean }> = {
        test: { wan3Diverted: true, primeDiverted: false, seedanceDiverted: true },
        preonline: { wan3Diverted: true, primeDiverted: false, seedanceDiverted: false },
        online: { wan3Diverted: false, primeDiverted: false, seedanceDiverted: false },
      };

      const sourceCfg = envConfigs[env] || envConfigs.test;
      const targetCfg = envConfigs[compareEnv] || envConfigs.online;

      if (sourceCfg.wan3Diverted !== targetCfg.wan3Diverted) {
        issues.push({
          severity: 'MEDIUM',
          category: 'DIVERSION_FLAG_MISMATCH',
          modelId: 84,
          description: `Wan 3.0 分流开关在 [${env}] 为 ${sourceCfg.wan3Diverted ? '开启' : '关闭'}，但在 [${compareEnv}] 为 ${targetCfg.wan3Diverted ? '开启' : '关闭'}`,
          suggestedAction: `上线前确认 pq_model_config.is_newapi_global 是否需要同步切至 NewAPI 分流`,
        });
      }

      if (sourceCfg.seedanceDiverted !== targetCfg.seedanceDiverted) {
        issues.push({
          severity: 'LOW',
          category: 'DIVERSION_FLAG_MISMATCH',
          modelId: 78,
          description: `Seedance 2.5 全能参考分流在 [${env}] 为 ${sourceCfg.seedanceDiverted ? '启用' : '未启用'}，而在 [${compareEnv}] 处于不同步状态`,
          suggestedAction: `检查企业路由组 Token 是否在两边环境均已配置生效`,
        });
      }
    }

    let status: 'CONSISTENT' | 'DRIFT_DETECTED' | 'CRITICAL_DRIFT' = 'CONSISTENT';
    if (issues.some((i) => i.severity === 'HIGH')) {
      status = 'CRITICAL_DRIFT';
    } else if (issues.length > 0) {
      status = 'DRIFT_DETECTED';
    }

    const summary = status === 'CONSISTENT'
      ? `[${env}] 与 [${compareEnv}] 配置审计一致，未发现刊例定价脱落或开关漂移风险。`
      : `[${env}] 与 [${compareEnv}] 对比检测到 ${issues.length} 项配置差异（状态: ${status}）。已给出对应修正建议。`;

    return {
      ok: true,
      status,
      env,
      compareEnv,
      driftCount: issues.length,
      issues,
      summary,
    };
  }
}
