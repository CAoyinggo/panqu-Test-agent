/**
 * P0 快速收口共享 helper。
 * - makeFakeTraecliRoot：注入 fake traecli（HOME 兜底路径），使 analysis 确定性 PASSED，不依赖真实登录；
 * - buildMinimalCandidateRepo：把候选 CLI 打成最小根包临时 git 仓库（验证 npm git 一条命令语义）；
 * - buildRealFixture：真实 Node fixture（typescript/eslint/@types/node + CJS dayjs + ESM p-limit）。
 *
 * 全部自建自清理临时目录，不依赖旧 /tmp、不依赖用户全局 npm cache（npm 操作使用独立 cache）。
 */
import {
  mkdtempSync, mkdirSync, writeFileSync, cpSync, chmodSync, existsSync, realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, write, hashTree, PACKAGE_ROOT } from './helpers.mjs';

export const REPO_ROOT = resolve(PACKAGE_ROOT, '..', '..');

const FAKE_ANALYSIS = {
  architecture_summary: 'P0 fake analysis: minimal Node project',
  changed_areas: [{ path: 'src/', impact: 'no changes (fake)' }],
  risks: [{ id: 'R1', level: 'LOW', category: 'P0', description: 'fake risk entry' }],
  recommended_checks: ['typecheck'],
  execution_evidence: 'deterministic checks executed by panqu-test-agent',
  unverified_content: [],
  overall_interpretation: 'fake analysis for deterministic tests',
};

/**
 * 创建 fake traecli（临时 HOME 注入，CI 与本地均确定性命中）。
 * findTraecli 先用 `command -v traecli` 探测 PATH（spawnSync 无 shell 时该探测不可用），
 * 再回退到 `<HOME>/.local/bin/traecli` 与 `<HOME>/bin/traecli`。
 * 因此 fake 必须创建在 `<temporary-home>/.local/bin/traecli`，且被测 CLI 子进程的
 * HOME 必须指向该临时 HOME——PATH 前置仅作双保险，不能只依赖 PATH。
 * 不读取开发机真实 HOME，不依赖真实 traecli 登录态。
 * 返回 { binDir, env, cleanup }，env() 返回覆盖 HOME + PATH 前置的子进程环境。
 */
export function makeFakeTraecliRoot() {
  const tempHome = mkdtempSync(join(tmpdir(), 'panqu-p0-fakehome-'));
  const binDir = join(tempHome, '.local', 'bin');
  mkdirSync(binDir, { recursive: true });
  const fake = join(binDir, 'traecli');
  write(fake, `#!/bin/sh
if [ "$1" = "login" ]; then
  echo "Logged in using Trae"
  exit 0
fi
if [ "$1" = "--version" ]; then
  echo "traecli 0.0.0-fake"
  exit 0
fi
prev=""
for a in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then
    cat > "$a" <<'P0FAKE_EOF'
${JSON.stringify(FAKE_ANALYSIS)}
P0FAKE_EOF
  fi
  prev="$a"
done
echo '{"type":"event"}'
exit 0
`);
  chmodSync(fake, 0o755);
  return {
    binDir,
    env: () => ({
      ...process.env,
      HOME: tempHome,
      PATH: `${binDir}${delimiter}${process.env.PATH}`,
    }),
    cleanup: () => run('rm', ['-rf', tempHome]),
  };
}

/**
 * 把候选 CLI 打成「最小根包」临时 git 仓库并 commit。
 * 与真实根包共享同一 npm git 安装语义：根 bin 指向子包入口 + prepare 生命周期。
 * 返回 { repo, sha, filesHash }。
 */
export function buildMinimalCandidateRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'panqu-p0-gitrepo-'));
  const cliSrc = join(REPO_ROOT, 'packages', 'panqu-agent-cli');

  write(join(repo, 'package.json'), `${JSON.stringify({
    name: 'panqu-test-agent-git-smoke',
    version: '0.1.0',
    type: 'module',
    bin: { 'panqu-test-agent': 'packages/panqu-agent-cli/bin/panqu-test-agent.mjs' },
    scripts: { prepare: 'node scripts/prepare.mjs' },
  }, null, 2)}\n`);

  // 复制 prepare wrapper 与 CLI 包内容（含可执行位）
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  cpSync(join(REPO_ROOT, 'scripts', 'prepare.mjs'), join(repo, 'scripts', 'prepare.mjs'));
  cpSync(cliSrc, join(repo, 'packages', 'panqu-agent-cli'), { recursive: true });
  // 复制会带来 tests/node_modules 等无关内容不影响安装；确保 bin 可执行
  chmodSync(join(repo, 'packages', 'panqu-agent-cli', 'bin', 'panqu-test-agent.mjs'), 0o755);

  run('git', ['-C', repo, 'init', '-q']);
  run('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
  run('git', ['-C', repo, 'config', 'user.name', 'test']);
  run('git', ['-C', repo, 'add', '-A']);
  const c = run('git', ['-C', repo, 'commit', '-q', '-m', 'p0 synthetic candidate']);
  if (!c.ok) throw new Error(`synthetic commit failed: ${c.stderr}`);
  const sha = run('git', ['-C', repo, 'rev-parse', 'HEAD']).stdout.trim();

  return { repo, sha, filesHash: hashTree(repo) };
}

