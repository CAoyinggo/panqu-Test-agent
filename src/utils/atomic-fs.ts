// 原子文件写入 + 跨进程文件锁（JSON Memory 并发安全基础设施）。
//
// 修复的旧问题：固定 `<file>.tmp` 临时文件 —— 多实例并发写同一 tmp → 内容交错损坏、
// rename 竞态互相覆盖；且整文件替换无版本检测 → 后写者抹掉先写者的记录（丢更新）。
//
// 短期方案（本模块）：
//   writeAtomic —— UUID 临时文件 + fsync + rename（POSIX 原子替换），实例间 tmp 永不共享；
//   withFileLock —— O_EXCL 独占锁 + 指数退避重试 + 超时 + 陈旧锁接管 + 属主安全释放。
//   调用方在锁内做 read-merge-write（CAS：版本变化即重读合并）。
// 长期方向：JSON Memory → SQLite / PostgreSQL（见 SqliteMemoryStore）。
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import { ensureDir } from './fs-utils.js';

/**
 * 原子写入：`<file>.<uuid>.tmp` + fsync + rename。
 * - UUID 临时文件：多实例并发写互不交错（旧固定 .tmp 的覆盖/损坏根源）；
 * - fsync：落盘后再 rename，崩溃时不产生半写文件被 rename 成正式文件；
 * - rename：POSIX 原子替换，读者永远看到完整旧版或完整新版。
 */
export function writeAtomic(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    // wx 防止极端 UUID 冲突覆盖已有临时文件；0600 避免 Memory 内容被同机其他用户读取。
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, content, 'utf-8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, filePath);

    // 尽力同步目录项，确保掉电后 rename 也具备持久性；部分平台不允许 fsync 目录。
    try {
      const dirFd = fs.openSync(path.dirname(filePath), 'r');
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } catch { /* 平台不支持目录 fsync 时保留 rename 原子性 */ }
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* 已关闭 */ }
    }
    // 写入/fsync/rename 任一阶段失败时不遗留临时文件。
    try { fs.unlinkSync(tmp); } catch { /* 已 rename 或尚未创建 */ }
  }
}

/** 文件锁选项 */
export interface FileLockOptions {
  /** 获取锁超时毫秒（默认 5000；超时抛错，调用方决定降级） */
  timeoutMs?: number;
  /** 陈旧锁接管阈值毫秒（持锁进程崩溃遗留的锁，默认 10000） */
  staleMs?: number;
  /** 首次重试延迟毫秒（指数退避基数，默认 20） */
  retryBaseMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const LOCAL_HOST = os.hostname();

interface LockLease {
  owner: string;
  pid: number;
  hostname: string;
  createdAt: number;
}

function parseLease(value: string): LockLease | undefined {
  try {
    const lease = JSON.parse(value) as Partial<LockLease>;
    if (
      typeof lease.owner === 'string'
      && typeof lease.pid === 'number'
      && typeof lease.hostname === 'string'
      && typeof lease.createdAt === 'number'
    ) return lease as LockLease;
  } catch { /* 兼容旧版仅写 UUID 的锁文件 */ }
  return undefined;
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * 仅接管可确定已失效的本机锁。跨主机锁无法可靠判断进程存活，宁可超时也不冒险双写。
 * `.reclaim` 作为 O_EXCL 仲裁锁，避免多个等待者同时删除旧锁后互相删除新锁。
 */
function reclaimStaleLock(lockPath: string, staleMs: number, contender: LockLease): boolean {
  // 热路径先看锁龄，避免每次普通竞争都创建仲裁文件。
  try {
    if (Date.now() - fs.statSync(lockPath).mtimeMs <= staleMs) return false;
  } catch {
    return true;
  }

  const reclaimPath = `${lockPath}.reclaim`;
  const reclaimBody = JSON.stringify(contender);
  try {
    fs.writeFileSync(reclaimPath, reclaimBody, { flag: 'wx', mode: 0o600 });
  } catch {
    return false;
  }

  try {
    let raw: string;
    let stat: fs.Stats;
    try {
      raw = fs.readFileSync(lockPath, 'utf-8');
      stat = fs.statSync(lockPath);
    } catch {
      return true;
    }
    if (Date.now() - stat.mtimeMs <= staleMs) return false;

    const lease = parseLease(raw);
    // 无法验证属主的旧格式/损坏锁一律不自动删除，避免把仍活跃的锁误判为死亡锁。
    if (!lease) return false;
    if (lease.hostname !== LOCAL_HOST) return false;
    if (processAlive(lease.pid)) return false;

    // 仲裁锁存在期间，新获取者会等待；再次比对内容，确保没有接管变化。
    try {
      if (fs.readFileSync(lockPath, 'utf-8') !== raw) return false;
      fs.unlinkSync(lockPath);
      return true;
    } catch {
      return false;
    }
  } finally {
    try {
      if (fs.readFileSync(reclaimPath, 'utf-8') === reclaimBody) fs.unlinkSync(reclaimPath);
    } catch { /* 仲裁锁已不存在 */ }
  }
}

/**
 * 跨进程文件锁：`<file>.lock`（O_EXCL 独占创建）。
 * - 重试获取（指数退避，封顶 100ms）+ 总超时；
 * - 陈旧锁仅在能确认本机持有进程死亡时接管；
 * - 释放时校验锁内容 == 自身 UUID，只释放自己的锁（防止误删他人锁）。
 */
export async function withFileLock<T>(
  filePath: string,
  fn: () => Promise<T>,
  opts: FileLockOptions = {},
): Promise<T> {
  const { timeoutMs = 5_000, staleMs = 10_000, retryBaseMs = 20 } = opts;
  const lockPath = `${filePath}.lock`;
  const lease: LockLease = {
    owner: randomUUID(),
    pid: process.pid,
    hostname: LOCAL_HOST,
    createdAt: Date.now(),
  };
  const leaseBody = JSON.stringify(lease);
  ensureDir(path.dirname(lockPath));

  const deadline = Date.now() + timeoutMs;
  let delay = retryBaseMs;
  for (;;) {
    try {
      // 接管仲裁期间不得创建新锁，否则旧锁删除者可能误删刚创建的新锁。
      if (fs.existsSync(`${lockPath}.reclaim`)) throw Object.assign(new Error('lock reclaim in progress'), { code: 'EEXIST' });
      fs.writeFileSync(lockPath, leaseBody, { flag: 'wx', mode: 0o600 }); // O_EXCL：独占创建
      break; // 获得锁
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (reclaimStaleLock(lockPath, staleMs, lease)) continue;
      if (Date.now() > deadline) {
        throw new Error(`文件锁获取超时（${timeoutMs}ms）：${lockPath}`);
      }
      await sleep(delay);
      delay = Math.min(100, delay * 2); // 指数退避封顶
    }
  }

  try {
    return await fn();
  } finally {
    try {
      const holder = parseLease(fs.readFileSync(lockPath, 'utf-8'));
      if (holder?.owner === lease.owner) fs.unlinkSync(lockPath); // 只释放自己的锁
    } catch { /* 锁已被接管/移除 */ }
  }
}

/** 读取强内容指纹，供 CAS 比对；避免相同 size/mtime 下内容变化未被发现。 */
export function fileVersion(filePath: string): string {
  try {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch {
    return 'missing';
  }
}
