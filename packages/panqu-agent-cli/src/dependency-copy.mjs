/**
 * 依赖复制与内部 symlink 安全隔离。
 *
 * 安全要求（对原 workspace 的 node_modules）：
 *   - 不整体 symlink、不 hardlink 普通依赖文件；
 *   - 普通文件递归复制（优先 COPYFILE_FICLONE，回退普通复制），复制后 inode 必须不同于源；
 *   - 对每个 symlink：readlink → 相对当前目录解析 → realpath 最终目标；
 *     最终目标必须位于原 workspace 内，再映射为 snapshot 内相对 symlink；
 *   - broken / ELOOP / 循环 / 逃逸到 workspace 外部 / 特殊文件（socket/FIFO/device）→ fail closed；
 *   - 有界限制（最大深度/条目数）+ AbortSignal；
 *   - 先复制到 <snapshot>/.node_modules.staging-<random>，二次验证后才原子 rename 为 node_modules。
 *
 * 所有错误为结构化 code，供下游 fail-closed 与报告使用。
 */
import {
  mkdirSync, copyFileSync, chmodSync, symlinkSync, readlinkSync,
  realpathSync, lstatSync, statSync, rmSync, renameSync, readdirSync, existsSync,
  constants,
} from 'node:fs';
import { dirname, join, relative, resolve, isAbsolute, sep } from 'node:path';
import { randomBytes } from 'node:crypto';

export const DEPENDENCY_COPY_ERRORS = {
  DEPENDENCY_ENTRY_UNSUPPORTED: 'DEPENDENCY_ENTRY_UNSUPPORTED',
  DEPENDENCY_COPY_LIMIT_EXCEEDED: 'DEPENDENCY_COPY_LIMIT_EXCEEDED',
  DEPENDENCY_COPY_FAILED: 'DEPENDENCY_COPY_FAILED',
  DEPENDENCY_SYMLINK_UNSAFE: 'DEPENDENCY_SYMLINK_UNSAFE',
  DEPENDENCY_SYMLINK_BROKEN: 'DEPENDENCY_SYMLINK_BROKEN',
  DEPENDENCY_SYMLINK_LOOP: 'DEPENDENCY_SYMLINK_LOOP',
  DEPENDENCY_VALIDATION_FAILED: 'DEPENDENCY_VALIDATION_FAILED',
};

const DEFAULT_MAX_DEPTH = 64;
const DEFAULT_MAX_ENTRIES = 200000;
const DEFAULT_MAX_LINK_HOPS = 64;

export function isWithin(child, parent) {
  const c = resolve(child);
  const p = resolve(parent);
  if (c === p || c.startsWith(p + sep)) return true;
  // macOS 存在 /tmp -> /private/tmp、/var -> /private/var 等路径软链，
  // realpath 与逻辑路径会不一致，必须再做一次实路径比较。
  try {
    const rc = realpathSync(c);
    const rp = realpathSync(p);
    return rc === rp || rc.startsWith(rp + sep);
  } catch {
    return false;
  }
}

/** lstat 分类。 */
export function classifyEntry(st) {
  if (st.isSymbolicLink()) return 'symlink';
  if (st.isDirectory()) return 'directory';
  if (st.isFile()) return 'file';
  // socket / FIFO / block device / char device / 其它无法识别类型
  return 'special';
}

