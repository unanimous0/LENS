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
    "timestamp": "2026-04-15T09:30:00.123456",
    "is_initial": false,
    "high": 58500.0,
    "low": 58200.0,
    "prev_close": 58100.0,
    "last_trade_volume": 10,
    "trade_side": 1,
    "halted": false,
    "upper_limit": 75530.0,
    "lower_limit": 40670.0,
    "vi_active": false,
    "warning": false,
    "liquidation": false,
    "abnormal_rise": false,
    "low_liquidity": false,
    "under_management": false
  }
}
```

- 일반 주식 체결 (ETF가 아닌 종목). NAV 개념 없음.
- `cum_volume`: 당일 누적 거래량 (내부망 Trade의 `cs` 필드)
- ETF vs 주식 구분: 내부망에서는 NAV 데이터(Index fl=1,10,18) 수신 여부로 자동 판별
- 상태 필드 (전부 `#[serde(skip_serializing_if)]` — false/None이면 직렬화 X):
  - `is_initial`: true면 t1102/t8402 초기 스냅샷 (실시간 X — 이미 실시간 값 있으면 무시)
  - `high/low/prev_close`: 당일 고가/저가, 전일 종가
  - `last_trade_volume`: 그 체결의 단일 수량 (cum_volume과 별개)
  - `trade_side`: +1=매수, -1=매도 (LS S3_/K3_의 cgubun)
  - `halted`: 매매정지 (t1405 jongchk=2)
  - `upper_limit/lower_limit`: 상한가/하한가 (t1102, 당일 거의 불변)
  - `vi_active`: VI 발동 (VI_ stream, 2분 단일가 매매 중)
  - `warning/liquidation`: 투자경고/정리매매 (t1405)
  - `abnormal_rise/low_liquidity`: 이상급등/저유동성 (t1102)
  - `under_management`: 관리종목 (t1404)

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
| 주식 체결 (KOSPI) | S3_ | `wss://.../websocket` |
| 주식 체결 (KOSDAQ) | K3_ | `wss://.../websocket` |
| 주식선물 체결 | JC0 | `wss://.../websocket` |
| 주식선물 호가 | JH0 | `wss://.../websocket` |
| KOSPI200 선물 체결 | **FC9** (구 FC0, 5/28 deprecate) | `wss://.../websocket` |
| KOSPI200 선물 호가 | **FH9** (구 FH0, 5/28 deprecate) | `wss://.../websocket` |
| ETF NAV | I5_ | `wss://.../websocket` |
| 지수 | IJ_ | `wss://.../websocket` |

> 모든 TR 단일 경로 `/websocket` 사용 (이전 `/websocket/stock` 등 분리 표기는 잘못). 시장 구분은 구독 메시지의 `tr_cd` 로 한다.

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
| **선물이론가** | Index 메시지 (fl=12,20) — 서버 제공 | FC9의 `theoryprice` (구 FC0, 지수선물만) |
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

### Bridge 150ms coalesce + Batch envelope (내부망 스케일 핵심)

**문제**: 750종목 × ~2 tps = ~1500 tick/sec를 개별 broadcast 시 브라우저 onmessage 1500 hz → JSON.parse · store mutation · React 재렌더 cascade로 페이지 멈춤. 내부망(KOSPI200 + 6000 stocks + 5+ 사용자)에선 더 심해짐.

**해결**: `main.rs`의 bridge task가 mpsc rx에서 받은 WsMessage를 바로 broadcast하지 않고 **`pending: HashMap<String, WsMessage>`** 에 누적. **`tokio::time::interval(150ms)`** 가 fire하면 drain → 개별 직렬화 + cache 갱신 + 모두를 하나의 envelope JSON으로 묶어 broadcast 1회.

```json
{"type":"batch","ticks":[{"type":"stock_tick","data":{...}},{"type":"etf_tick","data":{...}}, ...]}
```

