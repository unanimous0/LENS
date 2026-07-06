"""패널 빌드·캐시·버전 관리 — backtest.md §3.2.

- 어댑터별 (time, stock) 컬럼을 join한 단일 패널. 기간 = 최대 가용(2022~), 유니버스 = 활성
  KOSPI/KOSDAQ 전체 (엔진이 spec.period·universe로 슬라이스하므로 패널은 spec 독립·1벌 캐시).
- 캐시 2단: pickle 파일(data/backtest_panel/*.pkl — parquet 엔진 부재로 pickle 사용, gitignore)
  + 프로세스 메모리. 버전 키 = 어댑터별 data_version 프로브(flow=flow_metrics.data_version 재사용,
  price=ohlcv max(time)+최신일 행수).
- **빌드는 lazy**: import/startup에서 절대 안 돌린다 (uvicorn --reload — import 부작용 금지).
  첫 요청 시 job이 빌드. stale이면 이전 버전 서빙 + 백그라운드 재빌드.
- 벌크 조회는 몇 개의 큰 SELECT로. investor_trading/ohlcv/market_cap은 TimescaleDB 하이퍼테이블
  (~236 주간 청크) — 전 구간을 한 트랜잭션에 몰면 청크 AccessShareLock 누적으로 out of shared
  memory. **연도 청크 × 테이블별 별도 세션**으로 락을 사이사이 해제 (flow_episodes 주석 계승).
"""
from __future__ import annotations

import asyncio
import logging
import pickle
import time as _time
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd
from sqlalchemy import text

from core.database import korea_async_session
from services import flow_metrics as fm

from . import adapters as ad

logger = logging.getLogger("uvicorn.error")

_CACHE_DIR = Path(__file__).resolve().parents[3] / "data" / "backtest_panel"
_INVESTOR_TYPES = ("FOREIGN", "INSTITUTION", "RETAIL")

# 벤치마크 지수 (index_ohlcv_daily) — KRX 코스피/코스닥 종합지수. 분할 없어 raw close 사용.
_INDEX_CODES = {"kospi": "KGG01P", "kosdaq": "QGG01P"}

# 프로세스 메모리 캐시 + 동시 빌드 가드
_PANEL: dict | None = None          # {"df", "versions", "meta"}
_build_lock = asyncio.Lock()
_bg_refreshing = False
_bg_tasks: set[asyncio.Task] = set()  # create_task 참조 보관 (GC 조기 수거 방지)


@dataclass
class PanelContext:
    start: date
    end: date
    codes: list[str]
    market_map: dict[str, str]
    versions: dict = field(default_factory=dict)


# ── 버전 프로브 ────────────────────────────────────────────────────────────
async def _price_version() -> str:
    async with korea_async_session() as s:
        row = (await s.execute(text(
            """
            WITH m AS (SELECT max(time) AS d FROM ohlcv_daily)
            SELECT m.d::text, (SELECT count(*) FROM ohlcv_daily o WHERE o.time = m.d) FROM m
            """
        ))).one()
    return f"{row[0]}:{int(row[1])}"


async def _fin_version() -> str:
    """financial_metrics_quarterly actual 스냅샷 버전 = max(collected_at):actual행수."""
    async with korea_async_session() as s:
        row = (await s.execute(text(
            "SELECT max(collected_at)::text, count(*) "
            "FROM financial_metrics_quarterly WHERE data_type = 'actual'"
        ))).one()
    return f"{row[0]}:{int(row[1])}"


async def _own_version() -> str:
    """foreign_ownership 버전 = max(time):그날 행수 (price 프로브와 동형)."""
    async with korea_async_session() as s:
        row = (await s.execute(text(
            """
            WITH m AS (SELECT max(time) AS d FROM foreign_ownership)
            SELECT m.d::text, (SELECT count(*) FROM foreign_ownership f WHERE f.time = m.d) FROM m
            """
        ))).one()
    return f"{row[0]}:{int(row[1])}"


async def _etf_version() -> str:
    """etf_master_daily 버전 = max(snapshot_date):전체 행수."""
    async with korea_async_session() as s:
        row = (await s.execute(text(
            "SELECT max(snapshot_date)::text, count(*) FROM etf_master_daily"
        ))).one()
    return f"{row[0]}:{int(row[1])}"


