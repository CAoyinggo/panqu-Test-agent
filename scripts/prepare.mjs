/**
 * 根 package.json 的 prepare 生命周期入口（开发 checkout / npm pack / git dependency 安装都会触发）。
 *
 * 只做不改写工作树的开发准备：条件性启用 husky。
 *   - 正常开发 checkout 且 husky 可执行文件存在时运行 husky；
 *   - npm git dependency 打包/安装环境（无 husky）静默跳过，不阻断 CLI 安装；
 *   - 不生成、不改写 provenance 文件。
 *
 * 不联网；不使用 `|| true` 吞错（此处逻辑本身无需吞错）。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

function isDevCheckout() {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: repoRoot, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function runHusky() {
  const huskyBin = join(repoRoot, 'node_modules', '.bin', 'husky');
  try {
    if (!existsSync(huskyBin) || !statSync(huskyBin).isFile()) return; // 无 husky 可执行文件
  } catch {
    return;
  }
  if (!isDevCheckout()) return;
  spawnSync(huskyBin, [], { cwd: repoRoot, stdio: 'inherit' });
}

runHusky();
process.exit(0);