- 같은 code의 중복 tick은 마지막 값만 유지 (자동 dedup, 호가창 ~50% 추가 감소)
- envelope 조립은 직접 문자열 concat — 이미 직렬화된 item을 다시 parse/stringify 하지 않음
- 캐시(snapshot)는 개별 JSON 단위 유지 — 신규 클라이언트 접속 시 기존 flush 그대로 작동
- 구독자 0명: 직렬화 스킵하지만 cache는 채움 (재접속 대비)
- 트레이드오프: 최대 150ms 표시 지연. 모니터링 화면엔 무해 (KRX 발행 cadence와 동급), 체결 경로 부적합 — 추후 별도 endpoint 분리 시 검토

**효과**:
- 1500/sec → ~6 batch/sec (250× 압축, 배치당 평균 ~237 ticks)
- 클라이언트당 WebSocket write/sec **종목 수·사용자 수와 무관**하게 6 hz로 평탄화 → 내부망 5+ 사용자 스케일 가능
- 프론트 측 `useWebSocket.ts onmessage`가 `type === 'batch'` 분기에서 내부 ticks 배열 순회 → 기존 dispatch 재사용

검증: `/debug/stats`의 `ticks_total / serialize.calls` 비율이 배치 압축률. `ws_lag_total: 0` 유지면 클라이언트가 잘 따라옴.

### 성능 최적화 (484종목 실운영 시 적용)

채널 버퍼 증가는 적용 완료 (mpsc 256→8192, broadcast 4096). 10단계 최적화 커밋(`5ef7dbf`~`13aabbb`)에서 LTO/codegen-unit, Arc 공유, 스냅샷 캐시, Nagle off, rAF 플러시, 마스터순 구독, `/debug/stats` 등 반영.

**2026-04-24 재검토 결과** (에이전트 3개 병렬 토의): 남은 항목 대부분 750종목·~300tps 현실 부하에선 측정 불가 수준이라 judgment = **"측정 → 필요시"**.

- [x] **구독자 없을 때 직렬화 스킵**: `OrderbookTick` (캐시 없음) + `ws_clients == 0` 조합만 스킵. 캐시 대상 틱은 snapshot 복원을 위해 항상 직렬화. `ticks_skipped_no_subscribers` 카운터로 효과 관측.
- [x] **과부하 모니터링 (`/debug/stats` 확장)**: `ws_clients`, `ws_lag_total` (broadcast Lagged 누적), `reconnect_count` (LS WS 재접속 총합), `fetch_failures.{no_data, http_5xx, tps, other}` 추가. 초기 fetch 실패율 분류는 `ls_rest.rs::classify_error`로 자동. 어제의 "205 failed" 같은 단일 경고가 이제 `warn!("t8402 failures: no_data=X http_5xx=Y tps=Z other=W")`로 분해돼 찍힘.
- [ ] **LpBookSnapshot 파싱 최소화** — **SKIP**. `OrderbookModal.tsx`가 10호가 전부 사용. 프런트 회귀 리스크가 절약보다 큼.
- [ ] **String clone → `Arc<str>`** — **DEFER**. Blast radius 크고 (SymbolState 키 / `message.rs` 3개 struct / HashMap) 현 부하에서 `/debug/stats` serialize avg_ns가 측정 임계 아래. `serialize.avg_ns > 20μs` 관측되면 재검토.
- [ ] **타임스탬프 캐싱** — **DEFER**. `Utc::now().format(...).to_string()`은 ~500ns + 1 alloc이지만 staleness 리스크가 있고 현 부하에선 체감 불가.

### 재연결 로직 (LS WS)

`ls_api.rs`의 3개 연결 그룹(고정 / 선물 / 호가) 모두 `run_single_connection` 리턴값이 `Err`일 때 exponential backoff (최대 60s)로 재시도. 성공 시 재구독. 스냅샷 캐시는 재연결 구간에도 보존되어 프런트가 데이터 공백 없이 이어감. 재접속 횟수는 `/debug/stats.reconnect_count`에 누적. 실제 TCP 끊김 시나리오는 `sudo iptables -I OUTPUT -d openapi.ls-sec.co.kr -j DROP`로 5초 차단 → 로그/카운터 확인으로 스모크 테스트 가능 (SIGSTOP은 연결 유지된 채 프로세스만 멈춰서 재연결 트리거 X).