# 어댑터 **공식** 버전 — DB 프로브는 데이터 변경만 감지하므로, 어댑터 산식이 바뀌면
# 여기를 올려 구 pickle을 무효화한다 (2 = C3.1: fin 분할 브리지·TTM/YoY 연속성 게이트,
# 3 = C4: etf 네임스페이스 + 유니버스에 ETF 종목 추가 → 패널 행 구성 변경).
PANEL_SCHEMA_VERSION = 3


async def adapter_versions() -> dict:
    fv = await fm.data_version()
    return {"schema": PANEL_SCHEMA_VERSION,
            "price": await _price_version(), "flow": f"{fv[0]}:{fv[1]}",
            "fin": await _fin_version(), "own": await _own_version(),
            "etf": await _etf_version()}


async def _fetch_indices(start: date, end: date) -> dict[str, dict]:
    """벤치마크 지수 종가 (KGG01P/QGG01P) → {"kospi": {Timestamp: close}, "kosdaq": {...}}.

    2 시계열·각 ~1,100행이라 부하 무시 가능. 지수는 분할 없어 raw close 그대로(CLAUDE.md 룰).
    """
    codes = list(_INDEX_CODES.values())
    async with korea_async_session() as s:
        rows = (await s.execute(text(
            "SELECT code, time, close FROM index_ohlcv_daily "
            "WHERE code = ANY(:codes) AND time BETWEEN :start AND :end ORDER BY time"
        ), {"codes": codes, "start": start, "end": end})).all()
    rev = {v: k for k, v in _INDEX_CODES.items()}
    out: dict[str, dict] = {k: {} for k in _INDEX_CODES}
    for code, t, close in rows:
        if close is None:
            continue
        out[rev[code]][pd.Timestamp(t)] = float(close)
    return out


# ── 유니버스 + 벌크 조회 (연도 청크 · 테이블별 세션) ────────────────────────
async def _resolve_universe() -> tuple[list[str], dict[str, str], date]:
    async with korea_async_session() as s:
        # ETF 포함(패널 1벌에 담고 엔진이 spec.universe.markets로 슬라이스). 기본 markets는
        # KOSPI/KOSDAQ이라 ETF는 명시 선택 시에만 조건 평가에 들어간다.
        rows = (await s.execute(text(
            "SELECT stock_code, market FROM stocks WHERE is_active AND market IN ('KOSPI','KOSDAQ','ETF')"
        ))).all()
        latest = (await s.execute(text("SELECT max(time) FROM ohlcv_daily"))).scalar()
    codes = [r[0] for r in rows]
    market_map = {r[0]: r[1] for r in rows}
    return codes, market_map, latest


def _year_chunks(start: date, end: date):
    y = start.year
    while y <= end.year:
        cs = max(start, date(y, 1, 1))
        ce = min(end, date(y, 12, 31))
        if cs <= ce:
            yield cs, ce
        y += 1


async def _fetch_chunked(sql: str, ctx: PanelContext, columns: list[str]) -> pd.DataFrame:
    """연도별 별도 세션으로 SELECT (하이퍼테이블 청크 락 해제). 결과를 하나로 concat."""
    frames = []
    for cs, ce in _year_chunks(ctx.start, ctx.end):
        async with korea_async_session() as s:
            rows = (await s.execute(text(sql), {"start": cs, "end": ce, "codes": ctx.codes})).all()
        if rows:
            frames.append(pd.DataFrame(rows, columns=columns))
    if not frames:
        return pd.DataFrame(columns=columns)
    return pd.concat(frames, ignore_index=True)


