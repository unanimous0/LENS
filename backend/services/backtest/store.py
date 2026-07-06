"""전략 저장 + 실행 이력 (lens.db) — backtest.md §6.

positions.py 관례 그대로: stdlib sqlite3 + asyncio.to_thread, backend/data/lens.db 공유,
PRAGMA per-connection, CREATE TABLE IF NOT EXISTS. LENS 자체 DB만 쓴다(Finance_Data 쓰기 금지).

테이블:
  - backtest_strategies(id, name UNIQUE, spec_json, created_at, updated_at)
      이름 중복 = 새 버전 아님 → 단순 upsert(spec_json·updated_at 갱신).
  - backtest_runs(id, strategy_id nullable, spec_json, spec_hash, summary_json,
                  panel_version, started_at, finished_at, status)
      **result 전체가 아니라 summary(스탯·경고·메타)만** 저장 — 에쿼티·에피소드 배열은 크므로
      제외(재실행으로 재현 가능·spec 사본 보존).

다중검정 카운터: spec_hash = 정규화 spec(name 제외)의 sha256 → 같은 조건이면 이름 달라도 같은
계열. attempts = {same_spec: 동일 hash run 수, total_runs: 전체 run 수}.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any

from .schema import Strategy

DATA_DIR = Path(__file__).resolve().parents[2] / "data"
DB_FILE = DATA_DIR / "lens.db"

# summary_json에서 제외할 무거운 배열 (재실행 재현 가능).
_HEAVY_KEYS = ("episodes",)
_HEAVY_PORTFOLIO_KEYS = ("equity_curve",)


def _now_ms() -> int:
    return int(time.time() * 1000)


def _connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    # positions.py와 동일 PRAGMA — 같은 lens.db 파일 공유(동시 쓰기 회피).
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _ensure_schema_sync() -> None:
    with _connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS backtest_strategies (
                id          TEXT PRIMARY KEY,
                name        TEXT NOT NULL UNIQUE,
                spec_json   TEXT NOT NULL,
                created_at  INTEGER NOT NULL,
                updated_at  INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS backtest_runs (
                id            TEXT PRIMARY KEY,
                strategy_id   TEXT,
                spec_json     TEXT NOT NULL,
                spec_hash     TEXT NOT NULL,
                summary_json  TEXT,
                panel_version TEXT,
                started_at    INTEGER NOT NULL,
                finished_at   INTEGER,
                status        TEXT NOT NULL,
                FOREIGN KEY (strategy_id) REFERENCES backtest_strategies(id) ON DELETE SET NULL
            );

            CREATE INDEX IF NOT EXISTS idx_bt_runs_hash ON backtest_runs(spec_hash);
            CREATE INDEX IF NOT EXISTS idx_bt_runs_strategy ON backtest_runs(strategy_id);
            CREATE INDEX IF NOT EXISTS idx_bt_runs_started ON backtest_runs(started_at);
            """
        )
        # ── C4 holdout 마이그레이션 (기존 배포 호환 — PRAGMA table_info 후 ADD COLUMN) ──
        # holdout_unlocked_at: 개봉 시각(ms), NULL=미개봉. holdout_spec_hash: 개봉 시점 spec 해시
        # (개봉 후 조건 변경으로 전체 기간을 다시 보는 우회 차단 — 실행 spec_hash 일치 시에만 전체 측정).
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(backtest_strategies)").fetchall()}
        if "holdout_unlocked_at" not in cols:
            conn.execute("ALTER TABLE backtest_strategies ADD COLUMN holdout_unlocked_at INTEGER")
        if "holdout_spec_hash" not in cols:
            conn.execute("ALTER TABLE backtest_strategies ADD COLUMN holdout_spec_hash TEXT")
        conn.commit()


async def ensure_schema() -> None:
    await asyncio.to_thread(_ensure_schema_sync)


