/**
 * 测试共享工具：临时 Git 仓库、命令执行、目录哈希。
 * 所有 `git config` 均以 `-C <临时目录>` 作用到隔离的临时仓库，绝不触碰用户全局配置。
 */
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const PACKAGE_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

export function tmpDir(prefix = 'panqu-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function run(bin, args, opts = {}) {
  const res = spawnSync(bin, args, { encoding: 'utf8', ...opts });
  return {
    ok: res.status === 0,
    code: res.status,
    signal: res.signal,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    error: res.error ? String(res.error) : null,
  };
}

/** 写入文件（自动创建父目录）。 */
export function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/**
 * 创建临时 Git 仓库。
 * @param {Record<string,string>} files 相对路径 → 内容
 * @returns {string} 仓库目录
 */
export function makeGitRepo(files) {
  const dir = tmpDir('panqu-git-');
  for (const [rel, content] of Object.entries(files)) {
    write(join(dir, rel), content);
  }
  run('git', ['-C', dir, 'init', '-q']);
  run('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
  run('git', ['-C', dir, 'config', 'user.name', 'test']);
  run('git', ['-C', dir, 'add', '-A']);
  const commit = run('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  if (!commit.ok) throw new Error(`git commit failed: ${commit.stderr}`);
  return dir;
}

/** 递归计算目录内所有文件的 sha256（相对路径 → hash）。跳过 .git（快照 worktree 会在 .git 注册元数据，非被测源码）。 */
export function hashTree(dir) {
  const out = {};
  const walk = (base) => {
    for (const name of readdirSync(base)) {
      if (name === '.git') continue;
      const full = join(base, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) {
        const rel = relative(dir, full);
        out[rel] = createHash('sha256').update(readFileSync(full)).digest('hex');
      }
    }
  };
  if (dir && statSync(dir).isDirectory()) walk(dir);
  return out;
}

export function contains(haystack, needle) {
  return haystack.includes(needle);
}
