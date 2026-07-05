"""수급 태그 **매도 타이밍** 백테스트 (PR-6, 측정 전용 — UI 없음).

사용자 질문: "장기동시·진입권 같은 좋은 조합에 들어갔으면 *언제 파는 게 좋은가* —
고정 보유가 나은가, 신호 소멸/경고 발생 때 파는 게 나은가."

flow_tag_backtest.py의 인프라(_fetch / _build_panel)를 그대로 재사용(중복 구현 금지).
look-ahead 규약 동일: 신호는 D 종가 데이터, 체결은 D+1 시가(adj_open).

세 가지 측정:
  ① 보유기간 곡선  — 태그 4종의 초과수익을 h∈{5,10,20,40,60,90,120,180}에서 측정
     + 구간별 한계 초과수익(0→60 / 60→120 / 120→180). "어디까지 알파가 쌓이나".
     (기존 방식: 태그일 → D+1 시가 진입, 주간 리밸런스 날짜를 관측단위로 t검정)
  ② 이벤트 기반 청산 규칙 비교 (사전 등록 5개, 튜닝 금지) — 태그 onset 진입 후
     E1 고정60 / E2 고정120 / E3 신호소멸 / E4 경고발생 / E5 둘 중 먼저 (cap180).
     에피소드 단위 초과수익(유니버스 일평균 수익 누적 인덱스 매칭 차감) + 보유일당 %.
  ③ 경고 태그의 잔여수익 — 강세 보유(장기동시 onset 후 120일 내) 중 경고 발생 시점부터
     이후 20/60일 초과수익 vs 경고 없는 대조군. "경고=즉시매도"가 데이터로 정당한가.

원칙: flow_tag_backtest.py 수정 금지(import만). data/flow_backtest.json 접근 금지.
임계값은 아래 명시분만(스윕/튜닝 금지). 수정주가(adj_open) 사용. Finance_Data read-only.

실행: cd backend && python3 scripts/flow_exit_backtest.py --years 2
"""
from __future__ import annotations

import asyncio
import sys

import numpy as np
import pandas as pd

from flow_tag_backtest import _fetch, _build_panel, ADV_MIN, MCAP_MIN, REBAL_EVERY

# ① 보유기간 곡선 지평 + 한계구간
CURVE_H = [5, 10, 20, 40, 60, 90, 120, 180]
SEGMENTS = [(0, 60), (60, 120), (120, 180)]
# ② 청산 규칙 cap / 고정 보유일
CAP = 180
FIX1, FIX2 = 60, 120
# ③ 강세 보유 창 + 잔여수익 지평
HOLD_WINDOW = 120
RES_H = [20, 60]


# ───────────────────────── 태그 정의 (사전 등록, 스윕 금지) ─────────────────────────
def _tag_masks(df: pd.DataFrame) -> tuple[dict, dict]:
    """진입 태그(4) + 경고 태그(3). flow_tag_backtest / flow_ai `_canonical_masks`와 동일 조건."""
    mc = df["mcap"].replace(0, np.nan)
    f20mc = df["f20"] / mc
    f5mc = df["f5"] / mc
    both = (df["f20"] > 0) & (df["i20"] > 0)
    entry_ok = (f20mc >= 0.0015) & (df["f5"] >= 0.3 * df["adv20"])           # 진입권 근사(5D/ADV)
    long_both = both & (df["f120"] > 0) & (df["i120"] > 0)                    # 4중 부호(장기동시 조건)
    entry_tags = {
        "핵심A(장기동시∧진입권)": long_both & entry_ok,
        "장기동시": long_both,
        "정석근사(동시∧진입권)": both & entry_ok,
        "매집주 눌림": (df["f120"] > 0) & (df["f20"] < 0),
    }
    warn_tags = {
        "분배": (f5mc <= -0.001) & (df["ret5"] >= -0.02) & (df["r5"] > 0),
        "동반순매도": (df["f20"] < 0) & (df["i20"] < 0) & (df["f120"] <= 0),
        "단기반등": (df["f20"] > 0) & (df["f120"] < 0),
    }
    return entry_tags, warn_tags


