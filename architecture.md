# 프로젝트 구조 & 아키텍처

## 디렉토리 구조

```
LENS/
├── frontend/                              # Vite + React
│   ├── vite.config.ts                     # Vite 설정 (프록시, 경로 별칭)
│   ├── index.html                         # 엔트리 HTML (Inter + Pretendard)
│   ├── src/
│   │   ├── main.tsx                       # React 엔트리
│   │   ├── App.tsx                        # BrowserRouter + Routes + WebSocket 초기화
│   │   ├── globals.css                    # 테마 (CSS 변수, Tailwind @theme)
│   │   ├── lib/utils.ts                   # cn() 유틸리티
│   │   ├── types/market.ts                # ETFTick, FuturesTick 등 공통 타입
│   │   ├── stores/marketStore.ts          # Zustand (시세, 네트워크 상태)
│   │   ├── hooks/useWebSocket.ts          # WebSocket 연결 + 자동 재연결
│   │   ├── components/
│   │   │   └── layout/
│   │   │       ├── top-nav.tsx            # 상단 탭 네비게이션
│   │   │       └── network-toggle.tsx     # 내부망/외부망/Mock 전환
│   │   └── pages/
│   │       ├── dashboard.tsx              # 메인 대시보드 (샘플 데이터)
│   │       ├── market.tsx                 # 실시간 시세 (WebSocket 연동)
│   │       ├── lending.tsx                # 대차 페이지 (서브탭 컨테이너)
│   │       ├── borrowing.tsx              # 차입 (비용 분석 + Rollover)
│   │       ├── lending-availability.tsx   # 대여가능확인
│   │       └── repayment-check.tsx        # 상환가능확인
│
├── backend/                               # FastAPI
│   ├── main.py                            # 앱 엔트리 (lifespan, CORS, 라우터)
│   ├── core/
│   │   ├── config.py                      # 환경 설정 (pydantic-settings)
│   │   ├── database.py                    # PostgreSQL async 연결
│   │   ├── app_state.py                   # AppState (어댑터 관리, 스트리밍)
│   │   └── data/
│   │       ├── adapter.py                 # MarketDataAdapter ABC + NetworkMode
│   │       └── mock_adapter.py            # Mock 시세 생성기
│   ├── routers/
│   │   ├── borrowing.py                   # POST /api/borrowing/analyze
│   │   ├── health.py                      # GET /api/health
│   │   ├── lending.py                     # POST /api/lending/calculate
│   │   ├── repayment.py                   # POST /api/repayment/calculate, /api/repayment/lenders
│   │   ├── market.py                      # GET/POST /api/network/mode, /api/etf/list, /api/basis
│   │   └── ws.py                          # WebSocket /ws/market
│   ├── models/
│   │   ├── market.py                      # ETFTick, FuturesTick, BasisData
│   │   └── portfolio.py                   # Position, PortfolioGreeks, ScenarioPnL
│   ├── schemas/
│   │   ├── lending.py                     # LendingResponse, StockResult, FundBreakdown
│   │   └── repayment.py                   # RepaymentResponse, RepaymentMatch, StockSummary
│   └── services/
│       ├── file_resolver.py               # 폴더 내 파일 자동 탐색 (패턴 매칭, NFC/NFD 정규화)
│       ├── excel_reader.py                # 엑셀 읽기 (openpyxl → xlrd → xlwings fallback)
│       ├── stock_code.py                  # 종목코드 정규화 (6자리/A접두/ISIN → 표준 6자리)
│       ├── borrowing_calculator.py        # 차입 비용 분석 + Rollover 관리
│       ├── lending_parser.py              # 대여가능 개별 파일 파싱 (5개 파일)
│       ├── lending_calculator.py          # 대여가능 산출 로직
│       ├── repayment_parser.py            # 상환가능 엑셀 파싱 (오피스 + 예탁원)
│       └── repayment_calculator.py        # 상환가능 매칭 로직 + 필터
│
├── features.md                            # 구현된 기능 상세
├── architecture.md                        # 프로젝트 구조, 아키텍처
├── data/                                  # 엑셀 데이터 파일
├── start_dev.sh                           # 개발 서버 실행 스크립트
├── docker-compose.yml
└── .env
```

## 데이터 소스 전략

외부망(집 서버)과 내부망(회사 서버) 두 환경에서 동일 앱을 사용하되 데이터 출처만 다름:

| 환경 | 데이터 출처 |
|------|------------|
| 외부망 | HTS API, 주식 프로그램 API, 자체 PostgreSQL DB |
| 내부망 | 한국거래소 데이터를 수신하는 회사 서버 |

- `MarketDataAdapter` ABC 인터페이스로 추상화
- 프론트엔드 NetworkToggle로 런타임 전환 (내부망/외부망/Mock)
- 기존 다른 프로젝트의 PostgreSQL DB를 연결해서 사용 가능

### 시계열 데이터 (백테스팅용) — Finance_Data 프로젝트와 분담

