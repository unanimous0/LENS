#!/usr/bin/env python3
"""t8407 (API용 주식멀티현재가조회) 스펙 계단식 검증.

목적:
  - 한 호출에 몇 종목까지(nrec) 넣을 수 있는지 → ETF 초기 fetch / B 파이프라인 폴링 설계
  - 응답 종목 수가 요청과 일치하는지 (일부 누락 패턴)
  - 호출 소요 시간 (30~60초 폴링 가능성 산정)

키: 키B(LS_APP_KEY_B) 사용 — realtime이 쓰는 키A를 안 건드려 WS 유지.
    (주말엔 Finance_Data 배치 없어 키B idle. 평일 야간엔 키B 충돌하니 실행 금지.)

원칙 (feedback_external_blame_bias): "API 제한" 가설 최후. 실패 시 요청 포맷부터 의심.
"""
import json, time
from urllib.request import Request, urlopen
from urllib.parse import urlencode
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
env = {}
for line in (REPO / ".env").read_text().splitlines():
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        env[k] = v
KEY = env.get("LS_APP_KEY_B", "")
SECRET = env.get("LS_APP_SECRET_B", "")
assert KEY and SECRET, ".env의 LS_APP_KEY_B/SECRET_B 필요"


def get_token():
    req = Request(
        "https://openapi.ls-sec.co.kr:8080/oauth2/token",
        data=urlencode({"grant_type": "client_credentials", "appkey": KEY,
                        "appsecretkey": SECRET, "scope": "oob"}).encode(),
        headers={"Content-Type": "application/x-www-form-urlencoded"})
    return json.loads(urlopen(req, timeout=10).read())["access_token"]


def t8407(token, codes):
    """codes: 6자리 주식코드 리스트. shcode는 구분자 없이 연접 (ls_api_full 예시 기준)."""
    shcode = "".join(codes)
    body = json.dumps({"t8407InBlock": {"nrec": len(codes), "shcode": shcode}}).encode()
    req = Request(
        "https://openapi.ls-sec.co.kr:8080/stock/market-data",
        data=body,
        headers={"Content-Type": "application/json; charset=utf-8",
                 "authorization": f"Bearer {token}", "tr_cd": "t8407", "tr_cont": "N"})
    try:
        t0 = time.time()
        rb = urlopen(req, timeout=20).read()
        el = round((time.time() - t0) * 1000)
        d = json.loads(rb)
        out = d.get("t8407OutBlock1", [])
        sample = out[0].get("price") if out else None
        return {"ok": True, "ms": el, "rsp": d.get("rsp_cd"),
                "msg": d.get("rsp_msg", "")[:40], "n_resp": len(out), "first_price": sample}
    except Exception as e:
        return {"ok": False, "err": str(e)[:120]}


def main():
    fm = json.load(open(REPO / "data" / "futures_master.json"))["items"]
    codes = [x["base_code"] for x in fm]  # 273 주식코드
    print(f"테스트 종목 풀: {len(codes)}개 (주식선물 base_code)")
    token = get_token()
    print("토큰 발급 OK (키B)\n")
    print(f"{'nrec':>5} | {'응답':>5} | {'ms':>6} | rsp | first_price | msg")
    print("-" * 70)
    for n in [1, 3, 10, 30, 50, 70, 100, 150, 200, 273]:
        if n > len(codes):
            break
        r = t8407(token, codes[:n])
        if r["ok"]:
            print(f"{n:>5} | {r['n_resp']:>5} | {r['ms']:>6} | {r['rsp']} | "
                  f"{str(r['first_price']):>11} | {r['msg']}")
        else:
            print(f"{n:>5} | ERROR: {r['err']}")
        time.sleep(0.3)


if __name__ == "__main__":
    main()
