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
  - ③ 조건부 Rank IC: 정렬축(sig) IC를 전체 / f120>0(장기정합 게이트 ON) /
    f120<=0 서브셋에서 각각 측정 → 장기 지속성 축이 정렬 품질을 실제로 개선하는지.
  - ④ 일관성(순매수일 비율) 후보: cons120 단독 Rank IC + (f120>0 & cons120>=0.5)
    이중 게이트 IC로 일관성 게이트가 합계 게이트에 추가 가치를 주는지 측정.

정규화 주: 프로덕션 지표는 유통시총(유통비율×시총) 분모지만, 백테스트는
floating_shares as-of 조인(2026-05-21~ NULL 이슈)을 피해 **market_cap**을 분모
프록시로 쓴다. Rank IC 결론은 이 단조 변환에 견고.

실행: cd backend && python3 scripts/flow_tag_backtest.py
Finance_Data는 read-only(SELECT만).
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from datetime import date, timedelta

import numpy as np
import pandas as pd
from sqlalchemy import text

from core.database import korea_async_session

YEARS = 2.0  # 룩백 기간. 0.5~3년 비교 결과 2년이 Rank IC 최강(t7.15)+패턴 edge 최선(스위트스팟).
ADV_MIN = 1_000_000_000      # 일평균 거래대금 10억 이상 (거래 가능 유니버스)
MCAP_MIN = 50_000_000_000    # 시총 500억 이상
REBAL_EVERY = 5              # 리밸런스 간격 (거래일) — 주간
HORIZONS = [5, 20, 60, 120]  # 보유일수 (120=중장기 지속성 축 측정용, 2년 룩백에선 마지막 ~6개월 fwd가 NaN → 날짜수 감소는 정상)
# 보유기간 곡선용 지평 (검증 근거 화면 곡선 차트). stdout 리포트 ①~④는 HORIZONS만 쓰며 불변.
CURVE_H = [5, 10, 20, 40, 60, 90, 120, 180]


async def _fetch(years: float = YEARS) -> tuple[pd.DataFrame, ...]:
    end = date.today()
    start = end - timedelta(days=int(years * 365))
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
    # 순매수일 비율(일관성): rolling 120일 중 외인 순매수일(f>0) 비율
    df["cons120"] = g["f"].transform(lambda s: (s > 0).rolling(120, min_periods=120).mean())
    df["i5"] = rsum("i", 5); df["i20"] = rsum("i", 20); df["i120"] = rsum("i", 120)
    df["r5"] = rsum("r", 5)
    df["tv5"] = rsum("tv", 5)
    df["adv20"] = g["tv"].transform(lambda s: s.rolling(20, min_periods=20).mean())
    df["ma200"] = g["adj_close"].transform(lambda s: s.rolling(200, min_periods=120).mean())
    df["ret20"] = g["adj_close"].transform(lambda s: s / s.shift(20) - 1)
    df["ret5"] = g["adj_close"].transform(lambda s: s / s.shift(5) - 1)

    # 진입 = D+1 시가, 청산 = (D+1+h) 시가 (look-ahead 차단)
    df["entry"] = g["adj_open"].shift(-1)
    for h in sorted(set(HORIZONS) | set(CURVE_H)):
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
    df["T_지속매집"] = (df["f120"] > 0) & (df["cons120"] >= 0.5) & (df["f20"] > 0)  # 장기 순매수 + 과반수 매수일 + 최근도 매집 (지속성 후보)
    df["T_동반순매도"] = (df["f20"] < 0) & (df["i20"] < 0) & (df["f120"] <= 0)  # 장기매집 없는 순수 동반 이탈 → 약세
    # PR-4a 측정 후보 (사전 등록, 스윕 금지)
    df["T_장기동시"] = (df["f20"] > 0) & (df["i20"] > 0) & (df["f120"] > 0) & (df["i120"] > 0)      # 외+기 20D·120D 4중 동반 매집 (사용자 가설)
    df["T_동반순매도_장기"] = (df["f20"] < 0) & (df["i20"] < 0) & (df["f120"] <= 0) & (df["i120"] <= 0)  # 매도측 강화 (기관 장기까지 이탈)
    # 좁히기 게이트 후보 (사전 등록 3개, 스윕/튜닝 금지) — 강세후보 풀(256종목) 축소용
    long_both = (df["f20"] > 0) & (df["i20"] > 0) & (df["f120"] > 0) & (df["i120"] > 0)
    df["T_핵심A"] = long_both & entry_ok                                    # 4중 겹침 + 규모·지속성 임계(진입권 근사)
    df["T_핵심B"] = long_both & (df["ret20"] > 0)                           # 4중 겹침 + 상승추세 동반
    df["T_강세흡수"] = (long_both | (both & entry_ok)) & (absorb >= 0.10)   # (장기동시 or 정석근사) + 흡수율 게이트
    return df


