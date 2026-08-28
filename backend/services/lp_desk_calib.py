"""LP 데스크 인트라데이 캘리브레이션 — lp-system-design.md §14.5 **캘리브레이션 층**.

§14.5는 호가를 2층으로 쪼갠다. 이 모듈은 그중 **배치 층**이다.

    호가 층(실시간·프론트)  매도 = tick↑(iNAV × (1+x_ask)) / 매수 = tick↓(iNAV × (1+x_bid))
    캘리브 층(여기)         x = μ_g ± z·√(σ_g² + σ_r²)  의 재료 (μ_g·σ_g·σ_r)

**4차 보완 (2026-08-21) — 두 분포 결합 2σ.** x는 이제 분위수 선택이 아니라 **두 괴리 분포를
합친 폭**이다: NAV에서 벌어지는 폭(g)과, 그 사이 선물 대비로 밀릴 수 있는 폭(s의 단기 증분).
분위수는 표시·참고용으로 남는다.

    σ_g = g의 **pooled 레벨 σ** (일중 demean 아님 — 날짜 간 레벨 이동까지 포함)
    σ_r = **지평 T에서 직접 잰** s의 변화 σ (`s_diff_sigma_bp[T]` — T = 1/2/5분, 프론트 선택)
    x_ask = μ_g + z·σ_comb  /  x_bid = μ_g − z·σ_comb   (z 기본 2.0, 프론트 튜너)

**5차 보완 (2026-08-21) — √T 환산 폐기.** 종전엔 30초 증분 σ에 √(T/30s)를 곱해 지평 σ를 만들었다.
그 가정(랜덤워크)이 **데이터에서 기각된다**: 305540 실측으로 30초 증분 7.84bp를 √10 환산하면
25.0bp인데 5분 변화를 직접 재면 **17.2bp**(분산비 0.47), 1분은 9.8bp(VR 0.77)다. s는 되돌리는
성질이 있고 30초 증분에는 호가 바운스 잡음이 섞여 있어, √T는 지평이 길수록 σ_r을 부풀린다 —
그 부풀림이 제안 호가를 30~70bp씩 벌려 놓은 주범이었다. 이제 **각 지평을 직접 잰다**.

`g_t = (P_t − NAVʳ_t)/NAVʳ_t` (NAVʳ = 당일 PDF × 구성종목 30초봉 + 현금, /CU)는 "현재가가
장중 NAV에서 몇 bp 벌어져 거래되나"다. **4차 정정으로 이게 호가 x의 중심(μ)이 됐다** — LP 호가는
NAV 주변에 서야 하고, g는 그 감각과 맞는 유일한 양이다. μ·σ 모두 raw 레벨(demean 아님)로 낸다 —
호가 위치로 직접 곱해지므로 ETF별 상수 프리미엄/디스카운트도 그대로 실려야 한다. 선물이 필요
없어 표본은 09:10~15:20 하루 전체(740봉/일)다.

`s_t`는 "ETF가 β 조합 선물 대비 전일종가에서 얼마나 벌어졌나"의 장중 경로다:

    s_t = (P_t/P_전일종가 − 1) − β_K×(F_K,t/F_K,전일 − 1) − β_Q×(F_Q,t/F_Q,전일 − 1)   (bp)

**s의 레벨은 호가에서 빠져 있다.** 섹터 ETF는 지수와 무관한 고유 요인으로 일중 ±100~200bp
움직이는데, 3차 구조는 그 전부를 호가 위치에 실어 제안 호가를 NAV 대비 200~300bp 밖에 세웠다.
그건 호가가 아니라 **헤지 잔차 리스크**의 크기다. 4차 보완이 쓰는 건 s의 **레벨이 아니라 변화**
(`s_diff_sigma_bp`) — "호가가 걸려 있는 몇 분 사이에 선물 대비로 얼마나 밀리나"이며, 이건 호가 폭에
들어가야 하는 리스크다. 레벨 분위수·경로는 잔차 감각·상세 표시용 참고 통계로 남는다
(표본 11:26~15:20, 선물 30초봉 제약).

두 축 모두 분위수와 함께 **도달 일수**(창 N일 중 그 레벨이 한 번이라도 열린 날 수)를 낸다 —
"얼마나 자주 열리나"를 단조 지표로 읽기 위해서다. x는 분위수가 아닌 임의 레벨이라, g는 **일별
극값 배열**(`g_day_max`/`g_day_min`)을 그대로 실어 보내 프론트가 그 x의 도달 일수를 직접 센다.

규약·주의:
- 30초봉은 raw(무수정) 종가끼리 비교한다. s의 앵커는 `ohlcv_daily`의 **직전 거래일 raw 종가
  (lag)**다. ⚠️ 배당락·분할일에는 이 앵커가 실시간 호가 층과 **어긋난다** — 거래소(그리고 LS
  틱의 prev_close)는 락 조정된 **기준가**를 주는데 여기 lag close는 조정 전 값이라, 배당락일
  하루치 s가 배당락률만큼(분배금 ETF 기준 통상 수십~수백 bp) 통째로 밀린다. 분기 배당 ETF면
  창 10일 중 1일 오염 = 분위수가 그 방향으로 살짝 끌린다. 실시간 층까지 같은 정의로 맞추려면
  `corporate_actions`/분배금으로 앵커를 조정해야 하나, 현재는 **알려진 한계로 남긴다**.
  g는 같은 날 PDF×구성종목 종가 대 ETF 종가라 raw끼리가 정합 (lp_desk_stats._GAP_SQL과 동일).
- **가격 없는 레그는 바스켓에서 뺀다** (2026-08-26 사용자 확정, §14.3): 창 전체에 30초봉이 하나도
  없는 비현금 구성(커버드콜 ETF의 옵션·선물 레그 등)은 재구성 대상에서 제외하고 **주식+현금만으로**
  다른 ETF와 같은 g를 낸다. 종전 규칙("구성 중 하나라도 결측이면 그 봉 폐기")은 그런 ETF의 g를
  통째로 0봉으로 만들었다. 제외한 레그의 가치만큼 μ_g에 레벨 편차가 실리는 건 **감수**하고,
  몇 개를 뺐는지는 `excluded_legs`로 화면에 밝힌다.
- 단일가 구간 제외: KST **09:10~15:20** bar만 사용 (개장 직후 변동·마감 동시호가 배제).
- ⚠️ 선물 30초봉은 LS 수집 상한(500봉/일) 탓에 **11:26~15:45만** 존재한다. 따라서 실제 s 표본은
  11:26~15:20 구간뿐 — 오전장 스큐는 아직 관측되지 않는다 (FD가 오전분도 적재하면 자동 확장).
- 지수선물 근월물은 일자별 `futures_ohlcv_daily`(underlying 01/06, contract_class NEAR)로
  해석하고, 전일 종가는 **contract_code 직접 조회**로 잡는다. NEAR/NEXT 라벨로 조인하면 롤
  경계에서 전일치가 다른 계약을 가리킨다 (통계차익 캐리에서 같은 사고 — 커밋 4ba92f4).
- 선물 일봉 `settle_price`는 이 DB에서 0으로 적재돼 있어 **close**를 전일 앵커로 쓴다.

캐시: 시간 TTL이 아니라 **데이터 버전**(인트라데이 최신 봉 시각 + lp_desk_stats 패널 버전) 기반.
백그라운드 루프가 1시간마다 버전만 프로브하고, 바뀐 경우에만 재계산한다 — 인트라데이 적재는
야간 배치라 장중에는 대개 스킵된다(§14.5의 "장중 1시간 주기"를 낭비 없이 만족).
"""
from __future__ import annotations

