#!/usr/bin/env node
/**
 * notify-feishu.mjs — 发布结果飞书通知
 *
 * 复用 FeishuNotifier 的卡片格式，发送发布状态通知到飞书群。
 * 支持成功/失败/回滚三种状态。
 *
 * 环境变量：
 *   FEISHU_WEBHOOK     - 飞书 webhook 地址（必填）
 *   RELEASE_STATUS     - 发布状态：success | failure | rollback
 *   RELEASE_IMAGE      - 镜像引用
 *   RELEASE_TAG        - 镜像 tag
 *   COMMIT_SHA         - commit SHA
 *   COMMIT_MESSAGE     - commit message
 *   PIPELINE_ID        - 流水线 ID
 *   PIPELINE_URL       - 流水线 URL
 *   DEPLOY_ENV         - 部署环境（默认 test）
 *   SMOKE_RESULT       - 冒烟测试结果
 *   ROLLBACK_IMAGE     - 回滚到的镜像（如有）
 *   FAILED_STAGE      - 失败阶段（如有）
 *
 * 用法：
 *   node scripts/deploy/notify-feishu.mjs
 *   # 或在 CI 中：
 *   RELEASE_STATUS=success RELEASE_IMAGE=... node scripts/deploy/notify-feishu.mjs
 */

const WEBHOOK = process.env.FEISHU_WEBHOOK || process.env.TESTFLOW_FEISHU_WEBHOOK;
const STATUS = process.env.RELEASE_STATUS || (process.env.CI ? 'unknown' : 'local');
const IMAGE = process.env.RELEASE_IMAGE || process.env.CI_REGISTRY_IMAGE || 'N/A';
const TAG = process.env.RELEASE_TAG || process.env.IMAGE_TAG || 'latest';
const COMMIT_SHA = process.env.COMMIT_SHA || process.env.CI_COMMIT_SHA || '';
const COMMIT_MSG = process.env.COMMIT_MESSAGE || process.env.CI_COMMIT_MESSAGE || '';
const PIPELINE_ID = process.env.PIPELINE_ID || process.env.CI_PIPELINE_ID || process.env.GITHUB_RUN_ID || '';
const PIPELINE_URL = process.env.PIPELINE_URL || process.env.CI_PIPELINE_URL || '';
const DEPLOY_ENV = process.env.DEPLOY_ENV || 'test';
const SMOKE_RESULT = process.env.SMOKE_RESULT || '';
const ROLLBACK_IMAGE = process.env.ROLLBACK_IMAGE || '';
const FAILED_STAGE = process.env.FAILED_STAGE || '';

if (!WEBHOOK) {
  console.log('⚠ FEISHU_WEBHOOK 未设置，跳过通知');
  process.exit(0);
}

// ── 构建卡片内容 ──
const isSuccess = STATUS === 'success';
const isRollback = STATUS === 'rollback' || STATUS === 'rollback_no_previous';

const headerColor = isSuccess ? 'green' : (isRollback ? 'orange' : 'red');
const headerTitle = isSuccess
  ? '✅ test-flow 发布成功'
  : isRollback
    ? '⚠ test-flow 发布回滚'
    : '❌ test-flow 发布失败';

// 构建内容行
const lines = [];
lines.push(`**状态**: ${isSuccess ? '成功' : isRollback ? '已回滚' : '失败'}`);
lines.push(`**镜像**: \`${IMAGE}:${TAG}\``);
lines.push(`**环境**: ${DEPLOY_ENV}`);
if (COMMIT_SHA) {
  lines.push(`**Commit**: ${COMMIT_SHA.substring(0, 12)}`);
}
if (COMMIT_MSG) {
  const shortMsg = COMMIT_MSG.split('\n')[0].substring(0, 80);
  lines.push(`**消息**: ${shortMsg}`);
}
if (PIPELINE_ID) {
  lines.push(`**流水线**: ${PIPELINE_ID}`);
}
if (SMOKE_RESULT) {
  lines.push(`**冒烟测试**: ${SMOKE_RESULT}`);
}
if (ROLLBACK_IMAGE) {
  lines.push(`**回滚镜像**: \`${ROLLBACK_IMAGE}\``);
}
if (FAILED_STAGE) {
  lines.push(`**失败阶段**: ${FAILED_STAGE}`);
}
if (PIPELINE_URL) {
  lines.push(`**流水线链接**: [查看](${PIPELINE_URL})`);
}

// ── 构建飞书卡片消息 ──
const card = {
  msg_type: 'interactive',
  card: {
    config: { wide_screen_mode: true },
    header: {
      template: headerColor,
      title: { tag: 'plain_text', content: headerTitle },
    },
    elements: [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: lines.join('\n') },
      },
    ],
  },
};

// ── 发送通知 ──
const body = JSON.stringify(card);

try {
  const resp = await fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  const text = await resp.text();
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    result = { raw: text };
  }

  if (result.code !== undefined && result.code !== 0) {
    console.error('❌ 飞书通知发送失败:', result.msg || result);
    process.exit(1);
  }

  console.log('✅ 飞书通知已发送');
  console.log(`   状态: ${STATUS}`);
  console.log(`   镜像: ${IMAGE}:${TAG}`);
} catch (err) {
  console.error('❌ 飞书通知发送异常:', err.message);
  // 通知失败不应阻塞流水线
  process.exit(0);
}
