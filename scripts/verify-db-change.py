#!/usr/bin/env python3
"""
Test-Flow 数据变更数据库取证核验工具
用途: 测试执行中存在数据变更时，自动通过 SSH 隧道连接测试库，核验物理落库证据。
严格只读 (READ ONLY)，支持按 task_id 或 user_id 取证。
"""

import argparse
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

def main():
    parser = argparse.ArgumentParser(description="核验数据库真实数据变更事实")
    parser.add_argument("--task-id", type=str, help="任务 ID")
    parser.add_argument("--user-id", type=str, help="用户 ID")
    parser.add_argument("--cred-path", type=str, help="凭据文件路径 (可选)")
    parser.add_argument("--json", action="store_true", help="以 JSON 格式输出结果")
    args = parser.parse_args()

    cred_path = args.cred_path or resolve_cred_path()
    if not cred_path:
        res = {"status": "UNVERIFIED", "error": "MISSING_CREDENTIALS", "message": "找不到 db-credentials.json"}
        print(json.dumps(res, ensure_ascii=False) if args.json else res["message"])
        sys.exit(1)

    with open(cred_path, "r", encoding="utf-8") as f:
        cred = json.load(f)

    try:
        import pymysql
        import paramiko
        if not hasattr(paramiko, "DSSKey"): paramiko.DSSKey = None
        import sshtunnel
        from sshtunnel import SSHTunnelForwarder
        # SSH 连接/隧道快速失败：跳板机不可达时约 8s 内失败，避免上层 execFile 长时间卡死
        sshtunnel.SSH_TIMEOUT = 8.0
        sshtunnel.TUNNEL_TIMEOUT = 8.0
    except ImportError as e:
        res = {"status": "UNVERIFIED", "error": "MISSING_DEPENDENCY", "message": str(e)}
        print(json.dumps(res, ensure_ascii=False) if args.json else f"❌ 依赖缺失: {e}")
        sys.exit(1)

    ssh_config = cred.get("ssh_tunnel", {})
    evidence = {
        "status": "UNVERIFIED",
        "taskId": args.task_id,
        "userId": args.user_id,
        "recordsFound": {}
    }

    try:
        with SSHTunnelForwarder(
            (ssh_config["host"], int(ssh_config["port"])),
            ssh_username=ssh_config["user"],
            ssh_password=ssh_config["password"],
            remote_bind_address=(cred["host"], int(cred.get("port", 3306)))
        ) as tunnel:
            conn = pymysql.connect(
                host="127.0.0.1",
                port=tunnel.local_bind_port,
                user=cred["user"],
                password=cred["password"],
                database=cred["database"],
                charset=cred.get("charset", "utf8mb4"),
                connect_timeout=10,
                cursorclass=pymysql.cursors.DictCursor
            )
            with conn.cursor() as cur:
                if args.task_id:
                    tid = str(args.task_id).strip()

                    # 1. 查询 aivideo_new (前台任务表，主键为 id)
                    v_rec = None
                    cur.execute("SELECT * FROM pq_aivideo_new WHERE id = %s LIMIT 1;", (tid,))
                    v_rec = cur.fetchone()
                    if v_rec:
                        evidence["recordsFound"]["pq_aivideo_new"] = v_rec

                    # 2. 查询 volcengine_ai_task (后台调度表，id 或 source_id 或 task_id)
                    t_rec = None
                    cur.execute(
                        "SELECT * FROM pq_volcengine_ai_task WHERE id = %s OR source_id = %s OR task_id = %s ORDER BY id DESC LIMIT 1;",
                        (tid, tid, tid)
                    )
                    t_rec = cur.fetchone()
                    if t_rec:
                        evidence["recordsFound"]["pq_volcengine_ai_task"] = t_rec

                    # 3. 查询关联积分流水 (pq_score_log: task_id 对应后台任务 id 或前台 id，source_id 对应前台 id)
                    backend_id = t_rec["id"] if t_rec and "id" in t_rec else None
                    frontend_id = v_rec["id"] if v_rec and "id" in v_rec else None
                    cur.execute(
                        """
                        SELECT * FROM pq_score_log 
                        WHERE task_id = %s OR source_id = %s 
                           OR (%s IS NOT NULL AND task_id = %s) 
                           OR (%s IS NOT NULL AND source_id = %s)
                        ORDER BY id DESC LIMIT 10;
                        """,
                        (tid, tid, backend_id, backend_id, frontend_id, frontend_id)
                    )
                    s_recs = cur.fetchall()
                    if s_recs:
                        evidence["recordsFound"]["pq_score_log"] = s_recs


                if args.user_id:
                    # pq_score_log 的用户字段为 userid
                    cur.execute("SELECT * FROM pq_score_log WHERE userid = %s ORDER BY id DESC LIMIT 5;", (args.user_id,))
                    evidence["recordsFound"]["user_score_logs"] = cur.fetchall()

            conn.close()

        # 根据是否查询到数据判定状态
        if any(evidence["recordsFound"].values()):
            evidence["status"] = "VERIFIED"
        else:
            evidence["status"] = "UNVERIFIED"
            evidence["reason"] = "NO_RECORD_FOUND"

    except Exception as e:
        evidence["status"] = "UNVERIFIED"
        evidence["error"] = str(e)

    if args.json:
        # 处理 datetime 序列化
        print(json.dumps(evidence, ensure_ascii=False, default=str))
    else:
        print(f"📊 数据库取证状态: {evidence['status']}")
        for k, v in evidence["recordsFound"].items():
            print(f"  ✅ 表 [{k}]: 找到记录")

if __name__ == "__main__":
    main()
