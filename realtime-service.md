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
│  ├─ Calculation Engine (실시간 계산)      │
│  │   ├─ 소스별 네이티브 타입으로 계산     │
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

**주의**: 기존 Python의 `POST /api/network/mode/{mode}` (market.py)와 `GET /api/basis/{code}` 등은 어댑터 상태에 의존한다. Rust 전환 시 이 엔드포인트들을 Rust로 옮기거나, Python이 Rust에 위임하도록 수정해야 한다. Phase 1에서는 Python WS 코드(`ws.py`, `app_state.py`, `adapter.py`)를 삭제하지 않고 보존하여, Vite 프록시 한 줄 원복만으로 즉시 롤백 가능하게 유지.

---

## 데이터 모델

### 소스별 네이티브 타입 (공통 Tick 모델 없음)

내부망과 외부망은 데이터 풍부도가 크게 다르고 (내부망: rNAV, LP잔량, 선물이론가 등), 한 환경에서 한 소스만 사용하므로 **공통 Tick 모델로 합치지 않는다**.

각 어댑터가 자체 타입으로 데이터를 처리하고, **프론트엔드로 브로드캐스트하는 시점에만** 프론트엔드 메시지 계약 포맷으로 변환한다.

```
내부망: raw JSON → InternalTick (서버 원본 그대로) → 계산 → 브로드캐스트 변환 → 프론트엔드
외부망: raw JSON → ExternalTick (LS API 원본 그대로) → 계산 → 브로드캐스트 변환 → 프론트엔드
Mock:   MockFeed가 직접 프론트엔드 포맷 생성 → 브로드캐스트 → 프론트엔드
```

이렇게 하면:
- 내부망의 풍부한 데이터(rNAV, LP잔량 등)를 계산 단계에서 그대로 활용 가능
- 외부망에서 직접 계산해야 하는 값(rNAV 등)도 외부망 타입 내에서 자연스럽게 처리
- 프론트엔드는 어느 소스든 동일한 메시지를 받음

### 프론트엔드 메시지 계약 (필수 준수)

기존 Python WebSocket이 보내는 포맷을 Rust가 **정확히** 재현해야 한다. 필드명, 타입, 구조가 하나라도 다르면 프론트엔드가 조용히 무시한다 (에러 없이 화면만 안 뜸).

**엔드포인트**: `/ws/market`
**프론트엔드 초기 메시지**: 연결 시 `"subscribe"` 문자열 전송 (hooks/useWebSocket.ts)

**ETF 틱**:
```json
{
  "type": "etf_tick",
  "data": {
    "code": "069500",
    "name": "KODEX 200",
    "price": 35420.0,
    "nav": 35415.0,
    "spread_bp": 1.41,
    "spread_bid_bp": -1.13,
    "spread_ask_bp": 2.69,
    "volume": 1234567,
    "timestamp": "2026-04-15T09:30:00.123456"
  }
}
```

- `spread_bp`: (현재가 - NAV) / NAV × 10000
- `spread_bid_bp`: (매수1호가 - NAV) / NAV × 10000
- `spread_ask_bp`: (매도1호가 - NAV) / NAV × 10000
- bid/ask는 LpBookSnapshot(호가)에서 갱신, Trade(체결) 시 함께 계산

**주식 틱**:
```json
{
  "type": "stock_tick",
  "data": {
    "code": "005930",
    "name": "삼성전자",
    "price": 58400.0,
    "volume": 10,
    "cum_volume": 5234567,
    "timestamp": "2026-04-15T09:30:00.123456"
  }
}
```

- 일반 주식 체결 (ETF가 아닌 종목). NAV 개념 없음.
- `cum_volume`: 당일 누적 거래량 (내부망 Trade의 `cs` 필드)
- ETF vs 주식 구분: 내부망에서는 NAV 데이터(Index fl=1,10,18) 수신 여부로 자동 판별

**선물 틱**:
```json
{
  "type": "futures_tick",
  "data": {
    "code": "A1165000",
    "name": "삼성전자 F 근월",
    "price": 58500.0,
    "underlying_price": 58400.0,
    "basis": 100.0,
    "volume": 5,
    "timestamp": "2026-04-15T09:30:00.123456"
  }
}
```

