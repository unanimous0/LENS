"""배당 데이터 API.

Phase 1 (현재): data/dividends_mock.json 읽어서 메모리 캐시.
Phase 3 (추후): FINANCE_DB_URL 환경변수 있으면 PostgreSQL에서 SELECT.

캐싱 정책: 첫 요청 시 로드, 일자가 바뀌면 자동 reload (장중엔 안 바뀌니까).
"""
from __future__ import annotations

import json
import os
from datetime import date
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException

from services.dividend_estimator import estimate_dividends

router = APIRouter(prefix="/dividends", tags=["dividends"])

DATA_DIR = Path(__file__).resolve().parents[2] / "data"
MOCK_FILE = DATA_DIR / "dividends_mock.json"
EXPORT_FILE = DATA_DIR / "dividends.json"  # Finance_Data export (실제 운영 시)


class _Cache:
    loaded_on: Optional[date] = None
    src_mtime: float = 0.0
    items: list[dict] = []
    estimates: list[dict] = []  # LENS 측 추정 (DB에 없음, 매 reload 시 재계산)
    exported_at: Optional[str] = None
    name_by_code: dict[str, str] = {}


_cache = _Cache()


def _load_master_names() -> dict[str, str]:
    """종목명 매핑을 마스터에서 가져온다 (배당 응답에 종목명 주입)."""
    master_file = DATA_DIR / "futures_master.json"
    if not master_file.exists():
        return {}
    try:
        data = json.loads(master_file.read_text(encoding="utf-8"))
        return {
            item["base_code"]: item["base_name"]
            for item in data.get("items", [])
            if item.get("base_code") and item.get("base_name")
        }
    except (json.JSONDecodeError, KeyError, OSError):
        return {}


def _ensure_loaded() -> None:
    """첫 호출, 일자 변경, 또는 파일 mtime 변경 시 cache 갱신.

    daily_update가 같은 날짜에 dividends.json을 갱신하는 케이스를 잡기 위해
    mtime도 함께 비교한다. (날짜만 보면 ETL이 같은 날에 돌아도 cache stale)
    """
    today = date.today()

    # 우선순위: 실제 export 파일 → mock
    src = EXPORT_FILE if EXPORT_FILE.exists() else MOCK_FILE
    if not src.exists():
        raise HTTPException(status_code=503, detail="배당 데이터 파일 없음")

    src_mtime = src.stat().st_mtime
    if _cache.loaded_on == today and _cache.src_mtime == src_mtime:
        return

    try:
        data = json.loads(src.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=500, detail=f"배당 JSON 파싱 실패: {e}")

    _cache.items = data.get("items", [])
    _cache.exported_at = data.get("exported_at")
    _cache.name_by_code = _load_master_names()
    # 추정 배당 — 과거 패턴 기반 미래 추정. today에 의존하니 캐시 무효화 시 같이 재계산.
    _cache.estimates = estimate_dividends(_cache.items, today)
    _cache.loaded_on = today
    _cache.src_mtime = src_mtime


@router.get("")
async def list_dividends(
    code: Optional[str] = None,
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    include_stale: bool = False,
    include_estimates: bool = True,
):
    """배당 데이터 조회.

    필터:
    - code: 특정 종목코드만
    - from_date / to_date: 배당락일 기준 범위 (YYYY-MM-DD)
    - include_stale: 정정공시로 대체된 과거 버전까지 포함 (기본 False — is_latest=true만)
    - include_estimates: LENS 측 추정 배당 포함 (기본 True — source='ESTIMATE', confirmed=False)
    """
    _ensure_loaded()

    # 확정 + (옵션) 추정
    items = _cache.items + (_cache.estimates if include_estimates else [])
    if not include_stale:
        # 기본: 각 (code, fiscal_year, period) 그룹의 최신 버전만.
        # 정정 이력은 각 item.revisions 배열에 임베드돼 있음.
        items = [d for d in items if d.get("is_latest", True)]
    if code:
        items = [d for d in items if d.get("code") == code]
    if from_date:
        items = [d for d in items if (d.get("ex_date") or "") >= from_date]
    if to_date:
        items = [d for d in items if (d.get("ex_date") or "") <= to_date]

    # 종목명: Finance_Data export의 name 우선 → 마스터 fallback → 코드 fallback.
    # Finance_Data가 stocks 테이블 LEFT JOIN으로 name을 채워 보내므로 1,224/1,246 건은 그대로 사용.
    # 22건은 name=null (상폐/미등록) → 마스터 또는 코드로 떨어짐.
    def _resolve_name(d: dict) -> str:
        code = d.get("code", "")
        return d.get("name") or _cache.name_by_code.get(code) or code

    enriched = [{**d, "name": _resolve_name(d)} for d in items]
    enriched.sort(key=lambda d: d.get("ex_date") or "")

    return {
        "exported_at": _cache.exported_at,
        "source": "export" if EXPORT_FILE.exists() else "mock",
        "count": len(enriched),
        "items": enriched,
    }


@router.get("/upcoming")
async def upcoming_dividends(days: int = 90):
    """오늘부터 N일 내 배당락 예정 종목."""
    from datetime import timedelta
    today = date.today()
    end = today + timedelta(days=days)
    return await list_dividends(from_date=today.isoformat(), to_date=end.isoformat())
