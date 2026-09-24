/**
 * Legacy（概率）分流资格 — 可确定性建模 + 可测性边界
 * =============================================================================
 * `routeMode='legacy'` 时（NewAPI 故障回切），走 `LegacyDiversionService::check`
 * （`application/admin/service/LegacyDiversionService.php`，2026-09-24 逐行核对）：
 *   ratio 累计区间随机落点 → 通用规则 → 角色/时间/积分上限 → 限速锁 → 命中 line(2/5/6/7)。
 *
 * 可测性边界（诚实）：
 *  - ✅ 可确定性建模（本模块）：`passesLegacyCommonRules`(任务型/模型/分辨率/画幅/真人像/参考视频/cueword)、
 *    `matchLegacyLineByRatio`(给定 bucket 的区间匹配)、`isLegacyRoleAllowed`、`isLegacyTimeAllowed`。
 *  - ❌ 非确定/有状态（运行时，本模块不判定，仅标注 runtimeGated）：
 *    `createDiversionBucket` 随机落点（pid+hrtime+random_bytes）；`isDiversionScoreLimitReached` 查 pq_score_log 实时累计；
 *    `acquireDiversionSpeedLock` Redis 限速锁（有副作用）。
 *
 * 纯逻辑、零 I/O：随机 bucket、当前分钟、角色/时间/ratio 配置均由调用方注入。
 * 常量核对：SEEDANCE_TYPE_UNIVERSAL=28 / FIRST_LAST_FRAME=29；线路 2=RH/5=SJB/6=XC/7=ZQ。
 */

export const SEEDANCE_TYPE_UNIVERSAL = 28;
export const SEEDANCE_TYPE_FIRST_LAST_FRAME = 29;

export interface LegacyRequest {
  taskType?: number;
  selmodelsId?: number;
  hasRealHumanPortrait?: boolean;
  refVideos?: boolean; // ref_videos 非空
  cuewordLength?: number;
  outputFormat?: string;
  videoResolution?: string;
  resolution?: string;
  videoAspectRatio?: string;
}

/** 通用规则（LegacyDiversionService::passesDiversionCommonRules :53-119 的忠实镜像）。 */
export function passesLegacyCommonRules(req: LegacyRequest, line: number): boolean {
  const supportedTaskType =
    line !== 2 ? [SEEDANCE_TYPE_UNIVERSAL] : [SEEDANCE_TYPE_UNIVERSAL, SEEDANCE_TYPE_FIRST_LAST_FRAME];
  if (req.taskType !== undefined && !supportedTaskType.includes(req.taskType)) return false;

  let supportedModelIds = [15, 16];
  if (line === 5) supportedModelIds = [15, 16, 78];
  else if (line === 7) supportedModelIds = [15, 78];
  if (req.selmodelsId !== undefined && !supportedModelIds.includes(Number(req.selmodelsId))) return false;

  if (line !== 6 && req.hasRealHumanPortrait) return false;
  if (req.refVideos) return false;
  if ((req.cuewordLength ?? 0) > 5000) return false;

  let whiteResolution = ['720p', '1080p'];
  const model = Number(req.selmodelsId);
  if (line === 5) {
    whiteResolution.push('480p', '4k');
    if (model === 78) whiteResolution = ['720p', '480p'];
  }
  if (line === 6) {
    if ((req.outputFormat ?? '').toLowerCase() === 'mov') return false;
    const a = req.videoAspectRatio ?? '';
    // 注：line6 支持模型是 [15,16]（见上），model===78 分支在 line6 实为死代码（78 已被模型门槛挡下）——忠实镜像 SUT。
    if (model === 78 && !['16:9', '9:16', '1:1'].includes(a)) return false;
    if (model === 16 && !['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'].includes(a)) return false;
    if (model === 15 && !['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'].includes(a)) return false;
    whiteResolution.push('480p');
  }
  if (line === 7) {
    whiteResolution.push('480p');
    if (model === 78) whiteResolution = ['720p', '480p'];
  }
  for (const key of ['videoResolution', 'resolution'] as const) {
    const v = req[key];
    if (v !== undefined && !whiteResolution.includes(String(v).toLowerCase().trim())) return false;
  }
  return true;
}

// APPEND_LEGACY

