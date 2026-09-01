// 发布链路配置契约测试（静态，无需 Docker/网络）。
// 覆盖本轮 4 项修复：CLI 专用 CI、Release CLI 资产、GHCR 镜像名规范化、OpenSSL 修复，
// 以及安全约束（无外部 LLM / Token / shell:true / eval）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const read = (p) => readFileSync(join(REPO, p), 'utf8');

const cliYml = read('.github/workflows/cli.yml');
const releaseYml = read('.github/workflows/release.yml');
const dockerfile = read('deploy/docker/Dockerfile');
const cliPkg = JSON.parse(read('packages/panqu-agent-cli/package.json'));

// ── 1. CLI 专用 CI 触发与步骤 ──
test('cli.yml 对 packages/panqu-agent-cli/** 与自身触发', () => {
  assert.ok(existsSync(join(REPO, '.github/workflows/cli.yml')), 'cli.yml 必须存在');
  assert.match(cliYml, /packages\/panqu-agent-cli\/\*\*/);
  assert.match(cliYml, /\.github\/workflows\/cli\.yml/);
  assert.match(cliYml, /pull_request:/);
  assert.match(cliYml, /push:/);
});

test('cli.yml 包含 install/build/test/pack/hash 校验', () => {
  assert.match(cliYml, /npm (ci|install)/, '安装依赖');
  assert.match(cliYml, /npm run build/, 'CLI build（条件触发）');
  assert.match(cliYml, /node --test "tests\/\*\.test\.mjs"/, 'CLI 全部测试');
  assert.match(cliYml, /npm pack/, 'npm pack');
  assert.match(cliYml, /shasum -a 256 -c/, 'SHA256 回验');
  assert.match(cliYml, /tar -tzf/, 'tarball 内容校验');
});

test('cli.yml 最小权限且稳定命名', () => {
  assert.match(cliYml, /permissions:\s*\n\s*contents: read/, '最小权限 contents:read');
  assert.match(cliYml, /name: panqu-agent-cli verify/, '稳定 job 名称');
});

// ── 2. Release CLI 资产 ──
test('release.yml 含独立 CLI 资产 job（pack+sha256+上传）', () => {
  assert.match(releaseYml, /cli-assets:/, 'cli-assets job 存在');
  const section = releaseYml.slice(releaseYml.indexOf('cli-assets:'));
  assert.match(section, /npm pack/, 'CLI npm pack');
  assert.match(section, /shasum -a 256 -c/, 'SHA256 回验');
  assert.match(section, /actions\/upload-artifact@v4/, 'artifact 上传');
  assert.match(section, /\.sha256/, '同时上传 sha256 文件');
});