/** 解析一个源 symlink 的最终 realpath，并校验其在 workspaceRoot 内。 */
export function resolveSymlinkSafely(srcPath, workspaceRoot, maxHops = DEFAULT_MAX_LINK_HOPS) {
  let current = srcPath;
  let hops = 0;
  const seen = new Set();
  while (true) {
    if (hops >= maxHops) return { ok: false, code: DEPENDENCY_COPY_ERRORS.DEPENDENCY_SYMLINK_LOOP, path: srcPath };
    hops += 1;
    let raw;
    try {
      raw = readlinkSync(current);
    } catch (err) {
      return { ok: false, code: DEPENDENCY_COPY_ERRORS.DEPENDENCY_SYMLINK_BROKEN, path: current, reason: String(err && err.code || err) };
    }
    // 相对链接基于链接所在目录解析
    const target = isAbsolute(raw) ? raw : resolve(dirname(current), raw);
    const key = target;
    if (seen.has(key)) return { ok: false, code: DEPENDENCY_COPY_ERRORS.DEPENDENCY_SYMLINK_LOOP, path: current };
    seen.add(key);
    let st;
    try {
      st = lstatSync(target);
    } catch (err) {
      return { ok: false, code: DEPENDENCY_COPY_ERRORS.DEPENDENCY_SYMLINK_BROKEN, path: current, reason: String(err && err.code || err) };
    }
    if (st.isSymbolicLink()) {
      current = target;
      continue;
    }
    // 最终目标落点（文件或目录）
    let finalTarget;
    try {
      finalTarget = realpathSync(target);
    } catch (err) {
      return { ok: false, code: DEPENDENCY_COPY_ERRORS.DEPENDENCY_SYMLINK_BROKEN, path: current, reason: String(err && err.code || err) };
    }
    if (!isWithin(finalTarget, workspaceRoot)) {
      return { ok: false, code: DEPENDENCY_COPY_ERRORS.DEPENDENCY_SYMLINK_UNSAFE, path: srcPath, target: finalTarget };
    }
    // relTarget 用逻辑 target（非 realpath）计算，避免 macOS /var->/private/var 造成错误相对路径
    return { ok: true, finalTarget, relTarget: relative(workspaceRoot, target), type: st.isDirectory() ? 'dir' : 'file' };
  }
}

/**
 * 预检复制计划：递归遍历，分类 + 校验 symlink，执行有界限制。
 * 返回 { ok:true, counts } 或 { ok:false, code, path }。
 */
export function planDependencyCopy(srcNodeModules, workspaceRoot, {
  maxDepth = DEFAULT_MAX_DEPTH, maxEntries = DEFAULT_MAX_ENTRIES, signal = null,
} = {}) {
  const counts = { files: 0, dirs: 0, symlinks: 0, total: 0 };

  function walk(absDir, relDir, depth) {
    if (signal && signal.aborted) throw { code: 'DEPENDENCY_ABORTED' };
    if (depth > maxDepth) return { ok: false, code: DEPENDENCY_COPY_ERRORS.DEPENDENCY_COPY_LIMIT_EXCEEDED, path: relDir };
    let names;
    try {
      names = readdirSync(absDir);
    } catch (err) {
      return { ok: false, code: DEPENDENCY_COPY_ERRORS.DEPENDENCY_COPY_FAILED, path: relDir, reason: String(err && err.code || err) };
    }
    for (const name of names) {
      const abs = join(absDir, name);
      const rel = relDir ? `${relDir}/${name}` : name;
      counts.total += 1;
      if (counts.total > maxEntries) return { ok: false, code: DEPENDENCY_COPY_ERRORS.DEPENDENCY_COPY_LIMIT_EXCEEDED, path: rel };
      let st;
      try {
        st = lstatSync(abs);
      } catch (err) {
        return { ok: false, code: DEPENDENCY_COPY_ERRORS.DEPENDENCY_COPY_FAILED, path: rel, reason: String(err && err.code || err) };
      }
      const kind = classifyEntry(st);
      if (kind === 'special') return { ok: false, code: DEPENDENCY_COPY_ERRORS.DEPENDENCY_ENTRY_UNSUPPORTED, path: rel };
      if (kind === 'directory') {
        counts.dirs += 1;
        const r = walk(abs, rel, depth + 1);
        if (r && !r.ok) return r;
      } else if (kind === 'file') {
        counts.files += 1;
      } else {
        counts.symlinks += 1;
        const r = resolveSymlinkSafely(abs, workspaceRoot);
        if (!r.ok) return { ok: false, code: r.code, path: rel, reason: r.reason };
      }
    }
    return { ok: true };
  }

  const res = walk(srcNodeModules, '', 1);
  if (res && !res.ok) return res;
  return { ok: true, counts };
}