- `basis`: 시장 베이시스 = 선물가 - 현물가 (순수 가격 차이, bp 아님)
- bp 변환 필요 시 프론트엔드에서 `basis / underlying_price × 10000`

**주의**: `timestamp`는 ISO 8601 문자열.

### 채널/토픽 구조

초기에는 단일 WebSocket(`/ws/market`)에서 메시지 타입으로 분기 (현재 Python 방식과 동일).
트래픽 증가 시 토픽별 분리 검토:

```
/ws/market          — 전체 시세 스트림 (기존 호환)
/ws/basis           — 종목차익 베이시스 스트림 (향후)
/ws/etf             — ETF NAV/괴리 스트림 (향후)
```

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

거래소(KRX)에서 직접 수신한 시세 데이터를 중계하는 사내 서버에 WebSocket으로 접속.
LS API보다 데이터가 풍부하고 (LP잔량, rNAV, 선물이론가 등), latency도 낮다.

#### 접속 정보

```
주소: ws://10.21.1.208:41001
인증: 없음 (사내망 접속만으로 인증)
```

#### 구독 요청

WebSocket 연결 후 JSON 메시지를 보내면 해당 종목의 실시간 데이터가 스트리밍된다.

```json
{
  "symbols": ["A005930", "KA1165000", "A364980", "KA0166000"],
  "real_nav": true
}
```

- `symbols`: 구독할 종목 코드 배열 (아래 종목코드 체계 참조)
- `real_nav`: `true`이면 서버가 자체 계산한 실시간 NAV(rNAV)와 선물이론가도 함께 수신

응답으로 `{"code": 0, "error": null}`이 오면 구독 성공. 이후 실시간 틱 데이터가 계속 흘러온다.

#### 종목코드 체계

구독 요청 시 보내는 코드와, 실제 데이터에 들어오는 코드(`s` 필드)의 형태가 다르다.

| 종류 | 구독 요청 코드 | 데이터 `s` 필드 (ISIN) | 예시 |
|------|--------------|----------------------|------|
| 주식 현물 | `A005930` | `KR7005930003` | 삼성전자 |
| ETF | `A364980` | `KR7364980003` | KODEX K-반도체 |
| ETF | `A365000` | `KR7365000009` | — |
| 주식선물 | `KA1165000` | `KR4A11650004` | 삼성전자선물 |
| 지수선물 | `KA0166000` | `KR4A01660005` | 코스닥150선물 |

- 구독 코드는 `A` + 6자리 (현물/ETF) 또는 `KA` + 7자리 (선물)
- 데이터의 `s` 필드는 12자리 ISIN 코드 (국제 표준 증권 식별번호)
- 현물/ETF: `KR7` + 6자리 + 체크 3자리 → `KR7005930003`
- 선물: `KR4A` + 7자리 + 체크 1자리 → `KR4A11650004`

#### 메시지 수신 형태

**중요: 메시지는 항상 JSON 배열로 온다.** 하나의 WebSocket 메시지에 여러 틱이 묶여올 수 있다.

```json
[
  {"ty": "Trade", "s": "KR7364980003", "tp": "11640", "ts": "2", ...},
  {"ty": "Index", "s": "KR7364980003", "i1": "11636.0509", "i2": "", ...}
]
```

위 예시처럼 ETF 체결(Trade) 직후에 rNAV(Index)가 바로 같은 배열에 들어오는 경우가 흔하다.
배열 길이 1인 경우도 많다: `[{"ty": "LpBookSnapshot", ...}]`

---

### 내부망 메시지 타입 상세

#### 1. Trade (체결)

주식/ETF/선물의 실제 체결이 발생했을 때 오는 메시지.

```json
{
  "ty": "Trade",
  "s": "KR4A01660005",
  "tp": "937.15",
  "ts": "1",
  "cs": "7134",
  "fl": 2,
  "et": 1776385994739313,
  "rt": 1776385994742285,
  "ex": "XKRF"
}
```

