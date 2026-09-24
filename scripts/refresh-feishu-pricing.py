#!/usr/bin/env python3
"""Refresh the NewAPI-diversion pricing authority cache from the Feishu 《分流渠道表》.

Reads Feishu app credentials from a memory file (never prints token/secret), pulls
the diversion spreadsheet, parses the line-mapping + per-channel cost/points/eligibility,
resolves `J<row>*<discount>` cost formulas, and writes the machine-readable snapshot
consumed by `src/devtest/diversion-pricing-authority.ts`.

Usage:  python3 scripts/refresh-feishu-pricing.py
Env override:  FEISHU_CRED_FILE=/path/to/feishu-api-credentials.md
"""
import os, json, re, datetime, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CRED = os.environ.get(
    "FEISHU_CRED_FILE",
    "/Users/mac/.claude/projects/-Users-mac/memory/feishu-api-credentials.md",
)
SS = "TBaBsTTgmhQixPtzGHXcwdQZnWh"
URL = "https://panqu-ai.feishu.cn/wiki/NNxfwgI2fih5iekmKABcSn2Wnne?sheet=35279c"
OUT = os.path.join(HERE, "..", "src/devtest/assets/panqu-newapi-diversion/references/feishu-live-pricing-cache.json")
OUT = os.path.normpath(OUT)


def cred(label):
    with open(CRED, encoding="utf-8") as fh:
        for line in fh:
            if label in line:
                return line.split(label, 1)[1].strip().lstrip(":").strip()
    raise SystemExit("cred not found: " + label)


def post(url, body):
    req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=20))


def get(url, token):
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + token})
    return json.load(urllib.request.urlopen(req, timeout=20))


tok = post("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
           {"app_id": cred("App ID"), "app_secret": cred("App Secret")})["tenant_access_token"]

SHEETS = {"tM4eqI": "分流线路对应表", "35279c": "国内线路", "KostYN": "国际线路",
          "1gamsa": "图片线路", "uG2iV6": "图片渠道（不用看）"}

# PLACEHOLDER


def fetch(sid, rng="A1:AC300"):
    u = f"https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/{SS}/values/{sid}%21{rng}?valueRenderOption=ToString"
    d = get(u, tok)
    if d.get("code") != 0:
        raise SystemExit(f"fetch {sid} failed: {d.get('code')} {d.get('msg')}")
    rows = d["data"]["valueRange"]["values"] or []
    return [["" if c is None else str(c).strip() for c in r] for r in rows]


raw = {sid: fetch(sid) for sid in SHEETS}


def num(x):
    try:
        return round(float(x), 6)
    except Exception:
        return None


def ffill(rows, cols):
    last, out = {}, []
    for r in rows:
        r = list(r)
        for c in cols:
            v = r[c] if c < len(r) else ""
            if v:
                last[c] = v
            elif c in last:
                if c >= len(r):
                    r += [""] * (c - len(r) + 1)
                r[c] = last[c]
        out.append(r)
    return out


def cell(r, i):
    return r[i] if i < len(r) and r[i] != "" else None


line_mapping = []
for r in raw["tM4eqI"][1:]:
    if not any(r):
        continue
    line_mapping.append({
        "line": cell(r, 0), "site": cell(r, 1), "code": cell(r, 2),
        "provider": cell(r, 3), "category": cell(r, 4), "models": cell(r, 5),
        "discount": cell(r, 6), "schedulerStatus": cell(r, 7), "docNote": cell(r, 8),
    })


