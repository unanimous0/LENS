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

### 향후 후보 (스코프 외 — 우선순위 별도)
- ETF 실시간 구독 활성화 — 현재 realtime auto-subscribe는 273 stocks + 273 futures만. 통계차익 페어 70%가 ETF인데 ETF 페이지 미마운트 상태에선 etfTicks 비어 있음 → 페어 상세에서 ETF leg "—" 표시. realtime의 /subscribe 핸들러가 ETF 코드를 LS API S3_ 등에 어떻게 라우팅하는지 확인 후 결정 (장중 검증).
- **PnL 시뮬레이터 UX 개선** — 라벨/순서/설명 단순화. 데이터 없는 토요일에는 추측 디자인이라 평일 장중 보고 평가 후 정비.
- M:N 발굴 — Sparse CCA + Johansen + Sparse PCA cluster
- 발굴 자체에 다중 timeframe (현재는 일봉 + 상세만 다중)
- 수동 조립 모드 (`POST /pairs/validate`)
- realtime 스냅샷 동기화 (현재는 PG 분봉만)
- 매도차(베이시스) 레이어 — 선물 페어 발굴 추가 시 PnL 시뮬에 합산

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
