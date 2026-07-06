"""이벤트 스터디 + 포트폴리오 엔진 — backtest.md §5.

진입 조건 **onset**(전일 False→당일 True, 유니버스 내)마다 에피소드 생성 → 청산 규칙 중
먼저 발동(whichever-first)하는 시점에 청산 → 에피소드별 수익/초과수익.

엔진이 고정하는 레일 (사용자 선택 불가):
  - 신호는 D 종가 데이터로만 (모든 패널 지표가 trailing — 어댑터에서 shift 방향 보장).
  - 진입/청산은 execution.entry_fill/exit_fill 가격. same_close는 look-ahead 경고 배지.
  - 손절/익절은 **종가 기준 판정 후 다음날 체결** (장중 low 터치 금지 — LP_MM 부검).
  - 벤치마크: universe_avg=엔진 유니버스 adj_open 로그수익 평균 기하 누적(Blume-Stambaugh),
    kospi/kosdaq=지수 종가(panel["indices"]). excess는 벤치마크 비율로 차감.

C2:
  - rank_pct_top/bottom: 그날 유니버스 내 지표 횡단면 percentile 상·하위 value%.
  - run_portfolio(engine_portfolio): 이벤트 스터디 산출 + 자본 제약 시뮬(에쿼티/CAGR/…).

이벤트 스터디 산출은 `run_event_study`. 포트폴리오는 `_prepare`/`_run_episodes`를 재사용하는
`engine_portfolio.run_portfolio`가 담당한다 (에피소드 후보 = 자본 무제약 onset 전부).
"""
from __future__ import annotations

import math
from datetime import date, timedelta

import numpy as np
import pandas as pd

from .adapters import field_column_map
from .schema import Condition, Group, Strategy, iter_condition_fields

_FOOTNOTES = {
    "survivorship": "생존편향: 상장폐지 종목이 유니버스에 없어 수익률이 낙관 편향된다(구조적 한계).",
    "overlap": "에피소드 중첩: 같은 종목 연속 onset·동시 다종목으로 t값이 팽창 — 보수적으로 해석.",
    "same_close": "same_close 체결: D일 데이터로 D일 종가에 매수한다는 낙관 가정 — 실현 불가능할 수 있음(look-ahead).",
}

# holdout 분할 비율 — 실효 커버리지(첫 유효 adj_open ~ 패널 끝)의 앞 75%가 train, 뒤 25%가 holdout.
_HOLDOUT_FRAC = 0.75


# ── holdout 잠금 (부검 "train/holdout 1회 개봉" 계승 — backtest.md §6) ─────────
def compute_holdout_start(panel: dict) -> date | None:
    """holdout 시작일 = 실효 커버리지(첫 유효 adj_open ~ 패널 끝)의 75% 지점(달력일).

    엔진 레일: 기본 모든 실행은 이 날짜 **직전**까지만(train-only). 저장 전략 1회 개봉 시에만
    전체 기간 측정. spec·유니버스와 무관한 패널 속성이라 patch 한 벌로 결정적.
    """
    df: pd.DataFrame = panel["df"]
    open_finite = np.isfinite(df["adj_open"].to_numpy(dtype=float))
    if not open_finite.any():
        return None
    eff_start = pd.Timestamp(df["time"].to_numpy()[open_finite].min()).date()
    try:
        end = date.fromisoformat(panel["meta"]["period"]["end"])
    except (KeyError, ValueError, TypeError):
        return None
    span = (end - eff_start).days
    if span <= 0:
        return None
    return eff_start + timedelta(days=round(span * _HOLDOUT_FRAC))


def _resolve_end(panel: dict, spec: Strategy, holdout_unlocked: bool):
    """(eff_end, holdout_start, train_only) — 실행 창 상한을 결정.

    train_only(기본)면 holdout_start 직전으로 캡. 개봉 상태면 전체 기간(user/panel end).
    period.end가 이미 train 안이면 min으로 캡이 무영향.
    """
    try:
        panel_end = date.fromisoformat(panel["meta"]["period"]["end"])
    except (KeyError, ValueError, TypeError):
        panel_end = None
    user_end = spec.period.end or panel_end
    hs = compute_holdout_start(panel)
    if holdout_unlocked or hs is None:
        return user_end, hs, False
    train_end = hs - timedelta(days=1)
    if user_end is not None:
        train_end = min(user_end, train_end)
    return train_end, hs, True


