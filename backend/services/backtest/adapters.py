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


# ─────────────────────────────── fin ───────────────────────────────
# 재무 point-in-time (backtest.md §3.1). DB 실측(2026-07):
#  - 분기 값은 **순분기**(누적 아님) — 005930 CFS revenue Q2<Q1 로 확인.
#  - 정본 fs_type = **CFS(연결) 우선, 결측만 OFS 폴백** (per-field combine_first).
#    CFS eps 결측이나 OFS는 있는 (종목,분기) 2000건을 OFS가 구제 (실측).
#  - `data_type='actual'`만 (원천 SQL 차단) — preliminary/estimate는 존재 시점 불명 → look-ahead.
#  - 저장 `per` 컬럼은 100% NULL, `pbr`은 collected_at 시점 가격 기반(point-in-time 아님) →
#    per·pbr은 저장값 버리고 **raw종가 기준 일별 재계산** (flow 분모와 동일 논리).
#
# ── 주식수 기준(basis) 브리지 — 분할·병합 왜곡 보정 (C3.1) ──
# 저장 eps/bps는 **collected_at 스냅샷 시점 주식수 기준으로 이력 전체가 소급 재표시**돼 있다
# (실측: 042510 5:1 병합·117670 12.1× 이벤트 전후 shares_outstanding 불변 = 단일 현재 기준).
# 반면 close_raw(t)는 t 시점 기준 → 이벤트가 (t, collected일] 사이면 per/pbr이 factor배 왜곡.
# corporate_actions는 share_factor 100% NULL(가격 gap 자동감지 price_factor뿐)이라 브리지로
# 못 쓰고, 대신 **adjfac(t) = adj_close(t)/close_price(t)** (= t 이후 이벤트 누적 price factor;
# 배당 미반영·분할/병합 전용 — 005930 배당주 전 구간 1.0000, 042510 5.0026 실측)를 쓴다:
#   value_basis(t) = value_stored × adjfac(collected일) / adjfac(t)
# 이벤트 없으면 비율 1 → 결과 불변. collected_at **이후** 이벤트(예: 011330 10:1 2026-06-30)는
# adjfac(collected일)≠1이 되어 같은 식으로 보정. collected일 = 종목별 max(collected_at)
# (스냅샷 창 2026-05-20~06-06 내 이벤트로 인한 행간 기준 혼재는 창 17일이라 근사 무시).
# eps_ttm·bps 패널 컬럼도 basis(t) 값으로 노출 → per/pbr = close_raw(t) ÷ basis(t) 값.
#
# 공시 지연 상수 (자본시장법 제출기한): 분기·반기보고서 45일, 사업보고서(FY말=Q4) 90일. 보수 고정.
FIN_LAG_Q = 45
FIN_LAG_ANNUAL = 90
# 카탈로그 가용 시작일 — actual 광범위(>1000 종목) 첫 분기 2024-12-31 기준 실측(2026-07):
#   as-of 레벨(pbr/bps/roe/roa/op_margin): 2024-12-31(Q4)+90 = 2025-03-31
#   TTM(per/eps_ttm): 첫 4분기창 종료 2025-09-30(+45) = 2025-11-14
#   전년동기(op_yoy/rev_yoy): 첫 전년비교 가능 분기 2025-12-31(Q4)+90 = 2026-03-31
FIN_ASOF_AVAIL = "2025-03-31"
FIN_TTM_AVAIL = "2025-11-14"
FIN_YOY_AVAIL = "2026-03-31"

# combine_first 대상 원천 필드 (CFS 우선 coalesce OFS).
_FIN_SRC_FIELDS = ["revenue", "operating_profit", "net_income", "eps", "bps",
                   "roe", "roa", "operating_margin"]
_FIN_OUT = ["per", "pbr", "eps_ttm", "bps", "roe", "roa", "operating_margin",
            "op_yoy", "revenue_yoy"]