def _augment(df: pd.DataFrame) -> tuple[pd.DataFrame, list[str], list[str]]:
    """태그 bool + onset(전일 false→당일 true) + 유니버스 open 일수익 누적 인덱스(uidx)를 부착."""
    entry_tags, warn_tags = _tag_masks(df)
    gb = df.groupby("stock", sort=False)

    et_names, wt_names = list(entry_tags), list(warn_tags)
    for name, m in entry_tags.items():
        df[f"E::{name}"] = m.fillna(False).values
        df[f"ON::{name}"] = df[f"E::{name}"] & ~gb[f"E::{name}"].shift(1, fill_value=False)
    warn_on = np.zeros(len(df), dtype=bool)
    for name, m in warn_tags.items():
        df[f"W::{name}"] = m.fillna(False).values
        won = df[f"W::{name}"] & ~gb[f"W::{name}"].shift(1, fill_value=False)
        df[f"WON::{name}"] = won
        warn_on |= won.values
    df["any_warn_onset"] = warn_on

    # 거래 가능 유니버스 (같은 필터를 초과수익 벤치마크에도 사용)
    df["uni_day"] = (df["adv20"] >= ADV_MIN) & (df["mcap"] >= MCAP_MIN)
    # 유니버스 open 일수익 → **기하(로그) 누적 인덱스** (에피소드 기간 초과수익 매칭 차감용).
    #   ⚠ 일별 횡단면 *산술* 평균을 복리化(1+r 누적)하면 소형주 노이즈 open의 Blume-Stambaugh
    #   재조정 편향으로 60일 벤치가 +7%p 부풀어(실측 raw7.15% vs 산술idx14.5%) 초과수익 부호가
    #   뒤집힌다. 로그수익 평균의 누적 = 경로독립(횡단면 기하평균 총수익) → 편향 제거 + 가변창 정합.
    #   진단(scratchpad): fixed60 state 벤치를 ①(날짜 횡단면)과 일치(+3.64 vs +3.66)시킴.
    df["ret_open"] = gb["adj_open"].transform(lambda s: s / s.shift(1) - 1)
    m = df["uni_day"] & df["ret_open"].notna() & (df["ret_open"] > -0.99)
    lr = df.loc[m].assign(_lr=np.log1p(df.loc[m, "ret_open"])).groupby("time")["_lr"].mean().sort_index()
    uidx = np.exp(lr.cumsum())
    df["uidx"] = df["time"].map(uidx)
    return df, et_names, wt_names


# ───────────────────────── ① 보유기간 곡선 ─────────────────────────
def _date_ttest(groups: list, tag_col: str, val_col: str):
    """날짜별 (태그군 평균 − 유니버스 평균) 스프레드 → 날짜를 관측단위로 t검정."""
    spreads, counts = [], []
    for _, grp in groups:
        u = grp[grp[val_col].notna()]
        if len(u) < 20:
            continue
        tg = u[u[tag_col]]
        if len(tg) == 0:
            continue
        spreads.append(tg[val_col].mean() - u[val_col].mean())
        counts.append(len(tg))
    if len(spreads) < 5:
        return None
    sp = np.asarray(spreads)
    t = sp.mean() / (sp.std(ddof=1) / np.sqrt(len(sp)))
    return sp.mean() * 100, float(t), len(sp), float(np.mean(counts))


