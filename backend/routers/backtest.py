"""범용 전략 백테스트 API (PR-C1/C2) — catalog / run / jobs / strategies / runs.

- 지표 정의·태그 판정은 services/backtest 어댑터(공식 1벌)에만. 라우터는 얇은 소비자.
- run은 전략 JSON을 검증(422 필드 에러) 후 job 제출 → job_id 반환. 무거운 빌드/시뮬은
  백그라운드 job (동시 1개). strategies CRUD·실행 이력은 lens.db(store.py).
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import ValidationError

from services.backtest import adapters, jobs, panel, store
from services.backtest.schema import Strategy, iter_condition_fields, iter_conditions

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
        "operators": [">", ">=", "<", "<=", "==", "is_true", "is_false",
                      "rank_pct_top", "rank_pct_bottom"],
        "panel_meta": panel.get_cached_meta(),  # 빌드 전이면 None
        "notes": {
            "cost_bps_default": 25,
            "portfolio_modes": ["event_study", "portfolio"],
            "benchmarks": ["universe_avg", "kospi", "kosdaq", "none"],
            "max_positions_default": 20,
        },
    }


def _validate_fields(spec: Strategy) -> None:
    """카탈로그 대조 필드 검증 (422). 지표 존재 + rank_pct/rank_by 지표 유형 제약."""
    cat = adapters.full_catalog()
    valid = {c["key"] for c in cat}
    bool_fields = {c["key"] for c in cat if c.get("unit") == "bool"}

    errors = [
        {"loc": path.split("."), "field": fkey, "msg": f"알 수 없는 지표 '{fkey}'"}
        for path, fkey in iter_condition_fields(spec)
        if fkey not in valid
    ]
    # rank_pct는 bool(태그) 지표에 불허 — 횡단면 순위는 수치 지표만.
    for path, c in iter_conditions(spec):
        if c.op in ("rank_pct_top", "rank_pct_bottom") and c.field in bool_fields:
            errors.append({"loc": path.split("."), "field": c.field,
                           "msg": f"'{c.op}'는 bool 지표에 사용할 수 없다 (수치 지표만)"})
    # portfolio rank_by도 카탈로그에 있어야 (있으면 검증; 없으면 코드순).
    rb = spec.portfolio.rank_by
    if rb is not None and rb not in valid:
        errors.append({"loc": ["portfolio", "rank_by"], "field": rb,
                       "msg": f"알 수 없는 rank_by 지표 '{rb}'"})
    if errors:
        raise HTTPException(422, detail=errors)


@router.post("/run")
async def run(payload: dict) -> dict:
    """전략 JSON → job_id. 스키마/필드 검증 실패 시 422 + 필드 단위 메시지.

    payload에 optional `strategy_id`(전략과 run 연결). Strategy 스키마 밖 키라 검증 전 분리.
    """
    payload = dict(payload)
    strategy_id = payload.pop("strategy_id", None)
    try:
        spec = Strategy.model_validate(payload)
    except ValidationError as e:
        # include_context=False: 커스텀 model_validator의 ValueError 객체(ctx.error)가 JSON
        # 직렬화 불가 → 제외해야 422 응답이 정상 렌더된다 (Portfolio ADV 캡 both-or-neither 등).
        # input도 제외: NaN 등 JSON 비호환 입력값이 detail에 실리면 응답 직렬화가 500이 된다.
        errs = [{k: v for k, v in err.items() if k != "input"}
                for err in e.errors(include_url=False, include_context=False)]
        raise HTTPException(422, detail=errs)

    _validate_fields(spec)

    if strategy_id is not None and await store.get_strategy(strategy_id) is None:
        raise HTTPException(404, f"unknown strategy: {strategy_id}")

    job_id = jobs.submit(spec, strategy_id=strategy_id)
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


# ── 전략 저장 (lens.db) ──────────────────────────────────────────────────────
@router.post("/strategies")
async def save_strategy(payload: dict) -> dict:
    """전략 저장 — {name, spec}. 이름 중복이면 단순 upsert(새 버전 아님, updated_at 갱신).

    spec은 Strategy 스키마로 검증(422). name은 payload.name 우선, 없으면 spec.name.
    """
    spec_payload = payload.get("spec")
    if not isinstance(spec_payload, dict):
        raise HTTPException(422, detail=[{"loc": ["spec"], "msg": "spec(dict)이 필요하다"}])
    try:
        spec = Strategy.model_validate(spec_payload)
    except ValidationError as e:
        # include_context=False: 커스텀 model_validator의 ValueError 객체(ctx.error)가 JSON
        # 직렬화 불가 → 제외해야 422 응답이 정상 렌더된다 (Portfolio ADV 캡 both-or-neither 등).
        # input도 제외: NaN 등 JSON 비호환 입력값이 detail에 실리면 응답 직렬화가 500이 된다.
        errs = [{k: v for k, v in err.items() if k != "input"}
                for err in e.errors(include_url=False, include_context=False)]
        raise HTTPException(422, detail=errs)
    _validate_fields(spec)

    name = (payload.get("name") or spec.name or "").strip()
    if not name:
        raise HTTPException(422, detail=[{"loc": ["name"], "msg": "name이 필요하다"}])

    return await store.upsert_strategy(name, spec.model_dump(mode="json"))


@router.get("/strategies")
async def list_strategies() -> list[dict]:
    return await store.list_strategies()


@router.get("/strategies/{sid}")
async def get_strategy(sid: str) -> dict:
    s = await store.get_strategy(sid)
    if s is None:
        raise HTTPException(404, f"unknown strategy: {sid}")
    return s


@router.delete("/strategies/{sid}")
async def delete_strategy(sid: str) -> dict:
    ok = await store.delete_strategy(sid)
    if not ok:
        raise HTTPException(404, f"unknown strategy: {sid}")
    return {"deleted": sid}


@router.post("/strategies/{sid}/unlock-holdout")
async def unlock_holdout(sid: str) -> dict:
    """저장 전략의 holdout 구간을 개봉(1회성). 개봉 후 실행은 spec_hash가 개봉 시점과 일치할 때만
    전체 기간 측정. 이미 개봉된 전략은 409 (재개봉 불가 — 우회 차단)."""
    res = await store.unlock_holdout(sid)
    if res is None:
        raise HTTPException(404, f"unknown strategy: {sid}")
    if res.get("already"):
        raise HTTPException(409, detail="이미 holdout이 개봉된 전략이다 (재개봉 불가).")
    return {"unlocked": sid, **res}


@router.get("/runs")
async def list_runs(strategy_id: str | None = None, limit: int = 50) -> list[dict]:
    """실행 이력 (최신순). strategy_id 필터·limit."""
    limit = max(1, min(int(limit), 200))
    return await store.list_runs(strategy_id, limit)