# ── spec_hash ───────────────────────────────────────────────────────────────
def spec_hash(spec: Strategy | dict) -> str:
    """정규화(name 제외·sort_keys) spec의 sha256 — 같은 조건이면 이름 달라도 같은 계열.

    dict 입력도 **Strategy로 라운드트립**해 스키마 기본값을 채운 뒤 해싱한다 — 구 스키마로 저장된
    spec(예: C4 이전, capital_eok 필드 없음)과 실행 시 Strategy가 기본값을 채운 spec의 해시가
    일치하도록(holdout 개봉 hash 매칭 안정성). 검증 실패 시에만 원본 dict로 폴백.
    """
    if isinstance(spec, Strategy):
        d = spec.model_dump(mode="json")
    else:
        try:
            d = Strategy.model_validate(spec).model_dump(mode="json")
        except Exception:  # noqa: BLE001 — 손상/구형 spec은 원본 그대로(해시 안정성보다 실패 회피)
            d = dict(spec)
    d.pop("name", None)
    canon = json.dumps(d, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(canon.encode("utf-8")).hexdigest()


def _spec_json(spec: Strategy | dict) -> str:
    d = spec.model_dump(mode="json") if isinstance(spec, Strategy) else dict(spec)
    return json.dumps(d, ensure_ascii=False)


def summary_of(result: dict) -> dict:
    """result에서 무거운 배열 제외한 요약(스탯·경고·메타·attempts·portfolio 스탯)만."""
    out = {k: v for k, v in result.items() if k not in _HEAVY_KEYS}
    port = out.get("portfolio")
    if isinstance(port, dict):
        out["portfolio"] = {k: v for k, v in port.items() if k not in _HEAVY_PORTFOLIO_KEYS}
    return out


# ── strategies CRUD ─────────────────────────────────────────────────────────
def _upsert_strategy_sync(name: str, spec: dict) -> dict:
    now = _now_ms()
    spec_j = json.dumps(spec, ensure_ascii=False)
    with _connect() as conn:
        row = conn.execute("SELECT id, created_at FROM backtest_strategies WHERE name = ?",
                           (name,)).fetchone()
        if row:
            sid = row["id"]
            conn.execute(
                "UPDATE backtest_strategies SET spec_json = ?, updated_at = ? WHERE id = ?",
                (spec_j, now, sid))
            created = row["created_at"]
        else:
            sid = uuid.uuid4().hex
            conn.execute(
                "INSERT INTO backtest_strategies (id, name, spec_json, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?)", (sid, name, spec_j, now, now))
            created = now
        conn.commit()
    return {"id": sid, "name": name, "spec": spec, "created_at": created, "updated_at": now}


async def upsert_strategy(name: str, spec: dict) -> dict:
    return await asyncio.to_thread(_upsert_strategy_sync, name, spec)


def _row_to_strategy(row: sqlite3.Row) -> dict:
    try:
        spec = json.loads(row["spec_json"])
    except json.JSONDecodeError:
        spec = None
    keys = row.keys()
    return {"id": row["id"], "name": row["name"], "spec": spec,
            "created_at": row["created_at"], "updated_at": row["updated_at"],
            "holdout_unlocked_at": row["holdout_unlocked_at"] if "holdout_unlocked_at" in keys else None,
            "holdout_spec_hash": row["holdout_spec_hash"] if "holdout_spec_hash" in keys else None}


def _list_strategies_sync() -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM backtest_strategies ORDER BY updated_at DESC").fetchall()
    return [_row_to_strategy(r) for r in rows]


async def list_strategies() -> list[dict]:
    return await asyncio.to_thread(_list_strategies_sync)


def _get_strategy_sync(sid: str) -> dict | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM backtest_strategies WHERE id = ?", (sid,)).fetchone()
    return _row_to_strategy(row) if row else None


async def get_strategy(sid: str) -> dict | None:
    return await asyncio.to_thread(_get_strategy_sync, sid)


def _delete_strategy_sync(sid: str) -> bool:
    with _connect() as conn:
        cur = conn.execute("DELETE FROM backtest_strategies WHERE id = ?", (sid,))
        conn.commit()
        return cur.rowcount > 0


async def delete_strategy(sid: str) -> bool:
    return await asyncio.to_thread(_delete_strategy_sync, sid)


# ── holdout 개봉 (전략별 1회) ────────────────────────────────────────────────
def _unlock_holdout_sync(sid: str) -> dict | None:
    """전략의 holdout을 개봉(1회). None=미존재, {'already':True}=이미 개봉, 아니면 개봉 정보."""
    with _connect() as conn:
        row = conn.execute(
            "SELECT id, spec_json, holdout_unlocked_at FROM backtest_strategies WHERE id = ?",
            (sid,)).fetchone()
        if row is None:
            return None
        if row["holdout_unlocked_at"] is not None:
            return {"already": True, "holdout_unlocked_at": row["holdout_unlocked_at"]}
        try:
            spec = json.loads(row["spec_json"])
        except json.JSONDecodeError:
            spec = {}
        # 개봉 시점 전략 spec의 해시를 고정 저장 — 이후 실행은 이 해시와 일치할 때만 전체 기간.
        h = spec_hash(spec)
        now = _now_ms()
        # WHERE ... IS NULL + rowcount: SELECT~UPDATE 사이 동시 개봉 경합에도 1회만 성공 (TOCTOU 차단)
        cur = conn.execute(
            "UPDATE backtest_strategies SET holdout_unlocked_at = ?, holdout_spec_hash = ?"
            " WHERE id = ? AND holdout_unlocked_at IS NULL",
            (now, h, sid))
        conn.commit()
        if cur.rowcount == 0:
            return {"already": True, "holdout_unlocked_at": None}
    return {"id": sid, "holdout_unlocked_at": now, "holdout_spec_hash": h}


async def unlock_holdout(sid: str) -> dict | None:
    return await asyncio.to_thread(_unlock_holdout_sync, sid)


# ── runs 이력 + 다중검정 카운터 ──────────────────────────────────────────────
def _record_run_sync(run_id: str, strategy_id: str | None, spec_json: str, s_hash: str,
                     summary_json: str | None, panel_version: str | None,
                     started_at: int, finished_at: int | None, status: str) -> dict:
    with _connect() as conn:
        conn.execute(
            "INSERT INTO backtest_runs (id, strategy_id, spec_json, spec_hash, summary_json, "
            "panel_version, started_at, finished_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (run_id, strategy_id, spec_json, s_hash, summary_json, panel_version,
             started_at, finished_at, status))
        same = conn.execute("SELECT count(*) FROM backtest_runs WHERE spec_hash = ?",
                            (s_hash,)).fetchone()[0]
        total = conn.execute("SELECT count(*) FROM backtest_runs").fetchone()[0]
        conn.commit()
    return {"same_spec": int(same), "total_runs": int(total)}


