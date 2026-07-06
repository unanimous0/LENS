"""수급 태그 **에피소드 히스토리** 정본 (PR-B) — 종목별 "이 태그가 과거에 붙었을 때 실제로 어땠나".

원칙(부검 준수 — 공식 1벌):
  - **태그 판정 공식을 새로 쓰지 않는다.** 종목의 과거 각 거래일 D를 runtime 랭킹 SQL과 같은
    의미의 SQL-row로 재구성해 `flow_metrics._row_to_metrics`를 **그대로** 통과시킨 뒤,
    그 dict를 `flow_verdict.applicable_patterns`에 **그대로** 넘겨 일별 패턴 멤버십을 얻는다.
    → 화면 태그(=/ranking)와 히스토리가 바이트 일치. (분모·bp 임계·부호 게이트 전부 정본 재사용.)
  - **성과 = look-ahead 차단**: 진입은 태그 onset의 **D+1 시가(adj_open)**, h∈{20,60,120} 거래일
    후 시가로 청산. 초과수익 = 종목수익 − 유니버스 벤치(universe_index, 로그수익 평균 기하 누적)
    수익. 벤치는 flow_tag_backtest --save가 생성한 data/flow_backtest.json의 universe_index.
  - 벤치 부재(JSON 없음/구스키마) → 절대수익만 + benchmark_available:false.

캐시: flow_metrics.data_version 기반 `_result_cache` (검증 기준일 gen 포함 키).
"""
from __future__ import annotations

import json
import math
from datetime import date, timedelta
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pandas as pd
from sqlalchemy import text

from core.database import korea_async_session
from services import flow_metrics as fm
from services import flow_verdict

# flow_ai._BACKTEST_PATH와 동일 파일 (중복 상수 대신 여기서도 레포 루트/data 재계산)
_BACKTEST_PATH = Path(__file__).resolve().parents[2] / "data" / "flow_backtest.json"
_WARMUP_DAYS = 190          # 롤링 워밍업 여유 (120거래일 ≈ 168달력일 < 190 → 안전)
_DEFAULT_WINDOW_DAYS = 730  # 벤치 JSON 없을 때 기본 히스토리 창(≈2년)
_HORIZONS = (20, 60, 120)


# ── 벤치마크 로드 ──────────────────────────────────────────────────────────
def _load_benchmark() -> tuple[dict | None, dict | None, str | None]:
    """flow_backtest.json → (uidx_map{date:value}, period, generated_at).

    universe_index(PR-B) 부재 시 uidx_map=None → benchmark_available:false로 degrade."""
    try:
        if _BACKTEST_PATH.exists():
            data = json.loads(_BACKTEST_PATH.read_text(encoding="utf-8"))
            ui = data.get("universe_index") or {}
            uidx = None
            if ui.get("dates") and ui.get("values") and len(ui["dates"]) == len(ui["values"]):
                uidx = dict(zip(ui["dates"], ui["values"]))
            return uidx, data.get("period"), data.get("generated_at")
    except Exception:  # noqa: BLE001 — 손상/부재 시 벤치 없이 진행
        pass
    return None, None, None


# ── 데이터 조회 (Finance_Data read-only, 종목 1개라 가벼움) ────────────────
# ⚠️ investor_trading/ohlcv_daily/market_cap_daily는 일자 파티션 테이블 — 2.5년 범위를 한
#    트랜잭션에 몰아 SELECT하면 파티션별 AccessShareLock이 누적돼 max_locks_per_transaction 초과
#    (out of shared memory). 각 조회를 **별도 세션(트랜잭션)**으로 돌려 파티션 락을 사이사이 해제.
async def _q(sql: str, params: dict):
    async with korea_async_session() as session:
        return (await session.execute(text(sql), params)).all()


