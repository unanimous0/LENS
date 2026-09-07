"""LP 데스크 API — lp-system-design.md §14.9. prefix `/api/lp-desk`.

  GET    /master              유니버스 36종 회귀 통계 (β·R²·잔차) + 괴리 분포 + 인트라데이 캘리브
  GET    /detail/{etf_code}   rolling β / 잔차·괴리·s·g 분포 / s 경로 / PDF 상위 10
  GET    /universe            유니버스 코드 (디버깅·프론트 부트스트랩)
  GET    /export.xlsx         파라미터 엑셀 (내부망 반입 — β·호가 밴드 + OMS 조건변수 + DDE 결합 수식, §14.11)
  GET    /fills               ETF 체결 목록          POST /fills        등록
  DELETE /fills/{id}          삭제
  GET    /hedge-fills         선물 체결 목록         POST /hedge-fills  등록
  DELETE /hedge-fills/{id}    삭제
  GET    /positions           per-ETF + 헤지 계약 합산
  GET    /exit-basket         정리 미리보기 (넷팅 주식 바스켓 + 선물 레그)

실시간 시세·계약수 환산(§14.4)·호가 산식(§14.5 호가 층 — iNAV × (1+x), x = μ_g ± z·σ_comb)은
프론트 몫 — 서버는 β·포지션과 **캘리브 층**(g μ/σ·s 증분 σ·일별 극값·분위수·전일종가+신선도)까지만.
캘리브가 없거나 실패해도
`calib: null`로만 degrade하고 통계 응답 자체는 살린다 (§14.9).
"""
from __future__ import annotations

import io
import logging
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from services import lp_desk, lp_desk_calib, lp_desk_export, lp_desk_stats
from services.stock_code import normalize_stock_code

logger = logging.getLogger("uvicorn.error")

router = APIRouter(prefix="/lp-desk", tags=["lp-desk"])


def _normalize_universe_code(code: str) -> str:
    """입력 코드를 유니버스 코드로 정규화 (A접두/ISIN 허용, memory `feedback_symbol_input`).
    유니버스 밖이면 빈 문자열 — 36행 화면이라 오타를 조용히 저장하지 않는다."""
    norm = normalize_stock_code(code)
    return norm if norm in lp_desk_stats.universe() else ""


# ---------------------------------------------------------------------------
# 통계
# ---------------------------------------------------------------------------


@router.get("/universe")
async def get_universe() -> dict:
    codes = lp_desk_stats.universe()
    return {"count": len(codes), "codes": list(codes)}


@router.get("/master")
async def get_master() -> dict:
    try:
        return lp_desk_calib.decorate_master(await lp_desk_stats.master())
    except Exception as e:  # noqa: BLE001 — Finance_Data 미가용 시 화면 전체가 죽지 않게 503
        logger.warning("lp_desk master 실패: %s", e)
        raise HTTPException(503, f"LP 데스크 통계 산출 실패: {e}")


@router.post("/calib/refresh")
async def post_calib_refresh(force: bool = Query(True, description="false면 데이터 버전이 바뀐 경우에만 재계산")) -> dict:
    """캘리브 재계산 (§14.5 배치 층). 평소엔 기동 시 + 1시간 주기 자동."""
    try:
        cal = await lp_desk_calib.refresh(force=force)
    except Exception as e:  # noqa: BLE001
        logger.warning("lp_desk calib refresh 실패: %s", e)
        raise HTTPException(503, f"캘리브레이션 실패: {e}")
    if cal is None:
        raise HTTPException(503, "캘리브레이션 산출 불가 — 30초봉/근월물 데이터 없음")
    return {
        "params": cal.params(),
        # count = **호가를 낼 수 있는 종목 수**(호가 중심 μ_g 보유). s는 참고 축이라 따로 센다.
        "count": sum(1 for v in cal.items.values() if v and v.get("g_mean_bp") is not None),
        "s_count": sum(1 for v in cal.items.values() if v and v.get("s_quantiles")),
    }


@router.get("/detail/{etf_code}")
async def get_detail(etf_code: str) -> dict:
    code = _normalize_universe_code(etf_code)
    if not code:
        raise HTTPException(404, f"유니버스 밖 ETF: {etf_code}")
    try:
        detail = await lp_desk_stats.detail(code)
        if detail is None:
            raise HTTPException(404, f"통계 없음: {etf_code}")
        return lp_desk_calib.decorate_detail(code, {**detail, "pdf_top": await lp_desk.pdf_top(code)})
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001 — Finance_Data 미가용 시 행 펼침만 실패하고 표는 살린다
        logger.warning("lp_desk detail(%s) 실패: %s", code, e)
        raise HTTPException(503, f"LP 데스크 상세 산출 실패: {e}")