| 필드 | 타입 | 설명 | 예시 |
|------|------|------|------|
| `ty` | string | 메시지 타입, 항상 `"Trade"` | `"Trade"` |
| `s` | string | ISIN 종목코드 | `"KR4A01660005"` (코스닥150선물) |
| `tp` | **string** | 체결 가격. **숫자가 아니라 문자열!** 파싱 필요 | `"937.15"`, `"11640"`, `"134200"` |
| `ts` | **string** | 체결 수량. **문자열!** | `"1"`, `"164"` |
| `cs` | **string** | 누적 체결 수량. **문자열!** (LS API에는 없는 필드) | `"7134"` |
| `fl` | number | 체결 플래그 (아래 상세 설명) | `1`, `2`, `34` |
| `et` | number | 거래소 시각 (epoch **마이크로초**) | `1776385994739313` |
| `rt` | number | 서버 수신 시각 (epoch **마이크로초**) | `1776385994742285` |
| `ex` | string | 거래소 코드 | `"XKRX"`, `"XKRF"` |

**거래소 코드 (`ex`)**:
- `XKRX` = 유가증권시장 (주식, ETF)
- `XKRF` = 파생상품시장 (선물, 옵션)
- `NXTE` = (기타)

**시각 변환 예시**: `et: 1776385994739313` → `2026-04-17 09:33:14.739313 (KST)`
```python
pd.to_datetime(1776385994739313, unit='us').tz_localize('utc').tz_convert('Asia/Seoul')
# → Timestamp('2026-04-17 09:33:14.739313+0900')
```

**Trade 플래그 (`fl`) 상세**:

`fl` 값은 비트마스크(bitmask)로 여러 의미를 동시에 가질 수 있다. 각 비트가 하나의 조건을 나타낸다.

| 비트 | 10진수 값 | 의미 |
|------|----------|------|
| `0b1` | 1 | **BUY** — 시장가매수주문으로 인한 체결 |
| `0b10` | 2 | **SELL** — 시장가매도주문으로 인한 체결 |
| `0b100` | 4 | **OPEN_AUCTION** — 시초단일가 체결 |
| `0b1000` | 8 | **CLOSE_AUCTION** — 종가단일가 체결 |
| `0b10000` | 16 | **MIDDAY_AUCTION** — 장중단일가 (VI 등) |
| `0b100000` | 32 | **PRE_MARKET** — 장 개시 전 |
| `0b1000000` | 64 | **POST_MARKET** — 장 마감 후 |
| `0b10000000` | 128 | **BLOCK_DEAL** — 대량매매 |
| `0b100000000` | 256 | **OTC** — 장외거래 |

**비트마스크 읽는 법**: `fl` 값을 이진수로 변환해서 어떤 비트가 켜져 있는지 본다.

예시:
- `fl = 1` → 이진수 `1` → BUY만 켜짐 → "매수 체결"
- `fl = 2` → 이진수 `10` → SELL만 켜짐 → "매도 체결"
- `fl = 34` → 이진수 `100010` → SELL(2) + PRE_MARKET(32) → "장전 매도 체결"
- `fl = 5` → 이진수 `101` → BUY(1) + OPEN_AUCTION(4) → "시초단일가 매수 체결"

코드에서 확인하는 법:
```rust
let is_buy  = (fl & 1) != 0;    // 매수인가?
let is_sell = (fl & 2) != 0;    // 매도인가?
let is_open = (fl & 4) != 0;    // 시초단일가인가?
```

장중 일반 거래에서는 `fl`이 대부분 `1` (매수) 또는 `2` (매도)이다.

---

#### 2. LpBookSnapshot (호가)

현재 호가창 상태 전체를 스냅샷으로 보내주는 메시지. 호가가 바뀔 때마다 온다.

```json
{
  "ty": "LpBookSnapshot",
  "s": "KR7364980003",
  "a": [
    ["11640", "7406", "0"],
    ["11645", "8114", "2106"],
    ["11650", "8109", "6300"],
    ["11655", "6086", "4000"],
    ["11660", "15303", "15000"]
  ],
  "b": [
    ["11630", "4247", "0"],
    ["11625", "13473", "7978"],
    ["11620", "23843", "18223"],
    ["11615", "2312", "2300"],
    ["11610", "9395", "5000"]
  ],
  "mp": "11635",
  "ma": "0",
  "mb": "0",
  "fl": 0,
  "et": 1776385994080757,
  "rt": 1776385994085471,
  "ex": "XKRX"
}
```

