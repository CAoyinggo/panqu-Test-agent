#!/bin/bash
# Pre-commit 安全扫描：仅扫描暂存文件中的 ERROR 级别安全问题
# 由 lint-staged 调用，暂存文件路径作为参数传入
# 用法：bash scripts/security/pre-commit-scan.sh file1.ts file2.ts
# 退出码：0=通过，1=发现 ERROR 级别问题

set -euo pipefail

# 无文件时跳过
if [ $# -eq 0 ]; then
  exit 0
fi

REPORT_DIR="security-reports"
mkdir -p "$REPORT_DIR"

echo "── Pre-commit SAST 扫描 ──"
echo "扫描文件：$#"

# 运行 semgrep，仅扫描暂存文件
semgrep --config config/security/semgrep.yml --json --output "$REPORT_DIR/semgrep-precommit.json" "$@" 2>/dev/null || true

# 检查 ERROR 级别问题
ERROR_COUNT=$(python3 -c "
import json, sys
try:
    with open('$REPORT_DIR/semgrep-precommit.json') as f:
        data = json.load(f)
    results = data.get('results', [])
    errors = [r for r in results if r.get('extra', {}).get('severity') == 'ERROR']
    for e in errors:
        check_id = e.get('check_id', '?')
        path = e.get('path', '?')
        line = e.get('start', {}).get('line', '?')
        msg = e.get('extra', {}).get('message', '?')
        print(f'  ❌ {check_id}: {path}:{line} — {msg}', file=sys.stderr)
    print(len(errors))
except Exception as ex:
    print(f'0', file=sys.stdout)
" 2>&1 || echo "0")

if [ "$ERROR_COUNT" -gt 0 ]; then
  echo "❌ Pre-commit 扫描发现 $ERROR_COUNT 个 ERROR 级别安全问题（硬编码密钥等）"
  echo "修复后重新暂存并提交，或使用 --no-verify 跳过（不推荐）"
  exit 1
fi

echo "✅ Pre-commit SAST 扫描通过"
exit 0
