# ETF주선교체 (ETF Arbitrage)

ETF LP/MM 데스크 관점의 ETF 차익 스크리너 화면.
- 전체 상장 ETF (~585개)에 대해 PDF 구성종목 베이시스로 차익 기회 포착
- 호가/NAV 괴리 종합 분석 + LP가 maker/taker 입장에서 매매 시 기대이익

상세 인프라는 [realtime-service.md](realtime-service.md) 참조.

---

## 컬럼 구성 (15개)

| 그룹 | 컬럼 | 소스 / 공식 |
|------|------|------|
| **종목** | 종목 (이름/코드) | ETF 마스터 (`data/etf_info.xlsx`) |
| **거래** | 거래대금 | `stockTicks[code].cum_volume` (원, t1102 + S3_/K3_) — `5,300억`/`1,234만` 단위 |
| **가격** | 현재가 | `etfTicks[code].price ?? stockTicks[code].price` |
| | NAV | `etfTicks[code].nav` (외부망 I5_ TR / 내부망 real_nav) |
| **괴리 (호가 vs NAV)** | 현재 괴리 | `(현재가 - NAV) / NAV × 10000` bp |
| | 매도 괴리 | `(매도1호가 - NAV) / NAV × 10000` bp |
| | 매수 괴리 | `(매수1호가 - NAV) / NAV × 10000` bp |
| **차익 (PDF 베이시스)** | **차익bp** | `(콘탱고합 - 백워데이션합) / cuValue × 10000` |
| | f_nav | 차익 우세 방향에 유리한 선물가로 PDF 종목 재평가한 NAV |
| | nav 차이 | `f_nav - NAV` (원) |
| **매매이익** | 매매이익(자기) | maker 체결 시 fNav 대비 이익 (원) |
| | 매매이익(상대) | taker 체결 시 fNav 대비 이익 (원) |
| **PDF** | 선물비중 | 차익 대상 종목 가치 합 ÷ ETF 평가가치 (%) |
| | 선물수 | 필터 통과한 PDF 종목 수 |
| | 추이 | sparkline (5초 간격 history, 우세 측 한쪽만) |

---

## 부호 컨벤션 (페이지 전반 일관)

차익 방향과 색상이 직관적으로 매핑되도록:

| 부호 | 의미 | 색상 |
|---|---|---|
| **양수 (+)** | 매수차 우세 (콘탱고 강함) → ETF 매수 + 선물매도 차익 | 빨강 |
| **음수 (−)** | 매도차 우세 (백워데이션 강함) → ETF 매도 + 선물매수 차익 | 초록 |
| 0 / 작음 | 차익 미미 | 흰색/회색 |

차익bp / nav 차이 / 매매이익(자기·상대) / 추이 / 시계열차트 / Top10 차트 모두 이 규칙.

---

## 핵심 공식

### 1. PDF 차익 (diffBp)

```
buyFutSum  = Σ (콘탱고 종목: qty × max(0, fut - spot))    # 매수+선물매도 이득
sellFutSum = Σ (백워데이션 종목: qty × max(0, spot - fut)) # 매도+선물매수 이득
diffBp     = (buyFutSum - sellFutSum) / cuValue × 10000
```

`cuValue = nav × cu_unit` (1 CU의 평가가치, 원). 부호:
- `diffBp > 0`: 콘탱고가 백워보다 큼 → 매수차 우세
- `diffBp < 0`: 백워가 콘탱고보다 큼 → 매도차 우세

### 2. f_nav (favorable NAV)

차익 방향 가정 하에, 유리한 선물가로 종목 재평가한 NAV.
```
basket = pdf.cash + Σ (qty × adjustedPrice)
adjustedPrice = {
  diffBp > 0 (매수): 콘탱고 종목은 fut(>spot)로 평가 → NAV 상승
  diffBp < 0 (매도): 백워데이션 종목은 fut(<spot)로 평가 → NAV 하락
  else:        spot
}
f_nav = basket / cu_unit
```

거래소 iNAV는 spot 기준이라 차익 방향을 반영하지 않음. f_nav는 "지금 차익 잡으면 이 가격이 fair" 라는 LP 관점 NAV.

### 3. 매매이익

LP가 호가에 fill됐을 때의 fNav 대비 이익 (원). 통일 공식 `fNav - 체결호가`:

| 시나리오 | 자기호가 (maker) | 상대호가 (taker) |
|---|---|---|
| 매도 우세 (diffBp < 0): ETF 매도 | `fNav - ask1` ← 음수 클수록 이익 | `fNav - bid1` ← 음수 클수록 이익 |
| 매수 우세 (diffBp > 0): ETF 매수 | `fNav - bid1` ← 양수 클수록 이익 | `fNav - ask1` ← 양수 클수록 이익 |

매도 시나리오: ask1 > fNav면 fNav 대비 비싸게 판 셈 → 음수 큰 = 좋음
매수 시나리오: bid1 < fNav면 fNav 대비 싸게 산 셈 → 양수 큰 = 좋음

---

## 데이터 소스

### 마스터 (정적)
- `data/etf_info.xlsx` — ETF 마스터 + PDF 구성종목 (qty, cu_unit, cash)
- 백엔드 `/api/etfs`, `/api/etfs/pdf-all` 노출
- 종목코드는 'A' 접두 제거하여 6자리로 정규화

