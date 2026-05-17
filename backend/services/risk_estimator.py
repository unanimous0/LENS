"""LP 리스크 파라미터 추정 — 베타 · 잔차 σ · 잔차 공분산 · 섹터 매핑.

산출 흐름:
1. Finance_Data DB에서 시장 일봉(K2G01P=KOSPI200) + 대상 종목 일봉(ohlcv_daily) fetch
2. 단순 일별 수익률 산출 + 거래일 align
3. 60일 OLS: r_stock = α + β × r_market + ε  →  β, ε 시계열
4. ε 시계열 → sample covariance + Ledoit-Wolf shrinkage (대각 타겟)
5. stock_sectors.fics_sector 매핑
6. 24h 캐시 + lock

호출: Rust startup에 GET /api/lp/risk-params 1회 + 24h TTL.

LP 의미:
- 베타 ≈ 시장 베타 노출도. 1.0 대비 큰 ETF는 변동성 큰 자산
- 잔차 σ = 시장 헤지 후 종목 고유 일변동성 (1σ)
- 잔차 공분산 = *같은 섹터 종목 잔차들끼리 +상관* → 단순 합보다 큰 잔차위험
- Ledoit-Wolf shrinkage = 표본 공분산을 *대각 (= 독립 가정)* 쪽으로 적정 비율 끌어당겨 추정 안정화
"""
from __future__ import annotations

import asyncio
import time
from datetime import date, timedelta
from typing import Optional

import numpy as np
from sqlalchemy import text

from core.database import korea_async_session

# 기본 시장 변수 — KOSPI 200 단일 팩터. 다음 빌드 multi-factor(섹터 지수 K2S07P 등) 자리.
MARKET_CODE = "K2G01P"
WINDOW_DAYS = 60
CACHE_TTL_SEC = 86_400.0  # 24h
MIN_SAMPLES_FOR_FIT = 20  # 회귀에 필요한 최소 거래일 수


class _RiskCache:
    fetched_at: float = 0.0
    data: Optional[dict] = None


_cache = _RiskCache()
_lock = asyncio.Lock()


async def _fetch_market_returns(
    session, market_code: str, window_days: int
) -> tuple[list[date], np.ndarray]:
    """시장 일봉 종가 → 일별 단순 수익률 시계열 (가장 최근 window_days 거래일)."""
    rows = (await session.execute(text(
        "SELECT time, close FROM index_ohlcv_daily "
        "WHERE code = :c ORDER BY time DESC LIMIT :n"
    ), {"c": market_code, "n": window_days + 1})).all()
    if len(rows) < window_days + 1:
        raise RuntimeError(
            f"시장 시계열 부족: {market_code} {len(rows)}/{window_days + 1}일"
        )
    rows = list(reversed(rows))  # 오름차순
    times = [r.time for r in rows[1:]]
    closes = np.array([float(r.close) for r in rows], dtype=np.float64)
    returns = (closes[1:] - closes[:-1]) / closes[:-1]
    return times, returns


