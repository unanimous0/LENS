"""이벤트 스터디 엔진 — backtest.md §5 (C1).

진입 조건 **onset**(전일 False→당일 True, 유니버스 내)마다 에피소드 생성 → 청산 규칙 중
먼저 발동(whichever-first)하는 시점에 청산 → 에피소드별 수익/초과수익.

엔진이 고정하는 레일 (사용자 선택 불가):
  - 신호는 D 종가 데이터로만 (모든 패널 지표가 trailing — 어댑터에서 shift 방향 보장).
  - 진입/청산은 execution.entry_fill/exit_fill 가격. same_close는 look-ahead 경고 배지.
  - 손절/익절은 **종가 기준 판정 후 다음날 체결** (장중 low 터치 금지 — LP_MM 부검).
  - 벤치마크(universe_avg)는 엔진 유니버스의 adj_open 로그수익 평균 기하 누적(Blume-Stambaugh).

flow_exit_backtest.py의 onset 에피소드 시뮬을 임의 조건·청산으로 일반화한 것.
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

from .adapters import field_column_map
from .schema import Condition, Group, Strategy

_FOOTNOTES = {
    "survivorship": "생존편향: 상장폐지 종목이 유니버스에 없어 수익률이 낙관 편향된다(구조적 한계).",
    "overlap": "에피소드 중첩: 같은 종목 연속 onset·동시 다종목으로 t값이 팽창 — 보수적으로 해석.",
    "same_close": "same_close 체결: D일 데이터로 D일 종가에 매수한다는 낙관 가정 — 실현 불가능할 수 있음(look-ahead).",
}


# ── 조건 → boolean ndarray ─────────────────────────────────────────────────
def _eval_condition(df: pd.DataFrame, col_map: dict, c: Condition) -> np.ndarray:
    col = col_map[c.field]
    s = df[col]
    if c.op == "is_true":
        return s.fillna(False).to_numpy(dtype=bool)
    if c.op == "is_false":
        return (~s.fillna(False).astype(bool)).to_numpy()
    left = pd.to_numeric(s, errors="coerce").to_numpy(dtype=float)
    if c.ref is not None:
        right = pd.to_numeric(df[col_map[c.ref]], errors="coerce").to_numpy(dtype=float) * c.mult
        right_nan = np.isnan(right)
    else:
        right = float(c.value)
        right_nan = None
    with np.errstate(invalid="ignore"):
        if c.op == ">":
            res = left > right
        elif c.op == ">=":
            res = left >= right
        elif c.op == "<":
            res = left < right
        elif c.op == "<=":
            res = left <= right
        else:  # "=="
            res = left == right
    res = np.asarray(res, dtype=bool)
    res &= ~np.isnan(left)          # NaN 좌변 → False (신호 안 냄)
    if right_nan is not None:
        res &= ~right_nan
    return res


def _eval_group(df: pd.DataFrame, col_map: dict, g: Group) -> np.ndarray:
    items = g.all if g.all is not None else g.any
    arrs = [
        _eval_group(df, col_map, it) if isinstance(it, Group) else _eval_condition(df, col_map, it)
        for it in items
    ]
    stacked = np.vstack(arrs)
    return stacked.all(axis=0) if g.all is not None else stacked.any(axis=0)


# ── 벤치마크 (유니버스 adj_open 로그수익 기하 누적) ─────────────────────────
def _build_uidx(df: pd.DataFrame, uni: np.ndarray) -> dict:
    # float32 패널 → 로그 누적 오차 방지 위해 float64로 승격 후 계산.
    ret = df.groupby("stock", sort=False)["adj_open"].transform(
        lambda s: s.astype("float64") / s.astype("float64").shift(1) - 1).to_numpy()
    m = uni & np.isfinite(ret) & (ret > -0.99)
    if not m.any():
        return {}
    tmp = pd.DataFrame({"time": df["time"].to_numpy()[m], "lr": np.log1p(ret[m])})
    lr = tmp.groupby("time")["lr"].mean().sort_index()
    uidx = np.exp(lr.cumsum())
    uidx = uidx / uidx.iloc[0]
    return {pd.Timestamp(t): float(v) for t, v in uidx.items()}


# ── 메인 ───────────────────────────────────────────────────────────────────
def run_event_study(panel: dict, spec: Strategy, progress_cb=None, _signal_shift: int = 0) -> dict:
    """spec을 패널에 적용해 이벤트 스터디 결과 dict 반환.

    _signal_shift: 검증(look-ahead 스모크) 전용 — onset을 종목 내 n칸 이동. 프로덕션 경로는 0.
    """
    def prog(p):
        if progress_cb:
            progress_cb(p)

    df: pd.DataFrame = panel["df"]  # 전체 패널 (종목·시간 정렬·연속 인덱스)
    col_map = field_column_map()

    # 1) 기간 마스크 — 패널을 **슬라이스하지 않는다**. 슬라이스하면 첫날 prev=False라
    #    이미 신호 중인 종목이 전부 경계 onset으로 잡힌다(인플레이션). 신호/onset은 전체
    #    범위에서 계산한 뒤 onset 날짜만 period로 필터 → 진짜 onset만 남는다.
    #    청산 스캔은 period end까지로 제한 (에피소드 루프의 L_eff).
    start = spec.period.start
    end = spec.period.end
    times = df["time"].to_numpy()
    in_period = np.ones(len(df), dtype=bool)
    if start is not None:
        in_period &= times >= np.datetime64(pd.Timestamp(start))
    end_ts = np.datetime64(pd.Timestamp(end)) if end is not None else None
    if end_ts is not None:
        in_period &= times <= end_ts
    prog(62)

    # 2) 유니버스 (일별 마스크)
    markets = set(spec.universe.markets)
    in_mkt = df["market"].isin(markets).to_numpy()
    adv = pd.to_numeric(df["adv_20d"], errors="coerce").to_numpy(dtype=float)
    mcap = pd.to_numeric(df["mcap"], errors="coerce").to_numpy(dtype=float)
    uni = in_mkt & (adv >= spec.universe.min_adv_eok) & (mcap >= spec.universe.min_mcap_eok)
    uni &= ~np.isnan(adv) & ~np.isnan(mcap)

    # 3) entry 조건 → onset (전일 False→당일 True, 유니버스 내)
    cond = _eval_group(df, col_map, spec.entry)
    signal = cond & uni
    df["__sig"] = signal
    prev = df.groupby("stock", sort=False)["__sig"].shift(1, fill_value=False).to_numpy()
    onset = signal & (~prev)
    if _signal_shift:
        # 종목 내 onset을 앞으로 당김(미래 신호를 오늘 아는 척) — look-ahead 스모크 전용.
        onset = df.groupby("stock", sort=False)["__sig"].shift(_signal_shift, fill_value=False).to_numpy() & uni
        pv = pd.Series(onset).groupby(df["stock"].to_numpy()).shift(1, fill_value=False).to_numpy()
        onset = onset & (~pv)
    onset &= in_period  # 진짜 onset 중 period 안에 있는 것만 (경계 onset 인플레이션 방지)
    prog(70)

    # 4) 벤치마크
    use_bench = spec.benchmark == "universe_avg"
    uidx = _build_uidx(df, uni) if use_bench else {}

    # 5) 에피소드 시뮬 (종목별 연속 배열)
    open_arr = df["adj_open"].to_numpy(dtype=float)
    close_arr = df["adj_close"].to_numpy(dtype=float)
    dates = df["time"].to_numpy()

    exec_ = spec.execution
    entry_fill, exit_fill = exec_.entry_fill, exec_.exit_fill
    cost = 2.0 * exec_.cost_bps / 1e4  # 왕복

    # 청산 규칙 준비
    fixed_days = None
    cond_rules = []   # (rule_index, cond_array)
    stops = []        # (rule_index, threshold_frac)  stop_loss
    takes = []        # (rule_index, threshold_frac)  take_profit
    for ri, rule in enumerate(spec.exit.rules):
        if rule.type == "fixed_holding":
            fixed_days = rule.days if fixed_days is None else min(fixed_days, rule.days)
        elif rule.type == "condition":
            grp = Group(all=rule.all, any=rule.any)
            cond_rules.append((ri, _eval_group(df, col_map, grp)))
        elif rule.type == "stop_loss_pct":
            stops.append((ri, rule.value / 100.0))
        elif rule.type == "take_profit_pct":
            takes.append((ri, rule.value / 100.0))

    group_idx = df.groupby("stock", sort=False).indices  # stock -> positional ndarray (연속·오름차순)

    episodes: list[dict] = []
    for stock, pos in group_idx.items():
        L = len(pos)
        o_open = open_arr[pos]
        o_close = close_arr[pos]
        o_dates = dates[pos]
        onset_local = np.nonzero(onset[pos])[0]
        if onset_local.size == 0:
            continue
        # period end까지만 시뮬 (end 이후 데이터는 없는 것으로 취급 — 미청산은 ongoing)
        L_eff = int(np.searchsorted(o_dates, end_ts, side="right")) if end_ts is not None else L
        cond_local = [(ri, arr[pos]) for ri, arr in cond_rules]
        for i in onset_local:
            # 진입 체결
            if entry_fill == "same_close":
                eb, entry_px = i, o_close[i]
            elif entry_fill == "next_close":
                eb, entry_px = i + 1, (o_close[i + 1] if i + 1 < L_eff else np.nan)
            else:  # next_open
                eb, entry_px = i + 1, (o_open[i + 1] if i + 1 < L_eff else np.nan)
            if eb >= L_eff or not np.isfinite(entry_px) or entry_px <= 0:
                continue

            # 각 규칙의 결정일 k (local index) — fixed가 있으면 스캔 상한 축소
            candidates: list[tuple[int, int, str]] = []
            scan_hi = L_eff - 1
            if fixed_days is not None:
                k_fixed = eb + fixed_days - 1
                candidates.append((k_fixed, -1, "fixed_holding"))
                scan_hi = min(scan_hi, k_fixed)
            if scan_hi >= eb:
                seg_close = o_close[eb:scan_hi + 1]
                seg_ret = seg_close / entry_px - 1.0
                for ri, thr in stops:
                    hit = np.nonzero(np.isfinite(seg_ret) & (seg_ret <= thr))[0]
                    if hit.size:
                        candidates.append((eb + int(hit[0]), ri, "stop_loss_pct"))
                for ri, thr in takes:
                    hit = np.nonzero(np.isfinite(seg_ret) & (seg_ret >= thr))[0]
                    if hit.size:
                        candidates.append((eb + int(hit[0]), ri, "take_profit_pct"))
                for ri, arr in cond_local:
                    hit = np.nonzero(arr[eb:scan_hi + 1])[0]
                    if hit.size:
                        candidates.append((eb + int(hit[0]), ri, "condition"))
            if not candidates:
                continue
            k, _ri, reason = min(candidates, key=lambda c: (c[0], c[1]))

            # 청산 체결
            ongoing = False
            if reason in ("stop_loss_pct", "take_profit_pct"):
                # 종가 판정 후 다음날 체결 (same_close는 next_open으로 폴백)
                xb = k + 1
                exit_px = (o_close[xb] if exit_fill == "next_close" else o_open[xb]) if xb < L_eff else np.nan
            else:  # fixed_holding / condition
                if exit_fill == "same_close":
                    xb = k
                    exit_px = o_close[xb] if xb < L_eff else np.nan
                elif exit_fill == "next_close":
                    xb = k + 1
                    exit_px = o_close[xb] if xb < L_eff else np.nan
                else:  # next_open
                    xb = k + 1
                    exit_px = o_open[xb] if xb < L_eff else np.nan

            if xb >= L_eff or not np.isfinite(exit_px) or exit_px <= 0:
                # 데이터(또는 period) 끝까지 미청산 → 마지막 유효 종가로 partial 표시
                li = L_eff - 1
                while li > eb and not (np.isfinite(o_close[li]) and o_close[li] > 0):
                    li -= 1
                if li <= eb:
                    continue
                xb, exit_px, ongoing, reason = li, o_close[li], True, "ongoing"

            net = exit_px / entry_px - 1.0 - cost
            excess = None
            if use_bench and uidx:
                eu = uidx.get(pd.Timestamp(o_dates[eb]))
                xu = uidx.get(pd.Timestamp(o_dates[xb]))
                if eu is not None and xu is not None and eu > 0:
                    excess = net - (xu / eu - 1.0)
            elif not use_bench:
                excess = net  # benchmark=none → 초과=절대수익

            episodes.append({
                "stock": stock,
                "onset_date": pd.Timestamp(o_dates[i]).date().isoformat(),
                "entry_date": pd.Timestamp(o_dates[eb]).date().isoformat(),
                "exit_date": pd.Timestamp(o_dates[xb]).date().isoformat(),
                "exit_reason": reason,
                "holding_days": int(xb - eb),
                "ret_pct": round(net * 100, 2),
                "excess_pct": round(excess * 100, 2) if excess is not None else None,
                "ongoing": ongoing,
            })
    prog(90)

    result = _summarize(episodes, spec, panel, uni & in_period, df)
    prog(100)
    return result


def _summarize(episodes, spec, panel, uni, df) -> dict:
    ex = np.array([e["excess_pct"] for e in episodes if e["excess_pct"] is not None], dtype=float)
    n = len(episodes)
    n_ex = len(ex)

    reason_counts: dict[str, int] = {}
    for e in episodes:
        reason_counts[e["exit_reason"]] = reason_counts.get(e["exit_reason"], 0) + 1

    by_year: dict[str, list] = {}
    by_month: dict[str, list] = {}
    for e in episodes:
        if e["excess_pct"] is None:
            continue
        y = e["entry_date"][:4]
        ym = e["entry_date"][:7]
        by_year.setdefault(y, []).append(e["excess_pct"])
        by_month.setdefault(ym, []).append(e["excess_pct"])

    def _mean(a):
        return round(float(np.mean(a)), 2) if len(a) else None

    t_val = None
    if n_ex > 1 and ex.std(ddof=1) > 0:
        t_val = round(float(ex.mean() / (ex.std(ddof=1) / math.sqrt(n_ex))), 2)

    summary = {
        "n_episodes": n,
        "n_with_excess": n_ex,
        "avg_excess_pct": _mean(ex),
        "median_excess_pct": round(float(np.median(ex)), 2) if n_ex else None,
        "avg_return_pct": round(float(np.mean([e["ret_pct"] for e in episodes])), 2) if n else None,
        "win_rate": round(float(np.mean(ex > 0)), 3) if n_ex else None,
        "t_value": t_val,
        "avg_holding_days": round(float(np.mean([e["holding_days"] for e in episodes])), 1) if n else None,
        "exit_reason_breakdown": reason_counts,
        "by_year_avg_excess": {y: _mean(v) for y, v in sorted(by_year.items())},
        "by_month_avg_excess": {m: _mean(v) for m, v in sorted(by_month.items())},
    }

    warnings = [_FOOTNOTES["survivorship"], _FOOTNOTES["overlap"]]
    if n < 30:
        warnings.insert(0, f"표본 부족: 에피소드 {n}개 < 30 — 결과 신뢰 제한적.")
    # 진입뿐 아니라 청산도 same_close면 같은 낙관 가정 (D 데이터로 D 종가 체결)
    lookahead = "same_close" in (spec.execution.entry_fill, spec.execution.exit_fill)
    if lookahead:
        warnings.insert(0, _FOOTNOTES["same_close"])

    n_uni_stocks = int(df.loc[uni, "stock"].nunique()) if uni.any() else 0
    meta = {
        "panel_versions": panel["versions"],
        "panel_meta": panel["meta"],
        "period": {
            "start": (spec.period.start.isoformat() if spec.period.start else panel["meta"]["period"]["start"]),
            "end": (spec.period.end.isoformat() if spec.period.end else panel["meta"]["period"]["end"]),
        },
        "universe": {
            "markets": spec.universe.markets,
            "min_adv_eok": spec.universe.min_adv_eok,
            "min_mcap_eok": spec.universe.min_mcap_eok,
            "n_stocks": n_uni_stocks,
        },
        "benchmark": spec.benchmark,
        "lookahead_warning": lookahead,
    }

    return {"summary": summary, "episodes": episodes, "warnings": warnings, "meta": meta}