LENS는 실시간 트레이딩 데스크 도구. 과거 시계열 데이터(일봉/분봉)는 **별도 프로젝트 `Finance_Data` (`/home/una0/projects/Finance_Data`)에서 중앙 관리**, LENS는 read-only로 조회.

| 데이터 | 위치 | 출처 | 갱신 |
|---|---|---|---|
| 일봉 OHLCV (`ohlcv_daily`) | Finance_Data PostgreSQL+TimescaleDB | 인포맥스 API | 매일 16:30 KST daily_update |
| 분봉 OHLCV (`ohlcv_intraday`) | 동일 DB hypertable | **LS API t8452** | 매일 05:30 KST daily_update STEP 5 |
| 종목 마스터 (`stocks`) | 동일 | 인포맥스 | 매일 |
| 지수 구성 종목 (`index_components` SCD2) | 동일 | KODEX 200/코스닥150 PDF | 매일 |
| ETF PDF (`etf_portfolios` SCD2) | 동일 | 인포맥스 `/api/etf/port` | 매일 |
| 배당 (`dividends`) | 동일 | DART | 매일 |

**LENS read-only 계정**: `korea_stock_reader` (Finance_Data가 발급).

**분봉 수집 정책 (Phase 6 진행 중, 2026-05 기준)**:
- LS API **t8452 (통합 주식챠트 N분)** 사용 — 같은 그룹의 구 t8412는 백필 깊이가 약 10거래일로 차단되어 백필 불가. **t8452는 백필 시작일 2026-01-02까지 정상 응답** (실측 확인). InBlock에 `exchgubun: "K"` (KRX) 명시. 페이지네이션 시 `tr_cont: Y` 헤더 + `cts_date`/`cts_time` 필수
- **봉 단위 혼합 운영**: `ncnt`로 분기
  - `ncnt=1` (1분봉): 2026-01-02 ~ **2026-04-26**
  - `ncnt=0` (30초봉): **2026-04-27 이후** (실측 확정 시작점)
  - 30초봉은 LS 서버가 ~10거래일치만 응답하는 한도가 있어 과거 백필 불가. 향후 일배치 누적으로만 30초봉 확보
- 30초봉이 1분봉의 상위 데이터 (30초봉 2개 = 1분봉 합성 가능). 가용 구간은 30초봉으로 받는 게 정보 손실 없음
- 종목 스코프: KOSPI200 + KOSDAQ150 + 한국 ETF 636 (해외 키워드 제외) + ETF PDF stocks union ≈ 2,500~2,700종목
- ETF 해외 제외 키워드: `미국 / 나스닥 / S&P / 차이나 / 항셍 / WTI / (H) 헤지 표기 / 글로벌` 등 (정확한 룰은 `Finance_Data` 측 SQL)
- 봉당 거래량 = `jdiff_vol`(t8452의 봉 단위 거래량) → DB의 `volume` 컬럼에 저장
- 거래대금 = LS의 `value` 필드 (백만원 단위) × 1_000_000 → `trading_value` (NOT NULL)
- 15:30 종가 단일가는 분봉 차트에 없음 (15:29 또는 15:29:30 봉이 마지막). 백테스트 시 종가는 **`ohlcv_daily.close` 사용** (SSoT 분리 — 분봉은 분 단위 흐름, 종가/시가는 일봉 책임)
- 백필 시작일: 2026-01-02. 단일 워커 약 33시간 (혼합안 기준)
- 일배치 운영 시간: 새벽 05:30 KST (LENS realtime의 LS API 활동과 시간대 분리), t8452 ncnt=0으로 어제분 30초봉 적재
- LS 계정은 LENS realtime과 공유 (시간대 분리로 충돌 회피)

**`ohlcv_intraday` 스키마**:
- PK: `(stock_code, time, exchange, interval_seconds)`
- `exchange CHAR(1)` — `K`=KRX (현재 운영), `N`=NXT (미래 확장용 컬럼만 준비)
- `interval_seconds SMALLINT` — `60` 또는 `30`. row마다 봉 단위 명시
- 백테스트 측에서 `WHERE interval_seconds=30 OR (interval_seconds=60 AND time<'2026-04-27')` 같은 분기로 자유 사용. 또는 30초봉을 1분봉으로 합성해 통일 사용도 가능

**Phase 7 (선물 분봉) — 별도**:
- 주식선물 front+back 500 + 지수선물 front+back ~10
- LS API **t8465** (선물/옵션차트 N분, 신 TR — 구 t8415는 LS 공식 공지로 2026-05-28 이후 데이터 제공 중단). 호출 패턴은 `docs/ls_api_guide/ls_api_full.md`의 `[선물/옵션] 차트` 섹션 참조 (PDF 별도 X)
- Phase 6 안정화 후 진행

## 새 기능 추가 방법

1. `frontend/src/pages/새기능.tsx` 파일 생성 (export function 새기능Page)
2. `frontend/src/App.tsx`의 Routes에 `<Route path="/새기능" element={<새기능Page />} />` 추가
3. `frontend/src/components/layout/top-nav.tsx`의 `tabs` 배열에 항목 추가
4. 필요시 `backend/routers/새기능.py` 라우터 생성 후 `main.py`에 등록
