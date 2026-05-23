# ls_data_test

LS증권 OpenAPI WebSocket 데이터 수신 테스트 서버. LENS와 완전 별개.

## 구조

```
ls_data_test/
├── src/
│   ├── main.rs       # 진입점 + 라우터 + SUBSCRIPTIONS 상수
│   ├── config.rs     # .env 로드
│   ├── auth.rs       # LS OAuth 토큰 취득/캐시
│   ├── ls_ws.rs      # LS API WS 연결 + 재연결 루프
│   ├── state.rs      # 공유 상태 + state updater 태스크
│   └── http_ws.rs    # 브라우저 WebSocket 핸들러
└── static/
    └── index.html    # 테스트 UI (순수 HTML)
```

## 실행

```bash
cd ~/projects/ls_data_test
cargo run
# 또는
cargo build --release && ./target/release/ls-data-test
```

브라우저: http://localhost:9100

## 구독 변경

`src/main.rs`의 `SUBSCRIPTIONS` 상수에서 Phase 주석 처리 해제.

```rust
const SUBSCRIPTIONS: &[(&str, &str)] = &[
    ("S3_", "005930"),  // Phase 1 (현재)
    ("H1_", "005930"),
    // ("K3_", "086520"),  // Phase 2 — 주석 해제해서 추가
    ...
];
```

## 검증 목표 (phase별)

| Phase | TR | 확인 항목 |
|---|---|---|
| 1 | S3_, H1_ | 연결·수신 기본 동작 |
| 2 | K3_, HA_ | KOSPI/KOSDAQ 동시 수신 |
| 3 | I5_ | ETF iNAV |
| 4 | JC0 | 주식선물 체결 |
| 5 | **JH0** | **10단 vs 5단** (LS doc=10, LENS code=5 — raw body 확인) |
| 6 | FC9/FH9 | 지수선물 체결/호가 |
| 7 | **IJ_** | **KOSDAQ150 tr_key** (001=KOSPI200, ???=KOSDAQ150) |

## 환경

| 항목 | 값 |
|---|---|
| 포트 | 9100 |
| LS WS | wss://openapi.ls-sec.co.kr:9443/websocket |
| 키 | .env LS_APP_KEY / LS_APP_SECRET (키A 사용) |
| 로그 | RUST_LOG=ls_data_test=debug |
