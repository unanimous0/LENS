# 통계 차익거래 엔진 + 화면 (stat-arb)

> ETF LP 입장에서 **통계적 차익거래**를 주 목적으로 하되, **대여 수익**과 **주식선물 매도차익**을 결합 활용. 발굴 → 진입 → 추적 → 청산까지의 사이클 전체를 다룬다.

> ⚠️ **실측치를 근거로 튜닝하기 전에 §21(데이터 정합 이력)을 먼저 읽을 것.** 2026-07-28 이전
> 측정은 `adj_close` NULL→0 오염 위에서 나온 값이며, 오염기/클린 값을 이 문서에서 구분 표기했다.
> **현재 baseline(2026-08-02, 727봉): 1:1 4,422 · M:N 57(dedup) · s-score 527.**

## 1. 목적

### 1차 — 통계적 차익거래
- 자산군 자유 조합 (주식 / 주식선물 / 지수선물 / ETF)
- **M:N 페어** (1:1 아님). max 5×5. 필요 시 확장.
- 시간축: 초단기 (30초/1분봉) / 단기 (1분~일봉) / 중기 (일봉)

### 2차 — 대여·주식선물과의 결합
- 고요율 종목 매수 정당화 도구: 쌩매수 대신 통계차익으로 헷지된 매수 → 매수분 대여 송출
- 양방향 시너지: 통계차익으로 들어간 매수 포지션이 마침 고요율이면 대여, 베이시스 낮으면 주식선물 매도차 (수익 레이어 중첩)

### 핵심 원칙
- 통계적 엄밀성 / 정확성 최우선
- 즉시 판단·실행 가능한 고밀도 UI (차트·그래프 적극)

## 2. 핵심 결정사항 (1~11)

| # | 항목 | 결정 |
|---|---|---|
| 1 | 시간축 표시 | 토글 + 페어 상세에 3 timeframe 미니차트 |
| 2 | M×N 한도 | max 5×5. ETF↔PDF 부분 페어도 *통계 추정 대상* (사전 비중 X) |
| 3 | 갱신 주기 | 통계량 10분. Rust 엔진. |
| 4 | 자산군 매트릭스 | 8가지 카탈로그 모두 포함 + UI 토글 ON/OFF |
| 5 | 탐색 전략 | 1:1 시장 전체 무차별 (사전 필터링) + M:N은 도메인 그룹 내. Dense PCA→Sparse CCA→Johansen + Sparse PCA 병렬 트랙 |
| 6 | 갱신 비대칭 | 후보 풀 1시간/장개시, 통계량 10분 |
| 7 | 시간축 디폴트 | 없음. 페어마다 3 timeframe 다 계산, 최적 timeframe 자동 선택 |
| 8 | 엔진 위치 | 별도 binary `stat-arb-engine` (port 8300) |
| 9 | 포지션 자동 라벨 | 수렴/발산/stale/청산권장 + z 분포 시각화 (히스토그램 + 산점도) |
| 10 | 알림 | 화면 내 뱃지만 (외부 알림 없음) |
| 11 | 부분 청산 | 미지원 (한 포지션 = 한 번 진입/한 번 청산) |

## 3. 자산군 조합 카탈로그

자산군 가리지 않음. 시장 가리지 않음. 자유 혼합.

| 조합 | 예시 | 비고 |
|---|---|---|
| 주식 ↔ 주식 | 같은 섹터/지수 코호트 | 클래식 |
| 주식 ↔ 주식선물 | 한국조선해양 ↔ 한화오션선물 (교차 SF 포함) | 종목차익 페이지와는 다른 영역 |
| 주식 ↔ ETF | ETF가 그 주식 보유 시 | 비중 자동 추정 |
| ETF ↔ ETF | 같은/관련 지수, 섹터 | 가장 깨끗한 페어 |
| ETF ↔ 지수선물 | 지수 추종 ETF vs 선물 | 차익 본업 |
| ETF ↔ 구성종목 부분 바스켓 | NAV arb 변형 — *PDF 비중 X, 새 hedge ratio 추정* | 5×5의 핵심 동기 |
| 주식 ↔ 지수선물 | 베타 헷지 | 잔차가 idiosyncratic |
| SF ↔ SF / SF ↔ 지수선물 | 선물 페어 / 기간구조 | |
| ETF ↔ 주식선물 바스켓 | 현물+SF 혼합 바스켓도 가능 | |

## 4. 도메인 그룹 (탐색 범위 제한자)

자동 생성 그룹:

| 시드 | 자동 구성 |
|---|---|
| 종목 X | X + X의 SF + X가 담긴 ETF들 + 같은 지수 ETF + 같은 섹터 동종 + 그 SF들 |
| ETF Y | Y + Y의 PDF + PDF 종목들의 SF + 같은 카테고리 경쟁 ETF + 관련 지수선물 |
| 섹터 S | 섹터 주식 + SF + 섹터 ETF |
| 지수 I | 구성종목 + 구성 SF + 추종 ETF + 지수선물 + 인버스/레버리지 ETF |
| 테마 T | 사용자가 한 번 정의해두면 자동 풀 |
| 상관 클러스터 | historical correlation > 임계치 — 자산군 무관 자동 묶음 (의외 페어 발견용) |

사용자 정의 그룹: 임의 종목/SF/ETF 혼합. 워치리스트 형태.

## 5. 탐색 전략 (Phase별)

### 5.1 1:1 시장 전체 무차별
1. 사전 필터: 거래 활성도 + historical correlation > 0.5
2. 모든 페어에 OLS hedge ratio → ADF / Engle-Granger cointegration test
3. 살아남은 1:1 페어 → 후보 풀 1

### 5.2 M:N — 도메인 그룹 내 (트랙 A: Dense PCA → Sparse CCA → Johansen)
1. 그룹 안에서 Dense PCA → 후보 종목 풀 추출 (factor explanatory power)
2. 풀을 양분해서 **Sparse CCA**: 양변 다 sparse한 선형결합 추출 → M:N 직접 발굴
3. 발굴된 페어에 Johansen cointegration test → 잔차 stationarity 검증
4. half-life, R², p-value 산출

### 5.3 M:N — 도메인 그룹 내 (트랙 B: Sparse PCA)
1. 그룹 안에서 Sparse PCA: 한 factor가 k개 종목만 쓰도록 sparsity 강제
2. cluster 자체를 페어 시드로: `{ETF or 주식} ↔ {cluster}`
3. 잔차 mean-reversion 검증 → Johansen으로 stationarity 확인

### 5.4 발굴 결과 통합
- 두 트랙 결과를 *한 스크리너 테이블*에 통합
- 출처 뱃지: `[CCA]` `[sPCA]` `[1:1]`
- 중복 발견 시 dedup, 두 점수 모두 표시 (신뢰도 ↑)

### 5.5 수동 조립 + 즉시 검증
- 사용자가 종목/비중 직접 입력 → 즉시 통계량 + 백테스트
- 자동 발굴 누락 페어 보완

### 5.6 3 Timeframe 동시 계산
- 페어마다 30초/1분/일봉 모두 통계량 계산
- `best_timeframe` 자동 선택 (z-score, half-life, p-value 종합 점수)
- 스크리너 정렬은 *최고 점수 기준*. 사용자가 토글로 다른 timeframe 확인 가능.

### 5.7 갱신 주기
- **후보 풀 재발굴**: 장개시 / 1시간 (무거움)
- **통계량 갱신**: 10분 (실시간 가격 반영)

## 6. 아키텍처

```
LENS/
├── realtime/                   기존 — LS WS gateway (port 8200)
├── stat-arb-engine/            신규 — 통계 차익거래 (port 8300)
│   ├── src/
│   │   ├── main.rs             axum 서버
│   │   ├── data/               PG 로드 + realtime 스냅샷 동기화
│   │   ├── stats/              OLS, ADF, PCA, Sparse CCA, Johansen
│   │   ├── discovery/          1:1, M:N, Sparse PCA 발굴
│   │   ├── groups/             도메인 그룹 자동 생성
│   │   ├── timeframes/         30s/1m/1d 캔들 집계 + best 선택
│   │   ├── scheduler/          10분/1시간 cron
│   │   ├── api/                REST 엔드포인트
│   │   └── ls_utils/           [임시] LS 토큰/phase/holidays (lens-common 미루기)
│   └── Cargo.toml
├── backend/                    FastAPI (port 8100)
│   ├── routers/
│   │   ├── stat_arb_proxy.py   stat-arb-engine 프록시
│   │   ├── loan_rates.py       대여요율 CRUD + CSV import
│   │   ├── positions.py        포지션 CRUD
│   │   └── saved_pairs.py      즐겨찾기
│   └── data/lens.db            SQLite 영속화
└── frontend/src/pages/
    ├── stat-arb.tsx            메인 발굴 화면
    ├── stat-arb-positions.tsx  포지션 리스트
    └── stat-arb-position-detail.tsx  포지션 상세
```

### 분리 이유
- 배포 비대칭: realtime 안정 vs 통계 활발 튜닝
- 자원 격리: BLAS 연산이 realtime hot path 메모리 대역폭 침해 방지
- 장애 격리: 통계 panic/OOM이 LS WS gateway 안 죽임
- 데이터 공유 비용은 *10분 주기*라 미미

### `lens-common` 추출은 미루기
- 현재 `lens-worktree1`이 realtime 영역 작업 중 → 충돌 회피
- stat-arb-engine은 LS 토큰/phase/holidays를 *임시 자체 보유*
- worktree1 머지 후 `lens-common` workspace crate로 통합 리팩토링

## 7. 데이터 모델

### stat-arb-engine (in-memory)
```rust
struct Bar { ts: i64, open: f64, high: f64, low: f64, close: f64, volume: i64 }

enum AssetType { Stock, StockFuture, IndexFuture, ETF }

struct AssetSeries {
    code: String,
    asset_type: AssetType,
    bars_30s: VecDeque<Bar>,
    bars_1m:  VecDeque<Bar>,
    bars_1d:  VecDeque<Bar>,
}

struct Leg { code: String, asset_type: AssetType, weight: f64, side: i8 /* +1 long, -1 short */ }

enum Timeframe { Short, Mid, Long }
enum Source { CCA, SparsePCA, OneToOne, Manual }

struct PairStats {
    z_score: f64,
    half_life: f64,
    coint_p: f64,
    r_squared: f64,
    hedge_ratio: Vec<f64>,
    sample_size: usize,
    score: f64,
}

struct Pair {
    hash: String,
    legs_left: Vec<Leg>,
    legs_right: Vec<Leg>,
    source: Source,
    by_timeframe: HashMap<Timeframe, PairStats>,
    best_timeframe: Timeframe,
    last_updated: i64,
}

struct Group { id: String, name: String, group_type: GroupType, members: Vec<String> }
```

### FastAPI 영속화 (SQLite `backend/data/lens.db`)

**Connection 설정**: `_connect()`에서 PRAGMA journal_mode=WAL + busy_timeout=5000 적용 (PR-5). positions와 loan_rates가 같은 DB 파일 공유 — asyncio.to_thread 스레드풀 동시 호출 시 'database is locked' 회피. positions._close_sync 진입 시 BEGIN IMMEDIATE로 동시 close idempotency 보장.

```sql
groups (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    type         TEXT NOT NULL,  -- 'ETF', 'Index', 'Sector', 'Theme', 'User', 'Correlation'
    members_json TEXT NOT NULL,
    created_at   INTEGER NOT NULL
);

loan_rates (
    code        TEXT PRIMARY KEY,
    rate_pct    REAL NOT NULL,
    source      TEXT,           -- 'Manual', 'CSV'
    updated_at  INTEGER NOT NULL
);

saved_pairs (
    id          TEXT PRIMARY KEY,
    legs_json   TEXT NOT NULL,
    note        TEXT,
    created_at  INTEGER NOT NULL
);

positions (
    id          TEXT PRIMARY KEY,
    label       TEXT,
    status      TEXT NOT NULL,  -- 'open', 'closed'
    opened_at   INTEGER NOT NULL,
    closed_at   INTEGER,
    entry_z     REAL,
    -- 진입 시점 통계량 freeze: {alpha, beta, center, scale, basis, half_life, adf, r2}.
    -- alpha·beta·center·scale = 고정 z 좌표계 (§24). center/scale은 2026-08-27부터.
    entry_stats_json TEXT,
    note        TEXT
);

position_legs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    position_id   TEXT NOT NULL,
    asset_type    TEXT NOT NULL,
    code          TEXT NOT NULL,
    side          INTEGER NOT NULL,  -- +1 long, -1 short
    weight        REAL NOT NULL,
    qty           INTEGER NOT NULL,
    entry_price   REAL NOT NULL,
    exit_price    REAL,
    FOREIGN KEY (position_id) REFERENCES positions(id)
);

position_loans (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    position_id TEXT NOT NULL,
    leg_id      INTEGER NOT NULL,
    qty         INTEGER NOT NULL,
    rate_pct    REAL NOT NULL,
    started_at  INTEGER NOT NULL,
    ended_at    INTEGER,
    FOREIGN KEY (position_id) REFERENCES positions(id),
    FOREIGN KEY (leg_id) REFERENCES position_legs(id)
);

position_snapshots (
    position_id        TEXT NOT NULL,
    ts                 INTEGER NOT NULL,
    mark_pnl           REAL,
    loan_pnl           REAL,
    z_score            REAL,
    coint_p            REAL,
    hedge_ratio_drift  REAL,
    PRIMARY KEY (position_id, ts),
    FOREIGN KEY (position_id) REFERENCES positions(id)
);
```

## 8. API 엔드포인트

> 2026-08-03 실제 라우트 기준으로 재작성. 이전 판에는 구현되지 않은 계획 엔드포인트
> (`/pairs/validate`, `/scatter`, `POST /groups`, `/api/saved-pairs`)가 적혀 있었다.

### stat-arb-engine (port 8300)
```
GET /health
GET /debug/stats

GET /pairs                       1:1 페어 리스트 (score 내림차순)
    limit=100
    group=<group_id>             멤버 둘 다 그룹 소속인 페어만
    basis=exclude|only|all       베이시스형(같은 기초지수 복제) 처리. 미지정=exclude
    exclude_categories=<CSV>     leg 분류 태그 제외 (broad_index, leverage_inverse, …)
    asset_combo=any|etf_etf|etf_stock|stock_stock
    exclude_terms=<CSV>          종목명/코드 부분일치 제외 (대소문자 무시)
    stability=<CSV>              stable|caution|drift (Kalman 판정)
    → { total, returned, filtered, category_counts, stability_counts, pairs[] }
       ※ 지수 시계열(I:) leg 페어는 매매 불가라 모든 뷰에서 제외

GET /pairs/detail?left=&right=   1:1 상세 — 10분·일봉 헤드라인 2벌 + timeframes 6종
                                 + 히스토그램 + Kalman(KalmanStat)

GET /groups?kind=&with_members=  도메인 그룹 (index/sector/etf/etf_category)
GET /groups/{id}/pca             Dense PCA (멤버 ≥ PCA_MIN_MEMBERS)
GET /groups/{id}/mn-pair         그 그룹의 M:N 성분 전체 → { group_id, total, pairs[] }

GET /mn-pairs                    M:N 리스트 (leg 집합 기준 dedup 후)
    limit, kind
    johansen=rank1|rank0|all     Johansen 95% 판정 필터
    → { total, returned, johansen_counts, pairs[] }

GET /mn-pairs/detail?group=&component=1
                                 M:N 상세 — **일봉 전용**. 합성 X/Y 잔차 시계열 +
                                 히스토그램 + Kalman(Relative δ) + Johansen 전체

GET /s-scores                    팩터중립 s-score (|s| 내림차순)
    limit, min_abs_s, max_half_life, asset=stock|etf|any
    → { total, returned, factors{n_factors, explained_variance_ratio[], …}, items[] }
```

### backend FastAPI (port 8100)
`/api/stat-arb/*` 는 위 엔진 라우트의 **순수 프록시**(쿼리 파라미터 그대로 전달).
단 **알림만 LENS 로컬 SQLite**(`backend/data/lens.db`)이고 프록시가 아니다.
```
GET    /api/stat-arb/pairs | /pairs/detail | /groups | /groups/{id}/pca
       /groups/{id}/mn-pair | /mn-pairs | /mn-pairs/detail | /s-scores
       /health | /debug/stats                     ← 전부 8300 프록시

GET    /api/stat-arb/alerts                       목표 z 알림 리스트
POST   /api/stat-arb/alerts                       생성/갱신 (left,right,direction UPSERT)
PATCH  /api/stat-arb/alerts/{id}                  target_z / enabled / note
DELETE /api/stat-arb/alerts/{id}
POST   /api/stat-arb/alerts/{id}/triggered        발화 기록 (last_triggered_at)

GET    /api/loan-rates                            종목별 대여요율 (PnL·대여수익 계산)
PUT    /api/loan-rates/:code
POST   /api/loan-rates/csv-import

GET    /api/positions ... (positions 라우터, 별도)
POST   /api/positions/estimate-entry-band         진입일 기준 밴드 재계산 (§24.8, PG 직접 조회)
```

## 9. 화면 구조

### 9.1 `/stat-arb` 메인 발굴
- **좌측 필터 패널**: 자산군 매트릭스 (체크박스) + 도메인 그룹 선택 + timeframe 토글 + 출처 필터
- **중앙 스크리너 테이블**: 한 줄 = 한 페어. 컬럼: 페어 구성 / z-score / half-life / p-value / 최적 timeframe / 출처 뱃지 / 대여요율 / 베이시스 / 점수
- **우측 페어 상세 패널** (선택 시):
  - 스프레드 시계열 + z-score 시계열 + 과거 z 분포 히스토그램 (현재 마킹)
  - 3 timeframe 미니차트
  - hedge ratio + leg 구성
  - "이 조합으로 진입 기록" 버튼 → 포지션 등록 폼

### 9.2 수동 조립 모드 (메인 화면 내 별도 탭)
- leg 추가/삭제 UI (자산군, 종목, 방향, 비중)
- "검증" 버튼 → 즉시 통계량 표시
- "백테스트" 버튼 → 과거 시뮬레이션

### 9.3 `/stat-arb/positions` 리스트
- 테이블 컬럼: 페어 / 진입일 / 보유 / 진입 z / **고정 z** / 회귀 % / 오늘 z / 평가손익 / 대여수익 / 종합 PnL / 상태 뱃지
- **활성 포지션 z 산점도**: x=진입 z, y=**고정 z**, 대각선 = 회귀 0% — 한눈에 시급 포지션 파악
- ⚠️ 청산 판단의 자는 **고정 z**다 (§24). 롤링 z와의 뺄셈은 밴드가 움직이면 성립하지 않는다.

### 9.4 `/stat-arb/positions/:id` 상세
- **상단 헤더**: 페어 요약 / 상태 / 종합 PnL / 진입 vs **고정** z (+ 오늘 z·밴드 이동, §24) / 예상 청산 도달일
- **차트** (가장 중요):
  - Spread 시계열 (진입 마킹 + 현재 마커)
  - z-score 시계열 (±1, ±2 밴드, 청산 트리거)
  - **과거 z 분포 히스토그램 + 진입/현재 마킹**
  - 누적 PnL 스택 곡선 (통계차익 / 대여 / 매도차)
- **Leg 테이블**: 종목 / 비중 / 진입가 / 현재가 / 변동 % / leg PnL
- **통계량 변화**: 진입 시점 vs 현재 (cointegration p, half-life, R², hedge ratio drift)
- **시그널 패널**: 회귀 %, 보유일/half-life 비교, 예상 청산일, 경고 (drift 등)
- **액션**: 기록 수정(§24.7) / 청산 기록 / 메모 추가

### 자동 상태 분류
판정 z = **고정 z**(§24). 밴드도 역산도 없는 구 기록만 롤링 z로 폴백한다.
- **수렴**: `|고정 z| < |진입 z| × 0.5`
- **발산**: `|고정 z| > |진입 z| × 1.1`
- **stale**: `보유일 > half-life × 2 && 회귀 < 50%`
- **청산권장**: `|고정 z| < 0.3` 또는 진입 z와 부호 반전

## 10. PR 분해 — Phase 큰 그림

세부 진행/완료 내역은 `git log --oneline`. 여기는 *현 위치 + 남은 방향*만.

