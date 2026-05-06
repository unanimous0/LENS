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

## 새 기능 추가 방법

1. `frontend/src/pages/새기능.tsx` 파일 생성 (export function 새기능Page)
2. `frontend/src/App.tsx`의 Routes에 `<Route path="/새기능" element={<새기능Page />} />` 추가
3. `frontend/src/components/layout/top-nav.tsx`의 `tabs` 배열에 항목 추가
4. 필요시 `backend/routers/새기능.py` 라우터 생성 후 `main.py`에 등록
