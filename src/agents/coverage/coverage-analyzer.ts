// Coverage Analyzer：确定性覆盖分析（规则优先）
// 原则（任务书第 21 节）：覆盖分析优先基于结构化 Case / Requirement 计算，AI 只判断缺口解释。
// 维度：
// - requirement：业务规则被断言覆盖的比例（规则关键词出现在某用例断言/名称/标签中）
// - parameter：需求参数取值出现在用例输入中的比例（单位归一化比较）
// - boundary：边界/边界场景覆盖（存在 boundary/edge 标签用例的比例）
// - exception：异常/超时风险是否被异常用例覆盖
// - assertion：业务规则「至少有一条断言」的覆盖比例
// - risk：需求风险标签被用例标签覆盖的比例
// 缺口：组合场景缺失（如 1080P+10s 无单一用例同时覆盖）、未覆盖规则/风险、边界缺失。
import { Requirement } from '../requirement/requirement-schema.js';
import { TestCase } from '../test-design/testcase-schema.js';
import { CoverageAnalysis, CoverageDimension, CoverageRecommendation, buildCoverage } from './coverage-schema.js';

/** 覆盖分析输入 */
export interface CoverageInput {
  requirement: Requirement;
  testCases: TestCase[];
  /** 历史缺陷关键词（供 history 维度） */
  historicalDefects?: string[];
}

/** 覆盖值归一化（与 Selection 一致） */
function norm(v: unknown): string {
  const s = String(v).trim().toLowerCase();
  const m = s.match(/^([\d.]+)(s|秒|sec|seconds|ms|分钟|min)?$/);
  return m ? m[1] : s.replace(/[_\-\s]+/g, '');
}

/** 把一条用例摊平成可检索文本（名称+标签+断言路径/期望+步骤输入） */
function caseBlob(c: TestCase): string {
  return [
    c.name,
    ...c.tags,
    ...c.steps.flatMap((s) => Object.values(s.input ?? {}).map(String)),
    ...c.assertions.map((a) => `${a.operator} ${a.path} ${String(a.expected ?? '')}`),
  ].join(' ');
}

/** 规则/缺陷分词：拆分连接词后的完整 token + 2-gram（提高中文短规则命中率） */
function ruleKeywords(rule: string): string[] {
  const tokens = rule
    .split(/[和与及、，。；;\s]/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  const grams: string[] = [];
  for (const t of tokens) {
    for (let i = 0; i + 1 < t.length; i++) grams.push(t.slice(i, i + 2));
  }
  return [...new Set([...tokens, ...grams])];
}

/** 规则是否被某用例覆盖（任一关键词出现在用例摊平文本中） */
function isRuleCovered(rule: string, blobs: string[]): boolean {
  const kws = ruleKeywords(rule);
  if (!kws.length) return false;
  const blob = blobs.join(' ');
  return kws.some((k) => blob.includes(k));
}

/** 收集需求参数取值（归一化），返回 name → values */
function collectParamValues(req: Requirement): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const item of req.requirements ?? []) {
    map.set(item.name, (item.values ?? []).map(norm));
  }
  return map;
}

/** 计算用例输入取值集合（归一化） */
function caseInputValues(c: TestCase): string[] {
  return c.steps.flatMap((s) => Object.values(s.input ?? {})).map(norm);
}

