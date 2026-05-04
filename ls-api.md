# LS증권 OpenAPI 연동 가이드

## 개요

LS증권 OpenAPI를 통해 실시간 주식/ETF/선물 시세, 호가, 체결 데이터를 수신.
LENS의 종목차익 페이지 등에서 활용 예정.

## 사전 요건

1. LS증권 계좌 보유
2. xingAPI 서비스 등록 (HTS 또는 LS증권 홈페이지)
3. OpenAPI 등록 → APP_KEY, APP_SECRET 발급
4. 등록 URL: https://openapi.ls-sec.co.kr

## 인증

```
POST https://openapi.ls-sec.co.kr:8080/oauth2/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials&appkey={APP_KEY}&appsecretkey={APP_SECRET}&scope=oob
```

- 토큰 유효기간: 발급 시점 ~ 다음 날 07:00 (매일 재발급 필요)
- 최대 3개 계좌 등록 가능

## REST API

- Base URL: `https://openapi.ls-sec.co.kr:8080`
- 모든 요청: `POST` + JSON body
- 필수 헤더: `authorization: Bearer {TOKEN}`, `tr_cd: {TR코드}`, `tr_cont: N`

### 주요 TR 코드

| 구분 | TR코드 | 설명 | TPS |
|------|--------|------|-----|
| **주식 시세** | t1102 | 주식 현재가 조회 | 10 |
| **주식 호가** | t1101 | 10호가 조회 | 10 |
| **주식 분봉** | t1302 | N분 봉 | 1 |
| **주식 일봉** | t1305 | 일/주/월봉 | 1 |
| **선물 시세** | t2101 | 선물/옵션 현재가 (베이시스 포함) | 10 |
| **선물 호가** | t2105 | 선물/옵션 5호가 | 10 |
| **선물 분봉** | t8415 | N분 봉 | 1 |
| **선물 일봉** | t8416 | 일/주/월봉 | 1 |
| **주식선물 시세** | t8402 | 주식선물 현재가 | 10 |
| **주식선물 호가** | t8403 | 주식선물 호가 | 10 |
| **주식선물 마스터** | t8401 | 주식선물 종목 목록 | 2 |
| **지수선물 마스터** | t8432/t9943 | 지수선물 종목 목록 | 2 |
| **멀티 현재가** | t8434 | 선물/옵션 여러 종목 한 번에 | 3 |
| **ETF NAV** | I5_ (WS) | ETF 실시간 NAV | - |

## WebSocket 실시간 스트리밍

### 접속 URL

**중요: 경로는 `/websocket`이다** (`/websocket/stock` 아님). 시장 구분은 구독 시 TR코드로 한다.
User-Agent, Accept-Language 헤더가 없으면 WAF가 연결을 drop한다.

| 환경 | URL |
|------|-----|
| 실서버 | `wss://openapi.ls-sec.co.kr:9443/websocket` |
| 시뮬레이션 | `wss://openapi.ls-sec.co.kr:29443/websocket` |

**필수 헤더** (없으면 TLS 후 응답 없이 타임아웃):
```
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) LENS_Terminal/1.0
Accept-Language: ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7
```

### 구독/해제 메시지

```json
{
  "header": {
    "token": "{ACCESS_TOKEN}",
    "tr_type": "3"
  },
  "body": {
    "tr_cd": "FC0",
    "tr_key": "101T9000"
  }
}
```

- `tr_type`: `"3"` = 구독, `"4"` = 해제

### 주요 실시간 TR

| TR코드 | 시장 | 데이터 | 주요 필드 |
|--------|------|--------|-----------|
| **S3_** | KOSPI 체결 | 주식 실시간 체결 | price, volume, change |
| **K3_** | KOSDAQ 체결 | 주식 실시간 체결 | price, volume, change |
| **H1_** | KOSPI 호가 | 10호가 잔량 | offerho1-10, bidho1-10 |
| **HA_** | KOSDAQ 호가 | 10호가 잔량 | offerho1-10, bidho1-10 |
| **FC0** | KOSPI200 선물 체결 | 가격+베이시스+지수 | price, ibasis, k200jisu, theoryprice, volume |
| **FH0** | KOSPI200 선물 호가 | 5호가 잔량 | offerho1-5, bidho1-5, offerrem1-5, bidrem1-5 |
| **JC0** | 주식선물 체결 | 주식선물 실시간 | price, basprice, openyak, theoryprice, sbasis, ibasis |
| **JH0** | 주식선물 호가 | 주식선물 호가 | 5호가 |
| **OC0** | KOSPI200 옵션 체결 | 옵션 실시간 | price, iv, greeks |
| **IJ_** | 지수 | 실시간 지수 | jisu, volume |
| **I5_** | ETF NAV | ETF 실시간 NAV (거래소 발행 iNAV, ~10초 주기) | nav, diff |

