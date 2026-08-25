// Run ID / Task ID：运行标识与任务标识的确定性来源（并发、存储稳定性基础设施）。
//
// 修复的旧问题：taskId = 需求文本前 20 字符 —— 同一需求并发运行产生相同 taskId，
// 导致任务记录互相覆盖（output/tasks/<taskId>.json）、Trace 混流、Memory 历史污染。
//
// 新模型（三字段分别保存，职责分离）：
//   runId            —— 每次运行的唯一标识（ULID：时间有序 + 随机尾缀），用于文件名 / Trace 键，
//                       同需求并发运行互不覆盖；
//   taskId           —— 任务的稳定逻辑标识（由需求内容哈希派生），同一需求跨运行保持一致，
//                       供历史聚合 / --resume 检索；
//   requirementsHash —— 需求内容 SHA-256（归一化后），内容变化即新任务；
//   createdAt        —— 运行创建时间（ISO）。
import { createHash, randomBytes } from 'node:crypto';

/** Crockford Base32（ULID 标准字母表，排除 I/L/O/U 防误读） */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODING_LEN = 32;

/** 时间戳编码长度（10 字符 = 48bit 毫秒精度） */
const TIME_LEN = 10;
/** 随机尾缀长度（16 字符 = 80bit 随机） */
const RANDOM_LEN = 16;

function encodeTime(nowMs: number, length: number): string {
  let time = nowMs;
  let out = '';
  for (let i = 0; i < length; i++) {
    out = ENCODING[time % ENCODING_LEN] + out;
    time = Math.floor(time / ENCODING_LEN);
  }
  return out;
}

function encodeRandom(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    // 256 % 32 == 0：无取模偏差
    out += ENCODING[bytes[i] % ENCODING_LEN];
  }
  return out;
}

/**
 * 生成 ULID（26 字符：10 时间 + 16 随机）。
 * 时间有序（字典序即创建序，便于按目录扫描排序），随机尾缀保证同毫秒并发不冲突。
 */
export function generateRunId(nowMs: number = Date.now()): string {
  return encodeTime(nowMs, TIME_LEN) + encodeRandom(RANDOM_LEN);
}

/** ULID 格式校验（26 字符 Crockford Base32） */
export function isUlid(value: string): boolean {
  return /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/.test(value);
}

/**
 * 需求内容哈希：SHA-256（先做空白归一化 —— 行尾/缩进差异不应产生新任务）。
 */
export function hashRequirement(requirementText: string): string {
  const normalized = String(requirementText ?? '')
    .replace(/\r\n/g, '\n')
    .trim();
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/**
 * 由需求哈希派生稳定 taskId：同一需求内容 → 同一 taskId（跨运行一致，供聚合/检索）；
 * 不同内容 → 不同 taskId。
 */
export function deriveTaskId(requirementsHash: string): string {
  return `task-${requirementsHash.slice(0, 12)}`;
}

/** 一次性生成运行标识三件套（runId / taskId / requirementsHash / createdAt） */
export function createRunIdentity(requirementText: string, nowMs: number = Date.now()): {
  runId: string;
  taskId: string;
  requirementsHash: string;
  createdAt: string;
} {
  const requirementsHash = hashRequirement(requirementText);
  return {
    runId: generateRunId(nowMs),
    taskId: deriveTaskId(requirementsHash),
    requirementsHash,
    createdAt: new Date(nowMs).toISOString(),
  };
}
