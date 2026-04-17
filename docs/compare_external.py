"""
외부망 PC에서 실행: LS증권 API WebSocket 실시간 데이터 수신
compare_internal.py와 같은 시간에 실행하여 데이터 비교

사용법: python compare_external.py
출력: compare_external.log (30초간 수집)
의존성: pip install websockets
"""
import asyncio
import websockets
import json
import ssl
import time
import os
from datetime import datetime, timezone, timedelta
from urllib.request import Request, urlopen
from urllib.parse import urlencode

KST = timezone(timedelta(hours=9))
DURATION = 100  # 30초간 수집

APP_KEY = os.environ.get("LS_APP_KEY", "PSkI66GNNchK7vE2lteLggheyHcmazrd0K4L")
APP_SECRET = os.environ.get("LS_APP_SECRET", "xFOSXokQUq94PE5GHaVGVmCNv4TLUChX")

# 접속 URL: 반드시 /websocket (not /websocket/stock)
WS_URL = "wss://openapi.ls-sec.co.kr:9443/websocket"
REST_BASE = "https://openapi.ls-sec.co.kr:8080"

# WAF 통과용 필수 헤더
WS_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) LENS_Terminal/1.0",
    "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
}


def get_token() -> str:
    data = urlencode({
        "grant_type": "client_credentials",
        "appkey": APP_KEY,
        "appsecretkey": APP_SECRET,
        "scope": "oob",
    }).encode()
    req = Request(f"{REST_BASE}/oauth2/token", data=data, method="POST")
    with urlopen(req) as resp:
        return json.loads(resp.read())["access_token"]


async def main():
    log_lines = []
    start_dt = datetime.now(KST).strftime("%Y-%m-%d %H:%M:%S")
    log_lines.append(f"=== 외부망(LS API) WebSocket 데이터 수집 시작: {start_dt} ===")
    log_lines.append(f"수집 시간: {DURATION}초")
    log_lines.append("")

    token = get_token()
    log_lines.append(f"토큰 발급 완료: {token[:20]}...")
    log_lines.append("")

    ssl_ctx = ssl.create_default_context()
    trade_count = 0
    start = time.time()

    async with websockets.connect(
        WS_URL, additional_headers=WS_HEADERS, ssl=ssl_ctx, open_timeout=15
    ) as ws:
        log_lines.append("WebSocket 연결 성공")

        # 구독 요청 헬퍼
        async def subscribe(tr_cd: str, tr_key: str):
            sub = {
                "header": {"token": token, "tr_type": "3"},
                "body": {"tr_cd": tr_cd, "tr_key": tr_key},
            }
            await ws.send(json.dumps(sub))
            log_lines.append(f"구독: {tr_cd} {tr_key}")

        # 비교 대상 종목 구독
        # await subscribe("S3_", "005930")   # 삼성전자 현물 체결
        # await subscribe("S3_", "069500")   # KODEX 200 ETF 체결
        await subscribe("JC0", "KA1165000")  # 삼성전자 선물 체결 (주식선물 TR)
        log_lines.append("")

        while time.time() - start < DURATION:
            try:
                msg = await asyncio.wait_for(ws.recv(), timeout=5)
                now = datetime.now(KST).strftime("%H:%M:%S.%f")

                if isinstance(msg, bytes):
                    log_lines.append(f"[bytes] {now} | len={len(msg)}: {msg[:200]}")
                    trade_count += 1
                    continue

                data = json.loads(msg)
                header = data.get("header", {})
                body = data.get("body")
                tr_cd = header.get("tr_cd", "?")
                tr_key = header.get("tr_key", "")

                # 구독 응답 (body=null)
                if body is None:
                    rsp_msg = header.get("rsp_msg", "")
                    log_lines.append(f"[응답 ] {now} | {tr_cd} {tr_key} → {rsp_msg}")
                    continue

                trade_count += 1

                if tr_cd == "S3_":
                    # 주식/ETF 체결
                    price = body.get("price", "?")
                    cvolume = body.get("cvolume", "?")
                    volume = body.get("volume", "?")
                    offerho = body.get("offerho", "?")
                    bidho = body.get("bidho", "?")
                    cgubun = body.get("cgubun", "?")
                    high = body.get("high", "?")
                    low = body.get("low", "?")
                    log_lines.append(
                        f"[Trade] {now} | {tr_key:>10} | "
                        f"가격={price:>10} | 체결량={cvolume:>6} | "
                        f"매수1={bidho:>10} 매도1={offerho:>10} | "
                        f"{'매수' if cgubun == '+' else '매도':>4} | "
                        f"고={high} 저={low} 누적={volume}"
                    )

                elif tr_cd == "JC0":
                    # 주식선물 체결
                    price = body.get("price", "?")
                    cvolume = body.get("cvolume", "?")
                    volume = body.get("volume", "?")
                    offerho = body.get("offerho", body.get("offerho1", "?"))
                    bidho = body.get("bidho", body.get("bidho1", "?"))
                    log_lines.append(
                        f"[Futr ] {now} | {tr_key:>10} | "
                        f"가격={price:>10} | 체결량={cvolume:>6} | "
                        f"매수1={bidho:>10} 매도1={offerho:>10} | 누적={volume}"
                    )

                else:
                    # 기타 TR
                    log_lines.append(
                        f"[{tr_cd:>5}] {now} | {tr_key:>10} | {json.dumps(body, ensure_ascii=False)[:200]}"
                    )

            except asyncio.TimeoutError:
                continue

    log_lines.append("")
    log_lines.append(f"=== 수집 완료: {datetime.now(KST).strftime('%Y-%m-%d %H:%M:%S')} ===")
    log_lines.append(f"수신 건수: {trade_count}")

    with open("compare_external.log", "w", encoding="utf-8") as f:
        f.write("\n".join(log_lines))

    print(f"저장 완료: compare_external.log ({len(log_lines)}줄)")
    print(f"수신: {trade_count}건")


if __name__ == "__main__":
    asyncio.run(main())
