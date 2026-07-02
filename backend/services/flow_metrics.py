"""수급(투자자별 순매수) 지표 정본 — 프로젝트에서 유일한 정의처.

지표: 수급강도(N일) = Σ순매수금액(N일) ÷ (as-of 유통주식수 × raw 종가), bp 단위.
설계 근거: memory `project_supply_demand` (4관점 제로베이스 설계 통합안) +
`reference_lpmm_supply_postmortem` (과거 실패 부검 — 공식은 반드시 1벌만).

불변 규약 (여기서만 바꾸고, 바꾸면 SCORE_VERSION 올릴 것):
- 분모는 raw close_price × as-of floating_shares. adj_close는 분할 시 과거가 소급
  재작성되므로 point-in-time 분모로 금지 — 수익률/차트 표시에만 사용.
- 유통주식수·시총은 base_date/time <= as_of 인 가장 최근 이력값 (look-ahead 금지).
  이력이 없으면 NULL → 랭킹 제외 (임의 backfill 금지).
- PENSION은 INSTITUTION의 부분집합 — 합산 금지 (검증: 외+기+개 일합 ≈ 0).
- 시그널 날짜 규약: D일 수급은 D일 장 마감 후 확정 → D 신호는 **D+1 시가부터**
  실행 가능. 백테스트 진입가는 반드시 D+1 open.
- 파라미터(윈도우 5/20/60, 필터 하한)는 코드 상수 — 사용자 노브로 노출 금지.

캐시: 시간 TTL이 아니라 **데이터 버전** 기반.
- 버전 프로브(자체 60s TTL): (max(time), 그 날짜 row수). 크롤러가 저녁에 적재하면
  버전이 바뀌어 다음 조회 때 자동 재계산 — cron/webhook/수동 무효화 불필요.
- is_complete 게이트: 최신일 종목 커버리지가 직전 5일 중앙값의 90% 미만이면
  as_of를 전일로 강등 (부분 수집 데이터로 랭킹 내는 것 원천 차단).
"""
from __future__ import annotations

import statistics
import time as _time
from dataclasses import dataclass
from datetime import date

from sqlalchemy import text

from core.database import korea_async_session

SCORE_VERSION = "flow-v1"
WINDOWS = (5, 20, 60)

# 유니버스 필터 프리셋 (하한은 상수 — 튜닝 금지. 체결 가능성의 전제)
PRESETS = {
    "default": {"min_adv_20d": 1_000_000_000, "min_float_mcap": 50_000_000_000},  # 거래대금 10억↑, 유통시총 500억↑
    "large": {"min_adv_20d": 1_000_000_000, "min_float_mcap": 1_000_000_000_000},  # 시총 1조↑
    "all": {"min_adv_20d": 0, "min_float_mcap": 0},
}

_PROBE_TTL_SECS = 60.0
_probe_cache: tuple[float, tuple[str, int]] | None = None  # (checked_at, (max_date, rows))
_result_cache: dict[tuple, object] = {}  # (version, kind, args...) -> result


async def data_version() -> tuple[str, int]:
    """(최신 수급 날짜, 그 날짜 row수) — 캐시 무효화 키. 60초 프로브 TTL."""
    global _probe_cache
    now = _time.monotonic()
    if _probe_cache and now - _probe_cache[0] < _PROBE_TTL_SECS:
        return _probe_cache[1]
    async with korea_async_session() as session:
        row = (await session.execute(text(
            """
            WITH m AS (SELECT max(time) AS d FROM investor_trading)
            SELECT m.d::text, (SELECT count(*) FROM investor_trading it WHERE it.time = m.d)
            FROM m
            """
        ))).one()
    version = (row[0], int(row[1]))
    _probe_cache = (now, version)
    # 버전이 바뀌면 이전 버전 결과는 자연 고아가 됨 — 주기적으로 비워 메모리 누수 방지
    for key in [k for k in _result_cache if k[0] != version]:
        _result_cache.pop(key, None)
    return version


@dataclass
class AsOfInfo:
    as_of: str            # 랭킹 기준일 (커버리지 게이트 통과한 날)
    latest: str           # DB 최신 날짜
    is_partial: bool      # 최신일이 부분 수집이라 전일로 강등됐는지
    prev: str | None      # 기준일의 직전 거래일 (NEW 뱃지 비교용)