| 필드 | 타입 | 설명 |
|------|------|------|
| `a` | array | **매도호가** (Ask). 배열의 각 요소는 `[가격, 잔량, LP잔량]`. **첫 번째가 최우선(최저) 매도호가**. 모두 문자열. |
| `b` | array | **매수호가** (Bid). 배열의 각 요소는 `[가격, 잔량, LP잔량]`. **첫 번째가 최우선(최고) 매수호가**. 모두 문자열. |
| `mp` | string | 중간가 (mid price). 빈 문자열일 수 있음 (선물은 보통 `""`) |
| `ma` | string | 중간가 매도잔량 |
| `mb` | string | 중간가 매수잔량 |
| `fl` | number | 호가 플래그 (Trade 플래그와 동일). `0`이면 장중 일반 호가 |

**호가 배열 읽는 법**:

`"a": [["11640", "7406", "0"], ["11645", "8114", "2106"]]` 이것의 의미:

| | 가격 | 총 잔량 | LP 잔량 |
|---|------|--------|---------|
| 매도 1호가 (최우선) | 11,640원 | 7,406주 | 0주 |
| 매도 2호가 | 11,645원 | 8,114주 | 2,106주 (LP가 올린 물량) |

- LP잔량은 **ETF에서만** 의미 있는 값. 일반 주식이나 선물은 항상 `"0"`.
- 호가 레벨 수는 보통 5~10개지만 가변적.
- **선물은 `mp`(중간가)가 빈 문자열** `""`. 주식/ETF는 값이 있음.

**데이터 빈도**: 호가는 매우 자주 온다. 선물의 경우 초당 수십~수백 건. 로그에서 볼 수 있듯이 50ms 간격으로 계속 업데이트된다.

---

#### 3. Index (iNAV / rNAV / 선물이론가)

ETF의 NAV(순자산가치)나 선물의 이론가 등 **파생 계산 값**을 전달하는 메시지.
이 메시지 타입이 가장 복잡한데, **`fl` 값에 따라 `i1`, `i2`의 의미가 완전히 달라지기 때문**이다.

```json
{
  "ty": "Index",
  "s": "KR7364980003",
  "i1": "11633.8649",
  "i2": "11643.3549",
  "fl": 18,
  "et": 1776385994085483,
  "rt": 1776385994085483,
  "ex": "XKRX"
}
```

| 필드 | 타입 | 설명 |
|------|------|------|
| `i1` | string | 값 1 (fl에 따라 의미 다름). 문자열. |
| `i2` | string | 값 2 (fl에 따라 의미 다름). 빈 문자열 `""`일 수 있음. |
| `fl` | number | **IndexFlags** 비트마스크 — 이게 핵심 |

**IndexFlags 비트마스크**:

| 비트 | 10진수 값 | 이름 | 의미 |
|------|----------|------|------|
| `0b1` | 1 | **EXCHANGE_NAV** | 거래소에서 보내주는 공식 iNAV |
| `0b10` | 2 | **REAL_NAV** | 사내 서버가 자체 계산한 rNAV |
| `0b100` | 4 | **FUTURES_IDEAL** | 사내 서버가 자체 계산한 선물 이론가 |
| `0b1000` | 8 | **TRADE** | 체결가 기반으로 계산된 값 |
| `0b10000` | 16 | **QUOTE** | 호가 기반으로 계산된 값 |
| `0b100000` | 32 | **INDICATIVE** | 단일가 시 예상값 |
| `0b1000000` | 64 | **OPEN_AUCTION** | 시초단일가 중 |
| `0b10000000` | 128 | **CLOSE_AUCTION** | 종가단일가 중 |

**`fl` 값에 따른 `i1`, `i2` 의미 — 이것이 핵심!**

`fl` 값은 위 비트들의 조합이다. 자주 나오는 조합들:

**fl = 1 (EXCHANGE_NAV)**
```
거래소 공식 iNAV
i1 = 현재 NAV 값 (예: "11652.83")
i2 = 전일종가 NAV (예: "11415.02")
```
- `real_nav` 설정과 무관하게 항상 온다
- ETF에만 해당

**fl = 10 (= 2 + 8 = REAL_NAV + TRADE)**
```
서버 자체 계산 rNAV (체결가 기반)
i1 = 각 PDF 구성종목의 현재 체결가로 계산된 실시간 NAV (예: "11636.0509")
i2 = "" (빈 문자열, 사용하지 않음)
```
- `real_nav: true`일 때만 온다
- ETF 체결(Trade)이 발생하면 같은 배열에 묶여서 온다: `[{Trade}, {Index fl=10}]`
- 거래소 iNAV보다 더 실시간에 가깝다 (거래소 iNAV는 약간의 딜레이가 있음)

