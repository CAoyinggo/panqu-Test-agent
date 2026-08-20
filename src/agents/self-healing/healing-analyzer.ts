// Healing Analyzer：确定性自愈检测（Phase 15）
// Deterministic First：路径失效检测与最近路径搜索由规则引擎完成（任务书第 21 节），
// AI 只补充理由与补丁措辞。
// 检测：断言命中 JSON Path 但实际为 undefined/null / 无法读取 → 路径失效 →
// 解析实际响应 Schema → 相似度匹配最可能新 Path → 生成 Patch（Diff）。
import type { CaseExecutionResult } from '../execution/execution-schema.js';
import { HealingSuggestion, HealingType, HealingAnalysis, buildHealingSuggestion } from './healing-schema.js';

/** 分析输入 */
export interface HealingAnalyzerInput {
  feature: string;
  /** 失败用例 */
  failedCases: CaseExecutionResult[];
  /** 实际响应 Schema（嵌套对象，可选；缺省从失败细节尝试解析） */
  actualSchema?: Record<string, unknown>;
}

/** 路径失效征兆（断言 detail / error 中命中即认为路径可能失效） */
const PATH_FAILURE_HINTS = [
  /cannot read propert/i,
  /undefined/i,
  /\bnull\b/i,
  /got undefined/i,
  /无法读取|为空|未定义/i,
];

/** 从文本提取点分路径（如 data.result.video.url） */
export function extractPaths(text: string): string[] {
  const matches = text.match(/\b(?:[a-zA-Z_$][\w$]*)(?:\.[a-zA-Z_$][\w$]*)+/g) ?? [];
  return Array.from(new Set(matches)).filter((p) => p.split('.').length >= 2);
}

/** 扁平化嵌套对象为路径列表 */
export function flattenSchema(obj: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length > 0) {
      out.push(...flattenSchema(v as Record<string, unknown>, p));
    } else {
      out.push(p);
    }
  }
  return out;
}

/** 尝试从文本中解析 JSON 对象并扁平化 */
export function parseSchemaFromText(text: string): string[] {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return [];
  try {
    const obj = JSON.parse(match[0]);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      return flattenSchema(obj as Record<string, unknown>);
    }
  } catch {
    // 解析失败返回空
  }
  return [];
}

/** 路径相似度：0~1（按段级 Jaccard） */
export function pathSimilarity(a: string, b: string): number {
  const ta = a.split('.');
  const tb = b.split('.');
  if (ta.length === 0 || tb.length === 0) return 0;
  const setA = new Set(ta);
  const setB = new Set(tb);
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter++;
  return inter / Math.max(setA.size, setB.size);
}

/** 在候选路径中寻找与 oldPath 最相似的路径 */
export function findClosestPath(oldPath: string, candidates: string[]): { path: string; confidence: number } | null {
  let best: string | null = null;
  let bestScore = 0;
  for (const c of candidates) {
    if (c === oldPath) continue;
    const s = pathSimilarity(oldPath, c);
    if (s > bestScore) {
      best = c;
      bestScore = s;
    }
  }
  if (!best || bestScore < 0.4) return null; // 相似度过低不推荐
  return { path: best, confidence: Math.round(bestScore * 100) / 100 };
}

/** 判断单条失败用例是否为路径失效 */
export function isPathFailure(failed: CaseExecutionResult): boolean {
  const blob = [
    failed.error ?? '',
    ...(failed.checks ?? []).map((c) => `${c.name} ${c.detail}`),
  ].join(' ');
  return PATH_FAILURE_HINTS.some((re) => re.test(blob));
}

/** 服务级错误征兆（模型/网关/数据库/连接故障）——路径失效背后的真实原因 */
const SERVICE_ERROR_HINTS = [
  /50[0-9]|502|503|504|gateway|service unavailable|server error/i,
  /database\s+unavailable|db\s+unavailable|数据库故障|数据库不可用|db\s+error/i,
  /econnrefused|connection\s+refused/i,
];

/**
 * 判断失败是否伴随服务级错误（Phase 45 DANGEROUS 防护）。
 * 当错误/断言明细指向模型/网关/数据库/连接故障时，路径自愈会掩盖真实 Bug，
 * 必须禁止路径修复建议，改由 RCA/缺陷流程登记真实问题。
 */
export function hasServiceError(failed: CaseExecutionResult): boolean {
  const blob = [
    failed.error ?? '',
    ...(failed.checks ?? []).map((c) => `${c.name} ${c.detail}`),
  ].join(' ');
  return SERVICE_ERROR_HINTS.some((re) => re.test(blob));
}

/** 提取错误码不匹配（期望 vs 实际）。返回 { oldCode=期望码, newCode=实际码 } 或 null */
export function extractErrorCodeMismatch(text: string): { oldCode: string; newCode: string } | null {
  // 期望在前（英文）：expected 4001, got 4003
  const enFirst = text.match(/expected\s*[:：]?\s*(\d{3,5})[\s,，]+(?:got|actual|received|实际|收到|返回)[\s:：]*(\d{3,5})/i);
  if (enFirst) return { oldCode: enFirst[1], newCode: enFirst[2] };
  // 期望在前（中文）：期望 4001，实际 4003
  const zhFirst = text.match(/期望\s*(?:错误码)?\s*[:：]?\s*(\d{3,5})[\s,，]+(?:实际|收到|返回|got)[\s:：]*(\d{3,5})/i);
  if (zhFirst) return { oldCode: zhFirst[1], newCode: zhFirst[2] };
  // 实际在前：错误码 4003 与期望 4001 不一致
  const actualFirst = text.match(/错误码\s*[:：]?\s*(\d{3,5})[\s,，]+(?:与期望|expected)[\s:：]*(\d{3,5})/i);
  if (actualFirst) return { oldCode: actualFirst[2], newCode: actualFirst[1] };
  return null;
}