### I5_ (ETF iNAV) 사용

ETF주선교체 페이지에서 거래소 발행 iNAV를 EtfTick.nav로 채움. PDF 자체계산 NAV 인프라 (KOSPI/KOSDAQ TR 분류, 동적 t1102 등) 없이도 정확한 NAV 확보.

- 구독 경로: 프론트 `usePageInavSubscriptions` → `POST /realtime/subscribe-inav` → Rust SubCommand `SubscribeInav` → I5_ TR 구독
- 그룹: 별도 conn_id 300+ (stocks 그룹 200+와 분리)
- main.rs bridge에서 EtfTick 필드 merge로 S3_(price)와 I5_(nav)가 충돌 없이 공존

### FC0 (선물 체결) 주요 필드

종목차익에 핵심:
- `price` — 선물 현재가
- `ibasis` — 내재 베이시스
- `sbasis` — 스프레드 베이시스 (= 선물가 - 이론가)
- `theoryprice` — 이론가
- `k200jisu` — KOSPI200 지수
- `openyak` — 미결제약정
- `bidho1`, `offerho1` — 최우선 호가
- `cpower` — 체결강도 (%)
- `cgubun` — 매수/매도 구분

### JC0 (주식선물 체결) 주요 필드

LS 공식 C# 래퍼 `realtime_blocks.cs` 기준 — JC0 OutBlock에 FC0와 거의 동일한 필드가 옴:
- `price`, `basprice`(기초자산현재가) — 베이시스 계산
- `theoryprice`, `sbasis`, `ibasis`, `kasis`(괴리율) — 이론가/베이시스
- **`openyak`** — 미결제약정수량 (정수)
- **`openyakcha`** — 미결제약정 전일대비 증감 (정수, 음수 가능)
- `volume`, `cvolume`, `cgubun` — 체결량/구분

OI는 KRX가 매 체결마다 보내지 않고 분당 ~1회 스냅샷으로 갱신함. 1~5분 주기 모니터링 용도엔 충분.

### t8402 (주식선물 현재가 REST) OI 필드

초기값 fetch에 사용. 응답의 `t8402OutBlock`에:
- `mgjv` — 미결제약정수량 (= JC0 `openyak`)
- `mgjvdiff` — 미결제약정 전일대비 (= JC0 `openyakcha`)

JC0와 t8402가 **다른 키 이름**으로 같은 정보를 줌. realtime 서비스에서 둘 다 파싱해 `FuturesTick.open_interest` / `open_interest_change` 필드로 통합 송출.

## 제한 사항

- **무료** (무과금)
- TPS 제한: TR별로 1~10 TPS (WebSocket 스트리밍은 제한 없음)
- 토큰 매일 07:00 만료 → 자동 재���급 로직 필요
- 시뮬레이션 서버: `wss://openapi.ls-sec.co.kr:29443` (테스트��)
- **실시간 구독 상한: 연결당 ~200개** (문서 미기재, 실측). 초과 시 "정상처리" 응답은 오지만 데이터 미수신. 해��: 190개씩 분할하여 다중 WebSocket 연결 사용.
- **데이터 소스: KRX만**. NXT(넥스트레이드) 체결은 별도 TR 필요 (현재 미사용).

## LENS 활용 계획

- **종목차익 페이지**: FC0 (선물 체결) + IJ_ (지수) → 베이시스 실시간 모니터링
- **시세 페이지**: S3_/K3_ (주식 체결) + H1_/HA_ (호가) → 실시간 시세
- **내부망 전용**: 회사에서 LS증권 API 접근 가능 시 InternalAdapter에 연결