import asyncio
import logging
import math
import time as _time
from dataclasses import dataclass, field
from datetime import date as _date, datetime, time as _dtime, timedelta, timezone
from typing import Any, NamedTuple, Sequence

import numpy as np
from sqlalchemy import text

from core.database import korea_async_session
from services import lp_desk_stats

logger = logging.getLogger("uvicorn.error")

KST = timezone(timedelta(hours=9))

BAR_SECONDS = 30            # 30초봉 (§14.5)
CALIB_DAYS = 10             # 최근 N거래일
SESSION_START = _dtime(9, 10)   # 단일가·개장 직후 제외 (KST)
SESSION_END = _dtime(15, 20)    # 마감 동시호가 제외 (KST)
CAL_LOOKBACK_DAYS = 45      # 선물/ETF 일봉 앵커 조회 여유 (휴장 포함)

QUANTILES: tuple[int, ...] = (5, 10, 25, 75, 90, 95)
UPPER_QUANTILES: frozenset[int] = frozenset({75, 90, 95})   # 상방(매도측) 레벨

# 이 미만이면 분위수 산출 포기. 하루치 표본으로 p90/p95를 확정해 버리면 그날 한 번의
# 스파이크가 곧 레벨이 된다 — 최소 3거래일치를 요구해 서로 다른 장 상황이 섞이게 한다.
# 두 축의 봉/일이 달라(선물 30초봉이 11:26~만 적재) 하한도 따로 잡는다:
#   s = 469봉/일 (11:26~15:20)  →  1400 ≈ 3일
#   g = 740봉/일 (09:10~15:20 실측)  →  2200 ≈ 3일   ← **호가 x의 하한** (4차 정정)
MIN_BARS = 1400
MIN_G_BARS = 2200

# 호가 폭 σ_r을 재는 **지평**(초) — 5차 보완. √T 환산이 아니라 각 지평의 s 변화를 직접 잰다.
# 30초봉 기준 k = 2/4/10봉. 프론트 튜너가 이 중 하나를 고른다(기본 60초).
S_DIFF_HORIZONS: tuple[int, ...] = (60, 120, 300)
# 지평별 하한. 비중첩 차분이라 표본이 k배로 줄어든다(5분이면 469봉/일 → 46쌍/일, 10일 ≈ 470쌍).
# 300쌍 미만이면 그 지평만 null — σ를 못 믿을 표본으로 호가 폭을 정하지 않는다.
MIN_DIFF_PAIRS = 300
S_HIST_BINS = 28
G_HIST_BINS = 24
G_ABS_MAX_BP = 500.0        # PDF 수량 100배 적재 이상치 컷 (§14.3과 동일 기준)

RECENT_DAYS = 3             # /detail s_recent 경로 일수
RECENT_MAX_PER_DAY = 150    # 하루 최대 점 수 (30초 → 필요 시 stride 다운샘플)

REFRESH_SECS = 3600.0       # 버전 프로브 주기 (§14.5 "장중 1시간")
RETRY_SECS = 300.0          # 실패 시 재시도 주기

K200_UNDERLYING = "01"
KQ150_UNDERLYING = "06"


def _q(p: int) -> str:
    """분위수 → 페이로드 키. `5 → 'p05'`."""
    return f"p{p:02d}"


