"""배당 추정 (LENS 측 휴리스틱).

전제: DB(Finance_Data)는 DART 확정 배당만 보관. 미래 예상 배당은 LENS가 매 요청마다 동적 계산.

규칙:
1. 각 (종목, period) 쌍별로 가장 최근 확정 배당을 본다.
2. 그 ex_date에서 1년 / 2년 뒤 같은 날짜를 후보로 삼고, [today, today+12개월] 안에 들어오면 추정.
3. 금액은 작년 동일 period 그대로 (보수적 가정).
4. 정관 A형은 히스토리 2건 미만이면 skip (추정 신뢰도 낮음).
5. 이미 확정 배당이 있는 (code, period, year)는 skip (중복 방지).

추정 결과는 confirmed=False, source='ESTIMATE'로 표시 → 프론트가 노란빛+예 배지로 자동 구분.
"""
from __future__ import annotations

from datetime import date


def estimate_dividends(items: list[dict], today: date) -> list[dict]:
    """과거 배당 패턴으로 미래 배당 추정 리스트 반환."""
    # (code, period)별로 그룹화 — is_latest=True + 확정만 (이미 추정인 건 다시 추정하지 않음)
    by_key: dict[tuple[str, str], list[dict]] = {}
    for d in items:
        if not d.get("is_latest", True):
            continue
        if not d.get("ex_date"):
            continue
        if not d.get("confirmed", True):
            continue
        key = (d["code"], d["period"])
        by_key.setdefault(key, []).append(d)

    # 중복 방지용 인덱스 — 이미 actual에 있는 (code, period, year)
    existing: set[tuple[str, str, int]] = set()
    for d in items:
        ex = d.get("ex_date")
        if ex:
            try:
                year = int(ex[:4])
                existing.add((d["code"], d["period"], year))
            except ValueError:
                pass

    horizon = today.replace(year=today.year + 1).isoformat()
    today_iso = today.isoformat()
    estimates: list[dict] = []

    for (code, period), divs in by_key.items():
        divs_sorted = sorted(divs, key=lambda d: d["ex_date"], reverse=True)
        last = divs_sorted[0]
        charter = last.get("charter_group")

        # 1건이라도 있으면 추정 — 신뢰도는 "예" 배지 + estimation_basis로 표시.
        # 너무 옛날(2년 이상 전) 마지막 배당은 회사가 그만뒀을 가능성 → skip.
        try:
            last_ex_check = date.fromisoformat(last["ex_date"])
        except (ValueError, TypeError):
            continue
        if (today - last_ex_check).days > 730:
            continue

        last_ex = last_ex_check

        # 1년 / 2년 후 동일 날짜 후보
        for years_ahead in (1, 2):
            try:
                next_ex = last_ex.replace(year=last_ex.year + years_ahead)
            except ValueError:
                # 윤년 2/29 → 2/28로 떨어뜨림
                next_ex = last_ex.replace(year=last_ex.year + years_ahead, day=28)

            next_iso = next_ex.isoformat()
            if next_iso < today_iso:
                continue
            if next_iso > horizon:
                continue

            year = next_ex.year
            if (code, period, year) in existing:
                continue
            existing.add((code, period, year))  # 1년/2년 두번 만드는 거 방지

            estimates.append({
                "id": f"est-{code}-{period}-{year}",
                "code": code,
                "name": last.get("name") or code,
                "fiscal_year": year,
                "period": period,
                "board_resolution_date": None,
                "announced_at": None,
                "record_date": None,
                "ex_date": next_iso,
                "pay_date": None,
                "amount": last.get("amount", 0),
                "yield_pct": last.get("yield_pct"),
                "dividend_type": last.get("dividend_type", "CASH"),
                "confirmed": False,
                "estimation_basis": (
                    f"작년 동일 {period}({last['ex_date']} "
                    f"{int(last.get('amount', 0)):,}원) 반복 패턴 가정"
                ),
                "charter_group": charter,
                "source": "ESTIMATE",
                "version": 1,
                "is_latest": True,
                "raw_text_url": None,
                "revisions": [],
            })

    return estimates
