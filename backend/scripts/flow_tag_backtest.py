"""수급 태그 후보 백테스트 — "검증 없이 라벨 붙이지 말라"(부검 원칙) 실행 도구.

목적: 랭킹 정렬축(외인 20D 매집)과 패턴 태그 후보들이 *실제로* 미래 수익률을
예측하는지 look-ahead 없이 측정한다. 통과한 태그만 flow_metrics에 실을 근거.

방법 (look-ahead 차단):
  - 신호는 D일 장 마감까지 데이터로만 계산 (trailing window).
  - 진입가 = D+1 *시가*(adj_open). 청산가 = (D+1+h) 시가. → fwd_h = 청산/진입 - 1.
  - 초과수익 = 그날 유니버스 평균 대비 (시장 베타 제거).
  - Rank IC: 날짜별 횡단면 스피어만(신호 vs fwd), 날짜 평균 + t값.
  - 태그: 날짜별 (태그군 평균 - 유니버스 평균) 스프레드 → 날짜를 관측단위로 t검정
    (횡단면 상관 부풀림 방지). 주간(5거래일) 리밸런스로 중첩 완화.

정규화 주: 프로덕션 지표는 유통시총(유통비율×시총) 분모지만, 백테스트는
floating_shares as-of 조인(2026-05-21~ NULL 이슈)을 피해 **market_cap**을 분모
프록시로 쓴다. Rank IC 결론은 이 단조 변환에 견고.

실행: cd backend && python3 scripts/flow_tag_backtest.py
Finance_Data는 read-only(SELECT만).
"""
from __future__ import annotations

import asyncio
from datetime import date, timedelta

import numpy as np
import pandas as pd
from sqlalchemy import text

from core.database import korea_async_session

YEARS = 3.2
ADV_MIN = 1_000_000_000      # 일평균 거래대금 10억 이상 (거래 가능 유니버스)
MCAP_MIN = 50_000_000_000    # 시총 500억 이상
REBAL_EVERY = 5              # 리밸런스 간격 (거래일) — 주간
HORIZONS = [5, 20, 60]       # 보유일수


async def _fetch() -> tuple[pd.DataFrame, ...]:
    end = date.today()
    start = end - timedelta(days=int(YEARS * 365))
    async with korea_async_session() as session:
        # 1) 유동성 유니버스 (활성 KOSPI/KOSDAQ + 평균 거래대금 하한)
        uni = (await session.execute(text(
            """
            SELECT o.stock_code
            FROM ohlcv_daily o
            JOIN stocks s ON s.stock_code = o.stock_code AND s.is_active
                         AND s.market IN ('KOSPI','KOSDAQ')
            WHERE o.time BETWEEN :start AND :end
            GROUP BY o.stock_code
            HAVING AVG(o.trading_value) >= :adv
            """
        ), {"start": start, "end": end, "adv": ADV_MIN})).fetchall()
        codes = [r[0] for r in uni]
        print(f"유니버스: {len(codes)}종목  기간 {start}~{end}")

        # 2) 패널 데이터 (유니버스 한정)
        it = (await session.execute(text(
            """
            SELECT time, stock_code, investor_type, net_buy_value
            FROM investor_trading
            WHERE time BETWEEN :start AND :end
              AND investor_type IN ('FOREIGN','INSTITUTION','RETAIL')
              AND stock_code = ANY(:codes)
            """
        ), {"start": start, "end": end, "codes": codes})).fetchall()
        ohlcv = (await session.execute(text(
            """
            SELECT time, stock_code, adj_open, adj_close, trading_value
            FROM ohlcv_daily
            WHERE time BETWEEN :start AND :end AND stock_code = ANY(:codes)
            """
        ), {"start": start, "end": end, "codes": codes})).fetchall()
        mc = (await session.execute(text(
            """
            SELECT time, stock_code, market_cap
            FROM market_cap_daily
            WHERE time BETWEEN :start AND :end AND stock_code = ANY(:codes)
            """
        ), {"start": start, "end": end, "codes": codes})).fetchall()

    it_df = pd.DataFrame(it, columns=["time", "stock", "type", "net"])
    ohlcv_df = pd.DataFrame(ohlcv, columns=["time", "stock", "adj_open", "adj_close", "tv"])
    mc_df = pd.DataFrame(mc, columns=["time", "stock", "mcap"])
    return it_df, ohlcv_df, mc_df