class FinAdapter:
    namespace = "fin"

    def required_sources(self) -> set[str]:
        return {"ohlcv", "fin"}  # ohlcv = per/pbr 재계산용 raw종가(close_price)

    def catalog(self) -> list[dict]:
        def m(key, label, unit, desc, avail):
            return {"key": f"fin.{key}", "column": key, "label": label,
                    "unit": unit, "desc": desc, "available_from": avail}
        return [
            m("per", "PER (TTM·point-in-time)", "배",
              "raw종가 ÷ TTM 주당순이익(최근 공시 4개 **연속** 순분기 EPS 합, 당일 주식수 기준 환산). "
              "**음수 EPS의 PER는 NaN**(관례). 분기 누락 시 NaN.",
              FIN_TTM_AVAIL),
            m("pbr", "PBR (point-in-time)", "배",
              "raw종가 ÷ 최근 공시 BPS(당일 주식수 기준 환산 — 분할·병합 브리지). "
              "수정주가 아닌 raw종가(소급 방지, flow 분모와 동일).",
              FIN_ASOF_AVAIL),
            m("eps_ttm", "EPS (TTM)", "원",
              "최근 공시 4개 연속 순분기 EPS 합 — 당일 주식수 기준 (4분기 미확보·분기 누락 시 NaN)", FIN_TTM_AVAIL),
            m("bps", "BPS", "원", "최근 공시 주당순자산 (as-of, 당일 주식수 기준)", FIN_ASOF_AVAIL),
            m("roe", "ROE", "%", "최근 공시 자기자본이익률 (as-of, CFS 우선)", FIN_ASOF_AVAIL),
            m("roa", "ROA", "%", "최근 공시 총자산이익률 (as-of, CFS 우선)", FIN_ASOF_AVAIL),
            m("operating_margin", "영업이익률", "%", "최근 공시 영업이익률 (순분기, as-of)", FIN_ASOF_AVAIL),
            m("op_yoy", "영업이익 증감률 (YoY)", "%", "영업이익 전년동기 대비 증감률 (직전 흑자 기준, 적자→NaN)", FIN_YOY_AVAIL),
            m("revenue_yoy", "매출 증감률 (YoY)", "%", "매출 전년동기 대비 증감률", FIN_YOY_AVAIL),
        ]

    def build(self, raw: dict, ctx) -> pd.DataFrame:
        oh = raw["ohlcv"]   # time, stock, close_price(raw)·adj_close (adjfac 브리지용)
        fin = raw["fin"]    # actual만, CFS+OFS+collected_at (RawFetcher._fin)
        spine = oh[["time", "stock", "close_price", "adj_close"]].copy()
        # adjfac(t) = t 이후 분할·병합 누적 price factor (배당 미반영 — 실측 주석 참조).
        cp = pd.to_numeric(spine["close_price"], errors="coerce").to_numpy(dtype=float)
        ac = pd.to_numeric(spine["adj_close"], errors="coerce").to_numpy(dtype=float)
        with np.errstate(divide="ignore", invalid="ignore"):
            spine["adjfac"] = np.where((cp > 0) & (ac > 0), ac / cp, np.nan)
        if fin.empty:
            for c in _FIN_OUT:
                spine[c] = np.nan
            return spine[["time", "stock", *_FIN_OUT]]

        # 1) CFS 우선 coalesce OFS (per-field). PK(stock,period_end,fs_type) → 각 fs_type 1행.
        cfs = fin[fin["fs_type"] == "CFS"].set_index(["stock", "period_end"])[_FIN_SRC_FIELDS]
        ofs = fin[fin["fs_type"] == "OFS"].set_index(["stock", "period_end"])[_FIN_SRC_FIELDS]
        q = cfs.combine_first(ofs).reset_index()
        q["period_end"] = pd.to_datetime(q["period_end"])
        q = q.sort_values(["stock", "period_end"]).reset_index(drop=True)
        g = q.groupby("stock", sort=False)

        # TTM EPS = 4 순분기 합 (min_periods=4 → 결측 분기 있으면 NaN). 값이 순분기임을 실측(2026-07).
        q["eps_ttm"] = g["eps"].transform(lambda s: s.rolling(4, min_periods=4).sum())
        # 분기 **연속성 게이트**: 행 존재 ≠ 연속 분기 (실측 488900 gap 184일). 4분기창 스팬
        # (pe − pe.shift(3)) = 정상 267~276일, 전년동기 스팬 (pe − pe.shift(4)) = 365~366일.
        # 창이 스팬 허용범위 밖이면 결산기 누락/변경 → TTM·YoY 각각 NaN.
        span3 = (q["period_end"] - g["period_end"].shift(3)).dt.days.to_numpy(dtype=float)
        span4 = (q["period_end"] - g["period_end"].shift(4)).dt.days.to_numpy(dtype=float)
        ttm_ok = (span3 >= 250) & (span3 <= 290)
        yoy_ok = (span4 >= 350) & (span4 <= 380)
        q.loc[~ttm_ok, "eps_ttm"] = np.nan
        op_prev = g["operating_profit"].shift(4).to_numpy(dtype=float)
        rev_prev = g["revenue"].shift(4).to_numpy(dtype=float)
        op_now = pd.to_numeric(q["operating_profit"], errors="coerce").to_numpy(dtype=float)
        rev_now = pd.to_numeric(q["revenue"], errors="coerce").to_numpy(dtype=float)
        with np.errstate(divide="ignore", invalid="ignore"):
            q["op_yoy"] = np.where((op_prev > 0) & yoy_ok, (op_now / op_prev - 1.0) * 100, np.nan)
            q["revenue_yoy"] = np.where((rev_prev > 0) & yoy_ok, (rev_now / rev_prev - 1.0) * 100, np.nan)

        # 1.5) 종목별 collected일의 adjfac (= fac_c) — basis 브리지 분자.
        #      collected일이 휴장일이면 직전 거래일 (merge_asof backward).
        coll = (fin.groupby("stock", sort=False)["collected_at"].max()
                .reset_index().rename(columns={"collected_at": "time"}))
        coll["time"] = (pd.to_datetime(coll["time"]).dt.tz_localize(None).dt.normalize()
                        .astype(spine["time"].dtype))  # merge_asof는 양쪽 M8 단위 일치 요구
        fac_src = spine[["time", "stock", "adjfac"]].dropna(subset=["adjfac"]).sort_values("time")
        coll = pd.merge_asof(coll.sort_values("time"), fac_src, on="time", by="stock",
                             direction="backward")
        fac_c_map = dict(zip(coll["stock"], coll["adjfac"]))
        q["fac_c"] = q["stock"].map(fac_c_map)

        # 2) 공시 지연 → available_from (분기 45일 / Q4=FY말 90일). Q4는 12월 결산 대다수;
        #    비12월 결산 소수 종목(각 ~4행)의 사업보고서는 +45로 근사됨(§3.1 근사 명시).
        month = q["period_end"].dt.month.to_numpy()
        lag = np.where(month == 12, FIN_LAG_ANNUAL, FIN_LAG_Q)
        q["available_from"] = q["period_end"] + pd.to_timedelta(lag, unit="D")

        # 3) as-of backward 조인 (available_from 기준) → 일별 값. available_from은 period_end 단조↑.
        asof_cols = ["eps_ttm", "bps", "roe", "roa", "operating_margin", "op_yoy", "revenue_yoy", "fac_c"]
        qa = (q[["available_from", "stock", *asof_cols]]
              .dropna(subset=["available_from"]).sort_values("available_from")
              .rename(columns={"available_from": "time"}))
        spine = spine.sort_values("time")
        merged = pd.merge_asof(spine, qa, on="time", by="stock", direction="backward")

        # 4) basis 브리지: 저장 eps/bps(collected일 주식수 기준) → t 시점 기준.
        #    value_basis(t) = value × fac_c / adjfac(t). 이벤트 없으면 비율 1 → 불변.
        fac_t = merged["adjfac"].to_numpy(dtype=float)
        fac_c = merged["fac_c"].to_numpy(dtype=float)
        with np.errstate(divide="ignore", invalid="ignore"):
            basis = np.where((fac_t > 0) & (fac_c > 0), fac_c / fac_t, np.nan)
        merged["eps_ttm"] = merged["eps_ttm"].to_numpy(dtype=float) * basis
        merged["bps"] = merged["bps"].to_numpy(dtype=float) * basis

        # 5) per/pbr 일별 재계산 (raw종가 ÷ basis(t) 주당값). 음수/0 EPS·BPS → NaN.
        close = pd.to_numeric(merged["close_price"], errors="coerce").to_numpy(dtype=float)
        eps_ttm = merged["eps_ttm"].to_numpy(dtype=float)
        bps = merged["bps"].to_numpy(dtype=float)
        with np.errstate(divide="ignore", invalid="ignore"):
            merged["per"] = np.where(eps_ttm > 0, close / eps_ttm, np.nan)
            merged["pbr"] = np.where(bps > 0, close / bps, np.nan)
        return merged[["time", "stock", *_FIN_OUT]]