/** 覆盖分析主入口 */
export function computeCoverageAnalysis(input: CoverageInput): CoverageAnalysis {
  const cases = input.testCases ?? [];
  const req = input.requirement;
  const blobs = cases.map(caseBlob);
  const dimensions: CoverageDimension[] = [];
  const gaps: string[] = [];
  const recommendations: CoverageRecommendation[] = [];
  const addRec = (description: string, priority: CoverageRecommendation['priority'], dimension: string) => {
    gaps.push(description);
    recommendations.push({ description, priority, dimension });
  };

  // 1) requirement / assertion：业务规则覆盖
  const rules = req.businessRules ?? [];
  const coveredRules = rules.filter((r) => isRuleCovered(r, blobs));
  dimensions.push(dim('requirement', coveredRules.length, rules.length));
  dimensions.push(dim('assertion', coveredRules.length, rules.length));
  for (const r of rules) {
    if (!coveredRules.includes(r)) {
      addRec(`业务规则「${r}」无对应断言覆盖`, 'P1', 'requirement');
    }
  }

  // 2) parameter：需求参数取值覆盖
  const paramValues = collectParamValues(req);
  const allValues: string[] = [];
  const coveredValues = new Set<string>();
  for (const [name, values] of paramValues) {
    allValues.push(...values.map((v) => `${name}=${v}`));
    for (const v of values) {
      const hit = cases.some((c) => caseInputValues(c).includes(v));
      if (hit) coveredValues.add(`${name}=${v}`);
    }
  }
  dimensions.push(dim('parameter', coveredValues.size, allValues.length));

  // 3) boundary：边界用例覆盖（boundary/edge 标签）
  const boundaryCases = cases.filter((c) => c.tags.some((t) => /boundary|edge|边界/i.test(t)));
  const needsBoundary = paramValues.size > 0;
  dimensions.push(dim('boundary', Math.min(boundaryCases.length, 1), needsBoundary ? 1 : 0));

  // 4) exception：异常/超时风险覆盖
  const needException = (req.risks ?? []).some((r) => /exception|timeout|异常|超时/i.test(r)) || (req.risks ?? []).includes('exception');
  const exceptionCases = cases.filter((c) => c.tags.some((t) => /exception|error|异常|失败|timeout/i.test(t)));
  dimensions.push(dim('exception', needException && exceptionCases.length ? 1 : 0, needException ? 1 : 0));
  if (needException && !exceptionCases.length) {
    addRec('异常/超时场景缺失：需求含异常风险但无异常用例', 'P2', 'exception');
  }

  // 5) risk：风险标签覆盖
  const risks = req.risks ?? [];
  const coveredRisks = risks.filter((r) => cases.some((c) => c.tags.some((t) => t.toLowerCase() === r.toLowerCase() || t.includes(r))));
  dimensions.push(dim('risk', coveredRisks.length, risks.length));
  for (const r of risks) {
    if (!coveredRisks.includes(r)) {
      addRec(`风险「${r}」无对应标签用例覆盖`, 'P2', 'risk');
    }
  }

  // 6) history：历史缺陷关键词覆盖（2-gram 匹配）
  const defects = input.historicalDefects ?? [];
  const coveredDefects = defects.filter((d) => isRuleCovered(d, blobs));
  dimensions.push(dim('history', coveredDefects.length, defects.length));
  for (const d of defects) {
    if (!coveredDefects.includes(d)) {
      addRec(`历史缺陷「${d}」无对应用例覆盖`, 'P2', 'history');
    }
  }

  // 7) 组合缺口：两个需求参数取值各自被覆盖但无单一用例同时覆盖
  const paramPairs = detectCombinationGaps(cases, paramValues);
  for (const [a, b] of paramPairs) {
    addRec(`组合场景缺失：无单一用例同时覆盖「${a}」与「${b}」`, 'P2', 'parameter');
  }

  // 8) 边界缺失：参数存在但无 boundary 用例
  if (needsBoundary && !boundaryCases.length) {
    addRec('边界场景缺失：需求含参数组合但无 boundary/edge 用例', 'P2', 'boundary');
  }

  return buildCoverage({
    feature: req.feature,
    dimensions,
    coverage: Object.fromEntries(dimensions.map((d) => [d.name, d.rate])),
    gaps,
    recommendedCases: recommendations,
    confidence: 0.95,
  });
}

function dim(name: string, covered: number, total: number): CoverageDimension {
  return { name, covered, total, rate: total > 0 ? Math.round((covered / total) * 1000) / 10 : 100 };
}

/** 检测组合缺口：两参数取值各自有覆盖，但无单一用例同时覆盖两者 */
function detectCombinationGaps(cases: TestCase[], paramValues: Map<string, string[]>): Array<[string, string]> {
  const gaps: Array<[string, string]> = [];
  const entries = Array.from(paramValues.entries());
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const [nameA, valsA] = entries[i];
      const [nameB, valsB] = entries[j];
      for (const va of valsA) {
        for (const vb of valsB) {
          const hasBoth = cases.some((c) => {
            const vals = caseInputValues(c);
            return vals.includes(va) && vals.includes(vb);
          });
          if (!hasBoth) {
            // 各自需被覆盖（否则已在参数维度缺口）
            const aCovered = cases.some((c) => caseInputValues(c).includes(va));
            const bCovered = cases.some((c) => caseInputValues(c).includes(vb));
            if (aCovered && bCovered) {
              gaps.push([`${nameA}=${va}`, `${nameB}=${vb}`]);
            }
          }
        }
      }
    }
  }
  return gaps;
}