### Phase-aware 시간대 게이트 (2026-05-07 인시던트 대응)

당일 사건: 자정(00:02 KST) LS API가 일일 토큰 갱신/유지보수로 모든 WS 연결 disconnect → realtime이 즉시 폭주 재연결 → "silent 5 cycles" 트리거 → 300s extended backoff. 이후 9시간 동안 재시도 정상 동작 안 됨 → 09:00 장 시작에도 LS 연결 0개. 원인은 **시간대 무관 24/7 재연결 시도**.

해결: `phase.rs` 모듈 + 5개 reconnect loop 게이트.

**Phase enum** (KST 기준):
| Phase | 시간 | 동작 |
|---|---|---|
| Sleep | 16:00~다음 영업일 08:30, 주말, KRX 공휴일 | LS 연결 시도 금지, 다음 attach 시각까지 sleep |
| WarmUp | 평일 08:30~09:00 | attach (장 시작 전 준비) |
| Live | 평일 09:00~15:30 | 정상 운영 |
| WindDown | 평일 15:30~16:00 | 잔여 틱 수신 |

**구현**:
- `phase::current()` — KST 시각 + `holidays.rs::is_krx_holiday()` 결합 판정
- `phase::next_attach_time()` — 다음 영업일 08:30 (주말/공휴일 skip)
- `phase::wait_until_active(cancel, label)` — Sleep phase면 5분 단위 chunk로 next attach까지 대기
- `phase::spawn_watchdog(cancel)` — 30초마다 phase polling, 변화 시 INFO `[PHASE]` 로그

**5개 LS reconnect loop 게이트** (`ls_api.rs`):
- fixed / futures / stocks / inav / orderbook 각 loop 상단에 `wait_until_active(...)` 1줄
- Sleep 진입 시 모든 task 동시 idle, LS 점검 시간과 충돌 안 함
- WarmUp 진입 시 동시 attach

**효과**:
- LS 점검 시간 (00:00~01:00 추정) 폭주 재연결 차단 → abuse heuristic 회피
- 새벽 무의미한 토큰/세션 낭비 X
- 09:00 장 시작 정확히 30분 전부터 attach 보장

**가시성**: `[PHASE] startup phase: live` / `[PHASE] sleep → warm-up` / `[PHASE] warm-up → live` 등 INFO 로그 → start_dev.sh 터미널 + `logs/realtime.log` 양쪽에서 시간대 전환 보임.

### LS API abuse 보호 (2026-04-27 인시던트 대응)

당일 사건: 빠른 frontend re-subscribe (HMR/멀티탭) + 내부 idle timeout 버그(`last_data_us` reset 누락 → 무한 재연결) 결합으로 LS-측 abuse heuristic 발동, 데이터 송신 중단. 5겹 방어 도입 (`commit 2d4b331` + 후속 race fix):

1. **OAuth 토큰 캐시** (`ls_rest.rs::get_or_fetch_token`)
   - 프로세스 단위 `OnceLock<TokioMutex<Option<CachedToken>>>` + 23h TTL
   - `fetch_initial_prices`와 `run_single_connection` 모두 같은 캐시 사용
   - 재연결 60회 → 토큰 요청 1회로 압축 (LS abuse 신호의 가장 큰 트리거 제거)

2. **Subscribe dedupe — 2겹 방어**
   - 프론트 (`stock-arbitrage.tsx`): `useRef<lastSubKey>`로 `(month, sorted-codes)` 동일하면 skip
   - 백엔드 (`ls_api.rs::run`): `current_futures_key` 추적, 동일 코드 셋 들어오면 `info!("Subscribe: same N codes — skip")` 후 no-op
   - HMR/멀티탭/직접 호출 어느 경로든 storm 차단