# ─────────────────────────────── own ───────────────────────────────
# 외인 보유율 (foreign_ownership, hypertable). 실측(2026-07): 일별 전종목 커버리지 2022-01-03~,
# ratio/limit/vol 전부 non-null. frn_limit_ratio는 대다수 100(무제한)이나 은행·통신·유틸 등은
# 49/49.99/30/40 (한도 유효). limit=0 종목은 소진율 NaN 가드.
_OWN_OUT = ["frn_ratio", "frn_ratio_5d_chg", "frn_ratio_20d_chg", "frn_limit_util"]


class OwnAdapter:
    namespace = "own"

    def required_sources(self) -> set[str]:
        return {"foreign"}

    def catalog(self) -> list[dict]:
        def m(key, label, unit, desc, avail):
            return {"key": f"own.{key}", "column": key, "label": label,
                    "unit": unit, "desc": desc, "available_from": avail}
        return [
            m("frn_ratio", "외국인 보유율", "%", "외국인 보유 주식수 비율", DATA_START.isoformat()),
            m("frn_ratio_5d_chg", "외인 보유율 5D 변화", "pp", "외국인 보유율 5거래일 변화(%p)", _avail(5)),
            m("frn_ratio_20d_chg", "외인 보유율 20D 변화", "pp", "외국인 보유율 20거래일 변화(%p)", _avail(20)),
            m("frn_limit_util", "외인 한도소진율", "%", "보유율 ÷ 외인한도 × 100 (한도 0/무 → NaN)", DATA_START.isoformat()),
        ]

    def build(self, raw: dict, ctx) -> pd.DataFrame:
        fo = raw["foreign"]   # time, stock, frn_ownership_ratio, frn_limit_ratio
        if fo.empty:
            return pd.DataFrame(columns=["time", "stock", *_OWN_OUT])
        df = fo.sort_values(["stock", "time"]).reset_index(drop=True)
        g = df.groupby("stock", sort=False)
        ratio = pd.to_numeric(df["frn_ownership_ratio"], errors="coerce")
        df["frn_ratio"] = ratio
        df["frn_ratio_5d_chg"] = ratio - g["frn_ownership_ratio"].shift(5)
        df["frn_ratio_20d_chg"] = ratio - g["frn_ownership_ratio"].shift(20)
        limit = pd.to_numeric(df["frn_limit_ratio"], errors="coerce").to_numpy(dtype=float)
        rr = ratio.to_numpy(dtype=float)
        with np.errstate(divide="ignore", invalid="ignore"):
            df["frn_limit_util"] = np.where(limit > 0, rr / limit * 100.0, np.nan)
        return df[["time", "stock", *_OWN_OUT]]