/**
 * 真实 Node fixture：typescript + eslint + @types/node + dayjs(CJS) + p-limit(ESM)。
 * npm install 使用独立 cache（不依赖用户全局 cache）。
 * 返回 { dir, head, sentinelPath, cleanup }。
 */
export function buildRealFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'panqu-p0-fixture-'));

  write(join(dir, 'package.json'), `${JSON.stringify({
    name: 'panqu-p0-real-fixture',
    version: '1.0.0',
    type: 'module',
    private: true,
    scripts: {
      typecheck: 'tsc --noEmit',
      lint: 'eslint .',
      test: 'node --test',
      build: 'tsc --noEmit false --outDir dist',
    },
    devDependencies: {
      '@types/node': '^20.14.0',
      dayjs: '^1.11.11',
      eslint: '^9.20.0',
      'p-limit': '^6.1.0',
      typescript: '^5.7.0',
    },
  }, null, 2)}\n`);

  write(join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      allowJs: true, checkJs: true, strict: true, noEmit: true,
      module: 'nodenext', moduleResolution: 'nodenext', target: 'es2022', skipLibCheck: true,
    },
    include: ['src/**/*.mjs', 'test/**/*.mjs'],
  }, null, 2));

  write(join(dir, 'eslint.config.mjs'), `export default [
  { ignores: ['dist/**', 'node_modules/**'] },
  {
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { console: 'readonly', process: 'readonly' },
    },
    rules: { 'no-unused-vars': 'error', 'no-undef': 'error' },
  },
];\n`);

  write(join(dir, 'src', 'lib.mjs'), `/** @param {number} a @param {number} b @returns {number} */\nexport function add(a, b) { return a + b; }\n\n/** @param {number} a @param {number} b @returns {number} */\nexport function multiply(a, b) { return a * b; }\n`);
  write(join(dir, 'src', 'index.mjs'), `export { add, multiply } from './lib.mjs';\n`);
  // test：同时验证 ESM import（p-limit）与 CommonJS require（dayjs）
  write(join(dir, 'test', 'index.test.mjs'), `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import pLimit from 'p-limit';
import { add, multiply } from '../src/index.mjs';

const require = createRequire(import.meta.url);
const dayjs = require('dayjs');

test('pure functions', () => {
  assert.equal(add(2, 3), 5);
  assert.equal(multiply(2, 3), 6);
});

test('ESM dependency resolves (p-limit)', () => {
  assert.equal(typeof pLimit, 'function');
});

test('CommonJS dependency resolves (dayjs)', () => {
  assert.equal(typeof dayjs, 'function');
});
`);

  write(join(dir, '.gitignore'), 'node_modules/\ndist/\n');

  // 真实安装依赖（独立 cache）
  const cache = mkdtempSync(join(tmpdir(), 'panqu-p0-npmcache-'));
  const install = run('npm', ['install', '--no-audit', '--no-fund', `--cache=${cache}`], {
    cwd: dir, timeout: 420000,
  });
  if (!install.ok) throw new Error(`fixture npm install failed: ${install.stderr.slice(0, 500)}`);

  // 哨兵文件 + git init
  const sentinelPath = join(dir, 'node_modules', '.sentinel-p0');
  writeFileSync(sentinelPath, 'SENTINEL-P0-ORIGINAL');
  run('git', ['-C', dir, 'init', '-q']);
  run('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
  run('git', ['-C', dir, 'config', 'user.name', 'test']);
  run('git', ['-C', dir, 'add', '-A']);
  const c = run('git', ['-C', dir, 'commit', '-q', '-m', 'fixture init']);
  if (!c.ok) throw new Error(`fixture commit failed: ${c.stderr}`);
  const head = run('git', ['-C', dir, 'rev-parse', 'HEAD']).stdout.trim();

  return {
    dir, head, sentinelPath,
    cleanup: () => run('rm', ['-rf', dir, cache]),
  };
}

/** 真实路径（消除 macOS /var → /private/var 符号链接差异），用于 git+file URL。 */
export function realPath(p) {
  return existsSync(p) ? realpathSync(p) : p;
}

export const __filenameForHelper = fileURLToPath(import.meta.url);
export const __dirnameForHelper = dirname(__filenameForHelper);