**fl = 18 (= 2 + 16 = REAL_NAV + QUOTE)**
```
서버 자체 계산 rNAV (호가 기반)
i1 = 각 PDF 구성종목의 매수호가로 계산된 NAV (예: "11633.8649")
i2 = 각 PDF 구성종목의 매도호가로 계산된 NAV (예: "11643.3549")
```
- `real_nav: true`일 때만 온다
- 호가(LpBookSnapshot)가 업데이트될 때 같은 배열에 묶여서 온다
- LP 입장에서 매우 유용: bid NAV와 ask NAV를 동시에 알 수 있음

**fl = 12 (= 4 + 8 = FUTURES_IDEAL + TRADE)**
```
선물 이론가 (체결가 기반)
i1 = 기초자산의 현재가로 계산된 선물 이론가
i2 = "" (빈 문자열)
```
- `real_nav: true`일 때만 온다
- 선물 종목에 대해서만 온다
- 종목차익 화면에서 이론 베이시스 계산에 직접 활용 가능

**fl = 20 (= 4 + 16 = FUTURES_IDEAL + QUOTE)**
```
선물 이론가 (호가 기반)
i1 = 기초자산의 매수호가로 계산된 이론가
i2 = 기초자산의 매도호가로 계산된 이론가
```

**실제 로그 예시로 보기**:

로그에서 ETF(A364980)를 구독하면 이런 순서로 데이터가 온다:

```
09:33:14.065 - [{LpBookSnapshot: ETF 호가}, {Index fl=18: rNAV 호가기반}]  ← 호가 + rNAV 묶음
09:33:14.415 - [{Index fl=1: 거래소 iNAV}]                                ← 거래소 공식 NAV (별도)
09:33:15.067 - [{Trade: 체결}, {Index fl=10: rNAV 체결기반}]              ← 체결 + rNAV 묶음
```

패턴 정리:
- `real_nav: false` → Trade, LpBookSnapshot, Index(fl=1, 거래소 iNAV)만 온다
- `real_nav: true` → 위에 더해서 Index(fl=10, 18, 12, 20 등 서버 계산값)도 온다

---

#### 4. Auction (단일가 예상 체결)

장 시작 전 시초단일가, 장 마감 전 종가단일가 시 예상 체결 정보.
**실제 체결은 Trade에서 발생**한다. Auction은 "이 가격에 체결될 것 같다"는 예상값.

```json
{
  "ty": "Auction",
  "s": "KR7252670005",
  "ip": "564",
  "is": "10218190",
  "as": "1074316",
  "bs": "2960585",
  "fl": 4,
  "et": 1776385994080757,
  "rt": 1776385994085471,
  "ex": "XKRX"
}
```

| 필드 | 타입 | 설명 |
|------|------|------|
| `ip` | string | 예상 체결가 (Indicative Price) |
| `is` | string | 예상 체결 수량 (Indicative Size) |
| `as` | string | 총 매도호가 잔량 |
| `bs` | string | 총 매수호가 잔량 |
| `fl` | number | Trade 플래그와 동일 (`4` = 시초단일가, `8` = 종가단일가) |

장중에는 거의 안 온다. 장 시작/마감 전후로만 수신.

---

#### 5. Status (매매정지/재개)

종목의 거래 상태가 변경될 때 오는 메시지. VI(변동성 완화장치) 발동/해제 등.

```json
{
  "ty": "Status",
  "s": "KR7252670005",
  "fl": 6,
  "et": 1776385994080757,
  "rt": 1776385994085471,
  "ex": "XKRX"
}
```

| 비트 | 10진수 | 이름 | 의미 |
|------|--------|------|------|
| `0b1` | 1 | **RESUME** | 거래 재개 |
| `0b10` | 2 | **HALT** | 거래 정지 |
| `0b100` | 4 | **VI** | VI 관련 |

조합 예시:
- `fl = 6` (= 2 + 4 = HALT + VI) → "VI 발동으로 거래 정지"
- `fl = 5` (= 1 + 4 = RESUME + VI) → "VI 해제로 거래 재개"
- `fl = 2` → "거래 정지 (VI 아닌 사유)"

