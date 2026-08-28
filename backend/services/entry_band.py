"""진입 시점 밴드 재계산 (refit) — 과거 날짜의 α₀·β₀·μ₀·σ₀를 일봉으로 복원.

stat-arb-engine.md §24.8. 엔진(8300)은 **최신 사이클 통계만** 메모리에 들고 있어 임의 과거
날짜의 밴드를 소급 조회할 방법이 없다. 하지만 밴드의 재료는 Finance_Data 일봉뿐이므로,
엔진과 *같은 자*로 다시 회귀하면 그날의 밴드가 그대로 복원된다.

재현 스펙 — `stat-arb-engine/src/`의 세 지점을 그대로 옮긴 것 (하나라도 어긋나면 다른 자다):

    ① 가격   data/bars.rs `load_stock_daily`
             ohlcv_daily.adj_close::INTEGER (수정주가 + 정수 반올림). `adj_close IS NULL`
             행 제외, 종가 ≤ 0 제외. 지수는 index_ohlcv_daily.close (분할 없어 raw).
    ② 창     main.rs `warmup_days_daily()` = 1095 캘린더일.
             time ∈ [entry_date − 1095일, entry_date)  ← **진입일 당일 미포함**
    ③ 정렬   detail.rs `intersect_by_ts` — 날짜 교집합, 양쪽 종가 > 0인 날만.
    ④ 회귀   stats.rs `ols` — 레벨 OLS  y(right) = β·x(left) + α,  잔차 e = y − α − βx.
    ⑤ 정규화 detail.rs `build_headline` — center = mean(e)(절편 OLS라 ≈0),
             sigma = 모표준편차(분모 n),  z = (e − center)/sigma.

**당일을 빼는 이유**: 일봉은 장 마감 후 Finance_Data 배치로 들어온다. 진입 시점에 엔진 캐시가
들고 있던 마지막 봉은 D−1이다. 실증 — 실기록 "방산 페어"(2026-08-13 15:51 진입, E:0080G0 ↔
S:012450)의 저장 밴드 α=−108,100.82340 β=103.50002062 r²=0.94642638 이 D−1 창(2025-07-15
~2026-08-12, 264봉) 재계산과 소수점 8자리까지 일치했고, 진입 z에서 역산한 σ₀ 45,635.3116과
재계산 σ 45,635.3128의 오차가 0.000%였다.

한계: 엔진의 실제 창 시작은 *프로세스 기동일* − 1095일이라, 엔진이 여러 날 떠 있었으면 창
시작이 며칠 앞설 수 있다. 3년 창의 양 끝 며칠 차이라 β·σ 영향은 미미하지만 완전 항등은 아니다
(위 실측은 기동 당일 진입이라 정확히 일치). 상장 3년 미만 종목은 창이 데이터에 잘려 무관.
"""
from __future__ import annotations

import math
import time
from datetime import date, timedelta

import numpy as np
from sqlalchemy import text

from core.database import korea_async_session

# 엔진 warmup_days_daily() 기본값과 동일 (main.rs). 창 길이를 바꾸면 다른 자가 된다.
WINDOW_DAYS = 1095
# 최소 표본. 엔진 timeframe 통계 하한이 30이지만, σ·ADF가 의미를 갖는 선에서 2배로 잡는다.
MIN_BARS = 60
# 교집합 / 짧은 쪽 봉 수. 신규 상장(짧은 쪽이 통째로 짧은 경우)은 통과하고,
# 거래정지·데이터 구멍으로 날짜가 어긋난 경우만 걸린다.
MIN_OVERLAP_RATIO = 0.6
# 밴드 캐시 — 같은 (페어, 진입일)이면 가격이 바뀌어도 회귀는 그대로다 (모달 debounce 재호출).
_CACHE_TTL_SEC = 600.0
_CACHE_MAX = 64

_STOCK_SQL = text(
    """
    SELECT stock_code AS code, time, adj_close::INTEGER AS close
    FROM ohlcv_daily
    WHERE stock_code = ANY(:codes) AND time >= :start AND time < :end
      AND adj_close IS NOT NULL
    ORDER BY time
    """
)

