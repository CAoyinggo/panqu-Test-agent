#!/usr/bin/env python3
"""
Test-Flow 只读数据库连接与状态检查工具
凭据读取自本地独立凭据目录: /Users/mac/agents/test-Configuration/db-credentials.json
支持 DBeaver 同款 SSH 隧道（SSH Tunnel）跳板代理连接与直连双模式
严禁向 Git 代码库硬编码任何账号密码
"""

import json
import os
import sys

def resolve_cred_path():
    candidates = [
        os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "db-credentials.json"),
        os.path.join(os.getcwd(), "db-credentials.json"),
        os.environ.get("DB_CRED_PATH", ""),
        "/Users/mac/agents/test-Configuration/db-credentials.json",
    ]
    for path in candidates:
        if path and os.path.exists(path):
            return path
    return None

def run_diagnostics(conn):
    with conn.cursor() as cursor:
        cursor.execute("SELECT VERSION();")
        ver = cursor.fetchone()
        print(f"✅ 连接成功！MySQL 版本: {ver[0]}")

        cursor.execute("SHOW TABLES LIKE 'pq_%';")
        tables = cursor.fetchall()
        print(f"✅ 找到 {len(tables)} 张 pq_ 前缀核心业务表:")
        for t in tables[:15]:
            print(f"   - {t[0]}")
        if len(tables) > 15:
            print(f"   ... (还有 {len(tables) - 15} 张表)")

        # 测试关键表只读查询
        print("\n📊 核心业务表当前只读记录抽样:")
        for table_name in ["pq_user_score_log", "pq_score_log", "pq_aivideo_new", "pq_volcengine_ai_task", "pq_admin"]:
            try:
                cursor.execute(f"SELECT COUNT(*) FROM `{table_name}`;")
                cnt = cursor.fetchone()
                print(f"   - [{table_name}] 当前记录总数: {cnt[0]}")
            except Exception as table_err:
                print(f"   - [{table_name}] 查询异常: {table_err}")


def main():
    cred_path = resolve_cred_path()
    if not cred_path:
        print(f"❌ 找不到凭据文件 (已检索本目录 db-credentials.json 与配置目录)")
        sys.exit(1)

    print(f"📄 加载凭据文件: {cred_path}")
    with open(cred_path, "r", encoding="utf-8") as f:
        cred = json.load(f)

    db_host = cred.get("host")
    db_port = int(cred.get("port", 3306))
    db_user = cred.get("user")
    db_password = cred.get("password")
    db_name = cred.get("database")
    db_charset = cred.get("charset", "utf8mb4")

    ssh_config = cred.get("ssh_tunnel")

    try:
        import pymysql
    except ImportError:
        print("❌ 缺少 pymysql 依赖，请运行: python3 -m pip install pymysql")
        sys.exit(1)

    if ssh_config and ssh_config.get("enabled"):
        ssh_host = ssh_config.get("host")
        ssh_port = int(ssh_config.get("port", 22))
        ssh_user = ssh_config.get("user")
        ssh_password = ssh_config.get("password")

        print("🚀 [DBeaver 模式] 检测到 SSH 隧道配置，正在建立跳板机安全隧道...")
        print(f"   跳板机: {ssh_user}@{ssh_host}:{ssh_port}")
        print(f"   目标库: {db_user}@{db_host}:{db_port}/{db_name}")

        try:
            import paramiko
            # 兼容 Python 3.14 / paramiko 3.x 弃用 DSSKey 的情况
            if not hasattr(paramiko, "DSSKey"):
                paramiko.DSSKey = None
            from sshtunnel import SSHTunnelForwarder
        except ImportError:
            print("❌ 缺少 sshtunnel 或 paramiko 依赖，请运行: python3 -m pip install sshtunnel paramiko")
            sys.exit(1)

        try:
            with SSHTunnelForwarder(
                (ssh_host, ssh_port),
                ssh_username=ssh_user,
                ssh_password=ssh_password,
                remote_bind_address=(db_host, db_port)
            ) as tunnel:
                local_port = tunnel.local_bind_port
                print(f"🔒 SSH 隧道建立成功！本地映射端口: 127.0.0.1:{local_port}")
                print(f"   正在通过隧道连接 MySQL 数据库...")

                conn = pymysql.connect(
                    host="127.0.0.1",
                    port=local_port,
                    user=db_user,
                    password=db_password,
                    database=db_name,
                    charset=db_charset,
                    connect_timeout=10
                )
                try:
                    run_diagnostics(conn)
                finally:
                    conn.close()

            print("\n🎉 [DBeaver 模式] SSH 隧道连接测试完全通过，取证链路畅通！")
        except Exception as e:
            print(f"\n❌ [SSH 隧道连接失败]: {e}")
            sys.exit(1)
    else:
        print(f"正在直连火山引擎 RDS 测试库: {db_host}:{db_port} ...")
        print(f"数据库名: {db_name}, 用户名: {db_user}")

        try:
            conn = pymysql.connect(
                host=db_host,
                port=db_port,
                user=db_user,
                password=db_password,
                database=db_name,
                charset=db_charset,
                connect_timeout=8
            )
            try:
                run_diagnostics(conn)
            finally:
                conn.close()

            print("\n🎉 直连测试完全通过！")
        except pymysql.MySQLError as e:
            err_code, err_msg = e.args[0], e.args[1] if len(e.args) > 1 else str(e)
            print(f"\n❌ 连接失败: [{err_code}] {err_msg}")
            if "white List" in err_msg or "IP NOT IN white List" in err_msg or err_code == 1045:
                print("\n💡 原因诊断：火山引擎 RDS 白名单拦截")
                print("请在 /Users/mac/agents/test-Configuration/db-credentials.json 中启用 ssh_tunnel 配置（与 DBeaver 保持一致）。")

if __name__ == "__main__":
    main()