def _split_event_stats(episodes: list[dict], hs_iso: str) -> dict:
    """개봉 시 이벤트 스터디 산출을 train/holdout 구간으로 분리(각 n·평균 초과·t)."""
    def stat(sub: list[dict]) -> dict:
        ex = np.array([e["excess_pct"] for e in sub if e["excess_pct"] is not None], dtype=float)
        ne = len(ex)
        t_val = None
        if ne > 1 and ex.std(ddof=1) > 0:
            t_val = round(float(ex.mean() / (ex.std(ddof=1) / math.sqrt(ne))), 2)
        return {"n_episodes": len(sub), "n_with_excess": ne,
                "avg_excess_pct": round(float(ex.mean()), 2) if ne else None,
                "median_excess_pct": round(float(np.median(ex)), 2) if ne else None,
                "t_value": t_val}
    train = [e for e in episodes if e["entry_date"] < hs_iso]
    hold = [e for e in episodes if e["entry_date"] >= hs_iso]
    return {"train": stat(train), "holdout": stat(hold)}


def _split_portfolio_returns(curve: list[dict], hs_iso: str) -> dict | None:
    """개봉 시 포트폴리오 에쿼티 커브를 train/holdout 구간 수익률로 분리."""
    if not curve:
        return None
    b = next((i for i, p in enumerate(curve) if p["date"] >= hs_iso), None)
    start_eq = curve[0]["equity"]
    end_eq = curve[-1]["equity"]

    def seg(a_eq, b_eq, days):
        return {"return_pct": round((b_eq / a_eq - 1.0) * 100, 2) if a_eq else None, "days": days}

    if b is None:               # 전 구간 train (개봉했으나 holdout 진입 없음)
        return {"train": seg(start_eq, end_eq, len(curve)), "holdout": None}
    if b == 0:                  # 전 구간 holdout (드묾)
        return {"train": None, "holdout": seg(start_eq, end_eq, len(curve))}
    boundary_eq = curve[b - 1]["equity"]
    return {"train": seg(start_eq, boundary_eq, b),
            "holdout": seg(boundary_eq, end_eq, len(curve) - b)}


def _attach_holdout(result: dict, episodes: list[dict], hs: date | None,
                    train_only: bool, portfolio: dict | None = None) -> None:
    """result.meta.holdout 블록 + 경고 배지. train_only면 잠금 표기, 개봉이면 구간 분리 스탯."""
    if hs is None:
        return
    hs_iso = hs.isoformat()
    if train_only:
        result["meta"]["holdout"] = {"start": hs_iso, "locked": True}
        result["warnings"].insert(
            0, f"최근 구간은 holdout으로 잠김({hs_iso}~) — 저장 전략의 1회 개봉으로만 측정 가능.")
        return
    block = {"start": hs_iso, "locked": False, "event_study": _split_event_stats(episodes, hs_iso)}
    if portfolio is not None:
        ps = _split_portfolio_returns(portfolio.get("equity_curve") or [], hs_iso)
        if ps is not None:
            block["portfolio"] = ps
    result["meta"]["holdout"] = block
    result["warnings"].insert(
        0, f"holdout 개봉됨 (1회성) — 전체 기간 측정, holdout({hs_iso}~) 구간 분리 표기.")


def _ns_coverage_start(df: pd.DataFrame, prefix: str) -> str | None:
    """네임스페이스(prefix, 예 'fin.') 컬럼 중 하나라도 non-NaN인 첫 날짜 (실질 커버리지 시작)."""
    cmap = field_column_map()
    cols = [col for key, col in cmap.items() if key.startswith(prefix) and col in df.columns]
    if not cols:
        return None
    mask = df[cols].notna().any(axis=1).to_numpy()
    if not mask.any():
        return None
    return pd.Timestamp(df["time"].to_numpy()[mask].min()).date().isoformat()