class RawFetcher:
    """어댑터가 요청하는 원천 테이블을 **한 번만** 조회 (memoize) — 어댑터 간 ohlcv/mcap 중복 방지."""

    def __init__(self, ctx: PanelContext):
        self.ctx = ctx
        self._cache: dict[str, pd.DataFrame] = {}

    async def get(self, source: str) -> pd.DataFrame:
        if source in self._cache:
            return self._cache[source]
        df = await getattr(self, f"_{source}")()
        self._cache[source] = df
        return df

    async def _ohlcv(self) -> pd.DataFrame:
        df = await _fetch_chunked(
            "SELECT time, stock_code AS stock, adj_open, adj_close, close_price, trading_value "
            "FROM ohlcv_daily WHERE time BETWEEN :start AND :end AND stock_code = ANY(:codes)",
            self.ctx, ["time", "stock", "adj_open", "adj_close", "close_price", "trading_value"])
        df["time"] = pd.to_datetime(df["time"])
        for c in ("adj_open", "adj_close", "close_price", "trading_value"):
            df[c] = pd.to_numeric(df[c], errors="coerce")
        return df

    async def _mcap(self) -> pd.DataFrame:
        df = await _fetch_chunked(
            "SELECT time, stock_code AS stock, market_cap FROM market_cap_daily "
            "WHERE time BETWEEN :start AND :end AND stock_code = ANY(:codes)",
            self.ctx, ["time", "stock", "market_cap"])
        df["time"] = pd.to_datetime(df["time"])
        df["market_cap"] = pd.to_numeric(df["market_cap"], errors="coerce")
        return df

    async def _investor(self) -> pd.DataFrame:
        df = await _fetch_chunked(
            "SELECT time, stock_code AS stock, investor_type AS type, net_buy_value AS net "
            "FROM investor_trading WHERE time BETWEEN :start AND :end "
            "AND investor_type IN ('FOREIGN','INSTITUTION','RETAIL') AND stock_code = ANY(:codes)",
            self.ctx, ["time", "stock", "type", "net"])
        df["time"] = pd.to_datetime(df["time"])
        df["net"] = pd.to_numeric(df["net"], errors="coerce").fillna(0.0)
        return df

    async def _floating(self) -> pd.DataFrame:
        # base_date <= end 전 이력 (merge_asof backward). 유효값(>0)만 — NULL 적재 행 제외.
        async with korea_async_session() as s:
            rows = (await s.execute(text(
                "SELECT stock_code AS stock, base_date, floating_shares, total_shares "
                "FROM floating_shares WHERE base_date <= :end AND floating_shares > 0 AND total_shares > 0 "
                "AND stock_code = ANY(:codes)"
            ), {"end": self.ctx.end, "codes": self.ctx.codes})).all()
        df = pd.DataFrame(rows, columns=["stock", "base_date", "floating_shares", "total_shares"])
        if not df.empty:
            df["base_date"] = pd.to_datetime(df["base_date"])
            df["floating_shares"] = pd.to_numeric(df["floating_shares"], errors="coerce")
            df["total_shares"] = pd.to_numeric(df["total_shares"], errors="coerce")
        return df

    async def _fin(self) -> pd.DataFrame:
        # financial_metrics_quarterly는 하이퍼테이블 아님(소형·~3만 actual행) → 단일 SELECT.
        # actual만 조회 = look-ahead 원천 차단(preliminary/estimate 제외). CFS+OFS 둘 다(어댑터가 coalesce).
        async with korea_async_session() as s:
            rows = (await s.execute(text(
                "SELECT stock_code AS stock, period_end, fs_type, revenue, operating_profit, "
                "net_income, eps, bps, roe, roa, operating_margin, collected_at "
                "FROM financial_metrics_quarterly WHERE data_type = 'actual' AND stock_code = ANY(:codes)"
            ), {"codes": self.ctx.codes})).all()
        cols = ["stock", "period_end", "fs_type", "revenue", "operating_profit",
                "net_income", "eps", "bps", "roe", "roa", "operating_margin", "collected_at"]
        df = pd.DataFrame(rows, columns=cols)
        for c in ("revenue", "operating_profit", "net_income", "eps", "bps",
                  "roe", "roa", "operating_margin"):
            df[c] = pd.to_numeric(df[c], errors="coerce")
        return df

    async def _etf_master(self) -> pd.DataFrame:
        # etf_master_daily = 하이퍼테이블 아님(~9만 행) → 단일 SELECT. 비ETF 코드는 자연 부재.
        async with korea_async_session() as s:
            rows = (await s.execute(text(
                "SELECT etf_code AS stock, snapshot_date, net_asset, listed_shares, total_fee "
                "FROM etf_master_daily WHERE etf_code = ANY(:codes)"
            ), {"codes": self.ctx.codes})).all()
        cols = ["stock", "snapshot_date", "net_asset", "listed_shares", "total_fee"]
        df = pd.DataFrame(rows, columns=cols)
        if not df.empty:
            df["snapshot_date"] = pd.to_datetime(df["snapshot_date"])
            for c in ("net_asset", "listed_shares", "total_fee"):
                df[c] = pd.to_numeric(df[c], errors="coerce")
        return df

    async def _foreign(self) -> pd.DataFrame:
        # foreign_ownership = 하이퍼테이블(236 청크) → 연도 청크(ohlcv와 동일 패턴).
        df = await _fetch_chunked(
            "SELECT time, stock_code AS stock, frn_ownership_ratio, frn_limit_ratio "
            "FROM foreign_ownership WHERE time BETWEEN :start AND :end AND stock_code = ANY(:codes)",
            self.ctx, ["time", "stock", "frn_ownership_ratio", "frn_limit_ratio"])
        df["time"] = pd.to_datetime(df["time"])
        for c in ("frn_ownership_ratio", "frn_limit_ratio"):
            df[c] = pd.to_numeric(df[c], errors="coerce")
        return df


