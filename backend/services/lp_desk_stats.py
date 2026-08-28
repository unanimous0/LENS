"""LP 데스크 통계 파이프라인 — lp-system-design.md §14.3.

두 축을 낸다:

① **2-팩터 회귀** — ETF 일간수익률 ~ K200 지수(`K2G01P`) + KQ150 지수(`Q5G01P`) 수익률의
   절편 포함 OLS(창 120영업일). β_k200 / β_kq150 / R² / 잔차변동성(bp/일) / 최근 잔차 z.
   상세(행 펼침)용으로 rolling 60일 β 시계열 + 잔차 시계열/히스토그램.
② **과거 괴리 분포** — 호가 밴드(§14.5)의 원천. 공식 NAV 히스토리가 FD에 없어 **PDF 재구성
   NAV**를 쓴다: `navʳ_t = (Σ shares×close_t[비현금] + Σ shares[현금]) / CU_t`,
   `gap_t = (ETF close_t − navʳ_t)/navʳ_t × 1e4` (bp). gap_mean / gap_sigma / 유효표본수 +
   상세용 gap 시계열·히스토그램.

규약:
- 회귀용 ETF 가격은 **`ohlcv_daily.adj_close`** (수정주가). raw close는 분할/병합 spike로
  회귀를 무력화 — CLAUDE.md 작업 규칙. 지수(`index_ohlcv_daily.close`)는 분할이 없어 raw.
  **괴리는 반대로 raw `close_price`** — 같은 날 PDF 수량×종가와 ETF 종가의 비(比)라서
  수정계수를 한쪽에만 먹이면 어긋난다 (당일 재구성은 raw끼리가 정합).
- 지수로 회귀하고 집행은 선물로 한다 (§14.3): KQ150 선물 일봉이 짧고 연결선물은 롤 점프
  보정이 필요. 지수 β ≈ 선물 β (베이시스 노이즈 무시).
- 관측 수익률이 MIN_OBS 미만인 신생 ETF는 통계를 내지 않고 `insufficient: True`.
  유니버스에 영숫자 신형 코드(0052D0 등)가 있으므로 코드는 **항상 문자열**로 다룬다.

캐시: 시간 TTL이 아니라 **데이터 버전**(지수 최신일, ETF 최신일) 기반 — flow_metrics와 동일
사고방식. 60초 프로브로 날짜만 확인하고, 날짜가 그대로면 패널을 재사용한다.
조회는 유니버스 36종 × HIST_BARS봉을 **IN 쿼리 1방**으로 받고 numpy로만 계산 (pandas 미사용).
괴리도 36종 × 120일 전체를 (etf, date) 집계 SQL **1방**으로 받는다.
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import time as _time
from dataclasses import dataclass
from datetime import date as _date
from pathlib import Path
from typing import Any

import numpy as np
from sqlalchemy import text

from core.database import korea_async_session

logger = logging.getLogger("uvicorn.error")

DATA_DIR = Path(__file__).parent.parent / "data"
UNIVERSE_FILE = DATA_DIR / "lp_desk_universe.json"

K200_CODE = "K2G01P"
KQ150_CODE = "Q5G01P"

WINDOW = 120          # 회귀 창 (수익률 개수)
ROLL = 60             # 상세 rolling β 창 (수익률 개수)
MIN_OBS = 40          # 이 미만이면 통계 포기 (신생 ETF)
HIST_BARS = WINDOW + ROLL + 1   # 조회 봉 수 — rolling β가 WINDOW개 나오도록
HIST_BINS = 24        # 잔차 히스토그램 bin 수

GAP_WINDOW = 120      # 괴리 분포 창 (영업일)
GAP_MIN_OBS = 60      # 유효 표본이 이 미만이면 gap_* 전부 null (§14.3)
# |gap| 상한 — 2026-08-10·11에 PDF shares가 100배로 적재돼 navʳ가 100배(= gap −9,899bp)로
# 튄 실측이 있다(전 ETF 공통). 정상 괴리는 수십 bp라 500bp는 넉넉한 이상치 컷.
GAP_ABS_MAX_BP = 500.0
GAP_HIST_BINS = 24    # 괴리 히스토그램 bin 수

_PROBE_TTL_SECS = 60.0


# ---------------------------------------------------------------------------
# 유니버스
# ---------------------------------------------------------------------------

_universe_cache: tuple[float, tuple[str, ...]] | None = None  # (mtime, codes)


def universe() -> tuple[str, ...]:
    """유니버스 코드 튜플. 파일 mtime이 바뀌면 재로드 (재기동 없이 유니버스 변경)."""
    global _universe_cache
    try:
        mtime = UNIVERSE_FILE.stat().st_mtime
    except OSError:
        logger.warning("lp_desk_universe.json 없음: %s", UNIVERSE_FILE)
        return ()
    if _universe_cache and _universe_cache[0] == mtime:
        return _universe_cache[1]
    raw = json.loads(UNIVERSE_FILE.read_text(encoding="utf-8"))
    seen: dict[str, None] = {}
    for c in raw:
        code = str(c).strip().upper()
        if code:
            seen.setdefault(code, None)
    codes = tuple(seen)
    _universe_cache = (mtime, codes)
    return codes


# ---------------------------------------------------------------------------
# 회귀 커널 (numpy)
# ---------------------------------------------------------------------------


def _finite(x: Any, digits: int | None = None) -> float | None:
    """JSON 안전 float — NaN/Inf는 None (FastAPI가 그대로 NaN을 뱉으면 잘못된 JSON).

    `digits`를 주면 반올림까지 — 시계열 배열(잔차·괴리·rolling β)에 부동소수 17자리를 그대로
    실어 보내면 /detail 페이로드가 배 가까이 부푼다 (§14.9 응답 크기 제한).
    """
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(v):
        return None
    return round(v, digits) if digits is not None else v


def _fit(y: np.ndarray, x1: np.ndarray, x2: np.ndarray) -> tuple[np.ndarray, np.ndarray, float, float]:
    """절편 포함 2-팩터 OLS. 반환 (계수[c,b1,b2], 잔차, R², 잔차 표준편차).

    잔차 표준편차는 회귀 표준오차 sqrt(SSR/(n-3)) — 절편·기울기 2개의 자유도 차감.
    절편이 있으므로 잔차 평균은 0 → z는 잔차/σ 로 바로 계산 가능.
    """
    n = y.size
    X = np.column_stack((np.ones(n), x1, x2))
    coef, *_ = np.linalg.lstsq(X, y, rcond=None)
    resid = y - X @ coef
    ss_res = float(resid @ resid)
    ss_tot = float(((y - y.mean()) ** 2).sum())
    r2 = 1.0 - ss_res / ss_tot if ss_tot > 0 else float("nan")
    sigma = math.sqrt(ss_res / max(n - 3, 1))
    return coef, resid, r2, sigma


def _histogram(values: np.ndarray, bins: int) -> dict:
    """`{bins: 경계(len=counts+1), centers, counts}` — 프론트 SVG 히스토그램용."""
    if values.size == 0:
        return {"bins": [], "centers": [], "counts": []}
    counts, edges = np.histogram(values, bins=bins)
    return {
        "bins": [_finite(e, 2) for e in edges],
        "centers": [_finite(c, 2) for c in (edges[:-1] + edges[1:]) / 2],
        "counts": [int(c) for c in counts],
    }


def _rolling_beta(y: np.ndarray, x1: np.ndarray, x2: np.ndarray, w: int) -> np.ndarray:
    """슬라이딩 창 2-팩터 β. 반환 shape (n-w+1, 2) = [β_x1, β_x2].

    창마다 lstsq를 다시 돌리면 O(n·w) — 누적합으로 정규방정식 Gram 행렬을 O(n)에 만들고
    3×3 배치 solve 1회로 끝낸다 (창 120개 × 36종을 상세 요청마다 도는 비용 회피).
    """
    n = y.size
    if n < w:
        return np.empty((0, 2))

    def win(a: np.ndarray) -> np.ndarray:
        c = np.empty(n + 1, dtype=np.float64)
        c[0] = 0.0
        np.cumsum(a, out=c[1:])
        return c[w:] - c[:-w]

    s1, s2, sy = win(x1), win(x2), win(y)
    s11, s22, s12 = win(x1 * x1), win(x2 * x2), win(x1 * x2)
    s1y, s2y = win(x1 * y), win(x2 * y)
    m = s1.size

    A = np.empty((m, 3, 3), dtype=np.float64)
    A[:, 0, 0] = float(w)
    A[:, 0, 1] = A[:, 1, 0] = s1
    A[:, 0, 2] = A[:, 2, 0] = s2
    A[:, 1, 1] = s11
    A[:, 1, 2] = A[:, 2, 1] = s12
    A[:, 2, 2] = s22
    b = np.stack((sy, s1y, s2y), axis=1)
    try:
        sol = np.linalg.solve(A, b)
    except np.linalg.LinAlgError:
        # 특이행렬(상수 구간 등) — 창별 최소자승 폴백.
        sol = np.full((m, 3), np.nan)
        for i in range(m):
            try:
                sol[i] = np.linalg.solve(A[i], b[i])
            except np.linalg.LinAlgError:
                continue
    return sol[:, 1:]


# ---------------------------------------------------------------------------
# 괴리 분포 — PDF 재구성 NAV (§14.3)
# ---------------------------------------------------------------------------

# 36종 × 창 전체를 (etf, date) 집계 **1방**으로. 구성종목 종가 결측 개수를 같은 집계에서
# 세어 두면(missing) 파이썬에서 종목 단위 재순회 없이 그날을 통째로 버릴 수 있다.
#   · 설정현금액(H00000)은 CU 전체 설정금액 summary 행이라 제외 (exit_basket·routers/etfs.py 동일 규칙)
#   · **영구 결측 레그 제외**(`priced`) — 창 전체에 일봉 종가가 하나도 없는 비현금 구성(커버드콜
#     ETF의 옵션·선물 레그 등)은 재구성 바스켓에서 아예 뺀다. 종전엔 이들이 매일 missing을 만들어
#     그 ETF의 gap이 통째로 0표본이었다. 판정은 코드 패턴이 아니라 **종가 존재 여부**
#     (lp_desk_calib._SQL_NAVR의 30초봉 판정과 같은 규칙 — 2026-08-26 사용자 확정, §14.3)
#   · CU는 그날 스냅샷 우선, 없으면 최신 (§14.3)
#   · sum()은 NULL을 건너뛰므로 남은 구성에 결측이 하나라도 있으면 gross가 과소집계 →
#     missing>0인 날은 그대로 폐기 (일시 결측 필터는 종전 그대로)
_GAP_SQL = text(
    """
    WITH pdf_all AS (
        SELECT etf_code, snapshot_date AS d, component_code, shares, is_cash
        FROM etf_portfolio_daily
        WHERE etf_code = ANY(:codes) AND snapshot_date >= :start
          AND NOT (is_cash AND component_code = 'H00000')
    ),
    priced AS (
        SELECT c.component_code
        FROM (SELECT DISTINCT component_code FROM pdf_all WHERE NOT is_cash) c
        WHERE EXISTS (
            SELECT 1 FROM ohlcv_daily o
            WHERE o.stock_code = c.component_code AND o.time >= :start AND o.close_price > 0
        )
    ),
    pdf AS (
        SELECT * FROM pdf_all
        WHERE is_cash OR component_code IN (SELECT component_code FROM priced)
    ),
    agg AS (
        SELECT pdf.etf_code, pdf.d,
               sum(CASE WHEN pdf.is_cash THEN pdf.shares::numeric
                        ELSE pdf.shares::numeric * o.close_price END) AS gross,
               count(*) FILTER (
                   WHERE NOT pdf.is_cash AND (o.close_price IS NULL OR o.close_price <= 0)
               ) AS missing
        FROM pdf
        LEFT JOIN ohlcv_daily o
               ON o.stock_code = pdf.component_code AND o.time = pdf.d
              AND o.time >= :start AND NOT pdf.is_cash
        GROUP BY 1, 2
    ),
    cu_latest AS (
        SELECT DISTINCT ON (etf_code) etf_code, creation_unit
        FROM etf_master_daily
        WHERE etf_code = ANY(:codes) AND creation_unit > 0
        ORDER BY etf_code, snapshot_date DESC
    )
    SELECT a.etf_code, a.d::text AS d, a.missing, a.gross,
           coalesce(nullif(m.creation_unit, 0), cl.creation_unit) AS cu,
           e.close_price AS etf_close
    FROM agg a
    LEFT JOIN etf_master_daily m ON m.etf_code = a.etf_code AND m.snapshot_date = a.d
    LEFT JOIN cu_latest cl       ON cl.etf_code = a.etf_code
    LEFT JOIN ohlcv_daily e      ON e.stock_code = a.etf_code AND e.time = a.d
                                AND e.time >= :start
    ORDER BY a.etf_code, a.d
    """
)


def _gap_series(rows, codes: list[str]) -> dict[str, tuple[list[str], np.ndarray]]:
    """code -> (날짜, 괴리 bp). 필터 3종(§14.3)을 통과한 날만 남긴다.

    ① 비현금 구성종목 종가 결측일 제외 (navʳ 과소집계) — 단, **창 전체에 종가가 없는 레그**는
       그날의 결측이 아니라 애초에 재구성 대상이 아니다(SQL `priced`에서 제외, §14.3)
    ② ETF 자체 종가 없는 날 제외 (당일 PDF는 종가 전에 이미 올라와 있음)
    ③ |gap| > GAP_ABS_MAX_BP 제외 (PDF 수량 100배 적재 이상 — 2026-08-10·11 실측)
    """
    acc: dict[str, tuple[list[str], list[float]]] = {c: ([], []) for c in codes}
    for r in rows:
        bucket = acc.get(r.etf_code)
        if bucket is None or r.missing:
            continue
        cu = r.cu
        close = r.etf_close
        if not cu or close is None or close <= 0 or r.gross is None:
            continue
        navr = float(r.gross) / float(cu)
        if navr <= 0:
            continue
        gap = (float(close) - navr) / navr * 1e4
        if abs(gap) > GAP_ABS_MAX_BP:
            continue
        bucket[0].append(r.d)
        bucket[1].append(gap)
    return {
        code: (ds[-GAP_WINDOW:], np.array(vs[-GAP_WINDOW:], dtype=np.float64))
        for code, (ds, vs) in acc.items()
    }


def _gap_stats(gap: tuple[list[str], np.ndarray]) -> dict:
    """gap_mean_bp / gap_sigma_bp / gap_obs. 유효표본 부족이면 mean·sigma는 null."""
    vals = gap[1]
    n = int(vals.size)
    if n < GAP_MIN_OBS:
        return {"gap_mean_bp": None, "gap_sigma_bp": None, "gap_obs": n}
    return {
        "gap_mean_bp": _finite(vals.mean(), 2),
        "gap_sigma_bp": _finite(vals.std(ddof=1), 2),
        "gap_obs": n,
    }


# ---------------------------------------------------------------------------
# 데이터 패널 (버전 캐시)
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class _Panel:
    version: tuple[str, str]
    stats_date: str
    dates: list[str]                                  # 지수 기준 날짜 축 (오름차순)
    k: np.ndarray                                     # K200 종가
    q: np.ndarray                                     # KQ150 종가
    series: dict[str, tuple[np.ndarray, np.ndarray]]  # code -> (날짜축 위치, adj_close)
    gaps: dict[str, tuple[list[str], np.ndarray]]     # code -> (날짜, 괴리 bp) 필터 통과분
    meta: dict[str, dict]                             # code -> {name, creation_unit}
    items: list[dict]                                 # /master items


_panel: _Panel | None = None
_panel_lock = asyncio.Lock()
_probe_cache: tuple[float, tuple[str, str]] | None = None
_detail_cache: dict[tuple[tuple[str, str], str], dict] = {}


async def data_version() -> tuple[str, str]:
    """(지수 최신일, 유니버스 지문 + ETF 최신일) — 캐시 무효화 키. 60초 프로브 TTL.

    유니버스 지문이 없으면 코드 추가/삭제가 버전을 안 바꿔 핫리로드가 무력화된다
    (봉 최신 날짜는 그대로이므로 — 2026-08-26 472150·417630 추가 때 실증).
    """
    global _probe_cache
    now = _time.monotonic()
    if _probe_cache and now - _probe_cache[0] < _PROBE_TTL_SECS:
        return _probe_cache[1]
    codes = list(universe())
    import hashlib
    uni_fp = f"u{len(codes)}:{hashlib.md5(','.join(codes).encode()).hexdigest()[:8]}"
    async with korea_async_session() as session:
        idx_max = (await session.execute(text(
            "SELECT max(time)::text FROM index_ohlcv_daily WHERE code = :c"
        ), {"c": K200_CODE})).scalar()
        # time 하한으로 hypertable 청크 프루닝 (유니버스 전 구간 스캔 회피).
        etf_max = (await session.execute(text(
            "SELECT max(time)::text FROM ohlcv_daily "
            "WHERE stock_code = ANY(:codes) AND time > current_date - INTERVAL '30 days'"
        ), {"codes": codes})).scalar()
    version = (idx_max or "", f"{uni_fp}|{etf_max or ''}")
    _probe_cache = (now, version)
    for key in [k for k in _detail_cache if k[0] != version]:
        _detail_cache.pop(key, None)
    return version


async def _build_panel(version: tuple[str, str]) -> _Panel:
    codes = list(universe())
    if not codes:
        raise RuntimeError("lp_desk 유니버스가 비어 있음")

    async with korea_async_session() as session:
        # ① 지수 2종 최근 HIST_BARS봉 — 창별 row_number로 한 방에.
        idx_rows = (await session.execute(text(
            """
            SELECT time::text AS d, code, close
            FROM (
                SELECT time, code, close,
                       row_number() OVER (PARTITION BY code ORDER BY time DESC) AS rn
                FROM index_ohlcv_daily
                WHERE code = ANY(:codes)
            ) t
            WHERE rn <= :n
            ORDER BY time
            """
        ), {"codes": [K200_CODE, KQ150_CODE], "n": HIST_BARS})).all()

        k_map: dict[str, float] = {}
        q_map: dict[str, float] = {}
        for r in idx_rows:
            (k_map if r.code == K200_CODE else q_map)[r.d] = float(r.close)
        dates = sorted(k_map.keys() & q_map.keys())
        if len(dates) < 2:
            raise RuntimeError("지수 일봉 부족 — K2G01P/Q5G01P 확인 필요")

        # ② ETF 36종 × 같은 구간 — IN 쿼리 1방. adj_close 결측/0은 제외
        #    (adj_close 오염 사건 §21: 0 종가가 수익률을 폭파시킴).
        etf_rows = (await session.execute(text(
            """
            SELECT time::text AS d, stock_code, adj_close
            FROM ohlcv_daily
            WHERE stock_code = ANY(:codes) AND time >= :start AND adj_close > 0
            ORDER BY stock_code, time
            """
        ), {"codes": codes, "start": _date.fromisoformat(dates[0])})).all()

        # ③ ETF 마스터 최신 snapshot (이름·CU)
        meta_rows = (await session.execute(text(
            """
            SELECT DISTINCT ON (etf_code) etf_code, kr_name, creation_unit
            FROM etf_master_daily
            WHERE etf_code = ANY(:codes)
            ORDER BY etf_code, snapshot_date DESC
            """
        ), {"codes": codes})).all()

        # ④ 괴리 분포 원자료 — PDF 재구성 NAV (§14.3). 창은 날짜 축의 최근 GAP_WINDOW일.
        gap_start = _date.fromisoformat(dates[max(0, len(dates) - GAP_WINDOW)])
        gap_rows = (await session.execute(_GAP_SQL, {"codes": codes, "start": gap_start})).all()

    pos_of = {d: i for i, d in enumerate(dates)}
    k = np.array([k_map[d] for d in dates], dtype=np.float64)
    q = np.array([q_map[d] for d in dates], dtype=np.float64)

    raw: dict[str, list[tuple[int, float]]] = {c: [] for c in codes}
    for r in etf_rows:
        i = pos_of.get(r.d)
        if i is None:
            continue  # 지수 축에 없는 날 (지수 휴장 등) — 정렬 불가
        bucket = raw.get(r.stock_code)
        if bucket is not None:
            bucket.append((i, float(r.adj_close)))

    series: dict[str, tuple[np.ndarray, np.ndarray]] = {}
    for code, pts in raw.items():
        if len(pts) < 2:
            series[code] = (np.empty(0, dtype=np.int64), np.empty(0))
            continue
        idx = np.fromiter((p[0] for p in pts), dtype=np.int64, count=len(pts))
        px = np.fromiter((p[1] for p in pts), dtype=np.float64, count=len(pts))
        series[code] = (idx, px)

    meta = {
        r.etf_code: {
            "name": (r.kr_name or "").strip(),
            "creation_unit": int(r.creation_unit) if r.creation_unit else None,
        }
        for r in meta_rows
    }

    gaps = _gap_series(gap_rows, codes)

    items = [
        _master_item(code, dates, k, q, series[code], gaps[code], meta.get(code, {}))
        for code in codes
    ]
    stats_date = max((it["last_date"] for it in items if it["last_date"]), default=dates[-1])
    return _Panel(
        version=version, stats_date=stats_date, dates=dates, k=k, q=q,
        series=series, gaps=gaps, meta=meta, items=items,
    )


def _returns(
    dates: list[str], k: np.ndarray, q: np.ndarray, serie: tuple[np.ndarray, np.ndarray]
) -> tuple[list[str], np.ndarray, np.ndarray, np.ndarray]:
    """ETF 보유 날짜에 정렬한 (수익률 날짜, ETF 수익률, K200 수익률, KQ150 수익률).

    ETF가 빠진 날(거래정지 등)은 그 종목의 연속 두 봉 사이 구간으로 처리 — 지수도 같은
    두 날짜 사이 수익률을 쓴다 (구간 복리와 동일).
    """
    idx, px = serie
    if idx.size < 2:
        return [], np.empty(0), np.empty(0), np.empty(0)
    prev, cur = idx[:-1], idx[1:]
    ry = px[1:] / px[:-1] - 1.0
    rk = k[cur] / k[prev] - 1.0
    rq = q[cur] / q[prev] - 1.0
    return [dates[i] for i in cur], ry, rk, rq


def _master_item(
    code: str,
    dates: list[str],
    k: np.ndarray,
    q: np.ndarray,
    serie: tuple[np.ndarray, np.ndarray],
    gap: tuple[list[str], np.ndarray],
    meta: dict,
) -> dict:
    rdates, ry, rk, rq = _returns(dates, k, q, serie)
    base = {
        "etf_code": code,
        "name": meta.get("name") or "",
        "creation_unit": meta.get("creation_unit"),
        "beta_k200": None,
        "beta_kq150": None,
        "r2": None,
        "resid_vol_bp": None,
        "resid_z": None,
        **_gap_stats(gap),
        "obs": len(rdates),
        "insufficient": True,
        "last_date": rdates[-1] if rdates else None,
    }
    if len(rdates) < MIN_OBS:
        return base
    n = min(WINDOW, len(rdates))
    coef, resid, r2, sigma = _fit(ry[-n:], rk[-n:], rq[-n:])
    base.update({
        "beta_k200": _finite(coef[1], 4),
        "beta_kq150": _finite(coef[2], 4),
        "r2": _finite(r2, 4),
        "resid_vol_bp": _finite(sigma * 1e4, 2),
        "resid_z": _finite(resid[-1] / sigma, 3) if sigma > 0 else None,
        "obs": n,
        "insufficient": False,
    })
    return base


async def _get_panel() -> _Panel:
    global _panel
    version = await data_version()
    panel = _panel
    if panel is not None and panel.version == version:
        return panel
    async with _panel_lock:
        if _panel is not None and _panel.version == version:
            return _panel  # 락 대기 중 다른 요청이 채움
        _panel = await _build_panel(version)
        logger.info(
            "lp_desk 통계 갱신: %d종 (stats_date=%s, version=%s)",
            len(_panel.items), _panel.stats_date, version,
        )
        return _panel


# ---------------------------------------------------------------------------
# 공개 API
# ---------------------------------------------------------------------------


async def master() -> dict:
    """/master 페이로드 — 유니버스 전 종목 회귀 통계."""
    panel = await _get_panel()
    return {
        "stats_date": panel.stats_date,
        "params": {
            "window": WINDOW, "roll": ROLL, "min_obs": MIN_OBS,
            "gap_window": GAP_WINDOW, "gap_min_obs": GAP_MIN_OBS,
        },
        "count": len(panel.items),
        "items": panel.items,
    }


async def meta_map() -> dict[str, dict]:
    """code -> {name, creation_unit}. 포지션/바스켓 라벨링용."""
    return (await _get_panel()).meta


async def detail(code: str) -> dict | None:
    """rolling β 시계열 + 잔차 시계열 + 잔차 히스토그램. 유니버스 밖이면 None."""
    panel = await _get_panel()
    if code not in panel.series:
        return None
    cached = _detail_cache.get((panel.version, code))
    if cached is not None:
        return cached

    rdates, ry, rk, rq = _returns(panel.dates, panel.k, panel.q, panel.series[code])
    gdates, gvals = panel.gaps.get(code, ([], np.empty(0)))
    meta = panel.meta.get(code, {})
    out: dict = {
        "etf_code": code,
        "name": meta.get("name") or "",
        "params": {
            "window": WINDOW, "roll": ROLL, "min_obs": MIN_OBS,
            "gap_window": GAP_WINDOW, "gap_min_obs": GAP_MIN_OBS,
        },
        "rolling_beta": [],
        "resid": [],
        "hist": {"bins": [], "centers": [], "counts": []},
        "gap": [{"date": d, "bp": _finite(v, 2)} for d, v in zip(gdates, gvals)],
        "gap_hist": _histogram(gvals, GAP_HIST_BINS) if gvals.size >= GAP_MIN_OBS
                    else {"bins": [], "centers": [], "counts": []},
        **_gap_stats((gdates, gvals)),
        "insufficient": len(rdates) < MIN_OBS,
    }
    if len(rdates) >= MIN_OBS:
        n = min(WINDOW, len(rdates))
        _, resid, _, sigma = _fit(ry[-n:], rk[-n:], rq[-n:])
        resid_bp = resid * 1e4
        out["resid"] = [
            {"date": d, "bp": _finite(v, 2)} for d, v in zip(rdates[-n:], resid_bp)
        ]
        out["resid_vol_bp"] = _finite(sigma * 1e4, 2)
        out["hist"] = _histogram(resid_bp, HIST_BINS)
        if len(rdates) >= ROLL:
            betas = _rolling_beta(ry, rk, rq, ROLL)
            out["rolling_beta"] = [
                {"date": d, "bk": _finite(b[0], 4), "bq": _finite(b[1], 4)}
                for d, b in zip(rdates[ROLL - 1:], betas)
            ]
    _detail_cache[(panel.version, code)] = out
    return out


async def warmup() -> None:
    """기동 시 사전 계산 (§14.3 '기동 시 + 날짜 바뀌면 재계산')."""
    await master()