# ─────────────────────────────── etf ───────────────────────────────
# ETF 괴리(disparity)·NAV·보수. 원천 = etf_master_daily(snapshot_date, net_asset, listed_shares,
# total_fee). 실측(2026-07): 커버리지 **2026-01-02~** (676 종목), 하이퍼테이블 아님(단일 SELECT).
# 가격/거래대금/시총은 price 네임스페이스가 ohlcv_daily·market_cap_daily로 이미 커버(ETF도 존재) —
# etf 어댑터는 NAV 계열만. 비ETF 종목은 etf_master 없음 → 전 컬럼 NaN.
#   nav_per_share = net_asset / listed_shares (raw 원/주)
#   disparity(%)  = raw종가(close_price) / nav_per_share − 1   (nav가 raw-per-share라 raw종가 사용)
# as-of backward 조인(snapshot_date ≤ t) — 스냅샷 없는 날은 직전 스냅샷 forward-fill.
# `_etf_mcap_eok`(= net_asset ÷ 1억)은 카탈로그 밖 헬퍼 — market_cap_daily 결측 ETF의 mcap 폴백용
# (panel._compute가 소비 후 drop). ETF는 market_cap_daily 실측 커버리지 1142/1143이라 폴백은 예외적.
ETF_AVAIL = "2026-01-02"
_ETF_OUT = ["disparity", "nav_per_share", "total_fee"]