def _rank_ic(d: pd.DataFrame, sig_col: str, h: int, mask: pd.Series | None = None) -> tuple[float, float, int, float]:
    """날짜별 횡단면 Rank IC(sig_col vs fwd{h})의 (평균, t값, 날짜수, 평균종목수/일).

    mask가 주어지면 해당 서브셋에 한정해 계산. 날짜별 최소 종목수 20 미달 날짜는 skip
    (서브셋이라 미달 날짜가 늘 수 있으며 그대로 제외).
    """
    src = d if mask is None else d[mask]
    ics, counts = [], []
    for _, grp in src.groupby("time"):
        sub = grp[[sig_col, f"fwd{h}"]].dropna()
        if len(sub) >= 20:
            ics.append(sub[sig_col].rank().corr(sub[f"fwd{h}"].rank()))
            counts.append(len(sub))
    ics = np.array(ics, dtype=float)
    mean = float(ics.mean()) if len(ics) else np.nan
    t = ics.mean() / (ics.std(ddof=1) / np.sqrt(len(ics))) if len(ics) > 1 else np.nan
    avg_n = float(np.mean(counts)) if counts else 0.0
    return mean, float(t), len(ics), avg_n


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
        ic, t, nd, _ = _rank_ic(d, "sig", h)
        print(f"{h:>9} {ic:>9.4f} {t:>7.2f} {nd:>7}")

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

    # ③ 조건부 Rank IC — 장기 정합(f120) 게이트가 정렬축(sig) 품질을 개선하는가
    m_on = d["f120"] > 0            # 장기 정합 게이트 ON (화면 "장기 정합만" 필터)
    m_off = d["f120"] <= 0         # 장기 비정합
    print("\n" + "=" * 78)
    print("③ 조건부 Rank IC  (정렬축 sig 를 f120 서브셋별로)  — (b)>(a)·유의면 장기게이트가 정렬 품질 개선")
    print("-" * 78)
    print(f"{'h':>4} │ {'(a)전체':>8} {'t':>6} {'날짜':>5} {'종목/일':>7} │ "
          f"{'(b)f120>0':>9} {'t':>6} {'날짜':>5} {'종목/일':>7} │ "
          f"{'(c)f120<=0':>10} {'t':>6} {'날짜':>5} {'종목/일':>7}")
    for h in HORIZONS:
        a = _rank_ic(d, "sig", h)
        b = _rank_ic(d, "sig", h, m_on)
        c = _rank_ic(d, "sig", h, m_off)
        print(f"{h:>4} │ {a[0]:>8.4f} {a[1]:>6.2f} {a[2]:>5} {a[3]:>7.0f} │ "
              f"{b[0]:>9.4f} {b[1]:>6.2f} {b[2]:>5} {b[3]:>7.0f} │ "
              f"{c[0]:>10.4f} {c[1]:>6.2f} {c[2]:>5} {c[3]:>7.0f}")
    print("해석: (b)의 IC가 (a)보다 높고 유의(|t|>2)하면 장기 게이트가 정렬 품질을 실제로 개선.")

    # ④ 일관성(순매수일 비율) 후보 지표
    print("\n" + "=" * 78)
    print("④ 일관성 cons120 (외인 순매수일 비율, rolling120)  — 단독 예측력 + 이중 게이트 추가 가치")
    print("-" * 78)
    m_dbl = (d["f120"] > 0) & (d["cons120"] >= 0.5)   # 합계 게이트 + 일관성 게이트
    print(f"{'h':>4} │ {'(i)cons120 IC':>13} {'t':>6} {'날짜':>5} {'종목/일':>7} │ "
          f"{'(ii)이중게이트 sig IC':>20} {'t':>6} {'날짜':>5} {'종목/일':>7}")
    for h in HORIZONS:
        i = _rank_ic(d, "cons120", h)
        ii = _rank_ic(d, "sig", h, m_dbl)
        print(f"{h:>4} │ {i[0]:>13.4f} {i[1]:>6.2f} {i[2]:>5} {i[3]:>7.0f} │ "
              f"{ii[0]:>20.4f} {ii[1]:>6.2f} {ii[2]:>5} {ii[3]:>7.0f}")
    print("해석: (i) cons120 IC가 양·유의면 일관성 자체가 신호. "
          "(ii)가 ③(b)보다 높으면 일관성 게이트가 합계 게이트에 추가 가치. 태그 T_지속매집은 ②표 참조.")


