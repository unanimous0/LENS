"""LP 북 원장 (SQLite) — lp-system-design.md §13.5 Phase 1.

기존 §9 `data/lp_positions.json` flat dict `{code: signed_qty}`를 lens.db 원장으로 승격.
이월 보유(carryover)와 당일 체결(fill)을 분리 추적한다.

엔트리 모델:
    {id, ts(ISO), code, instrument(etf|stock|index_fut|stock_fut),
     kind(carryover|fill), side(buy|sell), qty(양수), price(nullable), note}

현재 포지션 = 이월(carryover 부호합) + Σ 체결(fill 부호합).

저장소는 backend/data/lens.db (positions.py / loan_rates / backtest와 같은 파일).
stdlib sqlite3 + asyncio.to_thread. WAL·busy_timeout은 positions.py 패턴 그대로.

호환 계약: `GET /api/lp/positions`(Rust scheduler.rs 5초 poll)는 이 원장의
집계 net_qty를 flat dict로 반환한다. 코드 무수정. (routers/lp.py 참조)
"""
from __future__ import annotations

import asyncio
import sqlite3
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

DATA_DIR = Path(__file__).parent.parent / "data"
DB_FILE = DATA_DIR / "lens.db"

VALID_INSTRUMENTS = {"etf", "stock", "index_fut", "stock_fut"}
VALID_KINDS = {"carryover", "fill"}
VALID_SIDES = {"buy", "sell"}

# lp_meta 키: lp_positions.json → carryover 1회 이관 완료 마커.
# "원장 비어있음"을 트리거로 쓰면 사용자가 원장을 전부 비운 뒤 재기동(--reload 포함) 시
# 옛 JSON이 부활하는 유령 포지션 버그 → 키 존재 여부만으로 1회성 보장.
META_MIGRATED_KEY = "migrated_positions_json"

# startup ensure 실패 시 재기동 전까지 500 지속 방지 — lazy ensure 안전망용 플래그.
_schema_ready = False


def _connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    # WAL: 같은 DB를 positions/loan_rates/backtest도 씀 → 동시 쓰기 잠금 회피.
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


def _ensure_schema_sync() -> None:
    with _connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS lp_ledger (
                id          TEXT PRIMARY KEY,
                ts          TEXT NOT NULL,          -- ISO datetime (로컬=KST)
                code        TEXT NOT NULL,          -- 6자리(주식/ETF) 또는 8자리(A+7, 선물)
                instrument  TEXT NOT NULL,          -- etf | stock | index_fut | stock_fut
                kind        TEXT NOT NULL,          -- carryover | fill
                side        TEXT NOT NULL,          -- buy | sell
                qty         INTEGER NOT NULL,       -- 양수 (부호는 side로)
                price       REAL,                   -- 체결가/평단 (carryover는 nullable)
                note        TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_lp_ledger_code ON lp_ledger(code);
            CREATE INDEX IF NOT EXISTS idx_lp_ledger_kind ON lp_ledger(kind);
            CREATE INDEX IF NOT EXISTS idx_lp_ledger_ts   ON lp_ledger(ts);

            CREATE TABLE IF NOT EXISTS lp_meta (
                key   TEXT PRIMARY KEY,
                value TEXT
            );
            """
        )
        # 1급 시민화 컬럼들 — 멱등 ALTER (기존 DB엔 없으므로 table_info로 확인 후에만).
        #   entry_basis  : 진입 베이시스 (선물가 − 현물가, 주당 원). §13.4 베이시스 대체 기장.
        #   fv_at_fill   : 체결 시점 FV_futures 스냅샷 (§13.3-C 스프레드 수익 귀속). ETF 유니버스만.
        #   mid_at_fill  : 체결 시점 현재가(mid) 스냅샷 (markout 기준선 참고).
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(lp_ledger)").fetchall()}
        for col in ("entry_basis", "fv_at_fill", "mid_at_fill"):
            if col not in cols:
                conn.execute(f"ALTER TABLE lp_ledger ADD COLUMN {col} REAL")

        # markout 기록 (§13.3-C) — fill 후 5분/30분 경과 시점 현재가·FV 스냅샷.
        # Rust가 5초 poll 기반으로 due 마크를 계산해 POST /api/lp/fill-marks. (fill_id, horizon)
        # UNIQUE로 이중 기록 차단 → POST는 INSERT OR IGNORE 멱등.
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS lp_fill_marks (
                id        TEXT PRIMARY KEY,
                fill_id   TEXT NOT NULL,
                horizon   TEXT NOT NULL,          -- '5m' | '30m'
                price     REAL,
                fv        REAL,
                marked_at TEXT NOT NULL           -- ISO datetime (로컬=KST)
            )
            """
        )
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_lp_fill_marks_uniq "
            "ON lp_fill_marks(fill_id, horizon)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_lp_fill_marks_marked ON lp_fill_marks(marked_at)"
        )
        conn.commit()