def _build_panel(it_df, ohlcv_df, mc_df) -> pd.DataFrame:
    for d in (it_df, ohlcv_df, mc_df):
        d["time"] = pd.to_datetime(d["time"])
    piv = it_df.pivot_table(index=["time", "stock"], columns="type", values="net", aggfunc="sum")
    piv = piv.rename(columns={"FOREIGN": "f", "INSTITUTION": "i", "RETAIL": "r"}).reset_index()
    for c in ("f", "i", "r"):
        if c not in piv:
            piv[c] = 0.0
    df = ohlcv_df.merge(piv, on=["time", "stock"], how="left").merge(mc_df, on=["time", "stock"], how="left")
    for c in ("f", "i", "r"):
        df[c] = df[c].fillna(0.0)
    df = df.astype({c: "float64" for c in ("adj_open", "adj_close", "tv", "f", "i", "r", "mcap")})
    df = df.sort_values(["stock", "time"]).reset_index(drop=True)
    g = df.groupby("stock", sort=False)

    def rsum(col, n):
        return g[col].transform(lambda s: s.rolling(n, min_periods=n).sum())

    df["f5"] = rsum("f", 5); df["f20"] = rsum("f", 20); df["f60"] = rsum("f", 60); df["f120"] = rsum("f", 120)
    df["i5"] = rsum("i", 5); df["i20"] = rsum("i", 20)
    df["r5"] = rsum("r", 5)
    df["tv5"] = rsum("tv", 5)
    df["adv20"] = g["tv"].transform(lambda s: s.rolling(20, min_periods=20).mean())
    df["ma200"] = g["adj_close"].transform(lambda s: s.rolling(200, min_periods=120).mean())
    df["ret20"] = g["adj_close"].transform(lambda s: s / s.shift(20) - 1)
    df["ret5"] = g["adj_close"].transform(lambda s: s / s.shift(5) - 1)

    # 진입 = D+1 시가, 청산 = (D+1+h) 시가 (look-ahead 차단)
    df["entry"] = g["adj_open"].shift(-1)
    for h in HORIZONS:
        df[f"fwd{h}"] = g["adj_open"].shift(-(1 + h)) / df["entry"] - 1
    return df


def _signals_tags(df: pd.DataFrame) -> pd.DataFrame:
    mc = df["mcap"].replace(0, np.nan)
    df["sig"] = df["f20"] / mc                       # 정렬축 프록시: 외인 20D / 시총
    f20mc = df["f20"] / mc; f5mc = df["f5"] / mc
    absorb = (df["f5"] + df["i5"]) / df["tv5"].replace(0, np.nan)
    entry_ok = (f20mc >= 0.0015) & (df["f5"] >= 0.3 * df["adv20"])   # 진입권 근사(연속 대신 5D/ADV)
    both = (df["f20"] > 0) & (df["i20"] > 0)
    df["T_동시"] = both
    df["T_진입권"] = entry_ok & (df["f20"] > 0)
    df["T_정석(동시+진입권)"] = both & entry_ok
    df["T_단기반등"] = (df["f20"] > 0) & (df["f120"] < 0)
    df["T_분배"] = (f5mc <= -0.001) & (df["ret5"] >= -0.02) & (df["r5"] > 0)
    df["T_저점재매집"] = (df["f20"] > 0) & (df["f120"] > 0) & (df["adj_close"] < df["ma200"]) & (absorb >= 0.10)
    df["T_추세순항"] = both & (df["ret20"] > 0)
    df["T_동시함정"] = both & (df["i5"] < 0)
    # 매도·이탈 후보
    df["T_매집후이탈"] = (df["f120"] > 0) & (df["f20"] < 0)                  # 장기매집+ 최근 외인 이탈 → 검증상 강세(눌림)
    df["T_동반순매도"] = (df["f20"] < 0) & (df["i20"] < 0) & (df["f120"] <= 0)  # 장기매집 없는 순수 동반 이탈 → 약세
    return df


