"""LP 데스크 체결·포지션·출구 바스켓 — lp-system-design.md §14.6 / §14.7.

저장소는 backend/data/lens.db (positions.py / loan_rates / lp_ledger와 같은 파일).
stdlib sqlite3 + asyncio.to_thread, WAL + busy_timeout — positions.py 패턴 그대로.

테이블 2개:
  - lp_desk_fills       : ETF 체결 (qty 부호 = 방향, 진입 스냅샷 entry_inav/entry_k200/entry_kq150은
                          프론트가 체결 시점 실시간 값으로 첨부 — 없으면 NULL)
  - lp_desk_hedge_fills : 지수선물 체결 (MK200 / KQ150F)

포지션 집계 규약 — **평균원가법(average cost)**. 체결을 시간순으로 접어 상태를 굴린다:
  - net_qty  = Σ qty (부호합)
  - avg_price / 진입 스냅샷 = 남은 재고의 원가·진입 시점 값.
      · 포지션 증가(같은 방향): |수량| 가중 평균으로 갱신
      · 포지션 감소(반대 방향, |fill| ≤ |net|): 수량만 줄고 원가는 불변 (실현손익으로 소멸)
      · 관통(부호 반전): 잔여 반전분은 해당 체결의 값으로 리셋
      · net_qty=0이면 전부 None
    진입 스냅샷 3종(entry_gap_bp / entry_k200 / entry_kq150)은 **각자 분모**로 가중한다 —
    값이 붙은 체결분의 재고 수량만 세야 결측 체결이 섞여도 희석되지 않는다(§14.6 규약).
    ⚠ 부호합(Σqty·price / Σqty) 가중은 쓰지 않는다. 매수/매도가 섞이면 분모가 0에 수렴하며
    발산한다 (+10,000 후 −9,800이면 잔여 200주에 평단 37,560 같은 값이 나옴).
"""
from __future__ import annotations

import asyncio
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Any

from sqlalchemy import text

from core.database import korea_async_session

DATA_DIR = Path(__file__).parent.parent / "data"
DB_FILE = DATA_DIR / "lens.db"

HEDGE_CONTRACTS = ("MK200", "KQ150F")

# 진입 스냅샷 컬럼 — 초기 스키마(entry_inav만) 이후 §14.6으로 추가된 것들.
# 이미 만들어진 lens.db에도 붙여야 해서 ensure 시 PRAGMA로 확인 후 ALTER TABLE.
_FILL_SNAPSHOT_COLS = ("entry_inav", "entry_k200", "entry_kq150")

_schema_ready = False


def _connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    # 같은 DB 파일을 positions/loan_rates/backtest/lp_ledger도 씀 → WAL + busy_timeout.
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


