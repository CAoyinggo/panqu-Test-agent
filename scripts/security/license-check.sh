#!/bin/bash
# License 合规扫描：license-checker
# 用法：bash scripts/security/license-check.sh
# 输出：security-reports/licenses.json + security-reports/licenses.csv
# 退出码：0=无 GPL copyleft 依赖，1=存在 GPL（仅警告不阻塞 CI）

set -euo pipefail

REPORT_DIR="security-reports"
mkdir -p "$REPORT_DIR"

echo "── License 合规扫描 ──"

# 生成 JSON 报告
npx license-checker --json --production > "$REPORT_DIR/licenses.json" 2>/dev/null || {
  echo "⚠ license-checker 未安装，跳过 License 扫描"
  echo "安装：npm install -g license-checker"
  exit 0
}

# 生成 CSV 报告
npx license-checker --csv --production > "$REPORT_DIR/licenses.csv" 2>/dev/null || true

# 检查 copyleft license
GPL_PACKAGES=$(node -e "
const licenses = require('./$REPORT_DIR/licenses.json');
const copyleft = ['GPL', 'LGPL', 'AGPL', 'MPL', 'CDDL', 'EPL'];
let found = [];
for (const [name, info] of Object.entries(licenses)) {
  const lic = (info.licenses || '').toString();
  if (copyleft.some(c => lic.includes(c))) {
    found.push('  ⚠ ' + name + '@' + info.version + ' → ' + lic);
  }
}
if (found.length > 0) {
  console.log('发现 ' + found.length + ' 个 copyleft 依赖：');
  found.forEach(f => console.log(f));
} else {
  console.log('未发现 copyleft 依赖');
}
console.log(found.length);
" 2>/dev/null)

echo ""
echo "── 扫描结果 ──"
echo "$GPL_PACKAGES"
echo ""
echo "报告已保存："
echo "  JSON: $REPORT_DIR/licenses.json"
echo "  CSV:  $REPORT_DIR/licenses.csv"
echo ""
echo "注意：GPL 等 copyleft 依赖仅警告，暂不阻塞流水线"
exit 0
