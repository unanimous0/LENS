# LENS LP Design — 설계 단일 진실원

LENS가 ETF LP 시그널 대시보드로 전환하는 작업의 **현재까지 합의된 방향성 + 향후 작업 기준**.
CLAUDE.md와 함께 읽을 것. 살아있는 문서 — 합의가 갱신되면 여기에 반영.

> 참고용과 구분: `docs/ETF Market Making Plans/` 폴더(00_OVERVIEW + Phase1~5 + 데이터모델 + 리스크 + 사용자 작성 PDF)는 **참고 자료**이고, 거기 적힌 기술 스택·phase 구성을 그대로 베끼지 않음. 이 문서가 실행 기준.

> **LS API 의문 시 절차**: `docs/ls_api_guide/ls_api_full.md` (365개 TR 자동 추출본)를 먼저 grep. PDF 별도 다운로드 금지 — `grep -A 50 "^### FC9 " docs/ls_api_guide/ls_api_full.md` 식으로. 누락 TR 의심 시 같은 파일 상단 누락 표가 단일 진실원. (CLAUDE.md 작업 규칙에 동일 명시)

---

## 1. 사용자 입장 / LENS 정체성

**사용자 (`[[user_role]]`)**: 국내 증권사 ETF LP. 명목상 LP, 실운영은 "기회 보일 때만 호가 대는 차익거래자" 수준. 10여 종목 협소 운영 → 광범위 ETF에 실제 호가/대량 체결을 만드는 진정한 LP로 전환 의지.

**LENS의 역할 전환 (`[[project_lens_lp_pivot]]`)**: 일반 데이터 대시보드 → **LP 운영을 받쳐주는 시그널 대시보드**. "보는 도구"가 아니라 "호가·헤지·보유 결정을 내리게 만드는 도구".

**스코프 안 / 밖**:
- 안: 시그널·fair value·리스크 가시화, 외부 플로우 탐지, 호가 결정 보조
- 밖: OMS 인프라 자체, μs 단위 latency 경쟁, 순수 passive HFT

---

## 2. 현재 운영의 문제 진단

사용자 작성 PDF의 핵심을 LENS 관점에서 정리:

**한 줄 진단**: "괴리 발견 → 즉시 정리(당일 0)" 모드 — LP가 아니라 "체결되면 빨리 없애는 재고 정리". 손실 회피에는 유리하나 LP 경제성을 거의 못 씀.

**근본 문제는 "측정 부재"** (기회 부족 X). 4가지가 안 보임:
1. 지금 호가가 좋은 가격인지 (체결 전 기대 이익)
2. 체결 후 북 전체가 어느 팩터에 노출됐는지
3. 헤지 비용 감안 후 남는 이익
4. 오늘 손익 분해 (스프레드 / 재고 / 헤지비용 / 베이시스)

**파생 문제**: 바스켓 헤지 가능한 곳에만 호가 → 거래량 적음 → 역선택 노출 → 더 보수적 → 악순환. ETF별로만 보고 **북 전체를 못 봄** (넷팅·상대가치·보유 선택권 미활용).

---

## 3. 가고 싶은 방향

**축 전환**: 개별 ETF flat → **데스크 전체 residual risk가 limit 안**.

- 여러 ETF + 헤지 수단을 하나의 북으로 묶어 통합 관리
- 베이시스 차익 + 통계적 차익을 같이 굴림
- 설정·환매는 마감 절차 아닌 **여러 정리 수단 중 가장 싼 옵션**
- 토대는 **자체 Fair Value 체계** — 시장 관점 + 북 전체 관점 둘 다

**실행 첫 4개 숫자 (PDF가 정한 운영 입력)**:

| # | 지표 | 용도 |
|---|---|---|
| 1 | 자체 기준가 ↔ 현재가 (실시간 괴리) | 호가 결정 |
| 2 | 베타조정 델타 | "지금 얼마나 열려 있나" |
| 3 | 잔차위험 | 팩터 헤지 후 남는 종목 고유 위험 |
| 4 | 손익 분해 | 오늘 무엇이 돈을 벌었나 |