# flow_ai `_assess`와 **정확히 동일한** 런타임 조건 — 저장 수치가 실제 적용 조건의 edge가 되도록.
def _canonical_masks(df: pd.DataFrame) -> dict:
    mc = df["mcap"].replace(0, np.nan)
    f20mc = df["f20"] / mc
    f5mc = df["f5"] / mc
    both = (df["f20"] > 0) & (df["i20"] > 0)
    entry_ok = (f20mc >= 0.0015) & (df["f5"] >= 0.3 * df["adv20"])
    return {
        # 장기동시: 외+기 20D·120D 4중 동반 순매수 (부호 게이트, 임계값 없음) — 검증 최상위 매수 태그.
        # flow_verdict.applicable_patterns의 배타 체인 맨 앞과 바이트 일치.
        "장기동시": (df["f20"] > 0) & (df["i20"] > 0) & (df["f120"] > 0) & (df["i120"] > 0),
        "정석(동시+진입권)": both & entry_ok,
        "진입권": entry_ok & (df["f20"] > 0),
        "추세순항": both & (df["ret20"] > 0),
        "동시": both,
        "매집주 눌림": (df["f120"] > 0) & (df["f20"] < 0),
        "하락추세 매집": (df["f20"] > 0) & (df["f120"] > 0) & (df["ret20"] < 0),
        "동반순매도": (df["f20"] < 0) & (df["i20"] < 0) & (df["f120"] <= 0),
        "분배": (f5mc <= -0.001) & (df["ret5"] >= -0.02) & (df["r5"] > 0),
        "단기반등": (df["f20"] > 0) & (df["f120"] < 0),
    }