### 실시간 구독
페이지 mount 시 자동 구독, unmount 시 자동 해제 ([realtime-service.md](realtime-service.md)의 페이지 lifecycle 패턴).

| 종류 | 엔드포인트 | TR | 대상 |
|---|---|---|---|
| 주식/ETF 가격 | `/realtime/subscribe-stocks` | S3_/K3_ | ETF 자체 + PDF 구성종목 + 선물 front (mock 호환) |
| ETF iNAV | `/realtime/subscribe-inav` | I5_ | ETF 마스터 전체 (~585) |
| 호가 5단 | `/realtime/orderbook/subscribe-bulk` | H1_/HA_ | ETF 마스터 전체 |

신규 코드 구독 시 백엔드가 t1102 REST fetch도 자동 트리거 → 장 외/재시작 직후에도 마지막 종가 즉시 표시.

---

## UI 구조

### 상단 영역
- **필터 패널** (접기/펴기 토글 + localStorage 저장)
  - 선물거래량 (입력 + 빠른 버튼 100/1,000/전체)
  - |차익bp| (입력 + 빠른 버튼 10/30/전체)
  - |매매이익(자기)| (입력 + 빠른 버튼 10/30/전체)
  - 적용된 필터 개수 + 초기화 버튼
- **차트 패널** (접기/펴기 토글, 3분할 같은 높이)
  - 좌: Top 10 차익 (매수차 빨강 / 매도차 초록 분리, 각자 내림차순)
  - 중: 시계열 (선택 ETF 차익bp 추이, 우세 측 area+line, 5초 간격 누적)
  - 우: 호가 5단 (선택 ETF, 현재가 매칭 호가 흰색 ring 하이라이트, 매도/매수 잔량 분리)

### 메인 테이블
- `table-fixed` + 헤더별 명시 너비 → 값 변동에도 컬럼 폭 고정
- 종목 컬럼 sticky-left (가로 스크롤 시 고정)
- 모든 컬럼 정렬 가능 (▲/▼ 토글, 같은 컬럼 재클릭 시 방향 반전)
- 펼침 패널 열린 동안 행 순서 freeze (사용 토글로 metric 흔들려도 위치 고정)

### 펼침 패널 (행 클릭)
- PDF 종목별 spot/선물가/베이시스 + 사용 토글 (특정 종목 차익에서 제외)
- 메트릭 요약: 선물대체 매수차/매도차 + 차익bp

---

## 성능 최적화

585행 × 14컬럼 + 매 tick마다 derived 컬럼 재계산 부담 → 다층 방어:

| 단계 | 적용 | 효과 |
|---|---|---|
| WS ingestion 배치 | `useWebSocket` requestAnimationFrame 배치 (기존 인프라) | 60Hz cap |
| 200ms tick throttle | `setInterval` 200ms로 store snapshot → metricsByCode/charts 5Hz 갱신 | 매 tick 17K iter → 5Hz cap (CPU 80%↓) |
| Sparkline `React.memo` + path `useMemo` | 같은 history reference면 SVG path 재계산/렌더 skip | 585 SVG × 매 렌더 → push마다만 (5초) |
| 차트 `React.memo` (TopBar/TimeSeries/Orderbook) | 부모 렌더 무관 props 비교만 | 불필요 재렌더 차단 |
| ETF row freeze (펼침 중) | sortKey 변경 또는 펼침 닫힘 전까지 행 순서 캡처 | 사용 토글이 정렬 흔들지 않음 |
| 가상화 | 미적용 (1+2+3+4로 충분) | 필요 시 `@tanstack/react-virtual` 도입 가능 |

---

## NAV 계산 정책 (트레이드오프)

| 모드 | NAV 소스 | 비고 |
|---|---|---|
| 외부망 (ls_api) | LS API I5_ TR (거래소 발행 iNAV) | 10초 주기. 공식. ETF 리밸런싱 자동 반영 |
| 내부망 (internal) | 회사 서버 real_nav (rnav_trade / iNAV fallback) | 더 fresh (밀리초). 자체 계산 |
| Mock | PDF basket 합 / cu_unit | f_nav와 동일 입력 → 검증 일관성 |

자체 계산(PDF 합산) 방식도 가능하지만 외부망에선 KOSPI/KOSDAQ TR 분류, 신규 코드 t1102 fetch 등 인프라가 무거워 거래소 iNAV 사용. f_nav 컬럼이 그 갭을 메움 — 차익 방향 가정 하의 fair NAV.

---

## Mock 데이터 동작

`FEED_MODE=mock` 시:
- 백엔드 `/api/etfs/pdf-all` 가져와 PDF 매핑 보유 → ETF NAV를 PDF basket 합으로 일관 계산 (랜덤 NAV와 fNav가 따로 노는 문제 회피)
- 가격 random walk: gauss std 0.5bp + KRX 호가단위 snap + base 평균회귀 0.5% → 거의 안 움직이거나 ±1틱
- 선물 베이시스: 코드별 결정적 1/3 콘탱고/백워/근사0 → 차익bp 다양성
- 동적 구독: 코드별 5% 샘플만 매 0.5초 walk (3000개 동시 갱신 회피)
- 초기 burst: 50개씩 batch + 50ms sleep으로 점진 emit (브라우저 끊김 방지)
- 모드 전환 시 broadcaster cache `clear_cache()` 호출 → mock 잔재가 ls_api/internal로 누수 안 됨
