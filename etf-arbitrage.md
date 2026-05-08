# ETF주선교체 (ETF Arbitrage)

ETF LP/MM 데스크 관점의 ETF 차익 스크리너 화면.
- 전체 상장 ETF (~585개)에 대해 PDF 구성종목 베이시스로 차익 기회 포착
- 호가/NAV 괴리 + 종목 단위 매수차/매도차 + 호가 기반 실집행 차익 종합 분석
- 사용자가 PDF 종목별 V=O 토글로 "어느 종목을 선물로 헤지할지" 시뮬레이션

상세 인프라는 [realtime-service.md](realtime-service.md) 참조.

---

## 변수명 (학계 표준)

| 변수 | 의미 |
|---|---|
| **S** | 현물가 (spot) |
| **F** | 선물 시장가 (futures market) |
| **N** | 이론가 (theoretical forward) = `S × (1 + r·d/365)` (배당 미반영 cost-of-carry) |
| **M** | 만기 이전 배당락 합산 금액 (배당 차감용) |
| **Q** | 시장 베이시스 = `F − S` |
| **P** | 이론 베이시스 = `(N − S) − M` (배당 종목은 −M 추가 차감) |
| **R** | 베이시스 갭 = `Q − P` = `F − N + M` (선물이 이론보다 비쌈/쌈) |
| **T** | 갭 BP = `R / N · 10000` |
| **H** | 비중 = `S·D / (Σ(S·D) + cash)` |
| **D** | 1 CU 종목 수량 |

종목별 우호 방향:
- **R > 0** → 선물이 이론보다 비쌈 → **매수차 우호** (선물 매도 이득)
- **R < 0** → 선물이 이론보다 쌈 → **매도차 우호** (선물 매수 이득)

---

## 부호 컨벤션 (페이지 전반 일관)

**매수차 = +, 매도차 = −**. 혼합 모드에서 부호 한 번에 우세 방향 보임.