# ── 빌드 + join ────────────────────────────────────────────────────────────
async def _build(progress_cb=None) -> dict:
    def prog(p):
        if progress_cb:
            progress_cb(p)

    async with _build_lock:
        versions = await adapter_versions()
        if _PANEL is not None and _PANEL["versions"] == versions:
            return _PANEL  # 대기 중 다른 빌드가 끝냄

        prog(3)
        codes, market_map, latest = await _resolve_universe()
        ctx = PanelContext(start=ad.DATA_START, end=latest.date() if hasattr(latest, "date") else latest,
                           codes=codes, market_map=market_map, versions=versions)

        # 원천 조회 (memoize) — 어댑터가 선언한 소스의 합집합을 한 번씩.
        fetcher = RawFetcher(ctx)
        needed: set[str] = set()
        for a in ad.ADAPTERS:
            needed |= a.required_sources()
        raw_by_adapter: dict[str, dict] = {}
        # 조회 진행률 0→45
        srcs = sorted(needed)
        for i, src in enumerate(srcs):
            await fetcher.get(src)
            prog(3 + int((i + 1) / len(srcs) * 42))
        for a in ad.ADAPTERS:
            raw_by_adapter[a.namespace] = {s: fetcher._cache[s] for s in a.required_sources()}

        t0 = _time.monotonic()

        def _compute() -> pd.DataFrame:
            frames = {a.namespace: a.build(raw_by_adapter[a.namespace], ctx) for a in ad.ADAPTERS}
            base = frames["price"].sort_values(["stock", "time"])
            flow = frames["flow"]
            df = base.merge(flow, on=["time", "stock"], how="left")
            # fin/own/etf는 price 스파인에 left-join(각 (time,stock) 유일 → 행 증식 없음). 없는 날 = NaN
            # (수치 지표 비교는 NaN→False로 신호 안 냄 — 기존 price/flow 행·값 불변, C1/C2 회귀 안전).
            for ns in ("fin", "own", "etf"):
                if ns in frames:
                    df = df.merge(frames[ns], on=["time", "stock"], how="left")
            # ETF mcap 폴백: market_cap_daily 결측 ETF는 net_asset 기반 NAV(억)로 채움 →
            # universe min_mcap 필터가 ETF에도 동작. (헬퍼 컬럼은 소비 후 즉시 drop — 카탈로그 밖.)
            if "_etf_mcap_eok" in df.columns:
                df["mcap"] = df["mcap"].where(df["mcap"].notna(), df["_etf_mcap_eok"])
                df = df.drop(columns=["_etf_mcap_eok"])
            # flow 없는 (종목,일)은 태그 False·수치 NaN — is_true가 정상 동작하도록 태그 fillna(False).
            tag_cols = [c for c in df.columns if c.startswith("tag_")]
            if tag_cols:
                df[tag_cols] = df[tag_cols].fillna(False).astype(bool)
            df["market"] = df["stock"].map(market_map)
            # 메모리/디스크 절반: 지표·가격 float64→float32 (수익률은 비율이라 float32 정밀도 충분,
            # 벤치마크 로그 누적만 엔진에서 float64로 승격). 비교 시 engine이 float64로 업캐스트.
            f64 = df.select_dtypes(include=["float64"]).columns
            if len(f64):
                df[f64] = df[f64].astype("float32")
            return df.sort_values(["stock", "time"]).reset_index(drop=True)

        df = await asyncio.to_thread(_compute)
        prog(52)

        indices = await _fetch_indices(ctx.start, ctx.end)  # 벤치마크 kospi/kosdaq (경량)

        meta = {
            "period": {"start": ctx.start.isoformat(), "end": ctx.end.isoformat()},
            "n_stocks": int(df["stock"].nunique()),
            "n_rows": int(len(df)),
            "built_at": date.today().isoformat(),
            "build_secs": round(_time.monotonic() - t0, 1),
        }
        panel = {"df": df, "versions": versions, "meta": meta, "indices": indices}
        # pickle dump ~460MB — 동기 실행 시 이벤트 루프 수 초 블로킹 → 스레드로 격리.
        await asyncio.to_thread(_save_cache, panel)
        _set_panel(panel)
        prog(55)
        logger.info("backtest panel built: %s rows, %s stocks, versions=%s",
                    meta["n_rows"], meta["n_stocks"], versions)
        return panel


