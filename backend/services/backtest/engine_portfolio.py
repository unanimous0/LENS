"""포트폴리오 시뮬레이션 엔진 — backtest.md §5 C2.

이벤트 스터디(자본 무제약 onset 전부)에 자본 제약을 얹는다:
  - max_positions 슬롯, equal weight, 리밸런스 없음(청산 자본은 다음 진입에 재사용).
  - 신호 초과 시 rank_by 내림차순으로 슬롯을 채움(동일 종목 중복 보유 금지).
    rank_by=None이면 코드순 결정적 타이브레이크. 슬롯 부족으로 못 잡은 onset = 미체결 신호.
  - 체결/청산 규칙·레일은 C1과 동일(에피소드 후보를 그대로 재사용 — 청산은 자본과 무관).

**자본 모델 = N 슬리브(sub-account).** 각 슬리브는 1/N로 시작, 비면 당일 onset을 담아
슬리브 전액을 투자, 청산 시 실현액이 그 슬리브의 새 현금이 되어 다음 진입에 재사용된다
(리밸런스 없음 = 슬리브 독립). 일별 에쿼티 = Σ(현금 슬리브) + Σ(투자 슬리브 시가평가).
비용은 진입·청산 각각 (1−cost_bps)로 곱(왕복 ≈ C1의 2×cost_bps).

에쿼티 커브 시작 t0 = 첫 진입일(자본 배치 시작). 벤치마크도 t0에서 1.0 정규화 → 동일 창 비교.
시가평가는 adj_close, 청산은 exit_px(에피소드 규약). CAGR/MDD/샤프/회전율/연도표는 커브에서 산출.
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

from . import engine
from .schema import Strategy

_TRADING_DAYS = 252.0


def run_portfolio(panel: dict, spec: Strategy, progress_cb=None) -> dict:
    """이벤트 스터디 결과 + portfolio 블록."""
    ctx = engine._prepare(panel, spec, progress_cb)
    episodes = engine._run_episodes(ctx, spec, progress_cb)  # prog→90

    # 이벤트 스터디 산출(자본 무제약) — 방향/edge 측정용.
    result = engine._summarize(engine._public(episodes), spec, panel,
                               ctx["uni"] & ctx["in_period"], ctx["df"])
    result["mode"] = "portfolio"

    result["portfolio"] = _simulate(ctx, episodes, spec, panel)
    if progress_cb:
        progress_cb(100)
    return result


def _simulate(ctx: dict, episodes: list[dict], spec: Strategy, panel: dict) -> dict:
    df = ctx["df"]
    dates = ctx["times"]                      # df 행별 날짜 (np.datetime64)
    close_arr = df["adj_close"].to_numpy(dtype=float)
    col_map = ctx["col_map"]
    N = spec.portfolio.max_positions
    cost = spec.execution.cost_bps / 1e4      # 편도

    if not episodes:
        return _empty_portfolio(spec)

    # 전역 거래일 축 D + 날짜→인덱스
    D = np.unique(dates)
    nD = len(D)
    end_ts = ctx["end_ts"]
    end_di = int(np.searchsorted(D, end_ts, side="right")) - 1 if end_ts is not None else nD - 1
    if end_di < 0:
        return _empty_portfolio(spec)

    # rank_by 값 (onset 시점, 내림차순 우선). None이면 0(코드순 타이브레이크만).
    rank_col = None
    if spec.portfolio.rank_by and spec.portfolio.rank_by in col_map:
        rank_col_name = col_map[spec.portfolio.rank_by]
        rank_col = pd.to_numeric(df[rank_col_name], errors="coerce").to_numpy(dtype=float)

    # 각 에피소드 → 진입/청산 전역 date 인덱스 + 가격 경로(전역 di → price) + 왕복 배수.
    cand = []  # dict per episode
    for e in episodes:
        eg, xg = e["_entry_g"], e["_exit_g"]
        entry_di = int(np.searchsorted(D, dates[eg]))
        exit_di = int(np.searchsorted(D, dates[xg]))
        if entry_di > end_di:
            continue  # period 밖 진입(있을 수 없지만 방어)
        exit_di = min(exit_di, end_di)   # end 넘어가면 end에서 마감(ongoing MTM)
        # 가격 경로: 종목의 entry_g..xg 연속 행 → (전역 di, adj_close)
        seg_dates = dates[eg:xg + 1]
        seg_close = close_arr[eg:xg + 1]
        seg_di = np.searchsorted(D, seg_dates)
        price_by_di = {int(d): float(p) for d, p in zip(seg_di, seg_close)
                       if np.isfinite(p) and p > 0}
        entry_px = e["_entry_px"]
        # 왕복 배수: 진입비용 → 시가 → 청산비용. exit는 exit_px로 실현.
        round_factor = (1.0 - cost) * (e["_exit_px"] / entry_px) * (1.0 - cost)
        rv = float(rank_col[e["_onset_g"]]) if rank_col is not None else 0.0
        if not math.isfinite(rv):
            rv = -math.inf   # NaN rank_by → 최하위 우선순위
        cand.append({
            "stock": e["stock"], "entry_di": entry_di, "exit_di": exit_di,
            "entry_px": entry_px, "price_by_di": price_by_di,
            "round_factor": round_factor, "rank": rv,
            "exit_at_close": bool(e.get("_exit_at_close", False)),
        })

    if not cand:
        return _empty_portfolio(spec)

    t0_di = min(c["entry_di"] for c in cand)

    # 진입일별 후보 버킷 (rank desc, code asc 결정적 정렬)
    by_entry: dict[int, list] = {}
    for c in cand:
        by_entry.setdefault(c["entry_di"], []).append(c)
    for di in by_entry:
        by_entry[di].sort(key=lambda c: (-c["rank"], c["stock"]))

    # 청산일별 슬리브 회수 인덱스 (슬리브 번호는 런타임 배정 → 실제 sim 중 처리)
    # 슬리브 상태
    sleeve_cash = [1.0 / N] * N       # 비어있을 때의 현금
    sleeve_free = [True] * N
    # 종가 실현 현금의 당일 재사용 금지 게이트: 진입은 di >= lock_di[j]일 때만 허용.
    # (시가 청산 대금은 당일 시가 진입과 동시 체결이라 무결 → lock 없음. 종가 실현 대금을
    #  당일 시가/종가 진입에 쓰면 미래 대금 사용 look-ahead → 다음 di부터 사용.)
    sleeve_lock_di = [t0_di] * N
    # 투자 중 슬리브: sleeve_pos[j] = {entry_px, committed, price_by_di, exit_di, last_price, round_factor, stock}
    sleeve_pos: list[dict | None] = [None] * N
    held_stocks: set[str] = set()

    eq_dates: list[str] = []
    eq_vals: list[float] = []
    daily_pos_count: list[int] = []
    total_entry_notional = 0.0
    entries = 0
    missed = 0
    dup_skipped = 0

    def _realize(j: int, di: int) -> None:
        p = sleeve_pos[j]
        sleeve_cash[j] = p["committed"] * p["round_factor"]
        held_stocks.discard(p["stock"])
        sleeve_pos[j] = None
        sleeve_free[j] = True
        # 종가 체결 실현분은 다음 di부터 진입 가능 (에쿼티에는 당일부터 현금으로 반영).
        sleeve_lock_di[j] = di + 1 if p["exit_at_close"] else di

    for di in range(t0_di, end_di + 1):
        # 1) 청산 (전일까지 진입분 중 당일 exit_di 도달 → 슬롯 반환, 시가 실현분만 당일 재사용)
        for j in range(N):
            p = sleeve_pos[j]
            if p is not None and p["exit_di"] == di:
                _realize(j, di)

        # 2) 진입 (빈 슬롯에 당일 후보를 rank순으로)
        bucket = by_entry.get(di)
        if bucket:
            for c in bucket:
                if c["stock"] in held_stocks:
                    dup_skipped += 1
                    continue
                # 빈 슬롯 찾기 (종가 실현 잠금 중인 슬리브 제외)
                j = next((k for k in range(N) if sleeve_free[k] and sleeve_lock_di[k] <= di), None)
                if j is None:
                    missed += 1
                    continue
                committed = sleeve_cash[j]
                sleeve_free[j] = False
                sleeve_pos[j] = {
                    "entry_px": c["entry_px"], "committed": committed,
                    "price_by_di": c["price_by_di"], "exit_di": c["exit_di"],
                    "last_price": c["entry_px"], "round_factor": c["round_factor"],
                    "stock": c["stock"], "exit_at_close": c["exit_at_close"],
                }
                held_stocks.add(c["stock"])
                total_entry_notional += committed
                entries += 1

        # 2.5) 당일 진입=청산(0일 보유, same_close 등) 즉시 실현 — 슬롯 영구 점유 방지.
        #      round_factor(진입·청산비용 포함)로 현금화. 종가 실현이라 다음 di부터 재사용.
        for j in range(N):
            p = sleeve_pos[j]
            if p is not None and p["exit_di"] == di:
                _realize(j, di)

        # 3) 시가평가 (당일 에쿼티)
        equity = 0.0
        held = 0
        for j in range(N):
            p = sleeve_pos[j]
            if p is None:
                equity += sleeve_cash[j]
            else:
                price = p["price_by_di"].get(di)
                if price is not None:
                    p["last_price"] = price
                # 진입비용 반영 후 시가/진입가 비율 (청산비용은 실현 시).
                equity += p["committed"] * (1.0 - cost) * (p["last_price"] / p["entry_px"])
                held += 1
        eq_dates.append(pd.Timestamp(D[di]).date().isoformat())
        eq_vals.append(equity)
        daily_pos_count.append(held)

    # ── 벤치마크 커브 (t0에서 1.0 정규화) ──
    bmap = ctx["bmap"]
    bench_vals: list[float | None] | None = None
    if ctx["use_bench"] and bmap:
        raw = []
        last = None
        for di in range(t0_di, end_di + 1):
            v = bmap.get(pd.Timestamp(D[di]))
            if v is not None and math.isfinite(v):
                last = v
            raw.append(last)
        base = next((x for x in raw if x), None)
        if base:
            bench_vals = [round(x / base, 6) if x else None for x in raw]

    stats = _stats(eq_dates, eq_vals, bench_vals, daily_pos_count,
                   total_entry_notional, D, t0_di, end_di)
    stats.update({
        "n_slots": N,
        # 실제 시뮬 대상 후보 수 — entered+missed+dup와 항상 일치(항등 보증).
        "n_candidate_signals": len(cand),
        "n_entered": entries,
        "missed_signals": missed,
        "dup_skipped": dup_skipped,
        "rank_by": spec.portfolio.rank_by,
    })

    curve = [{"date": d, "equity": round(v, 6)} for d, v in zip(eq_dates, eq_vals)]
    if bench_vals is not None:
        for pt, bv in zip(curve, bench_vals):
            pt["benchmark"] = bv

    return {**stats, "equity_curve": curve}


def _stats(eq_dates, eq_vals, bench_vals, pos_count, total_entry_notional, D, t0_di, end_di) -> dict:
    eq = np.asarray(eq_vals, dtype=float)
    n = len(eq)
    final_equity = float(eq[-1])
    start_date = pd.Timestamp(D[t0_di]).date()
    last_date = pd.Timestamp(D[end_di]).date()
    years = max((last_date - start_date).days / 365.25, 1e-9)

    cagr = (final_equity ** (1.0 / years) - 1.0) if final_equity > 0 else None
    total_return = final_equity - 1.0

    # MDD (+ 발생 구간)
    running_max = np.maximum.accumulate(eq)
    dd = eq / running_max - 1.0
    trough_i = int(np.argmin(dd))
    mdd = float(dd[trough_i])
    peak_i = int(np.argmax(eq[:trough_i + 1])) if trough_i > 0 else 0

    # 일별 수익률 → 샤프(초과수익 연율화)
    r_s = eq[1:] / eq[:-1] - 1.0
    if bench_vals is not None:
        bv = np.array([x if x is not None else np.nan for x in bench_vals], dtype=float)
        r_b = bv[1:] / bv[:-1] - 1.0
        excess = r_s - r_b
        excess = excess[np.isfinite(excess)]
    else:
        excess = r_s[np.isfinite(r_s)]
    sharpe = None
    if len(excess) > 1 and excess.std(ddof=1) > 0:
        sharpe = float(excess.mean() / excess.std(ddof=1) * math.sqrt(_TRADING_DAYS))

    mean_equity = float(eq.mean())
    turnover = (total_entry_notional / mean_equity / years) if mean_equity > 0 else None

    # 연도별 수익 테이블 (커브에서 연말/연초 대비)
    by_year = _by_year(eq_dates, eq_vals, bench_vals)

    return {
        "start_date": start_date.isoformat(),
        "end_date": last_date.isoformat(),
        "n_days": n,
        "final_equity": round(final_equity, 6),
        "total_return_pct": round(total_return * 100, 2),
        "cagr_pct": round(cagr * 100, 2) if cagr is not None else None,
        "mdd_pct": round(mdd * 100, 2),
        "mdd_peak_date": eq_dates[peak_i],
        "mdd_trough_date": eq_dates[trough_i],
        "sharpe": round(sharpe, 2) if sharpe is not None else None,
        "annual_turnover": round(turnover, 2) if turnover is not None else None,
        "avg_positions": round(float(np.mean(pos_count)), 1) if pos_count else 0.0,
        "by_year": by_year,
    }


def _by_year(eq_dates, eq_vals, bench_vals) -> list[dict]:
    """연도별 전략/벤치마크/초과 수익 — 각 연도 마지막 값 / 직전 연도 마지막(첫 해는 1.0/기준) 대비.

    벤치 연말값이 None(결측)이면 그 연도 내 마지막 유효값으로 이월(forward-fill) —
    prev_bench가 항상 최신 유효값을 물고 가서 다음 해 수익률이 2개 연도를 관통하지 않게.
    """
    years = sorted({d[:4] for d in eq_dates})
    # 연도별 마지막 인덱스
    last_idx: dict[str, int] = {}
    for i, d in enumerate(eq_dates):
        last_idx[d[:4]] = i
    # 벤치 forward-fill (결측 gap 이월)
    ff_bench = None
    if bench_vals is not None:
        ff_bench = []
        last = None
        for v in bench_vals:
            if v is not None:
                last = v
            ff_bench.append(last)
    out = []
    prev_eq = 1.0
    prev_bench = 1.0 if bench_vals is not None else None
    for y in years:
        i = last_idx[y]
        cur_eq = eq_vals[i]
        strat_ret = cur_eq / prev_eq - 1.0
        row = {"year": y, "strategy_pct": round(strat_ret * 100, 2)}
        if ff_bench is not None:
            cur_b = ff_bench[i]
            if cur_b is not None and prev_bench:
                bench_ret = cur_b / prev_bench - 1.0
                row["benchmark_pct"] = round(bench_ret * 100, 2)
                row["excess_pct"] = round((strat_ret - bench_ret) * 100, 2)
                prev_bench = cur_b
            else:
                row["benchmark_pct"] = None
                row["excess_pct"] = None
        out.append(row)
        prev_eq = cur_eq
    return out


def _empty_portfolio(spec: Strategy) -> dict:
    return {
        "n_slots": spec.portfolio.max_positions,
        "n_candidate_signals": 0, "n_entered": 0, "missed_signals": 0, "dup_skipped": 0,
        "rank_by": spec.portfolio.rank_by,
        "start_date": None, "end_date": None, "n_days": 0,
        "final_equity": 1.0, "total_return_pct": 0.0, "cagr_pct": None,
        "mdd_pct": 0.0, "mdd_peak_date": None, "mdd_trough_date": None,
        "sharpe": None, "annual_turnover": None, "avg_positions": 0.0,
        "by_year": [], "equity_curve": [],
    }