→ LENS 현재 상태: #1 일부(iNAV, rNAV, 괴리bp) 보유. **#2·#3·#4는 0% — 새로 만들어야 함**.

---

## 4. LP 핵심 명제 — 대화에서 도출

> **"누구보다 정확하고 빠르게 fair value를 계산하는 하우스가 이긴다."**

이 명제의 정확한 해석:

- **정확도** = 앵커 수 + 입력 데이터 신선도(PDF·베이시스·캐리·추적오차)
- **속도** = 매 틱 m×n 재계산이 호가 라이프사이클 안 (ms 단위, μs는 아님)
- 정확도와 속도는 일부 trade-off — 어디서 멈출지가 설계 결정

**Fair value는 단수가 아니라 헤지 수단의 함수**:

같은 ETF — KODEX 200 예 — 도 fair value가 단수형이 아님:

| 헤지 경로 | fair value 결정 요인 |
|---|---|
| 지수선물(K200F) | 선물가 − 베이시스 ± 캐리 |
| 구성종목 바스켓 | Σ(PDF 수량 × 종목 현재가) + 거래비용 |
| **PDF 종목 중 주식선물 가능한 부분** | Σ(주식선물가 × 비중) + 선물별 베이시스 + 잔여 종목 노출 |
| 상관 ETF (같은 지수 추적) | 상대 ETF 가격 + 추적오차 + 상대 ETF 자체 괴리 |
| 옵션 합성 (콜−풋) | 합성가격 + 변동성 비용 |
| **조합** (선물 70% + 상관 ETF 30% 등) | 가중평균 + 조합 잔차위험 |

같은 시점에 **N개의 fair value가 동시 존재**. 호가 결정 = "현재가 vs {가장 싼 헤지 경로의 fair value} 차이가 호가 갭보다 크냐". "가장 싼"은 거래비용 + 슬리피지 + 추적오차 + 캐리 + **자본비용**(margin offset 포함).

→ m개 ETF × n개 헤지 수단 → **매 틱 m×n 매트릭스 갱신**. 이게 LENS Rust-first의 정확한 의미.

---

## 5. 자산군 / 헤지 수단 풀

LP 대상 ETF의 fair value·헤지·호가 인풋으로 활용:

| 자산군 | 역할 | LENS 데이터 상태 |
|---|---|---|
| **주식 (PDF 구성종목)** | 가장 직접적, 비용 높음 | ✅ Finance_Data DB `etf_portfolio_daily` |
| **지수선물** (K200F, KQ150F 등) | 대형/지수형 ETF 1차 헤지 | ✅ realtime feed |
| **주식선물 ~500종목** | 개별 종목 헤지 + 베이시스 운용 | ✅ `data/futures_master.json` |
| **다른 ETF** | 상관 헤지 + 상대가치 호가 | ✅ master DB |
| **옵션 (KOSPI200 / KOSDAQ150 등)** | 합성 포지션 + vol 노출 분리 | ❌ 아직 데이터 인입 X |

**ETF 간 상관관계의 두 얼굴**:
- *헤지 수단으로서*: A ETF 매수 → B ETF 매도로 부분 헤지 → 잔차만 다른 수단으로
- *호가 기회로서*: 같은 지수 추적 A·B 일시 괴리 → 양쪽 동시 호가 (스프레드 트레이딩)

→ 같은 상관 데이터가 두 방향. LENS는 한 매트릭스에서 둘 다 보여줘야.

**PDF 종목 ∩ 주식선물 마스터** = LENS 차원에서 **이미 계산 가능한 교집합**. 코스닥150이든 반도체TOP10이든 PDF 구성종목 중 주식선물이 상장된 종목들은 별도 헤지 경로로 들어감. (단순 "주식 바스켓"과 따로 분리해야 함 — 베이시스 활용이 추가되므로 fair value가 다름)

