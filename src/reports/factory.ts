// 报告器工厂：按名称获取报告器，支持同时输出多份
import type { Reporter } from './index.js';
import { HtmlReporter } from './html-reporter.js';
import { JsonReporter } from './json-reporter.js';
import { JunitReporter } from './junit-reporter.js';

const REGISTRY: Record<string, Reporter> = {
  html: new HtmlReporter(),
  json: new JsonReporter(),
  junit: new JunitReporter(),
};

/** 支持的报告器名称 */
export const REPORTER_NAMES = Object.keys(REGISTRY);

/** 按名称获取报告器，默认 html */
export function getReporter(name?: string | null): Reporter {
  const n = (name || 'html').toLowerCase();
  const r = REGISTRY[n];
  if (!r) throw new Error(`未知报告器：${name}（可选 ${REPORTER_NAMES.join(', ')}）`);
  return r;
}

/** 获取多个报告器（逗号分隔，如 html,json,junit） */
export function getReporters(names?: string | null): Reporter[] {
  const list = (names || 'html')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
  return list.map((n) => getReporter(n));
}