/** ratio 累计区间匹配（matchDiversionLineByRatio :152-181）。orderedLines 按 Ai::diversion() 顺序给出，bucket∈[0,100)。 */
export function matchLegacyLineByRatio(orderedLines: Array<{ line: number; ratio: number }>, bucket: number): number {
  let cumulative = 0;
  for (const { line, ratio } of orderedLines) {
    const r = Math.min(100, Math.max(0, Number(ratio) || 0));
    if (r <= 0) continue;
    const next = Math.min(100, cumulative + r);
    if (bucket >= cumulative && bucket < next) return line;
    cumulative = next;
    if (cumulative >= 100) break;
  }
  return 0;
}

/** 角色组匹配（isDiversionRoleAllowed :223-240）。role 为逗号分隔；空=放行。 */
export function isLegacyRoleAllowed(roleCsv: string | null | undefined, groupIds: Array<string | number>): boolean {
  const roles = String(roleCsv ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (roles.length === 0) return true;
  return groupIds.some((g) => roles.includes(String(g)));
}

function timeToMinutes(t: string): number | false {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(t.trim());
  if (!m) return false;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return false;
  return h * 60 + min;
}

/** 时间段匹配（isDiversionTimeAllowed :248-272）。空=不放行；currentMinutes 由调用方注入（date('H:i')）。 */
export function isLegacyTimeAllowed(intervalsCsv: string | null | undefined, currentMinutes: number): boolean {
  const s = String(intervalsCsv ?? '').trim();
  if (s === '') return false;
  for (const range of s.split(',')) {
    const r = range.trim();
    if (r === '' || !r.includes('-')) continue;
    const [start, end] = r.split('-', 2);
    const sm = timeToMinutes(start);
    const em = timeToMinutes(end);
    if (sm !== false && em !== false && currentMinutes >= sm && currentMinutes < em) return true;
  }
  return false;
}

export type LegacyDecision =
  | 'LEGACY_HIT' // 确定性部分全通过（仍受 runtimeGated 的积分上限/限速锁约束）
  | 'RATIO_MISS' // 随机落点未命中任何线路
  | 'COMMON_RULES_FAIL'
  | 'ROLE_DENIED'
  | 'TIME_DENIED';

export interface LegacyDiversionInput {
  req: LegacyRequest;
  orderedLines: Array<{ line: number; ratio: number }>;
  bucket: number; // 注入随机落点（真实为 createDiversionBucket，0..99.99）
  groupIds: Array<string | number>;
  currentMinutes: number; // 注入当前分钟（date('H:i')）
  lineConfig?: Record<number, { role?: string; time_interval?: string }>;
}

/**
 * Legacy 分流的**可确定性**裁决（到角色/时间为止）。积分上限与限速锁属运行时/有状态，
 * 命中时以 runtimeGated 标注、本模块不判定。忠实镜像 check() 的确定性前半段。
 */
export function evaluateLegacyDiversion(input: LegacyDiversionInput): {
  line: number;
  decision: LegacyDecision;
  reason: string;
  runtimeGated?: string[];
} {
  const line = matchLegacyLineByRatio(input.orderedLines, input.bucket);
  if (line === 0) return { line: 0, decision: 'RATIO_MISS', reason: `随机落点 ${input.bucket} 未命中任何 ratio 区间` };
  if (!passesLegacyCommonRules(input.req, line)) {
    return {
      line: 0,
      decision: 'COMMON_RULES_FAIL',
      reason: `线路 ${line} 通用规则不通过（任务型/模型/分辨率/画幅/真人像等）`,
    };
  }
  const cfg = input.lineConfig?.[line] ?? {};
  if (!isLegacyRoleAllowed(cfg.role, input.groupIds)) {
    return { line: 0, decision: 'ROLE_DENIED', reason: `线路 ${line} 角色组不匹配` };
  }
  if (!isLegacyTimeAllowed(cfg.time_interval, input.currentMinutes)) {
    return { line: 0, decision: 'TIME_DENIED', reason: `线路 ${line} 不在分流时间段内` };
  }
  return {
    line,
    decision: 'LEGACY_HIT',
    reason: `命中线路 ${line}（确定性部分通过）`,
    runtimeGated: ['score_limit(pq_score_log 实时累计)', 'speed_lock(Redis 限速)'],
  };
}