_INDEX_SQL = text(
    """
    SELECT code, time, close
    FROM index_ohlcv_daily
    WHERE code = ANY(:codes) AND time >= :start AND time < :end
    ORDER BY time
    """
)

# ohlcv_daily 를 공유하는 prefix (같은 6자리 코드 공간, 의미만 다름).
_STOCK_TYPES = {"S", "E"}


class RefitError(ValueError):
    """재계산 불가 — 표본 부족·미지원 자산군·퇴화 회귀. 라우터가 422로 변환."""


_cache: dict[tuple[str, str, str], tuple[float, dict]] = {}


async def estimate(
    left_key: str,
    right_key: str,
    entry_date: date,
    left_price: float,
    right_price: float,
) -> dict:
    """진입일 기준 밴드 + 그 밴드로 잰 진입 z.

    반환 `sigma` 가 entry_stats 의 `scale` 이다 (§24.3 필드명). 가격은 회귀에 안 들어가고
    z 계산에만 쓰이므로 밴드는 (페어, 진입일)로 캐시한다 — 미래 데이터 누출 없음.
    """
    if entry_date > date.today():
        raise RefitError(f"진입일이 미래다: {entry_date.isoformat()}")

    band = _cached(left_key, right_key, entry_date)
    if band is None:
        band = await _fit(left_key, right_key, entry_date)
        _store(left_key, right_key, entry_date, band)

    spread = right_price - band["alpha"] - band["beta"] * left_price
    entry_z = (spread - band["center"]) / band["sigma"]
    return {
        "left_key": left_key,
        "right_key": right_key,
        "entry_date": entry_date.isoformat(),
        "spread": spread,
        "entry_z": entry_z,
        **band,
    }


async def _fit(left_key: str, right_key: str, entry_date: date) -> dict:
    """일봉 로드 → 교집합 → 레벨 OLS → 밴드. 가격 무관 (캐시 대상)."""
    start = entry_date - timedelta(days=WINDOW_DAYS)
    series = await _load_daily([left_key, right_key], start, entry_date)
    left, right = series[left_key], series[right_key]
    for key, s in ((left_key, left), (right_key, right)):
        if not s:
            raise RefitError(
                f"{key} 일봉이 창 [{start.isoformat()}, {entry_date.isoformat()}) 에 없다"
            )

    days = sorted(left.keys() & right.keys())
    n = len(days)
    if n < MIN_BARS:
        raise RefitError(
            f"표본 부족 — 진입일 이전 공통 일봉 {n}봉 (최소 {MIN_BARS}봉). "
            f"{left_key} {len(left)}봉 / {right_key} {len(right)}봉"
        )
    shorter = min(len(left), len(right))
    if n < shorter * MIN_OVERLAP_RATIO:
        raise RefitError(
            f"날짜 정렬 실패 — 공통 {n}봉이 짧은 쪽 {shorter}봉의 "
            f"{n / shorter:.0%} (거래정지·데이터 결측 의심)"
        )

    x = np.fromiter((left[d] for d in days), dtype=np.float64, count=n)
    y = np.fromiter((right[d] for d in days), dtype=np.float64, count=n)
    alpha, beta, resid, r2 = _ols(x, y)
    center = float(resid.mean())
    sigma = float(np.sqrt(((resid - center) ** 2).mean()))
    if not sigma > 0:
        raise RefitError("잔차 σ = 0 — 두 종목이 완전 선형 종속")
    adf, half_life = _adf_half_life(resid)

    return {
        "alpha": alpha,
        "beta": beta,
        "center": center,
        "sigma": sigma,
        "r2": r2,
        "adf": adf,
        "half_life": half_life,
        "window_bars": n,
        "window_days": WINDOW_DAYS,
        "first_date": days[0].isoformat(),
        "asof": days[-1].isoformat(),
        "basis": "1d",
        "source": "refit",
    }