3. **두 timestamp 분리** (`ls_api.rs::run_single_connection`)
   - `last_data_us`: 실제 Text/Binary 받은 시각만 갱신 → **뱃지 표시용** (정직한 데이터 age)
   - `last_subscribe_us`: subscribe 완료 시각만 갱신 → **idle grace 윈도우 anchor**
   - idle 판정: `max(last_data, last_subscribe)` — 재연결 직후 30초 grace 보존하면서 뱃지는 거짓말 안 함
   - 분리 전 버그: subscribe 시 `last_data_us` reset → 뱃지 영원히 "fresh" + 무한 재연결 루프

4. **Silent reconnect 백오프 escalation** (`ls_api.rs` 3개 spawn 루프)
   - 연속 5회 데이터 0인 재연결 후 → backoff 60s → **300s** (5분) 전환
   - LS가 침묵 중일 때 우리 부하 줄여 abuse 신호 약화
   - `stats.tick_count` delta로 silent 여부 판정, 데이터 들어오면 카운터 0 reset

5. **모드 전환 쿨다운** (`main.rs::set_mode`)
   - 5초 내 재전환 시 `429 Too Many Requests` 반환
   - **TOCTOU race fix**: read+check+claim을 한 write 락 critical section에 묶음 → 동시 요청도 1개만 통과
   - `mock → ls_api` 전환 시 `feed_last_data_us = now_us()` reset (뱃지가 잘못된 stale 빨간불 안 뜨도록)

### 운영 가시성 — Feed 헬스 뱃지

`/debug/stats`에 `feed_mode` / `feed_state` / `feed_age_sec` / `is_market_hours` 추가. 프론트 `useFeedHealth` hook이 5초 폴링하여 `marketStore`에 푸시, `NetworkToggle`에 색 뱃지 + hover 툴팁 표시.

| 상태 | 색 | 의미 |
|------|------|------|
| `fresh` | 🟢 정상 | ls_api + 30초 내 데이터 |
| `quiet` | 🟡 잠잠 | 30초~5분 침묵 |
| `stale` | 🔴 멈춤 | 5분+ 침묵 (LS 차단 의심) |
| `closed` | ⚪ 휴장 | KST 평일 09:00~15:45 외 |
| `mock`/`internal` | ⚫ | LS 미사용 모드 |

**Stale watcher**: 백그라운드 태스크가 매 분 `feed_age_sec`를 검사해 stale 진입 transition 감지 시 `broadcaster.clear_cache()` 1회 호출. 5분+ 침묵 후 재접속한 클라이언트가 옛 가격을 "현재"로 받는 상황 방지.

**장 외 가드 (`is_market_hours_kst()`)**: stale watcher는 **장중에만** 발동. 장 외(저녁/주말/휴장일)엔 무신호가 정상이고, 전일 종가를 참고용으로 계속 보여주는 게 트레이더에게 더 유용 (만기 임박 OI 추세 확인 등). 장 외 wipe 안 함 → 토요일 페이지 열어도 금요일 종가 그대로 보임. 월요일 첫 틱부터 자연스럽게 갱신.

### t1102 우선순위 + 재시도 (외부망 한정)

LS API TPS 10/초로 PDF 종목(~2000) 초기 fetch에 ~3.5분. 5xx 산발 발생. 다층 처리:

#### ETF PDF 마스터 확장 (`load_etf_pdf_extra_codes`)

`futures_master.json`은 주식선물 발행된 250개만 등록 → ETF PDF 잡주 1700개가 백그라운드 sweep 대상에서 빠지는 문제. 사용자 입장에선 "ETF 페이지 켜둬도 잡주 가격 못 받음, 클릭하면 그제야 받음" 현상.

