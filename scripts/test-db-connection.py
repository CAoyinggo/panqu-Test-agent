#!/usr/bin/env python3
"""
Test-Flow 只读数据库连接与状态检查工具（预检）
凭据自动检索本目录 db-credentials.json 或独立配置目录；支持 DBeaver 同款 SSH 隧道与直连。
两种输出：默认人读诊断；`--json` 输出结构化预检 {ok, stage, tables, error}，供 db-preflight.ts 消费。
严禁向 Git 硬编码任何账号密码。
"""

import json
import os
import sys
import argparse


def resolve_cred_path(explicit=None):
    candidates = [
        explicit or "",
        os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "db-credentials.json"),
        os.path.join(os.getcwd(), "db-credentials.json"),
        os.environ.get("DB_CRED_PATH", ""),
        "/Users/mac/agents/test-Configuration/db-credentials.json",
    ]
    for path in candidates:
        if path and os.path.exists(path):
            return path
    return None


def _connect(cred, pymysql, SSHTunnelForwarder, out):
    """建连并数 pq_ 表；逐阶段更新 out['stage']。返回 (ok, tables)。"""
    ssh = cred.get("ssh_tunnel")
    if ssh and ssh.get("enabled"):
        with SSHTunnelForwarder(
            (ssh["host"], int(ssh.get("port", 22))),
            ssh_username=ssh["user"],
            ssh_password=ssh.get("password"),
            remote_bind_address=(cred["host"], int(cred.get("port", 3306))),
        ) as tunnel:
            out["stage"] = "ssh"
            conn = pymysql.connect(host="127.0.0.1", port=tunnel.local_bind_port, user=cred["user"],
                                   password=cred["password"], database=cred["database"],
                                   charset=cred.get("charset", "utf8mb4"), connect_timeout=10)
            out["stage"] = "mysql"
            with conn.cursor() as cur:
                cur.execute("SHOW TABLES LIKE 'pq_%';")
                n = len(cur.fetchall())
            conn.close()
            return True, n
    conn = pymysql.connect(host=cred["host"], port=int(cred.get("port", 3306)), user=cred["user"],
                           password=cred["password"], database=cred["database"],
                           charset=cred.get("charset", "utf8mb4"), connect_timeout=8)
    out["stage"] = "mysql"
    with conn.cursor() as cur:
        cur.execute("SHOW TABLES LIKE 'pq_%';")
        n = len(cur.fetchall())
    conn.close()
    return True, n


# SEC_JSON

def preflight_json(cred_path):
    """结构化预检：逐阶段判定 credentials→deps→ssh→mysql→connected，输出一行 JSON。"""
    out = {"ok": False, "stage": "credentials", "tables": 0}
    if not cred_path:
        out["error"] = "MISSING_CREDENTIALS"
        print(json.dumps(out, ensure_ascii=False))
        return
    try:
        with open(cred_path, "r", encoding="utf-8") as f:
            cred = json.load(f)
    except Exception as e:
        out["error"] = f"cred unreadable: {e}"
        print(json.dumps(out, ensure_ascii=False))
        return
    out["stage"] = "deps"
    try:
        import pymysql
        import paramiko
        # paramiko 5.x 移除 DSSKey；sshtunnel 0.4.0 仍引用 → 别名回退 RSAKey（PASSWORD 认证不受影响）
        if not hasattr(paramiko, "DSSKey"):
            paramiko.DSSKey = paramiko.RSAKey
        import sshtunnel
        from sshtunnel import SSHTunnelForwarder
        sshtunnel.SSH_TIMEOUT = 8.0
        sshtunnel.TUNNEL_TIMEOUT = 8.0
    except ImportError as e:
        out["error"] = f"MISSING_DEPENDENCY: {e}"
        print(json.dumps(out, ensure_ascii=False))
        return
    try:
        ok, n = _connect(cred, pymysql, SSHTunnelForwarder, out)
        out["ok"] = ok
        out["tables"] = n
        out["stage"] = "connected"
    except Exception as e:
        out["error"] = str(e)  # stage 停留在最后到达处（ssh/mysql），便于区分连通性失败层次
    print(json.dumps(out, ensure_ascii=False, default=str))


def run_diagnostics(conn):
    with conn.cursor() as cursor:
        cursor.execute("SELECT VERSION();")
        print(f"✅ 连接成功！MySQL 版本: {cursor.fetchone()[0]}")
        cursor.execute("SHOW TABLES LIKE 'pq_%';")
        tables = cursor.fetchall()
        print(f"✅ 找到 {len(tables)} 张 pq_ 前缀核心业务表")
        for table_name in ["pq_score_log", "pq_aivideo_new", "pq_volcengine_ai_task", "pq_aivideo_diversion_config"]:
            try:
                cursor.execute(f"SELECT COUNT(*) FROM `{table_name}`;")
                print(f"   - [{table_name}] 记录总数: {cursor.fetchone()[0]}")
            except Exception as table_err:
                print(f"   - [{table_name}] 查询异常: {table_err}")


def main():
    parser = argparse.ArgumentParser(description="只读 DB 连接预检")
    parser.add_argument("--cred-path", type=str)
    parser.add_argument("--json", action="store_true", help="结构化预检输出 {ok,stage,tables,error}")
    args = parser.parse_args()
    cred_path = resolve_cred_path(args.cred_path)

    if args.json:
        preflight_json(cred_path)
        return

    if not cred_path:
        print("❌ 找不到凭据文件")
        sys.exit(1)
    print(f"📄 加载凭据文件: {cred_path}")
    with open(cred_path, "r", encoding="utf-8") as f:
        cred = json.load(f)
    try:
        import pymysql
        import paramiko
        if not hasattr(paramiko, "DSSKey"):
            paramiko.DSSKey = paramiko.RSAKey
        import sshtunnel
        from sshtunnel import SSHTunnelForwarder
        sshtunnel.SSH_TIMEOUT = 8.0
        sshtunnel.TUNNEL_TIMEOUT = 8.0
    except ImportError as e:
        print(f"❌ 依赖缺失: {e}（pip install pymysql sshtunnel paramiko）")
        sys.exit(1)
    ssh = cred.get("ssh_tunnel")
    try:
        if ssh and ssh.get("enabled"):
            print(f"🚀 [SSH 隧道] {ssh.get('user')}@{ssh.get('host')}:{ssh.get('port')} → {cred.get('host')}:{cred.get('port')}/{cred.get('database')}")
            with SSHTunnelForwarder(
                (ssh["host"], int(ssh.get("port", 22))), ssh_username=ssh["user"], ssh_password=ssh.get("password"),
                remote_bind_address=(cred["host"], int(cred.get("port", 3306)))
            ) as tunnel:
                conn = pymysql.connect(host="127.0.0.1", port=tunnel.local_bind_port, user=cred["user"],
                                       password=cred["password"], database=cred["database"],
                                       charset=cred.get("charset", "utf8mb4"), connect_timeout=10)
                try:
                    run_diagnostics(conn)
                finally:
                    conn.close()
            print("\n🎉 SSH 隧道取证链路畅通！")
        else:
            conn = pymysql.connect(host=cred["host"], port=int(cred.get("port", 3306)), user=cred["user"],
                                   password=cred["password"], database=cred["database"],
                                   charset=cred.get("charset", "utf8mb4"), connect_timeout=8)
            try:
                run_diagnostics(conn)
            finally:
                conn.close()
            print("\n🎉 直连测试通过！")
    except Exception as e:
        print(f"\n❌ 连接失败: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()