- **Phase 1** — 인프라 ✅ (PR1)
- **Phase 2** — 통계 엔진 ✅ (PR2~10): PG batch + 증분 갱신 + 1:1 발굴 + 도메인 그룹 + cron + 페어 상세 API + timeframe spectrum
- **Phase 3** — 발굴 화면 ✅
  - PR11 ✅ backend proxy + 페어 테이블 v0
  - PR12 ✅ 페어 상세 페이지 (KPI/Timeframe 테이블/스프레드·z 차트/히스토그램, lightweight-charts)
  - PR13 ✅ 화면 보강 (정렬/검색/tooltip)
- **Phase 4** — 보조 데이터 ✅
  - PR14 ✅ 대여요율 입력 + CSV import → 스크리너 컬럼 통합 (`/stat-arb/loan-rates` sub-tab)
  - PR15a ✅ PnL 시뮬레이터 — 통계차익 + 대여 레이어
  - PR15b ✅ 페어 상세에 실시간 가격/spread/z + 시뮬레이터 매수가 자동 디폴트
    - 매도차(베이시스) 레이어는 미구현 — 통계차익 페어 대상이 주식/ETF만이라 현 단계 불필요.
      선물 페어 발굴 추가 시 별 PR.
- **Phase 5** — 포지션 추적 ✅
  - PR16 ✅ SQLite 스키마 (positions/legs/loans/snapshots) + CRUD + 등록 모달 (페어 상세에서 prefill)
  - PR17 ✅ 포지션 리스트 + 자동 라벨링 (수렴/발산/stale/청산권장, 부호 반전도 청산권장) + z 산점도 (SVG)
  - PR18 ✅ 포지션 상세 — 진입 마커 차트 + 실시간 leg PnL + 통계량 변화 + 시그널(예상 청산일) + 메모/라벨 PATCH
  - PR19 ✅ 청산 기록 — leg.exit_price + loans.ended_at + status='closed'. partial close 미지원
  - PR20 ✅ 기록 수정 — `PUT /api/positions/:id` (진입일·leg 수량/진입가·라벨/메모) + entry_z 정합 정책 (§24.7)
  - PR21 ✅ 진입 밴드 재계산 — `POST /api/positions/estimate-entry-band` (진입일 이전 일봉으로
    그날의 α·β·μ·σ 복원 → 진입 z 자동 추정, §24.8)
- **Phase 6** — 후속 정리
  - PR20 `lens-common` workspace crate (worktree1 머지 후, realtime + stat-arb-engine 공유 모듈)
- **Phase 7 — M:N 발굴** (2026-05-20~21 진행)
  - PR-A ✅ 도메인 그룹 1:1 점검 + ETF 카테고리 그룹 추가 (`d344543`)
  - PR-B ✅ Dense PCA pre-filter — factor 1~3 + candidate pool top-30 (`fc3187b`)
  - PR-B.1 ✅ etf_category 멤버 확장 (underlying 구성종목 합치기) + 임계 완화
    (MIN_HALF_LIFE 3→0.5, R² 0.3→0.5) (`014cd3b`)
  - PR-C1 ✅ Sparse CCA core (Witten PMD-CCA) + 단위 테스트 4/4 (`1626214`)
  - PR-C2 ✅ 그룹별 M:N 발굴 (양변 분할 + Sparse CCA + 합성 spread OLS+ADF) +
    `GET /groups/{id}/mn-pair` + `GET /mn-pairs` API + backend proxy (`24efae8`)
  - PR-C2.1 ✅ fail 이유 카운트 + true correlation (`9d53977`)
  - PR-C3 ✅ 프론트 `/stat-arb/mn` 페이지 — 그룹 필터, leg 확장, score Top 정렬 (`fd4047a`)
  - PR-C4 ✅ **deflation** — 그룹당 최대 `MN_MAX_PER_GROUP`(3) 성분. 채택된 leg 을 후보 풀에서
    회수하고 같은 게이트로 재탐색(사영 deflation 아님 — leg 겹침 없어 포지션 집중 회피 +
    `/mn-pairs` 의 leg 집합 dedup 과 충돌하지 않음). `EtfNatural` 의 X변(ETF)은 **anchor** 라
    회수하지 않아 성분 2·3이 "같은 ETF ↔ 다른 보유주식 바스켓"이 된다.
    임계 전부 불변 → 성분 1 결과는 이전과 완전 동일. 50 → 108 페어(dedup 후, *2026-07 오염기
    측정 — §21*. 클린 데이터 현재는 dedup 후 57), M:N 단계 0.1초.
    `mn_pairs` 저장이 `HashMap<gid, Vec<MPairResult>>` 로 바뀌고
    `GET /groups/{id}/mn-pair` 응답이 `{group_id, total, pairs[]}` 객체가 됨.
  - PR-D ✅ **Johansen 공적분 검정** — `johansen.rs` 자체 구현(nalgebra Cholesky+SymmetricEigen).
    **부가 지표로만 계산하고 발굴 게이트는 그대로 뒀다** — 승격 여부는 분포 실측 후 결정.
    상세 §20.
  - PR-D 후속 ✅ (2026-08-02) — 클린 데이터 재측정 후 **게이트 승격 안 함 + 응답단 필터로 노출**
    (`/mn-pairs?johansen=rank1|rank0`). §20.5 결정 / §20.7 구현.
  - **다음 단계** (트랙 A 마무리 + 트랙 B):
    - **PR-D 잔여** — CCA 가중치 → 공적분 벡터 교체 여부(별개 트랙). 게이트 재검토는 포지션
      성과 확인 후. §20.5 참조
    - **PR-E Sparse PCA cluster (트랙 B)** — sparsity 강제 PCA로 서브클러스터 추출.
      그 cluster를 ETF/주식 1개와 페어. 1:N 형태 자연. 트랙 A (CCA)와 결과 다를 수 있음
    - **PR-F 두 트랙 통합 스크리너** — `[CCA]` `[sPCA]` `[1:1]` 출처 뱃지, dedup, 통합 score
- **Phase 8 — 후속 (우선순위 별도)**
  - 발굴 자체에 다중 timeframe (현재는 일봉. 분봉 발굴은 별도 — §12 정책 참조)
  - 수동 조립 모드 (`POST /pairs/validate`)
  - realtime 스냅샷 동기화 (현재 PG 분봉만)
  - 매도차(베이시스) 레이어 — 선물 페어 발굴 추가 시 PnL 시뮬에 합산
  - **2차 — 대여·주식선물 결합** (§1) — 통계차익 매수 포지션의 대여 송출 + 베이시스 낮으면
    선물 매도차 수익 레이어 중첩
  - **PnL 시뮬레이터 UX 개선** — 라벨/순서/설명 단순화

### 알려진 한계 (M:N PR-C 머지 후)
- **etf 그룹 fail 324개** — universe top 100 ETF만 cache → universe 밖 ETF는 PCA 입력 미포함 → M:N 발굴 X. universe top 200~300 확장 또는 cache 미존재 그룹 자동 제외 필요 (PR-C2.2)
- **현재 발굴 35 페어** — leg 1:2=17 (가장 많음 — ETF 트래킹 형태), 2:2=8, 1:3=7. Top score:
  sector:반도체 (2:2, corr=0.31, hl=1.5d, adf=-6.69, r²=0.94)
- **etf_category r²<0.5 fail 26개** — 큰 혼합 그룹 (KOSPI200 ETF + 구성종목)의 multi-leg OLS 정상 발굴 제한

### ✅ ~~bars.rs 수정주가 컬럼 교체~~ — A-1로 완료 (2026-05-20)
close_price → adj_close, ohlcv_intraday → ohlcv_intraday_adjusted view.

## 11. 통계 알고리즘 노트

### OLS hedge ratio + ADF
- Engle-Granger 2단계: OLS로 `Y = αX + ε` 추정 → ε에 ADF stationarity test
- p < 0.05 통과 시 cointegration 인정

### Half-life
- `Δε_t = θ ε_{t-1} + η_t` 회귀에서 `half-life = ln(2) / -θ`
- 작을수록 빠른 회귀, 큰 값은 stale 위험

### Dense PCA (사전 필터)
- 그룹 안 N종목의 일/분 수익률 행렬 → PCA
- 상위 k개 factor explanatory power 큰 종목만 후보 풀로

### Sparse CCA (M:N 직접 발굴)
- 두 그룹 X, Y 사이 canonical correlation 최대화
- 양변 weight에 L1 penalty → sparse 추출
- 라이브러리: `ndarray-linalg` + 자체 구현 (수렴 알고리즘)

### Johansen (M:N cointegration 검정)
- M+N 변수 시스템에서 공적분 벡터 추출 (eigendecomposition)
- trace test / max eigenvalue test 통과 시 인정

### Sparse PCA
- PCA에 sparsity 강제 (factor당 k 종목 제한)
- L1 penalty 또는 truncated power method
- cluster 자체가 페어 시드

## 12. 분봉 데이터 정책 (★ 중요 — 다음 클로드코드 필독)

### 12.1 배경 — Finance_Data DB의 분기 정책

`ohlcv_intraday` (TimescaleDB hypertable) 는 **시점 기준 자동 분기**:

| 시점 | `interval_seconds` | 출처 |
|---|---|---|
| 2026-01-02 ~ 04-24 | `60` (1분봉) | LS t8452 백필 (`ncnt=1`) |
| 2026-04-27 이후 | `30` (30초봉) | LS t8452 일배치 (`ncnt=0`) |

테이블 코멘트 그대로:
> `LS t8452 분봉 OHLCV (백필=1분봉 ncnt=1, 일배치=30초봉 ncnt=0). 30초 가용시작=2026-04-27`

확인 쿼리:
```sql
SELECT interval_seconds, COUNT(*), MIN(time)::date, MAX(time)::date
FROM ohlcv_intraday GROUP BY interval_seconds;
-- 결과 (2026-05-14 기준):
--  30 | 16,786,899 | 2026-04-27 | 2026-05-13
--  60 | 58,164,834 | 2026-01-02 | 2026-04-24
```

같은 *시계열의 연속*이지만 *interval이 시점에 따라 다름*. **Finance_Data 측 정책이고 LENS에서 변경 불가** — 이 분기를 받아들이고 처리해야 함. (`/home/una0/projects/Finance_Data/KOREA/PROJECT.md` 의 Phase 6 분봉 시스템 참조)

### 12.2 LENS의 처리 원칙 — 합치지 않는다

세 가지 안을 검토했음:
- **(A) 30초로 통일 (1분봉을 30초 2개로 split)**: 1분 안의 high/low를 *인공 복제* → 자기상관 spurious. 부정직.
- **(B) 1분으로 통일 (30초 2개를 1분 1개로 집계)**: 30초 해상도 손실. *미래 지향성*과 반대.
- **(C) ★ raw 그대로** ← **채택**

**최종 원칙**: 30초봉도 1분봉도 *raw 그대로 활용*. 인공 변환 없음.

| Rust 캐시 | 기간 | 데이터 | 미래 진화 |
|---|---|---|---|
| `bars_30s` | 2026-04-27 ~ (점차 누적) | PG 30초봉 raw | 자연 dominant |
| `bars_1m` | 2026-01-02 ~ 04-24 (4개월 고정) | PG 1분봉 raw | 시간 지나면 *너무 오래된 데이터*로 자연 fade out |
| `bars_1d` | **3년치**(§18.5, `STATARB_WARMUP_DAYS_DAILY`) | PG 일봉 `adj_close` | 변화 없음 |

```
[현재 2026-05-14]:    [···1분봉 4개월···][30초봉 보름]
[1년 후 2027-05]:     [···1분봉 4개월···][············30초봉 1년············]
[5년 후 2031-05]:     [1분봉 4개월]    [···············30초봉 5년···············]  ← 1분 데이터 점차 stale
```

### 12.3 분 단위 분석의 한계 (인정 + 우회)

분 단위 시계열이 *시기별 단편화*됨:
- 1분 단위 결과 = "2026-01-02 ~ 04-24 페어 관계" (4개월치 sample)
- 30초 단위 결과 = "2026-04-27 이후 페어 관계" (현재 보름~한달치)
- 두 결과가 *다른 시기* → 직접 비교 어려움

**근데 큰 문제 아닌 이유**:
- *중기/장기 분석*은 **일봉이 담당** — 3년치 연속 시계열 가용(§18.5). cointegration 검정/페어 발굴은 일봉이 baseline.
- *분 단위*는 **단기 entry/exit 시그널** 용도가 본질. 시기별 단편이라도 그 시점의 페어 안정성/회귀 파악엔 충분.
- 통계량 (β, half-life, R², ADF, z) 은 각각의 raw 시계열로 *개별 계산*. 비교는 *질적*으로만 (수치 직접 비교 X).

### 12.4 분석 단위별 활용 매트릭스

| Timeframe | 데이터 소스 | 활용 |
|---|---|---|
| 30초 | `bars_30s` (raw 4/27~) | 초단기 entry/exit, 일중 mean reversion 시그널 |
| 1분 | `bars_1m` (raw 1/2~4/24) | 과거 시점 1분 페어 관계 검증 (참고용) |
| 5분/30분/1시간 | 동적 집계 (PR9 예정) | 단기 페어 (며칠 보유). raw 보관 X. |
| 일 | `bars_1d` (**3년치** 수정주가 — §18.5) | 중기 페어 (수주~수개월) — *메인 발굴 기준* |
| 주/월 | 동적 집계 (PR9 예정) | 장기 페어 (수개월~수년). 일봉 N-bar 집계. |

### 12.5 추가 timeframe 처리 (PR9 예정)

raw로 *메모리에 보관하지 않고* 동적 집계 함수로:

```
5분봉 = 30초봉 10개 집계 (4/27~ 시기에 한해)
      또는 1분봉 5개 집계 (1/2~4/24 시기에 한해)
30분봉 = 30초봉 60개 / 1분봉 30개
1시간봉 = 30초봉 120개 / 1분봉 60개
주봉 = 일봉 5-bar 집계
월봉 = 일봉 ~21-bar 집계
```

집계 공식 (OHLCV):
- `open` = 첫 bar의 open
- `high` = max(high)
- `low` = min(low)
- `close` = 마지막 bar의 close
- `volume` = sum(volume)

집계는 *통계량 계산 시점*에 일회성, 결과는 `PairsState.by_timeframe` 에만 저장. raw bar는 폐기.

페어 *상세* 요청 시에는 해당 페어만 다시 집계해서 시계열 반환.

### 12.6 PR8 작업 정리 (이 섹션 정리 직후 진행 예정)

1. **`bars.rs`에 30초봉 batch 로더 추가**
   - `load_stock_intraday_batch(codes, interval_sec=30, days)` 활용 (이미 있음 — interval_sec 인자만 30 전달)
2. **워밍업에서 `bars_30s` 채움** — 14일치 (또는 30일치)
3. **`bars_1m`은 그대로 유지** — 4/24까지의 1분봉 raw. *합치지 않음*
4. **`detail.rs` 의 `timeframe_stat`** — 각 timeframe별로 *해당 raw 시계열* 그대로 분석. 빈 시계열 (예: 1분봉 시계열의 최근 14일) 은 자연스럽게 None 반환.
5. **검증** — `/pairs/detail?left=&right=` 응답에 30초/1분 timeframe 모두 정상 등장 확인.

### 12.7 향후 운영 시 주의

- *데이터 갱신 책임 분리*: 30초봉 raw / 1분봉 raw 채우는 건 Finance_Data 측. LENS는 *수동기*. PG 정책 바뀌면 (예: 30초봉도 백필되면) 자연스럽게 통합 가능.
- *1분봉 데이터 활용 frequency 줄어듦*: 시간 지날수록 1분봉 raw가 점점 오래됨. 어느 시점에 `bars_1m` 자체를 *제거하거나 보관만* 결정 필요. 운영 1년 후 재검토.
- *30초봉 메모리*: 종목당 일 ~780 bar, 14일치 = 약 11k bar. 469 종목이면 약 5.1M bar. f64×6 + i64 = 56 bytes 기준 ~285MB. 캐시 사이즈 운영 모니터링 필요.

### 12.8 수정주가 (액면분할·병합 spike 회피)

**왜**: raw close 시계열에 분할 spike가 들어가면 OLS의 잔차에 거대한 outlier 발생 →
hedge_ratio 추정 망가짐 + ADF t-stat 무력화 + half-life 계산 의미 없음. 분할 1건이
페어 발굴 결과 전체를 오염시킬 수 있음 (분할 종목이 leg에 포함된 모든 페어).

**Finance_Data 측 변경 (2026-05-16 적용)**: 주식 4년치 수정주가 적재 완료. 매일 04:30
cron이 sujung=Y + gap > 15% 자동 감지 + adj_factor UPDATE. 평상시 LS 호출 0.

**LENS 측 쿼리 매핑**:

| 자산군 | 일봉 | 분봉 (30초/1분 등 모두) |
|---|---|---|
| **주식** | `SELECT adj_close FROM ohlcv_daily` | `SELECT close FROM ohlcv_intraday_adjusted` |
| **ETF** | (분할 사례 거의 없음 — `adj_close` 사용 안전) | (동일) |
| **선물** | `futures_ohlcv_daily` raw | `futures_ohlcv_intraday` raw |
| **지수** | `index_ohlcv_daily` raw | `index_ohlcv_intraday` raw |

선물·지수는 분할 개념 없어 raw 그대로. 주식만 교체.

**ohlcv_intraday_adjusted**는 view라 *테이블명만 바꾸면 됨* (스키마 동일). `raw_close`
컬럼 별도 노출 (원본 비교용). `volume`은 raw 유지 (수량 자체는 분할 무관 데이터).

**영향 위치** (`stat-arb-engine/src/data/bars.rs`):
- 라인 153 / 432: `FROM ohlcv_daily` + `close_price` → `adj_close`
- 라인 184 / 474: `FROM ohlcv_intraday` → `FROM ohlcv_intraday_adjusted`

**영향 종목 확인 쿼리**: `SELECT * FROM corporate_actions WHERE event_date > '2026-01-01'`
(LS일렉트릭 4/13 1:5 분할, 신성이엔지 5/15 10:1 병합 등).

> ⚠️ **`adj_close` 로 바꾼 것만으로는 안전하지 않았다.** 그 컬럼이 NULL 인 구간을 로더가
> `unwrap_or(0)` 으로 **종가 0** 처리해 2026-07-28까지의 모든 통계가 오염돼 있었다.
> 경위·수정·백필과 **문서 숫자의 측정 시점 규칙은 §21 참조** — 이 문서의 실측치를 읽거나
> 새로 튜닝하기 전에 반드시 먼저 볼 것.

## 13. 외부 연동

- **베이시스**: `stock-arbitrage` 페이지 실시간 베이시스 store 재사용 → 스크리너 컬럼 + 포지션 상세 "매도차 가능성" 표시
- **실시간 가격**: realtime WS 그대로 사용 (leg별 mark price)
- **과거 데이터**: Finance_Data PG `korea_stock_data` — 일봉/분봉. 분봉 정책은 §12 참조.
- **대여요율**: 수동 입력 (외부 데이터 소스 없음). CSV 일괄 업로드 지원.

## 14. 미해결 / 나중 결정

- **자동 알림 외부 채널**: 현재 화면 뱃지만. 향후 Slack/이메일 필요 시 추가.
- **부분 청산 / 추가 진입**: 현재 미지원. 운용해보고 필요성 판단.
- **multi-user / 권한**: 단일 사용자 가정. 다중 사용자 필요 시 positions 테이블에 user_id 추가.
- **백테스트 결과 저장**: 수동 조립 백테스트 결과를 saved_pairs에 함께 저장할지.

## 15. 페어 상세(detail) 인트라데이 전환 + 부호 결정성 + 차트 UX (2026-06-19)

memory: `project_statarb_intraday_detail`. **발굴(discovery)은 여전히 일봉**, 상세 표시·시그널만 인트라데이로.

