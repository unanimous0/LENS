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

router = APIRouter(prefix="/dividends", tags=["dividends"])

DATA_DIR = Path(__file__).resolve().parents[2] / "data"
MOCK_FILE = DATA_DIR / "dividends_mock.json"
EXPORT_FILE = DATA_DIR / "dividends.json"  # Finance_Data export (실제 운영 시)


class _Cache:
    loaded_on: Optional[date] = None
    items: list[dict] = []
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
    """첫 호출 또는 일자 변경 시 cache 갱신."""
    today = date.today()
    if _cache.loaded_on == today:
        return

    # 우선순위: 실제 export 파일 → mock
    src = EXPORT_FILE if EXPORT_FILE.exists() else MOCK_FILE
    if not src.exists():
        raise HTTPException(status_code=503, detail="배당 데이터 파일 없음")

    try:
        data = json.loads(src.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=500, detail=f"배당 JSON 파싱 실패: {e}")

    _cache.items = data.get("items", [])
    _cache.exported_at = data.get("exported_at")
    _cache.name_by_code = _load_master_names()
    _cache.loaded_on = today


@router.get("")
async def list_dividends(
    code: Optional[str] = None,
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
):
    """배당 데이터 조회.

    필터:
    - code: 특정 종목코드만
    - from_date / to_date: 배당락일 기준 범위 (YYYY-MM-DD)
    """
    _ensure_loaded()

    items = _cache.items
    if code:
        items = [d for d in items if d.get("code") == code]
    if from_date:
        items = [d for d in items if (d.get("ex_date") or "") >= from_date]
    if to_date:
        items = [d for d in items if (d.get("ex_date") or "") <= to_date]

    # 종목명 주입 (마스터에 없는 코드는 코드 그대로)
    enriched = [
        {**d, "name": _cache.name_by_code.get(d.get("code", ""), d.get("code", ""))}
        for d in items
    ]
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
