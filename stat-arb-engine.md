# 통계 차익거래 엔진 + 화면 (stat-arb)

> ETF LP 입장에서 **통계적 차익거래**를 주 목적으로 하되, **대여 수익**과 **주식선물 매도차익**을 결합 활용. 발굴 → 진입 → 추적 → 청산까지의 사이클 전체를 다룬다.

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
    entry_stats_json TEXT,      -- 진입 시점 통계량 freeze
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

### stat-arb-engine (port 8300)
```
GET  /pairs?group=<id>&timeframe=auto&source=&min_score=
GET  /pairs/:hash/detail               z 시계열 + 히스토그램 + 3 timeframe 통계
POST /pairs/validate                   수동 조립 페어 즉시 검증
POST /positions/:id/snapshot           포지션 현재 통계량 계산 (backend가 호출)
GET  /scatter?status=active            활성 포지션 산점도 데이터
GET  /groups                           도메인 그룹 리스트
POST /groups                           사용자 정의 그룹 생성
GET  /health
GET  /debug/stats
```

### backend FastAPI (port 8100)
```
GET    /api/loan-rates                 종목별 대여요율 리스트
PUT    /api/loan-rates/:code           수동 입력
POST   /api/loan-rates/csv-import      CSV 일괄 업로드

GET    /api/positions                  리스트 (status 필터)
POST   /api/positions                  등록
GET    /api/positions/:id              상세 (현재 통계량 stat-arb-engine 위임)
POST   /api/positions/:id/close        청산 기록
GET    /api/positions/:id/timeline     스냅샷 시계열
DELETE /api/positions/:id

GET    /api/saved-pairs                즐겨찾기 리스트
POST   /api/saved-pairs                등록

GET    /api/groups                     stat-arb-engine 위임
POST   /api/groups                     사용자 정의 그룹
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
- 테이블 컬럼: 페어 / 진입일 / 보유 / 진입 z / 현재 z / 회귀 % / 평가손익 / 대여수익 / 종합 PnL / 상태 뱃지
- **활성 포지션 z 산점도**: x=진입 z, y=현재 z, 대각선 = 회귀 0% — 한눈에 시급 포지션 파악

### 9.4 `/stat-arb/positions/:id` 상세
- **상단 헤더**: 페어 요약 / 상태 / 종합 PnL / 진입 vs 현재 z / 예상 청산 도달일
- **차트** (가장 중요):
  - Spread 시계열 (진입 마킹 + 현재 마커)
  - z-score 시계열 (±1, ±2 밴드, 청산 트리거)
  - **과거 z 분포 히스토그램 + 진입/현재 마킹**
  - 누적 PnL 스택 곡선 (통계차익 / 대여 / 매도차)
- **Leg 테이블**: 종목 / 비중 / 진입가 / 현재가 / 변동 % / leg PnL
- **통계량 변화**: 진입 시점 vs 현재 (cointegration p, half-life, R², hedge ratio drift)
- **시그널 패널**: 회귀 %, 보유일/half-life 비교, 예상 청산일, 경고 (drift 등)
- **액션**: 청산 기록 / 메모 추가

### 자동 상태 분류
- **수렴**: `|현재 z| < |진입 z| × 0.5`
- **발산**: `|현재 z| > |진입 z| × 1.1`
- **stale**: `보유일 > half-life × 2 && 회귀 < 50%`
- **청산권장**: `|현재 z| < 0.3`

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
  - **다음 단계** (트랙 A 마무리 + 트랙 B):
    - **PR-D Johansen test** — M:N 잔차 cointegration 정식 검증. 현재 OLS+ADF 단순화.
      ndarray-linalg 또는 자체 구현 (Johansen은 eigendecomposition 무거움). 가짜 양성 강하게 거르기
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
| `bars_1d` | 1년치 | PG 일봉 raw | 변화 없음 |

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
- *중기/장기 분석*은 **일봉이 담당** — 1/2~ 1년치 연속 시계열 가용. cointegration 검정/페어 발굴은 일봉이 baseline.
- *분 단위*는 **단기 entry/exit 시그널** 용도가 본질. 시기별 단편이라도 그 시점의 페어 안정성/회귀 파악엔 충분.
- 통계량 (β, half-life, R², ADF, z) 은 각각의 raw 시계열로 *개별 계산*. 비교는 *질적*으로만 (수치 직접 비교 X).

### 12.4 분석 단위별 활용 매트릭스

| Timeframe | 데이터 소스 | 활용 |
|---|---|---|
| 30초 | `bars_30s` (raw 4/27~) | 초단기 entry/exit, 일중 mean reversion 시그널 |
| 1분 | `bars_1m` (raw 1/2~4/24) | 과거 시점 1분 페어 관계 검증 (참고용) |
| 5분/30분/1시간 | 동적 집계 (PR9 예정) | 단기 페어 (며칠 보유). raw 보관 X. |
| 일 | `bars_1d` (1년치 raw) | 중기 페어 (수주~수개월) — *메인 발굴 기준* |
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
- **헤드라인·차트 = 10분 버킷**, 비교표 = 1분/5분/10분/30분/1시간 (일/주/월 제거).
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