async def _load_panel(code: str, start: date, end: date):
    p = {"code": code, "start": start, "end": end}
    it = await _q(
        """
        SELECT time::text AS d, investor_type, net_buy_value
        FROM investor_trading
        WHERE stock_code = :code AND time BETWEEN :start AND :end
          AND investor_type IN ('FOREIGN','INSTITUTION','RETAIL')
        """, p)
    oh = await _q(
        """
        SELECT time::text AS d, adj_open, adj_close, close_price, trading_value
        FROM ohlcv_daily
        WHERE stock_code = :code AND time BETWEEN :start AND :end
        """, p)
    mc = await _q(
        """
        SELECT time::text AS d, market_cap
        FROM market_cap_daily
        WHERE stock_code = :code AND time BETWEEN :start AND :end
        """, p)
    # 유통주식수는 as-of(base_date<=end)면 되므로 start 하한 없이 이력 전부 (merge_asof backward).
    # 유효값(>0)만 — floating_shares NULL 적재 이슈 행은 건너뜀 (runtime과 동일).
    fs = await _q(
        """
        SELECT base_date::text AS d, floating_shares, total_shares
        FROM floating_shares
        WHERE stock_code = :code AND base_date <= :end
          AND floating_shares > 0 AND total_shares > 0
        ORDER BY base_date
        """, {"code": code, "end": end})
    nm_rows = await _q(
        """
        SELECT s.stock_name, s.market, sec.fics_sector
        FROM stocks s
        LEFT JOIN stock_sectors sec ON sec.stock_code = s.stock_code
        WHERE s.stock_code = :code
        """, {"code": code})
    nm = nm_rows[0] if nm_rows else None
    return it, oh, mc, fs, nm