class EtfAdapter:
    namespace = "etf"

    def required_sources(self) -> set[str]:
        return {"ohlcv", "etf_master"}  # ohlcv = disparity 재계산용 raw종가(close_price)

    def catalog(self) -> list[dict]:
        def m(key, label, unit, desc, avail=ETF_AVAIL):
            return {"key": f"etf.{key}", "column": key, "label": label,
                    "unit": unit, "desc": desc, "available_from": avail}
        return [
            m("disparity", "괴리율", "%",
              "ETF 시장가격 괴리율 = raw종가 ÷ 주당NAV(net_asset/listed_shares) − 1. "
              "양수=고평가(프리미엄)·음수=저평가(디스카운트). etf_master 2026-01-02~."),
            m("nav_per_share", "주당 NAV", "원", "순자산가치 ÷ 상장주식수 (as-of 스냅샷)"),
            m("total_fee", "총보수", "%", "ETF 총보수율(연) — 낮을수록 저비용"),
        ]

    def build(self, raw: dict, ctx) -> pd.DataFrame:
        oh = raw["ohlcv"]          # time, stock, close_price(raw)
        em = raw["etf_master"]     # stock, snapshot_date, net_asset, listed_shares, total_fee
        spine = oh[["time", "stock", "close_price"]].copy()
        if em is None or em.empty:
            for c in _ETF_OUT:
                spine[c] = np.nan
            spine["_etf_mcap_eok"] = np.nan
            return spine[["time", "stock", *_ETF_OUT, "_etf_mcap_eok"]]

        em = em.copy()
        em["time"] = pd.to_datetime(em["snapshot_date"])
        na = pd.to_numeric(em["net_asset"], errors="coerce").to_numpy(dtype=float)
        ls = pd.to_numeric(em["listed_shares"], errors="coerce").to_numpy(dtype=float)
        with np.errstate(divide="ignore", invalid="ignore"):
            em["nav_per_share"] = np.where(ls > 0, na / ls, np.nan)
            em["_etf_mcap_eok"] = np.where(na > 0, na / _EOK, np.nan)
        em["total_fee"] = pd.to_numeric(em["total_fee"], errors="coerce")
        asof = (em[["time", "stock", "nav_per_share", "total_fee", "_etf_mcap_eok"]]
                .dropna(subset=["time"]).sort_values("time"))
        spine = spine.sort_values("time")
        merged = pd.merge_asof(spine, asof, on="time", by="stock", direction="backward")
        close = pd.to_numeric(merged["close_price"], errors="coerce").to_numpy(dtype=float)
        nav = merged["nav_per_share"].to_numpy(dtype=float)
        with np.errstate(divide="ignore", invalid="ignore"):
            merged["disparity"] = np.where(nav > 0, close / nav - 1.0, np.nan) * 100.0
        return merged[["time", "stock", *_ETF_OUT, "_etf_mcap_eok"]]


ADAPTERS: list[DataAdapter] = [PriceAdapter(), FlowAdapter(), FinAdapter(), OwnAdapter(), EtfAdapter()]


def full_catalog() -> list[dict]:
    """네임스페이스별 카탈로그를 순서대로 병합."""
    out: list[dict] = []
    for a in ADAPTERS:
        out.extend(a.catalog())
    return out


def field_column_map() -> dict[str, str]:
    """카탈로그 지표 키 → 패널 컬럼명 (조건 필드 해석용)."""
    return {c["key"]: c["column"] for c in full_catalog()}
