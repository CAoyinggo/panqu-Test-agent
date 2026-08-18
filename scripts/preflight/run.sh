#!/bin/bash
# agent preflight（Phase 20.8）：构建后运行环境自检
# 用法：bash scripts/preflight/run.sh [--json]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

if [ ! -f dist/bin/preflight.js ]; then
  echo "dist 未构建，先执行 npm run build"
  npm run build
fi

exec node dist/bin/preflight.js "$@"
