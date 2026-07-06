"""네임스페이스 데이터 어댑터 — backtest.md §3.

각 어댑터는 (1) 지표 **카탈로그**(키·한글 라벨·단위·설명·가용 시작일)와
(2) (time, stock) 일별 **패널 컬럼**(build)을 제공한다. 새 데이터 소스 추가 = 어댑터 1개 추가.

- price: ohlcv_daily + market_cap_daily → 수익률/거래대금/시총/MA·이격도/52주 대비.
- flow : investor_trading(+유통시총 분모) → f/i bp·억, streak, 흡수율, **태그 bool**.
         태그·bp는 **공식 1벌**: flow_metrics._row_to_metrics + flow_verdict.applicable_patterns
         정본을 일별 SQL-row(SimpleNamespace)로 재호출 (flow_episodes와 동일). 근사 금지.

패널 컬럼은 전부 **trailing**(D 종가까지의 데이터로만 계산) — look-ahead 차단은 엔진 레일이
아니라 여기서 shift 방향으로 보장한다. 실행가(adj_open/adj_close)·market은 엔진이 쓰는
비카탈로그 컬럼으로 함께 싣는다.
"""
from __future__ import annotations

import math
from datetime import date, timedelta
from types import SimpleNamespace
from typing import Protocol

import numpy as np
import pandas as pd

from services import flow_metrics as fm
from services import flow_verdict

# 패널 데이터 시작일 (probe: ohlcv_daily min(time) = 2022-01-03). 카탈로그 가용 시작일 계산의 기준.
DATA_START = date(2022, 1, 3)
_EOK = 100_000_000  # 1억


def _avail(window_trading_days: int) -> str:
    """지표가 신뢰 가능해지는 대략적 시작일 = DATA_START + window(거래일→달력일 ≈ ×1.4)."""
    if window_trading_days <= 1:
        return DATA_START.isoformat()
    return (DATA_START + timedelta(days=math.ceil(window_trading_days * 7 / 5))).isoformat()


class DataAdapter(Protocol):
    namespace: str

    def catalog(self) -> list[dict]: ...
    def required_sources(self) -> set[str]: ...
    def build(self, raw: dict, ctx) -> pd.DataFrame: ...


# ─────────────────────────────── price ───────────────────────────────
class PriceAdapter:
    namespace = "price"

    def required_sources(self) -> set[str]:
        return {"ohlcv", "mcap"}

    def catalog(self) -> list[dict]:
        def m(key, label, unit, desc, win=1):
            return {"key": f"price.{key}", "column": key, "label": label,
                    "unit": unit, "desc": desc, "available_from": _avail(win)}
        cat = [
            m("close", "종가(수정)", "원", "수정종가 (분할·병합 반영)"),
            m("mcap", "시가총액", "억", "총 시가총액"),
            m("adv_20d", "거래대금(20D 평균)", "억", "최근 20거래일 평균 거래대금"),
            m("ret_5d", "수익률 5D", "%", "5거래일 수익률(수정종가)", 5),
            m("ret_20d", "수익률 20D", "%", "20거래일 수익률(수정종가)", 20),
            m("ret_60d", "수익률 60D", "%", "60거래일 수익률(수정종가)", 60),
            m("ret_120d", "수익률 120D", "%", "120거래일 수익률(수정종가)", 120),
        ]
        for n in (20, 60, 120, 200):
            cat.append(m(f"ma_{n}", f"이동평균 {n}일", "원", f"{n}일 단순이동평균(수정종가)", n))
            cat.append(m(f"ma{n}_disp", f"{n}일선 이격도", "%", f"종가/MA{n} − 1", n))
        cat.append(m("high_52w_disp", "52주 고점 대비", "%", "종가/52주 최고가 − 1", 252))
        return cat

    def build(self, raw: dict, ctx) -> pd.DataFrame:
        oh = raw["ohlcv"]   # time, stock, adj_open, adj_close, close_price, trading_value
        mc = raw["mcap"]    # time, stock, market_cap
        df = oh.merge(mc, on=["time", "stock"], how="left").sort_values(["stock", "time"])
        g = df.groupby("stock", sort=False)
        for h in (5, 20, 60, 120):
            df[f"ret_{h}d"] = g["adj_close"].transform(lambda s, h=h: s / s.shift(h) - 1) * 100
        # adv_20d: universe 필터·지표 공용 → 완전한 20거래일 창만 (min_periods=20). 억 단위.
        df["adv_20d"] = g["trading_value"].transform(lambda s: s.rolling(20, min_periods=20).mean()) / _EOK
        df["mcap"] = df["market_cap"] / _EOK
        df["close"] = df["adj_close"]
        for n in (20, 60, 120, 200):
            ma = g["adj_close"].transform(lambda s, n=n: s.rolling(n, min_periods=n).mean())
            df[f"ma_{n}"] = ma
            df[f"ma{n}_disp"] = (df["adj_close"] / ma - 1) * 100
        hi = g["adj_close"].transform(lambda s: s.rolling(252, min_periods=120).max())
        df["high_52w_disp"] = (df["adj_close"] / hi - 1) * 100

        cols = ["time", "stock", "adj_open", "adj_close",
                "close", "mcap", "adv_20d", "ret_5d", "ret_20d", "ret_60d", "ret_120d",
                "ma_20", "ma_60", "ma_120", "ma_200",
                "ma20_disp", "ma60_disp", "ma120_disp", "ma200_disp", "high_52w_disp"]
        return df[cols]


