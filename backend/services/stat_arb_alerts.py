"""통계차익 목표 z 도달 알림 (워치리스트) — SQLite.

스윙 진입 판단은 일봉 z인데 장중 내내 화면을 볼 수 없으니, 관심 페어에 목표 z를
걸어두고 프론트가 라이브 z를 감시한다. **감시·발화는 프론트(탭이 열린 동안)** 담당이고
여기는 워치 항목 저장 + 마지막 발화 시각 기록만 한다 (서버 푸시 아님).

저장소 backend/data/lens.db (positions·loan_rates와 같은 파일). stdlib sqlite3 +
asyncio.to_thread — positions.py 패턴 동일.

direction:
  'abs'   |z| >= target_z   (양방향, 기본)
  'above'  z  >= target_z   (right 고평가 쪽만)
  'below'  z  <= -target_z  (right 저평가 쪽만)
target_z는 항상 양수 임계로 저장한다 (below도 양수로 넣고 부호는 direction이 결정).
"""
from __future__ import annotations

import asyncio
import sqlite3
from datetime import datetime
from pathlib import Path

DATA_DIR = Path(__file__).parent.parent / "data"
DB_FILE = DATA_DIR / "lens.db"

DIRECTIONS = ("abs", "above", "below")


def _now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    # positions.py와 동일 — 같은 DB 파일을 여럿이 쓰므로 WAL + busy_timeout.
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


def _ensure_schema_sync() -> None:
    with _connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS stat_arb_alerts (
                id                INTEGER PRIMARY KEY AUTOINCREMENT,
                left_key          TEXT NOT NULL,
                right_key         TEXT NOT NULL,
                left_name         TEXT,
                right_name        TEXT,
                target_z          REAL NOT NULL,              -- 양수 임계 (예: 2.0)
                direction         TEXT NOT NULL DEFAULT 'abs',-- 'abs' | 'above' | 'below'
                enabled           INTEGER NOT NULL DEFAULT 1,
                note              TEXT,
                created_at        TEXT NOT NULL,
                last_triggered_at TEXT
            );

            CREATE UNIQUE INDEX IF NOT EXISTS ux_alert_pair_dir
                ON stat_arb_alerts(left_key, right_key, direction);
            """
        )
        conn.commit()


async def ensure_schema() -> None:
    await asyncio.to_thread(_ensure_schema_sync)


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------


def _row(r: sqlite3.Row) -> dict:
    d = dict(r)
    d["enabled"] = bool(d["enabled"])
    return d


def _list_sync() -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM stat_arb_alerts ORDER BY created_at DESC, id DESC"
        ).fetchall()
        return [_row(r) for r in rows]


async def list_alerts() -> list[dict]:
    return await asyncio.to_thread(_list_sync)


def _get_sync(alert_id: int) -> dict | None:
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM stat_arb_alerts WHERE id = ?", (alert_id,)
        ).fetchone()
        return _row(row) if row else None


async def get_one(alert_id: int) -> dict | None:
    return await asyncio.to_thread(_get_sync, alert_id)


def _create_sync(payload: dict) -> dict:
    """같은 (left_key, right_key, direction)이면 UPSERT — 목표/이름/메모 갱신 후 재활성화.

    created_at은 최초 등록 시각 유지 (충돌 시 갱신 안 함).
    last_triggered_at도 유지 — 목표만 바꾼 경우 발화 이력이 사라지면 혼란.
    """
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO stat_arb_alerts
                (left_key, right_key, left_name, right_name, target_z, direction,
                 enabled, note, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
            ON CONFLICT(left_key, right_key, direction) DO UPDATE SET
                target_z   = excluded.target_z,
                left_name  = COALESCE(excluded.left_name, stat_arb_alerts.left_name),
                right_name = COALESCE(excluded.right_name, stat_arb_alerts.right_name),
                note       = COALESCE(excluded.note, stat_arb_alerts.note),
                enabled    = 1
            """,
            (
                payload["left_key"],
                payload["right_key"],
                payload.get("left_name"),
                payload.get("right_name"),
                payload["target_z"],
                payload["direction"],
                payload.get("note"),
                _now_iso(),
            ),
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM stat_arb_alerts WHERE left_key = ? AND right_key = ? AND direction = ?",
            (payload["left_key"], payload["right_key"], payload["direction"]),
        ).fetchone()
    if row is None:  # pragma: no cover — UPSERT 직후엔 항상 존재
        raise RuntimeError("alert upsert succeeded but row not found")
    return _row(row)


async def create_alert(payload: dict) -> dict:
    return await asyncio.to_thread(_create_sync, payload)


def _update_sync(alert_id: int, fields: dict) -> dict | None:
    """target_z / enabled / note 부분 수정. 변경 필드 없으면 현재 row 그대로 반환."""
    sets: list[str] = []
    params: list = []
    if "target_z" in fields:
        sets.append("target_z = ?")
        params.append(fields["target_z"])
    if "enabled" in fields:
        sets.append("enabled = ?")
        params.append(1 if fields["enabled"] else 0)
    if "note" in fields:
        sets.append("note = ?")
        params.append(fields["note"])
    with _connect() as conn:
        if sets:
            params.append(alert_id)
            conn.execute(
                f"UPDATE stat_arb_alerts SET {', '.join(sets)} WHERE id = ?", params
            )
            conn.commit()
        row = conn.execute(
            "SELECT * FROM stat_arb_alerts WHERE id = ?", (alert_id,)
        ).fetchone()
        return _row(row) if row else None


async def update_alert(alert_id: int, fields: dict) -> dict | None:
    return await asyncio.to_thread(_update_sync, alert_id, fields)


def _delete_sync(alert_id: int) -> bool:
    with _connect() as conn:
        cur = conn.execute("DELETE FROM stat_arb_alerts WHERE id = ?", (alert_id,))
        conn.commit()
        return cur.rowcount > 0


async def delete_alert(alert_id: int) -> bool:
    return await asyncio.to_thread(_delete_sync, alert_id)


def _mark_triggered_sync(alert_id: int, ts: str) -> dict | None:
    with _connect() as conn:
        conn.execute(
            "UPDATE stat_arb_alerts SET last_triggered_at = ? WHERE id = ?",
            (ts, alert_id),
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM stat_arb_alerts WHERE id = ?", (alert_id,)
        ).fetchone()
        return _row(row) if row else None


async def mark_triggered(alert_id: int) -> dict | None:
    return await asyncio.to_thread(_mark_triggered_sync, alert_id, _now_iso())