def holding_curve(df: pd.DataFrame, et_names: list[str]) -> None:
    g = df.groupby("stock", sort=False)
    entry = df["entry"]  # = adj_open.shift(-1) (D+1 시가), _build_panel에서 부착됨
    for h in CURVE_H:                                    # 진입 → D+1+h 시가
        df[f"xf{h}"] = g["adj_open"].shift(-(1 + h)) / entry - 1
    for a, b in SEGMENTS:                                # 구간 [D+1+a, D+1+b] 시가 수익
        pa = g["adj_open"].shift(-(1 + a))
        pb = g["adj_open"].shift(-(1 + b))
        df[f"seg_{a}_{b}"] = pb / pa - 1

    uni = df["uni_day"] & df["entry"].notna()
    times = np.sort(df["time"].unique())
    rebal = set(times[::REBAL_EVERY])
    d = df[uni & df["time"].isin(rebal)].copy()
    groups = list(d.groupby("time"))

    print("\n" + "=" * 96)
    print("① 보유기간 곡선  (태그별 누적 초과수익%, T+1 시가 진입, 유니버스 평균 대비, 주간 리밸 날짜 t검정)")
    print("-" * 96)
    hdr = "".join(f"{('h'+str(h)):>9}" for h in CURVE_H)
    print(f"{'태그':<22}{hdr}")
    for name in et_names:
        cells = []
        nd_last = None
        for h in CURVE_H:
            r = _date_ttest(groups, f"E::{name}", f"xf{h}")
            if r is None:
                cells.append(f"{'—':>9}")
            else:
                ex, t, nd, _ = r
                cells.append(f"{ex:>6.2f}/{t:>2.0f}")
                nd_last = nd
        print(f"{name:<22}{''.join(cells)}")
    # 날짜수 (h180 표본 점검용)
    print(f"{'(날짜수)':<22}" + "".join(
        f"{(_date_ttest(groups, 'E::'+et_names[0], f'xf{h}') or (0,0,0,0))[2]:>9}" for h in CURVE_H))
    print("셀 = 누적초과%/t값. h180 날짜수 30 미만이면 --years 3 참고치 병기 권장.")

    print("\n" + "-" * 96)
    print("① 한계(구간별) 초과수익  — 각 구간에서 추가로 번 초과수익%. '어디서 알파가 꺾이나'")
    print("-" * 96)
    seg_cols = [f"{a}→{b}" for a, b in SEGMENTS]
    print(f"{'태그':<22}" + "".join(f"{c+' 초과%/t':>16}" for c in seg_cols)
          + f"{'0→60 %/일':>11}{'60→120 %/일':>12}{'120→180 %/일':>13}")
    for name in et_names:
        cells, perday = [], []
        for a, b in SEGMENTS:
            r = _date_ttest(groups, f"E::{name}", f"seg_{a}_{b}")
            if r is None:
                cells.append(f"{'—':>16}"); perday.append(np.nan)
            else:
                ex, t, nd, _ = r
                cells.append(f"{ex:>9.2f}/{t:>4.1f}")
                perday.append(ex / (b - a))
        pd_cells = "".join((f"{v:>11.3f}" if not np.isnan(v) else f"{'—':>11}")
                           for v in (perday + [np.nan, np.nan, np.nan])[:3])
        print(f"{name:<22}" + "".join(cells) + pd_cells)


# ───────────────────────── ② 이벤트 기반 청산 규칙 ─────────────────────────
def _episode_sim(sub: pd.DataFrame, tag: str) -> dict:
    """한 종목 시계열에서 tag onset 에피소드별 5개 청산 규칙 초과수익 시뮬."""
    ao = sub["adj_open"].to_numpy(dtype=float)
    uidx = sub["uidx"].to_numpy(dtype=float)
    uni = sub["uni_day"].to_numpy()
    onset = sub[f"ON::{tag}"].to_numpy()
    tagtrue = sub[f"E::{tag}"].to_numpy()
    warnon = sub["any_warn_onset"].to_numpy()
    n = len(ao)
    out = {r: [] for r in ("E1", "E2", "E3", "E4", "E5")}
    for i in np.nonzero(onset)[0]:
        if not uni[i]:
            continue
        ep = i + 1                                       # D+1 시가 진입
        if ep >= n or not np.isfinite(ao[ep]) or ao[ep] <= 0 or not np.isfinite(uidx[ep]):
            continue
        entry_px, entry_uidx = ao[ep], uidx[ep]
        hi = min(i + 1 + CAP, n)
        # E3 신호 소멸: onset 이후 첫 태그 false 날 → 그 D+1 매도
        e3 = ep + CAP
        for t in range(i + 1, hi):
            if not tagtrue[t]:
                e3 = t + 1
                break
        # E4 경고 발생: onset 이후 첫 경고 onset 날 → 그 D+1 매도
        e4 = ep + CAP
        for t in range(i + 1, hi):
            if warnon[t]:
                e4 = t + 1
                break
        e3 = min(e3, ep + CAP)
        e4 = min(e4, ep + CAP)
        exits = {"E1": ep + FIX1, "E2": ep + FIX2, "E3": e3, "E4": e4, "E5": min(e3, e4)}
        for r, xp in exits.items():
            if xp >= n or not np.isfinite(ao[xp]) or not np.isfinite(uidx[xp]):
                continue                                 # 우측 절단(데이터 부족) → 제외
            eret = ao[xp] / entry_px - 1
            uret = uidx[xp] / entry_uidx - 1
            out[r].append((eret - uret, xp - ep))
    return out