# ─────────────────────────────── flow ───────────────────────────────
# 정본 태그 (배타 체인 + 경고). flow_verdict.applicable_patterns가 반환하는 canonical 이름과 일치.
FLOW_TAGS = [
    "장기동시", "정석(동시+진입권)", "진입권", "추세순항", "동시",
    "매집주 눌림", "하락추세 매집", "동반순매도", "분배", "단기반등",
]
# _row_to_metrics dict에서 패널 컬럼으로 노출할 수치 지표 (키 = m dict 키 = 패널 컬럼).
_FLOW_NUM = [
    "f_5d_bp", "f_20d_bp", "f_60d_bp", "f_120d_bp", "i_20d_bp", "i_120d_bp",
    "f_5d_eok", "f_20d_eok", "f_60d_eok", "f_120d_eok",
    "i_5d_eok", "i_20d_eok", "i_120d_eok", "r_5d_eok",
    "f_streak", "absorb_5d_pct",
]


class FlowAdapter:
    namespace = "flow"

    def required_sources(self) -> set[str]:
        return {"investor", "ohlcv", "mcap", "floating"}

    def catalog(self) -> list[dict]:
        def m(key, label, unit, desc, win):
            return {"key": f"flow.{key}", "column": key, "label": label,
                    "unit": unit, "desc": desc, "available_from": _avail(win)}
        num_meta = {
            "f_5d_bp": ("외인 5D 수급강도", "bp", "외국인 5거래일 순매수 ÷ 유통시총", 5),
            "f_20d_bp": ("외인 20D 수급강도", "bp", "외국인 20거래일 순매수 ÷ 유통시총", 20),
            "f_60d_bp": ("외인 60D 수급강도", "bp", "외국인 60거래일 순매수 ÷ 유통시총", 60),
            "f_120d_bp": ("외인 120D 수급강도", "bp", "외국인 120거래일 순매수 ÷ 유통시총", 120),
            "i_20d_bp": ("기관 20D 수급강도", "bp", "기관 20거래일 순매수 ÷ 유통시총", 20),
            "i_120d_bp": ("기관 120D 수급강도", "bp", "기관 120거래일 순매수 ÷ 유통시총", 120),
            "f_5d_eok": ("외인 5D 순매수", "억", "외국인 5거래일 순매수 금액", 5),
            "f_20d_eok": ("외인 20D 순매수", "억", "외국인 20거래일 순매수 금액", 20),
            "f_60d_eok": ("외인 60D 순매수", "억", "외국인 60거래일 순매수 금액", 60),
            "f_120d_eok": ("외인 120D 순매수", "억", "외국인 120거래일 순매수 금액", 120),
            "i_5d_eok": ("기관 5D 순매수", "억", "기관 5거래일 순매수 금액", 5),
            "i_20d_eok": ("기관 20D 순매수", "억", "기관 20거래일 순매수 금액", 20),
            "i_120d_eok": ("기관 120D 순매수", "억", "기관 120거래일 순매수 금액", 120),
            "r_5d_eok": ("개인 5D 순매수", "억", "개인 5거래일 순매수 금액", 5),
            "f_streak": ("외인 연속일", "일", "외국인 연속 순매수(+)/순매도(−) 일수", 1),
            "absorb_5d_pct": ("흡수율 5D", "%", "(외+기) 5D 순매수 ÷ 5D 거래대금", 5),
        }
        cat = [m(k, *num_meta[k]) for k in _FLOW_NUM]
        for t in FLOW_TAGS:
            cat.append({"key": f"flow.tag.{t}", "column": f"tag_{t}", "label": t,
                        "unit": "bool", "desc": f"수급 태그 '{t}' (정본 판정)", "available_from": _avail(120)})
        return cat

    def build(self, raw: dict, ctx) -> pd.DataFrame:
        it = raw["investor"]   # time, stock, type, net
        oh = raw["ohlcv"]      # time, stock, adj_open, adj_close, close_price, trading_value
        mc = raw["mcap"]       # time, stock, market_cap
        fs = raw["floating"]   # stock, base_date, floating_shares, total_shares

        piv = it.pivot_table(index=["time", "stock"], columns="type", values="net", aggfunc="sum").reset_index()
        piv = piv.rename(columns={"FOREIGN": "f", "INSTITUTION": "i", "RETAIL": "r"})
        for c in ("f", "i", "r"):
            if c not in piv.columns:
                piv[c] = 0.0
        # runtime flow JOIN px 와 동일: 투자자축 ⋈ ohlcv축 (inner — 둘 다 있어야 지표 성립)
        df = oh.merge(piv, on=["time", "stock"], how="inner").merge(mc, on=["time", "stock"], how="left")
        for c in ("f", "i", "r"):
            df[c] = df[c].fillna(0.0).astype(float)
        df = df.sort_values(["stock", "time"]).reset_index(drop=True)
        g = df.groupby("stock", sort=False)

        # 롤링 합/평균 — runtime rn<=N(부분합 허용)과 정합하도록 min_periods=1 (flow_episodes와 동일).
        def rsum(col, n):
            return g[col].transform(lambda s, n=n: s.rolling(n, min_periods=1).sum())
        df["f5"], df["f20"], df["f60"], df["f120"] = rsum("f", 5), rsum("f", 20), rsum("f", 60), rsum("f", 120)
        df["i5"], df["i20"], df["i60"], df["i120"] = rsum("i", 5), rsum("i", 20), rsum("i", 60), rsum("i", 120)
        df["r5"] = rsum("r", 5)
        df["tv5"] = rsum("trading_value", 5)
        df["adv20"] = g["trading_value"].transform(lambda s: s.rolling(20, min_periods=1).mean())
        df["adj5"] = g["adj_close"].transform(lambda s: s.shift(5))
        df["adj20c"] = g["adj_close"].transform(lambda s: s.shift(20))

        # 부호 연속일 run-length (종목 경계에서 리셋) — runtime f_buy_streak/f_sell_streak과 동일 의미.
        fv = df["f"].to_numpy()
        st = df["stock"].to_numpy()
        pos = np.zeros(len(fv), dtype=np.int32)
        neg = np.zeros(len(fv), dtype=np.int32)
        for k in range(len(fv)):
            same = k > 0 and st[k] == st[k - 1]
            if fv[k] > 0:
                pos[k] = (pos[k - 1] + 1) if same else 1
            elif fv[k] < 0:
                neg[k] = (neg[k - 1] + 1) if same else 1
        df["buy_streak"] = pos
        df["sell_streak"] = neg

        # 유통주식수·시총 as-of (merge_asof backward) — point-in-time 분모용.
        if not fs.empty:
            fs = fs.rename(columns={"base_date": "time"}).sort_values("time")
            df = pd.merge_asof(df.sort_values("time"), fs[["time", "stock", "floating_shares", "total_shares"]],
                               on="time", by="stock", direction="backward")
            df = df.sort_values(["stock", "time"]).reset_index(drop=True)
        else:
            df["floating_shares"] = np.nan
            df["total_shares"] = np.nan

        n = len(df)
        num_out = {k: np.full(n, np.nan, dtype=np.float64) for k in _FLOW_NUM}
        tag_out = {t: np.zeros(n, dtype=bool) for t in FLOW_TAGS}

        def _v(x):
            return None if x is None or (isinstance(x, float) and math.isnan(x)) else x

        # 정본 재호출 루프 (~3M rows, ≈1분). itertuples로 오버헤드 최소화하되 정본 함수는 우회 금지.
        for idx, row in enumerate(df.itertuples(index=False)):
            r = SimpleNamespace(
                stock_code=row.stock, stock_name=None, market=None, fics_sector=None,
                market_cap=_v(row.market_cap), floating_shares=_v(row.floating_shares),
                total_shares=_v(row.total_shares), float_date=None,
                close_raw=_v(row.close_price) or 0, adj_now=_v(row.adj_close),
                adj_5d_ago=_v(row.adj5), adj_20d_ago=_v(row.adj20c),
                tv_5d=_v(row.tv5), adv_20d=_v(row.adv20), f_1d=row.f, i_1d=row.i,
                f_5d=row.f5, f_20d=row.f20, f_60d=row.f60, f_120d=row.f120,
                i_5d=row.i5, i_20d=row.i20, i_60d=row.i60, i_120d=row.i120, r_5d=row.r5,
                f_buy_streak=int(row.buy_streak), f_sell_streak=int(row.sell_streak),
            )
            m = fm._row_to_metrics(r)  # 정본 지표 (분모·bp·부호 게이트 전부 여기서)
            if m is None:
                continue
            for k in _FLOW_NUM:
                val = m.get(k)
                if val is not None:
                    num_out[k][idx] = val
            for t in flow_verdict.applicable_patterns(m):
                tag_out[t][idx] = True

        out = pd.DataFrame({"time": df["time"].values, "stock": df["stock"].values})
        for k in _FLOW_NUM:
            out[k] = num_out[k]
        for t in FLOW_TAGS:
            out[f"tag_{t}"] = tag_out[t]
        return out


ADAPTERS: list[DataAdapter] = [PriceAdapter(), FlowAdapter()]


def full_catalog() -> list[dict]:
    """네임스페이스별 카탈로그를 순서대로 병합."""
    out: list[dict] = []
    for a in ADAPTERS:
        out.extend(a.catalog())
    return out


def field_column_map() -> dict[str, str]:
    """카탈로그 지표 키 → 패널 컬럼명 (조건 필드 해석용)."""
    return {c["key"]: c["column"] for c in full_catalog()}