async def record_run(*, spec: Strategy | dict, strategy_id: str | None,
                     summary: dict | None, started_at: int, finished_at: int | None,
                     status: str) -> dict:
    """run 이력 기록 후 attempts({same_spec, total_runs}) 반환. summary는 이미 trim된 요약."""
    s_hash = spec_hash(spec)
    panel_version = None
    if summary:
        pv = (summary.get("meta") or {}).get("panel_versions")
        panel_version = json.dumps(pv, ensure_ascii=False) if pv is not None else None
    summary_json = json.dumps(summary, ensure_ascii=False) if summary is not None else None
    return await asyncio.to_thread(
        _record_run_sync, uuid.uuid4().hex, strategy_id, _spec_json(spec), s_hash,
        summary_json, panel_version, started_at, finished_at, status)


def _list_runs_sync(strategy_id: str | None, limit: int) -> list[dict]:
    with _connect() as conn:
        if strategy_id:
            rows = conn.execute(
                "SELECT id, strategy_id, spec_hash, panel_version, started_at, finished_at, "
                "status, summary_json FROM backtest_runs WHERE strategy_id = ? "
                "ORDER BY started_at DESC LIMIT ?", (strategy_id, limit)).fetchall()
        else:
            rows = conn.execute(
                "SELECT id, strategy_id, spec_hash, panel_version, started_at, finished_at, "
                "status, summary_json FROM backtest_runs ORDER BY started_at DESC LIMIT ?",
                (limit,)).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        # 목록에는 summary 통계 요약만 얹어준다 (전체 payload는 무거우니 헤드라인만).
        sj = d.pop("summary_json", None)
        head = None
        if sj:
            try:
                s = json.loads(sj)
                summ = s.get("summary") or {}
                port = s.get("portfolio") or {}
                head = {
                    "n_episodes": summ.get("n_episodes"),
                    "avg_excess_pct": summ.get("avg_excess_pct"),
                    "t_value": summ.get("t_value"),
                    "cagr_pct": port.get("cagr_pct"),
                    "mdd_pct": port.get("mdd_pct"),
                    "mode": s.get("mode"),
                }
            except json.JSONDecodeError:
                head = None
        d["summary_head"] = head
        out.append(d)
    return out


async def list_runs(strategy_id: str | None = None, limit: int = 50) -> list[dict]:
    return await asyncio.to_thread(_list_runs_sync, strategy_id, limit)