async def ensure_schema() -> None:
    global _schema_ready
    await asyncio.to_thread(_ensure_schema_sync)
    _schema_ready = True


async def ensure_schema_once() -> None:
    """Lazy 안전망 — startup ensure 실패(잠금 등) 시 요청 경로에서 재시도.

    Rust가 5초마다 치는 GET /positions 등에서 호출. 성공 후에는 플래그로 no-op.
    """
    if not _schema_ready:
        await ensure_schema()


# ---------------------------------------------------------------------------
# meta
# ---------------------------------------------------------------------------

def _get_meta_sync(key: str) -> Optional[str]:
    with _connect() as conn:
        row = conn.execute("SELECT value FROM lp_meta WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else None


async def get_meta(key: str) -> Optional[str]:
    return await asyncio.to_thread(_get_meta_sync, key)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _signed(side: str, qty: int) -> int:
    return qty if side == "buy" else -qty


def _opt_col(row: dict, key: str):
    v = row[key] if key in row.keys() else None
    return None if v is None else float(v)


def _row_to_entry(row: dict) -> dict:
    return {
        "id": row["id"],
        "ts": row["ts"],
        "code": row["code"],
        "instrument": row["instrument"],
        "kind": row["kind"],
        "side": row["side"],
        "qty": int(row["qty"]),
        "price": None if row["price"] is None else float(row["price"]),
        "note": row["note"],
        "entry_basis": _opt_col(row, "entry_basis"),
        "fv_at_fill": _opt_col(row, "fv_at_fill"),
        "mid_at_fill": _opt_col(row, "mid_at_fill"),
    }


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------

def _add_entry_sync(entry: dict) -> dict:
    eid = uuid.uuid4().hex
    ts = entry.get("ts") or datetime.now().isoformat(timespec="seconds")
    entry_basis = entry.get("entry_basis")
    fv_at_fill = entry.get("fv_at_fill")
    mid_at_fill = entry.get("mid_at_fill")
    row = (
        eid,
        ts,
        entry["code"],
        entry["instrument"],
        entry["kind"],
        entry["side"],
        int(entry["qty"]),
        entry.get("price"),
        entry.get("note"),
        entry_basis,
        fv_at_fill,
        mid_at_fill,
    )
    with _connect() as conn:
        conn.execute(
            "INSERT INTO lp_ledger "
            "(id, ts, code, instrument, kind, side, qty, price, note, entry_basis, fv_at_fill, mid_at_fill) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            row,
        )
        conn.commit()
    return {
        "id": eid,
        "ts": ts,
        "code": entry["code"],
        "instrument": entry["instrument"],
        "kind": entry["kind"],
        "side": entry["side"],
        "qty": int(entry["qty"]),
        "price": entry.get("price"),
        "note": entry.get("note"),
        "entry_basis": entry_basis,
        "fv_at_fill": fv_at_fill,
        "mid_at_fill": mid_at_fill,
    }


async def add_entry(entry: dict) -> dict:
    return await asyncio.to_thread(_add_entry_sync, entry)


def _delete_entry_sync(eid: str) -> bool:
    with _connect() as conn:
        cur = conn.execute("DELETE FROM lp_ledger WHERE id = ?", (eid,))
        conn.commit()
        return cur.rowcount > 0


async def delete_entry(eid: str) -> bool:
    return await asyncio.to_thread(_delete_entry_sync, eid)


def _list_entries_sync() -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM lp_ledger ORDER BY ts DESC, rowid DESC"
        ).fetchall()
        return [_row_to_entry(dict(r)) for r in rows]