---

### 내부망 데이터의 특징 정리

1. **모든 숫자 값이 문자열**: `tp`, `ts`, `cs`, `i1`, `i2`, 호가 배열 내 가격/잔량 전부 `"string"`. Rust에서 `parse::<f64>()`로 변환 필요.

2. **시각이 epoch 마이크로초**: `et`, `rt`는 `i64` 타입으로 epoch 이후 마이크로초(μs). 1초 = 1,000,000μs. (참고: LS API는 `HHMMSScc` 같은 문자열 포맷)

3. **메시지가 JSON 배열**: `[{tick1}, {tick2}]` 형태. 하나의 WebSocket 메시지에 관련된 틱들이 묶여온다 (특히 Trade + Index).

4. **호가 데이터가 풍부**: LP잔량까지 포함. ETF LP 업무에 매우 유용 (LS API에는 LP잔량 없음).

5. **rNAV/선물이론가 서버 제공**: `real_nav: true`로 구독하면 서버가 자체 계산한 실시간 값을 바로 줌. 외부망에서는 직접 계산해야 하는 값.

6. **데이터 빈도가 매우 높음**: 선물 호가는 초당 수십~수백 건. 종합 로그에서 50ms 이내 간격으로 계속 업데이트.

---

### 종목코드 체계 통합

사용자, 내부망, 외부망(LS API)이 각각 다른 형식을 쓰지만 핵심 숫자는 동일하다.
**사용자가 어떤 형식으로 입력하든 내부적으로 정규화하여 처리한다.**

#### 주식/ETF

| 형식 | 예시 | 설명 |
|------|------|------|
| 숫자 6자리 | `005930` | LS API tr_key, 사용자 입력 |
| A + 6자리 | `A005930` | 내부망 구독 코드 |
| ISIN 12자리 | `KR7005930003` | 내부망 데이터 `s` 필드 |

핵심: **6자리 숫자** (`005930`). ISIN에서는 `[3:9]`로 추출.

#### 선물

| 형식 | 예시 | 설명 |
|------|------|------|
| A + 7자리 | `A1165000` | LS API tr_key |
| KA + 7자리 | `KA1165000` | 내부망 구독 코드 |
| ISIN 12자리 | `KR4A11650004` | 내부망 데이터 `s` 필드 |

핵심: **A + 7자리** (`A1165000`). ISIN에서는 `[3:11]`로 추출. 내부망 구독은 앞에 `K`를 붙임.

#### 정규화 규칙

사용자 입력을 받으면 다음 순서로 정규화:

1. 앞뒤 공백 제거
2. `KR7` 또는 `KR4`로 시작하면 ISIN → 핵심 코드 추출
3. 순수 숫자 6자리면 → 주식/ETF 코드
4. `A` + 숫자 7자리면 → 선물 코드
5. `KA` + 숫자 7자리면 → `K` 제거 → 선물 코드
6. `A` + 숫자 6자리면 → `A` 제거 → 주식/ETF 코드

각 어댑터가 자기 형식으로 변환:
- 내부망 구독: 주식은 `A` + 6자리, 선물은 `KA` + 7자리 (`A` 제거 후 `KA` 붙임)
- LS API 구독: 주식은 6자리, 선물은 `A` + 7자리 그대로
- ISIN 매칭: 내부망 데이터의 `s` 필드와 비교 시 핵심 코드 부분만 비교

---

### 내부망 vs 외부망(LS API) 데이터 비교

| 항목 | 사내 서버 (내부망) | LS API (외부망) |
|------|-------------------|----------------|
| **종목코드** | ISIN 12자리 (`KR7005930003`) | 단축코드 6자리 (`005930`) |
| **가격/수량** | 모두 문자열 (`"937.15"`) | TR마다 다름 (숫자 또는 문자열) |
| **시각** | epoch 마이크로초 (`1776385994739313`) | TR마다 다름 (`HHMMSScc` 등) |
| **거래소 구분** | `ex` 필드 (`XKRX`, `XKRF`) | WebSocket URL로 구분 (`/stock`, `/futureoption`) |
| **메시지 구조** | JSON 배열 `[{tick}, {tick}]` | 개별 메시지 (배열 아님) |
| **호가 레벨** | N레벨 (가변) + LP잔량 | 5~10호가, LP잔량 없음 |
| **iNAV** | Index 메시지 (fl=1) | I5_ TR |
| **rNAV** | Index 메시지 (fl=10,18) — 서버 제공 | 없음 (직접 계산 필요) |
| **선물이론가** | Index 메시지 (fl=12,20) — 서버 제공 | FC0의 `theoryprice` (지수선물만) |
| **누적체결량** | Trade의 `cs` 필드 | 별도 필드 |
| **매수/매도 구분** | Trade의 `fl` 비트마스크 | `cgubun` 필드 등 |
| **인증** | 없음 (사내망) | OAuth2 토큰 (매일 07:00 만료) |
| **TPS 제한** | 없음 | REST는 TR별 1~10 TPS (WS는 제한 없음) |