# ── 일별 지표 패널 → SQL-row 재구성 → 정본 판정 ───────────────────────────
def _daily_membership(code, panel, nm) -> pd.DataFrame | None:
    """각 거래일의 (date, adj_open, patterns[list]) DataFrame. runtime 랭킹과 동일 의미 필드로
    `_row_to_metrics` → `applicable_patterns` 재호출 (공식 1벌). 데이터 없으면 None."""
    it, oh, mc, fs, _nm = panel

    it_df = pd.DataFrame(it, columns=["d", "type", "net"])
    oh_df = pd.DataFrame(oh, columns=["d", "adj_open", "adj_close", "close_price", "tv"])
    if it_df.empty or oh_df.empty:
        return None

    # 투자자별 순매수 pivot + 롤링 합 (투자자 거래일 축, min_periods=1 = runtime 부분합과 정합)
    piv = it_df.pivot_table(index="d", columns="type", values="net", aggfunc="sum")
    for c in ("FOREIGN", "INSTITUTION", "RETAIL"):
        if c not in piv.columns:
            piv[c] = 0.0
    piv = piv.rename(columns={"FOREIGN": "f", "INSTITUTION": "i", "RETAIL": "r"}).sort_index()
    piv[["f", "i", "r"]] = piv[["f", "i", "r"]].fillna(0.0).astype(float)
    for col, base in (("f5", "f"), ("f20", "f"), ("f60", "f"), ("f120", "f"),
                      ("i5", "i"), ("i20", "i"), ("i60", "i"), ("i120", "i"), ("r5", "r")):
        n = int("".join(ch for ch in col if ch.isdigit()))
        piv[col] = piv[base].rolling(n, min_periods=1).sum()
    # 부호 연속일 run-length (runtime f_buy_streak/f_sell_streak과 동일: 최근일부터 같은 부호 연속)
    fv = piv["f"].to_numpy()
    pos = np.zeros(len(fv), dtype=int)
    neg = np.zeros(len(fv), dtype=int)
    for k in range(len(fv)):
        if fv[k] > 0:
            pos[k] = (pos[k - 1] + 1) if k > 0 else 1
        elif fv[k] < 0:
            neg[k] = (neg[k - 1] + 1) if k > 0 else 1
    piv["buy_streak"] = pos
    piv["sell_streak"] = neg

    # OHLCV 파생 (ohlcv 거래일 축): adv20/tv5 + 5·20거래일 전 수정종가
    for c in ("adj_open", "adj_close", "close_price", "tv"):
        oh_df[c] = pd.to_numeric(oh_df[c], errors="coerce")
    oh_df = oh_df.sort_values("d")
    oh_df["adv20"] = oh_df["tv"].rolling(20, min_periods=1).mean()
    oh_df["tv5"] = oh_df["tv"].rolling(5, min_periods=1).sum()
    oh_df["adj_5d_ago"] = oh_df["adj_close"].shift(5)
    oh_df["adj_20d_ago"] = oh_df["adj_close"].shift(20)
    oh_df = oh_df.set_index("d")

    # 투자자축 ⋈ ohlcv축 (inner — runtime flow JOIN px와 동일: 둘 다 있어야 지표 성립)
    final = piv.join(
        oh_df[["adj_open", "adj_close", "close_price", "tv", "adv20", "tv5", "adj_5d_ago", "adj_20d_ago"]],
        how="inner",
    ).sort_index()
    if final.empty:
        return None
    final = final.reset_index().rename(columns={final.index.name or "index": "d"})
    if "d" not in final.columns:  # reset_index 컬럼명 방어
        final = final.rename(columns={final.columns[0]: "d"})
    final["dt"] = pd.to_datetime(final["d"])

    # as-of 시총 (14일 tolerance) + 유통주식수/총주식수 (backward, 최근 유효값)
    mc_df = pd.DataFrame(mc, columns=["d", "market_cap"])
    mc_df["market_cap"] = pd.to_numeric(mc_df["market_cap"], errors="coerce")
    mc_df = mc_df.dropna(subset=["market_cap"]).assign(dt=lambda x: pd.to_datetime(x["d"])).sort_values("dt")
    if not mc_df.empty:
        final = pd.merge_asof(final.sort_values("dt"), mc_df[["dt", "market_cap"]],
                              on="dt", direction="backward", tolerance=pd.Timedelta("14D"))
    else:
        final["market_cap"] = np.nan

    fs_df = pd.DataFrame(fs, columns=["d", "floating_shares", "total_shares"])
    if not fs_df.empty:
        fs_df["floating_shares"] = pd.to_numeric(fs_df["floating_shares"], errors="coerce")
        fs_df["total_shares"] = pd.to_numeric(fs_df["total_shares"], errors="coerce")
        fs_df = fs_df.assign(dt=lambda x: pd.to_datetime(x["d"])).sort_values("dt").rename(columns={"d": "float_date"})
        final = pd.merge_asof(final.sort_values("dt"), fs_df[["dt", "floating_shares", "total_shares", "float_date"]],
                              on="dt", direction="backward")
    else:
        final["floating_shares"] = np.nan
        final["total_shares"] = np.nan
        final["float_date"] = None

    final = final.sort_values("dt").reset_index(drop=True)

    name = getattr(nm, "stock_name", None)
    market = getattr(nm, "market", None)
    sector = getattr(nm, "fics_sector", None)

    def _v(x):  # NaN/None → None (그 외 float)
        return None if x is None or (isinstance(x, float) and math.isnan(x)) else x

    out_dates: list[str] = []
    out_open: list[float] = []
    out_patterns: list[list[str]] = []
    for row in final.itertuples(index=False):
        r = SimpleNamespace(
            stock_code=code, stock_name=name, market=market, fics_sector=sector,
            market_cap=_v(row.market_cap),
            floating_shares=_v(row.floating_shares),
            total_shares=_v(row.total_shares),
            float_date=row.float_date if isinstance(row.float_date, str) else None,
            close_raw=_v(row.close_price) or 0,
            adj_now=_v(row.adj_close),
            adj_5d_ago=_v(row.adj_5d_ago),
            adj_20d_ago=_v(row.adj_20d_ago),
            tv_5d=_v(row.tv5),
            adv_20d=_v(row.adv20),
            f_1d=row.f, i_1d=row.i,
            f_5d=row.f5, f_20d=row.f20, f_60d=row.f60, f_120d=row.f120,
            i_5d=row.i5, i_20d=row.i20, i_60d=row.i60, i_120d=row.i120, r_5d=row.r5,
            f_buy_streak=int(row.buy_streak), f_sell_streak=int(row.sell_streak),
        )
        m = fm._row_to_metrics(r)  # 정본 지표 (분모·bp·부호 게이트 전부 여기서)
        out_dates.append(row.d)
        out_open.append(_v(row.adj_open))
        out_patterns.append(flow_verdict.applicable_patterns(m) if m is not None else [])

    return pd.DataFrame({"d": out_dates, "adj_open": out_open, "patterns": out_patterns})


# ── 에피소드 추출 + 성과 ──────────────────────────────────────────────────
def _finite(x) -> bool:
    return x is not None and isinstance(x, (int, float)) and math.isfinite(x)


