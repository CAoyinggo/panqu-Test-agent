// Agent Evaluation Benchmark：Self-Healing 自愈基准（Phase 18）
// 路径失效样例（应产出 SUGGESTED 建议，oldPath→newPath）+ 非路径失效对照（应不产出建议）。
export interface BenchmarkHealing {
  id: string;
  caseId: string;
  name: string;
  error: string;
  timedOut?: boolean;
  checks?: Array<{ name: string; pass: boolean; detail: string }>;
  actualSchema: Record<string, unknown>;
  /** 期望的失效旧路径（无则 expectNoSuggestion） */
  expectedOldPath?: string;
  /** 期望的最可能新路径 */
  expectedNewPath?: string;
  /** 是否期望不产出建议（非路径失效） */
  expectNoSuggestion?: boolean;
}

export const HEALING_BENCHMARK: BenchmarkHealing[] = [
  { id: 'heal-001', caseId: 'wan3-401', name: '视频 URL 断言', error: '断言 data.result.video.url 为空', checks: [{ name: '视频 URL 存在', pass: false, detail: 'cannot read data.result.video.url, got undefined' }], actualSchema: { data: { output: { video: { url: 'x' } } } }, expectedOldPath: 'data.result.video.url', expectedNewPath: 'data.output.video.url' },
  { id: 'heal-002', caseId: 'wan3-402', name: '任务状态断言', error: '断言 data.task.status 失败：got undefined', checks: [{ name: '任务状态', pass: false, detail: 'data.task.status undefined' }], actualSchema: { data: { job: { status: 'SUCCESS' } } }, expectedOldPath: 'data.task.status', expectedNewPath: 'data.job.status' },
  { id: 'heal-003', caseId: 'wan3-403', name: '视频列表断言', error: 'data.videos.list 为空', checks: [{ name: '视频列表', pass: false, detail: 'data.videos.list is undefined' }], actualSchema: { data: { videos: { items: [1] } } }, expectedOldPath: 'data.videos.list', expectedNewPath: 'data.videos.items' },
  { id: 'heal-004', caseId: 'wan3-404', name: '非路径失效 503', error: 'HTTP 503 model service unavailable', actualSchema: {}, expectNoSuggestion: true },
  { id: 'heal-005', caseId: 'wan3-405', name: '非路径失效超时', error: 'task timed out', timedOut: true, actualSchema: {}, expectNoSuggestion: true },
];
