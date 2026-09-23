#!/usr/bin/env bash
# 一键启动本地 SSH 隧道映射到火山引擎 RDS 测试库
# 默认映射到本地 127.0.0.1:3306 (如 3306 被占用则可用 3307 等)

LOCAL_PORT=${1:-3306}
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRED_FILE="$DIR/db-credentials.json"

if [ ! -f "$CRED_FILE" ]; then
    echo "❌ 找不到 $CRED_FILE"
    exit 1
fi

SSH_HOST=$(python3 -c "import json; d=json.load(open('$CRED_FILE')); print(d['ssh_tunnel']['host'])")
SSH_PORT=$(python3 -c "import json; d=json.load(open('$CRED_FILE')); print(d['ssh_tunnel']['port'])")
SSH_USER=$(python3 -c "import json; d=json.load(open('$CRED_FILE')); print(d['ssh_tunnel']['user'])")
SSH_PASS=$(python3 -c "import json; d=json.load(open('$CRED_FILE')); print(d['ssh_tunnel']['password'])")
DB_HOST=$(python3 -c "import json; d=json.load(open('$CRED_FILE')); print(d['host'])")
DB_PORT=$(python3 -c "import json; d=json.load(open('$CRED_FILE')); print(d['port'])")

echo "🚀 正在建立 SSH 隧道: 本地 127.0.0.1:${LOCAL_PORT} -> ${DB_HOST}:${DB_PORT} (通过跳板机 ${SSH_USER}@${SSH_HOST}:${SSH_PORT})"

python3 - << PYEOF
import sys, paramiko
if not hasattr(paramiko, "DSSKey"): paramiko.DSSKey = None
from sshtunnel import SSHTunnelForwarder

try:
    with SSHTunnelForwarder(
        ('${SSH_HOST}', int(${SSH_PORT})),
        ssh_username='${SSH_USER}',
        ssh_password='${SSH_PASS}',
        remote_bind_address=('${DB_HOST}', int(${DB_PORT})),
        local_bind_address=('127.0.0.1', int(${LOCAL_PORT}))
    ) as tunnel:
        print(f"✅ SSH 隧道已就绪！")
        print(f"👉 本地 MySQL 连接地址: 127.0.0.1:${LOCAL_PORT}")
        print("按 Ctrl+C 可停止隧道。")
        tunnel.serve_forever()
except KeyboardInterrupt:
    print("\n🛑 SSH 隧道已停止。")
except Exception as e:
    print(f"❌ 启动失败: {e}")
    sys.exit(1)
PYEOF