### 15.1 detail = 10분 인트라데이 (일봉 종가 스파이크 배제)
> ⚠️ 최초 30분 버킷이었으나 **2026-06-20 10분으로 축소**(사용자 요청, §16.5). 아래는 현재(10분) 상태. 계산·차트·KPI·half-life 환산 전부 10분 기준.
- **동기**: 일봉 종가에 단일가(closing auction) 튀는 값이 섞여 z·차트가 망가짐(스파이크 1개가 y축 다 잡아먹음). → 일봉 버림.
- **데이터**: 과거 1분봉(`interval=60`, ~04-24) + 최근 30초봉(`interval=30`, 04-27~)을 거래일상 연속 stitch. `ohlcv_intraday_adjusted`(수정주가) 사용.
- **헤드라인·차트 = 10분 버킷**, 비교표 = 1분/5분/10분/30분/1시간 **+ 1일**(§18.4로 일봉 행 재추가).
- **구현** (`bars.rs`): `in_continuous_session(ts)`(KST 09:01~15:19만 — 시가 09:00·마감 15:20~15:30 단일가 제외) · `bucket_ohlc(bars, ms)`(시각정렬 버킷, 일경계 안 넘음, 혼합 interval 허용) · `unified_intraday(1m, 30s)`(30초 첫 ts 이전 1분봉+30초 concat) · `load_intraday_one(pool, asset_type, code, interval, days)`.
- **on-demand 로드** (`main.rs pair_detail`): warmup 캐시의 30초는 `WARMUP_DAYS_30S=5`(5일)뿐 → 디테일은 그 페어만 30초 60일 on-demand 로드해 캐시 1분봉과 stitch. 캐시 ref는 await 전 복사 후 drop(DashMap shard lock 회피).
- **`build_pair_detail`**(`detail.rs`): 시그니처 `&AssetSeries`→`&[Bar]`(stitched raw) 2개. 10분 OLS→잔차→z→spread_series, histogram, `spread_center`(mean)/`spread_scale`(std) 필드 추가(프론트 실시간 z를 차트 z와 동일 기준으로).
- **프론트** (`stat-arb-detail.tsx`): `KPI_TF='10m'`, 실시간 z=`(liveSpread−spread_center)/spread_scale`. pnl-simulator·position-detail도 '10m'. half-life는 10분봉 개수 → 거래일 ÷38(09:00~15:10, 38봉/거래일) 환산.
- **참고**: spread_series ~250(일봉)→~1,100(30분)→~3,230(10분). 1분봉은 이동창(`WARMUP_DAYS_1M=130`)이라 detail 시작이 "오늘−130일"(현재 ~2/9), 시간 지나면 1분봉 구간이 줄어 30초로 대체됨(§12 fade).

### 15.2 페어 좌/우(=z 부호) 결정성 (중요 버그 수정)
- **증상**: 같은 페어가 볼 때마다 z 부호 뒤집힘.
- **원인**: `discovery.rs`가 후보 시리즈를 **DashMap `cache.iter()`로 순회**(비결정적 순서) → 페어 (a,b)의 좌/우가 재시작마다 뒤바뀜 → 잔차 = y−α−β·x 의 x,y가 바뀌어 z 부호 반전.
- **수정**: `series_data`를 **키로 정렬**(1:1 발굴 + 그룹 발굴 둘 다). 항상 작은 코드=left(x), 큰 코드=right(y) → 부호 안정. (열린 포지션은 자기 진입 시점 키를 써서 영향 없음.)

### 15.3 차트 UX (`components/stat-arb/charts.tsx`)
- **라이브 이어 그리기**: DB 시계열(어제까지) 끝에 실시간 현재값을 10분 버킷으로 `series.update()`(전체 리빌드 X). ts는 effect 내 `Date.now()`(render 중 호출 금지 — react-hooks/purity). 점이 많아(~3,230) `minBarSpacing 0.08`로 fitContent가 전체 기간 표시.
- **x축 KST 날짜+시간**: `tickMarkFormatter`(날짜 틱 YY-MM-DD / 인트라데이 틱 HH:MM) + 크로스헤어 `YYYY-MM-DD HH:MM`. timestamp는 UTC 취급이라 +9h 보정.
- **히스토그램 = σ 단위 커스텀 SVG**(lightweight-charts는 분포·세로선·정수 σ눈금 불가): x축 z(σ), 평균 0 + ±1σ/±2σ 세로선, y축 빈도, 현재=빨강 막대+값 라벨, 막대 호버 툴팁(σ 구간/빈도/비중).
- **두 라인차트 동기화(시간축 + 십자선)**: 체크박스 토글(기본 on). `register` prop으로 (차트 + primary series)를 부모에 등록. ① 시간축=`subscribeVisibleLogicalRangeChange`. ② 십자선=`subscribeCrosshairMove`로 한쪽 호버 시 `param.logical`로 상대 차트 같은 인덱스 값(`dataByIndex`) 조회→`setCrosshairPosition`(벗어나면 `clearCrosshairPosition`). 두 차트가 같은 timestamp(spread_series) 공유라 logical 정확히 일치. 둘 다 guard로 무한루프 방지. (히스토그램은 시간축 없어 제외.)
- **평균회귀 시그널 라벨**(`meanRevSignal`): z 부호→"롱 L/숏 R"(z>0) or "롱 R/숏 L"(z<0), |z|≥2 "진입권". 추세 해석 없이 트레이드 방향을 글자로. 상단 카드 + z차트 헤더.
- 상단 3카드 리디자인(leg=가격 히어로, spread·z=z 히어로+시그널 pill).

## 16. OLS 방향 비대칭 대응 + β 헤지 도구 (2026-06-20)

사용자 개념 Q&A(OLS 방향에 따라 잔차/β가 달라짐 · 등액 vs β-헤지 · β 드리프트)에서 출발한 4개 작업. memory: `project_statarb_intraday_detail`(§후속), `project_mn_screener_progress`(PR-D).

### 16.1 1번 차트 = 두 종목 % 등락 오버레이
- 기존 "스프레드 시계열"은 z 차트와 사실상 동일 모양(z는 스프레드의 아핀변환)이라 중복 → **1번 차트를 두 종목 % 등락(시작점 0 기준) 오버레이로 교체**.
- 백엔드 `SpreadPoint`에 `left`/`right`(그 시점 두 leg 종가) 추가 → `build_pair_detail`이 헤드라인 버킷 종가를 `.enumerate()`로 채움. 프론트 `LegCompareChart`(`charts.tsx`): 두 라인(left 초록/right 파랑), 첫 점 기준 `(v/base−1)×100`, 라이브·KST축·z차트와 시간축 동기화.
- ⚠️ **엔진 재시작 필요** — left/right 필드가 응답에 실려야 라인 그려짐. 구버전 응답엔 필드 없어 라인 빈 채로 그레이스풀.

### 16.2 β-헤지 권장 수량 (`pnl-simulator.tsx`)
- **헤지비율은 등액(1억:1억)이 아니라 β 기준**: 손익 = −(right수량)×Δ스프레드 이려면 주식 수 비율 **left:right = β:1**.
- 금액(억원) 입력 → `right수량 = round(금액 / right가)`, `left수량 = round(β × right수량)`. 토글로 "수량 직접"도. 기준가는 실시간 우선, 없으면 마지막 헤드라인봉 종가 폴백.
- β-헤지 권장 수량 블록(두 종목 주수+명목금액) 표시. 진입 기록 prefill도 이 수량 사용 → 모달이 동일 β비율로 양 leg 재계산.