def _set_panel(panel: dict) -> None:
    global _PANEL
    _PANEL = panel


# ── pickle 캐시 ────────────────────────────────────────────────────────────
def _save_cache(panel: dict) -> None:
    try:
        _CACHE_DIR.mkdir(parents=True, exist_ok=True)
        with open(_CACHE_DIR / "panel.pkl", "wb") as f:
            pickle.dump({"versions": panel["versions"], "meta": panel["meta"],
                         "df": panel["df"], "indices": panel.get("indices", {})},
                        f, protocol=pickle.HIGHEST_PROTOCOL)
    except Exception as e:  # noqa: BLE001 — 캐시 실패는 치명적 아님 (메모리로 서빙)
        logger.warning("backtest panel cache save skipped: %s", e)


def _load_cache(versions: dict) -> dict | None:
    p = _CACHE_DIR / "panel.pkl"
    if not p.exists():
        return None
    try:
        with open(p, "rb") as f:
            obj = pickle.load(f)
        # "indices" 부재 = C2 이전 캐시 → 재빌드 유도(벤치마크 kospi/kosdaq에 필요).
        if obj.get("versions") == versions and "indices" in obj:
            return {"df": obj["df"], "versions": obj["versions"], "meta": obj["meta"],
                    "indices": obj["indices"]}
    except Exception as e:  # noqa: BLE001 — 손상 캐시면 무시하고 재빌드
        logger.warning("backtest panel cache load skipped: %s", e)
    return None


# ── 진입점: lazy ensure (stale 시 백그라운드 재빌드 + 이전 버전 서빙) ────────
async def ensure_panel(progress_cb=None) -> dict:
    global _bg_refreshing
    versions = await adapter_versions()

    if _PANEL is not None:
        if _PANEL["versions"] == versions:
            return _PANEL
        # stale → 이전 버전 서빙 + 백그라운드 재빌드 (한 번만)
        if not _bg_refreshing:
            _bg_refreshing = True

            async def _bg():
                global _bg_refreshing
                try:
                    await _build()
                except Exception as e:  # noqa: BLE001
                    logger.warning("backtest panel bg refresh failed: %s", e)
                finally:
                    _bg_refreshing = False

            task = asyncio.create_task(_bg())
            _bg_tasks.add(task)
            task.add_done_callback(_bg_tasks.discard)
        return _PANEL

    # 메모리 없음 → 캐시 로드 시도, 없으면 풀 빌드 (job 진행률에 반영).
    # pickle load ~460MB — 이벤트 루프 블로킹 방지 위해 스레드로 격리.
    cached = await asyncio.to_thread(_load_cache, versions)
    if cached is not None:
        _set_panel(cached)
        if progress_cb:
            progress_cb(55)
        return cached
    return await _build(progress_cb)


def get_cached_meta() -> dict | None:
    """빌드 없이 현재 메모리 패널 메타 (catalog 응답용). 없으면 None."""
    return _PANEL["meta"] if _PANEL is not None else None


async def fetch_stock_names(codes: list[str]) -> dict[str, str]:
    """종목코드 → 종목명 (stocks 테이블, read-only). 결과 에피소드 표시용 경량 조회.

    패널(458MB pickle)에 이름을 싣지 않고 에피소드 등장 코드에 대해서만 조회 —
    캐시 포맷 불변·부하 무시 가능(수천 코드 단일 SELECT).
    """
    if not codes:
        return {}
    async with korea_async_session() as s:
        rows = (await s.execute(text(
            "SELECT stock_code, stock_name FROM stocks WHERE stock_code = ANY(:codes)"
        ), {"codes": codes})).all()
    return {r[0]: r[1] for r in rows}