async def resolve_as_of() -> AsOfInfo:
    """커버리지 게이트: 최신일 종목수 < 직전 5일 중앙값의 90% → 전일 강등."""
    version = await data_version()
    key = (version, "as_of")
    if key in _result_cache:
        return _result_cache[key]  # type: ignore[return-value]
    async with korea_async_session() as session:
        rows = (await session.execute(text(
            """
            SELECT time::text, count(DISTINCT stock_code) AS n
            FROM investor_trading
            WHERE time > (SELECT max(time) FROM investor_trading) - INTERVAL '21 days'
            GROUP BY time ORDER BY time
            """
        ))).all()
    dates = [r[0] for r in rows]
    counts = [int(r[1]) for r in rows]
    latest = dates[-1]
    as_of_idx = len(dates) - 1
    if len(counts) >= 4:
        baseline = statistics.median(counts[-6:-1])
        if counts[-1] < baseline * 0.9:
            as_of_idx -= 1
    info = AsOfInfo(
        as_of=dates[as_of_idx],
        latest=latest,
        is_partial=as_of_idx != len(dates) - 1,
        prev=dates[as_of_idx - 1] if as_of_idx >= 1 else None,
    )
    _result_cache[key] = info
    return info


# 랭킹 정본 쿼리 — as-of 시점의 종목별 수급 집계 + point-in-time 분모.
# rn = 종목별 최근 거래일 역순 (rn<=N = "최근 N거래일"). 130일 달력 = 60거래일 + 여유.
_RANKING_SQL = text(
    """
    WITH it AS (
        -- 외인/기관: 120거래일(장기 추세)까지 → 190일 lookback으로 딱 커버.
        -- RETAIL은 5D만 필요(분배 패턴) → 14일만 읽어 스캔량 축소.
        SELECT stock_code, investor_type, net_buy_value,
               row_number() OVER (PARTITION BY stock_code, investor_type ORDER BY time DESC) AS rn
        FROM investor_trading
        WHERE time <= CAST(:as_of AS date)
          AND (
              (investor_type IN ('FOREIGN', 'INSTITUTION')
               AND time > CAST(:as_of AS date) - INTERVAL '190 days')
              OR (investor_type = 'RETAIL'
                  AND time > CAST(:as_of AS date) - INTERVAL '14 days')
          )
    ),
    flow AS (
        SELECT stock_code,
            COALESCE(SUM(net_buy_value) FILTER (WHERE investor_type='FOREIGN' AND rn<=5), 0)  AS f_5d,
            COALESCE(SUM(net_buy_value) FILTER (WHERE investor_type='FOREIGN' AND rn<=20), 0) AS f_20d,
            COALESCE(SUM(net_buy_value) FILTER (WHERE investor_type='FOREIGN' AND rn<=60), 0) AS f_60d,
            COALESCE(SUM(net_buy_value) FILTER (WHERE investor_type='FOREIGN' AND rn<=120), 0) AS f_120d,
            COALESCE(SUM(net_buy_value) FILTER (WHERE investor_type='INSTITUTION' AND rn<=5), 0)  AS i_5d,
            COALESCE(SUM(net_buy_value) FILTER (WHERE investor_type='INSTITUTION' AND rn<=20), 0) AS i_20d,
            COALESCE(SUM(net_buy_value) FILTER (WHERE investor_type='INSTITUTION' AND rn<=60), 0) AS i_60d,
            COALESCE(SUM(net_buy_value) FILTER (WHERE investor_type='RETAIL' AND rn<=5), 0)  AS r_5d,
            COALESCE(MAX(net_buy_value) FILTER (WHERE investor_type='FOREIGN' AND rn=1), 0)     AS f_1d,
            COALESCE(MAX(net_buy_value) FILTER (WHERE investor_type='INSTITUTION' AND rn=1), 0) AS i_1d,
            -- 연속 순매수/순매도 일수: 최근일부터 부호가 끊기기 직전까지 (0 = 어제 반대부호/무거래)
            COALESCE(MIN(rn) FILTER (WHERE investor_type='FOREIGN' AND net_buy_value <= 0),
                     COUNT(*) FILTER (WHERE investor_type='FOREIGN') + 1) - 1 AS f_buy_streak,
            COALESCE(MIN(rn) FILTER (WHERE investor_type='FOREIGN' AND net_buy_value >= 0),
                     COUNT(*) FILTER (WHERE investor_type='FOREIGN') + 1) - 1 AS f_sell_streak
        FROM it
        GROUP BY stock_code
    ),
    px AS (
        SELECT stock_code,
            MAX(close_price) FILTER (WHERE rn=1)  AS close_raw,
            MAX(adj_close)   FILTER (WHERE rn=1)  AS adj_now,
            MAX(adj_close)   FILTER (WHERE rn=6)  AS adj_5d_ago,
            MAX(adj_close)   FILTER (WHERE rn=21) AS adj_20d_ago,
            COALESCE(SUM(trading_value) FILTER (WHERE rn<=5), 0) AS tv_5d,
            AVG(trading_value) FILTER (WHERE rn<=20)             AS adv_20d
        FROM (
            SELECT stock_code, close_price, adj_close, trading_value,
                   row_number() OVER (PARTITION BY stock_code ORDER BY time DESC) AS rn
            FROM ohlcv_daily
            WHERE time <= CAST(:as_of AS date)
              AND time > CAST(:as_of AS date) - INTERVAL '130 days'
        ) o
        GROUP BY stock_code
    ),
    fs AS (
        -- ⚠️ floating_shares가 2026-05-21부터 NULL 적재 (Finance_Data 크롤러 이슈).
        -- as-of는 "그 시점에 알던 가장 최근의 *유효한* 값" — NULL/0 행은 건너뜀.
        -- 유통주식수 절대값 대신 유통비율(floating/total)을 쓴다: 비율은 완만하게 변하고,
        -- 최신 시총(market_cap_daily, 매일 갱신)에 곱하면 증자·분할 후에도 분모가 정확.
        -- (실측: 027360 증자로 주식수 2배 → 묵은 절대값 분모는 bp를 2배 왜곡했음)
        SELECT DISTINCT ON (stock_code) stock_code, floating_shares, total_shares,
               base_date AS float_date
        FROM floating_shares
        WHERE base_date <= CAST(:as_of AS date)
          AND floating_shares > 0 AND total_shares > 0
        ORDER BY stock_code, base_date DESC
    ),
    mc AS (
        SELECT DISTINCT ON (stock_code) stock_code, market_cap
        FROM market_cap_daily
        WHERE time <= CAST(:as_of AS date)
          AND time > CAST(:as_of AS date) - INTERVAL '14 days'
        ORDER BY stock_code, time DESC
    )
    SELECT f.stock_code, s.stock_name, s.market, sec.fics_sector,
           mc.market_cap, fs.floating_shares, fs.total_shares, fs.float_date,
           px.close_raw, px.adj_now, px.adj_5d_ago, px.adj_20d_ago, px.tv_5d, px.adv_20d,
           f.f_1d, f.f_5d, f.f_20d, f.f_60d, f.f_120d,
           f.i_1d, f.i_5d, f.i_20d, f.i_60d, f.r_5d,
           f.f_buy_streak, f.f_sell_streak
    FROM flow f
    JOIN stocks s ON s.stock_code = f.stock_code
                 AND s.is_active
                 AND s.market IN ('KOSPI', 'KOSDAQ')
    JOIN px ON px.stock_code = f.stock_code
    LEFT JOIN fs  ON fs.stock_code = f.stock_code
    LEFT JOIN mc  ON mc.stock_code = f.stock_code
    LEFT JOIN stock_sectors sec ON sec.stock_code = f.stock_code
    """
)