def _ensure_schema_sync() -> None:
    global _schema_ready
    with _connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS lp_desk_fills (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                ts          TEXT NOT NULL,       -- ISO datetime (로컬=KST)
                etf_code    TEXT NOT NULL,
                qty         INTEGER NOT NULL,    -- ± (매수 +, 매도 −)
                price       REAL NOT NULL,
                entry_inav  REAL,                -- 체결 시점 iNAV        (프론트 첨부, nullable)
                entry_k200  REAL,                -- 체결 시점 K200 선물가  (헤지 상대성과 기준점)
                entry_kq150 REAL,                -- 체결 시점 KQ150 선물가
                note        TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_lp_desk_fills_code ON lp_desk_fills(etf_code);
            CREATE INDEX IF NOT EXISTS idx_lp_desk_fills_ts   ON lp_desk_fills(ts);

            CREATE TABLE IF NOT EXISTS lp_desk_hedge_fills (
                id       INTEGER PRIMARY KEY AUTOINCREMENT,
                ts       TEXT NOT NULL,
                contract TEXT NOT NULL,          -- MK200 | KQ150F
                qty      INTEGER NOT NULL,       -- ±
                price    REAL NOT NULL,
                note     TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_lp_desk_hedge_ts ON lp_desk_hedge_fills(ts);
            """
        )
        have = {r["name"] for r in conn.execute("PRAGMA table_info(lp_desk_fills)")}
        for col in _FILL_SNAPSHOT_COLS:
            if col not in have:
                conn.execute(f"ALTER TABLE lp_desk_fills ADD COLUMN {col} REAL")  # noqa: S608 — 상수
        conn.commit()
    _schema_ready = True


async def ensure_schema() -> None:
    await asyncio.to_thread(_ensure_schema_sync)


async def _ensure() -> None:
    if not _schema_ready:
        await ensure_schema()


def _now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# 체결 CRUD
# ---------------------------------------------------------------------------


def _list_fills_sync(etf_code: str | None, limit: int) -> list[dict]:
    with _connect() as conn:
        if etf_code:
            rows = conn.execute(
                "SELECT * FROM lp_desk_fills WHERE etf_code = ? ORDER BY id DESC LIMIT ?",
                (etf_code, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM lp_desk_fills ORDER BY id DESC LIMIT ?", (limit,)
            ).fetchall()
        return [dict(r) for r in rows]


async def list_fills(etf_code: str | None = None, limit: int = 500) -> list[dict]:
    await _ensure()
    return await asyncio.to_thread(_list_fills_sync, etf_code, limit)


def _add_fill_sync(row: dict) -> dict:
    with _connect() as conn:
        cur = conn.execute(
            "INSERT INTO lp_desk_fills "
            "(ts, etf_code, qty, price, entry_inav, entry_k200, entry_kq150, note) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (row["ts"], row["etf_code"], row["qty"], row["price"],
             row.get("entry_inav"), row.get("entry_k200"), row.get("entry_kq150"),
             row.get("note")),
        )
        conn.commit()
        out = conn.execute(
            "SELECT * FROM lp_desk_fills WHERE id = ?", (cur.lastrowid,)
        ).fetchone()
        return dict(out)


async def add_fill(
    etf_code: str, qty: int, price: float,
    entry_inav: float | None = None, note: str | None = None, ts: str | None = None,
    entry_k200: float | None = None, entry_kq150: float | None = None,
) -> dict:
    await _ensure()
    row = {
        "ts": ts or _now_iso(), "etf_code": etf_code, "qty": qty,
        "price": price, "entry_inav": entry_inav,
        "entry_k200": entry_k200, "entry_kq150": entry_kq150, "note": note,
    }
    return await asyncio.to_thread(_add_fill_sync, row)


def _delete_sync(table: str, fill_id: int) -> bool:
    with _connect() as conn:
        cur = conn.execute(f"DELETE FROM {table} WHERE id = ?", (fill_id,))  # noqa: S608 — table은 상수
        conn.commit()
        return cur.rowcount > 0


async def delete_fill(fill_id: int) -> bool:
    await _ensure()
    return await asyncio.to_thread(_delete_sync, "lp_desk_fills", fill_id)


def _list_hedge_fills_sync(limit: int) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM lp_desk_hedge_fills ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
        return [dict(r) for r in rows]


async def list_hedge_fills(limit: int = 500) -> list[dict]:
    await _ensure()
    return await asyncio.to_thread(_list_hedge_fills_sync, limit)


def _add_hedge_fill_sync(row: dict) -> dict:
    with _connect() as conn:
        cur = conn.execute(
            "INSERT INTO lp_desk_hedge_fills (ts, contract, qty, price, note) VALUES (?, ?, ?, ?, ?)",
            (row["ts"], row["contract"], row["qty"], row["price"], row.get("note")),
        )
        conn.commit()
        out = conn.execute(
            "SELECT * FROM lp_desk_hedge_fills WHERE id = ?", (cur.lastrowid,)
        ).fetchone()
        return dict(out)


async def add_hedge_fill(
    contract: str, qty: int, price: float, note: str | None = None, ts: str | None = None
) -> dict:
    await _ensure()
    row = {"ts": ts or _now_iso(), "contract": contract, "qty": qty, "price": price, "note": note}
    return await asyncio.to_thread(_add_hedge_fill_sync, row)


async def delete_hedge_fill(fill_id: int) -> bool:
    await _ensure()
    return await asyncio.to_thread(_delete_sync, "lp_desk_hedge_fills", fill_id)


# ---------------------------------------------------------------------------
# 포지션 집계
# ---------------------------------------------------------------------------

# 체결을 시간순으로 읽어 키별로 접는다(GROUP BY 합산 불가 — 평균원가는 경로 의존).
# 정렬은 (ts, id): ts는 프론트가 넘길 수 있고 동일 ts면 입력 순서(id)가 시간순이다.
_ETF_FILLS_SQL = """
    SELECT etf_code, qty, price, entry_inav, entry_k200, entry_kq150, ts
    FROM lp_desk_fills ORDER BY etf_code, ts, id
"""

_HEDGE_FILLS_SQL = """
    SELECT contract, qty, price, ts
    FROM lp_desk_hedge_fills ORDER BY contract, ts, id
"""

# 진입 스냅샷 슬롯 — (포지션 응답 키, 체결 컬럼). 각자 분모로 가중된다.
_SNAPSHOTS = (("entry_gap_bp", "entry_inav"), ("entry_k200", "entry_k200"),
              ("entry_kq150", "entry_kq150"))


class _Wavg:
    """진입 스냅샷 하나의 가중평균 상태. qty는 **값이 붙은 체결분의 재고 수량**.

    net_qty와 따로 관리한다 — 스냅샷 없는 체결(시세 미수신 등)이 섞여도 희석되지 않게.
    """

    __slots__ = ("value", "qty")

    def __init__(self) -> None:
        self.value: float | None = None
        self.qty = 0.0

    def add(self, value: float | None, weight: float) -> None:
        if value is None:
            return
        self.value = (
            (self.value * self.qty + value * weight) / (self.qty + weight)
            if self.value is not None and self.qty > 0
            else value
        )
        self.qty += weight

    def reset(self, value: float | None, weight: float) -> None:
        self.value = value
        self.qty = weight if value is not None else 0.0

    def scale(self, factor: float) -> None:
        self.qty *= factor


class _AvgCost:
    """평균원가 상태 — 체결을 시간순으로 하나씩 먹인다.

    snaps = 진입 스냅샷 3종(진입괴리 bp / K200 선물가 / KQ150 선물가)의 _Wavg.
    """

    __slots__ = ("net", "avg", "snaps", "fills", "last_ts")

    def __init__(self) -> None:
        self.net = 0
        self.avg: float | None = None
        self.snaps = tuple(_Wavg() for _ in _SNAPSHOTS)
        self.fills = 0
        self.last_ts: str | None = None

    def feed(self, qty: int, price: float, snaps: tuple[float | None, ...], ts: str | None) -> None:
        self.fills += 1
        if ts and (self.last_ts is None or ts > self.last_ts):
            self.last_ts = ts

        if self.net == 0:
            self._reset_to(qty, price, snaps)
            return
        if (self.net > 0) == (qty > 0):  # 증가 — 가중 평균
            held, add = abs(self.net), abs(qty)
            base = self.avg if self.avg is not None else price
            self.avg = (base * held + price * add) / (held + add)
            for slot, v in zip(self.snaps, snaps):
                slot.add(v, add)
            self.net += qty
            return
        # 감소 / 관통
        remain = self.net + qty
        if remain == 0:
            self.net = 0
            self.avg = None
            for slot in self.snaps:
                slot.reset(None, 0.0)
        elif (remain > 0) == (self.net > 0):  # 부분 청산 — 원가 불변, 재고만 비례 축소
            factor = abs(remain) / abs(self.net)
            for slot in self.snaps:
                slot.scale(factor)
            self.net = remain
        else:  # 부호 반전 — 잔여분은 이 체결이 원가
            self._reset_to(remain, price, snaps)

    def _reset_to(self, qty: int, price: float, snaps: tuple[float | None, ...]) -> None:
        self.net = qty
        self.avg = price
        for slot, v in zip(self.snaps, snaps):
            slot.reset(v, abs(qty))

    def snapshot(self) -> dict:
        return {key: slot.value for (key, _), slot in zip(_SNAPSHOTS, self.snaps)}


def _entry_snaps(row) -> tuple[float | None, ...]:
    """체결 행 → 진입 스냅샷 튜플. 진입괴리는 (체결가 − 진입 iNAV)/iNAV bp로 환산."""
    inav = row["entry_inav"]
    gap = ((float(row["price"]) - inav) / inav * 10000.0) if inav and inav > 0 else None
    k200 = row["entry_k200"]
    kq150 = row["entry_kq150"]
    return (gap,
            float(k200) if k200 and k200 > 0 else None,
            float(kq150) if kq150 and kq150 > 0 else None)


def _fold(rows, key: str, *, with_snaps: bool) -> dict[str, _AvgCost]:
    """키(etf_code / contract)별 평균원가 상태. rows는 키·시간순 정렬 전제."""
    blank: tuple[float | None, ...] = (None,) * len(_SNAPSHOTS)
    out: dict[str, _AvgCost] = {}
    for r in rows:
        st = out.get(r[key])
        if st is None:
            st = out[r[key]] = _AvgCost()
        st.feed(int(r["qty"]), float(r["price"]),
                _entry_snaps(r) if with_snaps else blank, r["ts"])
    return out


def _positions_sync() -> dict:
    with _connect() as conn:
        # 커서를 그대로 흘려보낸다 (중간 리스트 없이 한 번만 순회).
        etf_state = _fold(conn.execute(_ETF_FILLS_SQL), "etf_code", with_snaps=True)
        hedge_state = _fold(conn.execute(_HEDGE_FILLS_SQL), "contract", with_snaps=False)

    etfs = [
        {
            "etf_code": code,
            "net_qty": st.net,
            "avg_price": st.avg,
            **st.snapshot(),
            "fills": st.fills,
            "last_ts": st.last_ts,
        }
        for code, st in sorted(etf_state.items())
    ]
    hedges = [
        {
            "contract": contract,
            "net_qty": st.net,
            "avg_price": st.avg,
            "fills": st.fills,
            "last_ts": st.last_ts,
        }
        for contract, st in sorted(hedge_state.items())
    ]
    return {"positions": etfs, "hedges": hedges}


async def positions() -> dict:
    """`{positions: per-ETF 합산, hedges: 계약별 합산}`.

    net_qty=0(당일 정리 완료) 행도 남긴다 — 프론트가 '오늘 손댄 종목'을 보여줄 수 있게.
    바스켓·헤지 레그는 0을 알아서 건너뛴다."""
    await _ensure()
    return await asyncio.to_thread(_positions_sync)


# ---------------------------------------------------------------------------
# 출구 바스켓 (§14.7)
# ---------------------------------------------------------------------------


async def pdf_top(etf_code: str, limit: int = 10) -> list[dict]:
    """최신 PDF 상위 구성종목 (비중 = shares × 최근 종가 기준). is_cash 제외."""
    async with korea_async_session() as session:
        rows = (await session.execute(text(
            """
            SELECT p.component_code, p.component_name, p.shares, s.market
            FROM etf_portfolio_daily p
            LEFT JOIN stocks s ON s.stock_code = p.component_code
            WHERE p.etf_code = :code
              AND p.snapshot_date = (SELECT max(snapshot_date) FROM etf_portfolio_daily
                                     WHERE etf_code = :code)
              AND NOT p.is_cash
            """
        ), {"code": etf_code})).all()
        if not rows:
            return []
        codes = [r.component_code for r in rows]
        px = await _latest_closes(session, codes)

    vals = []
    for r in rows:
        shares = int(r.shares or 0)
        value = shares * px.get(r.component_code, 0.0)
        vals.append((value, r))
    total = sum(v for v, _ in vals)
    vals.sort(key=lambda t: t[0], reverse=True)
    return [
        {
            "code": r.component_code,
            "name": (r.component_name or "").strip(),
            "weight_pct": (value / total * 100.0) if total > 0 else None,
            "market": _market_label(r.market),
        }
        for value, r in vals[:limit]
    ]


def _market_label(market: Any) -> str:
    m = (str(market) if market else "").strip().upper()
    if not m:
        return "미분류"
    if "KOSDAQ" in m or "코스닥" in m:
        return "KOSDAQ"
    if "KOSPI" in m or "코스피" in m:
        return "KOSPI"
    return m


async def _latest_closes(session, codes: list[str]) -> dict[str, float]:
    """종목별 최신 종가(raw close_price). 평가용이라 수정주가 불필요 — 최신봉은 동일하고
    실제 집행 단가는 raw. 30일 하한으로 hypertable 청크 프루닝."""
    if not codes:
        return {}
    rows = (await session.execute(text(
        """
        SELECT DISTINCT ON (stock_code) stock_code, close_price
        FROM ohlcv_daily
        WHERE stock_code = ANY(:codes) AND time > current_date - INTERVAL '30 days'
        ORDER BY stock_code, time DESC
        """
    ), {"codes": codes})).all()
    return {r.stock_code: float(r.close_price or 0) for r in rows}


async def exit_basket() -> dict:
    """현 ETF 포지션 전체를 최신 PDF로 분해한 넷팅 주식 바스켓 + 청산할 선물 레그.

    종목수량 = Σ_ETF (net_qty / creation_unit × shares). is_cash 행은 바스켓에서 빼고
    금액만 cash_omitted로 합산(§14.7) — 현금은 주식 주문으로 재현 불가.

    futures_legs.qty는 **집행할 주문 수량 = 현 보유의 반대 부호**(정리 티켓이므로).
    현 보유 자체는 position_qty로 같이 내려준다 (표기 혼동 방지).
    """
    pos = await positions()
    legs = [
        {
            "contract": h["contract"],
            "qty": -h["net_qty"],          # 청산 주문 방향
            "position_qty": h["net_qty"],  # 현 보유
            "price": h["avg_price"],       # 보유 평단 (참고)
            "avg_price": h["avg_price"],
        }
        for h in pos["hedges"] if h["net_qty"]
    ]
    holdings = {p["etf_code"]: p["net_qty"] for p in pos["positions"] if p["net_qty"]}
    empty = {
        "pdf_date": None, "rows": [], "futures_legs": legs,
        "cash_omitted": 0.0, "source_etfs": [], "warnings": [],
    }
    if not holdings:
        return empty

    codes = list(holdings)
    warnings: list[str] = []
    async with korea_async_session() as session:
        pdf_date = (await session.execute(text(
            "SELECT max(snapshot_date) FROM etf_portfolio_daily WHERE etf_code = ANY(:codes)"
        ), {"codes": codes})).scalar()
        if pdf_date is None:
            return {**empty, "warnings": ["보유 ETF의 PDF가 없음"]}

        cu_rows = (await session.execute(text(
            """
            SELECT DISTINCT ON (etf_code) etf_code, kr_name, creation_unit
            FROM etf_master_daily
            WHERE etf_code = ANY(:codes)
            ORDER BY etf_code, snapshot_date DESC
            """
        ), {"codes": codes})).all()
        cu = {r.etf_code: (r.creation_unit, (r.kr_name or "").strip()) for r in cu_rows}

        pdf_rows = (await session.execute(text(
            """
            SELECT p.etf_code, p.component_code, p.component_name, p.shares, p.is_cash,
                   s.market
            FROM etf_portfolio_daily p
            LEFT JOIN stocks s ON s.stock_code = p.component_code
            WHERE p.etf_code = ANY(:codes) AND p.snapshot_date = :d
            """
        ), {"codes": codes, "d": pdf_date})).all()

        # 종목별 넷팅 — 같은 종목을 여러 ETF가 들면 합산되며 자연 상계된다.
        acc: dict[str, dict] = {}
        cash_omitted = 0.0
        used: dict[str, dict] = {}
        for r in pdf_rows:
            etf = r.etf_code
            unit, name = cu.get(etf, (None, ""))
            if not unit:
                continue  # creation_unit 없는 ETF는 아래에서 경고
            ratio = holdings[etf] / float(unit)
            used.setdefault(etf, {"etf_code": etf, "name": name, "qty": holdings[etf],
                                  "creation_unit": int(unit)})
            if r.is_cash:
                code_u = (str(r.component_code) if r.component_code else "").strip().upper()
                # 설정현금액(H00000)은 CU 전체 설정금액 summary 행 — 합산 제외 (routers/etfs.py 동일 규칙)
                if code_u != "H00000" and "설정현금" not in (r.component_name or ""):
                    cash_omitted += ratio * float(r.shares or 0)
                continue
            slot = acc.setdefault(r.component_code, {
                "code": r.component_code,
                "name": (r.component_name or "").strip(),
                "market": _market_label(r.market),
                "qty_exact": 0.0,
            })
            slot["qty_exact"] += ratio * float(r.shares or 0)

        for etf in codes:
            if etf not in used:
                warnings.append(f"{etf}: PDF/creation_unit 없음 — 바스켓에서 제외")

        px = await _latest_closes(session, list(acc))

    rows = []
    for code, slot in acc.items():
        qty = int(round(slot["qty_exact"]))
        if qty == 0 and abs(slot["qty_exact"]) < 1e-9:
            continue
        price = px.get(code, 0.0)
        rows.append({
            "code": code,
            "name": slot["name"],
            "market": slot["market"],
            "qty": qty,
            "qty_exact": round(slot["qty_exact"], 4),
            "price": price,
            "est_value": qty * price,
        })
    rows.sort(key=lambda r: abs(r["est_value"]), reverse=True)
    return {
        "pdf_date": pdf_date.isoformat(),
        "rows": rows,
        "futures_legs": legs,
        "cash_omitted": cash_omitted,
        "source_etfs": list(used.values()),
        "warnings": warnings,
    }
