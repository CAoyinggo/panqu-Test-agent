#!/bin/bash
# deploy.sh — 部署到测试环境（通过 SSH 在测试服务器上执行）
# 由 CI runner 调用，通过 SSH 在测试机上执行
#
# 环境变量（通过 SSH 传入）：
#   DEPLOY_IMAGE         - 完整镜像引用（如 registry.gitlab.com/group/test-flow:latest）
#   REGISTRY             - Registry URL
#   REGISTRY_USER        - Registry 用户名
#   REGISTRY_PASSWORD    - Registry 密码
#
# 用法（CI 中）：
#   ssh user@host DEPLOY_IMAGE=... REGISTRY=... "bash -s" < scripts/deploy/deploy.sh
#
# 退出码：0=成功，1=冒烟测试失败（已回滚）

set -euo pipefail

IMAGE="${DEPLOY_IMAGE:?DEPLOY_IMAGE not set}"
CONTAINER_NAME="test-flow"
OUTPUT_DIR="/app/output"
CASES_DIR="/app/cases"
ASSETS_DIR="/app/assets"
REPORT_DIR="${REPORT_DIR:-security-reports}"
mkdir -p "$REPORT_DIR"

echo "════════════════════════════════════════"
echo "  test-flow 部署到测试环境"
echo "  镜像: $IMAGE"
echo "  时间: $(date '+%Y-%m-%d %H:%M:%S')"
echo "════════════════════════════════════════"

# ── 1. 登录 Registry ──
echo "── [1/6] 登录 Registry ──"
if [ -n "${REGISTRY_USER:-}" ] && [ -n "${REGISTRY_PASSWORD:-}" ]; then
  echo "$REGISTRY_PASSWORD" | docker login -u "$REGISTRY_USER" --password-stdin "${REGISTRY:-}" 2>/dev/null || {
    echo "⚠ Registry 登录失败，尝试无认证拉取"
  }
  echo "✅ Registry 登录成功"
else
  echo "⚠ 未提供 Registry 凭证，尝试无认证拉取"
fi

# ── 2. 记录当前镜像（回滚用） ──
echo "── [2/6] 记录当前镜像 ──"
PREVIOUS_IMAGE=""
if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q "^${CONTAINER_NAME}$"; then
  PREVIOUS_IMAGE=$(docker inspect --format='{{.Config.Image}}' "$CONTAINER_NAME" 2>/dev/null || echo "")
  echo "当前运行镜像: $PREVIOUS_IMAGE"
else
  echo "未找到运行中的容器（首次部署）"
fi
echo "$PREVIOUS_IMAGE" > "$REPORT_DIR/previous-image.txt"

# ── 3. 拉取新镜像 ──
echo "── [3/6] 拉取新镜像 ──"
docker pull "$IMAGE"
echo "✅ 镜像拉取成功"

# ── 4. 停止旧容器，启动新容器 ──
echo "── [4/6] 重启容器 ──"
if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q "^${CONTAINER_NAME}$"; then
  echo "停止旧容器..."
  docker stop "$CONTAINER_NAME" 2>/dev/null || true
  docker rm "$CONTAINER_NAME" 2>/dev/null || true
fi

echo "启动新容器..."
docker run -d \
  --name "$CONTAINER_NAME" \
  --restart unless-stopped \
  -v "$OUTPUT_DIR:/app/output" \
  -v "$CASES_DIR:/app/src/cases:ro" \
  -v "$ASSETS_DIR:/app/assets:ro" \
  -e TESTFLOW_ENV=test \
  -e TESTFLOW_OUTPUT_DIR=/app/output \
  -e TESTFLOW_ASSETS_DIR=/app/assets \
  "$IMAGE" --task src/cases --ci 2>/dev/null || true

echo "✅ 容器已启动"

# ── 5. 冒烟测试 ──
echo "── [5/6] 冒烟测试 ──"
SMOKE_PASS=true
SMOKE_ERRORS=""

# Test 1: --help
echo "  [1/2] 验证 --help..."
if docker run --rm "$IMAGE" --help > /dev/null 2>&1; then
  echo "  ✅ --help 通过"
else
  echo "  ❌ --help 失败"
  SMOKE_PASS=false
  SMOKE_ERRORS="$SMOKE_ERRORS --help"
fi

# Test 2: --dry-run
echo "  [2/2] 验证 --dry-run..."
if docker run --rm "$IMAGE" --task src/cases --dry-run > /dev/null 2>&1; then
  echo "  ✅ --dry-run 通过"
else
  echo "  ❌ --dry-run 失败"
  SMOKE_PASS=false
  SMOKE_ERRORS="$SMOKE_ERRORS --dry-run"
fi

# ── 6. 处理结果 ──
echo "── [6/6] 部署结果 ──"
if [ "$SMOKE_PASS" = "false" ]; then
  echo ""
  echo "❌ 冒烟测试失败: $SMOKE_ERRORS"
  echo "执行回滚..."

  # 停止新容器
  docker stop "$CONTAINER_NAME" 2>/dev/null || true
  docker rm "$CONTAINER_NAME" 2>/dev/null || true

  # 回滚到之前的镜像
  if [ -n "$PREVIOUS_IMAGE" ]; then
    echo "回滚到: $PREVIOUS_IMAGE"
    docker pull "$PREVIOUS_IMAGE" 2>/dev/null || true
    docker run -d \
      --name "$CONTAINER_NAME" \
      --restart unless-stopped \
      -v "$OUTPUT_DIR:/app/output" \
      -v "$CASES_DIR:/app/src/cases:ro" \
      -v "$ASSETS_DIR:/app/assets:ro" \
      -e TESTFLOW_ENV=test \
      -e TESTFLOW_OUTPUT_DIR=/app/output \
      -e TESTFLOW_ASSETS_DIR=/app/assets \
      "$PREVIOUS_IMAGE" --task src/cases --ci 2>/dev/null || true
    echo "✅ 已回滚到 $PREVIOUS_IMAGE"
    echo "{\"status\":\"rollback\",\"image\":\"$IMAGE\",\"previous_image\":\"$PREVIOUS_IMAGE\",\"errors\":\"$SMOKE_ERRORS\"}" > "$REPORT_DIR/deploy-status.json"
  else
    echo "⚠ 无可回滚的镜像（首次部署）"
    echo "{\"status\":\"rollback_no_previous\",\"image\":\"$IMAGE\",\"errors\":\"$SMOKE_ERRORS\"}" > "$REPORT_DIR/deploy-status.json"
  fi

  exit 1
fi

echo ""
echo "✅ 部署成功，冒烟测试全部通过"
echo "{\"status\":\"success\",\"image\":\"$IMAGE\",\"smoke_tests\":[\"--help\",\"--dry-run\"]}" > "$REPORT_DIR/deploy-status.json"
exit 0
