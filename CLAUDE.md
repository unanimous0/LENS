# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 프로젝트 개요

**LENS** — 증권사 ETF LP/MM 트레이딩 데스크용 내부 웹 도구. 실시간 시장 데이터, 전략 백테스팅, 시그널 포착, 수급 분석, 주식 대차, 포지션 관리 등의 기능을 제공한다. 상사에게도 배포 예정이라 깔끔하고 사용자 친화적이어야 한다.

## 기술 스택

| 구분 | 기술 |
|------|------|
| 프론트엔드 | Vite + React 19 + TypeScript + Tailwind CSS v4 |
| 상태관리 | Zustand |
| 백엔드 | FastAPI (Python) |
| 실시간 데이터 | WebSocket (FastAPI ↔ React) |
| DB | PostgreSQL (asyncpg) + Redis |
| 배포 | Docker Compose |

## 상세 문서

기능 상세, 프로젝트 구조 등은 별도 문서 참조:
- **[features.md](features.md)** — 구현된 기능 상세 (대여가능확인, 상환가능확인, 실시간 시세, 데이터 어댑터)
- **[architecture.md](architecture.md)** — 프로젝트 구조, 데이터 소스 전략, 새 기능 추가 방법
- **[ls-api.md](ls-api.md)** — LS증권 OpenAPI 연동 가이드 (실시간 시세, 선물 베이시스)
- **[internal-deploy.md](internal-deploy.md)** — 내부망 배포 가이드 (오프라인 Windows 설치)
- **[realtime-service.md](realtime-service.md)** — Rust 실시간 데이터 서비스 아키텍처 (모든 실시간 화면의 공통 인프라)
- **[stock-arbitrage.md](stock-arbitrage.md)** — 종목차익 기능 설계 (베이시스 모니터링 + ETF 차익 계산)
- **[etf-arbitrage.md](etf-arbitrage.md)** — ETF 차익 기능 설계 + **실시간 페이지 reference 구현**의 성능 최적화 다층 방어 표

## 디자인 가이드

### 폰트

- 본문: **Inter** (영문/숫자) + **Pretendard** (한국어 폴백) — OKX 스타일. `--font-pretendard` 변수에 Inter가 첫 번째로 지정됨
- 숫자: **Inter tabular-nums** (`font-mono` 또는 `tabular-nums` 클래스) — 고정폭 숫자로 컬럼 정렬

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
| `text-blue` | 강조 | `#0a84ff` |

### 레이아웃 원칙

