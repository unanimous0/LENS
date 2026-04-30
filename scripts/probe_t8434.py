#!/usr/bin/env python3
"""t8434 (멀티 현재가) 스펙 계단식 검증.

목적:
  - 한 호출에 몇 종목까지 넣을 수 있는지
  - 응답 JSON 구조 (t8402와 필드 차이)
  - 일부 종목만 빠지는 패턴이 있는지
  - 동일 요청 재시도 시 동작 차이

원칙 (feedback_external_blame_bias 참조):
  - "API 제한" 가설 최후. 실패 시 내 요청 포맷부터 의심.
  - 단순 1종목 → 5 → 20 → 50 → 100 계단식.
  - 같은 요청을 3회 반복해 영구 실패/일시 실패 구분.
  - 첫 몇 건은 응답 본문 통째로 저장(파일)해서 스펙 확인.
"""
import json, time, os, sys
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from urllib.parse import urlencode
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
ENV_FILE = REPO / ".env"
MASTER = REPO / "data" / "futures_master.json"
DUMP_DIR = Path("/tmp/t8434_probe")
DUMP_DIR.mkdir(exist_ok=True)

# .env 로드
env = {}
for line in ENV_FILE.read_text().splitlines():
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        env[k] = v
APP_KEY = env.get("LS_APP_KEY", "")
APP_SECRET = env.get("LS_APP_SECRET", "")
assert APP_KEY and APP_SECRET, ".env의 LS_APP_KEY/SECRET 필요"

def get_token():
    req = Request("https://openapi.ls-sec.co.kr:8080/oauth2/token",
        data=urlencode({"grant_type":"client_credentials",
                        "appkey":APP_KEY, "appsecretkey":APP_SECRET,
                        "scope":"oob"}).encode(),
        headers={"Content-Type":"application/x-www-form-urlencoded"})
    return json.loads(urlopen(req, timeout=10).read())["access_token"]

def call_t8434(token, codes):
    """t8434 한 번 호출. codes는 리스트. 구분자는 ls-api.md 스펙대로 조정 필요.
    현재 추측: 쉼표 구분 문자열. 실측하면서 확인."""
    focode = ",".join(codes)
    body = json.dumps({"t8434InBlock": {
        "gubun1": "F",   # 추측: F=선물, O=옵션
        "gubun2": "2",   # 추측: 2=현재가?
        "focode": focode,
    }}).encode()
    req = Request("https://openapi.ls-sec.co.kr:8080/futureoption/market-data",
        data=body,
        headers={"Content-Type":"application/json; charset=utf-8",
                 "authorization": f"Bearer {token}",
                 "tr_cd":"t8434", "tr_cont":"N"})
    try:
        t0 = time.time()
        resp_bytes = urlopen(req, timeout=15).read()
        elapsed = time.time() - t0
        return {
            "ok": True,
            "status": 200,
            "elapsed_ms": round(elapsed * 1000),
            "body": json.loads(resp_bytes),
        }
    except HTTPError as e:
        return {"ok": False, "status": e.code, "body": e.read().decode("utf-8", "replace")}
    except Exception as e:
        return {"ok": False, "status": -1, "body": str(e)}

def analyze(resp, requested_codes):
    """응답 분석: rsp_cd, outblock 키, 각 종목 매칭."""
    body = resp.get("body")
    if not resp.get("ok"):
        return {"rsp_cd": "-", "rsp_msg": "-", "got_codes": [], "keys": []}
    rsp_cd = body.get("rsp_cd", "-")
    rsp_msg = body.get("rsp_msg", "-")
    # 가능한 outblock 키 이름: t8434OutBlock1, Block2 등
    outblocks = [k for k in body.keys() if "OutBlock" in k]
    got_codes = []
    sample_fields = {}
    for k in outblocks:
        v = body[k]
        if isinstance(v, list):
            for row in v:
                code = row.get("focode") or row.get("shcode") or row.get("tr_key") or "?"
                got_codes.append(code)
                if not sample_fields:
                    sample_fields = {fk: fv for fk, fv in list(row.items())[:15]}
    return {
        "rsp_cd": rsp_cd,
        "rsp_msg": rsp_msg,
        "keys": outblocks,
        "got_codes": got_codes,
        "missing": [c for c in requested_codes if c not in got_codes],
        "sample_fields": sample_fields,
    }

def main():
    master = json.load(open(MASTER))
    # 활발한 종목 우선 (대형주 7개 + 나머지 순차)
    ACTIVE = ["A1165000","A5065000","A5665000","A1965000","ABN65000","A1665000","ACP65000"]
    # 활발 7 + 마스터 나머지 = 총 250
    all_futures = []
    seen = set(ACTIVE)
    all_futures.extend(ACTIVE)
    for i in master["items"]:
        fc = i.get("front", {}).get("code", "")
        if fc and fc not in seen:
            all_futures.append(fc)
            seen.add(fc)

    token = get_token()
    print(f"토큰 ok. 종목 준비: {len(all_futures)}개\n")

    LEVELS = [1, 5, 20, 50, 100, 200, 250]
    for n in LEVELS:
        codes = all_futures[:n]
        print(f"━━━ N={n:3d} 종목 ━━━")
        # 동일 요청 3회 (영구/일시 실패 구분)
        for attempt in range(1, 4):
            resp = call_t8434(token, codes)
            ana = analyze(resp, codes)
            status = "OK" if resp.get("ok") else f"ERR {resp.get('status')}"
            got = len(ana["got_codes"])
            miss = len(ana.get("missing", []))
            elapsed = resp.get("elapsed_ms", "?")
            print(f"  시도{attempt}: {status}  요청={n} 수신={got} 누락={miss}  "
                  f"rsp_cd={ana['rsp_cd']}  {elapsed}ms  keys={ana['keys']}")
            # 최초 시도만 응답 본문 저장
            if attempt == 1:
                dump_path = DUMP_DIR / f"n{n:03d}.json"
                dump_path.write_text(json.dumps(resp.get("body"), ensure_ascii=False, indent=2))
            # rsp_msg/sample_fields 한 번만 출력
            if attempt == 1 and ana["rsp_msg"] not in ("-", "정상처리되었습니다"):
                print(f"         rsp_msg={ana['rsp_msg']}")
            if attempt == 1 and ana["sample_fields"]:
                print(f"         fields={list(ana['sample_fields'].keys())[:10]}")
            if attempt == 1 and miss > 0 and miss <= 5:
                print(f"         missing={ana['missing']}")
            time.sleep(0.4)  # TPS 3 안전 (호출당 350ms+)
        print()

    print(f"\n응답 본문 덤프: {DUMP_DIR}/n*.json")

if __name__ == "__main__":
    main()