**해결**:
- realtime 시작 시 backend `/api/etfs/pdf-all` HTTP GET (5초 타임아웃, `BACKEND_URL` env 지원)
- ETF 코드 + PDF stocks union 추출 → `is_six_alnum`(6자리 영숫자)만 통과 — 'CASH'/9자리 선물코드(KA*, KAM*) 배제
- 마스터 미포함 종목만 `MasterShared.etf_pdf_extra_codes`로 보관
- backend 미가동 / JSON 파싱 실패 / 비-200 → 빈 Vec 폴백 (graceful degradation, 250개 fixed로 동작)
- LsApiFeed 시작 5초 후 별도 task로 백그라운드 t1102 sweep (fixed sweep과 토큰 경합 회피, phase-gated)
- 같은 `fetched_stocks`/`failed_stocks` Arc 공유 → SubscribeStocks 핸들러가 사용자 진입 시 이미 fetched된 종목 skip → 즉시 가격 표시
- WS subscribe는 안 함 (KOSDAQ 분류 정보 없어 S3_/K3_ 잘못 보낼 위험). 실시간 tick은 사용자 진입 시 SubscribeStocks가 처리
- 측정 결과 (2026-05-08): 589 ETFs / 32096 PDF rows / 1727 extra codes / 시작 후 6.8분에 1932/1977 (97.7%) 도달, http_5xx 0건

#### emit 분류 — `value_pos` / `pc_only` / `no_data`

`fetch_stocks_initial`의 emit 분기를 명확히 분리해서 `pc_only` 케이스가 fetched에 갇혀 영구 0원 표시되는 문제 회피:

- `value > 0` (거래대금 있음) → 정상 emit, **fetched 등록**, count++
- `value == 0 && pc > 0` (거래 없는 잡주) → `prev_close` 폴백으로 price=0 emit, **fetched 등록 X**, failed에 `pc_only` kind로 등록 → retry worker가 60초마다 재시도, 거래 발생 즉시 정상 가격 갱신
- 둘 다 0 → `no_data`, failed 등록

`Stats`에 누적 카운터: `emit_value_pos`, `emit_pc_only`, `fetch_attempts`.

#### `volume_cache.rs` — 거래대금 기반 sweep 순서

- t1102 응답에 이미 들어오는 `value`(당일 거래대금) piggyback 저장
- `data/stock_volumes.json`에 1000건 단위 incremental save (sweep 도중 재시작해도 부분 누적)
- 다음 launch 시 master 로더가 `ordered_stock_codes`를 거래대금 desc 정렬 → 다음 sweep부터 활발한 종목 먼저
- 추가 LS API 호출 0
- 첫 launch는 master 코드순 (캐시 없음)

#### `failed_stocks` 재시도 worker

- `Arc<DashMap<code, FailedT1102>>` — `AppState`와 `LsApiFeed`가 같은 Arc 공유 (`/debug/stats`에서 사이즈 노출)
- t1102 실패 (5xx / no_data / tps / other / **pc_only**) 시 코드 + 에러 종류 + 시도 횟수 기록
- 백그라운드 worker (60초 cycle, phase-gated):
  - failed_stocks snapshot → `fetch_stocks_initial` 호출
  - 성공 (value>0) → fetched로 이동, failed에서 제거 + tick emit
  - 여전히 pc_only → failed 잔류, attempt_count 증가
- 초기 fetch 후 120초 대기 후 시작 (sweep과 TPS 경합 회피)
- 모드 전환 / 일일 자동 새로고침 시 fetched + failed 둘 다 clear

#### `PrioritizeStocks` SubCommand

- 사용자 ETF 클릭 시 `POST /realtime/prioritize-stocks { codes: [...] }`
- `LsApiFeed::run` 핸들러: fetched 안 된 코드만 추출, 즉시 별도 fetch task spawn
- 5초 burst (50 종목 × 100ms) → LS abuse 신호 미달
- 모드 분기:
  - LS API: 정상 처리
  - Internal: no-op (즉시 도착하므로 의미 없음)
  - Mock: no-op

#### 진단 — `/debug/stats::t1102_progress`

```
ordered_total      : 250          // futures_master 사이즈 (extra 미포함)
fetched_size       : 1932         // value>0로 emit + fetched 등록
failed_size        : 45           // 재시도 대상 (대부분 pc_only)
failed_by_kind     : {pc_only:45} // 종류별 분포
fetch_attempts     : 2080         // 누적 시도 (= fetched + failed + retry attempts)
emit_value_pos     : 1931         // 정상 거래 emit 누적
emit_pc_only       : 147          // pc-only emit 누적 (이 중 retry로 회복된 건 value_pos로 옮겨감)
```