async def list_entries() -> list[dict]:
    return await asyncio.to_thread(_list_entries_sync)


def _set_carryover_sync(code: str, instrument: str, signed_qty: int, price, note) -> None:
    """특정 코드의 carryover 엔트리를 통째로 교체 (fill은 보존).

    signed_qty == 0 이면 해당 코드 carryover 삭제만.
    """
    with _connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(
            "DELETE FROM lp_ledger WHERE code = ? AND kind = 'carryover'", (code,)
        )
        if signed_qty != 0:
            side = "buy" if signed_qty > 0 else "sell"
            conn.execute(
                "INSERT INTO lp_ledger (id, ts, code, instrument, kind, side, qty, price, note) "
                "VALUES (?, ?, ?, ?, 'carryover', ?, ?, ?, ?)",
                (
                    uuid.uuid4().hex,
                    datetime.now().isoformat(timespec="seconds"),
                    code,
                    instrument,
                    side,
                    abs(int(signed_qty)),
                    price,
                    note,
                ),
            )
        conn.commit()


async def set_carryover(code: str, instrument: str, signed_qty: int,
                        price=None, note=None) -> None:
    await asyncio.to_thread(_set_carryover_sync, code, instrument, signed_qty, price, note)


def _replace_all_carryover_sync(items: list[tuple[str, str, int]]) -> None:
    """POST /positions 하위호환 — 전체 북을 items로 full replace.

    items: [(code, instrument, signed_qty), ...]. carryover 전체 + fill 전체 삭제 후
    carryover만 재삽입 → GET /positions net 이 정확히 items 와 일치 (legacy 계약 보존).
    """
    now = datetime.now().isoformat(timespec="seconds")
    with _connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute("DELETE FROM lp_ledger")
        for code, instrument, signed_qty in items:
            if signed_qty == 0:
                continue
            side = "buy" if signed_qty > 0 else "sell"
            conn.execute(
                "INSERT INTO lp_ledger (id, ts, code, instrument, kind, side, qty, price, note) "
                "VALUES (?, ?, ?, ?, 'carryover', ?, ?, NULL, NULL)",
                (uuid.uuid4().hex, now, code, instrument, side, abs(int(signed_qty))),
            )
        conn.commit()


async def replace_all_carryover(items: list[tuple[str, str, int]]) -> None:
    await asyncio.to_thread(_replace_all_carryover_sync, items)


# ---------------------------------------------------------------------------
# aggregation
# ---------------------------------------------------------------------------

