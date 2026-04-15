# Rust 실시간 데이터 서비스

LENS의 모든 실시간 화면을 위한 공통 데이터 파이프라인.
거래소/API로부터 시세를 수신하고, 정규화/계산 후 프론트엔드에 WebSocket으로 배포한다.

## 도입 배경

### 왜 Rust인가

- 종목차익(~2,300 주식선물), 실시간 시세, 호가창, 시그널, 포지션 모니터링 등 **수천 종목의 틱을 동시 처리**하는 화면이 계속 추가될 예정
- 매 틱마다 베이시스, 이론가, 괴리, 수익 시뮬레이션 등 **실시간 계산**이 필요
- Python asyncio의 GIL + 메모리 + latency 한계 → 종목/화면 수가 늘수록 병목
- Rust의 zero-cost abstraction, 네이티브 async, 메모리 안전성이 적합

### 기존 Python과의 역할 분리

| 영역 | 담당 | 비고 |
|------|------|------|
| 실시간 시세 수신/정규화 | **Rust** | 거래소, LS API, 사내 서버 |
| 실시간 계산 (베이시스, 시그널 등) | **Rust** | 매 틱마다 수행 |
| WebSocket 브로드캐스트 | **Rust** | 프론트엔드로 배포 |
| 파일 분석 (대차, 상환, PDF 등) | **Python (FastAPI)** | 배치성, 엑셀 파싱 |
| REST API (설정, 조회 등) | **Python (FastAPI)** | 기존 유지 |

핵심 원칙: **실시간 경로는 Rust, 배치/파일 분석은 Python.**

---

## 전체 아키텍처

```
[거래소 / LS증권 API / 사내 서버]
    │
    ▼
┌──────────────────────────────────────────┐
│  Rust 실시간 서비스 (port 8200)           │
│                                          │
│  ├─ Feed Handler (데이터 수신)            │
│  │   ├─ ExternalAdapter (LS증권 API)     │
│  │   ├─ InternalAdapter (사내 서버)       │
│  │   └─ MockAdapter (개발용)              │
│  │                                       │
│  ├─ Normalizer (정규화)                   │
│  │   └─ 각 소스별 raw 포맷 → 공통 Tick   │
│  │                                       │
│  ├─ Calculation Engine (실시간 계산)      │
│  │   ├─ 베이시스 계산 (종목차익)          │
│  │   ├─ ETF 괴리/NAV (시세 화면)         │
│  │   └─ [향후 추가되는 계산 모듈]         │
│  │                                       │
│  ├─ State Store (인메모리 상태)           │
│  │   └─ 종목별 최신 틱, 계산 결과 캐시   │
│  │                                       │
│  └─ WebSocket Server (클라이언트 배포)    │
│      ├─ 채널/토픽 기반 구독              │
│      └─ 클라이언트별 필터링              │
└──────────────────────────────────────────┘
    │                          │
    ▼                          ▼
┌──────────┐           ┌──────────────┐
│ Frontend │           │ FastAPI      │
│ (3100)   │           │ (8100)       │
│          │           │ 파일 분석 등  │
└──────────┘           └──────────────┘
```

---

## 포트 / 프록시 구성

| 서비스 | 포트 | 역할 |
|--------|------|------|
| Vite (프론트엔드) | 3100 | UI 개발 서버 |
| FastAPI (백엔드) | 8100 | 파일 분석, REST API |
| Rust (실시간) | 8200 | 시세 수신, 계산, WebSocket |

Vite 프록시 (vite.config.ts):
```
/api    → localhost:8100 (FastAPI)
/ws     → localhost:8200 (Rust)
```

기존 Python의 WebSocket 관련 코드(`ws.py`, `app_state.py`, `MarketDataAdapter`)는 Rust 전환 완료 후 제거.

---

## 어댑터 패턴

기존 Python `MarketDataAdapter` ABC와 동일한 개념을 Rust trait으로 구현.

```rust
#[async_trait]
pub trait MarketFeed: Send + Sync {
    /// 구독 시작. 수신된 틱을 channel로 전송.
    async fn subscribe(&self, symbols: Vec<String>, tx: Sender<RawTick>) -> Result<()>;
    /// 구독 해제.
    async fn unsubscribe(&self) -> Result<()>;
    /// 연결 상태 확인.
    fn is_connected(&self) -> bool;
}
```

