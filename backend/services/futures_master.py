"""주식선물 마스터 데이터 로더.

데이터 출처: Finance_Data DB의 일배치가 매일 새벽 5:30 KST에 `data/futures_master.json` 갱신.
LENS는 그 파일을 read-only로 읽기만 함.

이전 (~2026-05-13): LENS backend가 LS API t8401/t8402 직접 호출
변경 후: Finance_Data 측이 daily_update 끝에 JSON export (단일 진실원)
"""
from __future__ import annotations

import json
from pathlib import Path

DATA_DIR = Path(__file__).parent.parent.parent / "data"
MASTER_FILE = DATA_DIR / "futures_master.json"


def load_master() -> dict | None:
    """저장된 JSON 파일 로드. 없으면 None."""
    if not MASTER_FILE.exists():
        return None
    try:
        return json.loads(MASTER_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


async def ensure_master() -> dict:
    """마스터 데이터 로드. 파일이 없으면 503 RuntimeError.
    Finance_Data 측 daily_update가 매일 새벽 5:30 KST에 자동 갱신하므로
    LENS 측 fetch 로직 없음."""
    master = load_master()
    if master is None:
        raise RuntimeError(
            "data/futures_master.json 없음. "
            "Finance_Data 측 daily_update 동작 확인 필요."
        )
    return master