/**
 * 物化复制：把源 node_modules 树安全复制到 stagingDir。
 * 普通文件 COPYFILE_FICLONE（回退普通复制）+ 保留 mode；symlink 安全映射。
 */
export function materializeDependencyCopy({ srcNodeModules, stagingDir, workspaceRoot, plan, signal = null }) {
  function walk(absDir, relDir, depth) {
    if (signal && signal.aborted) return { ok: false, code: 'DEPENDENCY_ABORTED' };
    let names;
    try {
      names = readdirSync(absDir);
    } catch (err) {
      return { ok: false, code: DEPENDENCY_COPY_ERRORS.DEPENDENCY_COPY_FAILED, path: relDir, reason: String(err && err.code || err) };
    }
    for (const name of names) {
      const abs = join(absDir, name);
      const rel = relDir ? `${relDir}/${name}` : name;
      const st = lstatSync(abs);
      const kind = classifyEntry(st);
      const dst = join(stagingDir, rel);
      if (kind === 'directory') {
        mkdirSync(dst, { recursive: true });
        const r = walk(abs, rel, depth + 1);
        if (r && !r.ok) return r;
      } else if (kind === 'file') {
        copyFileOne(abs, dst);
      } else if (kind === 'symlink') {
        // 安全映射：解析最终目标 → 映射为 snapshot 内相对链接
        const r = resolveSymlinkSafely(abs, workspaceRoot);
        if (!r.ok) return { ok: false, code: r.code, path: rel, reason: r.reason };
        // rel 为 node_modules 相对路径；最终落点 = snapshot/node_modules/<rel>
        const linkDir = dirname(join('node_modules', rel));
        const relLink = relative(linkDir, r.relTarget) || '.';
        mkdirSync(dirname(dst), { recursive: true });
        try {
          symlinkSync(relLink, dst, r.type);
        } catch (err) {
          return { ok: false, code: DEPENDENCY_COPY_ERRORS.DEPENDENCY_COPY_FAILED, path: rel, reason: String(err && err.code || err) };
        }
      } else {
        return { ok: false, code: DEPENDENCY_COPY_ERRORS.DEPENDENCY_ENTRY_UNSUPPORTED, path: rel };
      }
    }
    return { ok: true };
  }
  return walk(srcNodeModules, '', 1);
}

/** 复制单个普通文件：COPYFILE_FICLONE 优先，回退普通复制；保留 mode；校验 inode 不同。 */
export function copyFileOne(src, dst) {
  mkdirSync(dirname(dst), { recursive: true });
  const srcStat = lstatSync(src);
  try {
    copyFileSync(src, dst, constants.COPYFILE_FICLONE);
  } catch {
    // COPYFILE_FICLONE 不可用则回退普通复制
    copyFileSync(src, dst);
  }
  // 保留 mode（copyFileSync 不复制 mode）
  chmodSync(dst, srcStat.mode & 0o7777);
  // 确保不是 hardlink（inode 不同）
  const srcIno = statSync(src).ino;
  const dstIno = statSync(dst).ino;
  if (srcIno === dstIno) {
    throw new Error(`hardlink 意外产生: ${src} -> ${dst}`);
  }
  return { ok: true };
}