async def _fetch_stock_returns(
    session, stock_codes: list[str], dates: list[date]
) -> dict[str, np.ndarray]:
    """대상 종목들의 일봉 → dates 기준 정렬된 수익률 시계열 (NaN 가능).

    각 dates[i]에 대해 수익률 = (close_dates[i] − prev_close_거래일) / prev_close.
    종목별 거래정지/신규상장으로 일부 NaN.
    """
    if not stock_codes or not dates:
        return {}
    earliest = dates[0] - timedelta(days=10)
    latest = dates[-1]

    # adj_close — 액면분할/병합 소급 조정된 종가. raw close_price를 쓰면 분할일에 spike
    # (예: 100만→10만) 발생해 OLS β·잔차 σ 무력화. Finance_Data 04:30 매일 갱신.
    # 지수(index_ohlcv_daily)는 분할 없어 raw 그대로 OK. 출처: CLAUDE.md Finance_Data 룰.
    rows = (await session.execute(text(
        "SELECT stock_code, time, adj_close FROM ohlcv_daily "
        "WHERE stock_code = ANY(:codes) AND time BETWEEN :s AND :e "
        "ORDER BY stock_code, time"
    ), {"codes": stock_codes, "s": earliest, "e": latest})).all()

    series_by_code: dict[str, list[tuple[date, float]]] = {}
    for r in rows:
        series_by_code.setdefault(r.stock_code, []).append(
            (r.time, float(r.adj_close))
        )

    out: dict[str, np.ndarray] = {}
    for code, ts in series_by_code.items():
        ts.sort(key=lambda x: x[0])
        close_by_time = dict(ts)
        sorted_times = [t for t, _ in ts]
        rets = np.full(len(dates), np.nan, dtype=np.float64)
        for i, d in enumerate(dates):
            if d not in close_by_time:
                continue
            # 이전 거래일 close — sorted_times에서 d 직전
            idx = next((j for j, sd in enumerate(sorted_times) if sd >= d), len(sorted_times))
            if idx == 0:
                continue
            prev_close = close_by_time[sorted_times[idx - 1]]
            if prev_close <= 0:
                continue
            rets[i] = (close_by_time[d] - prev_close) / prev_close
        out[code] = rets
    return out


def _ols_beta(
    market_ret: np.ndarray, stock_ret: np.ndarray
) -> tuple[float, float, np.ndarray]:
    """단순 OLS: r_stock = α + β × r_market + ε.

    NaN 있는 거래일 제외. 표본 < MIN_SAMPLES_FOR_FIT 이면 NaN 반환.
    반환: (β, α, ε array — NaN 제외 길이).
    """
    mask = ~(np.isnan(market_ret) | np.isnan(stock_ret))
    if int(mask.sum()) < MIN_SAMPLES_FOR_FIT:
        return float("nan"), float("nan"), np.array([])
    m = market_ret[mask]
    s = stock_ret[mask]
    m_mean = m.mean()
    s_mean = s.mean()
    var_m = ((m - m_mean) ** 2).mean()
    if var_m <= 0:
        return float("nan"), float("nan"), np.array([])
    cov_ms = ((m - m_mean) * (s - s_mean)).mean()
    beta = cov_ms / var_m
    alpha = s_mean - beta * m_mean
    eps = s - alpha - beta * m
    return float(beta), float(alpha), eps


def _ledoit_wolf_shrinkage(
    residuals: np.ndarray,
) -> tuple[np.ndarray, float]:
    """Ledoit-Wolf shrinkage of sample covariance toward diagonal target.

    참고: Ledoit & Wolf (2003) "Honey, I shrunk the sample covariance matrix."
        δ̂ = max(0, min(1, κ̂ / T)),  κ̂ = (π̂ - ρ̂) / γ̂
        π̂ = (1/T) Σ_t Σ_ij (X_ti X_tj − S_ij)²
        ρ̂ = Σ_i π̂_ii (대각 타겟이므로)
        γ̂ = ||S − diag(S)||²_F

    Args:
        residuals: (T, n) — T 시점 × n 자산
    Returns:
        (Σ_shrunk, δ̂) — shrunk 공분산 + shrinkage intensity
    """
    T, n = residuals.shape
    if T < 2 or n < 1:
        return np.zeros((n, n)), 0.0

    X = residuals - residuals.mean(axis=0, keepdims=True)
    S = (X.T @ X) / T
    F = np.diag(np.diag(S))

    # π̂ 벡터화 — outer products. 메모리: T × n² × 8 bytes
    outers = X[:, :, None] * X[:, None, :]  # (T, n, n)
    pi_mat = ((outers - S) ** 2).mean(axis=0)
    pi = float(pi_mat.sum())
    rho = float(np.diag(pi_mat).sum())

    gamma = float(((S - F) ** 2).sum())
    if gamma <= 0:
        return S, 0.0

    kappa = (pi - rho) / gamma
    delta = max(0.0, min(1.0, kappa / T))
    return (1.0 - delta) * S + delta * F, delta


