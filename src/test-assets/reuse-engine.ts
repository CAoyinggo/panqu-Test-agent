// Test Reuse Engine：测试复用引擎（Phase 21.2）
// 目标：新需求到来时不再默认「重新生成全部测试」：
//   新 Requirement → 检索既有测试资产 → 相似用例评分 → Gap 分析 → 只生成缺少的用例。
// 确定性实现（标签 / 取值匹配打分），不引入向量数据库。

import type { Requirement } from '../agents/requirement/requirement-schema.js';
import type { TestAsset } from './asset-schema.js';
import type { TestAssetStore } from './asset-store.js';

/** 复用候选：资产 + 相似度得分 + 命中原因 */
export interface ReuseCandidate {
  asset: TestAsset;
  score: number;
  reasons: string[];
}

/** 复用评估结果 */
export interface ReuseAssessment {
  /** 可复用候选（得分降序，score > 0） */
  reusable: ReuseCandidate[];
  /** 覆盖缺口（需新增用例覆盖的点，如 resolution=1080P） */
  gaps: string[];
  summary: {
    /** 候选资产总数 */
    existing: number;
    /** 可复用数 */
    reusable: number;
    /** 缺口数 */
    gapCount: number;
    /** 一句话建议（复用 N / 新增覆盖 M 个缺口） */
    recommendation: string;
  };
}

/** 将值转为可匹配字符串（大小写不敏感） */
function norm(v: unknown): string {
  return String(v ?? '').trim().toLowerCase();
}

/** 候选资产的全文匹配面（feature + tags + content 序列化） */
function haystack(asset: TestAsset): string {
  return `${asset.feature} ${asset.tags.join(' ')} ${JSON.stringify(asset.content ?? {})}`.toLowerCase();
}

/**
 * 复用评估：对候选 test-case 资产打分，并分析需求覆盖缺口。
 * 打分规则（确定性）：
 *   - feature 一致 +3
 *   - capability 命中 +2 / 个
 *   - input 命中 +1 / 个
 *   - businessRule 命中 +1 / 个
 * score > 0 视为可复用。
 */
export function assessReuse(requirement: Requirement, candidates: TestAsset[]): ReuseAssessment {
  const reusable: ReuseCandidate[] = [];

  for (const asset of candidates) {
    const hay = haystack(asset);
    const reasons: string[] = [];
    let score = 0;

    if (asset.feature === requirement.feature) {
      score += 3;
      reasons.push('feature 一致');
    }
    for (const cap of requirement.capabilities ?? []) {
      if (hay.includes(norm(cap))) {
        score += 2;
        reasons.push(`能力命中：${cap}`);
      }
    }
    for (const input of requirement.inputs ?? []) {
      if (hay.includes(norm(input))) {
        score += 1;
        reasons.push(`输入命中：${input}`);
      }
    }
    for (const rule of requirement.businessRules ?? []) {
      if (hay.includes(norm(rule))) {
        score += 1;
        reasons.push(`规则命中：${rule}`);
      }
    }

    if (score > 0) reusable.push({ asset, score, reasons });
  }
  reusable.sort((a, b) => b.score - a.score || a.asset.id.localeCompare(b.asset.id));

  // Gap 分析：需求声明的参数取值 / 输入 / 业务规则，候选资产未覆盖的即为缺口
  const allHay = candidates.map(haystack).join(' ');
  const gaps: string[] = [];

  for (const item of requirement.requirements ?? []) {
    for (const value of item.values ?? []) {
      if (!allHay.includes(norm(value))) gaps.push(`${item.name}=${String(value)}`);
    }
  }
  for (const input of requirement.inputs ?? []) {
    if (!allHay.includes(norm(input))) gaps.push(`input:${input}`);
  }
  for (const rule of requirement.businessRules ?? []) {
    if (!allHay.includes(norm(rule))) gaps.push(`rule:${rule}`);
  }

  return {
    reusable,
    gaps,
    summary: {
      existing: candidates.length,
      reusable: reusable.length,
      gapCount: gaps.length,
      recommendation: gaps.length === 0 && reusable.length > 0
        ? `全部覆盖点已有资产可复用（${reusable.length} 条），无需新增用例`
        : `复用 ${reusable.length} 条既有资产，仅需为 ${gaps.length} 个缺口新增用例`,
    },
  };
}

/**
 * 便捷入口：从资产库检索指定 feature 的 test-case 资产并做复用评估。
 * includeArchived=false：归档资产不参与复用。
 */
export function findReusableCases(store: TestAssetStore, requirement: Requirement): ReuseAssessment {
  const candidates = store.query({ type: 'test-case', feature: requirement.feature });
  return assessReuse(requirement, candidates);
}
