# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 프로젝트 개요

**LENS** — 증권사 ETF LP/MM 트레이딩 데스크용 내부 웹 도구. 실시간 시장 데이터, 전략 백테스팅, 시그널 포착, 수급 분석, 주식 대차, 포지션 관리 등의 기능을 제공한다. 상사에게도 배포 예정이라 깔끔하고 사용자 친화적이어야 한다.

## 기술 스택

| 구분 | 기술 |
|------|------|
| 프론트엔드 | Vite + React 19 + TypeScript + Tailwind CSS v4 |
| 상태관리 | Zustand |
| 라우팅 | React Router DOM |
| 백엔드 | FastAPI (Python) |
| 실시간 데이터 | WebSocket (FastAPI ↔ React) |
| DB | PostgreSQL (asyncpg) + Redis |
| 배포 | Docker Compose |
| Node.js | v20 (nvm 사용) |

## 프로젝트 구조

```
LENS/
├── frontend/                              # Vite + React
│   ├── vite.config.ts                     # Vite 설정 (프록시, 경로 별칭)
│   ├── index.html                         # 엔트리 HTML (Google Fonts)
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
│   │       └── lending.tsx                # 대차 대여가능 산출 (구현 완료)
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
│   │   ├── health.py                      # GET /api/health
│   │   ├── lending.py                     # POST /api/lending/calculate
│   │   ├── market.py                      # GET/POST /api/network/mode, /api/etf/list, /api/basis
│   │   └── ws.py                          # WebSocket /ws/market
│   ├── models/
│   │   ├── market.py                      # ETFTick, FuturesTick, BasisData
│   │   └── portfolio.py                   # Position, PortfolioGreeks, ScenarioPnL
│   ├── schemas/
│   │   └── lending.py                     # LendingResponse, StockResult, FundBreakdown
│   └── services/
│       ├── lending_parser.py              # 엑셀 파싱 (5개 시트)
│       └── lending_calculator.py          # 대여가능 산출 로직
│
├── data/                                  # 엑셀 데이터 파일
├── start_dev.sh                           # 개발 서버 실행 스크립트
├── docker-compose.yml
└── .env
```

## 구현된 기능

### 대차 대여가능 산출 (`/lending`)

엑셀 파일 업로드 → 자동 필터링 → 종목별 대여 가능 수량 + 펀드별 상세 내역 + 엑셀 저장

**필수 시트 (시트 이름 정확히 일치해야 함):**

| 시트명 | 내용 |
|--------|------|
| 문의종목 | 종목코드, 종목명, 최대수량, 요율 |
| 원장RAW | 펀드코드, 펀드명, 계정코드, 종목번호, 종목명, 잔고, 담보, 담보가능수량 등 (A~N열) |
| MM펀드 | 제외할 MM펀드 코드 목록 |
| 대여불가펀드 | 대여불가 펀드코드 뒤 3자리 목록 |
| 상환예정내역 | D열: ISIN코드, J열: 대차수량 |

**처리 로직:**
1. 문의종목 기준으로 원장RAW 매칭
2. MM펀드(펀드코드 일치) 제외
3. 대여불가펀드(펀드코드 뒤3자리 일치) 제외
4. 상환예정 수량 차감 (1순위: 계정코드 052, 2순위: 큰 수량, 3순위: 분산 차감)
5. 합산 수량 0인 펀드 제외
6. 결과: 종목별 담보가능수량 / 담보 / 합산 / 대여 + 펀드별 상세

**종목코드 정규화:**
- 문의종목: `011790` (6자리 기준)
- 원장RAW: `A011790` → A 제거
- 상환예정: `KR7011790004` → [3:9] 추출

### 실시간 시세 (`/market`)

WebSocket 기반 실시간 ETF/선물 데이터 스트리밍.
- ETF 괴리 히트맵 (bp 기준 색상)
- ETF 실시간 현황 테이블 (현재가, NAV, 괴리, 거래량)
- 선물 베이시스 테이블 (선물가, 현물가, 베이시스)
- 네트워크 모드 전환: 내부망/외부망/Mock (런타임 전환, 재시작 불필요)

### 데이터 어댑터 패턴

`MarketDataAdapter` ABC로 데이터 소스 추상화:
- `MockAdapter`: 개발용 랜덤 시세 (8 ETF + 3 선물, 1초 간격)
- `InternalAdapter`: 내부망 (미구현)
- `ExternalAdapter`: 외부망 (미구현)

프론트엔드 토글 → `POST /api/network/mode/{mode}` → 어댑터 교체 → 스트리밍 재시작

## 디자인 가이드

### 폰트

- 본문: **Plus Jakarta Sans** (`--font-jakarta`) — Inter, Roboto 등 범용 폰트 사용 금지
- 숫자/코드: **JetBrains Mono** (`--font-jetbrains`, `font-mono` 클래스)

### 컬러 시스템 (Apple Stocks + 트레이딩 터미널)

CSS 변수는 `globals.css`의 `@theme inline`에 정의. Tailwind 클래스로 직접 사용 가능.

