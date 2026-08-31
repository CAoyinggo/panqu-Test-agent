/**
 * 测试 16-18：traecli 缺失 / 未登录 / 使用 fake traecli 的结构化分析。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runTraeAnalysis, composePrompt, requiredAnalysisFields } from '../src/trae-analyzer.mjs';
import { tmpDir, write, run } from './helpers.mjs';

const VALID_ANALYSIS = {
  architecture_summary: '一个简单的 Node 服务',
  changed_areas: [{ path: 'src/', impact: '新增路由' }],
  risks: [{ id: 'R1', level: 'MEDIUM', category: '稳定性', description: '无锁并发' }],
  recommended_checks: ['typecheck'],
  execution_evidence: 'typecheck=PASSED（真实执行）',
  unverified_content: ['并发行为未验证'],
  overall_interpretation: '整体可用',
};

test('traecli 缺失 → BLOCKED，绝不 PASSED', async () => {
  const res = await runTraeAnalysis({
    snapshotPath: tmpDir(),
    promptTemplate: 'x',
    schemaPath: 'x',
    outputJsonPath: join(tmpDir(), 'out.json'),
    traecliPath: null,
    loginStatus: 'not_logged_in',
  });
  assert.equal(res.status, 'BLOCKED');
  assert.match(res.reason, /未安装/);
});

test('traecli 未登录 → BLOCKED，不发起调用', async () => {
  const res = await runTraeAnalysis({
    snapshotPath: tmpDir(),
    promptTemplate: 'x',
    schemaPath: 'x',
    outputJsonPath: join(tmpDir(), 'out.json'),
    traecliPath: '/definitely/fake/traecli',
    loginStatus: 'not_logged_in',
  });
  assert.equal(res.status, 'BLOCKED');
  assert.match(res.reason, /未登录/);
});

test('fake traecli：结构化分析成功，prompt 经 stdin 传入，参数安全', async () => {
  const dir = tmpDir();
  const fake = join(dir, 'traecli');
  const savedStdin = join(dir, 'stdin.txt');
  const savedArgs = join(dir, 'args.txt');
  const outPath = join(dir, 'analysis-out.json');
  write(fake, `#!/bin/sh
printf '%s' "$*" > "${savedArgs}"
cat > "${savedStdin}"
# 找到 --output-last-message 的值
prev=""
for a in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then
    cat > "$a" <<'EOF'
${JSON.stringify(VALID_ANALYSIS)}
EOF
  fi
  prev="$a"
done
echo '{"type":"event"}'
exit 0
`);
  run('chmod', ['+x', fake]);

  const res = await runTraeAnalysis({
    snapshotPath: dir,
    promptTemplate: 'panqu-Test-agent 请分析 {{MARKER_XYZ}}',
    schemaPath: join(dir, 'schema.json'),
    outputJsonPath: outPath,
    traecliPath: fake,
    loginStatus: 'logged_in',
    timeoutMs: 10000,
  });

  assert.equal(res.status, 'PASSED');
  assert.equal(res.data.architecture_summary, VALID_ANALYSIS.architecture_summary);
  assert.equal(res.data.execution_evidence, VALID_ANALYSIS.execution_evidence);
  assert.equal(res.exitCode, 0);
  assert.equal(readFileSync(savedStdin, 'utf8'), 'panqu-Test-agent 请分析 {{MARKER_XYZ}}', 'prompt 应通过 stdin 传入');
  const args = readFileSync(savedArgs, 'utf8');
  assert.ok(args.includes('--sandbox read-only'));
  assert.ok(args.includes('--ephemeral'));
  assert.ok(args.includes('--output-schema'));
  assert.ok(args.includes('--output-last-message'));
  assert.ok(!args.includes('--yolo'));
  assert.ok(!args.includes('danger-full-access'));
  assert.ok(!args.includes('bypass_permissions'));
});

test('fake traecli 输出缺字段 → ERROR（不伪造 PASSED）', async () => {
  const dir = tmpDir();
  const fake = join(dir, 'traecli');
  const outPath = join(dir, 'analysis-out.json');
  write(fake, `#!/bin/sh
for a in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then
    echo '{"architecture_summary":"只有摘要"}' > "$a"
  fi
  prev="$a"
done
exit 0
`);
  run('chmod', ['+x', fake]);
  const res = await runTraeAnalysis({
    snapshotPath: dir,
    promptTemplate: 'x',
    schemaPath: join(dir, 'schema.json'),
    outputJsonPath: outPath,
    traecliPath: fake,
    loginStatus: 'logged_in',
    timeoutMs: 10000,
  });
  assert.equal(res.status, 'ERROR');
  assert.match(res.reason, /缺少必要字段/);
});

test('composePrompt 替换占位符；requiredAnalysisFields 齐全', () => {
  const prompt = composePrompt('A={{A}} B={{B}}', { A: 'x', B: { k: 1 } });
  assert.equal(prompt, 'A=x B={\n  "k": 1\n}');
  assert.ok(requiredAnalysisFields().length >= 6);
});

test('有限重试：首次输出无效、二次成功 → PASSED 且 attempts=2', async () => {
  const dir = tmpDir();
  const fake = join(dir, 'traecli');
  const counter = join(dir, 'counter.txt');
  const outPath = join(dir, 'analysis-out.json');
  write(fake, `#!/bin/sh
if [ -f "${counter}" ]; then
  n=$(cat "${counter}")
else
  n=0
fi
n=$((n+1))
echo "$n" > "${counter}"
prev=""
for a in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then
    if [ "$n" = "1" ]; then
      echo '{}' > "$a"
    else
      cat > "$a" <<'EOF'
${JSON.stringify(VALID_ANALYSIS)}
EOF
    fi
  fi
  prev="$a"
done
exit 0
`);
  run('chmod', ['+x', fake]);
  const res = await runTraeAnalysis({
    snapshotPath: dir,
    promptTemplate: 'x',
    schemaPath: join(dir, 'schema.json'),
    outputJsonPath: outPath,
    traecliPath: fake,
    loginStatus: 'logged_in',
    timeoutMs: 10000,
  });
  assert.equal(res.status, 'PASSED');
  assert.equal(res.attempts, 2);
  assert.equal(res.data.architecture_summary, VALID_ANALYSIS.architecture_summary);
});

test('重试耗尽仍失败 → ERROR，attempts=maxAttempts，绝不伪造 PASSED', async () => {
  const dir = tmpDir();
  const fake = join(dir, 'traecli');
  const outPath = join(dir, 'analysis-out.json');
  write(fake, `#!/bin/sh
for a in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then
    echo '{}' > "$a"
  fi
  prev="$a"
done
exit 0
`);
  run('chmod', ['+x', fake]);
  const res = await runTraeAnalysis({
    snapshotPath: dir,
    promptTemplate: 'x',
    schemaPath: join(dir, 'schema.json'),
    outputJsonPath: outPath,
    traecliPath: fake,
    loginStatus: 'logged_in',
    timeoutMs: 10000,
    maxAttempts: 2,
  });
  assert.equal(res.status, 'ERROR');
  assert.equal(res.attempts, 2);
  assert.match(res.reason, /仍失败/);
});