# ── 조건 → boolean ndarray ─────────────────────────────────────────────────
def _eval_rank_pct(df: pd.DataFrame, col_map: dict, c: Condition,
                   times: np.ndarray, uni: np.ndarray) -> np.ndarray:
    """횡단면 순위 — 날짜별 유니버스 내 percentile 상·하위 value%.

    top: 값이 큰 쪽 value%, bottom: 값이 작은 쪽 value%. NaN·유니버스 밖은 순위 제외.
    method='min'으로 동점은 함께 포함(비율 보수적). 유니버스 수천 종목이라 ~value% 근사.
    """
    col = col_map[c.field]
    vals = pd.to_numeric(df[col], errors="coerce").to_numpy(dtype=float)
    res = np.zeros(len(df), dtype=bool)
    mask = uni & ~np.isnan(vals)
    if not mask.any():
        return res
    frac = float(c.value) / 100.0
    ascending = c.op == "rank_pct_bottom"
    sub = pd.DataFrame({"t": times[mask], "v": vals[mask]})
    rank = sub.groupby("t", sort=False)["v"].rank(pct=True, ascending=ascending, method="min").to_numpy()
    idx = np.nonzero(mask)[0]
    res[idx[rank <= frac]] = True
    return res


def _eval_condition(df: pd.DataFrame, col_map: dict, c: Condition,
                    times: np.ndarray, uni: np.ndarray) -> np.ndarray:
    col = col_map[c.field]
    s = df[col]
    if c.op == "is_true":
        return s.fillna(False).to_numpy(dtype=bool)
    if c.op == "is_false":
        return (~s.fillna(False).astype(bool)).to_numpy()
    if c.op in ("rank_pct_top", "rank_pct_bottom"):
        return _eval_rank_pct(df, col_map, c, times, uni)
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


def _eval_group(df: pd.DataFrame, col_map: dict, g: Group,
                times: np.ndarray, uni: np.ndarray) -> np.ndarray:
    items = g.all if g.all is not None else g.any
    arrs = [
        _eval_group(df, col_map, it, times, uni) if isinstance(it, Group)
        else _eval_condition(df, col_map, it, times, uni)
        for it in items
    ]
    stacked = np.vstack(arrs)
    return stacked.all(axis=0) if g.all is not None else stacked.any(axis=0)


# ── 벤치마크 (날짜 → 정규화 값 맵; excess는 비율로 차감) ─────────────────────
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


def _build_bmap(spec: Strategy, df: pd.DataFrame, uni: np.ndarray, panel: dict) -> tuple[bool, dict]:
    """(use_bench, {Timestamp: value}). value는 정규화 무관(excess는 비율만 사용)."""
    b = spec.benchmark
    if b == "none":
        return False, {}
    if b == "universe_avg":
        return True, _build_uidx(df, uni)
    # kospi / kosdaq — panel["indices"][b] = {Timestamp: close}
    idx = (panel.get("indices") or {}).get(b) or {}
    return True, dict(idx)