- **상단 탭 네비게이션** — 사이드바 사용 금지. 트레이딩 터미널처럼 가로 탭.
- **패널 간 구분**: border가 아닌 **배경색 차이** + `gap-1`로 영역 분리. 바닥색 `bg-bg-base`(#000000)에 패널 `.panel`(#111111)을 올려 각 영역이 독립 블록으로 보이게 함 (바이낸스/Apple Stocks 스타일).
- **패널 분리 기준**: 기능적으로 다른 영역(카드, 테이블)만 독립 패널로 분리. 조작 요소(파일선택, 필터, 엑셀저장)는 하나의 패널로 통합하여 번잡함 방지.
- **테이블 헤더 sticky**: 페이지 스크롤 시 테이블 `thead`가 `sticky top-0`으로 상단에 고정. 테이블이 자체 `overflow-y-auto` 스크롤을 갖지 않고 `<main>`이 유일한 스크롤 컨테이너.
- **고밀도 정보 레이아웃** — 바이낸스/블룸버그처럼 기능적이고 직선적
- **숫자 데이터**: Inter tabular-nums (`font-mono` 또는 `tabular-nums` 클래스)
- **둥근 모서리 최소화** — `rounded` 또는 `rounded-sm` 정도만

### 하지 말 것

- AI 느낌 나는 뻔한 디자인 (사이드바, 큰 둥근 카드, 보라색 그라데이션)
- 정보 밀도 낮은 여백 과다 레이아웃

## 작업 규칙

- 코드의 로직, 타입, 인터페이스, 변수, 함수 시그니처 등 동작에 영향을 주는 변경을 한 후에는 반드시 별도 에이전트를 생성하여 변경의 영향 범위를 검증할 것. 그리고 단순 문자열 검색뿐 아니라, 호출 체인·데이터 흐름·의존 관계를 따라가며 정합성이 깨지는 곳이 없는지 확인할 것. 단, 단순 문자열/라벨/주석 수정은 제외.
- 프로젝트 전반에 걸쳐 **최적화와 속도를 중시**할 것. 불필요한 반복 순회, DataFrame concat 반복, 중복 연산 등을 피하고 효율적인 자료구조와 알고리즘을 선택한다.
- 대량 데이터 처리 시 pandas 외에 더 적합한 도구(polars, numpy, 순수 Python 등)가 있다면 적극 검토한다. 단, 소규모 데이터에서 체감 차이 없이 의존성만 늘리는 도입은 지양.

### 실시간 페이지 작성/수정 규칙 (필수)

실시간 tick을 받는 페이지는 패턴 미준수 시 **페이지 멈춤·브라우저 hang**이 즉시 발생한다 (750종목 LS API 부하에서 이미 발생, 내부망 7000+ 종목·5+ 사용자 환경에선 더 심함).

**먼저 [architecture.md](architecture.md)의 "실시간 데이터 화면 — 필수 패턴" 섹션을 읽을 것.** reference 구현은 `frontend/src/pages/etf-arbitrage.tsx` — 새 실시간 페이지는 이 파일 패턴을 복사·변형. 이미 적용된 다층 방어 11종은 [etf-arbitrage.md](etf-arbitrage.md)의 "성능 최적화" 표 참조.

**신규 실시간 페이지 체크리스트**:
- [ ] hot-path store 필드 (`stockTicks` / `etfTicks` / `futuresTicks` / `orderbookTicks`) 를 `useMarketStore((s) => s.X)` 로 직접 구독하지 않는다 — 200ms `setInterval` snapshot 폴링 패턴 사용
- [ ] 100행 이상 테이블은 `@tanstack/react-virtual` + `<colgroup>` + spacer rows 가상화 (참고: `etf-arbitrage.tsx`, `dividends.tsx`)
- [ ] derived metric은 ref-stable 캐시 패턴 (shallow-equal로 이전 ref 재사용 → 행 단위 reconcile 비용 0)
- [ ] 행/셀 컴포넌트 `React.memo` + 콜백 `useCallback`
- [ ] 페이지 mount/unmount 시 `usePageStockSubscriptions` 등 page subscription 훅으로 구독 라이프사이클 관리 — Rust 측 ref-count로 다중 페이지 공유 안전
- [ ] 새 tick 타입 추가 시: `marketStore.ts` shape + `useWebSocket.ts` dispatch + `types/market.ts` 세 곳 동시 등록 (한 곳 누락 시 침묵 드롭)

서버 측 batch envelope (150~200ms coalesce)는 `useWebSocket`이 자동 unpack — 새 페이지에서 추가 작업 불필요.

**비-실시간 페이지** (대차/상환/배당 등 정적 데이터): 위 규칙 비적용. 일반 React 패턴.

## 코드 컨벤션

- 프론트엔드 import alias: `@/*` → `frontend/src/*` (예: `@/lib/utils`, `@/stores/marketStore`)
- 백엔드 API 라우터: 모든 라우터는 `/api` prefix로 `main.py`에 등록 (WebSocket은 `/ws` prefix)
- 유틸리티: `cn()` — clsx + tailwind-merge 조합 (`@/lib/utils`)
- 상태관리: Zustand store (`@/stores/marketStore`) — 실시간 데이터, 네트워크 모드
- 실시간 데이터: `useWebSocket()` 훅이 App 레벨에서 한 번만 연결

## 개발 환경

- 프론트엔드: **3100** / 백엔드: **8100** / Vite 프록시: `/api` → `localhost:8100`, `/ws` → `ws://localhost:8100`
- Node.js v20 (nvm 사용)

```bash
./start_dev.sh                              # 전체 서버 실행
cd frontend && npx vite                     # 프론트 개발 서버
cd frontend && npx tsc --noEmit             # 타입 체크
cd backend && uvicorn main:app --host 0.0.0.0 --port 8100 --reload  # 백엔드
```

**참고:** 테스트 프레임워크 미설정 (프론트: Vitest 없음, 백엔드: pytest 없음)