### 어댑터 구현체

| 어댑터 | 환경 | 데이터 소스 |
|--------|------|-------------|
| `MockFeed` | 개발 | 모의 틱 생성 (rand, 설정 가능한 종목 수/주기) |
| `LsApiFeed` | 외부망 | LS증권 OpenAPI WebSocket (상세: [ls-api.md](ls-api.md)) |
| `InternalFeed` | 내부망 | 사내 거래소 데이터 수신 서버 (WebSocket) |

### 네트워크 모드 전환

프론트엔드 NetworkToggle → Rust 서비스로 모드 전환 요청:

```
POST http://localhost:8200/mode/{external|internal|mock}
```

현재 피드 구독 해제 → 새 어댑터로 재구독. 프론트엔드 WebSocket 연결은 유지.

---

## 데이터 모델

### 공통 틱 구조체

모든 어댑터의 raw 데이터를 정규화한 공통 형태:

```rust
pub struct Tick {
    pub market: Market,       // Stock, Future, ETF, Index, Option
    pub code: String,         // 종목코드
    pub price: f64,           // 현재가
    pub volume: u64,          // 거래량 (누적)
    pub timestamp: i64,       // 수신 시각 (epoch ms)
    pub extra: TickExtra,     // 시장별 추가 필드
}

pub enum TickExtra {
    Stock { change: f64, change_pct: f64 },
    Future { basis: f64, theoretical: f64, open_interest: u64, underlying: String },
    Etf { nav: f64, spread_bp: f64 },
    Index { change: f64 },
    None,
}
```

### 채널/토픽 구조

프론트엔드가 필요한 데이터만 구독:

```
/ws/market          — 전체 시세 스트림 (기존 호환)
/ws/basis           — 종목차익 베이시스 스트림
/ws/etf             — ETF NAV/괴리 스트림
/ws/{custom}        — 향후 추가 화면별 스트림
```

또는 단일 WebSocket 연결에서 메시지 타입으로 분기 (현재 Python 방식과 동일):

```json
{ "type": "stock_tick", "data": { ... } }
{ "type": "futures_tick", "data": { ... } }
{ "type": "basis_update", "data": { ... } }
```

→ 초기에는 메시지 타입 분기 방식으로 시작, 트래픽 증가 시 토픽 분리 검토.

---

## 데이터 소스 상세

### 외부망: LS증권 OpenAPI

WebSocket 실시간 구독 (전체 레퍼런스: [ls-api.md](ls-api.md)):

| 데이터 | TR코드 | WebSocket URL |
|--------|--------|---------------|
| 주식 체결 (KOSPI) | S3_ | `wss://.../websocket/stock` |
| 주식 체결 (KOSDAQ) | K3_ | `wss://.../websocket/stock` |
| 주식선물 체결 | JC0 | `wss://.../websocket/futureoption` |
| 주식선물 호가 | JH0 | `wss://.../websocket/futureoption` |
| KOSPI200 선물 체결 | FC0 | `wss://.../websocket/futureoption` |
| KOSPI200 선물 호가 | FH0 | `wss://.../websocket/futureoption` |
| ETF NAV | I5_ | `wss://.../websocket/stock` |
| 지수 | IJ_ | `wss://.../websocket/indtp` |

주의사항:
- 인증 토큰 매일 07:00 만료 → Rust 서비스에서 자동 재발급
- WebSocket 스트리밍은 TPS 제한 없음 (REST는 TR별 1~10 TPS)
- 시뮬레이션 서버: `wss://openapi.ls-sec.co.kr:29443`

### 내부망: 사내 거래소 데이터 수신 서버

- 접속: WebSocket
- 데이터: 거래소(KRX)에서 직접 수신하는 실시간 시세
- 별도 인증 체계 (사내 규격)
- 프로토콜 분석 후 `InternalFeed` 구현

---

## Rust 기술 스택

