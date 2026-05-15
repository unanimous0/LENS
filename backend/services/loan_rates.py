"""대여요율 수동 입력/저장 (SQLite).

LENS 자체 DB 없음 정책 — 다만 *사용자 입력 데이터*는 영속화 필요.
SQLite 파일 backend/data/lens.db. stdlib sqlite3 사용 (의존성 0).

스키마 (stat-arb-engine.md §7):
    loan_rates (
        code        TEXT PRIMARY KEY,   -- 종목코드 (6자리 정규화)
        rate_pct    REAL NOT NULL,      -- 연 % (예: 15.5)
        source      TEXT,               -- 'manual' | 'csv'
        updated_at  INTEGER NOT NULL    -- UNIX ms
    )

비동기 — `await asyncio.to_thread(...)` 로 stdlib sqlite3 워크어라운드.
대여요율은 호출 빈도 낮음 (몇 분당 1회), async 풀 사용 안 하는 게 단순.
"""
from __future__ import annotations

import asyncio
import csv
import io
import sqlite3
import time
from pathlib import Path
from typing import Iterable

from services.stock_code import normalize_stock_code as _norm_code

DATA_DIR = Path(__file__).parent.parent / "data"
DB_FILE = DATA_DIR / "lens.db"


def _now_ms() -> int:
    return int(time.time() * 1000)


def _connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    return conn


def _ensure_schema_sync() -> None:
    with _connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS loan_rates (
                code        TEXT PRIMARY KEY,
                rate_pct    REAL NOT NULL,
                source      TEXT NOT NULL DEFAULT 'manual',
                updated_at  INTEGER NOT NULL
            )
            """
        )
        conn.commit()


async def ensure_schema() -> None:
    await asyncio.to_thread(_ensure_schema_sync)


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------

def _get_all_sync() -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT code, rate_pct, source, updated_at FROM loan_rates ORDER BY code"
        ).fetchall()
        return [dict(r) for r in rows]


async def get_all() -> list[dict]:
    return await asyncio.to_thread(_get_all_sync)


def _put_sync(code: str, rate_pct: float, source: str = "manual") -> dict:
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO loan_rates (code, rate_pct, source, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(code) DO UPDATE SET
                rate_pct = excluded.rate_pct,
                source = excluded.source,
                updated_at = excluded.updated_at
            """,
            (code, rate_pct, source, _now_ms()),
        )
        conn.commit()
    return {"code": code, "rate_pct": rate_pct, "source": source}


async def put(code: str, rate_pct: float, source: str = "manual") -> dict:
    norm = _norm_code(code)
    if not norm:
        raise ValueError(f"invalid code: {code}")
    if rate_pct < 0 or rate_pct > 1000:
        raise ValueError(f"rate_pct out of range: {rate_pct}")
    return await asyncio.to_thread(_put_sync, norm, float(rate_pct), source)


def _put_many_sync(items: list[tuple[str, float, str]]) -> int:
    if not items:
        return 0
    now = _now_ms()
    with _connect() as conn:
        conn.executemany(
            """
            INSERT INTO loan_rates (code, rate_pct, source, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(code) DO UPDATE SET
                rate_pct = excluded.rate_pct,
                source = excluded.source,
                updated_at = excluded.updated_at
            """,
            [(c, r, s, now) for c, r, s in items],
        )
        conn.commit()
    return len(items)


async def put_many(items: Iterable[tuple[str, float, str]]) -> int:
    """대량 upsert. 입력은 정규화 + 검증 거쳐서 들어와야 함."""
    cleaned: list[tuple[str, float, str]] = []
    for code, rate, source in items:
        norm = _norm_code(code)
        if not norm:
            continue
        try:
            r = float(rate)
        except (TypeError, ValueError):
            continue
        if r < 0 or r > 1000:
            continue
        cleaned.append((norm, r, source or "manual"))
    return await asyncio.to_thread(_put_many_sync, cleaned)


def _delete_sync(code: str) -> bool:
    with _connect() as conn:
        cur = conn.execute("DELETE FROM loan_rates WHERE code = ?", (code,))
        conn.commit()
        return cur.rowcount > 0


async def delete(code: str) -> bool:
    norm = _norm_code(code)
    if not norm:
        return False
    return await asyncio.to_thread(_delete_sync, norm)


# ---------------------------------------------------------------------------
# CSV import
# ---------------------------------------------------------------------------

async def import_csv(content: str) -> dict:
    """CSV 텍스트 → bulk upsert.

    포맷 (헤더 필수):
        code,rate_pct
        005930,15.5
        000660,8.2
    (선택 추가 컬럼: source — 없으면 'csv')
    """
    reader = csv.DictReader(io.StringIO(content))
    items: list[tuple[str, float, str]] = []
    errors: list[str] = []
    for i, row in enumerate(reader, start=2):  # 헤더 제외, 1-based
        code = (row.get("code") or "").strip()
        rate_s = (row.get("rate_pct") or "").strip()
        source = (row.get("source") or "csv").strip() or "csv"
        if not code or not rate_s:
            errors.append(f"line {i}: code or rate_pct empty")
            continue
        try:
            rate = float(rate_s)
        except ValueError:
            errors.append(f"line {i}: rate_pct '{rate_s}' not numeric")
            continue
        items.append((code, rate, source))
    inserted = await put_many(items)
    return {"received": inserted, "errors": errors}