| 부호 | 의미 | 색상 |
|---|---|---|
| 양수 (+) | 매수차 우세 | 초록 (#00b26b) |
| 음수 (−) | 매도차 우세 | 빨강 (#bb4a65) |
| 0 / 작음 | 차익 미미 | 흰색/회색 |

차익bp / 매수차BP / 매도차BP / 실집행BP / 갭BP / 기여BP / 추이 / 차트 모두 이 규칙.

---

## 차익 모드 (arbMode)

사용자가 어느 차익 거래를 노릴지 선언. 한 ETF는 한 시점에 한 방향만 거래 가능.

| 모드 | V=O 가능 종목 | ETF 차익BP 부호 | 거래세 적용 |
|---|---|---|---|
| **매수차** | R>0 종목만 | ≥ 0 | 종목 매도세 0.20% |
| **매도차** | R<0 종목만 | ≤ 0 | 0 (정리시 매수라 매도세 미발생) |
| **혼합** | 양방향 모두 | 합산 (부호로 우세 표시) | R>0 종목에만 매도세 |

V=O 가능 종목은 자동 필터링 — 모드와 우호 방향 불일치하는 종목의 사용 체크박스는 disabled.

---

## 컬럼 구성 (메인 테이블 17개)

| # | 컬럼 | 공식 / 출처 |
|---|---|---|
| 1 | 종목 (이름/코드, sticky-left) | ETF 마스터 |
| 2 | 거래대금 | `cum_volume` (5,300억 단위) |
| 3 | 현재가 | `etfTicks[code].price ?? prev_close` |
| 4 | rNAV | `(Σ(S·D) + cash) / CU` |
| 5 | fNAV | `(Σ(Z·D) + cash) / CU`, Z = V=O면 F, 아니면 S |
| 6 | 현재 괴리 | `(price − NAV) / NAV · 10000` bp |
| 7 | 매도 괴리 | `(ask1 − NAV) / NAV · 10000` bp |
| 8 | 매수 괴리 | `(bid1 − NAV) / NAV · 10000` bp |
| 9 | **매수차BP** | `Σ_{R>0, V=O} (T − slip − tax) · H` ≥ 0 |
| 10 | **매도차BP** | `Σ_{R<0, V=O} (T + slip) · H` ≤ 0 |
| 11 | 차익bp | `매수차BP + 매도차BP` (혼합에서 부호로 우세 방향) |
| 12 | **실집행차익(원)** | per-share, ETF 호가 vs fNAV (매수차는 매도세 차감) |
| 13 | **실집행BP** | `realProfitWon / rNAV · 10000` |
| 14 | **배당수** | 만기 이전 배당락 종목 수 |
| 15 | 선물비중 | V=O 종목 G 합 / rNAV_total · 100 |
| 16 | 선물수 | V=O 종목 수 |
| 17 | 추이 | sparkline (차익bp 5초 간격 history) |

---

## 핵심 공식

### rNAV / fNAV

```
rNAV = (Σ(S_i · D_i) + cash) / CU         # PDF 기준 NAV (현물)
fNAV = (Σ(Z_i · D_i) + cash) / CU         # 선물대체 NAV
  Z_i = F_i if V_i=O else S_i             # V=O 종목은 선물가, V=X면 현물가
```

ETF 거래소 iNAV는 spot 기준이라 차익 방향 반영 X. fNAV는 "지금 차익 잡으면 이 가격이 fair" LP 관점 NAV.

### 매수차BP / 매도차BP (per-stock 기여 합산)

V=O인 종목들에 대해 비중 가중 합:
```
종목 i 기여 BP =
  R_i > 0 (매수차 우호): (T_i − slip − tax) · H_i      # 매도세 차감
  R_i < 0 (매도차 우호): (T_i + slip) · H_i            # 매도세 0
  V=X 또는 R=0:           0

매수차BP = Σ_{R>0, V=O} 기여
매도차BP = Σ_{R<0, V=O} 기여
차익BP   = 매수차BP + 매도차BP
```

ground truth로는 `(fNAV − rNAV) / rNAV · 1만`이 직접 차익이지만, per-stock 합산은 비중·이론가 가중 차이로 수십 BP 오차. 종목별 토글 의사결정엔 per-stock 기여 BP가 더 직관적이라 화면에선 후자 사용.

### 실집행차익 (ETF 호가까지 포함)

per-share 단위 (ETF 1주 거래 시 기대 수익):
```
ETF 매도가 / 매수가 = quoteMode 따라:
  현재가  : price
  자기호가: ETF 매도시 ask, 매수시 bid (호가 걸기)
  상대호가: ETF 매도시 bid, 매수시 ask (호가 hit, 디폴트)
  중간가  : (bid + ask) / 2

매수차 (ETF 매수 + 종목 바스켓 매도):
  실집행차익 = fNAV·(1 − tax) − ETF_buy
  (종목 매도세 0.20% 차감)

매도차 (ETF 매도 + 종목 바스켓 매수):
  실집행차익 = −(ETF_sell − fNAV)
  (ETF 거래세 0, 종목 매수도 거래세 0)

실집행BP = realProfitWon / rNAV · 10000
```

부호 통일: 매수차 양수, 매도차 음수.

### 종목별 갭 BP / 기여 BP

```
N_i = S_i · (1 + r·d/365)                 # 이론가 (배당 미반영)
P_i = (N_i − S_i) − M_i                    # 이론베이시스 (배당 차감)
R_i = F_i − N_i + M_i                      # 베이시스 갭
T_i = R_i / N_i · 10000                    # 갭 BP

기여_i = (T_i − sign·slip − sign·tax_buy) · H_i
  sign = +1 if R>0, -1 if R<0
  tax_buy = taxBp if R>0 else 0  # 매수차 종목만 매도세
```

---

## 입력 (상단바)

| 입력 | 의미 | 디폴트 |
|---|---|---|
| 차익 방향 | 매수차/매도차/혼합 | 혼합 |
| 호가 기준 | 현재가/자기호가/상대호가/중간가 | 상대호가 |
| 슬리피지 | bp 단위, V=O 종목 균일 차감 | 0 |
| 금리 | %, 이론가 cost-of-carry용 | 2.8 (종목차익과 동일) |
| 거래세 | 표시 전용 (제도 변경 시 코드 상수 변경) | 0.20 |
| 누락한도 | %, 누락 비중 초과 시 fNAV/실집행 컬럼 흐림 | 1 |

모두 localStorage 영속.

상단 필터 quick 버튼 (100+, 1,000+, 10+, 30+, 1+, 10+) 은 토글식 — 활성 상태에서 다시 누르면 조건 해제.

---

## 데이터 누락 처리

외부망(LS API)에서 t1102 5xx 오류로 일부 종목(특히 잡주)이 빠지는 케이스 → 그 ETF의 fNAV/실집행 의심값 발생. 자동 흐림 처리.

### 누락 비중 산출

```
missingWeight = Σ(prev_close × qty for S=0 종목) / 전체 추정
  전체 추정 = rNAV_total + missingValueEstimate
  prev_close는 NAV 표시값 X, 누락 비중 추정에만 사용 (장중에 어제값 NAV로 쓰지 않는 정책)
```

### 처리

- `missingWeight > 누락한도(%)` → ETF 행에 다음 적용:
  - fNAV / 실집행차익 / 실집행BP 컬럼 "—" 표시 (의심값 가림)
  - 행 opacity 60%
  - hover tooltip: 누락 비중 %
- 매수차BP / 매도차BP는 그대로 (V=O 종목들 데이터는 살아있어 합산 정확)

### Mode-aware 자동 동작

- 외부망: 잡주 누락 발생 → trigger
- 내부망: 데이터 완전 → missingWeight ≈ 0 → 자동 비활성, 모든 ETF 정상 표시
- 명시적 모드 분기 X — 누락 0%면 어떤 임계값이든 안 걸림

---

## 비차익 ETF 분류 (레버리지/인버스/채권/혼합 등)

PDF 현물 바스켓을 개별주식선물로 대체하는 차익은 **현물 1× ETF에서만 의미**. 다른 유형은 자체 NAV 산출 자체가 깨짐 (PDF에 지수선물 라인이 들어가는데 일중 평가는 전일정산가 필요, 인버스는 PDF가 빈 껍데기, 채권형은 채권 시세 피드 별개 등).

**Backend 분류** — `backend/routers/etfs.py::_is_arbitrable(group, name)`:
- 그룹이 `주식-`로 시작하지 않으면 false (채권-/혼합-/통화-/원자재-/부동산/기타)
- 종목명에 `레버리지`/`인버스`/`2X`/`3X`/`선물`/`커버드콜` 포함 시 false
- `/etfs`, `/etfs/pdf-all`, `/etfs/{code}/pdf` 응답에 `arbitrable: bool` 포함

총 589개 중 **차익 361 / 비차익 228**. 비차익 예: KODEX 레버리지(122630), KODEX 인버스(114800), KODEX 200선물인버스2X(252670), KODEX 200롱코스닥150숏선물(360140), TIGER 미국나스닥100ETF선물(483240), TIGER 200커버드콜(289480), 채권/혼합/통화/원자재/부동산 ETF 전부. 커버드콜은 옵션 매도 프리미엄을 더해 NAV가 단순 현물 합산과 달라 PDF 기반 차익 산출 부정확.

**Frontend UI** — `etf-arbitrage.tsx`:
- `EtfMaster.arbitrable` 누락 시 true 폴백 (구버전 백엔드 호환)
- ArbRow `dim = nonArb || tooMissing` 통합:
  - **차익 컬럼만 흐림 + `—`**: fNAV/매수차BP/매도차BP/차익bp/실집행차익/실집행BP/배당수/적용%/선물수/추이
  - **정상 표시**: 거래대금/현재가/현재괴리/매도괴리/매수괴리 (라이브 NAV 기준 bp)
- **rNAV 컬럼 듀얼 표시**:
  - 차익 ETF → `m.rNav` 자체 산출 (`(SUM(S·D)+현금)/CU`)
  - **비차익 ETF → `m.nav` 라이브 NAV (I5_ feed)**
  - 누락 임계 초과 시만 `—` 흐림. 정렬도 동일 분기 (같은 가격 단위라 비교 자연)
- 정렬 시 차익 컬럼(`fNav`/`diffBp`/`buyArbBp`/`sellArbBp`/`realProfit*`/`dividendN`/`appliedPct`/`futuresCount`)에선 비차익 ETF 무조건 끝으로

---

## Fetch 우선순위 (외부망 t1102)

LS API TPS 10 한도라 1700+ PDF 종목 초기 fetch에 ~3.5분. 활발한 종목 빨리 도착하도록 다층 우선순위.

### 1. ETF PDF 마스터 확장 (Backend startup)

`futures_master.json`은 **주식선물 발행된 250개**만 등록 → ETF PDF 잡주 1700개가 백그라운드 sweep 대상에서 빠짐 → 사용자가 페이지 켜둬도 못 받음, 클릭하면 그제야 PrioritizeStocks로 받는 현상 발생.

**해결** (`realtime/src/main.rs::load_etf_pdf_extra_codes`):
- realtime 시작 시 backend `/api/etfs/pdf-all` HTTP GET (5초 타임아웃)
- ETF + PDF stocks union 추출 → 6자리 영숫자만 필터 (`is_six_alnum` — 'CASH'/9자리 선물코드 배제)
- 마스터 미포함 종목만 `MasterShared.etf_pdf_extra_codes`로 보관 (~1727개)
- backend 미가동/실패 시 빈 Vec 폴백 (graceful degradation)
- LsApiFeed 시작 5초 후 별도 task로 백그라운드 t1102 sweep 실행 (fixed sweep과 토큰 경합 회피)
- 같은 `fetched_stocks`/`failed_stocks` Arc 공유 → SubscribeStocks 핸들러가 사용자 진입 시 skip
- WS subscribe는 안 함 (KOSDAQ 분류 없어 S3_/K3_ 잘못 보낼 위험) — 실시간 tick은 사용자 진입 시 SubscribeStocks가 추가
- 효과: 시작 후 ~7분 만에 1977개 중 97.7% (1932) 가격 보유, 사용자 ETF 페이지 진입 시 즉시 표시

### 2. ETF 거래량 정렬 (Frontend)

- localStorage `etf.volumeCache.v1` — ETF별 cum_volume 30초마다 누적 저장
- mount 시 `stockSubscriptionCodes` useMemo가 캐시 기반 ETF 거래량 desc 정렬
- 정렬된 ETF 순으로 PDF 종목 + 선물 front 추가 (Set dedup)
- 첫 mount 후 30초~1분 누적 → 다음 mount부터 효과
- 효과: KODEX 200 같은 활발한 ETF의 PDF가 큐 앞으로 → 체감 빠른 도착

### 3. 종목 거래대금 정렬 (Backend, `volume_cache.rs`)

- t1102 응답의 `value`(당일 거래대금) 자체 piggyback 저장
- `data/stock_volumes.json`에 1000건 단위 incremental save
- 다음 launch 시 master 로더가 `ordered_stock_codes`를 거래대금 desc 정렬
- LS API 추가 호출 0, 디스크 IO 무시 수준
- Backend의 초기 sweep 자체 우선순위 — Frontend 정렬과 협력 (동일 코드 cache hit 무중복)

### 4. ETF 클릭 즉시 우선화

- 사용자가 ETF 행 클릭(펼침) → 프론트가 `POST /realtime/prioritize-stocks` { codes: [ETF, PDF종목들...] }
- 백엔드 `SubCommand::PrioritizeStocks` 핸들러:
  - fetched_stocks에 있는 코드 skip
  - 나머지 코드로 즉시 별도 task spawn → `fetch_stocks_initial`
  - 기존 sweep과 잠시 TPS 경합하지만 클릭당 ~50종목/5초 burst라 abuse 신호 미달
- 효과: 클릭 후 5초 안에 그 ETF의 PDF 종목 가격 도착

### 5. 실패/pc-only 재시도 worker (Backend)

- **5xx/no_data**: 일시 장애 — `failed_stocks`에 등록, 60초 cycle worker가 재시도
- **pc_only**: 거래대금 0이지만 전일종가 있는 잡주 — `prev_close` 폴백으로 emit (price=0)하되 **fetched 등록 X, failed에 등록**. 거래 발생 즉시 retry로 정상 가격 갱신.
- worker는 phase-active 시점에만 동작 (Sleep phase 자정 LS 점검 충돌 회피)
- 로그: `t1102 retry: K/N recovered (남음 M)`

### 종합 도착 시점 예측

- 메이저 ETF 종목 (KOSPI200 등): 첫 mount 후 30초~1분
- 중대형주 (코스피 50): 1~3분
- ETF PDF 잡주: 시작 후 ~7분 (마스터 확장 효과). 이후 페이지 진입 시 즉시
- 사용자가 클릭한 ETF: 5초 burst 내

---

## 만기 d / 배당 처리

**d (잔존 일수)**: `today - futures_master.front.expiry`로 매번 직접 계산.
- `futures_master.json`의 `days_left` 필드는 JSON 생성 시점 박힌 stale 값이라 무시.
- KST 기준 today (`todayKst()` 헬퍼) 사용 — UTC 자정 후 9시간 동안 어제 날짜 반환되는 버그 회피.

**배당 (M)**: `[today, futures.expiry]` 윈도우 안 ex_date 합산.
- 오늘 ex_date 포함 (종목차익과 일관). 장 시작 전 spot이 어제 종가라 차감 필요.
- 장중엔 spot 자체에 배당락 반영되어 약간 이중 차감 가능하지만, 빠뜨리는 위험보다 작음.
- 배당 데이터: `/api/dividends?from_date=today&include_estimates=true` (확정 + 추정 모두).
- 배당 페이지 DetailPanel과 동일 형식의 hover 툴팁 (ex_date / period / amount / yield / record_date / announced_at).
- `confirmed=true` (DART 공시) → 초록, `confirmed=false` (LENS estimator) → 오렌지 마커.

---

## PDF 펼침 패널 (행 클릭)

종목 단위 차익 정보 + V=O 토글 워크플로우.

### 메타 strip
`PDF 기준일 · CU · 현금 · 종목 수 · 만기 N일 · 배당 N종`

PDF 기준일 = `data/etf_info.xlsx`의 "날짜" 컬럼 (ETF 발행사가 산출한 PDF의 기준일). 매일 갱신해야 정확하지만 실제로 PDF는 주 1회 정도만 변경되니 7일 stale 무방. 만기 잔존일과 배당 윈도우는 today 기준으로 항상 정확.

### PDF 행 (15컬럼, 모두 정렬 가능)

| # | 컬럼 | 공식 |
|---|---|---|
| 1 | 코드 | 6자리 |
| 2 | 종목명 | |
| 3 | 1CU 수량 | D |
| 4 | 비중 | H × 100% (mini bar 시각화) |
| 5 | 배당 | M (확정 초록 / 예상 오렌지 / 혼합 흰색+배지, 호버 툴팁) |
| 6 | 현물가 | S |
| 7 | 선물가 | F |
| 8 | 이론가 | N |
| 9 | 시장베이시스 | Q = F − S |
| 10 | 이론베이시스 | P = (N−S) − M |
| 11 | 갭 | R = F − N + M (원) |
| 12 | 갭BP | T (매수차+ 매도차− 부호) |
| 13 | 거래량 | 선물 일중 누적 |
| 14 | 기여BP | (T ± slip − tax_buy) · H, V=O일 때만 |
| 15 | 사용 | V=O/X 체크박스 (모드와 우호 방향 불일치 시 disabled) |

### 행 색상

- V=O 적용 (사용중): 우호 방향 색조 약하게 (R>0 초록 tint, R<0 빨강 tint)
- 모드 불일치 / 선물 없음: opacity 40% (회색)
- hover 시 살짝 밝아짐

---

## 데이터 소스

### 마스터 (정적, mount 시 1회)
- `/api/etfs` — ETF 마스터 + cu_unit
- `/api/etfs/pdf-all` — PDF 구성종목 (qty, cash) — `data/etf_info.xlsx` 파싱
- `/api/arbitrage/master` — 선물 마스터 (front.expiry/code/multiplier)
- `/api/dividends?from_date=today&include_estimates=true` — 배당 (380~ 종목)

### 실시간 구독 (mount 시 자동, unmount 시 자동 해제)
| 종류 | 엔드포인트 | TR | 대상 |
|---|---|---|---|
| 주식/ETF 가격 | `/realtime/subscribe-stocks` | S3_/K3_ | ETF 자체 + PDF 종목 + 선물 front |
| ETF iNAV | `/realtime/subscribe-inav` | I5_ | ETF 마스터 전체 (~585) |
| 호가 5단 | `/realtime/orderbook/subscribe-bulk` | H1_/HA_ | ETF 마스터 전체 |

상세는 [realtime-service.md](realtime-service.md) 페이지 lifecycle 패턴 참조.

---

## TopBarChart (Top 7)

차익 모드별:
- **매수차 모드**: PDF에 매도차 우호 종목 있어도 매수차 기회만 합산. `buyArbBp` Top 7
- **매도차 모드**: 매도차 기회만 합산. `sellArbBp` Top 7 (절댓값 큰 순)
- **혼합 모드**: `buyArbBp` Top 7 + `sellArbBp` Top 7 (양쪽 동시 표시 — 같은 ETF가 양쪽 후보 가능)

---

## 성능 최적화

585행 × 17컬럼 + per-tick derived 계산. 1500/sec WS + 13K DOM + 필터·체크박스 cascade로 멈춤 발생 → 다층 방어:

| 레이어 | 적용 | 효과 |
|---|---|---|
| 서버 batch envelope | Rust bridge 150ms drain → `{type:'batch',ticks:[...]}` 한 번 broadcast | 1500/sec → 6/sec WS 프레임. dedup |
| 200ms tick throttle | `setInterval` 200ms로 store snapshot | 60Hz → 5Hz cap |
| `metricsByCode` ref-stable cache | 19필드 shallow-equal, 동일 시 이전 ref 재사용 | ArbRow memo 효과 |
| base + excluded overlay 분리 | baseMetricsByCode 전체 + metricsByCode excluded만 override | 사용 토글 ~50ms → ~5ms |
| ArbRow / ArbC / PdfRow `memo` | 행/셀 추출 + useCallback ref 안정화 | 변동 행만 reconcile |
| `<tr>` `transition-colors` 제거 | hover/select 150ms paint cascade 차단 | sticky 좌측 paint 줄임 |
| 차트 패널 `contain: paint` | TopBar/TimeSeries/Orderbook 격리 | 패널 간 독립 |
| 가상화 (`@tanstack/react-virtual`) | vRows = 메인+펼침 평탄화, 보이는 ~30행만 DOM | **13K → ~700 DOM**. 즉시 응답 |
| Sparkline `React.memo` | history ref 동일 시 SVG 재계산 skip | |
| ExpandedPanel: store 직접 구독 제거 | `stockTicks`/`futuresTicks` prop drilling | 펼침 시 50Hz → 5Hz |
| `mergeStockTick` alloc 제거 | 배열 spread/filter → 명시 비교 | GC 압박 ↓ |

---

## NAV 계산 정책

| 모드 | NAV 소스 | 비고 |
|---|---|---|
| 외부망 (ls_api) | LS API I5_ TR | 10초 주기, 거래소 발행 |
| 내부망 (internal) | 회사 서버 real_nav | 밀리초 단위, 자체 산출 |
| Mock | PDF basket / cu_unit | f_nav와 동일 입력 |

자체 PDF 합산도 가능하지만 외부망에선 KOSPI/KOSDAQ TR 분류, 신규 코드 t1102 fetch 등 인프라 부담으로 거래소 iNAV 사용. fNAV 컬럼이 그 갭 메움 — 차익 방향 가정 fair NAV.

---

## Mock 데이터

`FEED_MODE=mock`:
- 백엔드 `/api/etfs/pdf-all` 가져와 PDF 매핑 → ETF NAV를 PDF basket 합으로 일관 계산
- 가격 random walk: gauss std 0.5bp + KRX 호가단위 snap + base 평균회귀 0.5%
- 선물 베이시스: 코드별 결정적 1/3 콘탱고/백워/근사0
- 동적 구독: 코드별 5% 샘플만 매 0.5초 walk
- 초기 burst: 50개씩 batch + 50ms sleep
- 모드 전환 시 broadcaster cache `clear_cache()` → mock 잔재 누수 방지
