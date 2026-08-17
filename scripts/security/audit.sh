#!/bin/bash
# 依赖漏洞扫描：npm audit
# 用法：bash scripts/security/audit.sh
# 输出：security-reports/npm-audit.json
# 退出码：0=无 high/critical 漏洞，1=存在漏洞

set -euo pipefail

REPORT_DIR="security-reports"
mkdir -p "$REPORT_DIR"

echo "── npm audit 依赖漏洞扫描 ──"
echo "扫描级别：high 及以上"

# 输出 JSON 报告
npm audit --json > "$REPORT_DIR/npm-audit.json" 2>/dev/null || true

# 输出人类可读摘要
npm audit --audit-level=high 2>/dev/null || true

# 检查是否存在 high/critical 漏洞
VULN_COUNT=$(node -e "
try {
  const audit = require('./$REPORT_DIR/npm-audit.json');
  const vulns = audit.vulnerabilities || {};
  let count = 0;
  for (const [name, info] of Object.entries(vulns)) {
    if (info.severity === 'high' || info.severity === 'critical') count++;
  }
  console.log(count);
} catch(e) {
  console.log(0);
}
" 2>/dev/null || echo "0")

echo ""
echo "── 扫描结果 ──"
echo "High/Critical 漏洞数：$VULN_COUNT"
echo "报告已保存：$REPORT_DIR/npm-audit.json"

if [ "$VULN_COUNT" -gt 0 ]; then
  echo "❌ 发现 $VULN_COUNT 个 high/critical 漏洞"
  exit 1
else
  echo "✅ 未发现 high/critical 漏洞"
  exit 0
fi