# ── 준비: 기간·유니버스·onset·벤치마크 ──────────────────────────────────────
def _prepare(panel: dict, spec: Strategy, prog=None, _signal_shift: int = 0,
             end_cap: date | None = None) -> dict:
    def _p(p):
        if prog:
            prog(p)

    df: pd.DataFrame = panel["df"]
    col_map = field_column_map()

    # 1) 기간 마스크 — 패널을 **슬라이스하지 않는다**. 신호/onset은 전체 범위에서 계산 후
    #    onset 날짜만 period로 필터(경계 onset 인플레이션 방지). 청산 스캔은 period end까지.
    #    end_cap(holdout train 캡)이 주어지면 그것이 실효 상한 — 러너가 항상 concrete date 전달.
    start = spec.period.start
    end = end_cap if end_cap is not None else spec.period.end
    times = df["time"].to_numpy()
    in_period = np.ones(len(df), dtype=bool)
    if start is not None:
        in_period &= times >= np.datetime64(pd.Timestamp(start))
    end_ts = np.datetime64(pd.Timestamp(end)) if end is not None else None
    if end_ts is not None:
        in_period &= times <= end_ts
    _p(62)

    # 2) 유니버스 (일별 마스크)
    markets = set(spec.universe.markets)
    in_mkt = df["market"].isin(markets).to_numpy()
    adv = pd.to_numeric(df["adv_20d"], errors="coerce").to_numpy(dtype=float)
    mcap = pd.to_numeric(df["mcap"], errors="coerce").to_numpy(dtype=float)
    uni = in_mkt & (adv >= spec.universe.min_adv_eok) & (mcap >= spec.universe.min_mcap_eok)
    uni &= ~np.isnan(adv) & ~np.isnan(mcap)

    # 3) entry 조건 → onset (전일 False→당일 True, 유니버스 내). rank_pct는 uni·times 필요.
    cond = _eval_group(df, col_map, spec.entry, times, uni)
    signal = cond & uni
    df["__sig"] = signal
    prev = df.groupby("stock", sort=False)["__sig"].shift(1, fill_value=False).to_numpy()
    onset = signal & (~prev)
    if _signal_shift:
        # 종목 내 onset을 앞으로 당김(미래 신호를 오늘 아는 척) — look-ahead 스모크 전용.
        onset = df.groupby("stock", sort=False)["__sig"].shift(_signal_shift, fill_value=False).to_numpy() & uni
        pv = pd.Series(onset).groupby(df["stock"].to_numpy()).shift(1, fill_value=False).to_numpy()
        onset = onset & (~pv)
    onset &= in_period
    _p(70)

    use_bench, bmap = _build_bmap(spec, df, uni, panel)

    return {
        "df": df, "col_map": col_map, "times": times,
        "in_period": in_period, "end_ts": end_ts,
        "uni": uni, "onset": onset, "use_bench": use_bench, "bmap": bmap,
    }


# ── 에피소드 시뮬 (종목별 연속 배열) ─────────────────────────────────────────
def _run_episodes(ctx: dict, spec: Strategy, prog=None) -> list[dict]:
    """자본 무제약 onset 에피소드 전부. 각 dict에 내부 키(_entry_g/_exit_g/…) 포함
    (포트폴리오 엔진용 — 공개 결과는 _public로 strip)."""
    df = ctx["df"]
    col_map = ctx["col_map"]
    times = ctx["times"]
    uni = ctx["uni"]
    onset = ctx["onset"]
    end_ts = ctx["end_ts"]
    use_bench = ctx["use_bench"]
    uidx = ctx["bmap"]

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
            cond_rules.append((ri, _eval_group(df, col_map, grp, times, uni)))
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

            # 청산 체결 (exit_at_close: 대금이 종가에 실현 — 포트폴리오 당일 재사용 게이트용)
            ongoing = False
            if reason in ("stop_loss_pct", "take_profit_pct"):
                # 종가 판정 후 다음날 체결 (same_close는 next_open으로 폴백)
                xb = k + 1
                exit_at_close = exit_fill == "next_close"
                exit_px = (o_close[xb] if exit_at_close else o_open[xb]) if xb < L_eff else np.nan
            else:  # fixed_holding / condition
                exit_at_close = exit_fill in ("same_close", "next_close")
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
                exit_at_close = True  # 마지막 종가 마감

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
                # ── 내부(포트폴리오 시뮬용) — _public에서 strip ──
                "_onset_g": int(pos[i]),
                "_entry_g": int(pos[eb]),
                "_exit_g": int(pos[xb]),
                "_entry_px": float(entry_px),
                "_exit_px": float(exit_px),
                "_net": float(net),
                "_exit_at_close": exit_at_close,
            })
    if prog:
        prog(90)
    return episodes


def _public(episodes: list[dict]) -> list[dict]:
    """내부(_로 시작) 키 제거한 공개 에피소드."""
    return [{k: v for k, v in e.items() if not k.startswith("_")} for e in episodes]


