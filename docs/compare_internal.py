"""
내부망 PC에서 실행: 사내 서버 실시간 데이터 수신
compare_external.py와 같은 시간에 실행하여 데이터 비교

사용법: python compare_internal.py
출력: compare_internal.log (30초간 수집)
"""
import asyncio
import websockets
import orjson
import time
from datetime import datetime, timezone, timedelta

KST = timezone(timedelta(hours=9))
HOST = "10.21.1.208"
PORT = 41001
URI = f"ws://{HOST}:{PORT}"
DURATION = 30  # 30초간 수집

# 비교 대상 종목
SYMBOLS = [
    "A005930",    # 삼성전자 현물
    "A069500",    # KODEX 200 ETF
    "KA1165000",  # 삼성전자 선물
]

REQUEST = {
    "symbols": SYMBOLS,
    "real_nav": True,
}


def format_time(epoch_us: int) -> str:
    """epoch 마이크로초 → KST 시각 문자열"""
    dt = datetime.fromtimestamp(epoch_us / 1_000_000, tz=KST)
    return dt.strftime("%H:%M:%S.%f")


def isin_to_short(isin: str) -> str:
    """ISIN → 단축코드 (비교용)"""
    if isin.startswith("KR7"):
        return isin[3:9]  # KR7005930003 → 005930
    elif isin.startswith("KR4A"):
        return "F:" + isin[4:11]  # KR4A11650004 → F:1165000
    return isin


async def main():
    log_lines = []
    start = time.time()

    log_lines.append(f"=== 내부망 데이터 수집 시작: {datetime.now(KST).strftime('%Y-%m-%d %H:%M:%S')} ===")
    log_lines.append(f"종목: {SYMBOLS}")
    log_lines.append(f"수집 시간: {DURATION}초")
    log_lines.append("")

    trade_count = 0
    book_count = 0
    index_count = 0

    async with websockets.connect(URI) as ws:
        await ws.send(orjson.dumps(REQUEST))
        resp = await ws.recv()
        log_lines.append(f"구독 응답: {resp}")
        log_lines.append("")

        while time.time() - start < DURATION:
            try:
                msg = await asyncio.wait_for(ws.recv(), timeout=5)
                ticks = orjson.loads(msg)

                for tick in ticks:
                    ty = tick.get("ty")
                    s = tick.get("s", "")
                    short = isin_to_short(s)
                    et = tick.get("et", 0)
                    time_str = format_time(et) if et else "?"

                    if ty == "Trade":
                        trade_count += 1
                        tp = tick.get("tp", "")
                        ts = tick.get("ts", "")
                        cs = tick.get("cs", "")
                        fl = tick.get("fl", 0)
                        side = "BUY" if fl & 1 else "SELL" if fl & 2 else f"fl={fl}"
                        log_lines.append(
                            f"[Trade] {time_str} | {short:>10} | "
                            f"가격={tp:>10} | 수량={ts:>6} | 누적={cs:>10} | {side}"
                        )

                    elif ty == "LpBookSnapshot":
                        book_count += 1
                        a = tick.get("a", [])
                        b = tick.get("b", [])
                        best_ask = a[0] if a else ["?", "?", "?"]
                        best_bid = b[0] if b else ["?", "?", "?"]
                        log_lines.append(
                            f"[Book ] {time_str} | {short:>10} | "
                            f"매수1={best_bid[0]:>10}({best_bid[1]:>6}) | "
                            f"매도1={best_ask[0]:>10}({best_ask[1]:>6}) | "
                            f"LP매수={best_bid[2]} LP매도={best_ask[2]}"
                        )

                    elif ty == "Index":
                        index_count += 1
                        fl = tick.get("fl", 0)
                        i1 = tick.get("i1", "")
                        i2 = tick.get("i2", "")

                        # fl 해석
                        parts = []
                        if fl & 1:
                            parts.append("iNAV")
                        if fl & 2:
                            parts.append("rNAV")
                        if fl & 4:
                            parts.append("FutIdeal")
                        if fl & 8:
                            parts.append("Trade")
                        if fl & 16:
                            parts.append("Quote")
                        flag_str = "+".join(parts) if parts else f"fl={fl}"

                        log_lines.append(
                            f"[Index] {time_str} | {short:>10} | "
                            f"fl={fl:>3} ({flag_str:>20}) | i1={i1:>15} | i2={i2:>15}"
                        )

                    elif ty == "Auction":
                        ip = tick.get("ip", "")
                        is_ = tick.get("is", "")
                        log_lines.append(
                            f"[Auct ] {time_str} | {short:>10} | 예상가={ip} 예상량={is_}"
                        )

                    elif ty == "Status":
                        fl = tick.get("fl", 0)
                        log_lines.append(
                            f"[Stat ] {time_str} | {short:>10} | fl={fl}"
                        )

            except asyncio.TimeoutError:
                continue

    log_lines.append("")
    log_lines.append(f"=== 수집 완료: {datetime.now(KST).strftime('%Y-%m-%d %H:%M:%S')} ===")
    log_lines.append(f"Trade: {trade_count}건 | Book: {book_count}건 | Index: {index_count}건")

    # 파일 저장
    with open("compare_internal.log", "w", encoding="utf-8") as f:
        f.write("\n".join(log_lines))

    print(f"저장 완료: compare_internal.log ({len(log_lines)}줄)")
    print(f"Trade: {trade_count} | Book: {book_count} | Index: {index_count}")


if __name__ == "__main__":
    asyncio.run(main())
