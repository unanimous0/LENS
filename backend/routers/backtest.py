"""범용 전략 백테스트 API (PR-C1) — catalog / run / jobs.

- 지표 정의·태그 판정은 services/backtest 어댑터(공식 1벌)에만. 라우터는 얇은 소비자.
- run은 전략 JSON을 검증(422 필드 에러) 후 job 제출 → job_id 반환. 무거운 빌드/시뮬은
  백그라운드 job (동시 1개). strategies CRUD·실행 이력은 C2 (여기 없음).
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import ValidationError

from services.backtest import adapters, jobs, panel
from services.backtest.schema import Strategy, iter_condition_fields

router = APIRouter(prefix="/backtest", tags=["backtest"])


@router.get("/catalog")
async def catalog() -> dict:
    """네임스페이스·지표 카탈로그 (프론트 조건 빌더 드롭다운). 패널 빌드 불요 (정적)."""
    cat = adapters.full_catalog()
    namespaces: dict[str, list] = {}
    for c in cat:
        ns = c["key"].split(".", 1)[0]
        namespaces.setdefault(ns, []).append(c)
    return {
        "namespaces": list(namespaces.keys()),
        "metrics": cat,
        "operators": [">", ">=", "<", "<=", "==", "is_true", "is_false"],
        "panel_meta": panel.get_cached_meta(),  # 빌드 전이면 None
        "notes": {
            "cost_bps_default": 25,
            "portfolio_modes": ["event_study"],
            "benchmarks": ["universe_avg", "none"],
        },
    }


@router.post("/run")
async def run(payload: dict) -> dict:
    """전략 JSON → job_id. 스키마/필드 검증 실패 시 422 + 필드 단위 메시지."""
    try:
        spec = Strategy.model_validate(payload)
    except ValidationError as e:
        raise HTTPException(422, detail=e.errors(include_url=False))

    # 지표 키가 카탈로그에 존재하는지 (필드 단위)
    valid = set(adapters.field_column_map().keys())
    field_errors = [
        {"loc": path.split("."), "field": fkey, "msg": f"알 수 없는 지표 '{fkey}'"}
        for path, fkey in iter_condition_fields(spec)
        if fkey not in valid
    ]
    if field_errors:
        raise HTTPException(422, detail=field_errors)

    job_id = jobs.submit(spec)
    return {"job_id": job_id, "status": "queued"}


@router.get("/jobs/{job_id}")
async def job_status(job_id: str) -> dict:
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(404, f"unknown job: {job_id}")
    out = {"job_id": job.id, "status": job.status, "progress": job.progress}
    if job.status == "done":
        out["result"] = job.result
    elif job.status == "error":
        out["error"] = job.error
    return out