# ── 메인 (이벤트 스터디) ─────────────────────────────────────────────────────
def run_event_study(panel: dict, spec: Strategy, progress_cb=None, _signal_shift: int = 0,
                    holdout_unlocked: bool = False) -> dict:
    """spec을 패널에 적용해 이벤트 스터디 결과 dict 반환.

    holdout_unlocked=False(기본)면 train-only(holdout 직전 캡), True면 전체 기간 + 구간 분리 스탯.
    _signal_shift: 검증(look-ahead 스모크) 전용 — onset을 종목 내 n칸 이동. 프로덕션 경로는 0.
    """
    eff_end, hs, train_only = _resolve_end(panel, spec, holdout_unlocked)
    ctx = _prepare(panel, spec, progress_cb, _signal_shift, end_cap=eff_end)
    episodes = _run_episodes(ctx, spec, progress_cb)
    pub = _public(episodes)
    result = _summarize(pub, spec, panel, ctx["uni"] & ctx["in_period"], ctx["df"], eff_end=eff_end)
    result["mode"] = "event_study"
    _attach_holdout(result, pub, hs, train_only)
    if progress_cb:
        progress_cb(100)
    return result


def _summarize(episodes, spec, panel, uni, df, eff_end: date | None = None) -> dict:
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

    # 실효 커버리지 — 체결가(adj_open)가 실제 존재하는 첫 날. 표기 period.start보다 늦으면
    # 그 이전 신호는 체결 불가(측정 불가)라 경고 + meta에 별도 표기 (이벤트/포트폴리오 공통).
    period_start = (spec.period.start.isoformat() if spec.period.start
                    else panel["meta"]["period"]["start"])
    effective_start = None
    open_finite = np.isfinite(df["adj_open"].to_numpy(dtype=float))
    if open_finite.any():
        first_open = df["time"].to_numpy()[open_finite].min()
        effective_start = pd.Timestamp(first_open).date().isoformat()
        if effective_start > period_start:
            warnings.append(
                f"가격 데이터(수정시가) 가용 시작 {effective_start} — 그 이전 신호는 측정 불가.")

    # 재무(fin)·외인보유율(own) 조건은 공시 지연 근사·후발 커버리지라, 전략에 해당 네임스페이스
    # 필드가 있을 때만 실질 커버리지 시작을 경고에 명시 (effective_start 경고와 동일 방식).
    # portfolio.rank_by(슬롯 우선순위 지표)도 같은 데이터를 소비하므로 포함.
    used_ns = {f.split(".", 1)[0] for _p, f in iter_condition_fields(spec)}
    if spec.portfolio.rank_by:
        used_ns.add(spec.portfolio.rank_by.split(".", 1)[0])
    if "fin" in used_ns:
        cov = _ns_coverage_start(df, "fin.")
        warnings.append(
            "재무 조건 사용 — 공시 지연 근사(45/90일)·actual만"
            + (f", 실질 커버리지 {cov}~" if cov else ", 실질 커버리지 데이터 없음"))
    if "own" in used_ns:
        cov = _ns_coverage_start(df, "own.")
        warnings.append(
            "외인보유율 조건 사용 — 실질 커버리지 " + (f"{cov}~" if cov else "데이터 없음"))
    if "etf" in used_ns:
        cov = _ns_coverage_start(df, "etf.")
        warnings.append(
            "ETF 괴리 조건 사용 — 실질 커버리지 "
            + (f"{cov}~ (etf_master 2026-01-02~)" if cov else "데이터 없음"))

    # 실행 창 상한 — holdout train 캡(eff_end)이 주어지면 그것이 실제 측정 종료일.
    period_end = (eff_end.isoformat() if eff_end is not None
                  else (spec.period.end.isoformat() if spec.period.end
                        else panel["meta"]["period"]["end"]))
    n_uni_stocks = int(df.loc[uni, "stock"].nunique()) if uni.any() else 0
    meta = {
        "panel_versions": panel["versions"],
        "panel_meta": panel["meta"],
        "period": {
            "start": period_start,
            "end": period_end,
        },
        "effective_start": effective_start,  # 첫 유효 체결가(adj_open) 날짜 — 실효 커버리지
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