---

## 6. Fair Value 캐스케이드 (LENS 구현 목표 구조)

```
Level 0  시장가 (현재 ETF tick)                                      ── 현재 LENS 보유
Level 1  단일 NAV / iNAV — PDF × 구성종목가                          ── 일부 보유
Level 2  헤지수단별 fair value 매트릭스 (m × n)                       ── ★ 새로 만들 핵심
Level 3  net fair value = Level 2 − {헤지비용·슬리피지·캐리·자본}      ── 새로
Level 4  Inventory-skew + OBI + 외부 플로우 시그널 + 예측모델 미세조정 ── 더 나중
Level 5  최종 호가 가격 + 어떤 헤지 수단으로 갈지 자동 선택             ── 더 나중
```

LP가 결정 화면에서 봐야 할 핵심 = Level 2~3. 한 줄로 "이 ETF에 매수 호가 X에 내면 헤지수단 Y로 Z bp 기대 마진". 옆에 *다른 수단으로 갔을 때 Y'·Z'* 같이.

---

## 7. 외부 플로우 탐지 (사내 내부화 부재 대체)

**사내 retail/기관 ETF 플로우 내부화는 없음**. 대신 사용자가 활용 가능한 **외부 플로우 탐지 채널 3개**:

1. **옆팀 기관주문 인지** — 사용자 옆팀(브로커리지)으로 들어오는 기관 ETF 주문은 사용자가 직접 인지 가능. 정보 비대칭의 합법적 활용 범위 내.
2. **거래창구별 체결수량 편향** — 당일 거래창구 중 특정 증권사 체결이 매수·매도 한쪽으로 압도적이면 → 그쪽 고객이 한 방향으로 밀고 있음 추정.
3. **체결 패턴 분석** — 당일 체결내역에서 *특정 체결수량 + 체결텀 반복* → 알고리즘 주문 / VWAP 분할 / 특정 봇 흐름 특정 가능.

→ LENS는 **internalization 대신 "external flow detection"**을 시그널로 강화. 이게 미국 대형 LP의 internalization 자리를 부분 대체.

**LENS 데이터 인입 검토 (이후 작업)**:
- (1) 사용자 manual input UI 또는 옆팀 시스템 연동 (사내 정치 필요할 수 있음)
- (2) 거래창구별 체결 통계 — LS API에 해당 TR 있는지 `docs/ls_api_guide/ls_api_full.md` grep 필요 (t1404/t1463/t1487 등 후보)
- (3) tick 단위 트레이드 tape — LS API 실시간 체결 stream 활용. 수량+텀 패턴 인식 로직은 Rust에서 sliding window로

---

## 8. 월가 LP/MM/HFT 참고 (학습용)

**그들이 돈을 버는 7개 레이어**:

| # | 메커니즘 | 핵심 |
|---|---|---|
| 1 | 내부화 | 사내 플로우끼리 매칭 → 무위험 스프레드. **사용자 환경에 없음** |
| 2 | 다중 앵커 fair value | 선물 lead-lag + 바스켓 + 동일 노출 ETF + 가중평균. **LENS 핵심 목표** |
| 3 | 북 단위 팩터 리스크 | 종목별 P&L X. 델타·베가·감마·섹터·집중도를 데스크 전체로. **LENS 핵심 목표** |
| 4 | Creation/redemption 상시 도구 | 마감 절차 X. 다른 정리수단과 *연속 비교*해서 가장 싼 경로. **LENS 보조 목표** |
| 5 | Block / risk transfer pricing | 스크린 호가는 미끼. 진짜 수익은 기관 블록 risk price. **LENS 향후 영역** |
| 6 | Stat arb 레이어 | ETF-vs-basket, ETF-vs-ETF, lead-lag, cross-listed. **LENS 자연스러운 확장** |
| 7 | Inventory skewing + 역선택 모니터 | Avellaneda-Stoikov 류 quote skew + fill quality 통계 자동 조정. **LENS 향후 영역** |