def _r(v: Any, digits: int = 2) -> float | None:
    """JSON 안전 반올림 — NaN/Inf는 None (응답 크기도 여기서 줄인다)."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return round(f, digits) if math.isfinite(f) else None


# ---------------------------------------------------------------------------
# 쿼리
# ---------------------------------------------------------------------------

# 인트라데이 최신 봉 — 캐시 버전 키 겸 캘리브 창의 끝 날짜.
_SQL_LAST_BAR = text(
    """
    SELECT max(time) FROM ohlcv_intraday
    WHERE stock_code = ANY(:codes) AND interval_seconds = :bar
      AND time > current_date - INTERVAL '30 days'
    """
)

# KRX 휴장일 — 전일종가 신선도 판정("오늘 기준 직전 거래일")용. 미래분까지 적재돼 있어
# 최근 30일치만 받아도 충분하다 (판정은 항상 오늘에서 며칠 뒤로만 걷는다).
_SQL_HOLIDAYS = text(
    "SELECT date FROM krx_holidays WHERE date >= current_date - INTERVAL '30 days'"
)

# 지수선물 일봉 — 근월물 해석 + 전일 앵커. NEAR만 받으면 롤 경계에서 "오늘 NEAR = 어제 NEXT"인
# 계약의 전일 종가를 못 잡으므로 **두 클래스를 다 받아** contract_code로 직접 조회한다.
# ⚠️ 뷰 `futures_daily_with_class`가 아니라 **기반 테이블**을 쓴다 — 그 뷰의 NEXT 쪽은 30초봉
#    hypertable(3천만 row) 전체에 dense_rank를 돌리는 UNION이라 실측 56초다(2026-08-20).
_SQL_FUT_DAILY = text(
    """
    SELECT time::text AS d, underlying_code, contract_class, contract_code, close::float8 AS close
    FROM futures_ohlcv_daily
    WHERE underlying_code = ANY(:und) AND contract_class IN ('NEAR', 'NEXT')
      AND time >= :from_date AND close > 0 AND contract_code IS NOT NULL
    ORDER BY time
    """
)

# ETF 일봉 — 일자별 전일종가(앵커) + 최신 종가(호가 층 F_fair 기준가).
# 괴리와 마찬가지로 **raw close_price** (adj_close 아님) — 실시간 전일종가와 같은 정의.
_SQL_ETF_DAILY = text(
    """
    SELECT stock_code, time::text AS d, close::float8 AS close, prev_close::float8 AS prev_close
    FROM (
        SELECT stock_code, time, close_price AS close,
               lag(close_price) OVER (PARTITION BY stock_code ORDER BY time) AS prev_close
        FROM ohlcv_daily
        WHERE stock_code = ANY(:codes) AND time >= :from_date AND close_price > 0
    ) t
    WHERE time >= :d0
    ORDER BY stock_code, time
    """
)

# 30초봉 — (종목, 거래일) 단위 배열로 접어 받는다. row 수 17만 → 360 (asyncpg 배열 디코딩이
# row 오버헤드보다 훨씬 싸다). numeric은 Decimal로 디코딩되므로 SQL에서 float8 캐스팅.
_SQL_ETF_BARS = text(
    """
    SELECT stock_code AS code, (time AT TIME ZONE 'Asia/Seoul')::date::text AS d,
           array_agg(extract(epoch FROM time)::bigint ORDER BY time) AS ts,
           array_agg(close::float8 ORDER BY time) AS px
    FROM ohlcv_intraday
    WHERE stock_code = ANY(:codes) AND interval_seconds = :bar
      AND time >= :lo AND time <= :hi
      AND (time AT TIME ZONE 'Asia/Seoul')::time BETWEEN :t0 AND :t1
    GROUP BY 1, 2
    """
)

_SQL_FUT_BARS = text(
    """
    SELECT futures_code AS code, (time AT TIME ZONE 'Asia/Seoul')::date::text AS d,
           array_agg(extract(epoch FROM time)::bigint ORDER BY time) AS ts,
           array_agg(close::float8 ORDER BY time) AS px
    FROM futures_ohlcv_intraday
    WHERE futures_code = ANY(:codes) AND interval_seconds = :bar
      AND time >= :lo AND time <= :hi
      AND (time AT TIME ZONE 'Asia/Seoul')::time BETWEEN :t0 AND :t1
    GROUP BY 1, 2
    """
)

# 장중 재구성 NAV — 구성종목 30초봉을 (ETF, bar) 단위 SUM으로 **DB에서** 접는다.
# 결과 row는 (ETF, 거래일) 380개뿐 (봉 단위 300만 row를 파이썬으로 끌어오지 않는다).
#   · 설정현금액(H00000)은 CU 전체 요약 행이라 제외 (lp_desk_stats._GAP_SQL과 동일 규칙)
#   · **영구 결측 레그 제외** (`priced`) — 창 10일 전체에 30초봉이 하나도 없는 비현금 구성은
#     재구성 바스켓에서 아예 뺀다. 커버드콜 ETF(472150)의 옵션(B0xxxx)·선물(A0xxxx) 레그가
#     그 경우로, 종전엔 이들이 `have < n_comp`를 매 봉 만들어 **그 ETF의 g가 통째로 0봉**이었다.
#     코드 패턴이 아니라 **봉 존재 여부**로 판정한다 — 전 기간 거래정지 종목도 같은 규칙에 걸린다.
#   · 남은(가격 가능한) 구성에는 종전 규칙 그대로: have = n_comp 인 bar만 통과 → 그 봉에 하나라도
#     빠지면 NAV 과소집계라 폐기
#   · CU는 그날 스냅샷 우선, 없으면 최신
#   · `excluded`(그날 빠진 레그 수)를 같이 실어 보낸다 — 프론트 툴팁이 "이 g는 몇 개 레그를 빼고
#     잰 값인가"를 밝힐 수 있게 (§14.3 한계 표기)
_SQL_NAVR = text(
    """
    WITH pdf_all AS (
        SELECT p.etf_code, p.snapshot_date AS d, p.component_code, p.shares, p.is_cash
        FROM etf_portfolio_daily p
        WHERE p.etf_code = ANY(:codes) AND p.snapshot_date BETWEEN :d0 AND :d1
          AND NOT (p.is_cash AND p.component_code = 'H00000')
    ),
    priced AS (
        SELECT c.component_code
        FROM (SELECT DISTINCT component_code FROM pdf_all WHERE NOT is_cash) c
        WHERE EXISTS (
            SELECT 1 FROM ohlcv_intraday o
            WHERE o.stock_code = c.component_code AND o.interval_seconds = :bar
              AND o.time >= :lo AND o.time <= :hi
              AND (o.time AT TIME ZONE 'Asia/Seoul')::time BETWEEN :t0 AND :t1
        )
    ),
    pdf AS (
        SELECT * FROM pdf_all
        WHERE is_cash OR component_code IN (SELECT component_code FROM priced)
    ),
    side AS (
        SELECT a.etf_code, a.d,
               sum(CASE WHEN a.is_cash THEN a.shares::float8 ELSE 0 END) AS cash,
               count(*) FILTER (WHERE NOT a.is_cash AND pr.component_code IS NOT NULL) AS n_comp,
               count(*) FILTER (WHERE NOT a.is_cash AND pr.component_code IS NULL) AS excluded
        FROM pdf_all a
        LEFT JOIN priced pr ON pr.component_code = a.component_code
        GROUP BY 1, 2
    ),
    cu_latest AS (
        SELECT DISTINCT ON (etf_code) etf_code, creation_unit
        FROM etf_master_daily
        WHERE etf_code = ANY(:codes) AND creation_unit > 0
        ORDER BY etf_code, snapshot_date DESC
    ),
    cu AS (
        SELECT s.etf_code, s.d, s.cash, s.n_comp, s.excluded,
               coalesce(nullif(m.creation_unit, 0), cl.creation_unit)::float8 AS cu
        FROM side s
        LEFT JOIN etf_master_daily m ON m.etf_code = s.etf_code AND m.snapshot_date = s.d
        LEFT JOIN cu_latest cl       ON cl.etf_code = s.etf_code
    ),
    comp AS (
        SELECT o.stock_code, (o.time AT TIME ZONE 'Asia/Seoul')::date AS d, o.time, o.close
        FROM ohlcv_intraday o
        WHERE o.stock_code = ANY(ARRAY(SELECT component_code FROM priced))
          AND o.interval_seconds = :bar
          AND o.time >= :lo AND o.time <= :hi
          AND (o.time AT TIME ZONE 'Asia/Seoul')::time BETWEEN :t0 AND :t1
    ),
    navr AS (
        SELECT pdf.etf_code, pdf.d, comp.time,
               sum(pdf.shares::float8 * comp.close::float8) AS gross,
               count(*) AS have
        FROM pdf JOIN comp ON comp.stock_code = pdf.component_code AND comp.d = pdf.d
        WHERE NOT pdf.is_cash
        GROUP BY 1, 2, 3
    )
    SELECT n.etf_code AS code, n.d::text AS d, cu.excluded AS excluded,
           array_agg(extract(epoch FROM n.time)::bigint ORDER BY n.time) AS ts,
           array_agg(((n.gross + cu.cash) / cu.cu) ORDER BY n.time) AS navr
    FROM navr n
    JOIN cu ON cu.etf_code = n.etf_code AND cu.d = n.d
    WHERE n.have = cu.n_comp AND cu.cu > 0 AND (n.gross + cu.cash) > 0
    GROUP BY 1, 2, 3
    """
)


# ---------------------------------------------------------------------------
# numpy 커널
# ---------------------------------------------------------------------------


def _arr(v: Sequence[Any] | None, dtype) -> np.ndarray:
    return np.asarray(v if v else (), dtype=dtype)


def _match(ts: np.ndarray, ref_ts: np.ndarray, ref_val: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """`ts`의 각 봉에 대응하는 `ref` 값 (정확히 같은 timestamp만 매칭).

    30초 격자가 서로 같아도 결측봉이 있을 수 있어 위치 가정을 하지 않는다. 정렬된 ref에
    searchsorted 한 번 — 봉마다 dict 조회하는 것보다 한 자릿수 빠르다.
    """
    if ref_ts.size == 0 or ts.size == 0:
        return np.zeros(ts.size, dtype=bool), np.zeros(ts.size)
    idx = np.clip(np.searchsorted(ref_ts, ts), 0, ref_ts.size - 1)
    return ref_ts[idx] == ts, ref_val[idx]


def _touch_days(day_max: np.ndarray, day_min: np.ndarray, level: float, upper: bool) -> int:
    """그 레벨이 **한 번이라도 열린 날 수** (창 N일 중).

    앞서 쓰던 "도달 클러스터 수/일"은 **비단조**였다 (실측: p90 0.1회 < p95 1.9회 — 더 극단인
    레벨이 더 자주 열리는 것처럼 보임). 클러스터는 레벨을 넘나든 *횟수*라, 레벨이 분포 꼬리로
    갈수록 크로싱이 줄어 값이 다시 커질 수 있기 때문이다. 체결 가능성으로 읽히는 지표가
    비단조면 오독을 부른다.

    도달 일수는 정의상 단조다 — 상방은 레벨이 높을수록 `max(s) ≥ level`인 날이 줄고, 하방도
    같은 이유로 줄기만 한다. "10일 중 N일 도달"로 그대로 읽힌다.
    """
    return int(np.count_nonzero(day_max >= level if upper else day_min <= level))


def _s_sigmas(
    s_days: list[tuple[str, np.ndarray, np.ndarray]]
) -> tuple[float | None, dict[str, float | None]]:
    """s의 (30초 증분 σ, **지평별 직접 측정 σ**) — 호가 폭 σ_r의 재료 (5차 보완).

    반환 2번째가 정본이다: `{"60": σ(1분), "120": σ(2분), "300": σ(5분)}` (bp, 키는 초).
    각 지평 T에서 **비중첩** 차분 `s[i+k] − s[i]`(k = T/30초)의 pooled σ를 직접 잰다. 종전처럼
    30초 증분에 √(T/30s)를 곱하면 지평이 길수록 σ_r이 부풀려진다 — s는 되돌리는 성질이 있고
    30초 증분에는 호가 바운스가 섞여 있어 랜덤워크 가정이 실측에서 기각된다(305540: 30초 7.84 →
    √10 환산 25.0 vs 5분 직접 17.2bp, 분산비 0.47). 첫 값(`s_inc_sigma_bp`, 30초)은 그 대비를
    화면에 남기기 위한 **참고 표시용**으로만 유지한다.

    위생 규칙은 지평과 무관하게 같다 — 차분의 양 끝이 **정확히 k×30초** 떨어져 있어야 한다:
      · **일 경계** — 종가→익일 시가는 몇 분 움직임이 아니다(앵커도 바뀐다). 날짜별로 끊는다.
      · **결측봉** — 봉 간격이 30초가 아닌 지점에서 끊는다. s의 격자는 **ETF ∩ 선물 봉의 교집합**
        이라(ETF 30초봉 자체는 실측 100% 연속) 선물 쪽 결측이 그대로 갭이 된다 — 실제로 걸린다.
    그래서 하루치를 **연속 구간**으로 먼저 쪼갠다. 구간 안에서는 인덱스 거리 k = k×30초이므로
    지평별 차분이 timestamp 재검사 없이 벡터 연산 한 번으로 끝난다.

    하한: 30초 증분은 s 분위수와 같은 `MIN_BARS`(≈3거래일), 지평별 차분은 `MIN_DIFF_PAIRS`.
    """
    incs: list[np.ndarray] = []
    diffs: dict[int, list[np.ndarray]] = {h: [] for h in S_DIFF_HORIZONS}
    for _, ts, sv in s_days:
        if ts.size < 2:
            continue
        for seg in np.split(sv, np.flatnonzero(np.diff(ts) != BAR_SECONDS) + 1):
            if seg.size < 2:
                continue
            incs.append(np.diff(seg))
            for h, chunks in diffs.items():
                k = h // BAR_SECONDS
                n = (seg.size - 1) // k      # 비중첩 쌍 수
                if n:
                    chunks.append(seg[k : n * k + 1 : k] - seg[: n * k : k])

    def _pooled(chunks: list[np.ndarray], floor: int) -> float | None:
        if not chunks:
            return None
        v = np.concatenate(chunks)
        return _r(v.std(ddof=1)) if v.size >= floor else None

    return (
        _pooled(incs, MIN_BARS),
        {str(h): _pooled(chunks, MIN_DIFF_PAIRS) for h, chunks in diffs.items()},
    )


def _histogram(values: np.ndarray, bins: int) -> dict:
    """`{bins: 경계(len=counts+1), counts}` — 프론트 SVG 히스토그램용 (lp_desk_stats와 같은 형식)."""
    if values.size == 0:
        return {"bins": [], "counts": []}
    counts, edges = np.histogram(values, bins=bins)
    return {"bins": [_r(e) for e in edges], "counts": [int(c) for c in counts]}


# ---------------------------------------------------------------------------
# 스냅샷
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class Calib:
    version: tuple[str, tuple[str, str]]
    as_of: str                          # 캘리브 창의 마지막 거래일
    dates: list[str]                    # 사용한 거래일 (오름차순)
    elapsed_ms: int
    built_at: str                       # ISO (KST)
    # code -> /master calib 블록. **표본 부족 종목은 None** (§14.9 calib nullable).
    items: dict[str, dict | None] = field(default_factory=dict)
    details: dict[str, dict] = field(default_factory=dict)  # code -> /detail 추가 블록
    prev_close: dict[str, float] = field(default_factory=dict)
    prev_close_date: dict[str, str] = field(default_factory=dict)
    holidays: frozenset[_date] = frozenset()
    # 두 축 표본의 **실측** 시각 범위. 설정값(09:10~15:20)이 아니라 봉이 실제로 존재하는 구간이다.
    #   g_window — 호가 x의 표본. 선물이 필요 없어 보통 세션 전체.
    #   s_window — 선물 30초봉 적재 구간 제약으로 11:26~ (오전 스큐는 미관측).
    s_window: str | None = None
    g_window: str | None = None

    def params(self) -> dict:
        return {
            "calib_days": len(self.dates),
            "bar_seconds": BAR_SECONDS,
            "session": f"{SESSION_START:%H:%M}~{SESSION_END:%H:%M}",
            "g_window": self.g_window,
            "s_window": self.s_window,
            "quantiles": [_q(p) for p in QUANTILES],
            # σ_r을 직접 측정한 지평 목록(초) — 프론트 지평 선택 UI의 정본 (5차 보완).
            "s_diff_horizons": list(S_DIFF_HORIZONS),
            "as_of": self.as_of,
            "built_at": self.built_at,
            "elapsed_ms": self.elapsed_ms,
        }


_state: Calib | None = None
_lock = asyncio.Lock()
_task: asyncio.Task | None = None


# ---------------------------------------------------------------------------
# 계산
# ---------------------------------------------------------------------------


async def _probe(codes: list[str]) -> tuple[tuple[str, tuple[str, str]], _date] | None:
    """캐시 버전 (인트라데이 최신 봉, lp_desk_stats 패널 버전) + 창의 마지막 거래일.

    무거운 캘리브를 돌리기 전에 이것만 본다 — 인트라데이는 야간 배치라 장중 1시간 프로브는
    대부분 여기서 끝난다 (§14.5 "1시간 주기"의 실제 비용은 이 쿼리 하나).
    """
    stats_version = await lp_desk_stats.data_version()
    async with korea_async_session() as session:
        last_bar = (await session.execute(_SQL_LAST_BAR, {"codes": codes, "bar": BAR_SECONDS})).scalar()
    if last_bar is None:
        return None
    return (last_bar.isoformat(), stats_version), last_bar.astimezone(KST).date()


async def _fetch(codes: list[str], last_date: _date) -> dict | None:
    """PG 왕복 일체 — 반환 dict는 순수 파이썬/numpy 자료구조. None이면 데이터 부족."""
    async with korea_async_session() as session:
        from_date = last_date - timedelta(days=CAL_LOOKBACK_DAYS)
        fut_rows = (await session.execute(_SQL_FUT_DAILY, {
            "und": [K200_UNDERLYING, KQ150_UNDERLYING], "from_date": from_date,
        })).all()
        if not fut_rows:
            return None

        # 근월물·종가 인덱싱 → 창(최근 CALIB_DAYS 거래일) 확정
        near: dict[tuple[str, str], str] = {}
        fut_close: dict[tuple[str, str], float] = {}
        cal_dates: set[str] = set()
        for r in fut_rows:
            fut_close[(r.contract_code, r.d)] = float(r.close)
            if r.contract_class == "NEAR":
                near[(r.underlying_code, r.d)] = r.contract_code
                cal_dates.add(r.d)
        last_str = last_date.isoformat()
        dates = sorted(
            d for d in cal_dates
            if d <= last_str
            and (K200_UNDERLYING, d) in near and (KQ150_UNDERLYING, d) in near
        )[-CALIB_DAYS:]
        if not dates:
            return None

        # 근월물 전일 종가 — 같은 contract_code의 직전 거래일 (롤 경계 안전).
        cal_sorted = sorted(cal_dates)
        prev_of = {d: cal_sorted[i - 1] for i, d in enumerate(cal_sorted) if i > 0}
        fut_anchor: dict[str, tuple[str, float, str, float]] = {}
        fut_codes: set[str] = set()
        for d in dates:
            ck, cq = near[(K200_UNDERLYING, d)], near[(KQ150_UNDERLYING, d)]
            pd = prev_of.get(d)
            pk = fut_close.get((ck, pd)) if pd else None
            pq = fut_close.get((cq, pd)) if pd else None
            if not pk or not pq:
                continue
            fut_anchor[d] = (ck, pk, cq, pq)
            fut_codes.update((ck, cq))
        dates = [d for d in dates if d in fut_anchor]
        if not dates:
            return None

        d0, d1 = _date.fromisoformat(dates[0]), _date.fromisoformat(dates[-1])
        lo = datetime.combine(d0, datetime.min.time(), tzinfo=KST)
        hi = datetime.combine(d1, datetime.max.time(), tzinfo=KST)
        bar_args = {"bar": BAR_SECONDS, "lo": lo, "hi": hi, "t0": SESSION_START, "t1": SESSION_END}

        etf_daily = (await session.execute(_SQL_ETF_DAILY, {
            "codes": codes, "from_date": from_date, "d0": d0,
        })).all()
        etf_bars = (await session.execute(_SQL_ETF_BARS, {"codes": codes, **bar_args})).all()
        fut_bars = (await session.execute(_SQL_FUT_BARS, {"codes": sorted(fut_codes), **bar_args})).all()
        navr_rows = (await session.execute(_SQL_NAVR, {
            "codes": codes, "d0": d0, "d1": d1, **bar_args,
        })).all()
        holidays = frozenset(r[0] for r in (await session.execute(_SQL_HOLIDAYS)).all())

    prev_close: dict[str, float] = {}       # 최신 종가 (호가 층 F_fair 기준가)
    prev_close_date: dict[str, str] = {}    # 그 종가의 거래일 (신선도 판정용)
    anchor: dict[tuple[str, str], float] = {}
    for r in etf_daily:
        prev_close[r.stock_code] = float(r.close)   # 날짜 오름차순 → 마지막이 최신
        prev_close_date[r.stock_code] = r.d
        if r.prev_close:
            anchor[(r.stock_code, r.d)] = float(r.prev_close)

    def _bars(rows) -> dict[tuple[str, str], tuple[np.ndarray, np.ndarray]]:
        return {
            (r.code, r.d): (_arr(r.ts, np.int64), _arr(r.px, np.float64))
            for r in rows
        }

    # 재구성에서 빠진 레그 수 — 창 안에서 최대값(옵션 만기 롤로 날마다 1~2개 흔들린다).
    # 0이면 다른 ETF와 완전히 같은 정의의 g다.
    excluded_legs: dict[str, int] = {}
    for r in navr_rows:
        n = int(r.excluded or 0)
        if n > excluded_legs.get(r.code, 0):
            excluded_legs[r.code] = n

    return {
        "dates": dates,
        "fut_anchor": fut_anchor,
        "anchor": anchor,
        "holidays": holidays,
        "prev_close": prev_close,
        "prev_close_date": prev_close_date,
        "etf_bars": _bars(etf_bars),
        "fut_bars": _bars(fut_bars),
        "excluded_legs": excluded_legs,
        "navr": {
            (r.code, r.d): (_arr(r.ts, np.int64), _arr(r.navr, np.float64))
            for r in navr_rows
        },
    }


class _Block(NamedTuple):
    """한 축(g 또는 s)의 분포 요약. 표본 부족이면 `quantiles`/`touch`가 None."""

    quantiles: dict[str, float | None] | None
    touch: dict[str, int] | None
    days: int
    bars: int
    mean: float | None            # pooled raw 평균 (레벨)
    sigma: float | None           # pooled raw σ (레벨 — demean 아님)
    day_max: np.ndarray           # 일별 극값 (len = days) — 임의 레벨의 도달 일수 판정용
    day_min: np.ndarray


_EMPTY = np.empty(0)


def _quantile_block(days: list[tuple[str, np.ndarray]], min_bars: int) -> _Block:
    """일별 경로 → 분위수·도달 일수 + 레벨 μ/σ + 일별 극값.

    일별 극값을 한 벌 만들어 6개 레벨의 도달 일수를 전부 판정한다 (레벨마다 전 봉 재순회 X).
    같은 극값 배열을 응답에도 실어, 분위수가 아닌 **임의 x 레벨**(μ±zσ)의 도달 일수를 프론트가
    같은 정의로 셀 수 있게 한다.
    """
    if not days:
        return _Block(None, None, 0, 0, None, None, _EMPTY, _EMPTY)
    all_v = np.concatenate([v for _, v in days])
    day_max = np.array([v.max() for _, v in days])
    day_min = np.array([v.min() for _, v in days])
    if all_v.size < min_bars:
        # 표본 부족 — 분위수·μ/σ는 내지 않는다(하루치 스파이크가 곧 호가 레벨이 되는 걸 막는다).
        # 극값 배열은 그대로 실어 준다 (일수 표시는 가능).
        return _Block(None, None, len(days), int(all_v.size), None, None, day_max, day_min)
    quantiles: dict[str, float | None] = {}
    touch: dict[str, int] = {}
    for p, lv in zip(QUANTILES, np.percentile(all_v, QUANTILES)):
        quantiles[_q(p)] = _r(lv)
        touch[_q(p)] = _touch_days(day_max, day_min, float(lv), p in UPPER_QUANTILES)
    return _Block(
        quantiles, touch, len(days), int(all_v.size),
        _r(all_v.mean()), _r(all_v.std(ddof=1)), day_max, day_min,
    )


def _build(
    data: dict, betas: dict[str, tuple[float, float]]
) -> tuple[dict[str, dict | None], dict[str, dict], str | None, str | None]:
    """(items, details, s_window, g_window) — 종목별 g·s 분위수/도달일수 + 두 표본의 시각 범위."""
    dates: list[str] = data["dates"]
    etf_bars = data["etf_bars"]
    fut_bars = data["fut_bars"]
    navr_map = data["navr"]
    anchor = data["anchor"]
    excluded_legs: dict[str, int] = data["excluded_legs"]

    # 선물 수익률 경로는 종목과 무관 — 날짜당 한 번만 만든다 (36종 × 10일 재계산 회피).
    fut_ret: dict[str, tuple[np.ndarray, np.ndarray, np.ndarray]] = {}
    for d in dates:
        ck, pk, cq, pq = data["fut_anchor"][d]
        kts, kpx = fut_bars.get((ck, d), (np.empty(0, np.int64), np.empty(0)))
        qts, qpx = fut_bars.get((cq, d), (np.empty(0, np.int64), np.empty(0)))
        if kts.size == 0 or qts.size == 0:
            continue
        ok, qr = _match(kts, qts, qpx / pq - 1.0)
        if not ok.any():
            continue
        fut_ret[d] = (kts[ok], (kpx / pk - 1.0)[ok], qr[ok])

    items: dict[str, dict | None] = {}
    details: dict[str, dict] = {}
    # 두 표본의 실측 시각 범위 (HH:MM — 같은 날 안의 시각이라 문자열 비교가 곧 시각 비교)
    s_lo = s_hi = ""
    g_lo = g_hi = ""

    for code, (bk, bq) in betas.items():
        s_days: list[tuple[str, np.ndarray, np.ndarray]] = []   # (날짜, ts, s bp)
        g_days: list[tuple[str, np.ndarray]] = []               # (날짜, g bp — raw 레벨)
        for d in dates:
            bars = etf_bars.get((code, d))
            if bars is None:
                continue
            ts, px = bars
            if ts.size == 0:
                continue

            # ── g (호가 x의 원천) — 선물이 필요 없으므로 세션 전체(09:10~15:20).
            # s가 없는 날(선물 봉 결측)에도 반드시 산출돼야 하므로 s보다 **먼저**, 독립으로 판정한다.
            nav = navr_map.get((code, d))
            if nav is not None and nav[0].size:
                ok_n, nav_m = _match(ts, nav[0], nav[1])
                ok_n &= nav_m > 0
                if ok_n.any():
                    g_ts = ts[ok_n]
                    g = (px[ok_n] - nav_m[ok_n]) / nav_m[ok_n] * 1e4
                    # PDF 수량 100배 적재 같은 이상치 컷 (§14.3과 같은 기준). 시각 범위는 컷 전
                    # 매칭 구간으로 잡는다 — 표본이 "언제 존재하는가"의 답은 컷과 무관하다.
                    g = g[np.abs(g) <= G_ABS_MAX_BP]
                    if g.size:
                        g_days.append((d, g))
                        lo = datetime.fromtimestamp(int(g_ts[0]), KST).strftime("%H:%M")
                        hi = datetime.fromtimestamp(int(g_ts[-1]), KST).strftime("%H:%M")
                        if not g_lo or lo < g_lo:
                            g_lo = lo
                        if hi > g_hi:
                            g_hi = hi

            # ── s (참고 — 잔차 감각) — 선물 앵커·봉이 다 있어야 성립.
            base = anchor.get((code, d))
            fr = fut_ret.get(d)
            if not base or fr is None:
                continue
            kts, rk, rq = fr
            ok, rk_m = _match(ts, kts, rk)
            _, rq_m = _match(ts, kts, rq)
            if not ok.any():
                continue
            s = ((px / base - 1.0) - bk * rk_m - bq * rq_m) * 1e4
            s_ts = ts[ok]
            s_days.append((d, s_ts, s[ok]))
            lo = datetime.fromtimestamp(int(s_ts[0]), KST).strftime("%H:%M")
            hi = datetime.fromtimestamp(int(s_ts[-1]), KST).strftime("%H:%M")
            if not s_lo or lo < s_lo:
                s_lo = lo
            if hi > s_hi:
                s_hi = hi

        g_all = np.concatenate([v for _, v in g_days]) if g_days else _EMPTY
        # g_sigma_bp는 **일별 demean 후**의 산포 — 하루 안의 흔들림만 본다. 호가 폭이 쓰는
        # σ_g(레벨 σ)와 역할이 다르다: 이건 상세 패널의 "일중 흔들림" 표시용으로 유지.
        g_dev = np.concatenate([v - v.mean() for _, v in g_days]) if g_days else _EMPTY
        g_sigma = _r(g_dev.std(ddof=1)) if g_dev.size >= 30 else None

        s_all = np.concatenate([s for _, _, s in s_days]) if s_days else _EMPTY
        g = _quantile_block(g_days, MIN_G_BARS)
        s = _quantile_block([(d, sv) for d, _, sv in s_days], MIN_BARS)
        s_inc_sigma, s_diff_sigma = _s_sigmas(s_days)

        # 호가는 g로 서므로 g만 있어도 calib은 살아 있어야 한다. 둘 다 없을 때만 null (§14.9).
        items[code] = None if (g.quantiles is None and s.quantiles is None) else {
            "g_quantiles": g.quantiles,
            "g_touch_days": g.touch,
            "g_days": g.days,
            "g_bars": g.bars,
            # 재구성 바스켓에서 뺀 레그 수(창 내 최대). >0이면 그 가치만큼 μ_g에 레벨 편차가
            # 실린다 — 커버드콜 옵션 프리미엄 등 (§14.3 한계).
            "excluded_legs": excluded_legs.get(code, 0),
            # ── 호가 x의 재료 (4차 보완 — μ ± z·√(σ_g²+σ_r²)) ──
            "g_mean_bp": g.mean,
            "g_sigma_level_bp": g.sigma,
            # σ_r 정본 = 지평별 직접 측정 (5차 보완). 30초 증분은 참고 표시용으로만 남긴다.
            "s_diff_sigma_bp": s_diff_sigma,
            "s_inc_sigma_bp": s_inc_sigma,
            # 임의 x 레벨의 도달 일수를 프론트가 직접 세도록 (분위수가 아니므로 서버가 못 센다).
            "g_day_max": [_r(v) for v in g.day_max],
            "g_day_min": [_r(v) for v in g.day_min],
            "s_quantiles": s.quantiles,
            "touch_days": s.touch,
            "g_sigma_bp": g_sigma,
            "days": s.days,
            "bars": s.bars,
        }

        details[code] = {
            "s_hist": _histogram(s_all, S_HIST_BINS),
            "s_recent": _recent_path(s_days[-RECENT_DAYS:]),
            "g_hist": _histogram(g_all, G_HIST_BINS),
            "g_sigma_bp": g_sigma,
            "g_obs": int(g_all.size),
            "s_days": s.days,
            "s_bars": s.bars,
        }

    return (
        items,
        details,
        (f"{s_lo}~{s_hi}" if s_lo and s_hi else None),
        (f"{g_lo}~{g_hi}" if g_lo and g_hi else None),
    )


def _recent_path(days: list[tuple[str, np.ndarray, np.ndarray]]) -> list[dict]:
    """최근 며칠 s 경로 — `[{t:"08-19 13:05", bp:12.34}]`. 하루 RECENT_MAX_PER_DAY로 stride 다운샘플."""
    out: list[dict] = []
    for d, ts, s in days:
        stride = max(1, math.ceil(ts.size / RECENT_MAX_PER_DAY))
        label = d[5:]   # MM-DD
        for i in range(0, ts.size, stride):
            hm = datetime.fromtimestamp(int(ts[i]), KST).strftime("%H:%M")
            out.append({"t": f"{label} {hm}", "bp": _r(s[i])})
        # 마지막 봉은 항상 남긴다 (stride에 잘려 종가 근처가 빠지면 경로 끝이 어긋난다).
        if ts.size and (ts.size - 1) % stride:
            hm = datetime.fromtimestamp(int(ts[-1]), KST).strftime("%H:%M")
            out.append({"t": f"{label} {hm}", "bp": _r(s[-1])})
    return out


async def refresh(force: bool = False) -> Calib | None:
    """캘리브 재계산 (버전이 그대로면 스킵). 동시 호출은 락으로 1회만 수행."""
    global _state
    codes = list(lp_desk_stats.universe())
    if not codes:
        return None
    async with _lock:
        probed = await _probe(codes)
        if probed is None:
            logger.warning("lp_desk calib: 30초봉 없음 — 스킵")
            return _state
        version, last_date = probed
        if not force and _state is not None and _state.version == version:
            return _state

        t0 = _time.perf_counter()
        data = await _fetch(codes, last_date)
        if data is None:
            logger.warning("lp_desk calib: 근월물/앵커 해석 실패 — 스킵")
            return _state

        master = await lp_desk_stats.master()
        betas = {
            it["etf_code"]: (float(it["beta_k200"]), float(it["beta_kq150"]))
            for it in master["items"]
            if it.get("beta_k200") is not None and it.get("beta_kq150") is not None
        }
        items, details, s_window, g_window = await asyncio.to_thread(_build, data, betas)
        elapsed = int((_time.perf_counter() - t0) * 1000)
        _state = Calib(
            version=version,
            as_of=data["dates"][-1],
            dates=data["dates"],
            elapsed_ms=elapsed,
            built_at=datetime.now(KST).isoformat(timespec="seconds"),
            items=items,
            details=details,
            prev_close=data["prev_close"],
            prev_close_date=data["prev_close_date"],
            holidays=data["holidays"],
            s_window=s_window,
            g_window=g_window,
        )
        # 호가는 g로 서므로 "몇 종에 x가 있나"는 **호가 중심 μ_g** 보유 기준으로 센다.
        ok = sum(1 for v in items.values() if v and v.get("g_mean_bp") is not None)
        logger.info(
            "lp_desk calib 갱신: g %d/%d종 (as_of=%s, %d일, %dms)",
            ok, len(codes), _state.as_of, len(data["dates"]), elapsed,
        )
        return _state


def snapshot() -> Calib | None:
    """현재 캘리브 스냅샷 (계산 트리거 없음 — /master를 절대 막지 않는다, §14.9)."""
    return _state


# ---------------------------------------------------------------------------
# 응답 병합 (§14.9)
# ---------------------------------------------------------------------------


def _prev_trading_day(today: _date, holidays: frozenset[_date]) -> _date:
    """오늘 기준 **직전 거래일** (주말 + KRX 휴장일 제외).

    오늘이 거래일이면 어제 쪽 마지막 거래일, 오늘이 휴장이면 가장 최근 거래일 — 어느 쪽이든
    "오늘 시점에서 이미 확정돼 있어야 하는 종가의 날짜"다. 휴장 테이블이 이상해도 무한 루프를
    돌지 않도록 걸음 수를 막아 둔다 (연휴 최장 6일 + 여유).
    """
    d = today - timedelta(days=1)
    for _ in range(14):
        if d.weekday() < 5 and d not in holidays:
            break
        d -= timedelta(days=1)
    return d


def decorate_master(payload: dict) -> dict:
    """/master items에 `prev_close`(+날짜·신선도) + `calib` 주입. 캘리브 없으면 전부 null로 degrade.

    `prev_close_stale` = 이 종가가 **직전 거래일보다 오래됐다**(= FD 일봉 적재가 밀렸다). 4차 정정
    이후 호가 앵커는 iNAV라 이 값은 호가와 무관하고, 프론트는 **등락률·오늘 s가 2거래일 이상
    수익률**임을 경고하는 데만 쓴다 (§14.11).

    lp_desk_stats의 items는 **패널 캐시가 들고 있는 객체**라 제자리 수정 금지 — 새 dict로 복사.
    """
    cal = snapshot()
    # 신선도 기준은 **응답 시점의 오늘** — 캘리브는 데이터 버전이 안 바뀌면 며칠도 그대로라
    # 빌드 시각에 굳혀 두면 정작 적재가 밀린 날을 못 잡는다.
    prev_td = _prev_trading_day(datetime.now(KST).date(), cal.holidays).isoformat() if cal else None
    items = []
    for it in payload.get("items", []):
        pc_date = cal.prev_close_date.get(it["etf_code"]) if cal else None
        items.append({
            **it,
            "prev_close": _r(cal.prev_close.get(it["etf_code"]), 2) if cal else None,
            "prev_close_date": pc_date,
            "prev_close_stale": bool(pc_date and prev_td and pc_date < prev_td),
            "calib": (cal.items.get(it["etf_code"]) if cal else None),
        })
    return {**payload, "items": items, "calib_params": cal.params() if cal else None}


def decorate_detail(code: str, detail: dict) -> dict:
    """/detail에 s 분포·경로 + g 분포 주입."""
    cal = snapshot()
    extra = (cal.details.get(code) if cal else None) or {
        "s_hist": {"bins": [], "counts": []}, "s_recent": [],
        "g_hist": {"bins": [], "counts": []}, "g_sigma_bp": None, "g_obs": 0,
    }
    return {**detail, **extra, "calib": (cal.items.get(code) if cal else None)}


# ---------------------------------------------------------------------------
# 백그라운드 루프
# ---------------------------------------------------------------------------


async def _loop() -> None:
    while True:
        wait = REFRESH_SECS
        try:
            await refresh()
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 — PG 일시 장애로 루프가 죽으면 안 된다
            logger.warning("lp_desk calib 갱신 실패: %s", e)
            wait = RETRY_SECS
        await asyncio.sleep(wait)


def start_background() -> None:
    """기동 시 1회 계산 + 1시간 주기 버전 프로브 (§14.5). 중복 기동 방지."""
    global _task
    if _task is not None and not _task.done():
        return
    _task = asyncio.create_task(_loop())
