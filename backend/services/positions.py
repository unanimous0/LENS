"""포지션 추적 (SQLite).

stat-arb-engine.md §7 스키마. 4 테이블:
  - positions          : 포지션 헤더 + 진입 시 통계량 freeze
  - position_legs      : 양쪽 leg (종목/방향/수량/진입가)
  - position_loans     : leg별 대여 송출 기록
  - position_snapshots : 시계열 — 채우는 로직은 PR18 (PR16은 테이블만)

저장소 backend/data/lens.db (loan_rates와 같은 파일). stdlib sqlite3 + asyncio.to_thread.

PR16 범위:
  - 스키마 ensure
  - POST / GET 리스트 / GET 상세 / DELETE
  - close / timeline / snapshot 채우기는 PR18~19
"""
from __future__ import annotations

import asyncio
import json
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any

DATA_DIR = Path(__file__).parent.parent / "data"
DB_FILE = DATA_DIR / "lens.db"


def _now_ms() -> int:
    return int(time.time() * 1000)


def _connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    # PRAGMA는 connection scope — 매번 적용.
    # WAL: 같은 DB 파일을 loan_rates도 쓰므로 동시 쓰기 시 'database is locked' 회피.
    # busy_timeout: WAL이어도 짧은 잠금 충돌 가능 (체크포인트 등) → 5초 대기.
    # foreign_keys: positions↔legs/loans/snapshots CASCADE에 필수.
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _ensure_schema_sync() -> None:
    with _connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS positions (
                id          TEXT PRIMARY KEY,
                label       TEXT,
                status      TEXT NOT NULL,         -- 'open' | 'closed'
                opened_at   INTEGER NOT NULL,
                closed_at   INTEGER,
                left_key    TEXT NOT NULL,         -- 'S:005930' 등 series_key
                right_key   TEXT NOT NULL,
                entry_z     REAL,
                entry_stats_json TEXT,             -- 진입 시점 통계량 freeze (z/alpha/beta/half_life/adf/r2)
                note        TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
            CREATE INDEX IF NOT EXISTS idx_positions_opened_at ON positions(opened_at);

            CREATE TABLE IF NOT EXISTS position_legs (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                position_id   TEXT NOT NULL,
                asset_type    TEXT NOT NULL,        -- 'S' | 'E' | 'I' | 'F' (series_key prefix)
                code          TEXT NOT NULL,
                side          INTEGER NOT NULL,     -- +1 long, -1 short
                weight        REAL NOT NULL,        -- 페어 1:β 비율 또는 사용자 설정
                qty           INTEGER NOT NULL,
                entry_price   REAL NOT NULL,
                exit_price    REAL,
                FOREIGN KEY (position_id) REFERENCES positions(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_legs_position ON position_legs(position_id);

            CREATE TABLE IF NOT EXISTS position_loans (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                position_id TEXT NOT NULL,
                leg_id      INTEGER NOT NULL,
                qty         INTEGER NOT NULL,
                rate_pct    REAL NOT NULL,
                started_at  INTEGER NOT NULL,
                ended_at    INTEGER,
                FOREIGN KEY (position_id) REFERENCES positions(id) ON DELETE CASCADE,
                FOREIGN KEY (leg_id) REFERENCES position_legs(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_loans_position ON position_loans(position_id);

            CREATE TABLE IF NOT EXISTS position_snapshots (
                position_id        TEXT NOT NULL,
                ts                 INTEGER NOT NULL,
                mark_pnl           REAL,
                loan_pnl           REAL,
                z_score            REAL,
                coint_p            REAL,
                hedge_ratio_drift  REAL,
                PRIMARY KEY (position_id, ts),
                FOREIGN KEY (position_id) REFERENCES positions(id) ON DELETE CASCADE
            );
            """
        )
        conn.commit()


async def ensure_schema() -> None:
    await asyncio.to_thread(_ensure_schema_sync)


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------

def _list_sync(status: str | None) -> list[dict]:
    with _connect() as conn:
        if status:
            rows = conn.execute(
                "SELECT * FROM positions WHERE status = ? ORDER BY opened_at DESC",
                (status,),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM positions ORDER BY opened_at DESC"
            ).fetchall()
        return [_row_to_position(dict(r)) for r in rows]


async def list_positions(status: str | None = None) -> list[dict]:
    return await asyncio.to_thread(_list_sync, status)


def _get_one_sync(pos_id: str) -> dict | None:
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM positions WHERE id = ?", (pos_id,)
        ).fetchone()
        if not row:
            return None
        pos = _row_to_position(dict(row))
        legs = conn.execute(
            "SELECT * FROM position_legs WHERE position_id = ? ORDER BY id",
            (pos_id,),
        ).fetchall()
        loans = conn.execute(
            "SELECT * FROM position_loans WHERE position_id = ? ORDER BY id",
            (pos_id,),
        ).fetchall()
        pos["legs"] = [dict(r) for r in legs]
        pos["loans"] = [dict(r) for r in loans]
        return pos


async def get_one(pos_id: str) -> dict | None:
    return await asyncio.to_thread(_get_one_sync, pos_id)


def _row_to_position(row: dict) -> dict:
    """entry_stats_json 디코드 + 키 정리."""
    stats_json = row.get("entry_stats_json")
    if stats_json:
        try:
            row["entry_stats"] = json.loads(stats_json)
        except json.JSONDecodeError:
            row["entry_stats"] = None
    else:
        row["entry_stats"] = None
    row.pop("entry_stats_json", None)
    return row


def _create_sync(payload: dict) -> str:
    """positions + legs + (선택) loans 트랜잭션 INSERT.

    payload 구조 (router에서 검증 거쳐서 들어옴):
        {
            label, note, left_key, right_key, entry_z, entry_stats (dict),
            legs: [{asset_type, code, side, weight, qty, entry_price,
                    loan: {qty, rate_pct} | None}, ...]
        }
    """
    pos_id = uuid.uuid4().hex
    now = _now_ms()
    stats_json = json.dumps(payload.get("entry_stats") or {})
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO positions (id, label, status, opened_at, left_key, right_key,
                                   entry_z, entry_stats_json, note)
            VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?)
            """,
            (
                pos_id,
                payload.get("label"),
                now,
                payload["left_key"],
                payload["right_key"],
                payload.get("entry_z"),
                stats_json,
                payload.get("note"),
            ),
        )
        for leg in payload["legs"]:
            cur = conn.execute(
                """
                INSERT INTO position_legs (position_id, asset_type, code, side,
                                           weight, qty, entry_price)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    pos_id,
                    leg["asset_type"],
                    leg["code"],
                    leg["side"],
                    leg["weight"],
                    leg["qty"],
                    leg["entry_price"],
                ),
            )
            leg_id = cur.lastrowid
            loan = leg.get("loan")
            if loan:
                conn.execute(
                    """
                    INSERT INTO position_loans (position_id, leg_id, qty, rate_pct, started_at)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (pos_id, leg_id, loan["qty"], loan["rate_pct"], now),
                )
        conn.commit()
    return pos_id


async def create(payload: dict) -> str:
    return await asyncio.to_thread(_create_sync, payload)


def _delete_sync(pos_id: str) -> bool:
    with _connect() as conn:
        cur = conn.execute("DELETE FROM positions WHERE id = ?", (pos_id,))
        conn.commit()
        return cur.rowcount > 0


async def delete(pos_id: str) -> bool:
    return await asyncio.to_thread(_delete_sync, pos_id)


def _update_note_sync(pos_id: str, note: str | None, label: str | None) -> bool:
    """note / label 부분 업데이트. 둘 다 None이면 변경 없음 → False."""
    if note is None and label is None:
        return False
    sets: list[str] = []
    params: list = []
    if note is not None:
        sets.append("note = ?")
        params.append(note)
    if label is not None:
        sets.append("label = ?")
        params.append(label)
    params.append(pos_id)
    with _connect() as conn:
        cur = conn.execute(
            f"UPDATE positions SET {', '.join(sets)} WHERE id = ?", params
        )
        conn.commit()
        return cur.rowcount > 0


async def update_note(pos_id: str, note: str | None, label: str | None) -> bool:
    return await asyncio.to_thread(_update_note_sync, pos_id, note, label)


def _close_sync(pos_id: str, leg_exits: dict[int, float], note: str | None) -> str:
    """포지션 청산 트랜잭션. leg_exits: {leg_id: exit_price}.

    - position.status='closed', closed_at=now
    - 각 leg.exit_price 업데이트
    - 미종료 position_loans.ended_at=now
    - note 비어있지 않으면 기존 note에 합치지 않고 *덮어쓰기* (단순화)

    반환: 에러 메시지 (성공이면 빈 문자열).
    """
    now = _now_ms()
    with _connect() as conn:
        # BEGIN IMMEDIATE — close idempotency. 두 client가 동시 close 호출 시
        # 둘 다 status='open' 본 후 둘 다 UPDATE 발생 방지. WAL + busy_timeout과 조합.
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT id, status FROM positions WHERE id = ?", (pos_id,)
        ).fetchone()
        if not row:
            return f"position not found: {pos_id}"
        if row["status"] != "open":
            return f"position already closed: {pos_id}"

        # leg 검증 — 모든 leg가 정확히 한 번 청산 (partial close 미지원: stat-arb-engine.md §2 #11)
        leg_rows = conn.execute(
            "SELECT id FROM position_legs WHERE position_id = ?", (pos_id,)
        ).fetchall()
        valid_ids = {r["id"] for r in leg_rows}
        if set(leg_exits.keys()) != valid_ids:
            return (
                f"all legs must be closed in one shot (no partial close). "
                f"expected leg ids {sorted(valid_ids)}, got {sorted(leg_exits.keys())}"
            )

        # leg.exit_price 업데이트
        for lid, price in leg_exits.items():
            conn.execute(
                "UPDATE position_legs SET exit_price = ? WHERE id = ? AND position_id = ?",
                (price, lid, pos_id),
            )

        # 미종료 loans 종료 처리
        conn.execute(
            "UPDATE position_loans SET ended_at = ? WHERE position_id = ? AND ended_at IS NULL",
            (now, pos_id),
        )

        # positions 헤더
        if note is not None:
            conn.execute(
                "UPDATE positions SET status='closed', closed_at=?, note=? WHERE id=?",
                (now, note, pos_id),
            )
        else:
            conn.execute(
                "UPDATE positions SET status='closed', closed_at=? WHERE id=?",
                (now, pos_id),
            )
        conn.commit()
    return ""


async def close(pos_id: str, leg_exits: dict[int, float], note: str | None) -> str:
    return await asyncio.to_thread(_close_sync, pos_id, leg_exits, note)


def _active_leg_codes_sync() -> list[str]:
    """활성(open) 포지션의 모든 leg 종목 코드 (중복 제거). realtime 영구 sub용."""
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT DISTINCT l.code
            FROM position_legs l
            JOIN positions p ON p.id = l.position_id
            WHERE p.status = 'open'
            """
        ).fetchall()
        return [r["code"] for r in rows]


async def active_leg_codes() -> list[str]:
    return await asyncio.to_thread(_active_leg_codes_sync)


# ---------------------------------------------------------------------------
# Validation helpers (router에서 사용)
# ---------------------------------------------------------------------------

ALLOWED_ASSET_TYPES = {"S", "E", "I", "F"}


def validate_payload(payload: dict[str, Any]) -> list[str]:
    """등록 페이로드 검증. 에러 리스트 (빈 리스트면 OK)."""
    errors: list[str] = []
    for fld in ("left_key", "right_key"):
        if not payload.get(fld):
            errors.append(f"{fld} required")
    legs = payload.get("legs")
    if not isinstance(legs, list) or len(legs) < 2:
        errors.append("legs must be a list of length >= 2")
        return errors
    for i, leg in enumerate(legs):
        if leg.get("asset_type") not in ALLOWED_ASSET_TYPES:
            errors.append(f"legs[{i}].asset_type invalid: {leg.get('asset_type')}")
        if not leg.get("code"):
            errors.append(f"legs[{i}].code required")
        if leg.get("side") not in (1, -1):
            errors.append(f"legs[{i}].side must be +1 or -1")
        try:
            qty = int(leg.get("qty", 0))
            if qty <= 0:
                errors.append(f"legs[{i}].qty must be > 0")
        except (TypeError, ValueError):
            errors.append(f"legs[{i}].qty must be integer")
        try:
            price = float(leg.get("entry_price", 0))
            if price <= 0:
                errors.append(f"legs[{i}].entry_price must be > 0")
        except (TypeError, ValueError):
            errors.append(f"legs[{i}].entry_price must be numeric")
        loan = leg.get("loan")
        if loan is not None:
            try:
                lqty = int(loan.get("qty", 0))
                lrate = float(loan.get("rate_pct", 0))
                if lqty <= 0:
                    errors.append(f"legs[{i}].loan.qty must be > 0")
                if lrate < 0 or lrate > 1000:
                    errors.append(f"legs[{i}].loan.rate_pct out of range")
            except (TypeError, ValueError):
                errors.append(f"legs[{i}].loan fields must be numeric")
    return errors