**반드시 알아야 할 것**:
- **A**: "fair value 정확도+속도=수익" 명제의 정확한 의미 (정확도=앵커수+신선도, 속도=ms 단위 m×n 재계산)
- **B**: 블록·기관 risk transfer가 진짜 수익원. 사용자 환경에서도 운용사 콜 가격 매김이 핵심
- **C**: Avellaneda-Stoikov inventory 모델 — 재고 0정리 안 할 때 호가 logic의 수식 기반
- **D**: 역선택 트래킹 자동화 — fill PnL 분포로 quote quality 통계 검증
- **E**: (사용자 환경에서는) 외부 플로우 탐지 — 위 §7 채널들

**안 따라가도 되는 것**: μs/ns latency 경쟁, 수천 종목 시장조성, 순수 passive screen MM.

**참고 firm/자료**:
- ETF MM 본좌: **Jane Street** (2018 "The ETF Ecosystem" PDF 무료), **Flow Traders** (네덜란드 상장사, 연차보고서)
- 미국 종합형: **Citadel Securities**, **Susquehanna**, **Optiver**, **IMC**
- 도서: *Trading and Exchanges* (Larry Harris), *Algorithmic and High-Frequency Trading* (Cartea/Jaimungal/Penalva), *The ETF Handbook* (David Abner)
- Paper: Avellaneda-Stoikov (2008) inventory skewing, Cont-Stoikov-Talreja OBI 예측, Petajisto (2017) ETF mispricing
- 한국 특화: 공개 자료 빈약. 사용자 본인 경험 + KRX/KOFIA 규정 참고

---

## 9. 첫 빌드 (B 단계 합성안, 2026-05-12 확정)

**페이지**: 새 페이지 **`/lp-matrix`** (기존 etf-arbitrage, stock-arbitrage는 베이시스 트레이딩 화면으로 자기 역할 계속, 건드리지 않음)

**대상 ETF (2개)**:
- **KODEX 코스닥150** (A229200) — 지수형 (베이시스 트레이딩 패러다임 대표)
- **TIGER 반도체TOP10** (A396500) — 섹터 집중형 (LP 호가 모드 대표)

세 번째 ETF 추가는 다음 빌드 (사용자가 실 운영 중인 페어를 듣고 결정).

### 9.1 헤지 경로 enum — 5종 미리 정의 (확장 대비)

매 틱 m×n 매트릭스 재계산은 변함없는 핵심. 첫 빌드는 셀 일부만 채움.

```rust
pub enum HedgeRoute {
    PdfBasket,                              // ① ✓ 첫 빌드 wire
    StockFuturesIntersect,                  // ② ✓ 첫 빌드 wire
    IndexFutures { code: String },          // ③ ✗ 다음 빌드 (KQ150 stream 확인 후)
    CorrelatedEtf { peer_code: String },    // ④ ✗ 다음 빌드 (상관 추정 인프라 필요)
    BetaHedge { hedge_code: String },       // ⑤ ✗ 다음 빌드 (베타 추정 ohlcv 인입 필요)
}
```

| # | 경로 | 첫 빌드? | 비고 |
|---|---|---|---|
| ① | PDF 전종목 바스켓 (Σ qty × price + cash) | ✓ | etf_portfolio_daily + 실시간 S3_/K3_ 다 있음 |
| ② | PDF ∩ 주식선물 교집합 (교집합은 선물, 잔여는 현물) | ✓ | data/futures_master.json + PDF 교차. 5/14 만기 시 한 번 수동 갱신 |
| ③ | 지수선물 (KQ150 / KOSPI200F 등) | ✗ | FC9 wire가 KQ150 코드 받는지 실측 필요. 안 되면 t2112 폴링 fallback |
| ④ | 상관 ETF | ✗ | 상관 추정 파이프라인 부재 |
| ⑤ | KOSPI200F 베타 헤지 | ✗ | ohlcv_daily 베타 회귀 파이프라인 부재 |