def save_results(path: str, df: pd.DataFrame, years: float, h: int = 60) -> None:
    """canonical 패턴의 보유기간 곡선·Rank IC·메타를 측정해 JSON 저장.

    소비자 둘:
      1. flow_ai._load_edges — 레거시 키 `patterns.{name}.{h60_excess_pct,t,direction,n_dates}`만
         읽는다. 형식·값 **절대 불변**(h=60 canonical 스프레드, 기존과 동일 계산).
      2. 검증 근거 화면 — `patterns.{name}.curve`(CURVE_H 곡선), 최상위 `rank_ic`·메타를 읽는다.

    곡선은 리밸런스 서브셋(작음)을 날짜별 한 번만 순회하며 h마다 스프레드를 누적(h×패턴 중복
    groupby 회피). h60 곡선 값이 곧 레거시 h60_excess_pct라 한 번만 계산해 재사용한다.
    """
    masks = _canonical_masks(df)
    for name, m in masks.items():
        df[f"__c::{name}"] = m
    df["uni"] = (df["adv20"] >= ADV_MIN) & (df["mcap"] >= MCAP_MIN) & df["entry"].notna() & df["sig"].notna()
    times = np.sort(df["time"].unique())
    rebal = set(times[::REBAL_EVERY])
    d = df[df["uni"] & df["time"].isin(rebal)].copy()

    curve_h = sorted(set(CURVE_H) | {h})
    spreads: dict = {name: {hh: [] for hh in curve_h} for name in masks}
    counts: dict = {name: {hh: [] for hh in curve_h} for name in masks}
    for _, grp in d.groupby("time"):
        for hh in curve_h:
            fwd = f"fwd{hh}"
            u = grp[grp[fwd].notna()]
            if len(u) < 20:
                continue
            umean = u[fwd].mean()
            for name in masks:
                tg = u[u[f"__c::{name}"]]
                if len(tg) == 0:
                    continue
                spreads[name][hh].append(tg[fwd].mean() - umean)
                counts[name][hh].append(len(tg))

    patterns: dict = {}
    for name in masks:
        curve: dict = {}
        for hh in curve_h:
            sp_list = spreads[name][hh]
            if len(sp_list) < 5:  # 관측 부족 지평은 곡선에서 제외 (기존 <5 skip과 동일 기준)
                continue
            sp = np.array(sp_list)
            curve[str(hh)] = {
                "excess_pct": round(float(sp.mean()) * 100, 2),
                "t": round(float(sp.mean() / (sp.std(ddof=1) / np.sqrt(len(sp)))), 2),
                "n_dates": len(sp),
                "avg_stocks": round(float(np.mean(counts[name][hh])), 1),
            }
        h60 = curve.get(str(h))
        if h60 is None:  # h(=60) 관측 부족이면 패턴 자체 스킵 (기존 동작과 동일)
            continue
        patterns[name] = {
            # ── 레거시 키 (flow_ai._load_edges 소비 — 형식·값 불변) ──
            "h60_excess_pct": h60["excess_pct"],
            "t": h60["t"],
            "direction": "강세" if h60["excess_pct"] > 0 else "약세",
            "n_dates": h60["n_dates"],
            # ── 검증 근거 화면용 곡선 ──
            "curve": curve,
        }

    rank_ic: dict = {}
    for hh in HORIZONS:
        ic, tval, nd, _ = _rank_ic(d, "sig", hh)
        rank_ic[str(hh)] = {
            "ic": round(float(ic), 4) if not np.isnan(ic) else None,
            "t": round(float(tval), 2) if not np.isnan(tval) else None,
            "n_dates": nd,
        }

    # ── 유니버스 벤치마크 인덱스 (PR-B) — 종목별 에피소드 초과수익의 벤치마크 ──
    # 일별 유니버스(adv20≥ADV_MIN & mcap≥MCAP_MIN) 종목의 **로그수익 평균의 기하 누적**.
    # flow_exit_backtest.py _augment의 uidx와 동일 방법론: 일별 횡단면 *산술* 평균 복리化는
    # 소형주 노이즈 open의 Blume-Stambaugh 편향으로 벤치가 부풀어 초과수익 부호가 뒤집힘 →
    # 로그수익 평균의 누적(경로독립·기하평균 총수익)으로 교정. adj_open→adj_open (D+1 시가 체결 정합).
    uni_day = (df["adv20"] >= ADV_MIN) & (df["mcap"] >= MCAP_MIN)
    ret_open = df.groupby("stock", sort=False)["adj_open"].transform(lambda s: s / s.shift(1) - 1)
    m = uni_day & ret_open.notna() & (ret_open > -0.99)
    lr = ret_open[m].map(np.log1p).groupby(df.loc[m, "time"]).mean().sort_index()
    universe_index: dict = {"dates": [], "values": []}
    if len(lr) > 0:
        uidx = np.exp(lr.cumsum())
        uidx = uidx / uidx.iloc[0]  # 시작 1.0 정규화 (에피소드 초과수익은 비율이라 상수 상쇄)
        universe_index = {
            "dates": [pd.to_datetime(t).date().isoformat() for t in uidx.index],
            "values": [round(float(v), 6) for v in uidx.to_numpy()],
        }

    out = {
        "generated_at": date.today().isoformat(),
        "universe_n": int(df["stock"].nunique()),
        "horizon_days": h,
        "lookback_years": years,
        "period": {
            "start": pd.to_datetime(df["time"].min()).date().isoformat(),
            "end": pd.to_datetime(df["time"].max()).date().isoformat(),
        },
        "rebalance_days": REBAL_EVERY,
        "universe_criteria": {"adv_min": ADV_MIN, "mcap_min": MCAP_MIN},
        "curve_horizons": curve_h,
        "method": "D+1 시가 진입 · 유니버스 평균 대비 초과수익 · 주간 리밸런스 · look-ahead 차단",
        "rank_ic": rank_ic,
        "universe_index": universe_index,  # PR-B 종목 에피소드 벤치마크 (로그수익 평균 기하 누적)
        "patterns": patterns,
    }
    out_dir = os.path.dirname(os.path.abspath(path))
    os.makedirs(out_dir, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fp:
        json.dump(out, fp, ensure_ascii=False, indent=2)
    # startup 핸들러(main.py)가 남긴 실행 lock 정리
    lockp = os.path.join(out_dir, ".flow_backtest.running")
    if os.path.exists(lockp):
        os.remove(lockp)
    print(f"\n[saved] {path} — {len(patterns)}개 패턴 (기준일 {out['generated_at']})")


async def main() -> None:
    years = YEARS
    if "--years" in sys.argv:
        years = float(sys.argv[sys.argv.index("--years") + 1])
        print(f"[lookback override] {years}년")
    it_df, ohlcv_df, mc_df = await _fetch(years)
    print(f"패널 rows — 수급 {len(it_df):,} / 시세 {len(ohlcv_df):,} / 시총 {len(mc_df):,}")
    df = _build_panel(it_df, ohlcv_df, mc_df)
    df = _signals_tags(df)
    _evaluate(df)
    print("\n주: 초과수익 = 그날 유니버스 평균 대비. t>2 = 통계적으로 유의(✅). "
          "중첩·다중검정 감안해 t>2도 보수적으로 해석. 진입권은 연속일 대신 5D/ADV 근사.")
    # --save PATH → flow_ai가 읽을 검증 결과 JSON 저장 (주기 갱신 자동화)
    if "--save" in sys.argv:
        i = sys.argv.index("--save")
        path = sys.argv[i + 1] if i + 1 < len(sys.argv) else "data/flow_backtest.json"
        save_results(path, df, years)


if __name__ == "__main__":
    asyncio.run(main())