async def _load_daily(
    keys: list[str], start: date, end: date
) -> dict[str, dict[date, float]]:
    """series_key → {날짜: 종가}. 주식/ETF는 한 쿼리로 묶는다 (`stock_code = ANY`).

    end 는 **미포함** — 진입일 당일 봉은 진입 시점에 존재하지 않았다 (모듈 docstring).
    """
    by_table: dict[str, dict[str, str]] = {}  # sql 그룹 → {code: key}
    for key in keys:
        prefix, _, code = key.partition(":")
        if not code:
            prefix, code = "S", key
        if prefix in _STOCK_TYPES:
            by_table.setdefault("stock", {})[code] = key
        elif prefix == "I":
            by_table.setdefault("index", {})[code] = key
        else:
            raise RefitError(
                f"{key} — 주식/ETF/지수만 재계산할 수 있다 "
                "(선물은 만기 롤 때문에 과거 밴드 재현 불가)"
            )

    out: dict[str, dict[date, float]] = {k: {} for k in keys}
    params = {"start": start, "end": end}
    async with korea_async_session() as session:
        for group, sql in (("stock", _STOCK_SQL), ("index", _INDEX_SQL)):
            codes = by_table.get(group)
            if not codes:
                continue
            rows = (
                await session.execute(sql, {"codes": list(codes), **params})
            ).all()
            for r in rows:
                close = float(r.close) if r.close is not None else 0.0
                # 종가 ≤ 0 은 어느 자산군에서도 유효한 가격이 아니다 (bars.rs has_valid_close).
                if close > 0 and math.isfinite(close):
                    out[codes[r.code]][r.time] = close
    return out


def _ols(x: np.ndarray, y: np.ndarray) -> tuple[float, float, np.ndarray, float]:
    """레벨 OLS y = β·x + α. 반환 (α, β, 잔차, R²). stats.rs `ols` 와 동일 산식."""
    dx = x - x.mean()
    dy = y - y.mean()
    sxx = float(dx @ dx)
    syy = float(dy @ dy)
    if sxx <= 0 or syy <= 0:
        raise RefitError("가격이 상수 — 회귀 불가")
    beta = float(dx @ dy) / sxx
    alpha = float(y.mean() - beta * x.mean())
    resid = y - alpha - beta * x
    r2 = 1.0 - float(resid @ resid) / syy
    return alpha, beta, resid, r2


def _adf_half_life(resid: np.ndarray) -> tuple[float | None, float | None]:
    """잔차의 ADF t-stat(lag=0) + 반감기. stats.rs `adf_tstat`/`half_life` 이식.

    회귀 Δe_t = a + ρ·e_{t−1}. t = ρ̂/SE(ρ̂), half_life = ln2 / −ρ̂ (ρ̂ ≥ 0 이면 None).
    """
    n = resid.size - 1
    if n < 3:
        return None, None
    lag = resid[:-1]
    d = np.diff(resid)
    dx = lag - lag.mean()
    sxx = float(dx @ dx)
    if sxx <= 0:
        return None, None
    rho = float(dx @ (d - d.mean())) / sxx
    a = float(d.mean() - rho * lag.mean())
    err = d - a - rho * lag
    mse = float(err @ err) / (n - 2)
    se = math.sqrt(mse / sxx)
    adf = rho / se if se > 0 else None
    half_life = math.log(2) / -rho if rho < 0 else None
    return adf, half_life


def _cached(left_key: str, right_key: str, entry_date: date) -> dict | None:
    hit = _cache.get((left_key, right_key, entry_date.isoformat()))
    if hit and time.monotonic() - hit[0] < _CACHE_TTL_SEC:
        return hit[1]
    return None


def _store(left_key: str, right_key: str, entry_date: date, band: dict) -> None:
    if len(_cache) >= _CACHE_MAX:
        # 가장 오래된 항목부터 정리 (호출량이 모달 debounce 수준이라 단순 스캔으로 충분).
        for k, _ in sorted(_cache.items(), key=lambda kv: kv[1][0])[: _CACHE_MAX // 2]:
            _cache.pop(k, None)
    _cache[(left_key, right_key, entry_date.isoformat())] = (time.monotonic(), band)