### 9.2 Level 3 입력값 (확정, 2026-05-12)

| 입력 | 값 | 출처 / 적용 |
|---|---|---|
| **거래세** | 0.20% | **매도 측만** 차감 (−20bp) |
| **회사금리** | 2.8% (연) | 캐리 + 이론가 베이스. 일할 계산 `× hold_days/365` |
| **슬리피지** | 0~0.10% | 사용자 UI 입력 (etf-arbitrage 필터의 슬리피지 입력란 패턴). default 0 |
| **캐리** | 회사금리 2.8% × hold_days/365 | 매수 = 비용 (−), 매도 = 이익 (+) |
| **추적오차** | 첫 빌드 제외 | 일 단위 데이터라 ms 매트릭스에 부적합 — 다음 빌드 |

**계산식 (간소화)**:
```
net_fv_buy  = fair_value − slippage_bp − carry_cost(연 2.8% × hold_days/365)
net_fv_sell = fair_value + carry_income(연 2.8% × hold_days/365)
              − slippage_bp − 거래세 20bp
```
`hold_days` 기본값은 1일. 사용자 UI에서 조정 가능.

**계산 모델 가정 (사용자 합의 2026-05-12)**:
- **주식선물 가격 단위 = 주당**. multiplier(보통 10)는 *거래 단위 환산*에만 적용, fair value 계산엔 곱하지 않음. 한국 KRX 주식선물 관행대로.
- **bp 적용 기준 = fair_value 비율** (옵션 A). 정확한 모델은 *체결가 기준* (특히 매도 거래세) + *왕복 슬리피지*지만, 첫 구현은 단순 단일 비율 식으로 시작. 정상 시장에서는 fair_value ≈ etf_price이므로 미미. 정밀화는 후속 빌드 + Task #8 실측 후.

### 9.3 화면 (`/lp-matrix`) 구성

- **상단 4숫자 패널**: #1 자체 기준가 ↔ 현재가 ✓ / #2 베타조정 델타 ✓ (수동 포지션 기준) / #3 잔차위험 ✓ / **#4 손익 분해는 스텁** ("TODO" 빈 박스 — 시각적 약속)
- **메인 매트릭스**: 2행(ETF) × 5열(헤지 경로). 셀에 `{fair_value, edge_bp, net_fv, inputs_age_ms, usable}`. **3·4·5열은 첫 빌드에서 빈 셀 + "다음 빌드" 라벨**
- **포지션 수동 입력 폼**: 가상 북이어도 OK. #2·#3 계산용
- **슬리피지/hold_days 입력란**: etf-arbitrage 필터 패턴
- **신선도 배지 필수**: 각 셀에 `inputs_age_ms` — 입력 데이터 신뢰도 가시화

### 9.4 의도적으로 *뺀 것* (절제)

- 지수선물 wire (③) — 다음 빌드 진입 직전 KQ150 stream 가설 검증 후
- 상관 ETF (④) / 베타 헤지 (⑤) — 데이터 인입 후
- 외부 플로우 탐지 3채널 — fair value 정확도 확보 후
- 옵션 — 옵션 데이터 인입 시점에
- 손익 분해 #4 — 체결 데이터 인입 후
- 자동 호가 생성/제출 — LENS 스코프 아닐 가능성
- Avellaneda-Stoikov inventory skewing — Level 4 영역

### 9.5 자연스러운 다음 빌드 1~2

**B+1**: 헤지 경로 ③ wire (KQ150 stream 가설 검증 + FC9 wire 또는 t2112 fallback). 매트릭스 셀 추가만으로 처리.

**B+2**: 베타 추정 파이프라인 (Finance_Data ohlcv_daily 읽기 + Python nightly 60일 OLS) → 경로 ⑤ 활성화. 동시에 상관 ETF 매핑 → 경로 ④.