/** 复制后二次验证：snapshot 内所有 symlink 的最终 realpath 必须位于 snapshotRoot 内。 */
export function validateMaterializedDependencies(nodeModulesDir, snapshotRoot, { signal = null } = {}) {
  function walk(absDir, relDir) {
    if (signal && signal.aborted) return { ok: false, code: 'DEPENDENCY_ABORTED' };
    let names;
    try {
      names = readdirSync(absDir);
    } catch {
      return { ok: true }; // 空/不存在视为通过
    }
    for (const name of names) {
      const abs = join(absDir, name);
      const rel = relDir ? `${relDir}/${name}` : name;
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        const r = walk(abs, rel);
        if (r && !r.ok) return r;
      } else if (st.isSymbolicLink()) {
        const raw = readlinkSync(abs);
        const target = isAbsolute(raw) ? raw : resolve(dirname(abs), raw);
        let real;
        try {
          real = realpathSync(target);
        } catch (err) {
          return { ok: false, code: DEPENDENCY_COPY_ERRORS.DEPENDENCY_SYMLINK_BROKEN, path: rel, reason: String(err && err.code || err) };
        }
        if (!isWithin(real, snapshotRoot)) {
          return { ok: false, code: DEPENDENCY_COPY_ERRORS.DEPENDENCY_SYMLINK_UNSAFE, path: rel, target: real };
        }
      }
    }
    return { ok: true };
  }
  return walk(nodeModulesDir, '');
}

/** 清理 staging 目录（仅限本模块创建的 staging 前缀）。 */
export function cleanupDependencyCopy(stagingDir) {
  if (!stagingDir || !stagingDir.includes('.node_modules.staging-')) return { ok: true, removed: false };
  try {
    rmSync(stagingDir, { recursive: true, force: true });
    return { ok: true, removed: true };
  } catch (err) {
    return { ok: false, removed: false, reason: String(err && err.code || err) };
  }
}

export function stagingDirName() {
  return `.node_modules.staging-${randomBytes(6).toString('hex')}`;
}

/**
 * 顶层编排：plan → materialize → rename → validate；任一失败清理 staging。
 * @returns { ok:true } 或 { ok:false, code, path }
 */
export function copyNodeModulesSafe({ srcNodeModules, workspaceRoot, snapshotRoot, maxDepth, maxEntries, signal }) {
  // 顶层 node_modules 必须是真实目录；symlink/文件/特殊文件一律 fail closed，绝不跟随复制。
  let srcSt;
  try {
    srcSt = lstatSync(srcNodeModules);
  } catch {
    return { ok: true }; // 不存在 → 无依赖可复制
  }
  if (!srcSt.isDirectory()) {
    return { ok: false, code: DEPENDENCY_COPY_ERRORS.DEPENDENCY_SYMLINK_UNSAFE, path: 'node_modules' };
  }

  const staging = join(snapshotRoot, stagingDirName());
  const finalNodeModules = join(snapshotRoot, 'node_modules');

  const plan = planDependencyCopy(srcNodeModules, workspaceRoot, { maxDepth, maxEntries, signal });
  if (!plan.ok) { cleanupDependencyCopy(staging); return plan; }

  try {
    mkdirSync(staging, { recursive: true });
  } catch (err) {
    return { ok: false, code: DEPENDENCY_COPY_ERRORS.DEPENDENCY_COPY_FAILED, reason: String(err && err.code || err) };
  }

  const mat = materializeDependencyCopy({ srcNodeModules, stagingDir: staging, workspaceRoot, plan, signal });
  if (!mat.ok) { cleanupDependencyCopy(staging); return mat; }

  try {
    renameSync(staging, finalNodeModules);
  } catch (err) {
    cleanupDependencyCopy(staging);
    return { ok: false, code: DEPENDENCY_COPY_ERRORS.DEPENDENCY_COPY_FAILED, reason: String(err && err.code || err) };
  }

  const val = validateMaterializedDependencies(finalNodeModules, snapshotRoot, { signal });
  if (!val.ok) {
    // 二次验证失败：移除已就位的 node_modules，fail closed
    try { rmSync(finalNodeModules, { recursive: true, force: true }); } catch { /* ignore */ }
    return val;
  }
  return { ok: true };
}