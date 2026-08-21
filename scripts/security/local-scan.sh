#!/bin/bash
# 本地安全扫描 — 快速运行所有安全扫描工具
# 用法：npm run security:local
# 输出：security-reports/ 目录下的各项报告
# 退出码：0=全部通过，1=存在问题

set -euo pipefail

REPORT_DIR="security-reports"
mkdir -p "$REPORT_DIR"

HAS_ERROR=0

echo "════════════════════════════════════════"
echo "  test-flow 本地安全扫描"
echo "════════════════════════════════════════"
echo ""

# ── 1. SAST (Semgrep) ──
echo "── [1/4] SAST 扫描 (Semgrep) ──"
if command -v semgrep &>/dev/null; then
  semgrep --config config/security/semgrep.yml --json --output "$REPORT_DIR/semgrep.json" . 2>/dev/null || true
  ERROR_COUNT=$(python3 -c "
import json
try:
    with open('$REPORT_DIR/semgrep.json') as f:
        data = json.load(f)
    print(sum(1 for r in data.get('results', []) if r.get('extra', {}).get('severity') == 'ERROR'))
except:
    print(0)
" 2>/dev/null || echo "0")
  if [ "$ERROR_COUNT" -gt 0 ]; then
    echo "  ❌ $ERROR_COUNT 个 ERROR 级别问题"
    HAS_ERROR=1
  else
    echo "  ✅ 无 ERROR 级别问题"
  fi
else
  echo "  ⚠ semgrep 未安装，跳过"
  echo "    安装：pip install semgrep 或 brew install semgrep"
fi
echo ""

# ── 2. 密钥泄露 (Gitleaks) ──
echo "── [2/4] 密钥泄露扫描 (Gitleaks) ──"
if command -v gitleaks &>/dev/null; then
  gitleaks detect --config config/security/gitleaks.toml --report-format json --report-path "$REPORT_DIR/gitleaks.json" --source . 2>/dev/null || true
  LEAK_COUNT=$(python3 -c "
import json
try:
    with open('$REPORT_DIR/gitleaks.json') as f:
        data = json.load(f)
    print(len(data))
except:
    print(0)
" 2>/dev/null || echo "0")
  if [ "$LEAK_COUNT" -gt 0 ]; then
    echo "  ❌ $LEAK_COUNT 个密钥泄露"
    HAS_ERROR=1
  else
    echo "  ✅ 未检测到密钥泄露"
  fi
else
  echo "  ⚠ gitleaks 未安装，跳过"
  echo "    安装：brew install gitleaks"
fi
echo ""

# ── 3. 依赖漏洞 (npm audit) ──
echo "── [3/4] 依赖漏洞扫描 (npm audit) ──"
bash scripts/security/audit.sh || HAS_ERROR=1
echo ""

# ── 4. License 合规 ──
echo "── [4/4] License 合规扫描 ──"
bash scripts/security/license-check.sh || true
echo ""

echo "════════════════════════════════════════"
if [ "$HAS_ERROR" -gt 0 ]; then
  echo "  ❌ 安全扫描发现问题，请修复后再提交"
else
  echo "  ✅ 安全扫描全部通过"
fi
echo "  报告目录: $REPORT_DIR/"
echo "════════════════════════════════════════"

exit $HAS_ERROR