종류별 첫 5개 코드+에러 샘플도 로그로 노출 — `t1102 http_5xx samples: [001340=http 503, ...]`. `fetch_failures` 카운터(`http_5xx`/`no_data`/`tps`/`other`)는 별도 누적.

---

### 페이지별 구독 라이프사이클

프론트가 페이지 단위로 종목을 구독/해제하는 패턴. 모든 페이지가 한 번 구독한 종목을 영원히 유지하면 백그라운드 누적 → 외부망 200/연결 한계 압박. 그래서 페이지 mount/unmount에 맞춰 토글한다.

**훅 3종** — 엔드포인트별 분리 (시맨틱이 달라서):

| 훅 | 엔드포인트 | SubCommand | 시맨틱 | 사용 페이지 |
|---|---|---|---|---|
| `usePageSubscriptions` | `/realtime/subscribe`(`/unsubscribe`) | `Subscribe` / `Unsubscribe` | **replace** (월물 전환) | 종목차익 |
| `usePageStockSubscriptions` | `/realtime/subscribe-stocks`(`/unsubscribe-stocks`) | `SubscribeStocks` / `UnsubscribeStocks` | **ref-count + warm-down + client_subs** (멀티탭/멀티페이지 안전) | ETF주선교체 · 통계차익 페어/포지션 상세 |
| `usePageInavSubscriptions` | `/realtime/subscribe-inav`(`/unsubscribe-inav`) | `SubscribeInav` / `UnsubscribeInav` | **add/remove 누적** (I5_ ETF iNAV) | ETF주선교체 |
| `usePageOrderbookBulk` | `/realtime/orderbook/subscribe-bulk`(`/orderbook/unsubscribe`) | `SubscribeOrderbook` | **replace** (단일 active 호가셋) | 종목차익/ETF주선교체 |

내부 동작 (모든 훅 공통):
- mount 또는 codes 배열 변경 시 → 새로 추가된 코드만 subscribe, 빠진 코드만 unsubscribe
- unmount 시 → 마지막 보유 코드 일괄 unsubscribe

**왜 분리했나** — `/subscribe`는 stock-arbitrage가 월물 토글로 사용하는 replace 시맨틱. ETF주선교체 페이지가 여기에 ETF/PDF 코드를 섞어 넣으면 stock-arbitrage 선물 셋을 덮어씀. 별도 endpoint로 격리.

**Rust 측 그룹 구분 (LS API 모드 conn_id 범위)**:
- `0~99`: 고정 그룹 (현물 250 + 스프레드 D-코드, startup에 한 번 spawn)
- `100~199`: 선물 그룹 (`Subscribe` replace로 월물 전환)
- `200~299`: 동적 주식/ETF 그룹 (`SubscribeStocks` add/remove)
- `300~399`: ETF iNAV 그룹 (`SubscribeInav` add/remove, TR=`I5_`)
- `200`(공유): orderbook 단일 그룹 (`SubscribeOrderbook` replace, 위와 ID 충돌 가능하나 별개 WS 연결)

**SubscribeStocks가 t1102 fetch도 트리거**: 새로 추가된 코드들에 대해 `fetch_stocks_initial` 백그라운드 spawn → REST로 마지막 종가 + 전일 종가 즉시 발행. 장 외 / realtime 재시작 후에도 가격 빠르게 채워짐.

**StockTick prev_close 백필**: 라이브 S3_/K3_ 틱은 `prev_close: None`이라 cache 덮어쓰면 사라짐. main.rs bridge에서 `stock_prev_close` HashMap에 첫 t1102 응답값 저장해두고, 후속 라이브 틱 직렬화 직전에 백필. 재접속 클라이언트의 snapshot에 항상 prev_close 포함.

**EtfTick 필드 merge**: S3_(price/volume)와 I5_(nav)가 같은 EtfTick 캐시 키를 덮어쓰는 문제. main.rs bridge가 `etf_state` 맵으로 코드별 마지막 값을 보존하고 0인 필드는 채워줌 → 어느 한쪽만 들어와도 다른 쪽 데이터 유지.

