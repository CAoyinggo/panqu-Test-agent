#!/bin/bash
# smoke-test-local.sh — 本地冒烟测试（不依赖 SSH / 测试服务器）
# 构建 Docker 镜像并运行冒烟测试，验证镜像可用性
#
# 用法：bash scripts/deploy/smoke-test-local.sh [image-tag]
#   image-tag: 可选，默认 test-flow:smoke-test

set -euo pipefail

IMAGE_TAG="${1:-test-flow:smoke-test}"
REPORT_DIR="security-reports"
mkdir -p "$REPORT_DIR"

echo "════════════════════════════════════════"
echo "  test-flow 本地冒烟测试"
echo "  镜像: $IMAGE_TAG"
echo "════════════════════════════════════════"
echo ""

# ── 1. 构建镜像 ──
echo "── [1/4] 构建镜像 ──"
if ! command -v docker &>/dev/null; then
  echo "❌ Docker 未安装，无法运行冒烟测试"
  echo "{\"status\":\"skipped\",\"reason\":\"docker not installed\"}" > "$REPORT_DIR/smoke-test-local.json"
  exit 0
fi

DOCKER_BUILDKIT=1 docker build -t "$IMAGE_TAG" . 2>&1 | tail -5
echo "✅ 镜像构建完成"
echo ""

# ── 2. 验证 --help ──
echo "── [2/4] 验证 --help ──"
if docker run --rm "$IMAGE_TAG" --help > /dev/null 2>&1; then
  echo "✅ --help 通过"
  HELP_PASS=true
else
  echo "❌ --help 失败"
  HELP_PASS=false
fi
echo ""

# ── 3. 验证 --dry-run ──
echo "── [3/4] 验证 --dry-run ──"
if docker run --rm "$IMAGE_TAG" --task src/cases --dry-run > /dev/null 2>&1; then
  echo "✅ --dry-run 通过"
  DRYRUN_PASS=true
else
  echo "⚠ --dry-run 失败（可能未实现 dry-run 模式，视为非阻塞）"
  DRYRUN_PASS=false
fi
echo ""

# ── 4. 验证 --version ──
echo "── [4/4] 验证镜像完整性 ──"
if docker run --rm "$IMAGE_TAG" --task src/cases --ci --dry-run 2>&1 | head -5; then
  echo "✅ 镜像可正常启动"
else
  echo "⚠ 镜像启动有警告，检查输出"
fi
echo ""

# ── 结果汇总 ──
echo "════════════════════════════════════════"
if [ "$HELP_PASS" = "true" ]; then
  echo "  ✅ 冒烟测试通过（--help 正常）"
  echo "{\"status\":\"pass\",\"image\":\"$IMAGE_TAG\",\"tests\":{\"help\":true,\"dry_run\":$DRYRUN_PASS}}" > "$REPORT_DIR/smoke-test-local.json"
  exit 0
else
  echo "  ❌ 冒烟测试失败"
  echo "{\"status\":\"fail\",\"image\":\"$IMAGE_TAG\",\"tests\":{\"help\":false,\"dry_run\":$DRYRUN_PASS}}" > "$REPORT_DIR/smoke-test-local.json"
  exit 1
fi