def _extract(mdf: pd.DataFrame, uidx_map: dict | None, report_from: date) -> dict:
    """일별 멤버십 → 패턴별 에피소드(onset~소멸) + h20/60/120 초과수익. 최신순."""
    dates = mdf["d"].tolist()
    opens = mdf["adj_open"].tolist()
    memb = mdf["patterns"].tolist()
    n = len(dates)
    uidx = [uidx_map.get(dates[k]) if uidx_map else None for k in range(n)]
    bench = uidx_map is not None
    rf = report_from.isoformat()

    names: list[str] = []
    for lst in memb:
        for nm in lst:
            if nm not in names:
                names.append(nm)

    def horizon(ep: int, entry_px: float, entry_uidx, h: int):
        xp = ep + h
        if xp >= n or not _finite(opens[xp]):
            return None
        stock = opens[xp] / entry_px - 1
        excess = None
        if bench and _finite(entry_uidx) and _finite(uidx[xp]):
            excess = stock - (uidx[xp] / entry_uidx - 1)
        return {"stock_pct": round(stock * 100, 1),
                "excess_pct": round(excess * 100, 1) if excess is not None else None}

    result: dict = {}
    for name in names:
        member = [name in memb[k] for k in range(n)]
        episodes: list[dict] = []
        for k in range(n):
            if not member[k] or (k > 0 and member[k - 1]):
                continue  # onset = 전일 미보유 → 당일 보유
            if dates[k] < rf:
                continue  # 워밍업 구간 onset은 보고 안 함 (창 미성숙·벤치 미커버)
            j = k + 1
            while j < n and member[j]:
                j += 1
            duration = j - k
            ongoing = j == n
            ep = k + 1  # D+1 진입
            if ep >= n or not _finite(opens[ep]) or opens[ep] <= 0:
                continue
            entry_px = opens[ep]
            entry_uidx = uidx[ep]
            hs = {h: horizon(ep, entry_px, entry_uidx, h) for h in _HORIZONS}
            partial = None
            if hs[_HORIZONS[-1]] is None:  # 최장 지평 미성숙 → 마지막 가용일 partial
                li = n - 1
                while li > ep and not _finite(opens[li]):
                    li -= 1
                if li > ep:
                    stock = opens[li] / entry_px - 1
                    excess = None
                    if bench and _finite(entry_uidx) and _finite(uidx[li]):
                        excess = stock - (uidx[li] / entry_uidx - 1)
                    partial = {"days": li - ep, "stock_pct": round(stock * 100, 1),
                               "excess_pct": round(excess * 100, 1) if excess is not None else None}
            episodes.append({
                "onset": dates[k],
                "duration_days": duration,
                "entry_date": dates[ep],
                "entry_price": round(entry_px, 1),
                "h20": hs[20], "h60": hs[60], "h120": hs[120],
                "ongoing": ongoing,
                "partial": partial,
            })
        if not episodes:
            continue
        episodes.reverse()  # 최신순
        ex60 = [e["h60"]["excess_pct"] for e in episodes if e["h60"] and e["h60"]["excess_pct"] is not None]
        result[name] = {
            "episodes": episodes,
            "stats": {
                "count": len(episodes),
                "avg_excess_h60": round(sum(ex60) / len(ex60), 1) if ex60 else None,
                "win_rate_h60": round(sum(1 for x in ex60 if x > 0) / len(ex60), 3) if ex60 else None,
            },
        }
    return result


# ── 메인 엔트리 ────────────────────────────────────────────────────────────
async def episodes(code: str) -> dict | None:
    """종목 태그 에피소드 히스토리. 데이터 없으면 None (라우터가 404)."""
    version = await fm.data_version()
    uidx_map, period, gen = _load_benchmark()
    key = (version, "episodes", code, gen)
    cached = fm._result_cache.get(key)
    if cached is not None:
        return cached  # type: ignore[return-value]

    info = await fm.resolve_as_of()
    as_of = info.as_of
    if period and period.get("start"):
        report_from = date.fromisoformat(period["start"])
    else:
        report_from = date.fromisoformat(as_of) - timedelta(days=_DEFAULT_WINDOW_DAYS)
    load_start = report_from - timedelta(days=_WARMUP_DAYS)

    panel = await _load_panel(code, load_start, date.fromisoformat(as_of))
    mdf = _daily_membership(code, panel, panel[4])
    if mdf is None or mdf.empty:
        return None

    patterns = _extract(mdf, uidx_map, report_from)
    result = {
        "code": code,
        "as_of": as_of,
        "benchmark_available": uidx_map is not None,
        "benchmark_as_of": gen,
        "period": period,
        "patterns": patterns,
    }
    fm._result_cache[key] = result
    return result