/**
 * 区分路径变更类型：
 *   - 仅最后一段（叶子字段）被重命名（data.task.status → data.task.taskStatus）→ api-field
 *   - 中间结构段变化（data.result.url → data.output.url）→ json-path
 */
export function classifyPathChange(oldPath: string, newPath: string): 'json-path' | 'api-field' {
  const a = oldPath.split('.');
  const b = newPath.split('.');
  const len = Math.max(a.length, b.length);
  let diffIdx = -1;
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) {
      diffIdx = i;
      break;
    }
  }
  if (diffIdx === Math.max(a.length - 1, b.length - 1)) return 'api-field';
  return 'json-path';
}

/**
 * 确定性自愈分析：对每个路径失效的用例，搜索最可能新 Path 并生成建议。
 * 仅当证据充分（能定位到新 Path 且相似度达标）才产出 SUGGESTED 建议；
 * 否则不产出（避免误改）。所有建议状态恒为 SUGGESTED，需人工审批。
 */
export function analyzeHealing(input: HealingAnalyzerInput): HealingAnalysis {
  const candidates: string[] = [];
  for (const f of input.failedCases) {
    const blob = [
      f.error ?? '',
      ...(f.checks ?? []).map((c) => `${c.name} ${c.detail}`),
    ].join(' ');
    candidates.push(...extractPaths(blob));
  }
  if (input.actualSchema) {
    candidates.push(...flattenSchema(input.actualSchema));
  } else {
    const blob = input.failedCases.map((f) => f.error ?? '').join(' ');
    candidates.push(...parseSchemaFromText(blob));
  }
  const uniqueCandidates = Array.from(new Set(candidates));

  const suggestions: HealingSuggestion[] = [];
  for (const f of input.failedCases) {
    if (!isPathFailure(f)) continue;
    // Phase 45 DANGEROUS 防护：伴随服务级错误（503/数据库故障/连接拒绝）时禁止路径自愈，
    // 否则会把真实 Bug（模型/网关/数据库故障）误当作"字段重命名"而掩盖。
    if (hasServiceError(f)) continue;
    // 失效路径：优先取断言名中的路径，其次错误消息
    const blob = [
      ...(f.checks ?? []).filter((c) => !c.pass).map((c) => c.detail),
      f.error ?? '',
    ].join(' ');
    const oldPaths = extractPaths(blob);
    const oldPath = oldPaths[0];
    if (!oldPath) continue;

    const hit = findClosestPath(oldPath, uniqueCandidates);
    if (!hit) continue;

    const changeType = classifyPathChange(oldPath, hit.path);
    suggestions.push(buildHealingSuggestion({
      caseId: f.caseId,
      type: changeType,
      oldPath,
      newPath: hit.path,
      confidence: hit.confidence,
      reason: changeType === 'api-field'
        ? `API 字段重命名：${oldPath} 已无法读取，实际响应中最可能的新字段为 ${hit.path}（仅叶子字段变化）`
        : `JSON Path 失效：${oldPath} 无法读取（实际响应结构变化），最可能的新路径为 ${hit.path}`,
      patch: `- path: '${oldPath}'\n+ path: '${hit.path}'\n（请人工确认后应用）`,
      risk: hit.confidence >= 0.8 ? 'low' : 'medium',
      evidence: (f.checks ?? []).filter((c) => !c.pass).slice(0, 3).map((c) => `${c.name}: ${c.detail}`),
      status: 'SUGGESTED',
    }));
  }

  // 错误码变更检测（如期望 4001，实际 4003；需人工确认是预期业务调整还是回归缺陷）
  for (const f of input.failedCases) {
    const blob = [
      f.error ?? '',
      ...(f.checks ?? []).map((c) => `${c.name} ${c.detail}`),
    ].join(' ');
    const mismatch = extractErrorCodeMismatch(blob);
    if (!mismatch) continue;
    suggestions.push(buildHealingSuggestion({
      caseId: f.caseId,
      type: 'error-code',
      oldPath: 'error.code',
      newPath: mismatch.newCode,
      confidence: 0.7,
      reason: `错误码从 ${mismatch.oldCode} 变为 ${mismatch.newCode}（实际响应返回 ${mismatch.newCode}）。请人工确认是预期业务调整还是回归缺陷：若为预期变更则更新期望值，否则应登记缺陷而非修改断言。`,
      patch: `- expectedCode: '${mismatch.oldCode}'\n+ expectedCode: '${mismatch.newCode}'\n（请人工确认后应用）`,
      risk: 'high',
      evidence: (f.checks ?? []).filter((c) => !c.pass).slice(0, 3).map((c) => `${c.name}: ${c.detail}`),
      status: 'SUGGESTED',
    }));
  }

  return {
    feature: input.feature,
    total: suggestions.length,
    suggestions,
    summary: suggestions.length > 0
      ? `检测到 ${suggestions.length} 处可自愈变更（路径/字段/错误码），已生成修复建议（待人工确认）`
      : '未检测到可自愈的变更（证据不足时不做修改）',
    source: 'rules',
  };
}

// 重导出类型
export type { HealingSuggestion };
