"""주식선물 대체 캐리 — 통계차익 페어의 **매수 종목**을 주식선물로 바꾸면 얼마 이득인지.

발굴 유니버스에 선물을 넣는 게 아니다. 이미 발굴된 현물 페어에 "이 종목을 선물로 대체하면
현금이 덜 묶여 이자를 번다"를 원/주 단위로 붙이는 부가 지표 (stat-arb-engine.md §23).

만기 보유 기준, 현물 매수 대비 선물 매수의 순이득:

    r_eff            = r × (1 − margin)              # 증거금으로 묶이는 현금은 이자를 못 번다
    basis_theory     = spot × r_eff × d/365 − div_sum
    basis_now        = 선물 종가 − 현물가 (= futures_ohlcv_daily.underlying_basis)
    carry_advantage  = basis_theory − basis_now      # 원/주. 양수 = 선물이 유리(백워데이션)
    carry_bp         = carry_advantage / spot × 1e4
    carry_bp_per_day = carry_bp / d

- 이자 항을 따로 더하지 않는다 — 이론 베이시스에 이미 들어있다 (중복 계산 금지).
- 배당은 **만기까지의 확정분(div_sum)만** 숫자에 들어간다. 만기 후 배당락은 롤 이후 월물
  가격에 이미 프라이싱돼 있어 여기서 또 빼면 이중 반영 — 대신 가시화용으로만 내려준다
  (upcoming_dividends / past_dividends).
- 대여요율/대차 항은 넣지 않는다 (대여 송출이 안 나갈 가능성이 높아 사용자 결정으로 제외).
- 롤 규칙: front 잔존일 < ROLL_MIN_DAYS 면 back 월물 (만기일 당일 front를 잡으면 d=0).
  선택한 월물의 코드와 DB 일봉의 contract_code가 다르면(롤 경계일) 그 종목은 **제외**한다 —
  틀린 숫자보다 빈 값이 낫다. 제외 수는 응답 skipped_roll_mismatch.
- 롤을 반복하며 길게 들고 갈 때를 위해 향후 1년 확정 배당(만기 후 포함)과 지난 1년 이력을
  같이 내려준다. 이력은 아직 미공시인 정기배당(12월 결산 등)의 **힌트일 뿐 확정이 아니다**.

데이터는 전부 일봉 스냅샷(Finance_Data PG, read-only) — 실시간이 아니다.
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta

from sqlalchemy import text

from core.database import korea_async_session
from services.futures_master import load_master

# 회사금리 2.8% — LP 시스템(lp-system-design.md §금리, routers/lp.py base_rate_annual)과 동일 컨벤션.
DEFAULT_RATE = 0.028
# 주식선물 증거금률(대용 포함 개시증거금 근사). 이만큼의 현금은 묶여 이자를 못 번다.
DEFAULT_MARGIN = 0.15
# front 잔존일이 이 미만이면 back 월물 사용 (만기일 당일 = 0일 → 캐리 정의 불가).
ROLL_MIN_DAYS = 2
# 스냅샷 캐시. 원본은 일봉이라 장중 안 바뀌지만, 배당/날짜 경계를 위해 짧게 잡음.
CACHE_TTL_SEC = 600.0
# 최근 이 거래일 안에 선물 일봉이 없으면 제외 (상장폐지·거래 없는 계약).
RECENT_TRADING_DAYS = 5
# 유동성 참고용 평균 구간 (거래일).
AVG_TRADING_DAYS = 30
# futures_ohlcv_daily.trading_value 단위 = 천원 (volume×close×multiplier 대비 실측 ≈1000배).
TRADING_VALUE_UNIT_WON = 1000
# 배당 가시화 창(일) — 향후/과거 각각 이 기간. 캐리 숫자와 무관, 롤 판단용 표시 전용.
DIV_WINDOW_DAYS = 365


@dataclass(slots=True)
class CarryRow:
    """rate/margin 과 무관한 원자료 1종목분. 공식만 다시 씌우면 되도록 분리."""

    base_code: str
    name: str
    market: str
    futures_code: str
    contract: str  # 'front' | 'back'
    expiry: str  # YYYYMMDD
    days_left: int
    multiplier: float
    spot: float
    futures_close: float
    basis_now: float
    div_sum: float  # 만기까지의 확정 배당 합 — **이론가에 반영되는 유일한 배당 항**
    avg_value_30d: float  # 원. 근월물(NEAR) 기준 — 아래 _load_snapshot 주석 참조
    data_date: str
    # 배당 가시화 전용 (숫자 미반영). 응답 그대로 나가도록 스냅샷에서 미리 직렬화한다 —
    # 매 요청 재가공을 없애기 위함이고, 읽기 전용으로만 쓴다.
    upcoming_dividends: list[dict]  # 오늘 < ex_date ≤ +1년 (만기 내·후 모두. 구분은 프론트)
    past_dividends: list[dict]  # 오늘 −1년 ≤ ex_date ≤ 오늘 (미공시 정기배당 힌트)


@dataclass(slots=True)
class CarrySnapshot:
    asof: str  # 선물 일봉 최신 거래일
    today: date  # 스냅샷을 만든 날 (배당·잔존일 기준)
    rows: list[CarryRow]
    skipped_roll_mismatch: int  # 마스터 월물 ≠ DB 최신 일봉 계약 → 제외한 종목 수


class _Cache:
    snapshot: CarrySnapshot | None = None
    fetched_at: float = 0.0


_cache = _Cache()
_load_lock = asyncio.Lock()


def _parse_expiry(s: str) -> date | None:
    try:
        return datetime.strptime(s, "%Y%m%d").date()
    except (ValueError, TypeError):
        return None


def _div_json(rows: list[tuple[date, float]]) -> list[dict]:
    """배당 (ex_date, amount) 목록 → 날짜순 JSON 형태."""
    return [
        {"ex_date": ed.isoformat(), "amount": round(a, 2)}
        for ed, a in sorted(rows, key=lambda x: x[0])
    ]


def _pick_contract(item: dict, today: date) -> tuple[str, dict, int] | None:
    """롤 규칙 적용 — (contract, leg, days_left). 쓸 계약이 없으면 None.

    master의 days_left는 export 시점(새벽) 값이라 신뢰하지 않고 expiry로 재계산한다.
    """
    for name in ("front", "back"):
        leg = item.get(name)
        if not isinstance(leg, dict) or not leg.get("code"):
            continue
        exp = _parse_expiry(str(leg.get("expiry", "")))
        if exp is None:
            continue
        d = (exp - today).days
        if name == "front" and d < ROLL_MIN_DAYS:
            continue  # 만기 임박 — back으로 롤
        if d <= 0:
            continue
        return name, leg, d
    return None


async def _load_snapshot(today: date) -> CarrySnapshot:
    """전 종목 원자료 배치 로드 (종목별 루프 쿼리 없음 — 총 5쿼리)."""
    master = load_master()
    items = (master or {}).get("items") or []
    if not items:
        raise RuntimeError("data/futures_master.json 없음/비어있음 — Finance_Data daily_update 확인")

    # base_code → (contract, leg, days_left)
    picks: dict[str, tuple[str, dict, int]] = {}
    meta: dict[str, dict] = {}
    for it in items:
        base = str(it.get("base_code") or "").strip()
        if not base:
            continue
        pick = _pick_contract(it, today)
        if pick is None:
            continue
        picks[base] = pick
        meta[base] = it

    async with korea_async_session() as session:
        # ① 거래일 축 — 최근 N일. 5거래일(신선도) / 30거래일(유동성 평균) 경계를 정확히 잡는다.
        dates = [
            r[0]
            for r in (
                await session.execute(
                    text(
                        "SELECT DISTINCT time FROM futures_ohlcv_daily "
                        "ORDER BY time DESC LIMIT :n"
                    ),
                    {"n": AVG_TRADING_DAYS},
                )
            ).all()
        ]
        if not dates:
            raise RuntimeError("futures_ohlcv_daily 비어있음")
        asof: date = dates[0]
        recent_min = dates[min(RECENT_TRADING_DAYS, len(dates)) - 1]
        avg_min = dates[-1]

        # ② 기초주식코드(6자리) → underlying_code(2자리). 개별주식(L)만.
        u_rows = (
            await session.execute(
                text(
                    "SELECT underlying_code, stock_code FROM futures_underlyings "
                    "WHERE underlying_type = 'L' AND stock_code IS NOT NULL"
                )
            )
        ).all()
        by_stock: dict[str, str] = {}
        for r in u_rows:
            code = str(r.stock_code).strip().zfill(6)
            by_stock[code] = str(r.underlying_code).strip()

        ucodes = sorted({by_stock[b] for b in picks if b in by_stock})
        if not ucodes:
            raise RuntimeError("futures_underlyings 매핑 0건")

        # ③ 종목×월물별 최신 1행 (NEAR/NEXT 둘 다 받아 선택은 파이썬에서).
        #    contract_code를 같이 받아 **마스터가 고른 월물과 같은 계약인지 검증**한다. 롤 경계일
        #    (만기 다음 영업일 장중)에는 마스터 front가 이미 신규 월물인데 DB 최신 NEAR는 만기
        #    소멸한 구월물이라, 라벨(NEAR/NEXT)만 믿으면 엉뚱한 계약의 베이시스를 붙이게 된다.
        last_rows = (
            await session.execute(
                text(
                    "SELECT DISTINCT ON (underlying_code, contract_class) "
                    "  underlying_code, contract_class, contract_code, time, close, "
                    "  underlying_basis "
                    "FROM futures_ohlcv_daily "
                    "WHERE underlying_code = ANY(:codes) AND time >= :since "
                    "ORDER BY underlying_code, contract_class, time DESC"
                ),
                {"codes": ucodes, "since": recent_min},
            )
        ).all()
        last: dict[tuple[str, str], tuple[date, float, float, str]] = {}
        for r in last_rows:
            if r.close is None or r.underlying_basis is None:
                continue
            last[(str(r.underlying_code), str(r.contract_class))] = (
                r.time,
                float(r.close),
                float(r.underlying_basis),
                str(r.contract_code or "").strip(),
            )

        # ④ 유동성 참고 — **근월물(NEAR) 30거래일 평균 거래대금**. 선택 월물이 back일 때
        #    NEXT 평균을 쓰면 아직 원월물이던 기간이 섞여 유동성이 실제보다 훨씬 낮게 보인다
        #    (실측: 2026-08-07 BH NEAR 894억 vs NEXT 4.4억). 롤 후에는 그 계약이 근월물이 되므로
        #    연속 근월 계열이 "이 종목 주식선물이 얼마나 도나"의 대표값.
        avg_rows = (
            await session.execute(
                text(
                    "SELECT underlying_code, AVG(trading_value) AS avg_tv "
                    "FROM futures_ohlcv_daily "
                    "WHERE underlying_code = ANY(:codes) AND contract_class = 'NEAR' "
                    "  AND time >= :since AND trading_value IS NOT NULL "
                    "GROUP BY underlying_code"
                ),
                {"codes": ucodes, "since": avg_min},
            )
        ).all()
        avg_tv = {str(r.underlying_code): float(r.avg_tv or 0.0) for r in avg_rows}

        # ⑤ 배당 — 지난 1년 ~ 향후 1년의 확정 현금배당 1쿼리. 만기 컷(div_sum)·과거/미래
        #    분류는 파이썬에서. 만기가 1년보다 멀 리는 없지만 div_sum이 잘리지 않게 상한을
        #    가장 먼 만기까지 늘려 잡고, 표시용 upcoming만 1년으로 자른다.
        max_expiry = max(_parse_expiry(p[1]["expiry"]) or today for p in picks.values())
        horizon = today + timedelta(days=DIV_WINDOW_DAYS)
        div_rows = (
            await session.execute(
                text(
                    "SELECT code, ex_date, amount FROM dividends "
                    "WHERE is_latest AND dividend_type = 'CASH' "
                    "  AND code = ANY(:codes) AND ex_date >= :since AND ex_date <= :until"
                ),
                {
                    "codes": sorted(picks.keys()),
                    "since": today - timedelta(days=DIV_WINDOW_DAYS),
                    "until": max(horizon, max_expiry),
                },
            )
        ).all()
    # 종목별 (미래, 과거) 배당. 미래는 div_sum(만기 컷)과 표시용 upcoming 양쪽에 쓰인다.
    divs: dict[str, tuple[list[tuple[date, float]], list[tuple[date, float]]]] = {}
    for r in div_rows:
        code = str(r.code).strip().zfill(6)
        bucket = divs.setdefault(code, ([], []))
        bucket[0 if r.ex_date > today else 1].append((r.ex_date, float(r.amount or 0.0)))

    rows: list[CarryRow] = []
    skipped_roll_mismatch = 0
    for base, (contract, leg, days_left) in picks.items():
        ucode = by_stock.get(base)
        if not ucode:
            continue  # 선물 상장 종목인데 매핑 없음 (마스터-DB 시차) → 제외
        cls = "NEAR" if contract == "front" else "NEXT"
        hit = last.get((ucode, cls))
        if hit is None:
            continue  # 최근 5거래일 데이터 없음 → 제외
        data_date, close, basis_now, contract_code = hit
        code = str(leg.get("code") or "").strip()
        if contract_code != code:
            # 롤 경계 불일치 — 다른 계약의 종가/베이시스를 붙이느니 이 종목을 아예 뺀다.
            skipped_roll_mismatch += 1
            continue
        spot = close - basis_now
        if spot <= 0:
            continue
        exp = _parse_expiry(str(leg.get("expiry", "")))
        future_divs, past_divs = divs.get(base, ([], []))
        div_sum = sum(a for ed, a in future_divs if exp and ed <= exp)
        it = meta[base]
        rows.append(
            CarryRow(
                base_code=base,
                name=str(it.get("base_name") or ""),
                market=str(it.get("market") or ""),
                futures_code=code,
                contract=contract,
                expiry=str(leg.get("expiry") or ""),
                days_left=days_left,
                multiplier=float(leg.get("multiplier") or 0.0),
                spot=spot,
                futures_close=close,
                basis_now=basis_now,
                div_sum=div_sum,
                avg_value_30d=avg_tv.get(ucode, 0.0) * TRADING_VALUE_UNIT_WON,
                data_date=data_date.isoformat(),
                upcoming_dividends=_div_json([d for d in future_divs if d[0] <= horizon]),
                past_dividends=_div_json(past_divs),
            )
        )

    rows.sort(key=lambda r: r.base_code)
    return CarrySnapshot(
        asof=asof.isoformat(),
        today=today,
        rows=rows,
        skipped_roll_mismatch=skipped_roll_mismatch,
    )


async def get_snapshot() -> CarrySnapshot:
    """캐시된 원자료 스냅샷. TTL 만료 또는 날짜가 바뀌면 재적재."""
    today = date.today()
    snap = _cache.snapshot
    if (
        snap is not None
        and snap.today == today
        and time.monotonic() - _cache.fetched_at < CACHE_TTL_SEC
    ):
        return snap
    async with _load_lock:
        snap = _cache.snapshot  # 락 대기 중 다른 코루틴이 채웠을 수 있음
        if (
            snap is not None
            and snap.today == today
            and time.monotonic() - _cache.fetched_at < CACHE_TTL_SEC
        ):
            return snap
        loaded = await _load_snapshot(today)
        _cache.snapshot = loaded
        _cache.fetched_at = time.monotonic()
        return loaded


def compute(snap: CarrySnapshot, rate: float, margin: float) -> dict:
    """스냅샷 + (rate, margin) → 응답 dict. 계산이 가벼워 매 요청 재적용한다."""
    r_eff = rate * (1.0 - margin)
    items: dict[str, dict] = {}
    for row in snap.rows:
        basis_theory = row.spot * r_eff * row.days_left / 365.0 - row.div_sum
        carry_advantage = basis_theory - row.basis_now
        carry_bp = carry_advantage / row.spot * 1e4
        items[row.base_code] = {
            "name": row.name,
            "market": row.market,
            "futures_code": row.futures_code,
            "contract": row.contract,
            "expiry": row.expiry,
            "days_left": row.days_left,
            "multiplier": row.multiplier,
            "spot": round(row.spot, 2),
            "futures_close": round(row.futures_close, 2),
            "basis_now": round(row.basis_now, 2),
            "basis_theory": round(basis_theory, 2),
            "div_sum": round(row.div_sum, 2),
            "carry_advantage": round(carry_advantage, 2),
            "carry_bp": round(carry_bp, 3),
            "carry_bp_per_day": round(carry_bp / row.days_left, 4),
            "avg_value_30d": round(row.avg_value_30d),
            "data_date": row.data_date,
            # 가시화 전용 — 만기 후 배당은 carry_* 어디에도 안 들어간다 (§23.1).
            "upcoming_dividends": row.upcoming_dividends,
            "past_dividends": row.past_dividends,
        }
    return {
        "asof": snap.asof,
        "rate": rate,
        "margin": margin,
        "r_eff": round(r_eff, 6),
        "count": len(items),
        # 롤 경계일 진단용 — 마스터 월물과 DB 최신 일봉 계약이 달라 제외한 종목 수. 평시 0.
        "skipped_roll_mismatch": snap.skipped_roll_mismatch,
        "items": items,
    }