### 9.6 후순위 작업 (잊지 않되 첫 빌드 차단 X)

- **주식선물 만기 5/14 (2026-05-14) 수동 갱신** — `data/futures_master.json`. 자동 롤오버 스크립트 도입은 별도 인프라 작업
- 거래창구별 체결 통계 LS TR 식별 (외부 플로우 채널 2번)
- 체결 패턴 sliding window (외부 플로우 채널 3번)

---

### 9.7 Finance_Data 데이터 메모 (2026-05-15 답신 — 다음 빌드 진입 시 참조)

**이론가 금리 (확정 정책)**:
- LENS는 *사용자 입력* 금리 사용. UI(`CostInputsPanel`) 입력 가능. **default 2.8%**.
- `apply_level3_costs`의 carry = 이론가 금리 × hold_days/365.
- Finance_Data `futures_ohlcv_daily.theoretical_basis`/`theoretical_price`는 **인포맥스 API 계산값 그대로** 적재 — 그 내부 산출 금리는 *Finance_Data도 모름* (인포맥스 직접 문의 필요, KRX 공식은 91일 CD 기준 추정이나 미검증). → LENS 자체 캐스케이드(사용자 금리)와 인포맥스 theoretical_basis를 **직접 비교 시 금리 가정 불일치 주의**. 다음 빌드 베이시스 분석에서 명시할 것.

**인덱스 분봉 코드 매핑 (Q1)**:
- `index_ohlcv_intraday.index_code`: `101` = KOSPI200, `301` = KOSDAQ150 (LS API 코드)
- `index_ohlcv_daily.code`: `K2G01P`/`Q5G01P` (인포맥스/KRX 코드) — 동일 지수
- 매핑: `101 ↔ K2G01P`, `301 ↔ Q5G01P`. 분봉은 이 둘만 적재. 통일 view는 우선순위 주면 Finance_Data가 작업

**선물 분봉 ↔ 만기/기초자산 (Q2 — 이미 view 4개 존재)**:
- Finance_Data가 5/14 만들어둠 (`schema/futures_intraday_views.sql`, `futures_daily_views.sql`):
  - `futures_intraday_with_class` — 분봉 + underlying_code + contract_class(NEAR/NEXT)
  - `futures_intraday_near` / `futures_intraday_next`
  - `futures_daily_with_class` — 일별 NEAR(인포맥스) + 분봉 NEXT 일봉 집계 통합
- 매핑 로직: `underlying_code = futures_code의 2~3번째 문자` (예 `A0166000` → `01` KOSPI200). NEAR/NEXT는 (date, underlying)별 만기 정렬
- 사용 예: `SELECT * FROM futures_intraday_with_class WHERE underlying_code='01' AND time::date='2026-05-13' AND contract_class='NEAR';`
- 한계: 분봉은 `A` prefix 단일선물만. `B` prefix(채권/통화 등) 분봉 미수집. LENS `data/futures_master.json`(8자리)와는 별 체계 — 다음 빌드에서 이 view로 조인

**분봉 적재 정책 (Q3)**:
- 일배치 매일 23:00 KST(어제분), 주식선물만 22:30 KST 별도 (t8406 historical 불가)
- 30초/1분 혼합: 종목·ETF는 1/2~4/24 1분봉 → 4/27~ 30초봉. 지수·지수선물·주식선물은 30초봉만
- 영구 미수집: KP/KQ 3월물 1/2~3/12 분봉 (LS·인포맥스 모두 historical 미제공)

**`futures_underlyings.stock_code` 34건 미채움 (Q4)**: 전부 정상 — 지수·섹터·채권·통화·상품 선물(주식 미대응). stock_code는 단일종목선물에만.

### 9.8 첫 빌드 통합 검증 결과 (Task #8, 2026-05-17 주말)