### 16.3 양방향 ADF 대칭 게이트 (`discovery.rs` `evaluate_pair`)
- OLS는 y/x 선택에 따라 잔차→ADF가 비대칭(β·β'=R²). **역방향 OLS(b,a) 잔차 ADF도 계산해 둘 다 ADF_CRIT(−3.0) 통과**해야 페어 생존 → 방향 취약 페어 제거.
- 근거: 강한 기준이면 견고한 페어는 어느 방향이든 통과, 애매한 것만 걸러짐(개념 2). **대칭 정석(Johansen)은 M:N PR-D**로 보류 — M:N 경로 `discover_mn_in_group`은 아직 단방향 ADF.
- 사전필터(corr·R²·정방향 ADF) 통과분에만 1회 추가 → 비용 미미. score·표시 adf_tstat은 주 방향 유지.

### 16.4 β 드리프트 모니터 (`stat-arb-position-detail.tsx`)
- 열린 포지션에 카드: **진입 β vs 현재 β(10m), 드리프트 %, β-정합 left 권장수량**(right leg 고정 기준, Δ주). `|Δβ| ≥ 15%` 면 "재조정 검토" 경고.
- **자동 리밸런싱 안 함** — 벌어진 상태(open divergence)에서 추정한 롤링 β는 그 divergence에 오염돼, β 변화로 오인하고 재조정하면 평균회귀 베팅을 스스로 깨고 노이즈를 추격. 우리 β는 ~1년 일봉이라 비교 기준 자체는 둔감(안전). 정석 자동화 = Kalman 동적 헤지비율(v2 미정).

### 16.5 헤드라인 30분 → 10분 축소 (2026-06-20)
- 사용자 요청으로 detail 헤드라인(계산+차트+KPI)을 **30분 → 10분 버킷**으로. §15.1이 현재(10분) 상태.
- 백엔드 `detail.rs`: `BUCKET_10M_MS` 신설, headline OLS/잔차/z/histogram/center/scale를 `l10`/`r10`(10분 버킷)에서 계산. 비교표 `[1m,5m,30m,1h]`→`[1m,5m,10m,30m,1h]`(10m 추가, 30m 참고용 유지). spread_series ~1,105→~3,230점.
- 프론트: `KPI_TF`·pnl-simulator·position-detail `'30m'`→`'10m'`, KPI 라벨 `(${KPI_TF})` 템플릿화, half-life 환산 `÷13`→**`÷38`**(10분봉 38개/거래일, 09:00~15:10), 라이브 버킷 `1800s`→`600s`, `half-life.ts` `'10m':600`, `seriesTimeScale.minBarSpacing=0.08`(3,230점 fitContent 전체 표시).
- 검증: 엔진 재시작 후 API/화면 라이브 확인(10m β=10.243·ADF=-2.75·hl 23.2시간, 표 5행, 콘솔 0). 에이전트 영향검증 통과(timeframe 소비처·÷38·live 버킷 정렬·center/scale 동일 기준 모두 정합).
- ⚠️ **발굴(discovery)은 여전히 일봉** — 이번 변경은 detail 상세 표시만. 발굴 인트라데이화는 별건([[project_mn_screener_progress]]).

## 17. detail 당일분 즉석 stitch (2026-06-24)

**문제**: detail 인트라데이는 Finance_Data PG에서 로드하는데, PG 분봉은 **야간 배치**(23:00~24:00)라 장중엔 **전일 15:10까지만** 차 있음. 그래서 장중에 페어 상세를 열면 "전일 마지막점 + 실시간 1점(페이지 머무는 동안만 누적)" 사이가 빈칸. 라이브 append는 페이지 이탈 시 소실.

**해결 (방식 3a — 당일분 즉석 로드)**: detail 생성 시 LS `t8412`(주식차트 N분)로 **오늘 09:00~현재 분봉**을 받아 전일까지의 DB 인트라데이 뒤에 stitch. 페이지 열 때마다 "그 순간까지" 당일 전체가 채워지고(이탈/새로고침해도 재진입 시 다시 채움), 라이브 append는 그 위에 현재가만 얹음.

### 책임 분할 — 엔진은 realtime 경유 (LS 직접 호출 안 함)
- **realtime(8200)** `feed/ls_rest.rs`: `fetch_t8412_today(client, token, code, ncnt)` — LS `/stock/chart` endpoint(⚠️ `/stock/market-data` 아님 — t8412는 chart 그룹), `tr_cd: t8412`, `nday="0"`+`qrycnt=500`(당일 ~390 1분봉 < 500). `t8412_rate_gate()`(TPS 1, 1.1초 직렬화 — 전용 게이트, t8407/t8402와 독립). 토큰은 기존 `rest_credentials()`(09:00~15:45 키B) + `get_or_fetch_token()` 공유.
- **realtime** `main.rs`: `GET /intraday/today?code=&asset_type=&interval=` 라우트. 주식(S)·ETF(E) 6자리만 t8412 호출, 그 외(지수 I/선물 F)는 빈 배열. `kst_datetime_to_utc_ms`로 LS date/time(KST) → UTC ms(엔진 Bar.ts와 동일 체계). 토큰/t8412 실패 전부 graceful 빈 배열.
- **stat-arb-engine(8300)** `main.rs`: `AppState`에 `http: reqwest::Client` + `realtime_base`(env `REALTIME_BASE_URL`, 기본 `http://localhost:8200`). `stitch_today_intraday(state, raw, asset_type, code)` — `/intraday/today` 호출해 당일 Bar를 `raw`(전일까지) 뒤에 append(`ts > 마지막 ts`만 → DB 중복 제외), 후 `sort_by_key(ts)`로 ASC 복원. `pair_detail`이 `unified_intraday` 직후 두 leg에 적용.

### graceful·정합성
- **지수(I)/선물(F)**: 엔진이 stitch skip + realtime도 빈 배열(이중 방어). 게다가 `intersect_by_ts`가 교집합이라 한 leg만 당일분 있어도 자동으로 전일까지만 매칭 → 지수 낀 페어는 기존대로.
- **ts 그리드**: DB 1분봉(`timestamp_millis`, UTC) 과 t8412(KST→UTC ms) 동일 epoch → `bucket_ohlc`(10분)·`in_continuous_session`(09:01~15:19, 날짜 무관) 이 당일분도 과거분과 동일 처리.
- **타임아웃**: 엔진 leg당 3.5초(두 leg 합 7초) < FastAPI 프록시 10초 → realtime stall 시에도 "전일까지" graceful 폴백이 프록시 503보다 먼저 동작. 정상 응답 ~2.2초+(t8412 TPS1).

### 검증 (2026-06-24 장중 라이브)
- detail spread_series에 오늘 10분봉 포함(마지막점 = 현재 시각), 주식·ETF 당일분 500 bars, 지수 0 bars(graceful), 차트 우측 끝까지 연속, 콘솔 0. 에이전트 영향검증 통과(프록시 타임아웃 리스크 발견 → leg 3.5초로 수정).
- ⚠️ **t8412 endpoint**: 최초 `/stock/market-data`로 호출 시 `IGW00215 유효하지 않은 TR CD`(HTTP 500). 차트 TR은 `/stock/chart` 그룹 — TR별 endpoint 그룹 주의.

## 18. 최근창 안정성 게이트 + 스프레드 비교 차트 (2026-06-29)

발굴 방법론 검토(외부 전문가 답변 `docs/통계차익 질문답변.txt` + 4관점 에이전트 검토) 결론: 큰 틀(발굴=일봉, 검증=분봉)은 이미 LENS 철학이고, VWAP robust는 **함정**(trading_value가 분할 미보정 raw축 → spike 부활 + 비동기 편향)이라 보류. **진짜 미구현 갭 = "최근창 안정성"** 하나만 채택.

### 18.1 최근창 안정성 게이트 (`discovery.rs`)
- **동기**: 발굴이 1년 단일창이라 "3년·1년은 좋은데 최근 6개월 깨진 페어"를 못 거름 = false discovery의 실질 구멍.
- **구현**: `evaluate_pair`에서 1년 OLS 잔차의 **최근 126영업일(~6개월) tail로 ADF 재검정**(같은 β). `recent_adf > 임계`면 발굴 제외 + `recent_adf_tstat` 필드(PairResult)로 노출. 1:1만(M:N은 PR-D Johansen 별도).
- **임계 = -2.5** (`STATARB_RECENT_ADF_CRIT` env 튜닝). 1년창(-3.0)보다 완화 — 6개월은 표본 작아 검정력↓, 빡세면 진짜 페어도 버림. 측정으로 -2.0(거의 무컷)/-3.0(과컷) 사이 -2.5 선택.
- **프론트**: 메인 테이블 ADF 셀에 최근 ADF 병기 `-3.97 (-3.18)`, tooltip 설명.
- **검증 (2026-06-29 장 마감 후)**: baseline **결정적**(재시작 2회 1896=1896). 게이트 정상(모두 ≤-2.5), 경계 동작 확인. ⚠️ **발굴 baseline은 장중엔 당일 일봉 미확정으로 run마다 변동**(4370/1085/1385)하고 **장 마감 후 안정** — 측정·튜닝은 장 마감 후/주말에 할 것.

### 18.2 스프레드 비교 차트 분리 (`charts.tsx` `SpreadDualChart`)
- detail 1번 차트(% 등락)에 스프레드를 얹으니 혼잡 → **1번과 z 차트 사이에 독립 스프레드 차트** 신설.
- **두 스프레드 %p로 겹침**(사용자 결정: 둘 다 유지):
  - **A 수익률差**(주황 실선) = `right% − left%` : 1:1 단순 차이, 직관적("몇 %p 벌어졌나").
  - **B β스프레드**(회색 점선) = `잔차/right×100` : β-가중, z 차트와 같은 거동. (spread_series의 spread·left·right로 계산, α·β 직접 불필요.)
  - β가 1에서 멀어도 페어 유효성과 무관(β=수량비, 유효성=R²/ADF) — HD/두산은 %기준 β≈0.85라 A≈B.
- **3-way 동기화**: % 등락/스프레드/z 세 차트 시간축 + 십자선 동기화(`registerLeg`/`registerSpread`/`registerZ`, N-chart 일반화).
- 차트 4개 높이 260px 통일.

### 18.3 회귀기간 표기 — 청산권 예상 + 달력일 (2026-06-29)
- **half-life의 한계**: "절반 되는 시간"은 출발점 무관 고유속도라 *비교*엔 좋으나, "지금 언제 청산?"이라는 실전 직관엔 약함(사용자가 log₂ 재계산해야). + 인트라데이 봉은 거래시간에만 존재해 "17시간"이 달력 17h로 오해됨.
- **헤드라인 KPI 교체**: `half-life` → **"전형 회귀 (2σ→±0.3σ) 약 N일(달력)"**. ⚠️ *현재 z 무관* — 이 페어가 표준 진입(2σ)에서 청산권(0.3σ)까지 보통 걸리는 기간(페어 고유 특성). `전형거래일 = half-life거래일 × log₂(2.0/0.3≈2.74)`, 달력 ×`CAL_PER_TRADING_DAY`(1.49). (현재 z 기반은 평균 근처에서 "도달"만 떠 페어 흐름 파악엔 부적합 — 사용자 피드백.)
- **모든 회귀기간 달력일화**: `half-life.ts` `toTradingDays`(봉→거래일, 22800s/일) → `toCalendarDays`(×1.49). 비교표 half-life도 "약 N일"(달력). half-life는 비교표에 보조 유지(페어 고유 속도 비교용).
- ⚠️ 지수회귀라 **0σ 도달 불가**(∞) → 종착점은 청산권(0.3σ). half-life는 평균치라 큰 2σ 충격은 더 걸림(근사).
- **포지션 상세도 동일 통일**(`stat-arb-position-detail.tsx`): "예상 청산" KPI → "청산권(±0.3σ) 예상 약 N일 후"(달력), 통계량 변화표 half-life 행도 "달력일"(거래일×1.49). 계산은 거래일 기준(deriveLabel 영향 없음), 표시만 달력일.

### 18.4 비교표 일봉(1d) 행 재추가 (2026-06-30)
- **동기**: detail 인트라데이 전환(§15.1) 때 비교표에서 일/주/월을 뺐는데, **장기 관계(수일~수개월 회귀)는 일봉이 핵심**이고 **발굴도 일봉 기준**이라 비교표에 1d가 없는 건 불일치(사용자 지적).
- **타임프레임이 다른 이유**(개념): 가격은 빠른 노이즈(고빈도)+느린 구조(저빈도)의 혼합이라, 타임프레임마다 *다른 시간대의 관계*를 봄. β·R²가 TF 무관 거의 일정하면 견고한 페어, ADF·half-life는 스케일마다 다른 회귀를 측정. 고빈도일수록 R²↓·β attenuation(Epps 효과).
- **구현**: `build_pair_detail`에 `left_daily`/`right_daily: &[Bar]` 인자 추가, 1h 다음에 `timeframe_stat_from_bars("1d", …)` push. `pair_detail`이 캐시 `bars_1d`(adj_close ~1년) 복사해 전달. **버킷·당일 stitch 안 함**(일봉은 장 마감 후 확정). 차트·헤드라인은 인트라데이 유지(스파이크 회피), 비교표 *통계 행*만 추가. 프론트는 timeframe-table이 배열 그대로 렌더 → 자동 표시, half-life.ts가 '1d' 거래일=달력일 환산 처리.
- **실측 예**(두산/HD): 인트라데이 β≈9.56·R²≈0.67·ADF≈-2.5 vs **일봉 β=12.05·R²=0.90·ADF=-3.78** — 일봉에서 훨씬 강한 cointegration(고빈도 노이즈로 인트라데이가 약해 보였던 것). 이게 일봉 행 추가의 가치.

### 18.5 발굴 일봉 lookback 1년 → 3년 (2026-06-30)
- **동기**: 고정 1년 단일 윈도우는 그 기간에 과적합(경계 민감). 정석은 다중윈도우 robustness("오래 묶였나 + 최근 유지되나"). 월가 stat arb도 단일 윈도우 안 씀.
- **구현**: `WARMUP_DAYS_DAILY` const → `warmup_days_daily()` env 함수(`STATARB_WARMUP_DAYS_DAILY`, 기본 **1095**=3년). 호출처 3곳(warmup batch). 임계(MIN_SAMPLES 150 등)는 3년에서도 더 견고하게 작동 — 변경 없음.
- ⚠️ **당시 측정치(2026-06-30, 오염기 — §21)**: 1년 2028페어(ADF median −3.96·R² 0.768·표본 244) → 3년 1382페어(ADF median −5.01·R² 0.852·표본 727). **3년 쪽 수치는 신뢰 불가** — 3년창 727봉 중 178봉이 "종가 0"이었고, 두 계열이 공유하는 0→실가격 계단이 R²·ADF 를 부풀렸다(1년창은 0 구간 밖이라 상대적으로 온전). 즉 "3년이 질 급상승"의 낙차 자체가 과장돼 있었다.
- ✅ **재측정(2026-08-02, 백필 후 클린 데이터·장 마감 후·결정적)**: **1년 8,834페어(ADF median −3.63·R² 0.833·표본 242) → 3년 4,422페어(ADF median −4.10·R² 0.881·half-life 11.2일·표본 727)**. 페어 −50%, 질은 여전히 3년이 위 — **결론(3년 채택)은 클린 데이터에서도 유지**되고 낙차만 현실적인 크기로 줄었다. (페어 절대수가 당시보다 큰 것은 ETF universe top100→400 확대(2026-07-26)·corr 0.3(§18.7) 때문이며 lookback 과 무관.) 발굴 소요 2.7초 / 전체 사이클 26초.
- **최근창 게이트(§18.1)와 조합** = "오래 묶였고(3년) + 최근에도 안 깨진(6개월)" 페어 = 다중윈도우 robustness의 단일사용자 실용판. detail 1d 표본도 242→727.
- env로 즉시 튜닝 가능(`STATARB_WARMUP_DAYS_DAILY=365`로 복귀 등).

### 18.6 페어 선정 과정 설명 (2026-06-30)
사용자/상사 시연용 — "왜 이 페어인가"를 화면에 노출.
- **전반(메인 `/stat-arb`)**: 페어 테이블 위 접이식 `<details>` "발굴 방법론" 패널. ①유니버스·그룹 ②1:1 게이트(상관/R²/양방향ADF/half-life/최근창/score) ③M:N(PCA/CCA) + "3년 일봉 발굴 / 인트라데이 진입" 요약. 정적 설명.
- **개별(detail)**: Leg 패널 아래 "발굴 기준 점검 (3년 일봉)" — 이 페어의 1d 통계로 게이트 통과를 ✓/✗+수치(`GateRow`). 발굴 페어는 모두 ✓, 직접 URL로 연 미발굴 페어는 미달 항목 ✗(정직). 라벨 "선정 근거"→"발굴 기준 점검"(임의 페어도 열 수 있어 중립화).
- ⚠️ detail은 발굴 통과와 무관하게 캐시의 두 종목 통계를 계산. 그래서 미발굴 페어(예: 두산/HD는 3년 일봉 corr 0.47<0.5로 탈락, 단 R²0.94·ADF-3.16은 강함 — corr 사전필터가 레벨 cointegration을 놓치는 사례)도 detail은 열림. 선정근거 ✗는 버그 아님.

### 18.7 corr 사전필터 0.5 → 0.3 (2026-07-01)
- **동기**: corr 필터가 cointegration 강한데 단기 동조 중간인 진짜 페어(두산/HD 등)를 대량 탈락. corr는 cointegration 필수조건 아님(효율성 휴리스틱).
- **측정 (2026-07-01, 오염기 — §21. 아래 숫자는 당시 값이며 재측정 안 함)**: corr off(=0) 5532페어를 4관점 에이전트 분석.
  - corr off도 발굴 비용 부담 없음(22→21.9초, 일봉이라 ADF 전수 빠름).
  - **elbow**: corr 0.35→0.30에서 신규 페어 ADF median 최대 낙차(−4.04→−3.75) 후 평탄화 = 자연 컷.
  - **ETF 본업**: corr 0.5는 ETF-주식(E-S) **72% 탈락**, 금·CD금리 ETF는 페어 0개로 소멸(LP 호가 상품). E-E는 12.9%만 탈락(이미 corr 높음).
  - **전원 일치**: `score=−adf×(1/hl)×|corr|`가 corr를 반영 → top200 corr median 0.9, corr<0.3은 0개. **완화해도 상위 노출 불변**, 이득은 꼬리 페어(본업)에만. 저corr(<0.3)는 금리형 ETF 무차별 매칭 등 spurious 위험이라 컷 유지.
- **결정**: `STATARB_MIN_CORR` 기본 **0.3**. 당시 페어 1382(corr 0.5)→3501(corr 0.3). 임계는 env 튜닝.
- **클린 데이터 현재값(2026-08-02)**: corr 0.3 기본에서 **4,422페어**(|corr| median 0.531, corr<0.5 가 1,822/4,154 = 44%). 결론 근거였던 "완화해도 상위 노출 불변"도 유지 — **score top200 의 |corr| median 0.995, corr<0.3 은 0개**. corr 0.5 대조군은 재측정하지 않았다(임계 변경 계획 없음).
- **후속 제안(미구현)**: 헤지 에이전트가 `|β| 밴드 필터`(0.2~5, 극단 β 30% 제거) 병행 권고 — corr가 못 잡는 체결-비현실 리스크. 별건.

### 18.8 β 밴드 필터 검토 → 도입 안 함 (2026-07-01)
- **동기**: §18.7 corr 검토 때 헤지 에이전트가 `|β| 밴드`(0.2~5, 극단 β = 수량비 비현실) 병행을 권고.
- **측정(2026-07-01, 오염기 — corr 0.3 발굴 3501페어)**: |β| median 1.50, p95 17.6, max 467.7. 극단도 질 대등 — |β|>5(722개) R² 0.846·ADF −4.12, |β|<0.2(336개) R² 0.859·ADF −4.09 (중앙 0.5~2와 동급).
- ✅ **재측정(2026-08-02, 클린 4,422페어 중 basis 포함 4,154)**: |β| median **1.48**, p95 22.4, max 707.7. 극단 대등도 **그대로** — **|β|>5(1,056개) R² 0.868·ADF −3.89, |β|<0.2(321개) R² 0.818·ADF −4.14** vs 전체 median R² 0.881·ADF −4.10. |β|>50 은 71개(1.7%). **결론(도입 안 함) 불변.**
- **결론 — 필터 부적합**: β는 corr와 달리 **크기 자체가 품질과 무관**. 극단 β는 대부분 **자산군 가격 스케일 차이**(자산군별 |β| median: S-S 0.98·E-E 0.66·E-S 2.41·I-S 79.9·E-I 0.02 — 지수 3000pt vs 주식 5만원). 절대 밴드 0.2~5로 자르면 R² 0.85의 좋은 페어 **1058개(30%) 오제거**(2026-08-02 재측정 1,377개·33%로 동일 결론). 매우 극단(|β|>50)은 2.2%(재측정 1.7%, 주로 지수)뿐. 체결(극단 수량비)은 **PnL 시뮬레이터의 금액 기준 수량 산출이 이미 해결**(금액 입력→β비율 수량 자동).
- **결정: β 밴드 필터 도입 안 함.** 필요 시 정보성 "수량비 큼" 표시만 검토(필터 아님, 미구현).

### 18.9 목표 z 도달 알림 (워치리스트) (2026-07-26)
- **동기**: 스윙 진입 판단은 *일봉 z*인데 실행은 장중. "장중에 |z|가 2를 넘는 순간"을 하루 종일 화면 앞에서 기다릴 수 없음 → 관심 페어에 목표 z를 걸어두고 도달 시 알림.
- **엔진 (additive)**: `PairResult`에 `resid_mean`/`resid_std` 추가. `stats::resid_stats()`가 `current_z`와 **같은 진입점**이라 z_score와 척도가 어긋날 수 없다. 발굴 게이팅 수학 불변(필드 추가만).
  - 라이브 z = `(right − alpha − hedge_ratio×left − resid_mean) / resid_std`.
  - 실측 검증: TIGER200/RISE200·SK하이닉스/SK스퀘어 등 4페어에서 *마지막 일봉 종가*를 넣으면 `z_score`와 **diff 0.0** 재현. `/pairs/detail`의 `daily_center`/`daily_scale`과도 동일값.
- **저장 (LENS SQLite)**: `backend/services/stat_arb_alerts.py` — `stat_arb_alerts` 테이블(`left_key,right_key,direction` UNIQUE → 재등록은 UPSERT로 목표 갱신). 라우트는 `routers/stat_arb.py`의 `/api/stat-arb/alerts*` (**이 경로만 프록시가 아니라 로컬 CRUD**). direction = `abs`(|z|≥t) / `above`(z≥t) / `below`(z≤−t), target_z는 항상 양수.
- **프론트**: 목록 페이지 `AlertWatchlist` 패널 (`components/stat-arb/alert-watchlist.tsx`).
  - 조인: 목록 pairs는 필터가 걸려 있어 워치 페어가 빠질 수 있음 → **`basis=all&limit=10000` 별도 1회 조회**로 α·β·μ·σ 확보(필터 토글엔 무반응). α·β는 3년 일봉 회귀라 장중 불변 → 주기 refetch 없음(수동 버튼).
  - 발화: 브라우저 알림(Notification, 권한 요청 버튼) + 화면 우하단 배너 + 짧은 비프(무음 토글, localStorage). **라이브 가격이 양쪽 다 있을 때만** 발화(전일 종가 z로 장 시작 전 오발화 차단).
  - **히스테리시스**: 한 번 울리면 disarm → |z|가 `목표 × 0.8` 안쪽으로 되돌아와야 재무장(경계 진동 연타 방지). 무장 상태는 컴포넌트 메모리(useRef).
  - 등록 UI: 목록 행 페어 셀의 🔔 토글(기본 2.0·abs), 상세 헤더 `AlertButton` 팝오버(목표·방향 선택, 페어당 여러 건 가능).
- **한계(명시)**: 탭이 열려 있는 동안만 감시 — 서버 푸시 아님. 비보안(HTTP) 접속이면 Notification API가 없어 배너·소리로만 알림.

---

## 19. 팩터중립 s-score 트랙 (Avellaneda-Lee, 2026-07-27)

**1:1 / M:N 발굴과 완전히 독립된 별도 트랙.** 기존 발굴 코드(`evaluate_pair` / `discover_all_one_to_one` / `discover_mn_in_group` / `choose_target_len` / `compute_group_pca` / `PairResult` / `MPairResult`)는 한 줄도 건드리지 않았다 — 새 모듈 `sscore.rs` + 새 엔드포인트 `/s-scores` + 새 페이지 `/stat-arb/s-score`.

### 19.1 왜 필요한가
1:1 발굴은 자산유형 무관 전조합이라 **시장 대용 바스켓 ETF가 허브**가 된다(실측: `TIGER 코리아TOP10` 169 leg-slot, `RISE ESG사회책임투자` 149, 상위 12 leg가 전체의 27%). UI 키워드 제외는 증상 대응이지 구조적 해법이 아니다. 정석은 "A vs B"가 아니라 **"A vs A의 팩터 노출"** — 공통 팩터(시장·섹터)를 회귀로 제거한 **고유 잔차**의 평균회귀를 본다. 헤지는 페어 상대가 아니라 지수선물/팩터 ETF (ETF LP 본업과 일치).

### 19.2 알고리즘 (`stat-arb-engine/src/sscore.rs`)
1. **유니버스** — 캐시의 주식(`S:`)+ETF(`E:`) 일봉 로그수익률. 표본 정렬은 1:1의 `choose_target_len` 과 **같은 사상**(짧은 소수 드롭)이되 창 길이가 상수라 탐색 없이 `corr_window+1` 봉 미달을 드롭. 거래일 달력 tail 비교로 오정렬 멤버 제거(1:1의 `tail_ts_matches` 와 동일 취지).
2. **팩터 추출** — 최근 `corr_window`(252d) 수익률 **상관행렬 PCA**(`stats::pca` 재사용, 읽기 전용) → 상위 `n_factors`(15) 고유벡터. 고유벡터 부호는 성분 합이 양수가 되도록 고정(재기동 간 β 부호 뒤집힘 방지).
3. **eigenportfolio 수익률** — `Q_i = v_i/σ_i` 를 `Σ|Q| = 1`(총노출 1)로 정규화 → `F_k(t) = Σ_i Q_i R_i(t)`. 정규화는 AL 원문의 스케일 자유도이며, β 가 "그 포트폴리오 대비 헤지비율"이 되고 정규방정식 열 스케일이 균질해져 수치 안정성도 좋다.
4. **잔차 회귀** — 최근 `reg_window`(60d)에서 `R_i = β_i0 + Σ_k β_ik F_k + ε_i` **다중 OLS**. 설계행렬이 전 종목 공통이라 `X'X` Cholesky 분해는 **사이클당 1회**(600종목 × 15팩터가 156ms에 끝나는 이유). 준특이 가드: Cholesky 대각 min/max < 1e-6(≈ cond 1e12) 이면 거부 — `Cholesky::new` 는 완전 특이만 잡고 절편과 공선인 상수열도 1e-8 pivot 으로 통과시킨다(실측).
5. **OU 적합** — 누적잔차 `X(t)=Σ ε(s)` 에 AR(1) `X(t)=a+b·X(t-1)+ζ`. `0<b<1` 아니면 제외. **단위 규약**: AR 한 스텝 = 1영업일 → `κ_daily=−ln b`, `half_life=ln2/κ_daily`[일], 노출용 `kappa=κ_daily×252`[1/년, AL 표기].
6. **s-score** — `s=(X_last−m)/σ_eq`, `m=a/(1−b)`, `σ_eq=σ_ζ/√(1−b²)`.
   - ⚠️ **X_last ≈ 0 은 버그가 아니다**: 절편 있는 OLS 잔차 합은 정확히 0 → 실질 `s = −m/σ_eq`("평형 m 대비 지금(=0) 어디인가"). AL 정의 그대로. 공식은 일반형으로 두어 절편 없는 변형에도 성립.
7. **게이트** — half-life `0.5 ~ 30일`(30 = reg_window/2 = AL "회귀시간이 회귀창 절반보다 빨라야"의 취지), 팩터 R² ≤ 0.99(잔차가 수치 노이즈 = 팩터 선형결합으로 재현되는 시리즈 배제), 표본·수치 유효성.
   - 상수는 전부 env 튜닝: `STATARB_SSCORE_CORR_WINDOW / _N_FACTORS / _REG_WINDOW / _MIN_HL / _MAX_HL / _MAX_R2`.

### 19.3 산출 / API
- 엔진 `GET /s-scores?limit&min_abs_s&max_half_life&asset(stock|etf|any)` → `{total, filtered, returned, last_run_ms, duration_ms, factors{n_factors, explained_variance_ratio[], factor_vol[], corr_window, reg_window, universe_size}, items[]}`. **정렬은 계산 시점에 |s| 내림차순 고정**, 요청은 필터/limit 만.
- 계산은 recompute cron 사이클에 1회 (`AppState.sscores: Arc<RwLock<SScoreState>>`). 요청마다 재계산하지 않는다.
- `top_factors` 는 `{factor_idx, beta, contrib}`. **정렬 기준은 |β| 가 아니라 `contrib = β×σ_F`** — 상위 PC 는 long-short 분산 포트폴리오라 σ_F 가 작아 β 만 커진다(|β| 정렬 시 항상 저변동 팩터가 뽑히는 착시).
- ⚠️ **β_1 은 CAPM 시장베타가 아니다**: F1 은 `v/σ` 가중 분산 포트폴리오라 개별 종목보다 변동성이 낮고(σ_F1 ≈ 1.1%/일 vs 개별주 2~4%), 게다가 15팩터 다변량 계수 → 개별주 β_1 중앙값 2.66 이 정상. 감시 포인트는 값이 1이냐가 아니라 **σ_F1 이 지수 변동성 수준이고 부호가 안정적이냐**.
- 프록시 `backend/routers/stat_arb.py` `/api/stat-arb/s-scores` (기존 패턴 동일).

### 19.4 실측 (⚠️ 2026-07-27 초기 사이클 = 오염기 §21. 클린 재측정은 이 절 끝 참조)
- 후보 654(주식+ETF) → 짧은표본 79 드롭 → PCA 575 시리즈 → **게이트 통과 573** (r² 게이트 2, 그 외 탈락 0).
- 성능 **155ms**(PCA 156ms 포함... PCA가 사실상 전부). 1:1 발굴 2.2초 / 전체 사이클 24.6초 대비 **+0.6%** — 부담 없음.
- 팩터 설명력 top5 = 40.7 / 7.4 / 3.6 / 2.4 / 2.2%, 15팩터 누적 **68.1%**. σ_F1 1.11%/일.
- `|s|` p50 0.73 · p90 1.45 · p99 1.90 · max 2.53. |s|≥1.25(AL 진입 임계) **103종목(18%)**, ≥2 는 4종목. half-life p50 5.7일(p10 2.2 / p90 13.6). R² p50 0.796(p10 0.572 / p90 0.972).
- **sanity (이 트랙의 핵심 검증)** — 분류별 R² 중앙값: `broad_index 0.983` / `factor 0.975` / `leverage_inverse 0.969` / `theme 0.933` / `sector 0.923` vs **`stock 0.729`**. R² 상위 10은 전부 지수복제형(TIGER200 0.990, KODEX200 0.988 …)이고 잔차변동성 0.46~0.50%/일(유니버스 중앙값 1.65%의 **1/3**). 1:1 허브였던 `TIGER 코리아TOP10`(R² 0.892, s −0.65)·`RISE ESG사회책임투자`(0.910, −0.84)는 |s| 상위 어디에도 없다 — **허브 편향이 원리적으로 사라짐**.
  - 단서: s 는 자기 σ_eq 로 정규화하므로 지수복제 ETF도 |s| 자체는 0.6~0.9 로 0 은 아니다. "경제적으로 작다"는 **잔차변동성**(0.46% vs 1.65%)에서 읽어야 한다.
- 1:1 / M:N 산출 **불변 확인** — 같은 날 데이터로 HEAD 코드(대조군)와 신규 코드 각각 기동: 둘 다 **11,022 페어 / M:N 108**. (직전 기록 11,033 과의 차이는 3년 cutoff 날짜 롤오버 + 일배치 데이터 갱신 때문이며 s-score 트랙과 무관 — 대조군으로 분리 확인함. ⚠️ 이 11,022 는 오염기 값이라 현재 4,422 와 직접 비교 불가 — §21.)

**✅ 클린 재측정 (2026-08-02, 백필 후·장 마감 후·결정적)**
- 후보 648 → 짧은표본 77 드롭 → PCA **571 시리즈** → **게이트 통과 527**(탈락은 전부 r² 게이트 44건 — 회귀실패·OU실패·hl게이트 0. 오염기엔 r² 게이트가 2건이었다. 0 구간이 잔차에 노이즈를 더해 R²>0.99 를 못 넘게 했던 것으로 **추정**하나 확인은 안 했다).
- 성능 156ms, 전체 사이클 26.1초 대비 **+0.6%** — 부담 없음(불변).
- 팩터 설명력 top5 = 42.9 / 7.5 / 3.4 / 2.3 / 2.1%, 15팩터 누적 **69.6%**. σ_F1 1.03%/일 · β₁ 중앙값 3.27.
- `|s|` p50 0.79 · p90 1.59 · max 3.33, |s|≥2 는 16종목(3.0%). half-life p50 4.7일(p10 2.0 / p90 10.6). R² p50 0.815.
- **sanity 유지** — 분류별 R² 중앙값 `broad_index 0.984` / `leverage_inverse 0.983` / `factor 0.981` / `theme 0.954` / `sector 0.946` vs **`stock 0.765`**. 지수복제형이 상단, 개별주가 하단이라는 구조가 클린 데이터에서도 그대로다(이 트랙의 존재 이유가 데이터 오염의 부산물이 아니었음을 확인).

### 19.5 프론트 (`frontend/src/pages/stat-arb-sscore.tsx`)
- 서브탭 `s-score` (`/stat-arb/s-score`). 컨트롤: |s| 최소(0/1.25/2 프리셋 — 1.25 = AL 진입 임계) · half-life 상한 · 자산군 · 검색. 서버 필터가 바뀌면 재요청(AbortController), 검색·정렬은 클라이언트.
- 테이블: 종목·분류배지 / s-score(|s|≥2 강조, 양수 down·음수 up) / half-life / κ / R² / 잔차변동성 / 주요 팩터(기여도 %p, 호버 시 β) / 표본. 접이식 "읽는 법" 패널에 3단계 설명 + 1:1·M:N 과의 차이.
- leg 분류 라벨·색은 1:1 목록과 공용 (`lib/stat-arb/asset-class.ts` 로 추출).

### 19.6 남은 것 (미구현)
- 진입/청산 임계(±1.25 / ±0.5)로 **포트폴리오 백테스트** — 현재는 스크리너까지.
- 팩터 노출 합산 → **지수선물 헤지 수량 산출**(여러 종목 바스켓의 F1 순노출). 지금은 종목별 β 만 노출.
- 인트라데이 s-score(현재 일봉 전용). 회귀창 60일 고정이라 장중 갱신은 사이클 단위.

## 20. PR-D Johansen 공적분 검정 (M:N 부가 지표, 2026-07-28)

**발굴 게이트는 한 줄도 안 바꿨다.** 도입 시점(2026-07-28)엔 순수 측정 전용이었고, 1:1 11,071 /
M:N 130 / s-score 570 산출이 대조군(HEAD)과 완전 동일함을 같은 날 데이터로 확인했다(§20.4).
**2026-08-02 에 응답단 필터로 승격**(§20.7) — 게이트가 아니라 운영자가 켜고 끄는 보기 필터라
발굴 수학·산출은 여전히 불변이다.

> ⚠️ 도입 당시 수치(1:1 11,071 / M:N 130 / trace0 max 558.8 …)는 **adj_close 오염기 값**이다.
> 백필 후 클린 재측정은 §20.4의 "클린 재측정" 블록, 경위는 §21.

### 20.1 왜 필요한가
1:1 은 **양방향 ADF**(§16.3)로 "무엇이 y인가"를 이미 해소했지만, M:N(`discover_mn_in_group`)은
Sparse CCA 가중치로 만든 **합성 스프레드 하나에 단방향 ADF**만 건다. 게다가 CCA 가중치는
*상관 최대화*이지 *공적분 벡터*가 아니다. Johansen 은 n개 계열을 대칭적으로 검정하고 공적분
벡터를 직접 준다 — leg 3개 이상이 붙는 M:N 이 이 검정의 본래 무대다.

### 20.2 알고리즘 (`stat-arb-engine/src/johansen.rs`)
VECM `ΔY_t = ΠY_{t-1} + Σ_{i<p} Γ_i ΔY_{t-i} + μ + ε_t`, `Π = αβ'`, rank(Π) = r.
상수항은 **비제약(unrestricted constant, Johansen case 3)** — 회귀자로 넣고 양변에서 소거.
1. `Z0=ΔY_t`, `Z1=Y_{t-1}`, `Z2=[1, ΔY_{t-1}…]` (행 t = p..T-1, 유효표본 T−p)
2. `R0`,`R1` = Z0·Z1 을 Z2 에 회귀한 잔차 → `S00,S01,S11`
3. `|λS11 − S10 S00⁻¹ S01| = 0` 을 **대칭화**해서 푼다: `S11=LL'`(Cholesky) →
   `M = L⁻¹ S10 S00⁻¹ S01 L⁻ᵀ` 는 대칭 → `SymmetricEigen`(`stats::pca` 와 같은 pure-Rust 경로,
   LAPACK 불필요) → 공적분 벡터 `β = L⁻ᵀv`
4. `LR_trace(r) = −T Σ_{i>r} ln(1−λ_i)`, `LR_max(r) = −T ln(1−λ_{r+1})`
5. r=0 부터 순차 검정 — 처음 기각 실패한 r 이 추정 rank
- `coint_vector` 정규화 = **L2 = 1 + 첫 비영 성분 양수**. 고유벡터 부호는 원래 임의라 재기동
  간 뒤집히면 안 되고, CCA 가중치(역시 L2=1)와 방향 비교가 바로 되게 맞췄다.
- 시차 p 기본 1 (`STATARB_JOHANSEN_LAGS`). 수치 가드: 유효표본 ≥ max(30, 10×변수),
  Cholesky 대각비 ≥ 1e-7(cond 1e14), λ ∈ [0,1).

**임계값 표** — MacKinnon-Haug-Michelis(1999) 비제약 상수 케이스, `n−r = 1..12`, 90/95/99%.
수치 출처는 statsmodels `tsa/coint_tables.py` 의 `ss_tjcp1`(trace)·`ss_ejcp1`(max-eig)
= `c_sjt/c_sja(n, p=0)`. Osterwald-Lenum(1992)도 **같은 케이스의 구판**이지만 검증 가능한
사본이 없어 채택하지 않았다(임계값 추측 하드코딩은 조용한 오판정을 낳음). `n−r > 12` 는 미판정.

**검증** — `coint_johansen(y, det_order=0, k_ar_diff=lags−1)` 과 **lags ≥ 2 에서 소수 10자리
일치**(단위테스트가 golden 으로 대조). lags = 1 만 갈리는데, statsmodels 가 레벨 항으로
`Y_{t-1}` 이 아니라 `Y_t` 를 쓰기 때문이다(`vecm.py`: `lx = endog[:T−k][1:]`). k ≥ 1 이면 그
한 칸이 `ΔY_{t-1}` 회귀자에 흡수돼 같아지지만 k = 0 이면 Z2 가 상수뿐이라 흡수되지 않는다.
본 구현은 교과서 VECM 정의를 따른다. 별도로 numpy(lstsq+eigh) 독립 구현과도 대조.

### 20.3 M:N 배선 + adj_close 결측 처리 (★ 중요)
- `MPairResult` **additive 필드**: `johansen_rank`(trace 95%) / `johansen_trace0` /
  `johansen_crit95` / `johansen_eigen1`. 발굴 직후 엔리치 패스(`main.rs`)에서 채운다.
- `MnPairDetail.johansen` 에는 `JohansenResult` 전체(고유값·r별 trace·임계값·공적분 벡터).
- 입력은 leg 별 **로그가격 레벨**. 정렬은 발굴과 같은 도구(우측 정렬 + 거래일 달력 tail 검사)를
  쓰되 **leg 을 하나도 버릴 수 없어** `choose_target_len` 대신 전 leg 공통 최소 길이를 쓴다.
- ⚠️ **결측 구간은 "최장 연속 구간"으로 잘라낸다** (`johansen::longest_positive_run`).
  Johansen 은 `ΔY_t` 를 쓰므로 결측 시점을 개별로 빼면 차분이 구멍을 건너뛰어 가짜 점프가 된다.
  실측(2026-07-28): `ohlcv_daily.adj_close` 는 2024-04-23 이전 전체 NULL(로더가 0)에 더해
  **2026-06-02~09 주간이 통째로 NULL 인 ETF 가 다수**였다. "마지막 결측 이후" tail 절단이면
  130 페어 중 **86 개가 33봉만 남아 전멸**했고, 최장 연속 구간으로 바꾸니 **130/130 산출**됐다
  (대신 86 페어는 최신이 아닌 창 — 최대 38봉 전에서 끝남. 진단 로그가 그 수를 보고한다).
  - ✅ **현재(2026-08-02, 백필 후)는 과거 창 사용 0 페어** — 진단 로그의 "결측으로 과거 창 사용"
    줄 자체가 안 찍힌다. 방어 로직은 그대로 두되(FD 결측은 언제든 재발 가능) **지금 산출은
    전부 최신 창**이다.
- ❗ ~~**같은 결측이 기존 M:N 발굴 통계도 오염시킨다**~~ — 이 PR 이 발견한 오염(`log_closes_aligned`
  의 `ln(0)→0` 계단)은 **다음 커밋 `f960677`(2026-07-28)에서 수정**됐고, 2026-08-02 FD 백필로
  표본까지 회복됐다. 경위·영향 범위는 **§21**.

### 20.4 실측 (⚠️ 2026-07-28 사이클 = 오염기 §21. 클린 재측정은 아래 별도 블록)
- **산출 130/130, 미판정 0, 소요 6ms** (전체 사이클 23.6초의 0.03%).
- rank 분포(trace 95%): `r0=89, r1=29, r2=8, r3=3, r4=1` → **rank ≥ 1 41/130 (31.5%)**
- rank 분포(trace 99%): `r0=113, r1=15, r2=1, r3=1` → **rank ≥ 1 17/130 (13.1%)**
- trace(r=0) median 33.0 / p90 50.8 / min 13.2 / max 558.8
- leg 수별 rank ≥ 1(95%): n=3 29/84(35%) · n=4 11/44(25%) · n=5 1/2
- **핵심**: M:N 페어는 전부 합성 스프레드 ADF(t<−3)를 통과한 것들인데 **68.5%가 Johansen
  95%에서 rank 0**. 현 M:N 게이트가 대칭 공적분 기준으로는 상당히 관대하다.
- **더 중요한 관측** — rank ≥ 1 집단과 rank 0 집단의 발굴 통계가 사실상 같다:
  adf −8.72 vs −8.60 · R² 0.958 vs 0.960 · half-life 3.6 vs 3.7일 · |corr| 0.750 vs 0.784 ·
  score 1.70 vs 1.75. 즉 **Johansen 은 기존 score 와 직교하는 정보**다(현 랭킹으로는 대리 불가).
  score Top10 중 8개가 rank 0.
- ⚠️ **풀랭크(r=n) 4건은 과대기각 신호**로 읽어야 한다. `etf_category:코스피지수`(코스피200
  복제 ETF 4종, trace0 558.8)처럼 거의 동일한 계열이거나, λ 가 0.03 수준인데 T≈500 이라
  `n−r=1` 임계값(χ²(1)=3.84)을 쉽게 넘는 경우다. 로그가격 전부가 정상(stationary)이라는 결론은
  경제적으로 말이 안 되므로, 의미 있는 신호는 **"rank ≥ 1"이지 rank 의 크기가 아니다**.

**✅ 클린 재측정 (2026-08-02, 백필 후 727봉 / 3년 일봉 612 시리즈 / M:N 발굴 59 · dedup 후 57)**
- **산출 59/59, 미판정 0, 과거 창 사용 0, 소요 4ms** (전체 사이클 26.1초의 0.02%).
- rank 분포(trace 95%, 발굴 59 기준): `r0=25, r1=21, r2=6, r3=7` → **rank ≥ 1 34/59 (57.6%)**.
  `/mn-pairs` dedup 후 모수(57)로는 **rank ≥ 1 32 / rank 0 25 = 56.1%**(화면 배지 숫자).
- rank 분포(trace 99%): `r0=45, r1=12, r2=2` → rank ≥ 1 14/59 (23.7%).
- trace(r=0) median 34.8 / p90 49.9 / min 19.9 / **max 625.6**. leg 수별 rank ≥ 1(95%):
  n=3 25/42(60%) · n=4 9/16(56%) · n=5 0/1.
- **오염기 대비 뒤집힌 그림**: rank ≥ 1 비율 **31.5% → 57.6%**. 즉 §20.5 게이트 승격 찬성의
  핵심 근거였던 "68.5% 가 rank 0" 은 **오염기에만 성립하던 숫자**다.
  - 원인 분해는 단정하지 않는다 — (a) 오염기엔 결측을 피해 최장 연속 구간만 써서 **유효표본이
    ~500**이었고 지금은 727 이며, T 가 커지면 `n−r=1` trace 는 더 쉽게 기각된다(아래 T 의존성
    실측), (b) 페어 모집단 자체가 130 → 59 로 완전히 달라졌다. 두 요인이 섞여 있고 분리 측정은
    안 했다. **확실한 것은 "예전 비율을 근거로 쓰면 안 된다"는 것뿐.**
- **직교성은 유지** — rank ≥ 1 vs rank 0 집단의 발굴 통계가 여전히 사실상 같다:
  adf −3.44 vs −3.40 · R² 0.966 vs 0.970 · half-life 19.7 vs 20.8일 · |corr| 0.84 vs 0.86 ·
  score 0.148 vs 0.146. (단 score Top10 중 rank 0 은 8개 → **1개**로 줄었다 — 클린 데이터에선
  상위 랭킹과 약하게 정렬된다.)
- ⚠️ **풀랭크 과대기각은 오히려 심해졌다** — rank 3 이 7건(표본 727 로 늘어 검정력↑).
  trace0 max 625.6(코스피200 복제 ETF 그룹). 신뢰 가능한 신호는 여전히 **rank ≥ 1 여부뿐**.
- **T 의존성 실측** — 같은 데이터로 lookback 만 1년(`STATARB_WARMUP_DAYS_DAILY=365`)으로 낮추면
  rank ≥ 1 이 **10/36 (27.8%)** 로 떨어진다. `n−r=1` trace 검정이 T 에 얼마나 민감한지 보여주는
  직접 증거 — Johansen 통과율은 **관계의 질이 아니라 창 길이에도 좌우**된다(게이트화 반대 근거).

### 20.5 게이트 승격 판단 → **승격 안 함 · 응답단 필터로 노출** (2026-08-02 결정)
당초 권고 순서(① 데이터 정합 → ② 재측정 → ③ 결정)를 그대로 밟아 결론냈다. ①은 `f960677`+FD
백필(§21), ②는 §20.4 클린 재측정, ③이 이 절이다.
- 찬성이었던 근거는 약해졌다 — "68.5% 를 걸러 위양성 축소"는 오염기 한정 숫자였고(클린에선
  rank 0 이 43.9%), rank ≥ 1/0 두 집단의 발굴 통계는 여전히 구분이 안 된다(무엇을 거르는지 불분명).
- 반대 근거는 남았다 — (a) M:N 산출이 **57 → 32** 로 반토막나 실사용 후보가 얇아진다.
  (b) `n−r=1` 검정은 T=727 에서 과대기각 경향(풀랭크 rank 3 이 7건, trace0 max 625.6)이고,
  같은 페어도 창 길이만 바꾸면 통과율이 27.8% ↔ 57.6% 로 흔들린다.
- **결정: 발굴 게이트로 승격하지 않는다. 대신 운영자가 켜고 끄는 응답단 필터로 노출**(§20.7).
  1:1 의 `stability` 필터와 정확히 같은 사상 — 통계·산출은 불변, 보는 각도만 바꾼다.
- 남은 트랙(미구현): 공적분 벡터로 CCA 가중치를 교체하는 건 별개 건(방향 일치도 cos 은 페어마다
  0.6~1.0 로 편차가 크다 — 상세 패널에서 페어별 확인 가능). 게이트 재검토는 "rank ≥ 1 인 M:N 이
  실제로 더 잘 회귀하는가"를 **포지션 성과로** 확인한 뒤에.

### 20.6 프론트
- M:N 목록(`stat-arb-mn.tsx`): `Joh.` 컬럼 — `r0`(t4) / `r≥1`(accent) / `—`(미판정) 배지,
  호버에 trace(r=0)·95% 임계값·λ₁.
- M:N 상세(`components/stat-arb/johansen-panel.tsx`): 쉬운 설명 2줄 + r별 순차 검정표
  (trace / 95% / 99% / λ / 기각 여부) + **공적분 벡터 vs CCA 함의 벡터** leg별 비교.
  CCA 함의 벡터는 잔차 `Σvⱼ·lnPⱼ − β·Σwᵢ·lnPᵢ` 에서 온 `[−β·wᵢ, vⱼ]` 를 같은 규약으로
  정규화한 것이고, 방향 일치도 = 두 단위벡터 내적.

### 20.7 Johansen 응답단 필터 (2026-08-02)
§20.5 결정의 구현. **발굴 게이트 아님** — 이미 산출된 M:N 목록을 응답 시점에 거른다.

- **엔진** `GET /mn-pairs?johansen=rank1|rank0|all`(`MnPairsQuery`, `main.rs`).
  - 적용 순서: kind 필터 → 그룹 평탄화 → score 정렬 → **leg 집합 dedup** → *johansen 필터* → limit.
  - 응답 `johansen_counts: {rank1, rank0, undetermined}` — **dedup 후·johansen 필터 전 모수**
    기준이라 세그먼트를 눌러도 배지 숫자가 흔들리지 않는다(1:1 `stability_counts` 와 같은 규약).
    셋의 합 = johansen 미지정 시의 `total`. `total` 은 필터 적용 후 개수(기존 kind 와 동일 의미).
  - **미판정(`johansen_rank` 없음)은 rank1/rank0 어느 쪽에도 안 걸린다** — 1:1 의 안정성 미산출
    페어가 등급 지정 시 빠지는 것과 같은 정책. 카운트에는 `undetermined` 로 잡혀 총합이 맞는다.
  - 알 수 없는 값(`johansen=foo`)은 필터 미적용(`asset_combo` 와 같은 관대 정책).
- **백엔드** `routers/stat_arb.py` `/api/stat-arb/mn-pairs` 가 `johansen` 을 그대로 프록시.
- **프론트** `stat-arb-mn.tsx` 컨트롤 바 세그먼트 `전체 57 | 공적분 32 | 미검출 25`
  (`components/stat-arb/seg.tsx` — 1:1 안정성 세그먼트와 공용으로 추출). 통계 용어를 모르는
  사용자를 위해 rank ≥ 1 = "공적분", rank 0 = "미검출" 로 라벨링하고, 라벨 hover 에 "Johansen
  대칭 공적분 검정 95% 기준 — 여러 종목이 방향 구분 없이 장기적으로 묶여 있는지" 설명을 단다.
  선택은 서버 param 으로 나가고(`load` deps), 기존 `Joh.` 컬럼·배지는 그대로 유지.
- **검증(2026-08-02)**: 미지정 total 57 / rank1 32 / rank0 25, `johansen_counts` 합 = 57.
  kind 필터와 교차해도 정합(etf 46=26+20 · sector 6=3+3 · etf_category 5=3+2 · index 0).
  같은 사이클에서 1:1 4,422 / s-score 527 불변.

---

## 21. 데이터 정합 이력 — adj_close 오염 → 수정 → 백필 (★ 이 문서의 숫자를 읽기 전에)

**이 문서의 실측치는 두 세대가 섞여 있다.** 2026-07-28 이전 측정은 전부 오염된 캐시 위에서
나온 값이고, 그 위에서 내린 판단 중 일부는 근거가 무너졌다(§20.5 게이트 승격 논거였던
"M:N 의 68.5% 가 Johansen rank 0" → 클린 데이터에선 43.9% 가 대표 사례).
숫자를 근거로 튜닝하려는 다음 세대는 **측정 시점부터 확인**할 것.

### 21.1 무슨 일이 있었나

| 시점 | 사건 |
|---|---|
| ~2026-07-28 | `ohlcv_daily.adj_close` 가 2024-04-22 이전 전 구간 NULL 인데, 엔진 로더가 `c.unwrap_or(0)` 으로 매핑해 **종가 0.0 을 캐시에 적재**. 3년창 726봉 중 **178봉(24.5%)** 이 전 종목 0. 추가로 2026-06-02~09 주간이 통째로 NULL 인 ETF 다수. |
| 2026-07-28 `f960677` | **LENS 측 수정** — 일봉 SQL 에 `adj_close IS NOT NULL`, 로더 10개 전부에 `has_valid_close` 관문, 조용한 치환 제거(`ln(0)→0`, `log_returns` 의 `else{0.0}` → `Option`). raw close 폴백은 **불가**(2024-04-23 이후 corporate_actions 10,254건 — 수정치와 원가를 섞으면 경계에 분할 계단). NULL 봉을 버리니 계열이 2024-04-23 부터 **548봉**으로 짧아짐. 1:1 의 `align_tail`(개수 우측정렬)도 `intersect_daily`(ts 교집합)로 교체 — NULL 제거로 생긴 거래일 구멍 때문. |
| 2026-08-02 | **Finance_Data 가 `adj_close` 백필** → 표본 **548 → 727봉** 회복. 엔진 재기동만으로 정합 데이터 반영(코드 변경 없음). Johansen 의 "결측으로 과거 창 사용"도 0 페어. |

### 21.2 왜 조용히 통계를 망가뜨렸나

두 계열이 **같은 날짜에 동시에** 0 이 되므로, 로그가격에 `9 → 0 → 9` 계단이 공유된다.
그 계단은 (a) 두 계열의 공분산을 지배해 **R² 를 부풀리고**, (b) 잔차에 거대한 평균회귀 구조를
심어 **ADF t-stat 을 과대**하게 만들며(M:N ADF median −8.65 는 실데이터가 아니었다),
(c) half-life 를 비현실적으로 짧게(3.7일) 만들고, (d) Kalman β 를 흔들어 **가짜 드리프트 경보**를
낸다. 에러도 경고도 없이 "아주 좋은 페어"처럼 보인다는 점이 이 버그의 성질이다.

### 21.3 수정 전/후 실측 (f960677 커밋 메시지 + 2026-08-02 백필 후)

| 지표 | 오염기 (~07-28) | 수정 직후 (548봉) | **백필 후 현재 (727봉, 2026-08-02)** |
|---|---|---|---|
| 1:1 통과 페어 | 11,071 | 5,241 | **4,422** |
| 1:1 ADF median | −5.01 (3년, 06-30) | — | **−4.10** |
| 1:1 R² median | 0.852 (3년, 06-30) | — | **0.881** |
| 1:1 half-life median | — | — | **11.2일** |
| M:N 페어 | 130 | 65 | **59 발굴 / 57 dedup** |
| M:N ADF median | −8.65 | −3.38 | **−3.44** |
| M:N half-life median | 3.7일 | 16.2일 | **20.2일** |
| Johansen rank ≥ 1 | 31.5% | — | **57.6%** (dedup 후 56.1%) |
| Johansen trace0 max | 558.8 | 71.1 | 625.6 (표본 727 로 검정력 회복) |
| Kalman 안정성 | stable 53.9% / drift 22.8% | stable 76.3% / drift 7.1% | **stable 72.0% / caution 15.7% / drift 12.3%** |
| s-score 산출 | 570~573 | — | **527 / 571 시리즈** |
| 표본(3년창) | 727봉 (**중 178봉이 0**) | 548봉 | **727봉 (전부 실데이터)** |

- 소멸한 1:1 페어 7,252 개 중 **91.8% 가 0봉 구간을 포함**했다 = 오염이 만든 허구 페어.
- z 오차: 오염 노출 페어의 `|Δz|` median 0.31 / p90 1.35 / **max 7.28** — 진입 판단이 뒤집히는 크기.
- ⚠️ **표본 727봉이라는 숫자가 오염기와 현재에 우연히 같다.** 오염기 727봉은 178봉이 0인
  727봉이고 지금은 전부 실데이터다. "727" 만 보고 같은 조건이라 판단하면 안 된다.

### 21.4 다음 세대를 위한 규칙

1. **문서의 실측치에는 측정 시점을 붙인다.** 이 문서에서 `2026-07-28` 이전 날짜가 붙은 수치는
   전부 오염기 값이다(§18.5 / §18.7 / §18.8 / §19.4 / §20.4 에 표기해 뒀다).
2. **캐시 적재 경로에서 `unwrap_or(0)` 류의 조용한 치환을 금지**한다. 가격은 `Option` 으로
   흘리고 유효하지 않으면 봉 자체를 버린다(`bars.rs` 불변식: *캐시 종가는 항상 > 0*).
3. **통계가 갑자기 좋아지면 데이터를 먼저 의심**한다. ADF −8.65 / half-life 3.7일 같은 값은
   한국 주식 페어에서 정상 범위가 아니었는데, 두 세대에 걸쳐 "좋은 신호"로 읽혔다.
4. **표본 길이·시작일을 로그로 남기고 본다.** `[warmup] … series/bars` 와 `sample_size` 는
   같은 화면에서 대조할 것. 표본이 갑자기 늘거나 줄면 FD 측 스키마·백필 이벤트를 확인한다.
5. 재측정은 **장 마감 후**(당일 일봉 확정)에 한다 — 장중 발굴은 run 마다 흔들린다(§18.1).

---

## 22. 발굴 결과 정제 + 운영 화면 (2026-07-26 ~ 08-02)

발굴 자체(§18)가 아니라 **"나온 결과를 어떻게 쓸 수 있게 만드느냐"** 트랙. 게이팅 수학은
이 절 전체에서 **불변**이고, 전부 부가 메타 + 응답단 필터 + 화면이다.

### 22.1 ETF 분류 레이어 + 베이시스형 분리 (`classify.rs`)

**문제**: 1:1 발굴이 자산유형 무관 전조합이라, 같은 지수를 복제하는 ETF끼리
(KODEX200↔TIGER200) 자명하게 공적분돼 상위를 도배했다. 실측 당시 코스피200 계열만
37종 → 조합 666쌍이 전부 R²≈0.999로 게이트를 통과.

**DB에 유형 컬럼이 없다**(`etf_master_daily`에 asset_class/category 없음, `tracking_multiple`은
레버리지·인버스에도 "일반(1)"이라 무용). 분류 후크는 `underlying_index`·`kr_name`·`replication`
셋뿐 → 문자열 파싱으로 10종 태깅: `broad_index / leverage_inverse / sector / theme /
bond_rates / factor / overseas / commodity / active / other`. (regex 의존성 없이 정규화+contains.)

**베이시스형(`same_underlying`)** = 양 leg 모두 ETF이고 **같은 광범위 노출을 복제**하는 페어.
통계차익 리스트에서 기본 제외(`basis=exclude`)하고 **별도 뷰로 유지**(`basis=only`) — 삭제가
아니다. 이들은 평균회귀 알파가 아니라 **베이시스 트레이딩 대상**이기 때문(로드맵 1순위).

판정 2단계 (`main.rs is_basis`):
1. `benchmark_family()` 일치 — `200 · 200TR · 150 · 150TR · 코스피100 · 코스피/코스닥 종합 ·
   선물레버리지 · 200액티브` 계열을 `KOSPI_BROAD`/`KOSDAQ_BROAD`로 묶는다.
2. 또는 `underlying_index` 정규화 완전일치 (섹터 복제 등).

⚠️ **함정**: `underlying_index`가 **액티브·TR·커버드콜엔 빈 문자열**이다(인포맥스 소스가 값을
안 줌. 같은 200액티브라도 KODEX는 공백, 1Q는 "코스피 200"). 그래서 문자열 일치만으로는
200TR·200액티브가 통계차익에 샌다 → **종목명으로 기준지수를 유추**하는 게
`benchmark_family()`의 존재 이유다. 커버드콜/채권혼합/동일가중/중소형/롱숏/섹터/테마는
별상품이라 제외(액티브라도 별상품이면 제외).

**지수 시계열 leg 제외**: `코스피`·`코스피 200 금융` 같은 raw 지수(`I:`)가 leg인 페어는
**매매 불가**라 베이시스도 아니고 통계차익도 아니다 → `list_pairs`에서 모든 뷰 제외.

### 22.2 필터 축

전부 **서버 필터**(응답단). 클라이언트 필터는 자유입력 검색/제외 2개뿐.

| 필터 | 파라미터 | 성격 |
|---|---|---|
| 뷰 | `basis=exclude\|only\|all` | 통계차익 / 베이시스 / 전체 |
| 카테고리 제외 | `exclude_categories` CSV | 어느 한 leg라도 해당하면 제외 |
| 자산군 조합 | `asset_combo` | etf_etf / etf_stock / stock_stock |
| 키워드 제외 | `exclude_terms` CSV | 종목명·코드 부분일치. 시장대용 허브(코리아TOP10·ESG사회책임·코리아밸류업) 원클릭 |
| 관계 안정성 | `stability` CSV | stable / caution / drift |
| (M:N) 공적분 | `johansen=rank1\|rank0` | §20 |

**facet 카운트는 "자기 축을 뺀 나머지 필터"를 반영한다** (faceted search 표준).
처음엔 `category_counts`/`stability_counts`를 group+basis 모수로 **고정**했다 — "토글해도
숫자가 안 흔들리게" 하려던 건데, 결과가 반대였다. 키워드 제외를 걸어도 `안정만 3,039`가
그대로인데 실제 결과는 3,018개라, **사용자가 "안정성엔 제외가 안 먹는다"고 읽었다**(행은
정상적으로 걸러지고 있었음 — 카운트만 거짓말). 지금은 각 축이 나머지 필터를 반영해
**버튼 숫자 == 그 버튼을 눌렀을 때 나오는 개수**다. 단 *자기 축*은 반영하지 않는다 —
그러면 한 값을 고르는 순간 다른 선택지가 0이 되어 되돌아갈 수 없다.

**클라이언트단은 렌더 비용이 지배한다** — 500행 × 11열 ≈ 7,500 DOM 노드라, 토글 하나에
전체 재레이아웃이 걸린다. 그래서 버튼형 필터는 전부 서버로 보냈고(카테고리 칩과 동일 경로),
자유입력만 클라이언트에 남겼다. 테이블 패널엔 `contain: layout style`(레이아웃 격리),
열 너비는 `table-fixed` + `<colgroup>`으로 고정(내용이 바뀌어도 열이 안 흔들리게).

자유입력(검색/제외)은 **디바운스 350ms + 렌더 상한 500행**이다. `useDeferredValue`만으로는
부족했다 — 우선순위만 낮출 뿐 매 타자마다 렌더가 돈다. 그리고 예전엔 *검색 중에는 매칭
전체를 무제한 렌더*해서, 페어가 4천 개인 지금은 흔한 글자 한 자에 화면이 멈췄다. 상한에
걸려 잘린 건 `(매칭 N 중 상위 500)`으로 **표시한다** — 조용한 truncate 금지(§21.4 규칙).

### 22.3 관계 안정성 — Kalman 시변 β (`detail.rs`)

정적 OLS β로 발굴한 페어가 **최근 드리프트/재레벨링 중인지** 자동 감지. 사용자가 눈으로
판단하던 "이 관계 아직 살아있나"를 판정으로 대체.

- 모델: `y_t = β_t·x_t + α_t + e_t`, 상태 θ=[β,α] random walk. 초기 θ₀=OLS, R=OLS 잔차 분산.
- 산출 `KalmanStat`: `beta_static → beta_current`(드리프트 %), `z_static vs z_adaptive`(괴리),
  `stability`, `beta_series`(스파크라인).
- **판정**(공용 `classify_stability`, 목록·상세 동일 함수라 다른 값이 나올 수 없음):
  β 드리프트 >20% **또는** z 괴리 >3.0 → drift / >10% 또는 >2.0 → caution / else stable.
- **해석 규칙**: *정적·적응 z가 같이 크면 stable(진짜 회귀 기회), 정적만 크고 적응≈0이면
  drift(재레벨링)*. 후자는 TR ETF의 배당 드리프트처럼 스프레드 레벨 자체가 이동한 경우다.
- 목록엔 배지 컬럼 + 세그먼트 필터, 상세엔 패널(설명 토글 + 지표 호버 툴팁 + β_t 스파크라인).
- 전 페어 산출 비용 **92ms / 3.8천 페어**(등장 leg 일봉을 1회 스냅샷 후 계산).

**δ는 입력 스케일 종속** → `KalmanDelta{Absolute|Relative}`로 분기. 1:1은 원 단위(x~5만)
`Absolute(1e-4)`, M:N은 합성 로그가격(x~10) `Relative`(x·y 표준화 공간에서 필터링해 양쪽
스케일에 불변). Q/R 비만 맞추는 방식은 게인이 `x²P/(x²P+R)`이라 x 스케일에 여전히 종속이다.
**1:1의 Absolute는 판정 계약이므로 변경 금지**(바꾸면 사용자가 보던 배지가 전부 흔들림).

#### 화면에서 읽는 법 (운영자용)

**한 줄**: z가 크게 벌어졌을 때, 그게 *진짜 벌어진 것*인지 *두 종목 관계 자체가 옮겨간 것*인지
구분해 주는 판정. 후자면 "평균으로 돌아온다"는 전제가 깨져서 들어가도 안 돌아온다.

| 배지 | 뜻 | 행동 |
|---|---|---|
| 🟢 **안정** | 관계 그대로 + 두 잣대가 동의 | z 크면 **진입 후보** |
| 🟡 **주의** | 관계가 약간 흔들림 | 다른 지표(ADF·최근창·차트) 더 확인 |
| 🔴 **드리프트** | 관계가 재정착 중 | **z 커도 보류** |

**두 개의 잣대** — 배지는 이 둘을 다 보고 *나쁜 쪽*으로 결정한다(둘 다 괜찮아야 🟢):

| 지표 | 뜻 | 안정 / 주의 / 드리프트 |
|---|---|---|
| **β 드리프트** | 헤지비율이 최근 얼마나 변했나 (= 관계의 *형태* 변화) | ≤10% / 10~20% / >20% |
| **z 괴리** | 3년 고정 잣대 z와 최근 갱신 잣대 z의 차이 (= *레벨* 재정착) | ≤2.0 / 2.0~3.0 / >3.0 |

비유하면 **정적 = 내 3년 평균 체중, 적응 = 요즘 몇 주 체중**이다. 둘 다 무겁다고 하면 진짜
살찐 것(=진입 기회), 3년 평균으로만 무겁고 요즘 기준으론 정상이면 새 체중에 적응해버린 것
(=재레벨링, 옛 평균으로 안 돌아옴).

**운영 규칙**: 메인 z가 커도 **🟢일 때만 믿고 진입**한다. 목록 세그먼트로 `안정만` 필터,
상세 패널의 "설명 ▾"에 같은 내용이 기준표·색 범례로 들어있다.

⚠️ **z 괴리 임계를 3.0으로 높게 잡은 이유**: 재레벨링 페어에서는 적응 z가 ≈0으로 주저앉아
`z 괴리 ≈ |정적 z|`가 된다. 정상 페어도 |정적 z|가 1~2는 흔하므로 임계가 낮으면 멀쩡한 걸
오탐한다. 그래서 **β 드리프트가 1차축**(관계 기울기 변화를 z와 무관하게 독립적으로 잡음)이고,
z 괴리는 극단적 레벨 재정착만 승격시킨다.

⚠️ **§21 오염 사건의 최대 피해자가 이 지표였다.** adj_close NULL→0 계단 때문에 β_t가 0 구간에서
얼어붙었다가 점프에서 폭발 재추정 → 실제 관계 변화가 아니라 *계단 아티팩트*를 재고 있었다.
정합 후 stable 53.9→76.3% / drift 22.8→**7.1%**로 바뀌었다(=가짜 드리프트 경보가 다수였음).
**정합 이전 판정으로 페어를 걸렀다면 전부 재검토 대상.**

### 22.4 목표 z 도달 알림 (워치리스트)

"장중에 z가 ±2 넘는 순간 진입"하고 싶은데 하루 종일 화면을 볼 수 없다 → 관심 페어에
목표를 걸어두면 알림.

- **라이브 z** = `(right − α − β·left − resid_mean) / resid_std`. 이를 위해 `PairResult`에
  `resid_mean`/`resid_std` 노출(`stats::resid_stats` 단일 진입점 — `current_z`와 계산 1벌이라
  **목록 z와 완전히 같은 척도**. 재구성 diff 0.00e+00 실측).
- 저장: LENS SQLite `stat_arb_alerts` (`(left,right,direction)` 유니크 UPSERT).
- 발화: 브라우저 알림 + 배너 + 비프. **히스테리시스** — 한 번 울리면 `|z| < target×0.8`로
  돌아와야 재무장(경계 진동 시 연타 방지). **양쪽 실시간 체결이 있을 때만** 감시(장외 오발화 차단).
- ⚠️ **한계: 브라우저 탭이 열려 있는 동안만 동작**한다. 서버 감시 + 외부 발송(텔레그램)은 미구현
  — 원래 동기를 절반만 푸는 상태이고, 로드맵 1순위 후보다.

### 22.5 상세 화면 기준 토글

사용자는 스윙(며칠~수개월)이라 **판단 기준은 일봉**, 실행 타이밍만 장중. 타임프레임은
취향이 아니라 **보유기간=반감기에 맞추는 문제**다.

- **일봉 ↔ 10분 토글(기본 일봉)**: 카드 z/ADF/R² · 차트 · 히스토그램 · 베이시스(원) ·
  포지션 계산기 · 손익 시뮬레이터가 **전부 한 basis로 일관 전환**. 엔진이 일봉 헤드라인
  (`spread_series_daily`·`daily_center/scale`·`histogram_daily`)을 추가 제공.
- **1D 안에서 '장중 | 장기' 하위 토글(기본 장중)**:
  - *장중* = 10분 가격(엔진이 09:01~15:19만 사용 — 시가·마감 단일가 제외)을 **일봉 α·β·μ·σ로
    재점수화**한 z. **z=2가 진짜 일봉 2σ**인데 장중 촘촘히 움직여 진입 순간을 포착할 수 있다.
    마지막 실시간 점 = KPI 카드의 라이브 z와 일치.
  - *장기* = 3년 일봉 종가 z(날짜축).
- **일봉 차트는 business-day 축**: 일봉 bar가 매일 15:30 timestamp라 그대로 그리면 x축에
  15:30이 붙고 주말이 갭으로 벌어진다 → `{year,month,day}` BusinessDay로 넘겨 날짜만·비거래일
  자동 압축.

⚠️ 자주 헷갈리는 지점: 같은 페어의 **일봉 z와 10분 z가 크게 갈릴 수 있다**(예 −3.85 vs −1.63).
이는 **단기창이 새 레벨로 재중심화**한 것이지 일봉 관계가 깨진 게 아니다. 관계 자체가
흔들렸는지는 §22.3 Kalman 패널이 판정한다.

### 22.5-a 목록 z = 전일 종가 / 상세 카드 z = 실시간 (2026-08-13)

같은 페어인데 **목록 z와 상세 상단 카드 z가 다르게 보이는 건 정상**이다. 척도는 이미
한 벌로 통일돼 있고(둘 다 일봉 OLS α·β + 같은 잔차 μ·σ — `stats::resid_stats` 단일 진입점),
**시점만 다르다**.

| 위치 | 값 | 시점 |
|---|---|---|
| 목록 z 컬럼 | `discovery.z_score` | 발굴 사이클 기준 = **직전 일봉 종가** |
| 상세 `timeframes[1d]` · 일봉 시계열 마지막 점 | 목록 z와 **완전 동일** | 직전 일봉 종가 |
| 상세 상단 카드 | `liveZ ?? dbLastZ` | 장중엔 **실시간 틱** |

실측(2026-08-13 12:08, KODEX AI전력핵심설비 ↔ HANARO 전력설비투자): 목록 −0.675 =
`timeframes[1d].z_score` = 일봉 마지막 점 z. 카드는 −1.30. 두 종목이 같이 +2.5% 올랐는데
β=1.19 가중이라 잔차가 −89 → −171로 벌어진 결과(σ=132.35).

**목록을 전부 실시간으로 바꾸지 않는 이유**: 렌더 150행 × 2종목 = 최대 300종목 WS 구독 —
LS 계정 한계(호가 stall 전례, `realtime-service.md` §WS 두 키 분산)를 정면으로 건드린다.
대신:

- 목록 컬럼 헤더에 **`z 전일종가`** 명시 + 툴팁.
- **z 셀 hover(220ms) → 그 페어 2종목만** `/realtime/quote`(t8407 1콜, 20초 캐시) 조회 →
  같은 μ·σ로 라이브 z 팝오버(정적 z 대비 Δ·두 종목 현재가·조회시각). 산식은 워치리스트와
  공용(`lib/stat-arb/alerts.ts` `liveZ`) — z 산식 분기는 여전히 없음.
- 지속 감시가 필요하면 워치리스트(별표) — 그쪽은 WS 구독 + 목표 z 알림(§22.4).

구현: `realtime/src/main.rs` `/quote` + `feed/ls_rest.rs::fetch_quotes_snapshot`,
`frontend/src/lib/stat-arb/live-quote.ts`, `pages/stat-arb.tsx`(hover는 tableRows memo 밖 —
안에 넣으면 hover마다 150행 JSX 재생성).

### 22.6 M:N 확장 (§10 PR-C4)

병목이 **통계 임계가 아니라 입력 미도달**이었다(494 시도 중 85%가 게이트 전 탈락).

| 조치 | 결과 |
|---|---|
| `ETF_TOP_N` 100 → `STATARB_ETF_TOP_N`(기본 400, 10억 하한이 binding이라 실적재 304) | `standardize: empty side` 352 → 242 |
| `split_by_factor1` → `split_by_factor`(PC2 우선) | split 탈락 **67 → 0** |
| `choose_target_len`(상위 90% 보존) | PCA rank-deficient **91/495 → 0**, M:N 표본 151 → 727 |
| deflation(그룹당 성분 3개, leg 회수 + anchor 예외) | 페어 수 2배 |
| leg 집합 기준 dedup | 중복 25행 → 대표 1행 |

**왜 PC1이 아니라 PC2인가**: 상관이 전부 양인 주식 그룹의 PC1은 Perron-Frobenius로 **단일
부호**라 부호 분할 시 한쪽이 항상 빈다(결정론적 0%, 임계 완화로 안 풀림). PC2는 PC1과
직교라 **부호가 반드시 섞이고**, 그게 곧 시장 공통을 뺀 스프레드 축이다.

**왜 사영 deflation이 아니라 leg 회수인가**: `/mn-pairs` dedup 키가 leg 집합이라 가중치만
다른 재선택은 통째로 축약돼 산출이 안 늘고, 게이트가 원계열 OLS라 2번째 성분이 1번째의
선형결합이어도 못 거른다. leg 회수는 성분 간 종목이 겹치지 않아 포지션 집중도 없다. 단
etf 그룹의 X변은 **그룹 기준물**이라 anchor로 고정(회수하면 효과 0) → *같은 ETF ↔ 서로
겹치지 않는 바스켓 N종*이 나온다 = 헤지 바스켓 선택지.

**중복의 근원**: `groups.rs underlying_to_index()`가 KOSPI200 구성종목을 "코스피200*"
카테고리 25개 전부에 주입해 candidate pool이 사실상 동일해진다. 게이팅 문제가 아니라
그룹 정의 문제라 응답단에서 축약한다(`dup_group_count`).

### 22.7 M:N 상세 페이지 — 일봉 전용인 이유

`pair_detail`(1:1)은 leg당 30초봉 60일치를 온디맨드 로드하고 당일분을 **t8412로 순차**
stitch한다(TPS 1). M:N은 leg가 3~10개라 **레이턴시가 leg 수에 선형 증가** → 인트라데이는
실용 불가. 사용자 판단 기준도 일봉이라 **일봉 전용**으로 확정했다(응답 15ms 내).

`mn_detail.rs`는 N-way ts 교집합으로 합성 `X=Σw·lnP`, `Y=Σv·lnP`를 만들어 **`Bar`로 포장**해
`detail.rs`의 `build_headline`/`compute_stability`를 그대로 재사용한다 — 산식을 1벌로 유지.

⚠️ `MLeg.weight`는 **CCA 가중치이지 주수가 아니다.** 거래 가능한 바스켓으로 바꾸려면
가격으로 나누고 호가단위·수량 반올림이 필요한데 그 변환은 아직 없다(명목비중 ∝ `v : β·w`).

---

## 23. 주식선물 대체 캐리 (2026-08-13)

발굴된 현물 페어의 **매수 종목**을 개별주식선물로 바꾸면 현금이 덜 묶여 이자를 번다.
발굴 유니버스에 선물을 넣는 게 아니라(페어 통계는 그대로) **기존 페어에 "이 종목을 선물로
바꾸면 얼마 이득인지"를 붙이는 부가 지표**다. 엔진(8300)과 무관 — FastAPI가 직접 계산한다.

### 23.1 산식 (만기 보유 기준)

```
r_eff            = r × (1 − margin)                  # 증거금으로 묶이는 현금은 이자를 못 번다
basis_theory     = spot × r_eff × d/365 − div_sum    # 자체 이론 베이시스 (원/주)
basis_now        = 선물 종가 − 현물가                  # = futures_ohlcv_daily.underlying_basis
carry_advantage  = basis_theory − basis_now          # 양수 = 선물이 쌈 → 선물 매수 유리
carry_bp         = carry_advantage / spot × 1e4
carry_bp_per_day = carry_bp / d
```

- `r` 기본 **0.028**(회사금리 — `lp-system-design.md`·`routers/lp.py base_rate_annual`과 동일
  컨벤션), `margin` 기본 **0.15**. 둘 다 쿼리 파라미터(`rate`,`margin`)로 조정.
- `d` = 잔존 캘린더일, `div_sum` = `오늘 < ex_date ≤ 만기`인 **확정 현금배당** 합(원/주).
- ⚠️ **이자 항을 따로 더하지 않는다** — 이론 베이시스에 이미 들어있다(중복 계산 금지).
- ⚠️ **만기 후 배당은 숫자에 넣지 않는다 — 가시화만.** 롤해서 길게 들고 가면 다음/다다음 월물
  구간의 배당락을 맞지만, 그 배당은 **넘어갈 월물 가격에 이미 프라이싱**돼 있다. 지금 월물의
  캐리에서 또 빼면 이중 반영이다. 대신 언제 얼마짜리 배당락이 오는지는 봐야 하므로 응답에
  `upcoming_dividends`(오늘 < ex_date ≤ +1년, 만기 내·후 **모두**)와 `past_dividends`
  (오늘 −1년 ≤ ex_date ≤ 오늘)를 같이 내려 화면에서 3분류로 보여준다. 이론가에 반영되는
  배당 항은 여전히 `div_sum` 하나뿐 (= `upcoming_dividends` 중 `ex_date ≤ 만기` 합).
- ⚠️ **대여요율·대차 항은 넣지 않는다.** 대여 송출이 안 나갈 가능성이 높다는 사용자 결정.
  대여 수익은 목록의 별도 컬럼(대여 L/R)으로 이미 보고 있으므로 섞지 않는다.
- **매수 종목에만 의미가 있다.** 매도 종목은 현금이 들어오는 쪽이라 캐리 논리가 반대이고,
  실행은 대차(차입)라 이 지표와 별개다. 매수 종목은 **z 부호 + β 부호** 둘 다로 결정된다
  (`spread = right − α − β·left`, 헤지 = β·left 포지션):

  | | `z ≥ 0` (right 매도) | `z < 0` (right 매수) |
  |---|---|---|
  | `β ≥ 0` | left 매수 | right 매수 |
  | `β < 0` (short pair) | **매수 종목 없음** (두 종목 모두 매도) | **두 종목 모두 매수** |

  ⚠️ β<0 페어가 189개(3,591 중)나 된다. β 부호를 빼고 z만 보면 이들의 매수 종목을 정반대로
  지정한다. 판정은 `buyLegKeys(z, β, leftKey, rightKey)` 1벌(0~2개 key 반환).

### 23.2 롤 규칙 / 데이터 소스

| 항목 | 소스 | 비고 |
|---|---|---|
| 상장 종목·월물 | `data/futures_master.json` (273종) | `services/futures_master.py` 재사용. `days_left`는 export(새벽) 시점 값이라 **믿지 않고 expiry로 재계산** |
| 선물 종가·실측 베이시스 | `futures_ohlcv_daily` (`close`,`underlying_basis`) | `DISTINCT ON (contract_code)`로 **계약별** 최신 1행 (라벨 조인 아님 — 아래 롤 경계) |
| 기초주식 매핑 | `futures_underlyings` (`underlying_type='L'`, 275종) | `012450 → BH` 같은 2자리 코드. 매핑 없으면 제외 |
| 배당 | `dividends` (`is_latest AND dividend_type='CASH'`) | 지난 1년 ~ 향후 1년을 1쿼리로 받고, 계약별 만기 컷(`div_sum`)·과거/미래 분류는 파이썬에서 |
| 현물가 | **역산** `spot = close − underlying_basis` | 별도 현물 조회 불필요 (NEAR/NEXT 어느 쪽으로 계산해도 같은 값 — 실측 확인) |

- **롤**: front 잔존일 `< 2`면 back 월물. 만기일 당일 front를 잡으면 `d=0`이라 캐리가 정의되지
  않는다. (2026-08-13 = 8월물 만기일이라 273종 전부 back.)
- **롤 경계 = contract_code 직접 조회**: 마스터가 고른 월물의 코드(`ABH69000` 등)로 일봉
  룩업을 친다. NEAR/NEXT 라벨은 조인에 쓰지 않는다 — 만기 다음날에는 마스터 front가 이미 신규
  월물인데 DB 최신 NEAR는 만기 소멸한 구월물이고 신규 월물은 아직 **NEXT**라, 라벨 조인은 전
  종목을 어긋나게 한다. 코드 조회는 라벨이 무엇이든 같은 계약의 종가·베이시스를 집어오므로
  **경계일에도 빈 값이 아니라 정상 값**이 나온다 (2026-08-14 실측: `count=273, skipped=0`,
  012450 = ABH69000 / 8-13 / basis −3,000 / spot 1,185,000).
  ⚠️ 라벨 대조 가드(v1, 2026-08-13)는 정확히 이 상황에서 273종 전부를 걸러 캐리를 통째로 비웠다.
  `contract_code`는 기초자산까지 포함해 전역 유일(실측 1,198/1,198)이라 코드만으로 키가 된다.
- **제외 조건**: `futures_underlyings` 매핑 없음 / **선택 월물의 최근 5거래일 일봉 없음**(신규
  상장 월물·거래 중단 등 — 이 수가 응답 `skipped_roll_mismatch`. 평시 0, 프론트 미표시 진단용)
  / `spot ≤ 0`.
- `trading_value` 단위는 **천원**(volume×close×multiplier 대비 실측 ≈1000배) → 응답은 원으로 환산.
- `avg_value_30d`는 **근월물(NEAR) 30거래일 평균**이다. 선택 월물이 back일 때 NEXT 평균을 쓰면
  아직 원월물이던 기간이 섞여 유동성이 실제의 1/200로 보인다(2026-08-07 BH: NEAR 894억 vs
  NEXT 4.4억). 롤 후 그 계약이 근월물이 되므로 연속 근월 계열이 대표값.

### 23.3 API / 구현

`GET /api/stat-arb/futures-carry?rate=0.028&margin=0.15` → `{asof, rate, margin, r_eff, count,
skipped_roll_mismatch, items: {기초주식코드: {..., upcoming_dividends: [{ex_date, amount}],
past_dividends: [...]}}}`. 프록시가 아니라 `routers/stat_arb.py`가 직접 응답
(`services/futures_carry.py`).

- **배치 5쿼리**로 273종 전량 (종목별 루프 없음): 거래일 축 / 기초주식 매핑 / 최신 일봉
  `DISTINCT ON` / 30일 평균 / 배당(과거·미래 1쿼리). 배당 목록은 스냅샷에서 미리 직렬화해
  두고 응답에 그대로 실어 매 요청 재가공을 없앤다.
- **rate·margin과 무관한 원자료(`CarrySnapshot`)만 10분 캐시**하고 공식은 매 요청 재적용 —
  파라미터를 바꿔도 DB를 다시 안 친다(캐시 히트 22ms). 날짜가 바뀌면 무효화.
- 프론트 공용 타입·헬퍼: `frontend/src/lib/stat-arb/futures-carry.ts`
  (`loadFuturesCarry` / `buyLegKeys` / `carryOf` / `buyLegCarry` / `fmtValue`). 표시 자릿수도
  여기 1벌 — **bp는 `fmtBp` 소수 2자리 고정, 원/주는 `fmtWon` 정수 반올림**(둘 다 부호 포함).
  일봉 종가 스냅샷이라 셋째 자리 이하는 의미 없는 정밀도다. 목록·상세·툴팁 모두 이 헬퍼를 쓴다.
- **판정 배지 (2026-08-14)** — "복잡한 계산 말고 살지 말지만 보고 싶다"는 요구에 맞춘 결론 1개.
  `carryVerdict(c)` 3구간, 기준은 **만기까지 총 bp(`carry_bp`)**다 — bp/일은 잔존일이 짧을수록
  부풀어서 고정 비용(쿠션)과 견줄 축이 못 된다:

  | 판정 | 조건 | 뜻 |
  |---|---|---|
  | `futures` **선물 매수** (up) | `carry_bp ≥ CARRY_CUSHION_BP` | 이론 대비 백워데이션 — 현물 대신 주식선물 매수 |
  | `neutral` **중립** (t3) | `0 ≤ carry_bp < CARRY_CUSHION_BP` | 쿠션 미만이라 실익 미미. 단기 청산 예정이면 현물 유지 |
  | `spot` **현물 매수** (t4) | `carry_bp < 0` | 콘탱고가 이자 수익보다 큼 — 선물로 바꾸면 손해 |

  `CARRY_CUSHION_BP = 5`(총 bp) = 왕복 슬리피지·베이시스 노이즈 감안분. 라벨/배지색/숫자색/툴팁도
  같은 파일 1벌(`CARRY_VERDICT_LABEL` / `_BADGE_CLS` / `_TEXT_CLS` / `carryVerdictTitle`)이라
  목록 색과 상세 배지가 갈릴 수 없다.
- **배당 주의 `dividendCaution(c)`** — 캐리 숫자에 **안 들어간** 배당 리스크를 한 플래그로.
  ① 만기 후 확정 배당락 존재(`divsAfterExpiry` — 롤하면 그대로 맞는다) ② `past_dividends`의
  (월,일)을 잔존 구간 연도로 투영해 `[오늘, 만기]`에 들어오면 **미공시 정기배당 힌트**(그러면
  이론 베이시스 과대 = 캐리 과대평가, §23.4). 구간이 연말을 넘으면 두 해로 투영하고, 윈도 판정은
  ISO 문자열 비교라 2/29 투영도 안전하다.
  ⚠️ ②의 중복 제외는 **달(月) 일치가 아니라 ±`DIV_HINT_TOL_DAYS`(21일)**다 — 배당락일은 해마다
  ±2주 흔들려서(영원무역 작년 9/8 → 올해 확정 8/27) 달로만 보면 이미 공시된 배당이 "미공시분
  확인"으로 뜬다. 확정 목록은 `upcoming`뿐 아니라 **`past`도 포함**해야 한다: 오늘 배당락 난
  종목(SK·포스코인터 8/14)이 작년 같은 날짜 이력 때문에 오탐으로 뜨던 건이 이 규칙으로 사라졌다.
  2026-08-14 스냅샷 실측 = 273종 중 2종만 flag(현대백화점 ①, 현대엘리베이터 ②).
- 목록(`pages/stat-arb.tsx`): 정렬 가능한 **캐리(bp/일)** 컬럼 1개. 값 = 매수 종목의
  `carry_bp_per_day`(`buyLegCarry`), 없으면 `—`. 매수 종목이 둘이면(β<0 & z<0) **값이 큰**
  = 더 유리한 쪽을 표시한다(절댓값 아님). 값 없음은 `NaN`으로 두고 비교자가 **정렬 방향과
  무관하게 뒤로** 보낸다(빈칸이 위로 오면 표가 안 읽힌다). 페어 셀에 배지를 늘리지 않았다.
  **숫자 색이 곧 판정**(`CARRY_VERDICT_TEXT_CLS` — 초록 선물 매수 / t3 중립 / t4 현물 매수)이라
  150행짜리 표에 배지를 더 심지 않았고, 임계를 셀에 또 하드코딩하지 않는다(예전 `0.05bp/일`
  하드코딩 폐기). `dividendCaution.flag`면 값 옆에 **`배` 마커 1개**(10px, warning) — 툴팁 첫
  줄에 판정 한 줄(`carryVerdictTitle`), 아래에 배당 사유. 마커는 하나뿐이라 컬럼 폭·행 높이는
  그대로다.
- 상세(`pages/stat-arb-detail.tsx`): 하단 **"주식선물 대체"** 패널. **표면엔 구조만, 문장은 전부
  제목 옆 `[?]` 접이식 도움말로** (2026-08-13 가독성 재설계 — "글만 너무 많다" 피드백).
  · 헤더 = 진입 방향 배지 2개(`매수 A` up / `매도 B` down, `buyLegKeys` 그대로) + 오른쪽에 매수
  종목 캐리 **큰 숫자**(bp/일, `buyLegCarry` = 목록 컬럼과 같은 판정 1벌) + **판정 배지 소형**
  (`CarryVerdictBadge sm` — 배당 주의면 `배당 확인` 마커 동반) + 종목명. **헤더만 봐도 끝난다.**
  β<0은 배너 문장 대신 warning **배지** 하나(`β<0 · 둘 다 매도 — 대체 대상 없음` / `β<0 · 둘 다 매수`).
  · 종목 카드 2개 = 라벨:값 2열 그리드 — 월물(코드·근월/차월 M/D·잔존일), 실측/이론 베이시스
  (이론에 `배당 −div_sum` 부기), **캐리**(강조 박스: 맨 앞 **판정 배지**(+`배당 확인`) 뒤에
  bp/일 + 만기 bp + 원/주 — **배지가 결론, 숫자는 근거**다. **매수 종목 카드에만**.
  매도 카드는 같은 자리에 `매도 종목 — 캐리 산정 대상 아님` muted 한 줄이다: 매도 대금은 매수 종목
  자금으로 들어가 캐리가 상쇄되고, `carry_bp`는 **선물 매수 기준 부호**라 그대로 띄우면 백워데이션의
  비용을 이익으로 오독한다. 월물·베이시스·계약 환산·유동성·배당은 매도 카드도 유지 — 선물 상장 여부·
  베이시스 상태는 실행 참고 정보다), 계약 환산
  (`{qty}주 = N계약 + 잔차주`, `1계약 multiplier주`), 유동성(+`data_date`). 라벨 툴팁에 각 산식.
  미상장이면 "주식선물 미상장 · 현물로만 실행" 한 줄 + 회색 카드. 각주는 `일봉 {asof} 종가 기준 ·
  금리 · 증거금` 한 줄뿐. `[?]` 도움말은 **판정 3구간 / 쿠션 5bp(총 bp로 비교하는 이유) /
  배당 확인 ①② / 산식 / 매수 종목만 의미 / 배당 이중 반영 / 계약·유동성 / 한계** 8줄.
- 상세 카드 하단 **배당 = 날짜 | 금액 | 상태배지 미니 표 1개**(`DividendSection`). 3분류를 소제목
  문장이 아니라 배지로 구분: ① 만기 내 확정 = `차감됨`(t3, 툴팁에 `−div_sum원`) / ② 만기 후 확정
  예정 = `롤 유의`(warning, 툴팁에 이중 반영 설명) / ③ 지난 1년 이력 = `이력`(t4) — 기본 접힘,
  토글 라벨 `지난 1년 이력 N건 ▸`. 셋 다 없으면 "배당 없음" 한 줄. 분류 헬퍼는
  `splitDivsByExpiry` / `divsAfterExpiry` 1벌 (목록·상세의 배당 확인 마커도 `dividendCaution`을
  통해 같은 함수를 탄다).

### 23.4 한계

- **일봉 종가 기준**이다. 장중 실제 베이시스는 다르고, 특히 주식선물은 체결이 뜸해 종가
  베이시스가 마지막 체결의 잔재일 수 있다. 실행 직전엔 호가를 봐야 한다.
- **미공시 배당은 여전히 숫자에 반영 안 된다.** `dividends`에 아직 안 들어온 중간·기말 배당이
  있으면 이론 베이시스가 과대 → 캐리가 실제보다 좋아 보인다(백워데이션이 사실은 배당 선반영인
  경우). 추정 배당(`services/dividend_estimator.py`)은 **일부러 안 쓴다** — 확정만.
  → 보완: 상세 카드에 **지난 1년 배당 이력**(`past_dividends`, 기본 접힘)을 붙였다. 12월 결산
  종목의 정기 배당 주기를 눈으로 확인해 "곧 공시될 것"을 사람이 판단하라는 용도이지, 숫자에
  들어가는 값이 아니다 (확정 아님).
- **만기 후 배당은 캐리에 없다** — 표시만 한다(§23.1). 롤해서 계속 들고 갈 계획이면 `배` 마커·
  상세 카드에서 배당락 일정을 직접 확인해야 한다. 그 구간 손익은 다음 월물 가격에 이미 반영돼
  있어 이 지표로는 평가되지 않는다.
- **만기 전 청산 시 수렴이 불완전**하다. carry는 만기 보유(베이시스 → 0) 가정이고, 통계차익은
  보통 z 회귀 시점에 나오므로 실현 캐리는 이보다 작다. 잔여 베이시스 리스크는 별도.
- **판정 배지도 만기 보유 가정이다.** half-life가 잔존일보다 훨씬 짧으면 실현 캐리는 보유일수에
  비례해 축소되고 잔여 베이시스만큼 불확실하다 — 그런 페어는 `선물 매수`가 떠도 중립으로 취급하는
  게 안전하다 (쿠션은 고정 비용만 반영할 뿐 보유기간을 모른다).
- 증거금률은 **가정값 1개**(종목·증거금률 차등·대용증권 반영 없음). 실제 예탁금 소요와 다르다.
- 유동성(`avg_value_30d`)이 수억 원대인 종목은 캐리가 커 보여도 슬리피지가 캐리를 먹는다.
  실측 상위(2026-08-12 스냅샷)는 대부분 30일 평균 2~4억짜리 얇은 종목이었다.

---

## 24. 고정 z (frozen z) — 청산 판단의 자 (2026-08-27)

### 24.1 왜 필요한가

포지션 화면은 **진입 z(스냅샷)** 와 **현재 z(엔진의 오늘 롤링 z)** 를 나란히 놓고 회귀 %·
라벨·산점도를 계산해 왔다. 그런데 엔진은 사이클마다 회귀(α·β)와 정규화(μ·σ)를 **다시
추정**한다. 밴드가 움직이면 두 값은 *다른 자*로 잰 눈금이라 뺄셈 자체가 성립하지 않는다.

실사례 (한화에어로스페이스 ↔ KODEX 방산TOP10, 2026-08):

| | 진입 | 현재 | 화면 해석 |
|---|---|---|---|
| 화면 z (롤링) | −2.90 | −2.52 | "0.4σ 수렴 — 잘 가고 있다" |
| **고정 z** | **−2.90** | **−3.36** | **0.46σ 역행** |
| 실제 손익 | | 마이너스 | 고정 z와 부호 일치 |

σ가 354 → 471(+33%)로 벌어지는 동안 잔차는 오히려 더 벌어졌다. **σ가 커지면 같은(혹은 더
나쁜) 잔차도 z는 작아 보인다** — 이게 "수렴처럼 보이는 역행"의 정체다.

### 24.2 정의

    frozen_z = (P_right − (β₀·P_left + α₀) − μ₀) / σ₀

α₀·β₀·μ₀·σ₀는 **진입 시점 스냅샷**, 가격만 현재 것. 성질:

- 진입 시점엔 정의상 `frozen_z ≡ entry_z` (진입가 = 진입 z를 만든 가격일 때).
- 이후 변화분이 손익과 1:1: `ΔPnL ≈ −side_right × Δfrozen_z × σ₀ × right수량` (β-정합 헤지).
- 두 z를 **같은 가격**으로 재놓으므로 `고정 z − 오늘 z` 는 순수 **밴드 이동분**이다
  (가격 시점차가 섞이지 않는다 — 오늘 z도 롤링 밴드 + 같은 현재가로 다시 계산한다).

**청산 판단(회귀 %·자동 라벨·예상 청산일·산점도 y축)은 전부 고정 z로** 한다. 오늘 z는
"관계가 재추정됐나"를 보는 보조 지표로만 남긴다.

### 24.3 저장 (스키마 변경 없음)

`positions.entry_stats_json`(JSON dict)에 **`center`·`scale`·`basis`** 추가:

    {alpha, beta, center, scale, basis, half_life, adf, r2}

- 진입 기록 모달이 페어 상세의 **표시 기준(basis 토글 §22.5)과 같은 자**에서 뜬다. 즉
  `1d` 선택 상태면 `daily_center`/`daily_scale` + `timeframes[1d].alpha/hedge_ratio`.
  α·β와 μ·σ가 **같은 timeframe**이어야 `frozen_z(진입가) ≡ 진입 z`가 성립한다.
- JSON 필드 추가라 **마이그레이션 없음**. 구 기록은 그냥 키가 없다.

### 24.4 구 기록 — σ₀ 역산

밴드를 저장하기 전 기록도 대부분 구제된다. `entry_z = (spread₀ − μ₀)/σ₀` 에서 **μ₀ = 0**을
쓰면 (엔진 잔차는 절편 포함 OLS라 평균이 정의상 0 — 실측 |μ| < 1e-10)

    σ₀ = (P_right0 − β₀·P_left0 − α₀) / entry_z

남는 가정은 "진입가 = 진입 z를 만든 가격"뿐이고, 진입 모달이 실시간가를 prefill하므로 보통
성립한다. 가드: `|entry_z| ≥ 0.2` (0 근처면 폭발), `σ₀ > 0`(부호 어긋나면 α·β와 z가 다른
자에서 온 것 → 포기). 화면엔 **`역산` 마커 + 툴팁**으로 저장 밴드와 구분해 표시하고, 역산도
안 되면 고정 z는 `—` + 사유("진입 밴드 미저장 + 역산 불가").

### 24.5 화면

| 위치 | 표시 |
|---|---|
| 목록(`/stat-arb/positions`) | **고정 z**(주 컬럼, 진입 z 옆) · 회귀 · **오늘 z**(보조, 회색). 괴리 `|Δ| ≥ 0.5σ`면 행 강조 + 오늘 z 셀에 `(Δ+0.8)` + 툴팁 "밴드 이동 — 관계 재추정됨" |
| 산점도 | y축 = 고정 z (빈 점 = 고정 z 없어 오늘 z로 대체) |
| 상세 KPI | `진입 z → 고정 z` / `오늘 z · 롤링 {기준}`(괴리 시 warning 톤) / `회귀(고정 z)` / 청산권 예상 / 평가+대여 |
| 상세 통계표 | `밴드 중심 μ` · `밴드 σ` 행 추가 (진입 vs 현재) — 밴드가 얼마나 움직였는지 눈으로 |

경고 임계 **0.5σ**: 위 실사례의 괴리가 0.69~0.83σ라 0.7로 잡으면 정작 그 케이스를 놓친다.
진입 임계가 2σ인 화면에서 0.5σ는 이미 "청산이냐 유지냐"를 뒤집는 크기다.

**현재가 소스**: 목록은 `/realtime/quote`(t8407, 20초 캐시, 30초 폴링) — 미청산 leg만, 청산분은
확정 체결가. 페어 수천 개인 발굴 목록과 달리 포지션은 수십 건이라 WS 구독 없이 1콜로 끝난다
(`fetchQuotes`는 50개 초과 시 자동 분할). 상세는 기존대로 WS 틱(영구 sub) → 없으면 마지막 봉 종가.

곁다리로 목록 **평가손익**도 현재가 기반 실계산(`markPnLFromPrices`)으로 바꿨다 — 기존
회귀비율 추정(`estimateMarkPnL`)은 롤링 z에 의존해 "수렴처럼 보이는 역행"을 손익에도 그대로
옮겼기 때문. 가격이 없을 때만 추정으로 폴백한다.

### 24.6 검증 (2026-08-27, 실데이터)

한화에어로(S:012450) ↔ KODEX 방산TOP10(E:0080G0), 엔진 canonical 방향은 **left=ETF /
right=한화**(z 부호가 사용자 화면과 반대). 오늘 1d 밴드 α=−92,528 β=102.5026 σ=49,940.

| 테스트 | 진입 z | 고정 z(현재가 10,900/1,150,000) | 오늘 z(같은 가격) | 괴리 | 평가손익 |
|---|---|---|---|---|---|
| T1 오늘 밴드 스냅샷 | +2.2166 | **+2.5080** | +2.5080 | 0.0000 | −145,500 |
| T2 진입시점 밴드(σ₀=38,172 역산) | +2.9000 | **+3.2812** | +2.5080 | **+0.773 (경고)** | −145,500 |
| 실기록 "방산 페어"(역산 σ₀=45,635) | +2.0270 | **+2.8476** | +2.5080 | +0.340 | −3,145,800 |

- T1은 진입 밴드 = 오늘 밴드라 **괴리 0** — 좌표 변환이 항등임을 확인 (거짓 경고 없음).
- T2는 진입가 기준 고정 z가 **정확히 2.9000** (스냅샷 항등) → 현재 3.28로 **역행**인데 화면
  z는 2.90 → 2.51 "수렴". 손익 −145,500으로 고정 z와 부호 일치.
- 손계산 대조(사용자 방향, 진입 z −2.9 가정): σ₀ = 353.77 → 고정 z 진입 −2.900 → 현재
  **−3.360**(전일 종가 기준 −3.094), 오늘 z −2.524. 예상치(≈−3.5σ) 부합.
- 손익 1:1 확인: `Δfrozen × σ₀ × right수량` = −7,524원 vs 실제 −7,500원 (β-정합 수량
  반올림 오차 1025 vs 1025.03).

### 24.7 기록 수정 (PUT) + entry_z 정합 정책 (2026-08-27)

포지션은 등록·삭제만 됐고 **진입일·수량·진입가를 못 고쳤다** — 오입력이면 지우고 다시 넣어야
했다(대여 기록도 같이 날아간다). `PUT /api/positions/:id` 추가:

```
PUT /api/positions/:id     보낸 필드만 반영 (exclude_unset, 명시적 null = 지움)
    { opened_at, label, note, entry_z, legs: [{leg_id, qty, entry_price}, …] }
    → 갱신된 상세 + entry_z_update: {mode, previous, value, note}
```

- **못 바꾸는 것**: 종목·방향·페어 키(left/right_key)·청산가. 페어가 바뀌면 밴드·대여 기록이
  남의 것이 되므로 삭제 후 재등록이 맞다. 청산가는 청산 화면 소관.
- **이력 없음** — 단순 덮어쓰기. 남기고 싶으면 note에.
- 검증: leg_id ⊂ 해당 포지션 / qty·price > 0(pydantic) / `opened_at ≤ closed_at`.
  leg 갱신과 entry_z 재계산은 한 트랜잭션(BEGIN IMMEDIATE) — z와 가격이 어긋나지 않게.

**entry_z 정합** — 진입가를 고치면 진입 z도 같이 움직여야 `frozen_z(진입가) ≡ entry_z`(§24.2)가
유지된다. 밴드 유무로 갈린다:

| 기록 | 진입가 수정 시 | 근거 |
|---|---|---|
| **밴드 저장됨** (μ₀·σ₀ 있음) | 서버가 `entry_z = (P_r − β₀·P_l − α₀ − μ₀)/σ₀` **재계산**. 사용자 입력 entry_z는 무시(`mode: ignored`) | 밴드가 자로 있으니 z는 종속변수다. 사람이 따로 넣으면 항등이 깨진다 |
| **밴드 없음** (구 기록) | 자동 재계산 **안 함**. 사용자가 entry_z를 직접 수정 (`mode: manual`) | σ₀를 진입 z에서 역산(§24.4)하므로 z↔가격이 서로를 정의하는 **순환**. 자동 재계산하면 σ₀가 같이 움직여 아무 정보도 안 준다 |

⚠️ ~~밴드 자체는 진입일을 바꿔도 불변(스냅샷 유지). 엔진은 최신 사이클 통계만 들고 있어 임의
과거 날짜의 α·β·μ·σ를 소급 조회할 방법이 없다.~~ → **§24.8에서 해소**. 엔진에 없을 뿐 재료
(일봉)는 남아 있어 진입일 기준으로 다시 회귀하면 그날의 밴드가 복원된다. 밴드 미저장 기록의
수동 entry_z 입력도 자동 추정 + override로 바뀌었다 (아래 표는 `entry_band`를 안 보낼 때의
경로로 그대로 유효).

화면: 목록 행 `수정`(삭제 옆) / 상세 헤더 `기록 수정`. 모달은 등록 모달과 같은 문법이되 입력
축이 다르다(등록 = 실시간 통계량을 얼리는 화면, 수정 = 얼린 자는 두고 체결 사실만 교정) —
별도 `position-edit-modal.tsx`. 밴드가 있으면 진입 z는 입력이 아니라 **재계산 미리보기**
(`entryZ 현재 → 예상`, 프론트 `frozenZ`와 서버 산식 동일), 없으면 입력 필드 + 경고문.
저장 후 `entry_z_update`를 한 줄 안내로 띄운다(조용히 z가 바뀌면 사용자가 못 알아챈다).

검증 (2026-08-27 curl 왕복, 테스트 기록 생성→수정→삭제): 밴드 α=−100,000 β=100 μ=5,000
σ=20,000, 진입가 left 11,000 / right 1,200,000 → entry_z 9.75. 수량 100→120, left
11,000→11,050, right 1,200,000→1,150,000 수정 → spread 145,000 → **entry_z 7.00**
(손계산 `(145,000−5,000)/20,000 = 7.00` 일치, `mode: recomputed`). 구 기록(밴드 없음)은
가격만 고치면 `mode: unchanged` + 사유, entry_z 동봉 시 `manual`로 그 값 저장.

### 24.8 진입 z 자동 추정 — 과거 시점 밴드 재계산 (refit, 2026-08-27)

§24.7의 한계("과거 밴드는 소급 조회 불가")를 없앤다. **엔진에 없을 뿐, 밴드의 재료인 일봉은
Finance_Data에 그대로 남아 있다.** 진입일 이전 창만 다시 회귀하면 그날의 α₀·β₀·μ₀·σ₀가
복원되고, 진입가를 넣으면 진입 z가 나온다 — 날짜와 가격만으로 충분하다(따로 기록할 필요 없음).

```
POST /api/positions/estimate-entry-band
    {left_key, right_key, entry_date: 'YYYY-MM-DD', left_price, right_price}
    → {alpha, beta, center, sigma, entry_z, spread, r2, adf, half_life,
       window_bars, window_days, first_date, asof, basis:'1d', source:'refit'}
    422 = 표본 부족 / 자산군 미지원 / 미래 날짜 (사유 문장 그대로 detail)
```

**재현 스펙** — 엔진과 *같은 자*여야 의미가 있다. `services/entry_band.py`는 엔진 세 지점을
그대로 옮긴 것이고, 하나라도 어긋나면 다른 자다:

| | 산식 | 엔진 출처 |
|---|---|---|
| 가격 | `ohlcv_daily.adj_close::INTEGER` (수정주가 + **정수 반올림**), NULL·≤0 제외 | `data/bars.rs` `load_stock_daily` |
| 창 | `time ∈ [entry_date − 1095일, entry_date)` — **당일 미포함** | `main.rs warmup_days_daily()=1095` |
| 정렬 | 날짜 교집합, 양쪽 종가 > 0 인 날만 | `detail.rs intersect_by_ts` |
| 회귀 | 레벨 OLS `y(right) = β·x(left) + α`, 잔차 `e = y − α − βx` | `stats.rs ols` |
| 정규화 | `center = mean(e)`(절편 OLS라 ≈0), `sigma = 모표준편차(분모 n)`, `z = (e−center)/sigma` | `detail.rs build_headline` |

당일을 빼는 이유: 일봉은 장 마감 후 FD 배치로 들어오므로 **진입 시점에 엔진 캐시의 마지막 봉은
D−1**이다. 1d sample_size(예 273)는 고정 창이 아니라 *가용 봉 전체* — 3년 창에 상장 기간이
짧은 종목이 걸리면 그만큼 짧아진다(0080G0 = 2025-07-15 상장 → 273봉).

**검증 (2026-08-27)**

① 오늘 밴드 대조 — `entry_date = 오늘`로 재계산한 값 vs 엔진 `/pairs/detail` 1d
(`hedge_ratio`·`alpha`·`daily_scale`·`z`). 게이트 1% 대비 **오차 1e-6% 이하 = 사실상 비트 일치**:

| 페어 | n | α | β | σ | z |
|---|---|---|---|---|---|
| E:0080G0 ↔ S:012450 | 273 | 1.8e-12% | 2.0e-11% | 6.0e-12% | 2.7e-08% |
| S:000660 ↔ S:402340 | 728 | 8.2e-10% | 7.8e-08% | 9.4e-10% | 2.1e-05% |
| E:495050 ↔ E:495850 | 441 | 5.8e-07% | 1.7e-07% | 7.5e-07% | 5.7e-06% |

(오차가 남는 건 엔진 응답 JSON의 유효자릿수 때문. 같은 창·같은 표본 수.)

② 실기록 대조 — 실제 "방산 페어"(2026-08-13 15:51 진입, 저장 밴드 없음)의 진입 스냅샷을
재계산이 **소수점 끝자리까지 복원**했다. 이게 창 규약(당일 미포함)의 실증이다:

| | 기록에 저장된 값 | refit(2026-08-13) |
|---|---|---|
| α₀ | −108,100.82340007438 | −108,100.82340007438 |
| β₀ | 103.50002061701774 | 103.50002061701774 |
| r² / ADF / half-life | 0.9464263761620132 / −5.286099228209428 / 3.638122238175277 | 전부 동일 |
| σ₀ | 45,635.311605868264 (진입 z 역산, §24.4) | 45,635.311605868344 (**0.000%**) |
| entry_z @ 저장 진입가(11,600 / 1,185,000) | 2.02695195864016 | 2.02695195864016 |

창은 2025-07-15 ~ **2026-08-12** 264봉 (진입일 당일 제외). 사용자 실제 체결 평단
(11,354 / 1,181,985)으로는 **진입 z +2.5188** — 기록의 메모 "진입 z +2.52"와 일치한다
(사용자 화면 방향으론 −2.52. §24.6의 ±2.9는 σ₀=38,172를 가정한 T2 테스트 케이스 숫자).

**한계** — 엔진의 실제 창 시작은 *프로세스 기동일* − 1095일이라, 엔진이 며칠째 떠 있었으면
창 시작이 그만큼 앞선다. 3년 창의 끝 며칠 차이라 β·σ 영향은 미미하지만 완전 항등은 아니다
(위 실측은 기동 당일 진입이라 정확히 일치). 상장 3년 미만 종목은 창이 데이터에 잘려 무관.
선물(`F:`/`SF:`/`IF:`)은 만기 롤 때문에 과거 밴드 재현이 정의되지 않아 422.
가드: 공통 봉 < 60이거나 교집합이 짧은 쪽의 60% 미만(거래정지·결측)이면 422.

**저장** — `PUT /api/positions/:id` 에 `entry_band`(= 추정 응답, `sigma`→`scale`)를 실으면
entry_stats를 갈아끼우고 진입 z도 그 자로 다시 잰다 (`entry_z_update.mode = refit`).
`source:'refit'`·`asof`·`window_bars`가 같이 남아 어느 날짜·몇 봉으로 뜬 밴드인지 추적된다.
사용자 입력 entry_z보다 우선한다 — 밴드가 자고 z는 종속변수이므로.

**화면** (`position-edit-modal.tsx`) — 밴드가 없거나 **진입일을 바꾸면** 자동 추정
(debounce 400ms, 이전 요청 abort, 날짜가 어긋난 추정치는 폐기):

- `진입 z −1.23 → +2.52` + `2026-08-12 종가까지 264봉 재계산 (진입일 당일 미포함) · β=103.5 · σ₀=45,635원`
- 밴드 미저장 기록은 **직접 입력 필드가 override로 남는다** — 손대면 추정 밴드를 저장하지 않고
  (밴드를 두고 z만 다르면 §24.2 항등이 깨진다) 종전대로 σ₀ 역산 경로로 간다.
- 밴드가 있고 날짜도 그대로면 재계산하지 않는다 (기존 스냅샷 존중, §24.7 경로).
- **등록 모달은 그대로** — 실시간 진입은 그 순간 엔진 스냅샷이 정답이다.

밴드 출처 마커는 `lib/stat-arb/frozen-z.ts` 1벌(`BAND_SOURCE_MARK`/`BAND_SOURCE_NOTE`):
저장=마커 없음 / **재계산**(refit) / **역산**(reconstructed). 목록 고정 z 셀·상세 KPI·통계표
σ 행이 같은 문구를 쓴다.
