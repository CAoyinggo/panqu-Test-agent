#!/usr/bin/env python3
"""Read-only reader for pq_absetting list/cost prices (runtime billing truth).

刊例价/成本价的运行时真源是 pq_absetting（AB 库，含 resolution 整数码）。本脚本按
model_config_id 拉取该模型全部启用计价行，输出结构化 JSON，供 absetting-price-reader.ts 消费。
STRICTLY READ-ONLY。AB 库名可 --ab-db 指定，否则读 cred.ab_database，再否则自动探测
（枚举 schemata → 探测哪个库的 pq_absetting 有 resolution 列，优先含 'ab' 且非 'sea'）。

Usage:  python3 scripts/read-absetting-price.py --model 12 [--ab-db ai_video_ab_test] --json
"""
import os
import sys
import json
import argparse


def resolve_cred_path(explicit=None):
    for p in [
        explicit or "",
        os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "db-credentials.json"),
        os.path.join(os.getcwd(), "db-credentials.json"),
        os.environ.get("DB_CRED_PATH", ""),
        "/Users/mac/agents/test-Configuration/db-credentials.json",
    ]:
        if p and os.path.exists(p):
            return p
    return None


def detect_ab_schema(cur, explicit):
    if explicit:
        return explicit
    cur.execute("SELECT SCHEMA_NAME FROM information_schema.schemata;")
    schemas = [r["SCHEMA_NAME"] for r in cur.fetchall()]
    ranked = (
        [s for s in schemas if "ab" in s.lower() and "sea" not in s.lower()]
        + [s for s in schemas if "ab" in s.lower()]
        + schemas
    )
    seen = set()
    for s in ranked:
        if s in seen:
            continue
        seen.add(s)
        try:
            cur.execute(f"SELECT resolution FROM `{s}`.pq_absetting LIMIT 0;")
            return s
        except Exception:
            continue
    return None


# SEC_ABMAIN

def main():
    parser = argparse.ArgumentParser(description="只读读取 pq_absetting 刊例/成本价")
    parser.add_argument("--model", type=int, required=True, help="model_config_id")
    parser.add_argument("--ab-db", type=str, help="AB 库名（缺省读 cred.ab_database 或自动探测）")
    parser.add_argument("--cred-path", type=str)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    out = {"status": "UNVERIFIED", "abSchema": None, "model": args.model, "rows": []}
    cred_path = args.cred_path or resolve_cred_path()
    if not cred_path:
        out["error"] = "MISSING_CREDENTIALS"
        print(json.dumps(out, ensure_ascii=False))
        return
    with open(cred_path, "r", encoding="utf-8") as f:
        cred = json.load(f)

    try:
        import paramiko
        if not hasattr(paramiko, "DSSKey"):
            paramiko.DSSKey = paramiko.RSAKey
        import sshtunnel
        from sshtunnel import SSHTunnelForwarder
        import pymysql
        sshtunnel.SSH_TIMEOUT = 8.0
        sshtunnel.TUNNEL_TIMEOUT = 8.0
    except ImportError as e:
        out["error"] = f"MISSING_DEPENDENCY: {e}"
        print(json.dumps(out, ensure_ascii=False))
        return

    ab_db = args.ab_db or cred.get("ab_database")
    ssh = cred.get("ssh_tunnel", {})

    def query(cur):
        nonlocal ab_db
        ab_db = detect_ab_schema(cur, ab_db)
        if not ab_db:
            out["error"] = "AB_SCHEMA_NOT_FOUND（请用 --ab-db 指定或在 cred.ab_database 配置）"
            return
        out["abSchema"] = ab_db
        cur.execute(
            f"SELECT model_config_id,task_type,resolution,billing_type,list_price_points,cost_price,"
            f"model_name,extend_field,status FROM `{ab_db}`.pq_absetting "
            f"WHERE model_config_id=%s AND status=1 ORDER BY task_type,resolution;",
            (args.model,),
        )
        out["rows"] = cur.fetchall()
        out["status"] = "VERIFIED"

    try:
        import pymysql.cursors
        if ssh and ssh.get("enabled", True) and ssh.get("host"):
            with SSHTunnelForwarder(
                (ssh["host"], int(ssh.get("port", 22))), ssh_username=ssh["user"], ssh_password=ssh.get("password"),
                remote_bind_address=(cred["host"], int(cred.get("port", 3306))),
            ) as tunnel:
                conn = pymysql.connect(host="127.0.0.1", port=tunnel.local_bind_port, user=cred["user"],
                                       password=cred["password"], database=cred["database"],
                                       charset=cred.get("charset", "utf8mb4"), connect_timeout=10,
                                       cursorclass=pymysql.cursors.DictCursor)
                with conn.cursor() as cur:
                    query(cur)
                conn.close()
        else:
            conn = pymysql.connect(host=cred["host"], port=int(cred.get("port", 3306)), user=cred["user"],
                                   password=cred["password"], database=cred["database"],
                                   charset=cred.get("charset", "utf8mb4"), connect_timeout=8,
                                   cursorclass=pymysql.cursors.DictCursor)
            with conn.cursor() as cur:
                query(cur)
            conn.close()
    except Exception as e:
        out["status"] = "UNVERIFIED"
        out["error"] = str(e)

    print(json.dumps(out, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