**검증 완료 ✅**:
- 백엔드 broadcast 200ms 정확 (8초 41회), WS 메시지 구조 정상
- matrix-config 2 ETF / risk-params 156종목 100% fit / 베타·잔차 도메인 타당
- 포지션 입력 → 5초 poll → book_risk(#2 베타조정델타·#3 잔차위험·섹터·잔차기여·인덱스분해) 산출 + 수치 타당성 확인
- `/lp-matrix` UI end-to-end 렌더 (4숫자 패널이 검증 수치와 일치, 매트릭스·신선도 배지·③④⑤ 미운영 라벨 정상, 콘솔 에러 0)

**실측으로 발견·수정한 버그 3개** (단위 테스트로 안 잡히는 통합 결함):
1. `etfs.py` — `etf_master_daily`/`etf_portfolio_daily` snapshot_date 불일치 시 PDF 0 rows. → 마스터/PDF MAX(snapshot_date) 독립 조회. (기존 etf-arbitrage 페이지도 함께 복구)
2. `scheduler.rs` — Rust가 backend보다 먼저 떠 bootstrap fetch 실패 시 poll 재시도 없음. → poll worker가 etfs 비었거나 risk 캐시 없으면 5초마다 재fetch.
3. `start_dev.sh` — `load_etf_pdf_extra_codes`가 backend 미가동 시 0 (feed spawn 전 1회라 poll 복구 불가). → realtime 시작 전 backend `/api/health` 대기 가드.

**평일 장중 재검증 필수 ⏳** (주말 `phase.rs` 게이팅이 LS sweep을 월요일 08:30까지 sleep — 코드 정상, 환경 한계):
- ETF 자체 가격 (etf-pdf-sweep sleep → ETF price=0, edge 계산 불가)
- PDF 구성종목 커버리지 (주말 35~91% → 평일 t1102 sweep 후 ~100% 기대)
- `stock_futures_intersect` 경로 (futures 주말 no_data=500 → cov 0%)
- 실시간 틱 흐름 + rNAV vs 거래소 iNAV 정확도 (iNAV stream 주말 없음)
- → 평일 장중 1회 재기동하여 위 항목 실측 + lp-system-design 갱신

## 10. 작업 원칙 (반복 확인용)

- **큰 마스터 플랜 만들지 않음.** 단계별로 사용자와 합의 후 구현.
- **참고 자료 베끼지 않음.** `docs/ETF Market Making Plans/`는 도메인 지식 흡수용. 거기 기술 스택·phase 그대로 안 따라감.
- **Rust-first 성능 경로.** m×n 매트릭스 매 틱 재계산은 Rust. Python은 파일 분석·정적 REST.
- **end-to-end 먼저, 추상화 나중.** 한 케이스 끝까지 → 일반화.
- **변경 후 영향 범위 검증** (CLAUDE.md 작업 규칙) — fair value 계산 로직처럼 호출 체인이 깊은 영역은 특히.

---

## 11. 핸드오프 체크리스트 (이어받을 때 먼저 읽기)

**상태 (2026-05-17 기준)**: 첫 빌드 9개 task 전부 완료. 단위 테스트 Rust 11개 + tsc clean. 통합 검증으로 버그 3개 잡고 수정. **평일 장중 재검증만 미완** (§9.8) — 주말 phase 게이팅 한계, 코드 정상.

**worktree1 상태**: 변경 커밋 완료(박제). **main 머지는 보류** — main 쪽 작업(과거/실시간 데이터 적재 업데이트)이 진행 중이라, 그게 끝난 뒤 정찰→머지. LS API 키 1개라 main/worktree 동시 기동 불가 → 순차 진행.

**변경 파일**:
- 수정(11): `CLAUDE.md` `architecture.md`(/init), `backend/main.py`(lp 라우터 등록), **`backend/routers/etfs.py`(snapshot 버그수정 — 기존 etf-arbitrage도 복구되므로 독립 커밋)**, `frontend/src/App.tsx`·`top-nav.tsx`(라우트/탭 1줄), `frontend/src/hooks/useWebSocket.ts`(dispatch 2줄), `realtime/src/main.rs`(spawn_workers+hook), `realtime/src/model/{message,mod}.rs`, `start_dev.sh`(backend 대기 가드)
- 신규: `backend/routers/lp.py`, `backend/services/{pdf_futures_match,risk_estimator}.py`, `frontend/src/{types/lp.ts,stores/lpStore.ts,hooks/useLpInit.ts,pages/lp-matrix.tsx,components/lp/*}`, `realtime/src/calc/*`, `realtime/src/model/lp.rs`, `lp-system-design.md`
- 커밋 제외: `realtime/vendor`(심볼릭 링크), `lp-matrix-verify.png`(검증 스크린샷)

**이어서 할 일 (순서)**:
1. main 작업 종료 확인 → main 워크트리 `git status`로 정찰 (수정 11파일 중 main도 건드린 것 diff)
2. 머지 (linear, ff). 충돌은 겹친 파일의 겹친 줄만 — 대부분 새 파일이라 충돌 적음
3. **평일 장중 1회 재기동 → §9.8 항목 + 그 사이 main 데이터 레이어 변경분(§12) 함께 재검증**
4. 다음 빌드: 헤지경로 ③(KQ150 stream) → ④⑤(베타/상관) + Finance_Data view 4개(§9.7)

## 12. 데이터 의존성 계약 (main 데이터 작업과의 조율)

LP 작업은 Finance_Data DB + LS API를 광범위하게 *읽음*. main 쪽 데이터 적재/스키마 변경이 아래를 바꾸면 해당 LENS 파일이 조용히 깨짐 (etfs.py snapshot 버그가 그 사례). **main 데이터 레이어 변경 시 이 표의 영향 파일을 같이 점검, 평일 재검증(§9.8)에 묶어 확인.**

| Finance_Data / LS 객체 | 사용 컬럼/경로 | 영향 LENS 파일 | 민감도 |
|---|---|---|---|
| `ohlcv_daily` | stock_code, time, close_price | `services/risk_estimator.py` | 컬럼명/적재기간 변경 시 회귀 깨짐 |
| `index_ohlcv_daily` | code(=K2G01P/Q5G01P), time, close | `services/risk_estimator.py` | 코드 체계·종가 컬럼 변경 시 시장변수 깨짐 |
| `stock_sectors` | stock_code, fics_sector | `services/risk_estimator.py` | 섹터 분해 (없어도 치명적 X) |
| `etf_master_daily` | snapshot_date, etf_code, kr_name, creation_unit, tracking_multiple, replication | `routers/etfs.py` | **snapshot_date 적재 정책 매우 민감** |
| `etf_portfolio_daily` | snapshot_date, etf_code, component_code, component_name, shares, is_cash | `routers/etfs.py`, `services/pdf_futures_match.py` | **마스터와 날짜 어긋남 → §9.8 버그1. 독립 MAX 조회로 방어했으나 스키마 변경 시 재확인** |
| `data/futures_master.json` (LENS 측) | base_code, front.code, multiplier, expiry | `services/pdf_futures_match.py` | 만기 롤오버 시 수동 갱신 필요 (후순위) |
| LS API 실시간 | 구독셋(futures_master 250 + etf_pdf_extra union), t1102/t8402 초기fetch | `realtime/src/feed/*`, `calc/scheduler.rs` | phase.rs 게이팅 — 주말/장외 sweep sleep |
| Finance_Data 선물 view 4개 (`futures_intraday_with_class` 등) | §9.7 참조 | 다음 빌드 선물 베이시스 (아직 미사용) | 다음 빌드 진입 시 확인 |

**규칙**: 이 표의 객체를 main 데이터 작업이 바꾸면 → (a) 영향 LENS 파일 표시 (b) 평일 재검증 때 해당 쿼리 실행 검증 (c) 본 표 + §9.7/§9.8 갱신. 데이터 변화 대응은 *git 머지가 아니라 실행 검증*으로 푼다.