def parse_video(rows, usd=False):
    body = rows[1:]
    filled = ffill(body, [0, 1, 2])
    cost_col = 9
    costmap = {}
    for idx, r in enumerate(body, start=2):
        v = num(cell(r, cost_col))
        if v is not None:
            costmap[idx] = v
    parsed = []
    for k, r in enumerate(filled):
        orig = body[k]
        idx = k + 2
        if not (cell(orig, 3) or cell(orig, cost_col)):
            continue
        raw_cost = cell(r, cost_col)
        comp = num(raw_cost)
        formula = None
        if comp is None and raw_cost:
            m = re.match(r"[Jj](\d+)\s*\*\s*([\d.]+)", raw_cost.replace(" ", ""))
            if m:
                base = costmap.get(int(m.group(1)))
                if base is not None:
                    comp = round(base * float(m.group(2)), 6)
                    formula = raw_cost
        rec = {
            "row": idx, "channel": cell(r, 0), "model": cell(r, 1), "billing": cell(r, 2),
            "resolution": cell(r, 3), "aspectRatios": cell(r, 4),
            "virtualPortrait": cell(r, 5), "realPortrait": cell(r, 6),
            "universalRef": cell(r, 7), "firstLastFrame": cell(r, 8),
            "costPriceRaw": raw_cost, "costPriceComputed": comp, "costFormula": formula,
            "listPricePoints": num(cell(r, 10)) or cell(r, 10),
            "concurrency": cell(r, 11), "notes": cell(r, 12),
        }
        if usd:
            rec["rmbFormula"] = cell(r, 10)
            rec["listPricePoints"] = num(cell(r, 11)) or cell(r, 11)
            rec["concurrency"] = cell(r, 12)
            rec["notes"] = cell(r, 3)
        parsed.append(rec)
    return parsed


domestic = parse_video(raw["35279c"])
intl = parse_video(raw["KostYN"], usd=True)

image_lines = []
for r in ffill(raw["1gamsa"][1:], [0, 1, 2]):
    if not (cell(r, 3) or cell(r, 1)):
        continue
    image_lines.append({
        "channel": cell(r, 0), "model": cell(r, 1), "billing": cell(r, 2),
        "resolution": cell(r, 3), "aspectRatios": cell(r, 4),
        "costPriceRaw": cell(r, 5), "costPriceComputed": num(cell(r, 5)),
        "listPricePoints": num(cell(r, 6)) or cell(r, 6),
        "concurrency": cell(r, 7), "notes": cell(r, 8),
    })


def trim(rows):
    out = list(rows)
    while out and not any(c for c in out[-1]):
        out.pop()
    return out


raw_lean = {sid: trim(rows) for sid, rows in raw.items() if sid != "uG2iV6"}

cache = {
    "_meta": {
        "source": URL, "spreadsheetToken": SS, "title": "分流渠道表",
        "fetchedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "sheets": SHEETS,
        "authorityRule": "分流测试：成本价对比 + 可分流分辨率/能力，均以本表为准（用户指令 2026-09-24）。",
        "invariants": {
            "listPriceInvariant": "同(模型,分辨率)的刊例价(积分/秒,col K)不随分流渠道变化；分流只改平台成本(col J)，不改用户扣费。对应 pq_absetting.list_price_points 与 PointsService::calculatePoints。",
            "costFormula": "折扣渠道 cost = 火山官方价 × 折扣系数；表中以 J<行>*<系数> 表示，已解析入 costPriceComputed；国际线 col K = 成本USD × 7。",
            "eligibility": "某渠道对某(模型,分辨率)可分流，当且仅当本表存在对应行；能力门槛看 universalRef/firstLastFrame/realPortrait/aspectRatios 列。",
        },
    },
    "lineMapping": line_mapping,
    "domesticVideo": domestic,
    "internationalVideo": intl,
    "imageLines": image_lines,
    "rawSheets": raw_lean,
}

with open(OUT, "w", encoding="utf-8") as f:
    json.dump(cache, f, ensure_ascii=False, indent=2)

print(f"[refresh-feishu-pricing] wrote {OUT}")
print(f"  lineMapping={len(line_mapping)} domesticVideo={len(domestic)} "
      f"internationalVideo={len(intl)} imageLines={len(image_lines)}")