def exit_rules(df: pd.DataFrame, et_names: list[str]) -> None:
    cols = ["stock", "adj_open", "uidx", "uni_day", "any_warn_onset"]
    print("\n" + "=" * 96)
    print("② 이벤트 기반 청산 규칙 비교  (태그 onset 진입, 에피소드 단위, 유니버스 매칭기간 수익 차감)")
    print("   E1 고정60 · E2 고정120 · E3 신호소멸 · E4 경고발생 · E5 둘 중 먼저 (E3~E5 cap 180)")
    for tag in et_names:
        sub_cols = cols + [f"ON::{tag}", f"E::{tag}"]
        agg = {r: [] for r in ("E1", "E2", "E3", "E4", "E5")}
        for _, sub in df[sub_cols].groupby("stock", sort=False):
            res = _episode_sim(sub, tag)
            for r in agg:
                agg[r].extend(res[r])
        print("\n" + "-" * 96)
        print(f"[{tag}]")
        print(f"{'규칙':<20}{'에피소드':>8}{'평균보유일':>10}{'평균초과%':>10}{'초과/일%':>9}{'t값':>8}")
        for r, label in (("E1", "E1 고정60"), ("E2", "E2 고정120"), ("E3", "E3 신호소멸"),
                         ("E4", "E4 경고발생"), ("E5", "E5 먼저오는쪽")):
            arr = agg[r]
            if len(arr) < 5:
                print(f"{label:<20}{len(arr):>8}{'(부족)':>10}")
                continue
            ex = np.array([x[0] for x in arr])
            hold = np.array([x[1] for x in arr])
            t = ex.mean() / (ex.std(ddof=1) / np.sqrt(len(ex)))
            perday = ex.mean() / hold.mean() * 100
            print(f"{label:<20}{len(ex):>8}{hold.mean():>10.1f}{ex.mean()*100:>10.2f}"
                  f"{perday:>9.3f}{t:>8.2f}")
    print("\n주: t는 에피소드 단위. 같은 종목 다수 onset이 겹쳐 횡단면 독립 아님 → t는 보수적으로 해석.")


# ───────────────────────── ③ 경고 태그의 잔여수익 ─────────────────────────
def _warn_residual(sub: pd.DataFrame, anchor: str) -> tuple[dict, dict]:
    ao = sub["adj_open"].to_numpy(dtype=float)
    uidx = sub["uidx"].to_numpy(dtype=float)
    warnon = sub["any_warn_onset"].to_numpy()
    strong = sub[f"ON::{anchor}"].to_numpy()
    n = len(ao)
    ev_w = {h: [] for h in RES_H}   # 경고 시점 이후 (초과수익, 경과일)
    ev_c = {h: [] for h in RES_H}   # 대조군: 경고 前 보유일 (초과수익, 경과일)
    for i in np.nonzero(strong)[0]:
        warned = False
        for k in range(1, HOLD_WINDOW + 1):             # onset 후 1..120일 보유 중
            t = i + k
            if t >= n:
                break
            is_w = warnon[t]
            fp = t + 1                                   # 관측 시점부터 D+1 시가 진입
            if fp < n and np.isfinite(ao[fp]) and ao[fp] > 0 and np.isfinite(uidx[fp]):
                for h in RES_H:
                    xp = fp + h
                    if xp >= n or not np.isfinite(ao[xp]) or not np.isfinite(uidx[xp]):
                        continue
                    ex = (ao[xp] / ao[fp] - 1) - (uidx[xp] / uidx[fp] - 1)
                    if is_w:
                        ev_w[h].append((ex, k))
                    elif not warned:
                        ev_c[h].append((ex, k))
            if is_w:
                warned = True                            # 첫 경고 이후는 대조군에서 제외
    return ev_w, ev_c


