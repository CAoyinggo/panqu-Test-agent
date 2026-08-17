#!/bin/bash
# generate-allure-html.sh — 递归收集 allure-results 并生成 Allure HTML 报告
#
# 用法：
#   bash scripts/ci/generate-allure-html.sh [output-root]
#
# 参数：
#   output-root: output 根目录（默认从 TESTFLOW_OUTPUT_DIR 或 ./output 推断）
#
# 流程：
#   1. 递归查找所有 allure-results/ 目录
#   2. 合并到临时目录
#   3. 调用 npx allure generate 生成 HTML
#   4. 输出到 <output-root>/<日期>/allure-report/
#
# 退出码：0=成功（或降级跳过），不阻塞 CI

set -eo pipefail

OUTPUT_ROOT="${1:-${TESTFLOW_OUTPUT_DIR:-./output}}"

# 如果 OUTPUT_ROOT 是相对路径，转为绝对路径
if [[ "$OUTPUT_ROOT" != /* ]]; then
  OUTPUT_ROOT="$(cd "$OUTPUT_ROOT" 2>/dev/null && pwd || echo "$(pwd)/$OUTPUT_ROOT")"
fi

echo "════════════════════════════════════════"
echo "  Allure HTML 报告生成"
echo "  output-root: $OUTPUT_ROOT"
echo "════════════════════════════════════════"

# ── 1. 递归查找所有 allure-results 目录 ──
echo "── [1/4] 收集 allure-results ──"

if [ ! -d "$OUTPUT_ROOT" ]; then
  echo "⚠ 输出目录不存在: $OUTPUT_ROOT"
  exit 0
fi

RESULTS_DIRS=$(find "$OUTPUT_ROOT" -type d -name "allure-results" 2>/dev/null || true)

if [ -z "$RESULTS_DIRS" ]; then
  echo "⚠ 未找到任何 allure-results 目录"
  echo "  请确认测试已执行并生成 Allure 结果"
  exit 0
fi

RESULT_COUNT=$(echo "$RESULTS_DIRS" | wc -l | tr -d ' ')
echo "  发现 $RESULT_COUNT 个 allure-results 目录"

# ── 2. 合并到临时目录 ──
echo "── [2/4] 合并结果到临时目录 ──"
TEMP_MERGE=$(mktemp -d)
echo "  临时目录: $TEMP_MERGE"

MERGED_COUNT=0
while IFS= read -r dir; do
  if [ -d "$dir" ]; then
    find "$dir" -maxdepth 1 -name "*-result.json" -exec cp {} "$TEMP_MERGE/" \; 2>/dev/null || true
    FILE_COUNT=$(find "$dir" -maxdepth 1 -name "*-result.json" 2>/dev/null | wc -l | tr -d ' ')
    MERGED_COUNT=$((MERGED_COUNT + FILE_COUNT))
  fi
done <<< "$RESULTS_DIRS"

echo "  合并 $MERGED_COUNT 个 result.json 文件"

if [ "$MERGED_COUNT" -eq 0 ]; then
  echo "⚠ 无有效的 Allure 结果文件"
  exit 0
fi

# ── 3. 生成 HTML 报告 ──
echo "── [3/4] 生成 Allure HTML 报告 ──"

TODAY=$(date '+%Y-%m-%d')
HTML_DIR="$OUTPUT_ROOT/$TODAY/allure-report"

echo "  目标目录: $HTML_DIR"

# 检查 allure-commandline 是否可用
ALLURE_AVAILABLE=true
if ! npx allure --version >/dev/null 2>&1; then
  echo "⚠ allure-commandline 不可用，尝试安装..."
  npm install -g allure-commandline >/dev/null 2>&1 || ALLURE_AVAILABLE=false
fi

if [ "$ALLURE_AVAILABLE" = false ]; then
  echo "⚠ allure-commandline 安装失败，跳过 HTML 生成"
  echo "  可手动执行: npx allure generate $TEMP_MERGE -o $HTML_DIR"
  exit 0
fi

# 清理旧报告
if [ -d "$HTML_DIR" ]; then
  find "$HTML_DIR" -delete 2>/dev/null || true
fi

# 生成 HTML 报告
if npx allure generate "$TEMP_MERGE" -o "$HTML_DIR" 2>&1; then
  echo "✅ allure generate 成功"
else
  echo "⚠ Allure HTML 生成失败（allure-commandline 可能版本不兼容）"
  echo "  可手动执行: npx allure generate $TEMP_MERGE -o $HTML_DIR"
  exit 0
fi

# ── 4. 验证输出 ──
echo "── [4/4] 验证 ──"
if [ -f "$HTML_DIR/index.html" ]; then
  echo "✅ Allure HTML 报告已生成: $HTML_DIR/index.html"
  FILE_TOTAL=$(find "$HTML_DIR" -type f 2>/dev/null | wc -l | tr -d ' ')
  echo "  文件数: $FILE_TOTAL"
else
  echo "⚠ Allure HTML 报告生成异常（index.html 不存在）"
fi

echo ""
echo "✅ Allure HTML 报告路径: $HTML_DIR"
