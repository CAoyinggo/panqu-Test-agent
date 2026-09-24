#!/usr/bin/env python3
"""Read-only reader for the NewAPI diversion runtime-eligibility config.

Pulls `pq_aivideo_diversion_config` (line=10) + `pq_model_config` over the SSH
tunnel and emits the route-rules / route-mode / global-model set / alias map that
`NewapiDiversionRuleService` enforces at request time. STRICTLY READ-ONLY.

Output JSON: {status, routeMode, routeRules, groupRules, globalApiKeyConfigured,
              globalModelIds, aliasMap}
Usage:  python3 scripts/read-diversion-config.py --cred-path <path> --json
"""
import os
import sys
import json
import argparse


def resolve_cred_path():
    for p in [
        os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "db-credentials.json"),
        os.path.join(os.getcwd(), "db-credentials.json"),
        "/Users/mac/agents/test-flow/db-credentials.json",
        "/Users/mac/agents/test-Configuration/db-credentials.json",
    ]:
        if os.path.exists(p):
            return p
    return None


def _loads(val, fallback):
    try:
        return json.loads(val) if isinstance(val, str) and val.strip() else fallback
    except Exception:
        return fallback


def main():
    parser = argparse.ArgumentParser(description="只读读取 NewAPI 分流资格配置 (line=10)")
    parser.add_argument("--cred-path", type=str, help="凭据文件路径 (可选)")
    parser.add_argument("--json", action="store_true", help="以 JSON 格式输出")
    args = parser.parse_args()

    cred_path = args.cred_path or resolve_cred_path()
    out = {"status": "UNVERIFIED", "routeMode": None, "routeRules": {}, "groupRules": {},
           "globalApiKeyConfigured": False, "globalModelIds": [], "aliasMap": {}}
    if not cred_path:
        out["error"] = "MISSING_CREDENTIALS"
        print(json.dumps(out, ensure_ascii=False))
        sys.exit(0)

    with open(cred_path, "r", encoding="utf-8") as f:
        cred = json.load(f)

    # SEC_MAIN
    try:
        import sshtunnel
        from sshtunnel import SSHTunnelForwarder
        import pymysql
        sshtunnel.SSH_TIMEOUT = 8.0
        sshtunnel.TUNNEL_TIMEOUT = 8.0
    except ImportError as e:
        out["error"] = f"依赖缺失: {e}"
        print(json.dumps(out, ensure_ascii=False))
        sys.exit(0)

    ssh_config = cred.get("ssh_tunnel", {})
    try:
        with SSHTunnelForwarder(
            (ssh_config["host"], int(ssh_config["port"])),
            ssh_username=ssh_config["user"],
            ssh_password=ssh_config["password"],
            remote_bind_address=(cred["host"], int(cred.get("port", 3306))),
        ) as tunnel:
            conn = pymysql.connect(
                host="127.0.0.1",
                port=tunnel.local_bind_port,
                user=cred["user"],
                password=cred["password"],
                database=cred["database"],
                charset=cred.get("charset", "utf8mb4"),
                connect_timeout=10,
                cursorclass=pymysql.cursors.DictCursor,
            )
            with conn.cursor() as cur:
                cur.execute("SELECT name, value FROM pq_aivideo_diversion_config WHERE line = 10;")
                cfg = {r["name"]: r["value"] for r in cur.fetchall()}
                cur.execute("SELECT id, newapi_model_alias, is_newapi_global FROM pq_model_config;")
                models = cur.fetchall()
            conn.close()

        out["routeMode"] = (str(cfg.get("newapi_route_mode") or "").strip().lower() or "newapi")
        out["routeRules"] = _loads(cfg.get("newapi_route_rules"), {})
        out["groupRules"] = _loads(cfg.get("newapi_route_group_rules"), {})
        out["globalApiKeyConfigured"] = bool(str(cfg.get("newapi_global_api_key") or "").strip())
        out["aliasMap"] = {str(m["id"]): (m.get("newapi_model_alias") or "") for m in models}
        out["globalModelIds"] = [int(m["id"]) for m in models if int(m.get("is_newapi_global") or 0) == 1]
        out["status"] = "VERIFIED" if cfg else "UNVERIFIED"
        if not cfg:
            out["reason"] = "NO_DIVERSION_CONFIG_ROWS"
    except Exception as e:
        out["status"] = "UNVERIFIED"
        out["error"] = str(e)

    print(json.dumps(out, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