def _evaluate(df: pd.DataFrame) -> None:
    tag_cols = [c for c in df.columns if c.startswith("T_")]
    df["uni"] = (df["adv20"] >= ADV_MIN) & (df["mcap"] >= MCAP_MIN) & df["entry"].notna() & df["sig"].notna()

    times = np.sort(df["time"].unique())
    rebal = set(times[::REBAL_EVERY])
    d = df[df["uni"] & df["time"].isin(rebal)].copy()

    print("\n" + "=" * 78)
    print("① 정렬축 Rank IC  (외인 20D/시총 vs 미래수익)  — 양(+)·유의(|t|>2)면 정렬이 유효")
    print("-" * 78)
    print(f"{'h(보유일)':>9} {'RankIC':>9} {'t값':>7} {'날짜수':>7}")
    for h in HORIZONS:
        ics = []
        for _, grp in d.groupby("time"):
            sub = grp[["sig", f"fwd{h}"]].dropna()
            if len(sub) >= 20:
                ics.append(sub["sig"].rank().corr(sub[f"fwd{h}"].rank()))
        ics = np.array(ics, dtype=float)
        t = ics.mean() / (ics.std(ddof=1) / np.sqrt(len(ics))) if len(ics) > 1 else np.nan
        print(f"{h:>9} {ics.mean():>9.4f} {t:>7.2f} {len(ics):>7}")

    for h in HORIZONS:
        print("\n" + "=" * 78)
        print(f"② 태그 초과수익  (보유 {h}일, T+1 시가 진입, 유니버스 평균 대비)")
        print("-" * 78)
        print(f"{'태그':<18} {'초과수익%':>9} {'t값':>7} {'적중%':>7} {'평균종목/일':>11} {'날짜수':>7}")
        rows = []
        for tag in tag_cols:
            spreads, hits, counts = [], [], []
            for _, grp in d.groupby("time"):
                u = grp[grp[f"fwd{h}"].notna()]
                if len(u) < 20:
                    continue
                tg = u[u[tag] == True]  # noqa: E712
                if len(tg) == 0:
                    continue
                spreads.append(tg[f"fwd{h}"].mean() - u[f"fwd{h}"].mean())
                hits.append((tg[f"fwd{h}"] > u[f"fwd{h}"].mean()).mean())
                counts.append(len(tg))
            if len(spreads) < 5:
                print(f"{tag:<18} {'(관측부족)':>9}")
                continue
            sp = np.array(spreads)
            t = sp.mean() / (sp.std(ddof=1) / np.sqrt(len(sp)))
            rows.append((tag, sp.mean() * 100, t, np.mean(hits) * 100, np.mean(counts), len(sp)))
        for tag, ex, t, hit, cnt, nd in sorted(rows, key=lambda x: -x[2]):
            flag = "  ✅" if t > 2 else ("  ~" if t > 1 else "")
            print(f"{tag:<18} {ex:>9.2f} {t:>7.2f} {hit:>7.1f} {cnt:>11.1f} {nd:>7}{flag}")


async def main() -> None:
    it_df, ohlcv_df, mc_df = await _fetch()
    print(f"패널 rows — 수급 {len(it_df):,} / 시세 {len(ohlcv_df):,} / 시총 {len(mc_df):,}")
    df = _build_panel(it_df, ohlcv_df, mc_df)
    df = _signals_tags(df)
    _evaluate(df)
    print("\n주: 초과수익 = 그날 유니버스 평균 대비. t>2 = 통계적으로 유의(✅). "
          "중첩·다중검정 감안해 t>2도 보수적으로 해석. 진입권은 연속일 대신 5D/ADV 근사.")


if __name__ == "__main__":
    asyncio.run(main())
