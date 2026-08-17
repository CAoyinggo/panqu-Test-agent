#!/bin/bash
# github-summary.sh — 解析 JUnit XML / metrics.json 生成 GitHub Actions Summary
#
# 用法：
#   bash scripts/ci/github-summary.sh [output-root]
#
# 参数：
#   output-root: output 根目录（默认从 TESTFLOW_OUTPUT_DIR 或 ./output 推断）
#
# 输出：
#   写入 $GITHUB_STEP_SUMMARY（Markdown 格式）
#   包含：通过率、用例统计、失败列表、报告链接

set -euo pipefail

OUTPUT_ROOT="${1:-${TESTFLOW_OUTPUT_DIR:-./output}}"

# 如果 OUTPUT_ROOT 是相对路径，转为绝对路径
if [[ "$OUTPUT_ROOT" != /* ]]; then
  OUTPUT_ROOT="$(cd "$OUTPUT_ROOT" 2>/dev/null && pwd || echo "$(pwd)/$OUTPUT_ROOT")"
fi

SUMMARY_FILE="${GITHUB_STEP_SUMMARY:-/dev/stdout}"

echo "── 生成 GitHub Actions 测试摘要 ──"
echo "  output-root: $OUTPUT_ROOT"
echo "  summary-file: $SUMMARY_FILE"

if [ ! -d "$OUTPUT_ROOT" ]; then
  echo "⚠ 输出目录不存在: $OUTPUT_ROOT"
  exit 0
fi

# ── 收集所有 junit.xml ──
JUNIT_FILES=$(find "$OUTPUT_ROOT" -name "junit.xml" -type f 2>/dev/null || true)

# ── 收集所有 metrics.json ──
METRICS_FILES=$(find "$OUTPUT_ROOT" -name "metrics.json" -type f 2>/dev/null || true)

if [ -z "$JUNIT_FILES" ] && [ -z "$METRICS_FILES" ]; then
  echo "⚠ 未找到 junit.xml 或 metrics.json"
  exit 0
fi

# ── 使用 Python 解析 JUnit XML ──
python3 - "$OUTPUT_ROOT" "$SUMMARY_FILE" << 'PYTHON_SCRIPT'
import sys
import os
import json
import glob
import xml.etree.ElementTree as ET
from datetime import datetime

output_root = sys.argv[1]
summary_file = sys.argv[2]

# 收集统计
total = 0
passed = 0
failed = 0
errors = 0
skipped = 0
total_time = 0.0
failed_cases = []

# 解析所有 junit.xml
junit_files = glob.glob(os.path.join(output_root, "**", "junit.xml"), recursive=True)

for jf in junit_files:
    try:
        tree = ET.parse(jf)
        root = tree.getroot()

        # 兼容 <testsuites> 和 <testsuite> 根节点
        suites = root if root.tag == 'testsuite' else root.findall('.//testsuite')

        for suite in suites:
            suite_name = suite.get('name', 'unknown')
            suite_time = float(suite.get('time', 0))
            total_time += suite_time

            for tc in suite.findall('.//testcase'):
                total += 1
                tc_name = tc.get('name', 'unknown')
                tc_class = tc.get('classname', '')
                tc_time = float(tc.get('time', 0))

                failure = tc.find('failure')
                error = tc.find('error')
                skipped_el = tc.find('skipped')

                if error is not None:
                    errors += 1
                    msg = error.get('message', 'error')
                    failed_cases.append({
                        'feature': tc_class,
                        'name': tc_name,
                        'error': msg,
                        'type': 'error'
                    })
                elif failure is not None:
                    failed += 1
                    msg = failure.get('message', 'failure')
                    failed_cases.append({
                        'feature': tc_class,
                        'name': tc_name,
                        'error': msg,
                        'type': 'failure'
                    })
                elif skipped_el is not None:
                    skipped += 1
                else:
                    passed += 1
    except Exception as e:
        print(f"⚠ 解析失败 {jf}: {e}", file=sys.stderr)

# 也尝试从 metrics.json 读取补充数据
metrics_data = {}
metrics_files = glob.glob(os.path.join(output_root, "**", "metrics.json"), recursive=True)
for mf in metrics_files:
    try:
        with open(mf) as f:
            data = json.load(f)
            metrics_data.update(data)
    except Exception:
        pass

# 计算通过率
pass_rate = (passed / total * 100) if total > 0 else 0

# 选择 emoji
if failed == 0 and errors == 0:
    icon = "✅"
    status_text = "全部通过"
elif pass_rate >= 80:
    icon = "⚠️"
    status_text = "部分失败"
else:
    icon = "❌"
    status_text = "大量失败"

# 生成 Markdown
lines = []
lines.append(f"## {icon} 测试执行摘要")
lines.append("")
lines.append(f"**状态**: {status_text}")
lines.append("")
lines.append("### 统计概览")
lines.append("")
lines.append("| 指标 | 值 |")
lines.append("|------|------|")
lines.append(f"| 总用例数 | {total} |")
lines.append(f"| ✅ 通过 | {passed} |")
lines.append(f"| ❌ 失败 | {failed} |")
lines.append(f"| 💥 错误(超时) | {errors} |")
lines.append(f"| ⏭️ 跳过 | {skipped} |")
lines.append(f"| 📊 通过率 | {pass_rate:.1f}% |")
lines.append(f"| ⏱️ 总耗时 | {total_time:.1f}s |")
lines.append("")

# 失败用例列表
if failed_cases:
    lines.append("### ❌ 失败用例")
    lines.append("")
    lines.append("| 模块 | 用例 | 错误 | 类型 |")
    lines.append("|------|------|------|------|")
    for fc in failed_cases[:20]:  # 最多展示 20 条
        error_short = fc['error'][:80] + ('...' if len(fc['error']) > 80 else '')
        lines.append(f"| {fc['feature']} | {fc['name']} | {error_short} | {fc['type']} |")
    if len(failed_cases) > 20:
        lines.append(f"\n> 还有 {len(failed_cases) - 20} 条失败用例未展示...")
    lines.append("")

# 度量数据
if metrics_data:
    lines.append("### 📈 执行度量")
    lines.append("")
    lines.append("| 指标 | 值 |")
    lines.append("|------|------|")
    for key, val in list(metrics_data.items())[:10]:
        lines.append(f"| {key} | {val} |")
    lines.append("")

# 报告链接
lines.append("### 🔗 报告与产物")
lines.append("")
lines.append(f"- **JUnit XML**: `{output_root}` (CI artifacts)")
lines.append(f"- **报告目录**: `{output_root}`")

# 尝试读取 OSS 上传链接
oss_links_file = os.path.join(output_root, "..", "..", "oss-links.txt")
if os.path.exists(oss_links_file):
    try:
        with open(oss_links_file) as f:
            oss_links = [l.strip() for l in f if l.strip()]
        if oss_links:
            lines.append("")
            lines.append("### 🌐 OSS 在线报告")
            lines.append("")
            for link in oss_links:
                lines.append(f"- [{link}]({link})")
    except Exception:
        pass

lines.append("")
lines.append("---")
lines.append(f"_生成时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}_")

# 写入 summary 文件
content = "\n".join(lines)
try:
    with open(summary_file, 'a') as f:
        f.write(content + "\n")
    print(f"✅ GitHub Summary 已写入: {summary_file}")
except Exception as e:
    print(content)
    print(f"⚠ 写入 summary 文件失败: {e}", file=sys.stderr)
PYTHON_SCRIPT

echo "✅ GitHub Summary 生成完成"