def _aggregate_sync() -> dict[str, dict]:
    """코드별 집계.

    반환: {code: {code, instrument, carryover_qty(signed), fills_qty(signed, all),
                  fills_qty_today(signed), net_qty(signed), avg_price(nullable),
                  entry_basis(nullable)}}

    avg_price: price가 있는 모든 엔트리의 qty 가중 VWAP (blended 평단 proxy).
    entry_basis: entry_basis가 있는 엔트리 중 **포지션 증가 방향** (signed 부호 == 최종
                 net_qty 부호)만의 qty 가중 평균 (§13.4). 청산 방향 fill에 entry_basis가
                 실려도 진입 평균에 *가산*되는 왜곡 방지 — 청산은 진입 베이시스를 바꾸지
                 않는다 (v1 근사: FIFO 아닌 부호 필터. net 0이면 None).
    net_qty: carryover 부호합 + fill 부호합 (전체). Rust 호환 dict의 소스.
    fills_qty_today: 표시용 (ts date == 오늘).
    """
    today = datetime.now().date().isoformat()
    with _connect() as conn:
        rows = conn.execute("SELECT * FROM lp_ledger").fetchall()

    agg: dict[str, dict] = {}
    for r in rows:
        r = dict(r)
        code = r["code"]
        a = agg.get(code)
        if a is None:
            a = {
                "code": code,
                "instrument": r["instrument"],
                "carryover_qty": 0,
                "fills_qty": 0,
                "fills_qty_today": 0,
                "net_qty": 0,
                "_px_num": 0.0,
                "_px_den": 0,
                "_eb_rows": [],  # (signed_qty, qty, entry_basis) — net 확정 후 부호 필터
            }
            agg[code] = a
        # instrument는 코드당 일관되어야 하지만, override 등으로 갈리면 최신(=carryover 우선) 유지.
        if r["instrument"] in VALID_INSTRUMENTS:
            a["instrument"] = r["instrument"]
        qty = int(r["qty"])
        signed = _signed(r["side"], qty)
        if r["kind"] == "carryover":
            a["carryover_qty"] += signed
        else:
            a["fills_qty"] += signed
            if str(r["ts"])[:10] == today:
                a["fills_qty_today"] += signed
        if r["price"] is not None:
            a["_px_num"] += qty * float(r["price"])
            a["_px_den"] += qty
        eb = r.get("entry_basis")
        if eb is not None:
            a["_eb_rows"].append((signed, qty, float(eb)))

    for a in agg.values():
        a["net_qty"] = a["carryover_qty"] + a["fills_qty"]
        a["avg_price"] = (a["_px_num"] / a["_px_den"]) if a["_px_den"] > 0 else None
        # entry_basis: 포지션 증가 방향(부호 == net 부호)만 가중 (docstring 근거).
        net_sign = (a["net_qty"] > 0) - (a["net_qty"] < 0)
        eb_num = sum(q * eb for s, q, eb in a["_eb_rows"] if net_sign != 0 and (s > 0) == (net_sign > 0))
        eb_den = sum(q for s, q, _ in a["_eb_rows"] if net_sign != 0 and (s > 0) == (net_sign > 0))
        a["entry_basis"] = (eb_num / eb_den) if eb_den > 0 else None
        a.pop("_px_num", None)
        a.pop("_px_den", None)
        a.pop("_eb_rows", None)
    return agg


async def aggregate() -> dict[str, dict]:
    return await asyncio.to_thread(_aggregate_sync)


def _positions_flat_sync() -> dict[str, int]:
    """호환 계약: {code: net_qty} (0 제외). Rust scheduler.rs 5초 poll 소스."""
    agg = _aggregate_sync()
    return {code: a["net_qty"] for code, a in agg.items() if a["net_qty"] != 0}


async def positions_flat() -> dict[str, int]:
    return await asyncio.to_thread(_positions_flat_sync)


def _count_sync() -> int:
    with _connect() as conn:
        return conn.execute("SELECT COUNT(*) AS c FROM lp_ledger").fetchone()["c"]


async def count() -> int:
    return await asyncio.to_thread(_count_sync)


def _latest_ts_sync() -> Optional[str]:
    with _connect() as conn:
        row = conn.execute("SELECT MAX(ts) AS m FROM lp_ledger").fetchone()
        return row["m"] if row and row["m"] else None


async def latest_ts() -> Optional[str]:
    return await asyncio.to_thread(_latest_ts_sync)