def _welch(a: np.ndarray, b: np.ndarray) -> float:
    if len(a) < 2 or len(b) < 2:
        return np.nan
    return (a.mean() - b.mean()) / np.sqrt(a.var(ddof=1) / len(a) + b.var(ddof=1) / len(b))


def warn_residual(df: pd.DataFrame, anchor: str = "장기동시") -> None:
    cols = ["stock", "adj_open", "uidx", "any_warn_onset", f"ON::{anchor}"]
    ev_w = {h: [] for h in RES_H}
    ev_c = {h: [] for h in RES_H}
    for _, sub in df[cols].groupby("stock", sort=False):
        w, c = _warn_residual(sub, anchor)
        for h in RES_H:
            ev_w[h].extend(w[h])
            ev_c[h].extend(c[h])

    print("\n" + "=" * 96)
    print(f"③ 경고 태그의 잔여수익  (강세 앵커='{anchor}' onset 후 {HOLD_WINDOW}일 보유 중,")
    print("   경고(분배/동반순매도/단기반등) 발생 시점부터 이후 수익 vs 경고 없는 대조군)")
    print("-" * 96)
    print(f"{'지평':>6}{'경고 초과%':>11}{'경고 n':>8}{'대조 초과%':>11}{'대조 n':>8}"
          f"{'차이(경고−대조)%':>16}{'Welch t':>9}")
    for h in RES_H:
        w = np.array([x[0] for x in ev_w[h]])
        c = np.array([x[0] for x in ev_c[h]])
        if len(w) < 5 or len(c) < 5:
            print(f"{h:>6}{'(관측 부족)':>11}")
            continue
        t = _welch(w, c)
        print(f"{h:>6}{w.mean()*100:>11.2f}{len(w):>8}{c.mean()*100:>11.2f}{len(c):>8}"
              f"{(w.mean()-c.mean())*100:>16.2f}{t:>9.2f}")

    # 경과일 매칭 (같은 보유일수 버킷 내 비교)
    print("\n경과일 버킷별 (경고 vs 대조, h60 초과%) — '같은 보유일수' 대조 매칭")
    print(f"{'경과일버킷':>12}{'경고 초과%':>11}{'경고 n':>8}{'대조 초과%':>11}{'대조 n':>8}{'차이%':>9}{'t':>7}")
    buckets = [(1, 20), (21, 60), (61, 120)]
    h = 60
    for lo, hi in buckets:
        w = np.array([x[0] for x in ev_w[h] if lo <= x[1] <= hi])
        c = np.array([x[0] for x in ev_c[h] if lo <= x[1] <= hi])
        if len(w) < 5 or len(c) < 5:
            print(f"{f'{lo}-{hi}일':>12}{'(부족)':>11}{len(w):>8}{'':>11}{len(c):>8}")
            continue
        t = _welch(w, c)
        print(f"{f'{lo}-{hi}일':>12}{w.mean()*100:>11.2f}{len(w):>8}{c.mean()*100:>11.2f}"
              f"{len(c):>8}{(w.mean()-c.mean())*100:>9.2f}{t:>7.2f}")
    print("\n해석: 경고군 잔여수익이 대조군보다 유의하게 낮으면(차이 음·|t|>2) '경고=즉시 매도'가 정당.")
    print("주: 앵커 onset 창이 종목 내 중첩 가능 → 관측 독립 아님. t 보수 해석.")


# ───────────────────────── main ─────────────────────────
async def main() -> None:
    years = 2.0
    if "--years" in sys.argv:
        years = float(sys.argv[sys.argv.index("--years") + 1])
    print(f"[flow_exit_backtest] 룩백 {years}년")
    it_df, ohlcv_df, mc_df = await _fetch(years)
    print(f"패널 rows — 수급 {len(it_df):,} / 시세 {len(ohlcv_df):,} / 시총 {len(mc_df):,}")
    df = _build_panel(it_df, ohlcv_df, mc_df)
    df, et_names, wt_names = _augment(df)
    print(f"진입 태그: {et_names}")
    print(f"경고 태그: {wt_names}")

    holding_curve(df, et_names)
    exit_rules(df, et_names)
    warn_residual(df, anchor="장기동시")


if __name__ == "__main__":
    asyncio.run(main())