def _row_to_metrics(r) -> dict | None:
    """SQL row → 지표 dict. 유통시총 없으면 None (랭킹 제외 — backfill 금지).

    분모(유통시총) = 유통비율(as-of) × 최신 시총. 시총이 없으면 유통주식수×종가 폴백.
    """
    close_raw = float(r.close_raw or 0)
    floating = float(r.floating_shares or 0)
    total = float(r.total_shares or 0)
    mcap = float(r.market_cap) if r.market_cap else 0.0
    if mcap > 0 and total > 0:
        float_mcap = mcap * (floating / total)
    else:
        float_mcap = floating * close_raw  # 폴백: 시총 이력 없을 때만
    if float_mcap <= 0:
        return None
    eok = 100_000_000  # 1억
    tv_5d = float(r.tv_5d or 0)
    adv_20d = float(r.adv_20d or 0)
    adj_now = float(r.adj_now) if r.adj_now is not None else None
    adj_prev = float(r.adj_20d_ago) if r.adj_20d_ago is not None else None
    adj_5d = float(r.adj_5d_ago) if r.adj_5d_ago is not None else None
    ret_5d = (adj_now / adj_5d - 1) * 100 if adj_now and adj_5d else None
    f_5d = float(r.f_5d)
    r_5d = float(r.r_5d)
    f_5d_bp = f_5d / float_mcap * 10_000
    f_1d, i_1d = float(r.f_1d), float(r.i_1d)
    # 부호 있는 연속일수: 어제 순매수면 +매수연속, 순매도면 -매도연속
    streak = int(r.f_buy_streak) if f_1d > 0 else (-int(r.f_sell_streak) if f_1d < 0 else 0)
    # 분배 패턴 — "조용히 무너지기 전" 신호 (매수 부호반전으로 안 잡히는 3변수 조합):
    #   외인 5일 순매도(≤ -10bp) + 주가 방어(5D 수익률 -2% 이내) + 개인이 물량 받음(순매수).
    is_distribution = (
        f_5d_bp <= -10
        and ret_5d is not None and ret_5d >= -2
        and r_5d > 0
    )
    return {
        "code": r.stock_code,
        "name": r.stock_name,
        "market": r.market,
        "sector": r.fics_sector,
        "float_date": str(r.float_date),  # 유통주식수 기준일 (신선도)
        "mcap_eok": round(float(r.market_cap) / eok) if r.market_cap else None,
        "float_mcap_eok": round(float_mcap / eok),
        "f_streak": streak,
        "f_5d_eok": round(float(r.f_5d) / eok, 1),
        "f_20d_eok": round(float(r.f_20d) / eok, 1),
        "f_60d_eok": round(float(r.f_60d) / eok, 1),
        "i_5d_eok": round(float(r.i_5d) / eok, 1),
        "i_20d_eok": round(float(r.i_20d) / eok, 1),
        "r_5d_eok": round(r_5d / eok, 1),
        "f_5d_bp": round(f_5d_bp, 1),
        "f_20d_bp": round(float(r.f_20d) / float_mcap * 10_000, 1),
        "f_60d_bp": round(float(r.f_60d) / float_mcap * 10_000, 1),
        "f_120d_bp": round(float(r.f_120d) / float_mcap * 10_000, 1),
        "f_120d_eok": round(float(r.f_120d) / eok, 1),
        "i_20d_bp": round(float(r.i_20d) / float_mcap * 10_000, 1),
        # 흡수율: 최근 5일 (외+기) 순매수가 거래대금의 몇 %를 차지했나 — 진성/소음 구분
        "absorb_5d_pct": round((float(r.f_5d) + float(r.i_5d)) / tv_5d * 100, 1) if tv_5d > 0 else None,
        "ret_20d_pct": round((adj_now / adj_prev - 1) * 100, 1) if adj_now and adj_prev else None,
        "ret_5d_pct": round(ret_5d, 1) if ret_5d is not None else None,
        "is_distribution": is_distribution,
        "y_f_eok": round(f_1d / eok, 1),
        "y_i_eok": round(i_1d / eok, 1),
        "adv_20d_eok": round(adv_20d / eok, 1),
        # 뱃지 원료
        "both_20d": float(r.f_20d) > 0 and float(r.i_20d) > 0,
        # 단기반등: 20일 순매수 상위지만 120일(장기)은 순매도 — "장기 분산+단기 반등".
        # 장투 관점 경고 (정렬은 20일 유지, 이건 맥락 뱃지). 리노공업 사례.
        "short_bounce": float(r.f_20d) > 0 and float(r.f_120d) < 0,
        "long_up": float(r.f_120d) > 0,  # 장기 정합 필터용
        # 진입권/매도권 — 트레이더 설계의 지속성 임계 (상수, 튜닝 금지):
        #   20D ≥ ±15bp AND (연속 ≥ 3D or 5D 순매수가 20D 일평균 거래대금의 30% 이상)
        # 단일 이벤트성 스파이크(증자·블록 — 연속 끊김 + 5D 미미)를 뱃지 없음으로 구분.
        "entry_ok": (
            float(r.f_20d) / float_mcap * 10_000 >= 15
            and (streak >= 3 or (adv_20d > 0 and float(r.f_5d) >= 0.3 * adv_20d))
        ),
        "exit_ok": (
            float(r.f_20d) / float_mcap * 10_000 <= -15
            and (streak <= -3 or (adv_20d > 0 and float(r.f_5d) <= -0.3 * adv_20d))
        ),
        "_adv_20d": adv_20d,
        "_float_mcap": float_mcap,
    }