def _migrate_carryover_once_sync(items: list[tuple[str, str, int]]) -> int:
    """JSON → carryover 이관, lp_meta 키로 평생 1회 보장.

    items: [(code, instrument, signed_qty)].

    반환: 이관된 엔트리 수. 이미 이관됨(-1) / 원장 비어있지 않아 스킵(0, 키만 기록).

    멱등성: 트리거는 lp_meta 키 부재 *만* — "원장 비어있음"이 아님. 사용자가 원장을
    전부 비운 뒤 재기동(--reload 포함)해도 부활하지 않는다. BEGIN IMMEDIATE 안에서
    키를 재확인해 이중 프로세스 동시 기동 race 차단. 시도 후에는 (이관했든, 원장이
    이미 채워져 있어 스킵했든) 키를 기록해 재시도를 봉인.
    """
    now = datetime.now().isoformat(timespec="seconds")
    with _connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT value FROM lp_meta WHERE key = ?", (META_MIGRATED_KEY,)
        ).fetchone()
        if row is not None:
            conn.commit()
            return -1
        inserted = 0
        empty = conn.execute("SELECT COUNT(*) AS c FROM lp_ledger").fetchone()["c"] == 0
        if empty:
            for code, instrument, signed_qty in items:
                if signed_qty == 0:
                    continue
                side = "buy" if signed_qty > 0 else "sell"
                conn.execute(
                    "INSERT INTO lp_ledger (id, ts, code, instrument, kind, side, qty, price, note) "
                    "VALUES (?, ?, ?, ?, 'carryover', ?, ?, NULL, NULL)",
                    (uuid.uuid4().hex, now, code, instrument, side, abs(int(signed_qty))),
                )
                inserted += 1
        conn.execute(
            "INSERT OR REPLACE INTO lp_meta (key, value) VALUES (?, ?)",
            (META_MIGRATED_KEY, now),
        )
        conn.commit()
    return inserted


async def migrate_carryover_once(items: list[tuple[str, str, int]]) -> int:
    return await asyncio.to_thread(_migrate_carryover_once_sync, items)


# ---------------------------------------------------------------------------
# fill markout (§13.3-C) — fill 후 5분/30분 스냅샷
# ---------------------------------------------------------------------------

VALID_HORIZONS = {"5m", "30m"}


def _add_fill_mark_sync(mark: dict) -> bool:
    """markout 1건 기록. (fill_id, horizon) UNIQUE라 이미 있으면 무시(멱등).

    반환: 새로 삽입됐으면 True (이미 있었으면 False).
    """
    marked_at = mark.get("marked_at") or datetime.now().isoformat(timespec="seconds")
    with _connect() as conn:
        cur = conn.execute(
            "INSERT OR IGNORE INTO lp_fill_marks (id, fill_id, horizon, price, fv, marked_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (
                uuid.uuid4().hex,
                mark["fill_id"],
                mark["horizon"],
                mark.get("price"),
                mark.get("fv"),
                marked_at,
            ),
        )
        conn.commit()
        return cur.rowcount > 0


async def add_fill_mark(mark: dict) -> bool:
    return await asyncio.to_thread(_add_fill_mark_sync, mark)


def _list_fill_marks_sync(date_prefix: Optional[str]) -> list[dict]:
    """markout 목록. date_prefix('YYYY-MM-DD')가 주어지면 marked_at 해당일만, None이면 전체."""
    with _connect() as conn:
        if date_prefix:
            rows = conn.execute(
                "SELECT fill_id, horizon, price, fv, marked_at FROM lp_fill_marks "
                "WHERE marked_at LIKE ? ORDER BY marked_at",
                (f"{date_prefix}%",),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT fill_id, horizon, price, fv, marked_at FROM lp_fill_marks ORDER BY marked_at"
            ).fetchall()
        return [
            {
                "fill_id": r["fill_id"],
                "horizon": r["horizon"],
                "price": None if r["price"] is None else float(r["price"]),
                "fv": None if r["fv"] is None else float(r["fv"]),
                "marked_at": r["marked_at"],
            }
            for r in rows
        ]


async def list_fill_marks(date_prefix: Optional[str] = None) -> list[dict]:
    return await asyncio.to_thread(_list_fill_marks_sync, date_prefix)


# ---------------------------------------------------------------------------
# validation (router 사용)
# ---------------------------------------------------------------------------

def validate_entry(kind: str, side: str, instrument: str, qty: Any) -> list[str]:
    errs: list[str] = []
    if kind not in VALID_KINDS:
        errs.append(f"kind invalid: {kind}")
    if side not in VALID_SIDES:
        errs.append(f"side invalid: {side}")
    if instrument not in VALID_INSTRUMENTS:
        errs.append(f"instrument invalid: {instrument}")
    try:
        q = int(qty)
        if q <= 0:
            errs.append("qty must be > 0")
    except (TypeError, ValueError):
        errs.append("qty must be integer")
    return errs