---

## Rust 기술 스택

### Phase 1 (뼈대 + MockFeed)

| 용도 | 라이브러리 |
|------|-----------|
| 비동기 런타임 | tokio |
| WebSocket 서버 + HTTP | axum |
| JSON 직렬화 | serde + serde_json |
| 로깅 | tracing + tracing-subscriber |
| 인메모리 상태 | dashmap |
| Mock 데이터 생성 | rand |
| CORS | tower-http |
| Graceful shutdown | tokio-util (CancellationToken) |

### Phase 2+ (LS API 연동 이후)

| 용도 | 라이브러리 |
|------|-----------|
| WebSocket 클라이언트 | tokio-tungstenite |
| HTTP 클라이언트 | reqwest |
| 재접속 백오프 | backon |
| 시간 처리 | chrono 또는 time |
| 설정 관리 | config 또는 toml |
| 환경변수 | dotenvy |
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
│   │   │   ├── tick.rs        # EtfTick, FuturesTick (프론트엔드 메시지용)
│   │   │   ├── internal.rs    # 내부망 네이티브 타입 (Trade, LpBookSnapshot, Index 등)
│   │   │   ├── external.rs    # 외부망 네이티브 타입 (LS API TR별 타입)
│   │   │   └── message.rs     # WebSocket 브로드캐스트 메시지 (WsMessage enum)
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

### Phase 1: 뼈대 + MockFeed — 완료

- [x] `realtime/` Cargo 프로젝트 생성
- [x] tokio + axum 기본 서버 (port 8200)
- [x] `MarketFeed` trait 정의
- [x] `MockFeed` 구현 (설정 가능한 종목 수, 틱 주기)
- [x] 프론트엔드 메시지 계약 준수 (EtfTick, FuturesTick serde 직렬화)
- [x] WebSocket 서버 (클라이언트 접속/해제/브로드캐스트)
- [x] `GET /health` 헬스체크 엔드포인트
- [x] CORS 설정 (tower-http, React 3100 → Rust 8200)
- [x] Vite 프록시 `/ws` → `localhost:8200`
- [x] `start_dev.sh` 업데이트 (Rust 서비스 프로세스 추가)
- [x] `docker-compose.yml`에 realtime 서비스 추가
- [x] 프론트엔드 `useWebSocket` 훅 연동 확인
- [x] Python WS 코드 보존 (삭제하지 않음, 롤백용)

### Phase 2: LS증권 API 연동 (외부망) — 완료