@router.get("/export.xlsx")
async def get_export(
    z: float = Query(
        lp_desk_export.Z_DEFAULT, ge=0.25, le=4.0,
        description="호가 폭 σ 배수 — 범위는 프론트 튜너 Z_MIN~Z_MAX(0.25~4)와 동일",
    ),
    horizon: int = Query(lp_desk_export.HORIZON_DEFAULT, description="σ_r 지평(초) — 서버가 직접 측정한 지평만"),
    intraday_cap_won: int = Query(
        lp_desk_export.INTRADAY_CAP_WON_DEFAULT, ge=1_000_000, le=100_000_000_000,
        description="OMS 시트 C(재고한도) 산출용 장중 재고 상한(원). 전 종목 동일 — C = 상한 ÷ 전일종가, 100주 내림",
    ),
) -> StreamingResponse:
    """파라미터 엑셀 (§14.11 내부망 반입).

    실집행은 LENS가 없는 내부망에서 한다 — β·호가 밴드 같은 **정적 파라미터만** 값으로 넘기고,
    체결·시세·선물가는 내부망 엑셀이 DDE로 받아 워크북 수식이 헤지 계약수를 낸다. 매크로 없음.
    `OMS` 시트는 같은 밴드를 함수 전략 v1.1의 조건변수 **A~D**(% 단위)로 옮겨 적은 것 (매일 아침 반입용).

    x는 화면과 어긋나면 안 되므로 프론트 튜너(z·지평)를 그대로 받아 같은 산식으로 채운다.
    캘리브가 없으면 x가 전부 빈칸인 파일이 나가므로 **503** — 조용히 반쪽짜리를 내보내지 않는다.
    """
    if horizon not in lp_desk_calib.S_DIFF_HORIZONS:
        raise HTTPException(400, f"지평은 {list(lp_desk_calib.S_DIFF_HORIZONS)} 중 하나여야 합니다: {horizon}")
    try:
        master = lp_desk_calib.decorate_master(await lp_desk_stats.master())
    except Exception as e:  # noqa: BLE001 — Finance_Data 미가용
        logger.warning("lp_desk export 통계 조회 실패: %s", e)
        raise HTTPException(503, f"LP 데스크 통계 산출 실패: {e}")
    if not master.get("calib_params"):
        raise HTTPException(503, "캘리브레이션 없음 — 호가 밴드를 채울 수 없습니다 (POST /calib/refresh 후 재시도)")

    blob = lp_desk_export.build_workbook(
        master, z=z, horizon=horizon, intraday_cap_won=intraday_cap_won
    )
    name = lp_desk_export.filename()
    return StreamingResponse(
        io.BytesIO(blob),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": f'attachment; filename="{name}"',
            "Content-Length": str(len(blob)),
            "Cache-Control": "no-store",
        },
    )


# ---------------------------------------------------------------------------
# 체결
# ---------------------------------------------------------------------------


class FillIn(BaseModel):
    etf_code: str
    qty: int = Field(..., description="± 수량 (매수 +, 매도 −). 0 불가")
    price: float = Field(..., gt=0)
    entry_inav: float | None = Field(None, gt=0)
    # 진입 시점 지수선물가 (§14.6 헤지 상대성과의 기준점). 프론트가 실시간 값을 첨부,
    # 시세 미수신이면 null — 그 포지션은 edge 산출에서 빠진다.
    entry_k200: float | None = Field(None, gt=0)
    entry_kq150: float | None = Field(None, gt=0)
    note: str | None = None
    ts: str | None = None


class HedgeFillIn(BaseModel):
    contract: Literal["MK200", "KQ150F"]
    qty: int
    price: float = Field(..., gt=0)
    note: str | None = None
    ts: str | None = None


@router.get("/fills")
async def get_fills(etf_code: str | None = None, limit: int = Query(500, ge=1, le=5000)) -> dict:
    code = None
    if etf_code:
        code = _normalize_universe_code(etf_code)
        if not code:
            raise HTTPException(404, f"유니버스 밖 ETF: {etf_code}")
    items = await lp_desk.list_fills(code, limit)
    return {"count": len(items), "items": items}


@router.post("/fills")
async def post_fill(body: FillIn) -> dict:
    if body.qty == 0:
        raise HTTPException(400, "qty must be non-zero")
    code = _normalize_universe_code(body.etf_code)
    if not code:
        raise HTTPException(400, f"유니버스 밖 ETF: {body.etf_code}")
    return await lp_desk.add_fill(
        code, body.qty, body.price, body.entry_inav, body.note, body.ts,
        entry_k200=body.entry_k200, entry_kq150=body.entry_kq150,
    )


@router.delete("/fills/{fill_id}")
async def remove_fill(fill_id: int) -> dict:
    if not await lp_desk.delete_fill(fill_id):
        raise HTTPException(404, f"fill not found: {fill_id}")
    return {"deleted": True}


@router.get("/hedge-fills")
async def get_hedge_fills(limit: int = Query(500, ge=1, le=5000)) -> dict:
    items = await lp_desk.list_hedge_fills(limit)
    return {"count": len(items), "items": items}


@router.post("/hedge-fills")
async def post_hedge_fill(body: HedgeFillIn) -> dict:
    if body.qty == 0:
        raise HTTPException(400, "qty must be non-zero")
    return await lp_desk.add_hedge_fill(body.contract, body.qty, body.price, body.note, body.ts)


@router.delete("/hedge-fills/{fill_id}")
async def remove_hedge_fill(fill_id: int) -> dict:
    if not await lp_desk.delete_hedge_fill(fill_id):
        raise HTTPException(404, f"hedge fill not found: {fill_id}")
    return {"deleted": True}


# ---------------------------------------------------------------------------
# 포지션 / 출구 바스켓
# ---------------------------------------------------------------------------


@router.get("/positions")
async def get_positions() -> dict:
    pos = await lp_desk.positions()
    # 이름·CU는 통계 패널 메타 재사용 (별도 PG 왕복 없음). 통계 실패해도 포지션은 살린다.
    try:
        meta = await lp_desk_stats.meta_map()
    except Exception as e:  # noqa: BLE001
        logger.warning("lp_desk positions 메타 조회 실패: %s", e)
        meta = {}
    for row in pos["positions"]:
        m = meta.get(row["etf_code"], {})
        row["name"] = m.get("name") or ""
        row["creation_unit"] = m.get("creation_unit")
    return pos


@router.get("/exit-basket")
async def get_exit_basket() -> dict:
    try:
        return await lp_desk.exit_basket()
    except Exception as e:  # noqa: BLE001
        logger.warning("lp_desk exit-basket 실패: %s", e)
        raise HTTPException(503, f"출구 바스켓 산출 실패: {e}")