test('Release CLI 资产使用 npm pack 的真实文件名（非硬编码）', () => {
  const section = releaseYml.slice(releaseYml.indexOf('cli-assets:'));
  // 文件名来自 npm pack 命令输出，不应硬编码具体版本名
  assert.match(section, /TGZ=\$\(npm pack/, 'tgz 名取自 npm pack 输出');
  assert.ok(!/panqu-test-agent-cli-0\.1\.0\.tgz/.test(section), '不得硬编码版本化 tgz 文件名');
});

// ── 3. GHCR 镜像名规范化 ──
test('release.yml 规范化小写镜像引用并统一复用', () => {
  assert.match(releaseYml, /Normalize GHCR image reference/, '存在规范化步骤');
  assert.match(releaseYml, /tr '\[:upper:\]' '\[:lower:\]'/, '使用小写规范化');
  assert.match(releaseYml, /steps\.imgref\.outputs\.image_ref/, 'SBOM/部署复用 image_ref');
  assert.match(releaseYml, /image-ref: \$\{\{ steps\.digestref\.outputs\.digest_ref \}\}/, 'SBOM 使用 digest 引用');
});

test('release.yml 不再对大写镜像名进行 SBOM/Trivy 引用', () => {
  assert.ok(
    !releaseYml.includes('image-ref: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:latest'),
    'SBOM 不得再用未规范化的大写 IMAGE_NAME'
  );
});

// ── 4. OpenSSL 修复（P1：版本门禁 fail-closed，无 sort -V，双包双 stage） ──
test('Dockerfile 不再包含 sort -V 或旧的混合优先级校验', () => {
  assert.ok(!/sort -V/.test(dockerfile), '不得使用 sort -V');
  assert.ok(!/\|\| \[ /.test(dockerfile) || !/apk upgrade/.test(dockerfile), '不得残留 A&&B||C 混合优先级校验');
});

test('Dockerfile 两个 stage 均升级双包并用 apk version -t 校验 =/> fail-closed', () => {
  const stages = dockerfile.split(/^FROM /m).slice(1); // 两个 stage
  assert.ok(stages.length >= 2, '至少两个 stage');
  for (const s of stages) {
    assert.match(s, /apk upgrade --no-cache libcrypto3 libssl3/, '升级双包');
    assert.match(s, /for pkg in libcrypto3 libssl3/, '对两个包循环校验');
    assert.match(s, /apk version -t "\$ver" "\$MIN_VER"/, '使用 apk version -t');
    assert.match(s, /=\|\\>/, '只允许 = 或 >');
    assert.match(s, /\*\) echo "ERROR: \$pkg \$ver < \$MIN_VER/, '</?/其他 fail');
    assert.match(s, /if \[ -z "\$ver" \]; then/, '空值 fail');
  }
});

test('Dockerfile 未削弱 Trivy 门禁（无 ignore-unfixed / 降低 severity / .trivyignore）', () => {
  assert.ok(!/--ignore-unfixed/.test(dockerfile), '不得使用 --ignore-unfixed');
  assert.ok(!/trivyignore/.test(dockerfile), '不得引用 .trivyignore');
});

// ── 5. SBOM/Trivy 使用本次构建 digest，不再用 :latest；deploy/notify 同引用 ──
test('release-image 构建 step 有稳定 id 并导出 digest reference', () => {
  assert.match(releaseYml, /- name: Build and push\n\s+id: build/, 'build step 有稳定 id=build');
  assert.match(releaseYml, /id: digestref/, '存在 digestref 步骤');
  assert.match(releaseYml, /sha256:\[0-9a-f\]\{64\}/, '校验 digest 格式 sha256:<64hex>');
  assert.match(releaseYml, /digest-ref: \$\{\{ steps\.digestref\.outputs\.digest_ref \}\}/, 'job 导出 digest-ref');
});

test('SBOM/Trivy 使用 digest reference，不再使用 :latest', () => {
  assert.match(releaseYml, /image-ref: \$\{\{ steps\.digestref\.outputs\.digest_ref \}\}/, 'SBOM 用 digest reference');
  assert.ok(!/image-ref: \$\{\{ steps\.imgref\.outputs\.image_ref \}\}:latest/.test(releaseYml), 'SBOM 不再用 :latest');
  assert.ok(!/:latest"/.test(releaseYml.slice(releaseYml.indexOf('Generate SBOM'))), 'SBOM 区域无 :latest');
});

test('deploy/notify 使用本次精确 digest reference，main push 与 tag 均不依赖 latest', () => {
  assert.match(releaseYml, /RELEASE_IMAGE: \$\{\{ needs\.release-image\.outputs\.digest-ref \}\}/, 'notify 用 digest-ref');
  assert.match(releaseYml, /echo "\$\{\{ steps\.digestref\.outputs\.digest_ref \}\}" > security-reports\/published-image\.txt/, 'Save image info 记录 digest reference');
  assert.ok(!/published-image\.txt.*:latest/.test(releaseYml), 'published-image.txt 不含 :latest');
  assert.ok(!releaseYml.includes('ghcr.io/CAoyinggo'), '无大写 GHCR 残留');
  // 允许规范化步骤内用 ${{ github.repository }}（随后 tr 小写），禁止未经小写处理直接拼到镜像路径
  assert.ok(!/\$\{\{ env\.REGISTRY \}\}\/\$\{\{ github\.repository \}\}/.test(releaseYml), '无未规范化 github.repository 直接拼镜像路径');
});

// ── 6. CLI 资产失败阻断部署 ──
test('deploy-test.needs 同时包含 release-image 与 cli-assets', () => {
  assert.match(releaseYml, /deploy-test:\n\s+needs: \[release-image, cli-assets\]/, 'deploy-test 依赖双 job');
  const notifySection = releaseYml.slice(releaseYml.indexOf('notify:'));
  assert.match(notifySection, /CLI_ASSETS_STATUS: \$\{\{ needs\.cli-assets\.result \}\}/, 'notify 显示 cli-assets 结果');
});

// ── 7. upload-artifact if-no-files-found: error ──
test('两个 upload-artifact 步骤均设置 if-no-files-found: error', () => {
  const occurrences = (releaseYml.match(/if-no-files-found: error/g) || []).length;
  assert.ok(occurrences >= 2, `release.yml 至少 2 处 if-no-files-found: error（实际 ${occurrences}）`);
  assert.match(cliYml, /if-no-files-found: error/, 'cli.yml 含 if-no-files-found: error');
});

// ── 8. 安全约束（全改动） ──
test('改动不含外部 LLM / API Key / Token / shell:true / eval', () => {
  const changed = [cliYml, releaseYml, dockerfile, cliPkg && JSON.stringify(cliPkg)];
  // 排除「禁止性 grep 检测模式」所在行（这些行用于扫描 CLI 包，本身不是配置）
  const isDetectLine = (l) => /grep\s+(-\w+\s+)*-(RniE|niE|E)/.test(l);
  for (const text of changed) {
    const lines = text.split('\n').filter((l) => !isDetectLine(l)).join('\n');
    for (const bad of ['LLM_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK', 'MockLLM', 'shell: true', 'eval(']) {
      assert.ok(!lines.includes(bad), `不得包含 ${bad}`);
    }
  }
});

test('CLI 包为零外部依赖（无 npm Token 发布需求）', () => {
  assert.deepEqual(cliPkg.dependencies ?? {}, {}, 'CLI 无外部运行时依赖');
  assert.ok(cliPkg.version, 'CLI 有版本号');
});