| Tailwind 클래스 | 용도 | 색상 |
|------|------|------|
| `bg-bg-base` | 배경 (최하단) | `#000000` |
| `bg-bg-primary` | 배경 (기본) | `#111111` |
| `bg-bg-surface` | 패널 내부 | `#1c1c1e` |
| `text-t1` | 텍스트 (기본) | `#ffffff` |
| `text-t2` | 텍스트 (보조) | `#d1d1d6` |
| `text-t3` | 텍스트 (약한) | `#8e8e93` |
| `text-t4` | 텍스트 (비활성) | `#636366` |
| `text-accent` / `bg-accent` | 액센트 (초록) | `#34c759` |
| `text-up` | 상승 | `#34c759` (초록) |
| `text-down` | 하락 | `#ff3b30` (빨강) |
| `text-warning` | 경고/담보 | `#ff9f0a` (오렌지) |
| `text-blue` | 강조 (요율 5%+) | `#0a84ff` |

### 레이아웃 원칙

- **상단 탭 네비게이션** — 사이드바 사용 금지. 트레이딩 터미널처럼 가로 탭.
- **패널 간 구분**: border가 아닌 **배경색 차이** + `gap-px`로 영역 분리
- **고밀도 정보 레이아웃** — 바이낸스/블룸버그처럼 기능적이고 직선적
- **차트**: SVG 라인 + 초록 → 투명 그라데이션 fill (Apple Stocks 스타일)
- **숫자 데이터**: 모노스페이스 폰트 (`font-mono` 클래스)
- **둥근 모서리 최소화** — `rounded` 또는 `rounded-sm` 정도만

### 하지 말 것

- AI 느낌 나는 뻔한 디자인 (사이드바, 큰 둥근 카드, 보라색 그라데이션)
- 정보 밀도 낮은 여백 과다 레이아웃

## 작업 규칙

- 코드를 수정한 후에는 반드시 별도 에이전트를 생성하여 변경의 영향 범위를 검증할 것. 단순 문자열 검색뿐 아니라, 호출 체인·데이터 흐름·의존 관계를 따라가며 정합성이 깨지는 곳이 없는지 확인한다.

## 코드 컨벤션

- 프론트엔드 import alias: `@/*` → `frontend/src/*` (예: `@/lib/utils`, `@/stores/marketStore`)
- 백엔드 API 라우터: 모든 라우터는 `/api` prefix로 `main.py`에 등록 (WebSocket은 `/ws` prefix)
- 유틸리티: `cn()` — clsx + tailwind-merge 조합 (`@/lib/utils`)
- 상태관리: Zustand store (`@/stores/marketStore`) — 실시간 데이터, 네트워크 모드
- 실시간 데이터: `useWebSocket()` 훅이 App 레벨에서 한 번만 연결

## 새 기능 추가 방법

1. `frontend/src/pages/새기능.tsx` 파일 생성 (export function 새기능Page)
2. `frontend/src/App.tsx`의 Routes에 `<Route path="/새기능" element={<새기능Page />} />` 추가
3. `frontend/src/components/layout/top-nav.tsx`의 `tabs` 배열에 항목 추가
4. 필요시 `backend/routers/새기능.py` 라우터 생성 후 `main.py`에 등록

## 데이터 소스 전략

외부망(집 서버)과 내부망(회사 서버) 두 환경에서 동일 앱을 사용하되 데이터 출처만 다름:

| 환경 | 데이터 출처 |
|------|------------|
| 외부망 | HTS API, 주식 프로그램 API, 자체 PostgreSQL DB |
| 내부망 | 한국거래소 데이터를 수신하는 회사 서버 |

- `MarketDataAdapter` ABC 인터페이스로 추상화
- 프론트엔드 NetworkToggle로 런타임 전환 (내부망/외부망/Mock)
- 기존 다른 프로젝트의 PostgreSQL DB를 연결해서 사용 가능

## 개발 환경 (외부망)

### 서버 실행

```bash
./start_dev.sh
```

### 원격 접속 (회사 PC → 집 서버)

Tailscale VPN(`100.64.229.73`)으로 연결. WebSocket HMR을 위해 SSH 포트포워딩 사용:

```bash
ssh -L 3100:localhost:3100 -L 8100:localhost:8100 una0@100.64.229.73
# 브라우저에서 http://localhost:3100
```

### 포트 사용

- 프론트엔드: **3100** (3000은 다른 앱 사용 중)
- 백엔드: **8100** (8000은 다른 프로젝트 사용 중)
- Vite 프록시: `/api` → `http://localhost:8100`, `/ws` → `ws://localhost:8100`
- Docker Compose: 프론트 3000, 백엔드 8000

### 개발 명령어

```bash
# 전체 서버 실행 (프론트 3100 + 백엔드 8100)
./start_dev.sh

# 프론트엔드
cd frontend && npx vite                   # 개발 서버 (포트 3100)
cd frontend && npx vite build             # 프로덕션 빌드 (tsc -b 포함)
cd frontend && npx tsc --noEmit           # 타입 체크만
cd frontend && npx eslint .               # 린트
cd frontend && npx vite preview           # 빌드된 결과 미리보기

# 백엔드
cd backend && uvicorn main:app --host 0.0.0.0 --port 8100 --reload
cd backend && pip install -r requirements.txt  # 의존성 설치

# nvm으로 Node 20 활성화
nvm use --delete-prefix v20.20.2
```

**참고:** 테스트 프레임워크 미설정 (프론트: Vitest 없음, 백엔드: pytest 없음)