| 용도 | 라이브러리 |
|------|-----------|
| 비동기 런타임 | tokio |
| WebSocket 서버 + HTTP | axum |
| WebSocket 클라이언트 | tokio-tungstenite |
| JSON 직렬화 | serde + serde_json |
| HTTP 클라이언트 | reqwest |
| 설정 관리 | config 또는 toml |
| 로깅 | tracing + tracing-subscriber |
| 메트릭 (선택) | metrics + metrics-exporter-prometheus |

---

## 디렉토리 구조 (예상)

```
LENS/
├── frontend/          # 기존 Vite + React
├── backend/           # 기존 FastAPI (파일 분석)
├── realtime/          # Rust 실시간 서비스 (신규)
│   ├── Cargo.toml
│   ├── src/
│   │   ├── main.rs
│   │   ├── config.rs
│   │   ├── feed/
│   │   │   ├── mod.rs         # MarketFeed trait
│   │   │   ├── mock.rs        # MockFeed
│   │   │   ├── ls_api.rs      # LsApiFeed (외부망)
│   │   │   └── internal.rs    # InternalFeed (내부망)
│   │   ├── model/
│   │   │   ├── tick.rs        # Tick, TickExtra, Market
│   │   │   └── message.rs     # WebSocket 메시지 타입
│   │   ├── calc/
│   │   │   ├── mod.rs
│   │   │   ├── basis.rs       # 베이시스 계산
│   │   │   └── ...            # 향후 계산 모듈
│   │   ├── state.rs           # 인메모리 상태 (DashMap 등)
│   │   └── ws/
│   │       ├── server.rs      # axum WebSocket 핸들러
│   │       └── broadcast.rs   # 클라이언트 관리 + 브로드캐스트
│   └── tests/
├── docker-compose.yml  # frontend + backend + realtime
└── ...
```

---

## 구현 단계

### Phase 1: 뼈대 + MockFeed

- [ ] `realtime/` Cargo 프로젝트 생성
- [ ] tokio + axum 기본 서버 (port 8200)
- [ ] `MarketFeed` trait 정의
- [ ] `MockFeed` 구현 (설정 가능한 종목 수, 틱 주기)
- [ ] 공통 `Tick` 구조체 + serde 직렬화
- [ ] WebSocket 서버 (클라이언트 접속/해제/브로드캐스트)
- [ ] Vite 프록시 `/ws` → `localhost:8200`
- [ ] 프론트엔드 `useWebSocket` 훅 연동 확인

### Phase 2: LS증권 API 연동 (외부망)

- [ ] `LsApiFeed` 구현
- [ ] OAuth2 토큰 관리 (자동 재발급, 07:00 만료 대응)
- [ ] WebSocket 클라이언트 (tokio-tungstenite)
- [ ] TR별 구독/해제 메시지 처리
- [ ] raw 데이터 → `Tick` 정규화
- [ ] 네트워크 모드 전환 API (`POST /mode/{mode}`)

### Phase 3: 사내 서버 연동 (내부망)

- [ ] `InternalFeed` 구현
- [ ] 사내 WebSocket 프로토콜 분석
- [ ] 데이터 정규화 (거래소 포맷 → 공통 Tick)

### Phase 4+: 계산 모듈 확장

화면이 추가될 때마다 `calc/` 아래 모듈 추가:
- 종목차익 베이시스 계산 → `calc/basis.rs`
- ETF 괴리/NAV 계산 → `calc/etf.rs`
- 시그널 감지 → `calc/signal.rs`
- 포지션 PnL → `calc/position.rs`
- ...

---

## 참고: 월가 대형 LP/MM 아키텍처

대형사(Citadel Securities, Jane Street, Virtu 등)의 일반적 구조:

| 레이어 | 대형사 | LENS |
|--------|--------|------|
| 피드 핸들러 | C++/FPGA, kernel bypass | Rust, 표준 WebSocket |
| 내부 메시징 | Aeron, ZeroMQ, shared memory | tokio channel (인프로세스) |
| 계산 엔진 | C++/Rust, 마이크로초 단위 | Rust, 밀리초 단위 |
| 느린 분석 | Python/R | Python (FastAPI) |
| 프론트엔드 | Electron/OpenFin + React | Vite + React (웹) |

LENS는 동일한 원칙(실시간=저수준 언어, 분석=고수준 언어)을 규모에 맞게 적용한 구조.