async def ranking(as_of: str) -> list[dict]:
    """as_of 기준 전 종목 수급 지표. 정렬/필터 전 원본 (버전 캐시)."""
    version = await data_version()
    key = (version, "ranking", as_of)
    if key in _result_cache:
        return _result_cache[key]  # type: ignore[return-value]
    async with korea_async_session() as session:
        # asyncpg는 CAST(:p AS date) 파라미터를 date로 인코딩 — str 금지, date 객체로
        rows = (await session.execute(_RANKING_SQL, {"as_of": date.fromisoformat(as_of)})).all()
    out = [m for r in rows if (m := _row_to_metrics(r)) is not None]
    _result_cache[key] = out
    return out


def apply_preset(rows: list[dict], preset: str) -> list[dict]:
    p = PRESETS.get(preset, PRESETS["default"])
    return [
        r for r in rows
        if r["_adv_20d"] >= p["min_adv_20d"] and r["_float_mcap"] >= p["min_float_mcap"]
    ]


# 종목 상세 시계열 — 일별 주체별 순매수 + 수정종가 (차트용, 최대 3년)
_SERIES_SQL = text(
    """
    SELECT it.time::text AS d,
           COALESCE(SUM(it.net_buy_value) FILTER (WHERE it.investor_type='FOREIGN'), 0)     AS f_net,
           COALESCE(SUM(it.net_buy_value) FILTER (WHERE it.investor_type='INSTITUTION'), 0) AS i_net,
           MAX(o.adj_open)  AS adj_open,
           MAX(o.adj_high)  AS adj_high,
           MAX(o.adj_low)   AS adj_low,
           MAX(o.adj_close) AS adj_close
    FROM investor_trading it
    LEFT JOIN ohlcv_daily o ON o.stock_code = it.stock_code AND o.time = it.time
    WHERE it.stock_code = :code
      AND it.time > CAST(:as_of AS date) - CAST(:days || ' days' AS interval)
      AND it.time <= CAST(:as_of AS date)
    GROUP BY it.time
    ORDER BY it.time
    """
)


async def series(code: str, as_of: str, days: int) -> list[dict]:
    version = await data_version()
    key = (version, "series", code, as_of, days)
    if key in _result_cache:
        return _result_cache[key]  # type: ignore[return-value]
    async with korea_async_session() as session:
        rows = (await session.execute(
            _SERIES_SQL,
            {"code": code, "as_of": date.fromisoformat(as_of), "days": str(days)},
        )).all()
    eok = 100_000_000
    cum_f = cum_i = 0.0
    out = []
    for r in rows:
        cum_f += float(r.f_net)
        cum_i += float(r.i_net)
        out.append({
            "d": r.d,
            "f_eok": round(float(r.f_net) / eok, 1),
            "i_eok": round(float(r.i_net) / eok, 1),
            "cum_f_eok": round(cum_f / eok, 1),
            "cum_i_eok": round(cum_i / eok, 1),
            "o": float(r.adj_open) if r.adj_open is not None else None,
            "h": float(r.adj_high) if r.adj_high is not None else None,
            "l": float(r.adj_low) if r.adj_low is not None else None,
            "adj_close": float(r.adj_close) if r.adj_close is not None else None,
        })
    _result_cache[key] = out
    return out