- [x] `LsApiFeed` 구현 (`realtime/src/feed/ls_api.rs`)
- [x] OAuth2 토큰 발급 + 끊기면 자동 재발급
- [x] WebSocket 클라이언트 (tokio-tungstenite, native-tls)
- [x] WebSocket 접속: `/websocket` 경로 + User-Agent/Accept-Language 필수 헤더 (WAF 통과)
- [x] TR별 구독: S3_(코스피 체결), K3_(코스닥 체결), JC0(주식선물 체결)
- [x] 코스닥 종목 자동 감지 (t8436 목록 → 마스터 `market` 필드)
- [x] **멀티 커넥션**: LS API 실제 제한 ~200개/연결 → 190개씩 분할하여 3개 연결 동시 운영 (500개 전체 커버)
- [x] 시작 시 마스터 기반 500종목 자동 구독 (프론트 REST 구독 불필요)
- [x] JC0 체결 시 기초자산 StockTick 동시 발행 (futures_to_spot 매핑)
- [x] 프론트엔드 메시지 포맷으로 변환 (EtfTick, StockTick, FuturesTick)
- [x] `FEED_MODE` 환경변수로 mock/ls_api/internal 전환
- [x] `GET /mode` API (프론트 네트워크 토글 자동 반영)
- [x] 자동 재연결 (연결별 독립 백오프: 2s → 4s → 8s → ... → 최대 60s)
- [x] 데이터 검증: 내부망/외부망 동시 수집 비교 완료 (가격, 수량, 누적 일치)
- [x] 프론트 최적화: 100ms 틱 버퍼링 (초당 10회 렌더), React StrictMode 제거
- [x] 마스터에서 가격 제거 — 정적 매핑만 (stale 가격 문제 근본 해결)
- [x] 초기값 REST fetch: t8402(선물/스프레드) + t1102(현물) 병렬 실행 → `is_initial` 플래그
- [x] 프론트 store: `is_initial` 틱은 이미 실시간 값 있으면 무시
- [x] 고정/전환 그룹 분리: 현물+스프레드(고정) / 선물(월물 전환 가능)
- [x] 스프레드 D코드 종목 실시간 구독 (JC0, 근월-차월 자동 매칭)
- [x] 승수 일일 백그라운드 체크 (분할/증자 대응)
- [x] 마스터 갱신: 만기 시에만 (매일 갱신 제거)

**LS API 제한 사항 (문서에 없지만 실측)**:
- 단일 WebSocket 연결당 실시간 구독 상한: ~200개 (초과 시 정상처리 응답은 오지만 데이터 미수신)
- 해결: 190개씩 분할하여 여러 연결 사용 (동일 토큰으로 다중 연결 가능)
- KRX 데이터만 수신 (NXT 대체거래소 데이터는 별도 TR 필요, 현재 미사용)

### Phase 3: 사내 서버 연동 (내부망) — 완료

- [x] `InternalFeed` 구현 (`realtime/src/feed/internal.rs`)
- [x] 사내 WebSocket 프로토콜 연동 (`ws://10.21.1.208:41001`)
- [x] JSON 배열 메시지 파싱 (Trade, LpBookSnapshot, Index, Auction, Status)
- [x] 내부망 네이티브 타입 정의 (`realtime/src/model/internal.rs`)
- [x] ISIN ↔ 단축코드 변환 (`isin_to_short`, `short_to_subscribe`)
- [x] Index fl 비트마스크 처리 (iNAV, rNAV, 선물이론가 → SymbolState 갱신)
- [x] Trade → EtfTick/FuturesTick 변환 (rNAV/iNAV/이론가 활용)
- [x] 자동 재연결 (지수 백오프, LsApiFeed와 동일 패턴)
- [x] `FEED_MODE=internal` 환경변수 전환
- [ ] 내부망 실 데이터 테스트 (사내 PC에서 실행 필요)

### 성능 최적화 (484종목 실운영 시 적용)

채널 버퍼 증가는 적용 완료 (mpsc 256→1024, broadcast 4096→16384). 아래는 프로파일링 후 필요 시 적용:

- [ ] **LpBookSnapshot 파싱 최소화**: 현재 10호가 전부 파싱 중 (호가창 등에서 사용 예정이므로 당분간 유지). 과부하 확인 시 best bid/ask만 파싱하도록 최적화 검토
- [ ] **String clone 제거**: `handle_trade()`에서 매 틱마다 `short_code.clone()`, `name.clone()` 발생. → `Arc<str>`로 코드/이름을 한 번 할당 후 재사용
- [ ] **타임스탬프 캐싱**: `epoch_us_to_iso()`, `Utc::now().format()`가 매 틱 호출. → 같은 배열 내 메시지는 타임스탬프 공유, 또는 정수 타임스탬프로 보내고 프론트에서 포맷
- [ ] **구독자 없을 때 직렬화 스킵**: mpsc→broadcast 브릿지에서 클라이언트 없어도 `serde_json::to_string()` 호출. → broadcast 수신자 수 체크 후 스킵
- [ ] **과부하 모니터링 도입**: 채널 사용률, 틱 처리 지연(서버 시각 vs 브로드캐스트 시각), 메시지 드롭 수(Lagged) 등을 로그 또는 `/metrics` 엔드포인트로 노출. 위 최적화 항목의 적용 판단 기준으로 사용

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
