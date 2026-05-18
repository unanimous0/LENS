"""Realtime의 영구 sub set을 backend가 푸시 (Tier 1 일원화).

여러 소스의 union을 한 번에 push:
  - 활성 포지션 leg 코드 (services.positions.active_leg_codes)
  - LP 매트릭스 타겟 = DEFAULT_ETF_CODES ∪ PDF 구성종목 ∪ 매칭 주식선물 front_month

realtime의 POST /permanent-stocks는 set 전체 replace 의미라 *부분* push를 두 군데서
독립적으로 하면 서로 덮어쓰기 발생. 모든 소스의 union을 한 곳에서 계산해야 안전.

호출 시점:
  - 백엔드 startup (main.py on_event)
  - 포지션 create/delete/close (routers/positions.py)
  - LP 설정 변경 (향후 — 현재 DEFAULT_ETF_CODES 하드코딩이라 동적 변경 없음)
"""
from __future__ import annotations

import asyncio
import logging

import httpx

logger = logging.getLogger("uvicorn.error")

REALTIME_URL = "http://localhost:8200"

# fire-and-forget task ref 보존용 — asyncio.create_task 결과를 변수에 안 잡으면
# GC 가능성이 있어 RuntimeWarning 또는 task 중도 취소 위험. set에 보관 + 완료 시 자동 제거.
# https://docs.python.org/3/library/asyncio-task.html#asyncio.create_task
_pending_tasks: set[asyncio.Task] = set()


async def compute_lp_target_codes() -> set[str]:
    """LP 매트릭스가 fair_value 계산에 필요한 *추가* 구독 코드.

    realtime의 fixed 그룹(시작 시 자동 구독)에 이미 포함된 것은 제외:
      - 주식선물 마스터 base_code 약 273종목 (현물): fixed S3_/K3_로 자동
      - 주식선물 front_month 코드 약 273종목: fixed JC0_로 자동
    permanent set에 또 넣으면 LS WS sub *중복* 발생 (ref-count는 dynamic 그룹 전용 — fixed와 별개).

    포함 대상 (= fixed에 없어 별도 영구 구독 필수):
      - DEFAULT_ETF_CODES — ETF 자체 (229200, 396500 등). fixed master에 없음
      - PDF non_intersect_stocks — 주식선물 없는 PDF 구성종목 (잡주 등). fixed master에 없음
    """
    from routers.lp import DEFAULT_ETF_CODES
    from services.pdf_futures_match import get_intersect_for_etf

    codes: set[str] = set(DEFAULT_ETF_CODES)
    for etf_code in DEFAULT_ETF_CODES:
        intersect = await get_intersect_for_etf(etf_code)
        if not intersect:
            continue
        # intersect.stock_code(=master base_code) + futures_code는 fixed 그룹이 자동 구독 → 스킵
        for it in intersect.get("non_intersect_stocks", []):
            sc = it.get("code")
            if sc:
                codes.add(sc)
    return codes


async def compute_position_codes() -> set[str]:
    """활성 포지션의 leg 종목 코드 집합."""
    from services import positions

    codes = await positions.active_leg_codes()
    return set(codes)


async def sync_full_set(*, max_retries: int = 1, retry_delay_sec: float = 1.0) -> None:
    """모든 소스 union 계산 후 realtime POST /permanent-stocks (set 전체 replace).

    1회 실패 시 1초 후 재시도 (realtime 일시 다운 회복용). 그래도 실패하면 경고 로그만 —
    realtime side startup polling이 다음에 회복 시도.
    """
    try:
        lp = await compute_lp_target_codes()
        pos = await compute_position_codes()
    except Exception as e:  # noqa: BLE001
        logger.warning("permanent-stocks compute failed: %s", e)
        return

    union = sorted(lp | pos)
    last_err: Exception | None = None
    for attempt in range(max_retries + 1):
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                r = await client.post(
                    f"{REALTIME_URL}/permanent-stocks", json={"codes": union}
                )
                r.raise_for_status()
            logger.info(
                "permanent-stocks synced (attempt %d): %d codes (LP=%d, positions=%d)",
                attempt + 1, len(union), len(lp), len(pos),
            )
            return
        except Exception as e:  # noqa: BLE001
            last_err = e
            if attempt < max_retries:
                await asyncio.sleep(retry_delay_sec)
    logger.warning(
        "permanent-stocks sync failed after %d attempts: %s "
        "(realtime startup polling으로 회복 기대)",
        max_retries + 1, last_err,
    )


def schedule_sync() -> None:
    """비동기 sync_full_set을 fire-and-forget으로 스케줄. task ref GC 회피용 set 보관.

    호출 컨텍스트: 라우터 핸들러 안에서 응답 즉시 반환하고 싶을 때.
    asyncio.create_task 결과를 변수에 안 잡으면 weak ref만 남아 GC 위험 → set에 보관.
    """
    try:
        task = asyncio.create_task(sync_full_set())
        _pending_tasks.add(task)
        task.add_done_callback(_pending_tasks.discard)
    except RuntimeError:
        # 이벤트 루프 없으면 (테스트 컨텍스트 등) 무시
        logger.debug("schedule_sync: no running event loop, skipped")