async def estimate_risk_params(
    market_code: str = MARKET_CODE,
    window_days: int = WINDOW_DAYS,
) -> dict:
    """대상 종목·ETF의 베타 + 잔차 σ + 잔차 공분산 + 섹터 매핑 산출.

    대상 = LP 북 ETF (DEFAULT_ETF_CODES) + 각 PDF 구성종목 union.
    """
    # circular import 회피 — 함수 안에서 lazy import
    from routers.etfs import _cache as etf_cache, _ensure_loaded
    from routers.lp import DEFAULT_ETF_CODES

    await _ensure_loaded()

    target_codes_set: set[str] = set(DEFAULT_ETF_CODES)
    for etf_code in DEFAULT_ETF_CODES:
        pdf = etf_cache.pdfs.get(etf_code)
        if not pdf:
            continue
        for stock in pdf["stocks"]:
            target_codes_set.add(stock["code"])
    target_codes = sorted(target_codes_set)

    async with korea_async_session() as session:
        dates, market_ret = await _fetch_market_returns(session, market_code, window_days)
        stock_rets = await _fetch_stock_returns(session, target_codes, dates)
        sector_rows = (await session.execute(text(
            "SELECT stock_code, fics_sector FROM stock_sectors "
            "WHERE stock_code = ANY(:codes)"
        ), {"codes": target_codes})).all()

    sector_map = {r.stock_code: r.fics_sector for r in sector_rows if r.fics_sector}

    # 종목별 OLS
    betas: dict[str, float] = {}
    residual_series: dict[str, np.ndarray] = {}
    fit_failed: list[str] = []

    for code in target_codes:
        if code not in stock_rets:
            fit_failed.append(code)
            continue
        beta, _alpha, eps = _ols_beta(market_ret, stock_rets[code])
        if np.isnan(beta) or len(eps) == 0:
            fit_failed.append(code)
            continue
        betas[code] = beta
        residual_series[code] = eps

    # 잔차 공분산 — *공통 길이*만 사용 (종목별 NaN으로 길이 다를 수 있음)
    if residual_series:
        min_len = min(len(v) for v in residual_series.values())
        cov_codes = sorted(residual_series.keys())
        residual_matrix = np.column_stack(
            [residual_series[c][-min_len:] for c in cov_codes]
        )
        residual_sigmas = {
            c: float(residual_matrix[:, i].std())
            for i, c in enumerate(cov_codes)
        }
        cov_shrunk, shrinkage = _ledoit_wolf_shrinkage(residual_matrix)
    else:
        cov_codes = []
        residual_sigmas = {}
        cov_shrunk = np.zeros((0, 0))
        shrinkage = 0.0

    return {
        "as_of": dates[-1].isoformat() if dates else None,
        "market_code": market_code,
        "window_days": window_days,
        "betas": betas,
        "residual_sigmas_daily": residual_sigmas,
        "residual_covariance": {
            "codes": cov_codes,
            "matrix": cov_shrunk.tolist(),
        },
        "sector_map": sector_map,
        "shrinkage_intensity": shrinkage,
        "coverage": {
            "target_stocks": len(target_codes),
            "fit_ok": len(betas),
            "fit_failed": len(fit_failed),
            "failed_codes_sample": fit_failed[:20],
        },
    }


async def get_risk_params(force_refresh: bool = False) -> dict:
    """24h 캐시 + lock. 최초 호출 시 회귀 산출 — 수 초 소요."""
    if (
        not force_refresh
        and time.monotonic() - _cache.fetched_at < CACHE_TTL_SEC
        and _cache.data is not None
    ):
        return _cache.data
    async with _lock:
        if (
            not force_refresh
            and time.monotonic() - _cache.fetched_at < CACHE_TTL_SEC
            and _cache.data is not None
        ):
            return _cache.data
        data = await estimate_risk_params()
        _cache.data = data
        _cache.fetched_at = time.monotonic()
        return data