**현행 패턴: Tier 1 영구 + Tier 2 ref-count + warm-down**

트레이딩 데스크 표준의 3-tier 모델 도입 (subscribe-stocks 그룹 한정):

| Tier | 대상 | 정책 |
|---|---|---|
| **T1 영구** | 활성 포지션 leg 등 backend가 push한 코드 | 무조건 LS 유지. 페이지 mount 무관 |
| **T2 ref-count + warm-down** | 페이지가 보는 코드 | mount 시 ref+1 / unmount 시 ref-1. ref==0 도달 후 N초(`REALTIME_WARM_DOWN_SECS`, 기본 60) 대기 후 실제 LS 해제 |
| **T3 1회 fetch** | t1102 종가 캐시 (`fetched_stocks`) | 코드별 1회. 재구독 시 캐시 hit |

**Tier 1 (`POST /permanent-stocks`)**: backend가 set 전체를 replace. realtime이 diff 계산 → 내부적으로 `SubscribeStocks`/`UnsubscribeStocks`로 변환 → T2 흐름 위에 자연스럽게 얹힘 (영구 코드는 client_id 없이 호출 → client_subs 미추적). backend는 포지션 등록/청산/삭제 시점에 `asyncio.create_task`로 fire-and-forget 호출 + startup 시 1회. **realtime 단독 재시작 시 다음 포지션 변경까지 공백 허용** (의도된 한계).

**Tier 2 ref-count**: `current_stocks: HashMap<code, u32>`. 같은 코드를 여러 페이지·여러 client가 sub → ref 누적. ref==0 도달해도 즉시 LS WS 해제하지 않고 `pending_drops`에 warm-down 타이머 등록 → 만료 후 `drop_tx`로 self-signal → 그 시점에 실제 해제. 만료 전 재구독 도착 시 타이머 abort → "warm-down resumed" (LS 연결 유지).

**WS client_id 교환 (disconnect 자동 cleanup)**:
1. WS 연결 직후 realtime이 `{"type":"hello","client_id":N}` 메시지 송신 (`next_client_id.fetch_add(1)`)
2. frontend가 `marketStore.clientId`에 저장
3. `usePageStockSubscriptions`가 `X-LENS-Client-Id` 헤더로 첨부 → realtime이 `client_subs: DashMap<u64, DashSet<String>>`에 추적
4. WS disconnect (정상/F5/탭 강제 종료/네트워크 끊김 모두) → handler 종료 시 `cleanup_client_subs` → 남은 코드를 `UnsubscribeStocks`로 발사 → 페이지 명시적 unsub 없어도 ref-count leak 안 남

**WS 재연결 race 처리**: 재연결 시 새 client_id 발급 → frontend `clientId` 변경. `usePageStockSubscriptions`가 의존성으로 잡고 있어서 useEffect 재발화 + `lastSet` reset → 모든 코드 새 id로 재구독. 이전 client의 ref-count는 서버측 disconnect cleanup이 warm-down 시작 → 새 sub가 만료 전이면 `warm_resumed`로 LS 연결 그대로.

**도입 배경 (2026-05-16 세션)**: 사용자가 "탭 3~4개 켜면 어떻게 돼?" + "토요일 종가 테스트해보자" 질문에서 한계 노출. 30초 vs 60초 토론 후 60초 채택 — 단일 사용자 환경 + t1102 REST 재호출 회피 결정타. env로 운영 중 조정.

**Tier 2가 다루지 않는 그룹** (별도 시맨틱):
- `/subscribe` (선물 replace): stock-arbitrage 월물 토글. ref-count 없음.
- `/subscribe-inav` (I5_): ETF iNAV. ref-count는 있으나 warm-down 미적용.
- `/orderbook/subscribe-bulk` (replace): 호가창 단일 active 셋.

향후 일관성 위해 inav도 warm-down 도입 가능. 선물·orderbook은 replace 시맨틱이라 부적합.

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
