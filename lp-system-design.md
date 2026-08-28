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

**평일 라이브 재검증 완료 ✅ (2026-05-18 월요일 장중)**:
- adj_close 기준 베타·잔차 재산출: 156/156 fit_ok, shrinkage 0.291. 샘플 베타 — 000250=0.75, 000660(SK하이닉스)=1.37, 000990=1.02. 분포 정상 (대부분 1.0 근방, 대형주 1.0+)
- Ledoit-Wolf 메모리: refresh 시 RSS 변화 **0 KB** (PR-2 식 정리 효과 확정)
- LP 매트릭스 fair_value 산출 + usable=True: 229200 (KODEX 코스닥150 레버리지) price 18,440 vs pdf_basket fv 18,483 (-22.8bp); 396500 (TIGER 200타겟) price 46,360 vs pdf_basket fv 46,403 (-8.6bp) + stock_futures_intersect fv 46,496 (-28.6bp)
- /debug/stats: matrix_tx_dropped=0, tx_dropped=0, serialize avg 0.34ms — H4/H8 영구 보류 결정 (측정 후 무영향 확인)
- WS disconnect cleanup stocks/inav 양쪽 동작 (탭 강제 종료 시뮬 → 로그 확정)
- backend permanent-stocks sync + realtime startup polling 양쪽 정상 (재시작 어느 순서든 union 회복)
- ETF 페이지 sub 범위: 머지 후 *4358 codes* 한 번에 sub → LS API 연결 한도 초과로 재연결 폭주 발견. PR-13으로 sub 범위 토글(표시 50/100/200/300/전체 + 유형 섹터/지수/파생/채권/기타) 추가 + 해외 ETF 마스터 제외(636 → 563). 디폴트 섹터+100 = 1281 codes

## 10. 작업 원칙 (반복 확인용)

- **큰 마스터 플랜 만들지 않음.** 단계별로 사용자와 합의 후 구현.
- **참고 자료 베끼지 않음.** `docs/ETF Market Making Plans/`는 도메인 지식 흡수용. 거기 기술 스택·phase 그대로 안 따라감.
- **Rust-first 성능 경로.** m×n 매트릭스 매 틱 재계산은 Rust. Python은 파일 분석·정적 REST.
- **end-to-end 먼저, 추상화 나중.** 한 케이스 끝까지 → 일반화.
- **변경 후 영향 범위 검증** (CLAUDE.md 작업 규칙) — fair value 계산 로직처럼 호출 체인이 깊은 영역은 특히.

---

## 11. 핸드오프 체크리스트 (이어받을 때 먼저 읽기)

> **⚠️ 2026-07-07 이후 방향은 §13 (v2 운영 사이클 재설계)이 우선.** 아래 §11의 "이어서 할 일"과 §9.5 순서는 v2 합의로 대체됨 (§13.7 빌드 순서 참조). §1~§8 철학·§12 데이터 계약은 계속 유효.

**상태 (2026-05-19 기준)**: 첫 빌드 완료 + main 머지 완료(`39e43ec`) + post-merge 통합 검증 13 PR (`bd9dc96`~`95ded03`) 통과. 평일 라이브 재검증 OK (§9.8).

**현재 main HEAD**: PR-13까지 반영. 안전 태그 `pre-worktree1-merge` 보존.

**머지 후 통합 처리 요약**:
- **CRITICAL 3**: PR-1 risk_estimator adj_close 전환 / PR-2 Ledoit-Wolf 메모리 500x 절감 / PR-4 LP 가격 입력 경로 (3 agents 합의 발견)
- **HIGH 6**: PR-3 분할 당일 배너 / PR-5 SQLite WAL / PR-6 LP try_send 카운터 / PR-8 fire-and-forget 안정화 / PR-9 EtfTick 4필드 추가 / PR-10 inav header tracking
- **MEDIUM 2**: PR-7 startup ensure_schema / PR-11 잡일 묶음
- **추가 fix**: PR-12 startup race + STALE threshold 1h / PR-13 ETF 페이지 sub 범위 토글 (LS 한도 초과 회피)
- **영구 보류**: H4 snapshot_prices clone / H8 lock 직렬 — 측정 결과 무영향

**이어서 할 일 (순서)**:
1. (선택) PR-14: backend `/api/etfs/top-by-volume` — 첫 진입부터 정확한 거래량 ranking. 현재는 localStorage cache + master 순서 fallback
2. (선택) `stat-arb-engine/src/data/bars.rs` — `close_price`→`adj_close`, `ohlcv_intraday`→`ohlcv_intraday_adjusted` view (LP risk_estimator는 끝났고 stat-arb engine만 남음)
3. **다음 빌드 (§9.5)**: multi-factor risk (섹터 지수 K2S07P 등) → ETF 확장 → 인포맥스 theoretical_basis 금리(§9.7) → 호가 깊이 기반 fair value

## 12. 데이터 의존성 계약 (main 데이터 작업과의 조율)

LP 작업은 Finance_Data DB + LS API를 광범위하게 *읽음*. main 쪽 데이터 적재/스키마 변경이 아래를 바꾸면 해당 LENS 파일이 조용히 깨짐 (etfs.py snapshot 버그가 그 사례). **main 데이터 레이어 변경 시 이 표의 영향 파일을 같이 점검, 평일 재검증(§9.8)에 묶어 확인.**

| Finance_Data / LS 객체 | 사용 컬럼/경로 | 영향 LENS 파일 | 민감도 |
|---|---|---|---|
| `ohlcv_daily` | stock_code, time, adj_close | `services/risk_estimator.py` | 컬럼명/적재기간 변경 시 회귀 깨짐. adj_close 사용 (raw close_price는 액면분할 spike 위험) |
| `index_ohlcv_daily` | code(=K2G01P/Q5G01P), time, close | `services/risk_estimator.py` | 코드 체계·종가 컬럼 변경 시 시장변수 깨짐 |
| `stock_sectors` | stock_code, fics_sector | `services/risk_estimator.py` | 섹터 분해 (없어도 치명적 X) |
| `etf_master_daily` | snapshot_date, etf_code, kr_name, creation_unit, tracking_multiple, replication | `routers/etfs.py` | **snapshot_date 적재 정책 매우 민감** |
| `etf_portfolio_daily` | snapshot_date, etf_code, component_code, component_name, shares, is_cash | `routers/etfs.py`, `services/pdf_futures_match.py` | **마스터와 날짜 어긋남 → §9.8 버그1. 독립 MAX 조회로 방어했으나 스키마 변경 시 재확인** |
| `data/futures_master.json` (LENS 측) | base_code, front.code, multiplier, expiry | `services/pdf_futures_match.py` | 만기 롤오버 시 수동 갱신 필요 (후순위) |
| LS API 실시간 | 구독셋(futures_master 250 + etf_pdf_extra union), t1102/t8402 초기fetch | `realtime/src/feed/*`, `calc/scheduler.rs` | phase.rs 게이팅 — 주말/장외 sweep sleep |
| Finance_Data 선물 view 4개 (`futures_intraday_with_class` 등) | §9.7 참조 | 다음 빌드 선물 베이시스 (아직 미사용) | 다음 빌드 진입 시 확인 |

**규칙**: 이 표의 객체를 main 데이터 작업이 바꾸면 → (a) 영향 LENS 파일 표시 (b) 평일 재검증 때 해당 쿼리 실행 검증 (c) 본 표 + §9.7/§9.8 갱신. 데이터 변화 대응은 *git 머지가 아니라 실행 검증*으로 푼다.

**양방향 조율 프로토콜** (양 작업 흐름이 같은 데이터·인프라를 공유할 때):
- 변경 측 → 영향 측: §12 객체 의존 목록 + 수정한 공유 파일을 *능동 통지*
- 영향 측: 스키마/적재/snapshot 변경 사항을 회신 → 머지 시점에 시점 액션으로 흡수
- 핵심 원칙: 데이터/인프라 변화는 git diff가 아니라 *문서 회신 + 머지 후 실행 검증*으로 푼다

---

## 13. LP 매트릭스 v2 — 운영 사이클 재설계 (2026-07-07 합의)

첫 빌드(§9)가 "ETF별 × 헤지경로별 fair value 비교표"였다면, v2는 **실제 매매 사이클(호가 → 체결·헤지 → 보유·손익 → 정리)을 따라가는 워크플로 화면**으로 재설계한다. §1~§8의 철학(측정 부재 해소, 4대 숫자, fair value = 헤지 수단의 함수)은 그대로 유효하고, §9의 계산 자산은 §13.6대로 재배치한다.

근거 자료: `docs/ETF_LP_final_presentation (1).pptx` + Gemini 딥리서치 리포트(Jane Street warehousing/proxy hedging, A-S quote skewing, P&L 5분해, 글로벌 리스크 북). memory `project_lp_oms_constraints` 참조.

### 13.1 전제 — OMS 제약과 실운영 흐름 (사용자 진술 2026-07-07)

- ETF 체결 시 **넷팅 바스켓 헤지 불가**. ETF 하나 체결 → 그 ETF의 한쪽 방향 바스켓 헤지만 가능. 여러 ETF 간 바스켓 넷팅도 불가.
- 호가는 단순 전략만 제출 가능 (자동·복잡 호가 전략은 장기 목표).
- 가용 자산: **ETF · 현물 · 지수선물(K200F, KQ150F, 미니K200F) · 주식선물**. 옵션 X.
- 실운영 사이클: ETF 체결 → **지수선물로 델타 헤지** → 다일 보유 → ETF 북이 선물 대비 아웃퍼폼하면 **보유 ETF들의 넷팅 바스켓을 수동 매매**로 만들어 선물 정리 + 바스켓 청산. 당일 0정리 아님 — 기회 나올 때 정리.

### 13.2 핵심 통찰 — 넷팅은 선물 레이어에서

체결 시점엔 넷팅이 불가능하지만 정리 시점엔 (수동으로) 가능하고, **지수선물은 계좌에서 저절로 넷팅된다**. 따라서:

```
북 상태 = Σ ETF 재고 − 지수선물 오버레이
        = "ETF 바스켓 롱 vs 지수선물 숏" 베이시스 포지션 + 잔차위험
```

헤지는 ETF별이 아니라 **북 전체 순 베타델타 기준으로 선물 계약 수만 맞춘다** → 넷팅 효과를 선물 레이어에서 공짜로 얻는다. 결과적으로 운영은 "베이시스 창고업" (지수 베이시스 차익거래 유사 흐름)이 되며 이는 사용자가 수용한 방향. Jane Street proxy hedging과 동일 원리 — 정밀 헤지(바스켓) 대신 싸고 유동성 좋은 대용(선물)으로 매크로 델타만 잡고, 잔차는 감내하다 가장 싼 시점에 정리.

### 13.3 운영 사이클 4단계

**A. 매매 전 — 호가**: 호가 앵커를 **FV_futures(지수선물 기준)**로 승격 (체결 직후 행동이 선물 헤지이므로 앵커=행동 일치). ETF별 2개 FV:
- `FV_futures` (호가 앵커): 지수선물가 → 이론 현물 환산(베이시스·캐리) → ETF 관계(추적배수·레버리지·보수 드래그) 반영. 섹터형은 지수 베타 + 잔차 프리미엄.
- `FV_basket` (정리 앵커): 기존 PDF iNAV. 출구 가치 평가용.

```
요구 엣지(bp) = 기본 스프레드 + 재고 skew(−q·γ·σ²·h, A-S 간소화)
             + 잔차위험 charge + 역선택 버퍼(변동성·OBI 레짐) − 헤지 비용
제안 bid/ask = FV_futures ∓ 요구엣지,  제안 수량 = min(선물 헤지 여력, 재고 한도, 잔차 한도)
```
출력은 "호가 제안 시트" (자동 제출 X). 재고 skew가 호가에 들어가는 것이 핵심 — 북이 롱이면 매도 호가를 공격적으로 (재고 자연 건조 = 가장 싼 정리 경로).

**B. 체결 시 — 헤지**: 체결 입력(초기 수동, 이후 OMS 연동) → 선물 헤지 티켓 자동 계산:
1. 베타조정 델타 증분 (기존 `risk_estimator` 베타)
2. **북 전체 순 델타 기준** 계약 수 (반대 재고 있으면 "헤지 불필요" = 넷팅 판정)
3. 계약 선택: K200 계열→K200F, 코스닥→KQ150F, 잔량 작으면 **미니K200F로 라운딩 잔차 최소화**
4. 잔차 2단계: 선물이 못 잡는 것(섹터 괴리·단일종목 집중·레버리지 리밸런스 드리프트) 추적 + 집중분 한도 초과 시 주식선물 부분 헤지 제안 (기존 intersect 로직 재활용)

**C. 보유 중 — 손익 관리**: P&L 5분해 + 리스크 한도 4개.

| 구성 요소 | 정의 |
|---|---|
| 스프레드 수익 | 체결가 vs 체결 시점 FV_futures (+ 5분/30분 markout 역선택 판별) |
| 베이시스 손익 | ETF 북 가치 변화 − 선물 헤지 손익 (**전략의 본체**; 지수/종목 분리 §13.4) |
| 잔차 손익 | 베이시스 외 요인 (섹터·종목 드리프트) |
| 캐리 | 자금 비용(2.8%) − 배당 + 선물 롤 + ETF 보수 드래그 |
| 헤지 비용 | 선물 슬리피지 + 라운딩 잔차 손익 |

한도: 북 순 베타델타 / 잔차위험 총량 / ETF별 재고 / 베이시스 VaR. "헤지 비용 > 오버나이트 VaR이면 이월이 합리적"을 숫자로 보이게 (PPT 8p "측정→비교→부분 적용" 근거 자료 겸용).

**D. 정리 — 출구 3개의 상시 가격 비교**:
1. **넷팅 바스켓 + 선물 청산** (메인 출구): 보유 ETF 전체 PDF 합산 → 종목별 순 주수 → 실행 주문표 (예상 대금 − 실행 비용: 종목 스프레드·ADV 임팩트·거래세 20bp). 백테스트 엔진 ADV 캡 로직 재활용.
2. **호가 자연 건조**: A의 skew로 스프레드 받으며 정리. 기대 소요 시간 × 캐리와 비교.
3. **설정/환매**: CU 도달 ETF만. AP 수수료 + 조성 비용.

타이밍: "ETF 북 vs 선물" 스프레드 z-score + (지금 정리 순마진 vs 남은 기대 엣지 − 추가 캐리). 트리거 시 알림 + 넷팅 바스켓 원클릭 생성.

### 13.4 베이시스 레이어 (2026-07-07 사용자 요구로 추가)

**베이시스 인지 실행 라우터**: 헤지 티켓(B)·넷팅 바스켓(D)의 **모든 주문 leg**에 대해, 주식선물 상장 종목이면 현물 vs 선물 비교 후 라우팅. 판정 입력: 실시간 베이시스 vs **자체 이론 베이시스**(금리 2.8% × 잔존일 − 예상배당; 인포맥스 theoretical_basis는 금리 가정 불명 → 참고치, §9.7), 베이시스 z-score, 주식선물 유동성, 잔존일. 매도 leg는 베이시스 rich일 때, 매수 leg는 cheap일 때 선물 대체. 예: "삼성전자 매도 leg, 베이시스 +5,000(이론 +1,200 대비 +3,800 rich) → 선물 매도 대체" — 이때 **현물 롱 + 선물 숏 = 종목 베이시스 포지션이 자동 기장**됨.

**베이시스 북 원장**: 북의 모든 베이시스 포지션을 명시적 분리 추적:
- 지수 베이시스 (ETF vs 지수선물): 진입/현재/이론 대비 rich·cheap, 수렴 손익. **선물지수 추종 ETF(114800·252670·251340, DB underlying_index 실측)는 두 leg 모두 선물 연동이라 현물-선물 베이시스 노출 ≈ 0 → etf_leg에서 제외** (가족 델타·헤지 티켓에는 포함 — 델타는 실재)
- 종목 베이시스 (현물 vs 주식선물): 진입→현재 베이시스, 만기 D-day(현금결제 — 만기 수렴 보장이나 **만기일 현물 leg 처리 액션 필수**), 연환산 수익률. 같은 base 다월물(롤 주간 근월+차월)은 만기 순으로 현물 잔량 순차 배분 — 이중계상 금지
- 만기 롤 스케줄 (매월 두 번째 목요일, memory `reference_stock_futures_expiry`) — 만기 전 액션 알림

**북 4층 분해** (4대 숫자 패널 확장): 북 전체를 `방향 델타(≈0) + 지수 베이시스 노출(가족별 notional + 베이시스 10bp당 손익) + 종목 베이시스 노출 + 잔차`로 완전 분해. "지금 내 북 = K200 베이시스 42억 롱과 같다"가 한 줄로 보이게. 손익 분해(C)의 베이시스 항목과 1:1 대응.

### 13.5 원장 가시성 최우선 (사용자 요구 2026-07-07 — Phase 1)

**"기존 원장의 수량과 매매로 체결된 포지션이 한 눈에"** — 모든 계산(skew·헤지 티켓·분해)의 기반이 북 상태이므로 원장을 v2의 첫 조각으로 만든다.

- 현행: `data/lp_positions.json` flat dict `{code: qty}` (§9 수동 입력). → v2: **lens.db(SQLite) 원장**으로 승격.
- 데이터 모델 스케치: `lp_ledger` 엔트리 = `{id, ts, code, instrument(etf|stock|index_fut|stock_fut), kind(carryover|fill), side, qty, price, note}`. 현재 포지션 = 이월(carryover) + Σ 체결(fill). 기존 JSON은 carryover로 1회 마이그레이션.
- **호환 계약**: Rust `scheduler.rs`가 5초 poll하는 `GET /api/lp/positions`(flat dict)는 원장 집계 결과를 반환하도록 유지 — Rust 쪽 무수정. 신규는 `/api/lp/ledger` 계열로.
- 보드 UI: 자산유형별 그룹(ETF 재고 / 지수선물 오버레이 / 주식선물 / 현물), 행 = 이월·당일체결 분리 수량 + 평단 + 현재가 + 노출, 하단 당일 체결 로그. 상단에 북 합계(순 노출·베타조정 델타는 기존 book_risk 수치 재사용).

### 13.6 기존 자산 재배치 (§9 → v2)

| §9 자산 | v2 역할 |
|---|---|
| 경로 ③ 지수선물 (미 wire) | **호가 앵커로 승격** — v2의 1순위 wire (선물 시세는 이미 realtime feed에 있음) |
| 경로 ① PDF 바스켓 | 출구 평가 (FV_basket) + 넷팅 바스켓 빌더 |
| 경로 ② 주식선물 교집합 | 잔차 축소 도구 + 실행 라우터 재료 |
| 경로 ④ 상관 ETF / ⑤ 베타 헤지 | 매트릭스 열에서 제거 — 선물 오버레이 구조에 흡수 |
| `risk_estimator` (베타·Ledoit-Wolf·잔차) | 그대로 — 티켓 사이징·잔차·skew의 심장 |
| `BookFourNumbers` | 유지 + 4층 분해 확장. #4 손익분해는 §13.3-C로 정의 획득 |
| `PositionEntry` | 원장 보드로 대체/확장 (§13.5) |
| 신선도 배지·200ms 스케줄러·WS | 그대로 |

### 13.7 빌드 순서 (v2 Phase — §9.5/§11 순서 대체)

| Phase | 내용 | 상태 |
|---|---|---|
| **1. 북 원장** | lens.db 원장 + 체결 로그 + 한눈 보드 + positions API 호환 레이어 | ✅ 2026-07-07 `c6de5bc` |
| **2. 호가 보드** | FV_futures wire + 요구엣지·skew·제안 호가/수량 시트, 유니버스 12종 | ✅ 2026-07-07 PR-A `0cc9548` / PR-B `7a7a0b4` / PR-C `bbfbbab` (§13.8) |
| **3. 헤지 티켓 + 실행 라우터** | 체결→선물 티켓(넷팅 판정·미니 라운딩) + 현물vs선물 대체 판정 + 베이시스 포지션 기장 | ✅ 2026-07-07 `4a7e9dd` |
| **4. 손익·베이시스 분해** | 5분해 + markout + 베이시스 북 원장 + 4층 분해 + 만기 롤 알림 + 한도 4개 | ✅ PR-D(베이시스 북 원장·4층 분해·만기 롤, §13.9) + PR-E(P&L 5분해·markout·한도 4개, §13.10) 완료 |
| **5. 출구** | 베이시스 z-score 모니터 + 넷팅 바스켓 빌더 + 출구 3개 비교 | ✅ 2026-07-07 (§13.11) — 넷팅 바스켓 빌더(PDF 합산·부호 넷팅·ADV 캡·주식선물 배지) + 지수 베이시스 z-score(raw 60일 분포) + 출구 3개 순 bp 비교. 알림은 색상 배지 v1(별도 시스템 X) |

각 Phase는 독립적으로 쓸모 있게 (end-to-end 먼저 원칙 유지). 단계별 사용자 합의 후 다음 Phase.

### 13.8 Phase 2 구현 기록 (2026-07-07 완료)

**실측으로 확정된 사실**:
- **FC9는 A01(K200)·A05(미니)·A06(KQ150) 모두 수신** — t2112 폴링 fallback 불필요 (첫 빌드 §9.1의 미해결 가설 해소). FC9 응답에 theoryprice·k200jisu(기초지수)·미결제 포함.
- **t8467은 KOSPI200(A01)만 반환** → front month는 A01을 t8467로 확정 후 01→05/06 프리픽스 치환 파생 (3상품 분기 만기 공유, 만기 D-2 롤, 기동 시 1회 해석).
- **etf_master_daily NAV 컬럼은 신뢰 불가** (252670에서 ~10배 오차 실측) → prev_nav는 ohlcv_daily 전일 adj_close 프록시.
- **DB tracking_multiple은 레버리지 ETF에도 "일반(1)"** → 12종 family/배수는 `routers/lp.py`의 fallback 맵이 정본.
- 폭락일(K200 −8.4%, CB 발동·해제) 라이브 검증 통과 — no_quote→복구 경로 실증, r_implied 극단 가드 ±15%(CB-2 기준).

**구현 요약**: FC9 전용 커넥션(키A, conn 700번대, 전용 신선도 atomic) → `quote_board.rs`가 S_impl=F/(1+r·d/365), FV=prev_adj_close×(1+L·r_impl|β·r_impl), skew=−γ·q억·σ%²·h(예약가격 이동), KRX 호가단위 구간 스냅 → WS `quote_board` 200ms → QuoteBoard UI(12행 고정 순서·행 확장 분해·QuoteParamsPanel). PDF 확장 없음 — 12종은 ETF 틱 + 지수선물 3종만 소비 (구독 +10 코드).

**후속 트랙 (Phase 3 진입 전 선택)**:
- LS WS idle watchdog이 stall을 4.7h 미감지한 건 — `select!` 내 sleep 재생성으로 idle 브랜치 굶는 가설 (미확정, 별도 조사)
- 지수선물 front-month 일일 re-resolve (현재 기동 시 1회 — 만기 넘겨 장기 가동 시 만료물 구독 지속)
- InternalFeed 지수선물 wire (내부망 실측 필요, TODO 주석)
- 배당 시즌(4월) implied spot bias — v1 배당 무시 주석 참조

### 13.9 Phase 4 PR-D 구현 기록 (2026-07-07 — 베이시스 북 원장 + 4층 분해 + 만기 롤)

**목표 달성**: 북에 존재하는 모든 베이시스 포지션을 명시 분리 추적 + 북 전체 4층 분해로
"지금 내 북 = K200 베이시스 42억 롱"이 한 줄로 보이게 (§13.4).

**원장 확장**: `lp_ledger`에 `entry_basis REAL` 1급 시민화 (멱등 PRAGMA-guard ALTER). `POST
/ledger/entry`에 optional `entry_basis`. 집계는 avg_price처럼 qty 가중 평균. BasisRouterPanel
"선물 대체 기장"이 note(가독)와 entry_basis(수치) **병행** 기록. 소급 파싱 없음 (신규 기장부터).

**Rust 단일 소스화**: scheduler 5초 poll을 `/api/lp/positions` → **`/api/lp/ledger`**로 확장.
aggregates(instrument·base_code·entry_basis)에서 `DeskBook.positions`를 파생 → book_risk·hedge_ticket
무변경, 베이시스 북은 같은 aggregates 소비. `basis_book` WS는 flush 내 1초 스로틀 broadcast —
book_risk의 hedge_tickets(residual·existing)·잔차위험을 그대로 재사용 (계산 중복 없음).

**4층 분해**: `방향 델타(Σ 티켓 residual) + 지수 베이시스(가족별 etf_leg×L vs 선물 existing 매칭
notional·10bp 민감도) + 종목 베이시스(현물 vs 주식선물 페어) + 잔차(book_risk #3)`.

**종목 베이시스 페어**: 같은 base의 현물 ±q vs 주식선물 ∓q' → 반대 부호일 때 페어, 수량
불일치는 min 겹침만(잔여는 일반 포지션). 부호 규약 `matched_signed = sign(현물)×겹침`,
`convergence_pnl = (entry_basis − basis_now) × matched_signed` — 4방향 일관 (현물롱+선물숏 축소=이익).
만기 D-5 이내 = 현금결제 현물 leg 처리 액션 플래그. 지수 오버레이 front month D-2 = 롤 필요.

**독립 검증 후 수정 4건 (H1·M1·M2·M3, 2026-07-07)**:
- **H1 다월물 이중계상**: 같은 base의 선물 leg 여러 개(롤 주간 근월+차월)가 각각 현물 전량과
  페어링되던 버그 → **만기 순 정렬 후 현물 잔량 순차 배분** (근월 우선, 잔여 선물은 unpaired).
- **M1 만기 오귀속**: base→front 마스터만 봐서 차월물 만기가 근월물로 오표시 → futures_master
  로더에 **by_code(front+back) 맵** 추가, 실보유 계약 코드로 만기·이름 매칭. 마스터 miss는
  `expiry_known=false` = "만기 미상" (D-0 오독 액션 오경보 억제).
- **M2 유령 지수 베이시스**: 선물지수 추종 ETF(114800·252670·251340)를 etf_leg에서 제외
  (`futures_based` 필드, DB underlying_index 실측 근거 — §13.4 명기).
- **M3 4층 비가산성**: 주식선물 델타가 어느 층에도 없어 델타중립 페어의 현물 leg 델타가 ①에
  잔존 + 중복 지수 헤지 티켓 → hedge_ticket 가족 분해에 **주식선물을 base β로 포함** (주수 ×
  선물가(폴백 현물가) × β). book_risk #2는 여전히 미포함(unmapped 표시) — 알려진 스코프.
- entry_basis 집계는 **포지션 증가 방향 fill만** qty 가중 (청산 fill의 진입 평균 왜곡 방지).

**검증**: Rust 단위테스트 +17 (총 60 통과) — 페어 인식·수량 불일치·부호 4방향·지수 매칭·
notional 부호 + 다월물 배분 2·만기 미상·futures_based 제외·델타중립 넷팅 2. mock 라이브
스모크: (a) 229200 롱+KQ150F 숏 → KQ150 베이시스 4473만 롱(10bp +4만) 실측 정합, (b)
entry_basis round-trip, (c) 델타중립 페어 → ① 방향 델타 = 0, (d) H1 repro(현물 1만/근월 −1만/
차월 −6천) → 페어 1개·matched 10,000주(이중계상이면 16,000), 차월 unpaired 델타는 ①로.
UI: BookFourNumbers 바로 아래 BasisBookPanel (4층 요약 스트립 + 지수/종목 페어 테이블 + D-day
warning 배지, stale 시 수렴손익 동반 숨김). ④ 잔차 = book_risk #3 동일 소스 확인.

### 13.10 Phase 4 PR-E 구현 기록 (2026-07-07 — P&L 5분해 + markout + 리스크 한도)

**목표 달성**: 4대 숫자 #4(손익 분해) 스텁을 처음 채움. 당일 세션(전일 종가 대비) 북 MTM을
5항으로 **완전 분해**(residual attribution) + fill 후 markout 역선택 통계 + §13.3-C 리스크 한도 4개.

**원장 확장 (체결 시점 스냅샷)**: `lp_ledger`에 `fv_at_fill`·`mid_at_fill` REAL 컬럼 (멱등 ALTER,
entry_basis 패턴). fill 기장 시 프론트가 quote_board의 해당 ETF `fv_futures`·현재가를 자동 첨부
(LedgerBoard EntryForm — ETF 유니버스 종목만, 아니면 null). BasisRouterPanel 기장은 spot/선물가를
`mid_at_fill`로 첨부. 신규 테이블 `lp_fill_marks {fill_id, horizon('5m'|'30m'), price, fv, marked_at}`,
`(fill_id, horizon)` UNIQUE — POST는 INSERT OR IGNORE 멱등. `POST /api/lp/fill-marks`(Rust 호출)·
`GET /api/lp/fill-marks?date=today`.

**5분해 (Rust `calc/pnl.rs`, WS `pnl_decomp` 1초 throttle)** — 전부 pure, 단위테스트 10건:
- **스프레드** = Σ 당일 fill `(fv_at_fill − fill_price) × signed_qty` (매수 FV보다 싸게=+, 매도
  FV보다 비싸게=+, 4방향 부호 일관). fv_at_fill 없는 fill은 **unattributed**(건수·명목)로 별도 집계.
- **베이시스(종목)** = basis_book `stock_basis` 수렴손익 합. **지수 베이시스는 당일 변화 미기록이라
  v1 산출 불가** — `basis_index_status`로 정직 표기 (무리한 근사 금지).
- **총 MTM** = 포지션 평가 항 `Σ qty_now × (price − baseline) × mult` **+ 당일 fill 현금흐름 항
  `Σ −signed_qty × (fill_price − baseline) × mult`** (독립 검증 C1 수정 — 포지션 항만으론 왕복
  실현손익 증발·당일 신규가 "전일종가→진입가" 유령 손익 획득). baseline은 코드당 단일 소스
  (**유니버스 12종=real EOD, 그 외=day_open 폴백** — 포지션·fill 양쪽이 동일 기준가라 왕복·신규에서
  정확히 소거, 실현은 체결가 기준). day_open은 handle_tick DashMap, 날짜 바뀌면 리셋. 폴백/결측/
  fill 기준가 결측·**장중 재시작(day_open 왜곡 가능)** caveat. 지수선물은 승수 반영.
- **캐리** = `−r × Σ(현물성 부호 노출) × (당일 경과일/365)` (독립 검증 M1 수정 — **선물(index/
  stock_fut)은 증거금 상품이라 제외**(캐리는 베이시스에 내재), 현물·ETF는 부호 유지: 롱=비용(−)·
  숏=매도대금 운용 이익(+), §9.2 carry_income 정합). 당일 fill 무시 근사 + "현물성 노출 단순 근사
  (증거금·대차비용 미반영)" caveat 상시 명기.
- **헤지 비용** = `−Σ 당일 선물 fill 명목 × futures_fee_bp` (quote-params 신설, default 0.3bp).
- **잔차·방향** = `total_mtm − (스프레드+베이시스+캐리+헤지)` **역산** → `total = Σ 5항` 가산성 항등
  보장 (스모크 실측 diff=0.000000, 단위테스트 `decomposition_is_additive`).

**markout (poll 기반)**: scheduler 5초 poll이 당일 fill × horizon(5m/30m)에 대해 due(경과 + 유예
`MARK_GRACE_MS`=3분 내)이면서 미기록인 마크를 현재가·FV(`last_fv` DashMap) 스냅샷 → backend POST
(재시도 1회, 실패 로그, reqwest Client 재사용). dedup은 fill-marks GET의 (fill_id, horizon) 셋 +
backend UNIQUE 이중. **Rust 재시작으로 유예 초과한 마크는 미기록**(소급 불가 — 정직). **가격 신선도
가드**: 마크 시점 가격 age > 60s면 skip + debug 로그 (장 마감 후 due 마크가 정지 종가를 무경고
기록하는 것 차단 — etf_prices를 PriceWithAge로 승격해 ETF도 age 추적. 호가 보드 표시 나이는 기존
철학(0) 유지). markout_bp = `(mark−fill)/fill × 방향부호 × 1e4` (음수=역선택). 5m/30m 평균·건수 포함.

**리스크 한도 4개 (§13.3-C)**: quote-params 신설 `limit_net_delta_krw`·`limit_residual_krw`·
`limit_basis_var_krw`·`basis_vol_bp_daily`(15bp)·`futures_fee_bp`(0.3bp) — ETF별 재고 한도는 기존
`inventory_limit` 재사용. ① 순 델타(오버레이 후 = basis.directional_delta) ② 잔차위험 1σ(book_risk #3)
③ ETF 재고(유니버스 사용률 최대 종목) ④ 베이시스 VaR = (지수+종목 명목) × `basis_vol_bp_daily`
(**조잡 근사 — 주석·UI 캡션 명시**). 각 `{current, limit, ratio}` → pnl_decomp.limits.

**프론트**: BookFourNumbers #4 스텁 → 당일 P&L 총액 + 미니 분해(클릭 시 5행 펼침). 신규 **PnlPanel**
(BasisBookPanel 아래) — 한도 게이지 4개(80%↑ warning·100%↑ down색) + 5분해 막대 + markout 통계 +
unattributed·caveats 정직 표기. QuoteParamsPanel에 P&L·한도 필드 추가.

**검증**: Rust 테스트 +15 (총 75 통과) — 스프레드 부호 매수/매도/역, 미귀속, 잔여 역산 가산성
(total=Σ), 헤지비용, MTM 폴백, markout 부호 4방향·통계, 한도 ratio + **C1 4건**(왕복 +100만 정확·
부분청산 잔여 MTM+실현·당일 신규 진입가 기준 +60만/잔차 오염 소멸·폴백 baseline 왕복 소거) +
**M1 1건**(선물 제외·숏 캐리 + 부호·caveat). mock 라이브 스모크: (a) fill 기장 → fv_at_fill
round-trip, (b) pnl_decomp 수신 spread 손계산 일치·가산성 diff=0.000000·한도 4게이지,
(c) backdated fill로 markout POST 파이프라인 실증(5m 마크 기록·30m 미due), (d) 비ETF fill이
unattributed로 분류, (e) **왕복 시나리오 total_mtm=+1,000,000 정확 실측** (수정 전 0 — C1 repro).
테스트 원장·fill_marks 전량 정리(0/0). 기존 회귀(basis_book·book_risk·quote_board) 유지 —
Playwright 실화면 확인.

**독립 검증 후 수정 4건 (C1·M1 + 소소 2, 2026-07-07)**:
- **C1 당일 fill 현금흐름 누락 (치명)**: total이 현재 포지션 MTM만 계산 — 왕복(포지션 0) 실현
  +100만 증발, 부분청산 매도 leg 실현 누락, 당일 신규에 전일종가→진입가 유령 손익. → fill별
  `−signed × (체결가 − baseline)` 항 추가, baseline 조회를 포지션 항과 단일 클로저로 통일
  (불일치 시 폴백 종목 왕복 소거가 깨짐). 유령분이 잔차로 새던 오염도 소멸.
- **M1 캐리 무차별 비용화**: gross_abs가 롱숏 불문 + 선물 명목(×승수)까지 포함 → 델타중립 북에
  유령 캐리가 잔차로 역류. → 선물 제외 + 현물성 부호 반영 + caveat 명기.
- markout 가격 신선도 가드 60s (정지 종가 무경고 기록 차단) / 장중 재시작 day_open caveat +
  reqwest Client 재사용.

### 13.11 Phase 5 구현 기록 (2026-07-07 — 출구: 넷팅 바스켓 + z-score + 출구 3개 비교)

**목표 달성**: v2 운영 사이클의 마지막 단계(정리)를 채워 §13.3-D 출구 3개를 상시 비교
가능하게. **Rust 무변경** (전부 backend REST + 프론트 계산). 파일: backend
`services/lp_netting.py`(신규)·`routers/lp.py`, 프론트 `BasketBuilderPanel`·
`ExitComparisonPanel`(신규)·`BasisBookPanel`·`BasisRouterPanel`·`QuoteParamsPanel`·
`useBasisZscore`(신규)·`lpStore`·`types/lp`.

**Part 1 — 넷팅 바스켓 빌더 (메인 출구, §13.2)**: `POST /api/lp/netting-basket` (body 없음,
원장 ETF 재고 읽음). 버튼 트리거 스냅샷 (실시간 스트림 아님). 부호 규약
`units_signed = net_qty/cu_unit`, 종목별 기여 `= −units_signed × pdf_shares` (롱 ETF → 매도
leg / 숏 ETF → 매수 leg), **종목별 float 끝까지 누적 후 최종 1회 round-half-to-even** (ETF마다
반올림하면 겹침 상쇄가 깨져 잔여 부풀음 — 0주 leg 제외). 현금분 별도 합. PDF는 etf_cache
우선·miss 시 etf_portfolio_daily on-demand(마스터/PDF **독립 MAX** — §9.8 버그1 방어).
futures_based ETF(114800·252670·251340)는 excluded(사유 반환)하되 `etf_holdings`엔 남김
(설정/환매 출구용). leg 비용: (a) 매도 leg 거래세 tax_sell_bp (b) ADV 임팩트 =
|주문주수|/ADV20(20일 평균 volume, ohlcv_daily) 비율 + 캡(기본 10%) 초과 플래그 (c) 종목
스프레드 v1 생략(caveat). has_stock_future = futures_master base 존재. UI: 주문표 테이블 +
합계 스트립 + 선물 오버레이 청산 안내(현 index_fut의 역방향 계약수) + **주식선물 배지 클릭 →
BasisRouterPanel 프리필+자동판정** + **주문표 클립보드 복사(탭 구분)**.

**넷팅 손계산 실측** (069500 롱 50000(1CU) + 102110 숏 50000(1CU), 둘 다 K200): 삼성전자
069500 매도 6978 vs 102110 매수 6987 → **순 +9주 매수**. 단독 069500 gross 65.05억 → 넷팅 후
gross **7.85M (0.1%)**, 잔여 18 leg(지수편입비 차이). 반대로 229200(KQ150)+069500(K200)은
겹침 0 → 350 leg 그대로(넷팅 없음). 부호 4방향 검증: 롱 ETF 단독=전 leg 매도·현금잔여<0,
숏 ETF=매수, futures_based 제외+holdings 잔존 — 유닛 하네스 전부 통과.

**Part 2 — 지수 베이시스 z-score**: `GET /api/lp/basis-zscore?k200=&kq150=&k200_spot=&kq150_spot=`.
Finance_Data `futures_daily_with_class`(NEAR, underlying '01'/'06')의 **`underlying_basis`
컬럼이 정확히 (선물 종가 − 현물지수 종가)** 실측 확인(2026-07-06: 01 close 1303.95 − K2G01P
1293.13 = 10.82 = ub) → 지수 조인 불필요. **만기 정규화 excess 기준** (독립 검증 F1 수정,
아래): 행별 excess = ub − spot×r×잔존일/365 (r=cost_inputs 자체 금리, spot=close−ub, 잔존일 =
행 날짜 기준 다음 분기(3/6/9/12월) 두 번째 목요일 — NEAR가 만기 당일까지 유지·익일 롤 실측이라
코드 파싱 불필요). raw 행 1h 캐시·excess 통계는 요청마다 재계산(금리 변경 즉시 반영). 현재값도
동일 정의: 실시간 베이시스(tick.basis) − 이론(tick.underlying_index×r×D/365, spot 미제공 시
직전 종가 폴백). UI: BasisBookPanel 지수 베이시스 행 z 칼럼 + |z|≥2 warning, 툴팁에
excess/실측/이론/분포/D-day.

**Part 3 — 출구 3개 비교 카드** (`ExitComparisonPanel`, 프론트 근사): 넷팅 바스켓 결과
(lpStore 공유)의 재고 명목 대비 **순 bp**로 통일 비교·정렬. ① 넷팅 바스켓+선물 청산 = −(거래세
+ 선물청산수수료 근사(재고명목×futures_fee_bp)) ② 호가 자연 건조 = 재고명목×base_spread_bp −
캐리(base_rate×소요일/365), 소요일 사용자 입력(v1) ③ 설정/환매 = CU 도달 ETF만
재고×cu_fee_bp(**신설 quote-param, default 2bp**). 각 카드 근사 각주 + 최선 하이라이트. 실측
(재고 137.5억): ① −1.4bp ② **+2.7bp(최선)** ③ −2.0bp — bp 산식 손계산 일치.

**검증**: backend `import main` OK·tsc 0·lint 0(신규/수정 파일)·cargo 무변경(realtime/
stat-arb-engine git clean). mock 8200 라이브 스모크: 넷팅 바스켓 생성(4종·168 leg·오버레이
역방향 8계약)·출구 3카드 bp 정렬·z-score 칼럼(excess 기준 −1.33σ, 툴팁 "excess −4.3 (실측
2.0 − 이론 6.3) vs 60일 excess 1.8±4.6 (n=60, D-64)")·주식선물 배지→라우터
프리필+자동판정(196170/170/매도, 시세미수신=mock 구독외 정상)·클립보드 복사·콘솔 에러 0.
**테스트 원장 전량 정리(0/0)**. 기존 회귀(ledger·basis_book·pnl_decomp·quote_board·quote-params
cu_fee_bp round-trip) 유지 — Rust serde가 미지 필드 무시(deny_unknown_fields 없음)라 quote-params
확장 안전.

**독립 검증 후 수정 3건 + 소소 2건 (F1·F2·F3, 2026-07-07)**:
- **F1 z-score 롤오버 오염 (부호 반전 실측)**: 60일 창에 6월물 43일 + 9월물 17일 혼합 → raw
  베이시스가 이봉 분포(혼합 5.91±6.24 vs 월물별 2.97/13.34), basis 10.82의 z가 혼합 +0.79 vs
  현재월물 −0.64로 **부호 반전**. → **(a) 만기 정규화 excess** 채택 (선호안): 행별 excess =
  ub − spot×r×잔존일/365. 잔존일은 "행 날짜 기준 다음 분기 2번째 목요일" 규칙으로 도출 —
  view가 만기 당일까지 NEAR 유지(2026-06-11 A0166000 실측)라 계약 코드 파싱 없이 정확.
  수정 후 excess 분포 1.76±4.61 (만기 기울기 제거 — 월물간 잔차는 실제 시장 rich/cheap),
  current 10.82 → excess 4.57 → z +0.61. 단위검증: 2nd Thursday 3건·롤 경계 2건·연말 경계.
- **F2 레버리지 ETF 바스켓 미차단**: 122630·233740은 PDF가 현물+지수선물+타 ETF 혼합 —
  현물 leg만 환산하면 실델타(2x)의 ~50%만 커버하는 주문표 무경고 생성 + 069500 등 타 ETF
  성분이 leg로 등장. → `LEVERAGED_MIXED_ETFS` excluded (사유 명시), etf_holdings에는 잔존
  (설정/환매 참조 — futures_based와 동일 처리). 재현 테스트: 122630 기장 → excluded·leg 0 확인.
- **F3 복수 is_cash 행 overwrite 비결정**: `etfs.py`·`lp_netting.py`가 마지막 is_cash 행
  덮어쓰기 + ORDER BY 없음 → 122630에서 설정현금액 88.6억 vs 원화현금 0.9억이 행 순서 따라
  뒤바뀜(~98배, **186 ETF 영향**). is_cash 행은 전수 2종(원화현금 010010·설정현금액 H00000)
  실측. **설정현금액 = NAV×CU 정확 일치 (summary 행), 원화현금 = NAV − Σ주식 정확 일치** →
  단순 SUM은 ~2× NAV로 이중계상. 채택: **SUM(is_cash) − 설정현금액(H00000) 제외**. iNAV 영향:
  122630 rNAV 항등 (8,769,088,640 + 90,829,483)/50,000 = 177,198.36 = NAV/주 **정확 일치**.
  arbitrable ETF(단일 원화현금)는 069500=2,760,388·229200=−1,610,760 불변 회귀 확인 —
  H00000 보유 ETF는 전부 파생형(arbitrable=False, UI 흐림)이라 iNAV 화면 위험 없음, 이제 결정적.
- 소소: cash_residual 라벨 → "현금 leg (음수=수취)" (부호 규약 명시·중립색) / lp.py 사구
  `_PRODUCT_TO_UNDERLYING` 제거.

**알려진 v1 근사/스코프**: (a) 종목 스프레드·시장 임팩트 krw 비용 미산입(ADV 비율/캡 플래그만) —
실현 비용 과소평가 가능 (b) 선물 청산 수수료 = 재고명목×fee 근사(승수별 정밀 명목 아님) (c) 자연
건조 스프레드=전량 스큐 소진 가정(낙관적)·소요일 수동 (d) z의 excess는 배당 미반영 + spot 폴백
시 직전 종가 근사 (e) 가격/ADV는 직전 거래일 프록시(장중 실시간 아님).

### 13.12 헤지 정합 보드 (Hedge Reconciliation, 2026-07-08 — 무기억 진단)

**목표**: 사용자(ETF LP)의 하루 출발점 질문 — "현재 원장이 PDF 기준으로 알맞게 헤지돼
있는지, 어디가 어떻게 어긋났는지, 델타가 얼마나 떠 있는지"를 한 화면에서. **Rust 무변경**
(backend REST 스냅샷 + 프론트). 파일: backend `services/hedge_recon.py`(신규)·`routers/lp.py`
(`POST /api/lp/hedge-recon`), 프론트 `components/lp/HedgeReconPanel.tsx`(신규, LedgerBoard 바로
위)·`lpStore`·`types/lp`·`pages/lp-matrix`.

**핵심 원칙 — 무기억(memoryless)**: 엑셀 임포트(bdb5130)가 매일 아침 원장을 회사 스냅샷으로
재구성 → 과거 체결·의도 태그 기반 분류는 구조적으로 불가. 따라서 "이 leg가 어떤 의도였나"가
아니라 **"이 종목 노출이 지금 다른 헤지 수단으로 설명되는가"**를 분류한다. 입력은 오직 현재
원장 aggregate + PDF + β(risk_estimator) + 가격 프록시(직전 종가).

**부호 규약 (전 계산의 뿌리)**: `required[종목] = −Σ(etf_net_qty/cu_unit)×pdf_shares` (여러 ETF
합산 — ETF 간 넷팅). `actual[종목] = 현물 net + Σ주식선물 net` (둘 다 주수 — 주식선물은 원장에
이미 계약×10 주수 기장, ledger_import STOCK_FUT_MULT). **`gap = actual − required = 그 종목에 남은
순 방향 노출`** (= ETF 합성 노출 + 원장 명시 포지션; gap 0이면 PDF 헤지 완전 정합). netting
빌더(76b44a2)의 PDF 합산·CU·ADV 골격 재활용.

**분류 캐스케이드 (채택 — 독립 검증 H1·H2·M1 수정 반영, 2026-07-09)**:
- `|gap| ≤ tolerance` (tol = max(1주, |required|×0.5%), 파라미터화·패널 로컬 입력):
  - `|actual_spot − required| ≤ tol` → **정합**(현물만으로 정합)
  - 그 외 → **대체 헤지**(주식선물 합쳐 정합)
- `|gap| > tol` (미정합): 종목 gap 델타(gap×price×β)를 **K200 풀**에 적재 (M1 — 헤지 티켓과 동일
  규칙: β가 KOSPI200 단일 팩터라 KQ150 구성종목 잔여도 K200 합산, §9.5 multi-factor 전 한계).
  지수선물경로 ETF(114800·252670·251340 선물지수추종 + 122630·233740 레버리지)는 PDF 환산 불가라
  gap 없이 β/배수로 **요구 델타만** 산출해 **자기 가족** 풀에 적재. 리밸런싱 주문 =
  `round(−gap × (1−covered))`:
  - `|주문| ≥ 1주` → **미설명**(진짜 리스크 — 종목 리밸런싱 대상)
  - `|주문| < 1주` → **매크로**(gap은 있으나 지수선물 오버레이로 설명됨). 단 |gapδ| >
    offset_warn_krw(기본 5천만, 파라미터) → **매크로(상쇄)** warning — net 커버 뒤에 숨은
    종목 스프레드 리스크를 숨기지 않음 (H2).

**가족 커버리지 — 부호 분리 + 단조 (H1 수정)**: 초판 `(|needed|−|needed+fut|)/|needed|`는 fut에
**비단조** — 정확 커버에서 1, 2배 과다 헤지에서 0으로 붕괴해 실행 시 |델타|가 2배로 악화되는
매도 주문표를 생성했다 (실측 재현). 채택 산식:
```
선물이 needed 반대 방향일 때만:  covered = min(|fut|,|needed|) / |needed|   (단조 비감소, 캡 1)
같은 방향(또는 한쪽 0)이면:      covered = 0
분해 (가산 항등 needed + fut = stock_unexplained + futures_excess):
  stock_unexplained = needed × (1−covered)          ← 종목 리밸런싱 몫
  futures_excess    = (needed+fut) − stock_unexplained ← 선물 초과/동방향 — 헤지 티켓 몫
```
과다 헤지(|fut|>|needed|)는 covered=1 → 종목 전부 매크로·주문 0, 초과분은 **"선물 과다"로 1급
표시** (가족 테이블 + 요약 스트립, "헤지 티켓에서 청산 제안 확인"). naked 지수선물(needed=0)도
전량 excess. **gross 병기 (H2)**: 가족 gross δ = Σ|gapδ| — 부호 넷팅이 반대 방향 종목 리스크를
숨길 수 있어(±35억이 미니 1계약으로 "설명"되는 실측) gross > 3×|net| & gross > offset_warn 이면
"상쇄 큼" warning 배지. fully_aligned 초록 배지 = 미설명 0종목 + 미설명·선물초과 δ < **100만원**
(1원 기준은 라운딩 잔차로 정상 북에서도 안 뜸).

**역할 분리 + 운영 규율 (M2 — 이중 실행 방어)**: 이 보드 = **종목 레벨 리밸런싱**(미설명 gap의
(1−covered) 몫만 종목 주문). 헤지 티켓(§13.3-B) = **북 델타 지수선물 마감**(가족 잔여 +
futures_excess). 두 수치는 **같은 델타의 회계 분해이지 주문 중복 제거가 아니다** — 보드 주문 δ
총합 ≈ 티켓 target이므로 둘 다 실행하면 이중 헤지. **운영 규율: 리밸런싱 주문을 실행·기장하면
티켓이 자동 재계산되므로, 티켓과 동시 실행 금지.** UI 요약 스트립에 상시 문구 + caveat 명기.
UI: 요약 스트립(정합/대체/매크로/상쇄/미설명 수 + 가족별 미설명 δ·선물 과다, 미설명 0이면 초록
"헤지 정합" / 종목 0인데 가족 델타만 문제면 warning "가족 델타 미설명 X억") → 종목 테이블(미설명
우선·요구/실제(현물·선물 분해)/gap/gap δ/분류 배지/리밸런싱 + 행 클릭 ETF 롤업) → 지수선물경로
ETF 섹션 → 가족별 매크로 델타 대조(net·gross·오버레이·커버리지·미설명(종목)·선물 초과) → caveats.
주문표 클립보드 복사. 주식선물 종목 배지 클릭 → BasisRouterPanel 프리필.

**손계산 실측 (mock 8200 라이브)**: (1) 부분 헤지 — 069500 롱 50000(1CU): 316140/010140 현물 정확
숏 = **정합**, 005930 주식선물(A1167000) 6978주 숏 = **대체**, KQ150 무헤지 전 종목 **미설명**·주문
= required 그대로(032820 매도 658 = |−658|). (2) **과다 헤지 (H1 재현·수정 검증)** — 069500 1CU
무현물헤지 + K200F 32계약 숏: needed +73.89억 vs 선물 −98.05억 → cov **100%**·**주문 0건**(수정 전
전량 매도 주문표 생성 버그), 선물 과다 −24.15억 1급 표시, 매크로(상쇄) 11종목(|gapδ|>5천만), 가산
항등 diff=0. 단위테스트 **77건** — 기존 7케이스(정확헤지·주식선물대체·지수선물매크로·무헤지=
required·다ETF합산·tolerance경계·지수경로ETF) + H1(1.5×/2× 과다 주문 0·excess 표기·cov 단조 비감소
0→1 캡·동방향 cov 0)·H2(net −2e7/gross 4.2e8 병기·상쇄 warning·macro_offset 2종·임계 파라미터
동작)·M1(KQ150 구성종목 → k200 풀·251340 → kq150 풀)·naked 선물 = excess 전부 통과.

**알려진 v1 근사/스코프**: (a) β는 KOSPI200 단일 팩터 60일 OLS(KQ150 종목 포함 — 티켓과 동일 규칙,
caveat 명기) (b) 지수선물 δ = 현물지수 직전 종가×승수 프록시(베이시스 무시) (c) 가격/ADV는 직전
거래일 프록시 — 가격 없어도 주수 레벨 gap·분류는 동작(가격은 델타·주문 예상대금·매크로 커버
판정에만; 결측 시 보수적 미설명 + caveat) (d) 유니버스 밖 ETF는 가족 미상 → k200 기본 배정(caveat)
(e) 기초 미해석 주식선물·현물지수 종가 결측은 caveat으로 명시(조용한 소실 금지). **테스트 원장
전량 정리(0/0)**. 기존 회귀(ledger·netting-basket·quote-params) 유지 — Playwright 실화면(부분 헤지
+ 과다 헤지 2시나리오) 확인·콘솔 에러 0.

### 13.13 화면 전/후 재구성 + MID 기반 호가 + 매수차/매도차 프레이밍 (2026-07-09)

**목표**: 화면이 세로로 길어져(패널 12개) 매매 사이클 단계가 뒤섞임 → **매매 흐름을 서브탭
2개로 분리**. 동시에 호가 앵커 갭이 last(체결가) 기준이라 스프레드 넓은 ETF에서 왜곡 → **호가
mid 기준가**로 보강하고, 갭을 지수 차익 데스크 언어(**매수차/매도차 + 진입선 도달률**)로 표현.

**Part 1 — 화면 전/후 재구성 (프론트 무로직변경 이동)**: `/lp-matrix`를 상단 4대 숫자 공통 고정
아래 서브탭 2개로 — **[체결 전·호가·기회]** = QuoteBoard(메인) + 지수 베이시스 z 요약 스트립
(`IndexBasisStrip` 신규, useBasisZscore 재사용·읽기전용) + 조작(CostInputs·QuoteParams);
**[체결 후·북 관리]** = HedgeRecon → HedgeTicket·BasisRouter → Ledger → BasisBook → Pnl → 넷팅
바스켓·출구 → FairValueMatrix·Residual·Unmapped. 서브탭은 URL query `?view=pre|post`에 반영(새로고침
유지, `replace` — history 미오염). **display 토글**(둘 다 마운트·CSS `hidden`) 채택 — 조건부 언마운트
대신: (a) 컴포넌트 로컬 상태(원장 입력 draft·행 확장) 보존, (b) 호가 구독·WS 재구독 폭주 방지.
숨겨진 뷰는 lpStore/WS 전역 단일 소스라 저비용 memo 렌더만(200ms QuoteBoard·1s pnl/basis).

**Part 2 — MID 기반 보강 (Rust)**: 유니버스 12종 호가 구독은 **페이지 레벨**
`usePageOrderbookBulk(universeCodes)` — 기존 ETF 스크리너와 동일 `/orderbook/subscribe-bulk` →
`SubCommand::SubscribeOrderbook`(**키B WS**, 09:00~15:45; 윈도우 밖·내부망·mock은 자연 폴백).
탭 레벨이 아니라 페이지 레벨이라 서브탭 전환에 재구독 없음(replace+cancel 폭주 회피). Rust
`scheduler.handle_tick`이 `OrderbookTick` → `etf_orderbooks: DashMap<code, (best_bid,best_ask,age)>`
적재(구독 코드만·lock-free). `flush` 호가 루프가 `MID_FRESH_MS`(6s) 내 갱신 + bid/ask>0면 mid를
`compute_quote_row`에 fresh로 전달 → **mid를 갭·차익 기준가**(ref_price)로, stale/결측이면 **last
폴백**. QuoteRow 신규 필드(serde 하위호환·프론트 optional): `ref_price·price_source('mid'|'last'|
'none')·best_bid·best_ask·gap_bp`(서버 산출, mid 반영). 역전 호가(bid>ask)는 mid 거부→last.
MockFeed: 12종 합성 호가의 base를 `mock_base_for`(하드코딩 base_price)로 교정(deterministic_base
쓰면 mid가 엉뚱한 base로 mean-revert해 유령 갭) + 소규모 구독(≤40) 호가 샘플 30%로 상향
(mid가 MID_FRESH_MS 내 유지).

**Part 3 — 매수차/매도차 프레이밍 (계산 재활용, 서버 산출)**: `compute_quote_row`가 기준가 갭
부호로 방향 판정 — **매수차**(gap<0 저평가 → ETF 매수+선물 매도, 요구엣지 = edge_bid_bp) /
**매도차**(gap>0 고평가 → edge_ask_bp; skew 비대칭 자연 반영). **진입선 도달률** `reach_pct =
|gap_bp| / arb_edge_bp × 100`, `at_entry = reach ≥ 100`. QuoteRow 신규 필드 `arb_side·arb_edge_bp·
reach_pct·at_entry`. UI(QuoteBoard): 기존 갭 컬럼을 **차익·진입선 도달률** 확장 셀로 대체 —
방향 라벨(매수차 초록/매도차 빨강) + |갭|bp + 도달률 게이지(요구엣지=100%, at_entry면 accent) +
진입선 bp. 진입선 도달 행은 배경 subtle 하이라이트(방향색 6% + 좌측 2px inset). 현재가 옆
mid/last 소스 배지. 구 Rust 스냅샷은 클라이언트 폴백(gap_bp 없으면 row.price로 재계산).

**검증**: Rust `cargo build/clippy` 신규 0 + 단위테스트 **+7**(총 82 통과) — mid_fresh 갭·mid_stale
폴백·호가결측 none·역전 거부·매수차 reach·매도차 at_entry·no_quote 프레이밍 억제. `tsc`/`lint` 0.
mock 8200 라이브 스모크: (a) 구독 전 12행 `src=last`·bid/ask 0, (b) `/orderbook/subscribe-bulk` 후
12행 `src=mid`·ref=mid·bid/ask 실 ETF가 정합(069500 last 136,600 → mid 136,650), (c) 언구독 +8s(>6s)
→ 전량 `src=last`·ref=last 복귀·bid/ask 참고값 잔존, (d) 매수차/매도차·도달률·at_entry 산출·렌더,
(e) 서브탭 전환 `?view` 반영·`reconnect_count=0`(WS 유지)·pre뷰 마운트 유지(display 토글)·post 12패널
전원 렌더·콘솔 에러 0. **호가 구독은 키B(09:00~15:45)·mock만 실측 — ls_api 장중 실호가 mid는
익일 장중 검증 필요**(mock으로 mid 경로 자체는 검증). 테스트 원장 무변경(0/0). Playwright 2탭
스크린샷.

**알려진 v1 근사/스코프**: (a) mock 갭은 하드코딩 base_price vs 지수선물 파생 FV 불일치로 과대
(±500bp) — mid/last·프레이밍 *기전*만 검증, 실갭은 장중 실측 (b) `etf_orderbooks`는 구독 전 코드
전부 적재(ETF 스크리너 수백종 동시엔 map 커짐 — 구독 범위 제한이라 실용상 무해) (c) mid는 best
1호가 중간값(호가 잔량 가중 X) (d) 페이지 레벨 호가 구독은 replace 시맨틱이라 LP/ETF-스크리너
동시 마운트 불가 전제(라우트 분리라 실무 무영향).

### 13.14 후속 트랙 — 내부망 실시간 원장 피드 + 확인 대기 항목 (2026-07-09 기록)

**현재 원장 입력 경로 (구현 완료)**: 회사 원장 화면 엑셀(3454/2514/5264) 다중 업로드 → 미리보기 → 반영 (`bdb5130`, §엑셀 임포트). x1 스냅샷을 매일 아침 통째로 반영하는 방식. **먼저 이걸 실원장으로 실전 검증한 뒤** 아래 내부망 트랙으로 진행하기로 합의(사용자, 2026-07-09).

#### (D) 내부망 실시간 원장 피드 — 보류 (엑셀 검증 후 착수)

사내 내부망에서 **시장 데이터와 별개로 원장 데이터를 실시간 조회**하는 경로가 존재(TCP or WS — 미확인). 종목별×계좌별로:
- **당일 매매내역**: 당일매수수량·금액, 당일매도수량·금액 (= t, 체결 로그·P&L 스프레드 귀속용)
- **장부 잔고**: 매수잔고수량·금액, 매도잔고수량·금액 (= **현재 상태 x1 직접**)

**핵심 이해 (설계 정정)**: 내부망은 잔고(x1)를 직접 주므로 "x0 + t 누적 재구성"이 아님 — **잔고가 항상 정답, 드리프트 없음**. 당일매매(t)는 포지션 계산이 아니라 체결 로그/스프레드 귀속에만 사용. 따라서 엑셀 x0의 역할은 포지션 재구성이 아니라 **"조회할 종목 코드 리스트 공급"**(아래 열거 제약 때문).

**제약 1 — 종목 열거 (enumeration)**: (계좌, 종목코드)를 인풋으로 하나씩 넣어야 조회 가능. "펀드 전체 불러오기" 없음. → 조회 대상 코드 리스트가 선행 필요. 리스트 소스 = **아침 엑셀 코드 ∪ 보유 ETF의 PDF 구성종목 ∪ 수동 추가** (장중 신규 편입 종목 누락 방지 — PDF 변경·신규 ETF 대응).

**제약 2 — 성능 (미측정, 확인 필요)**: 계좌당 종목 276~355개(3454 샘플 기준) × 3계좌 ≈ 900 호출. 사용자 체감 "50~100 호출만 돼도 느림"(미확인). → **호출 1건당 지연 실측이 설계 선결 조건.** 전략 후보: 잔고≠0 종목만 / 워치리스트 고속·전체 저속 2단 주기 / 스태거링.

**제약 3 — 프로토콜 스펙 (구현 blocker, 리포에 없음)**: TCP vs WS, 접속 주소·포트, 요청/응답 메시지 포맷(필드명), 인증 방식 — 사용자 제공 필요. (참고: 시장 데이터 내부망 WS는 `10.21.1.208:41001`, 원장 피드는 별개.)

**아키텍처 판단 (착수 시)**: 요청-응답 폴링이라 시장 WS의 subscribe-broadcast와 성격 다름. 원장은 lens.db(SQLite, FastAPI 소유)에 쓰므로 **FastAPI 측 폴러가 내부망 조회 → lp_ledger 기록**이 자연스러울 수 있음 (Rust는 시장 실시간 전담 원칙). 단 성능 측정 후 결정.

#### 확인 대기 항목 (익일 장중 or 실원장 검증)

- **엑셀 임포트 실전 검증**: 실제 회사 원장 3454/2514 업로드 → 미리보기 인식·환산·정합 경고가 실물과 맞는지. **특히 2514 수량이 계약수 가정이 맞는지**(다르면 주수 토글), 지수선물이 2514에 어떤 코드로 나오는지(미인식이면 excluded 확인).
- **2514 신양식 반영 완료 (2026-07-09)**: 2514 파생 화면이 10열(종목/종목명/**매매구분**/수량/평균단가/현재가/평가금액/평가손익/수수료/순손익)로 변경 — 수량이 절대값이라 매매구분(매수=+/매도=−)으로 부호 결정, 가격·금액 컬럼 신뢰 불가(평단 미기록). 파서 헤더 기반으로 신·구 겸용. 분류기(`_classify_sync`)도 **8자 영숫자를 선물로 인정**하도록 확장(예 `1GNW4000` 금양 F — A-접두 아닌 단축코드). 실파일 검증: 9종 부호·환산 정확, excluded 0.
- **futures_master 커버리지 갭 (확인 필요)**: 2514 실데이터의 `1GNW4000`(금양)·`A1B67000`(HPSP)가 `data/futures_master.json`에 없음 → 임포트는 되나 헤지 정합 base_code 매핑·실시간 가격이 빠짐(unmapped 처리). 신규 상장 종목선물 누락인지 마스터 갱신 주기 문제인지 확인 필요. (A1B67000은 A-접두인데도 누락 → 커버리지가 A-접두 여부와 무관하게 불완전)
- **호가 보드 MID 실측** (§13.13): 장중(키B 09:00~15:45) 12행에 `src=mid` 배지 켜지는지, 실갭이 상식 범위인지 (mock은 ±500bp 과대 — 아티팩트).
- **헤지 정합 보드 실측** (§13.12): 실원장으로 정합/대체/매크로/미설명 분류가 타당한지, 리밸런싱 주문표가 실제 매매와 맞는지.
- **γ 튜닝**: 폭락장 σ 레짐에서 재고 skew 강도 실감각 확인.

#### 기존 후속 트랙 (미해결 유지)

- LS WS idle watchdog stall 미감지 (select! 내 sleep 재생성 가설, 미확정)
- 지수선물 front-month 일일 re-resolve (현재 기동 시 1회)
- 지수 베이시스 당일 변화 기록 → P&L 지수 베이시스 항 활성화 (현재 v1 미산출)
- 원장 주식선물 자동 구독 (베이시스 페어 "시세 미수신" 해소)
- InternalFeed 지수선물 wire (내부망 실측 필요)
- multi-factor 리스크 (§9.5) — 헤지 정합·베이시스 북의 K200 단일 팩터 한계 해소

## 14. LP 데스크 (`/lp-desk`) — 섹터 ETF LP 심플 콕핏 (2026-08-20 확정)

**lp-matrix(§13)와 완전 별개 화면.** lp-matrix가 분석적으로 완전하지만 복잡해서 실운영에 못 쓰인다는 반성에서 출발. 이 화면의 설계 원칙: **"지금 호가 어디에 / 선물 몇 계약 / 뭐 정리" 3개 질문에만 답한다.** 화면 요소는 계기판(sticky 헤더) 한 장 + 테이블 한 장뿐. 레이아웃 문법은 실제로 잘 쓰이는 종목차익 화면(테이블 1장 + 행 펼침 + sticky 헤더)을 그대로 따른다.

### 14.1 운영 모델

- 섹터/테마 ETF에 지수선물(미니K200·KQ150F) 헤지를 전제로 호가 제시. 현물 바스켓 즉시 헤지는 포기 (체결 안 되거나 슬리피지 역마진 — 실측 경험).
- 체결 → 수동 입력(주문 연동 없음) → ETF별 β로 K200/KQ150 버킷 델타 합산 → 계약수 액션 표시 → 수동 집행.
- 정리: ① ETF 반대매매 + 선물 청산, 또는 ② PDF 분해·넷팅한 주식 바스켓 + 선물 청산 (장중/장 막판). 바스켓은 OMS 수동 입력이므로 산출물은 CSV/클립보드.
- 여러 날 보유(베이시스 운용)는 v1 구조 그대로 컬럼 추가로 확장 가능하게만 설계 (보유일수·괴리 z).

### 14.2 유니버스

36종 (2026-08-20 사용자 확정, 이상 없으면 확장). TIGER 섹터/테마 중심 + HANARO Fn K-반도체.
`396500 305540 494670 364970 364990 228790 228800 364980 462010 365000 139230 471760 0052D0 466940 157500 400970 228810 157490 307520 139250 292150 139220 377990 0091P0 0117V0 091220 138540 0148J0 395270 261070 138530 261060 227540 138520 364960 150460`
정의 파일: `backend/data/lp_desk_universe.json` (코드 배열 — 수정만으로 유니버스 변경).

### 14.3 통계 파이프라인 (호가 근거)

- **2-팩터 회귀**: ETF 일간수익률(`ohlcv_daily.adj_close`) ~ K200 지수(`index_ohlcv_daily`, `K2G01P`) + KQ150 지수(`Q5G01P`) 수익률. 창 120영업일, 절편 포함 OLS.
- 산출: β_k200, β_kq150, R², 잔차변동성(bp/일), 최근 잔차 z (잔차의 창 내 표준화).
- 상세용: rolling 60일 β 시계열, 잔차 시계열/히스토그램.
- **지수로 회귀하고 선물로 집행하는 이유**: KQ150 선물 일봉이 2026년~라 짧고, 선물 연결은 롤 점프 보정 필요. 지수 β ≈ 선물 β (베이시스 노이즈 무시). 미니K200 일봉도 FD에 있음(underlying 05) — 검증용 참고만.
- **과거 괴리 분포 (호가 밴드의 원천, 2026-08-20 추가)**: 공식 NAV 히스토리가 FD에 없어(etf_master_daily의 net_asset/listed_shares는 시점 불일치로 σ 900bp+ — 사용 불가) **PDF 재구성 NAV**를 쓴다: `navʳ_t = (Σ 구성종목 shares×close_t + 현금)/CU`, `gap_t = (close_t − navʳ_t)/navʳ_t` (bp). 검증 실측: 396500 평상시 gap −75~+30bp — 올바른 스케일. **필터 필수**: 구성종목 종가 결측일 제외 + |gap|>500bp 제외 (2026-08-10·11 PDF 수량 100배 적재 이상 실측 — 전 ETF 공통). 창 120일, 유효 표본 60 미만이면 gap 통계 null. 산출: gap_mean_bp, gap_sigma_bp, 유효표본수, gap 시계열/히스토그램(상세용).
- **가격 없는 레그는 바스켓에서 뺀다 (2026-08-26 사용자 확정 — 파생 내장 ETF 대응)**: 위 결측 필터를 **2단으로** 쪼갠다. ① **영구 결측 레그 제외** — 창 전체에 가격(일봉 종가 / 30초봉)이 **하나도 없는** 비현금 구성은 재구성 대상에서 아예 뺀다. ② **일시 결측 필터 유지** — 남은 구성에는 종전 그대로(그날/그 봉에 하나라도 빠지면 폐기, |gap|>500bp 컷). 판정은 **코드 패턴이 아니라 데이터 존재 여부**라 옵션·선물뿐 아니라 전 기간 거래정지 종목에도 일반적으로 걸린다(SQL `priced` CTE — `lp_desk_stats._GAP_SQL`(일봉)·`lp_desk_calib._SQL_NAVR`(30초봉) 양쪽 같은 규칙).
  - 계기: **472150 TIGER 배당커버드콜액티브**. PDF에 코스피200 콜옵션 매도·선물 레그(B0xxxx·A0xxxx)가 섞여 있고 이들은 `ohlcv_*`에 없다 → 매일·매 봉 `missing>0`이 떠서 **일봉 gap 0표본 / 장중 g 0봉**, 즉 호가 산출이 통째로 불가였다. 제외 후 **일봉 gap μ +16.3 / σ 37.7 (118표본), 장중 g μ −5.5 / σ_레벨 14.7 (9일 6,660봉)** — 다른 37종과 같은 스케일로 정상 산출된다. 나머지 37종은 제외 레그가 0개라 μ·σ **완전 불변**(전수 대조 확인).
  - ⚠️ **한계 — 감수한다**: 뺀 레그의 가치(옵션 프리미엄·선물 평가손익)만큼 재구성 NAV가 어긋나므로 **μ에 레벨 편차**가 실릴 수 있다. 커버드콜은 모든 레그가 결국 같은 지수를 추종해 편차가 크지 않다는 판단(사용자 확정)이고, 실측 μ −5.5bp도 다른 종목 대역(−4.4~−12.5bp) 안이다. 몇 개를 뺐는지는 `calib.excluded_legs`(창 내 최대, 472150 = 4)로 내려보내 x·제안 호가 툴팁에 한 줄로 밝힌다 — **숨기지 않고 표시한다**가 원칙. (참고: 이 PDF의 파생 레그는 `shares`가 0으로 적재돼 있어 현재는 실제 기여분도 0이다.)
- ⚠️ **재구성 gap σ의 한계 (2026-08-20 검증 실측)**: gap 시계열 lag-1 자기상관 중앙값 0.08 (백색잡음 수준) — 실제 ETF 괴리는 일간 지속성 0.3~0.6이므로, 이 σ(24~55bp)는 **T-1 PDF×당일 종가 재구성 오차가 지배**한다. μ는 n=118·표준오차 ≈3bp로 유효 (ETF별 구조적 프리미엄/디스카운트 반영). 따라서 z·σ 항의 정보량은 제한적 — 호가 차등의 실질 원천은 μ와 밴드, 그리고 선물 상대 스큐.
- 공식 NAV가 필요해지면 LS `t1903`(ETF일별추이 — 일별 NAV·괴리율 제공)이 대안이나, FastAPI에 LS REST를 새로 여는 건 토큰 충돌 리스크가 있어 v1 보류. **권장 후속: Finance_Data 야간배치(키B)에 t1903 적재 추가** → 공식 NAV·괴리율 히스토리 확보 시 σ가 진짜 분포가 됨.
- 갱신: FastAPI 기동 시 + 첫 요청이 날짜 바뀌었으면 재계산. 메모리 캐시.

### 14.4 헤지 환산

- 버킷 노출(₩) = Σ_ETF (포지션 평가액 × β_버킷).
- 목표 계약수 = −버킷노출 / (선물가 × 승수). 승수 상수: 미니K200 50,000 / KQ150F 10,000 (K200F 250,000은 참고 표기).
- 프론트가 실시간 선물가로 계산 (서버는 β·포지션만 제공). 액션 줄 = "목표 − 보유" 차이.
- 잔차(헤지불가) = Σ|포지션 평가액| × 잔차변동성 가중 합 — 한도와 비교 표시 (한도 기본 ₩50M, localStorage 튜너블).

### 14.5 호가 제안 (2026-08-20 3차 확정 — 2층 구조)

**폐기 이력** (모두 사용자 지적): ① `base+k×잔차vol` — 호가 40틱 밖. ② `괴리 μ±zσ + 고정 밴드(+5~+15/−35~−20) 클램프 + w×rel 스큐` — 상수 밴드는 ETF별 시장 현실과 무관 (396500은 시장 호가가 NAV에 붙어 있어 상수 밴드 호가는 체결 0). 상하한·시장 호가 조인 프레임도 기각 — **체결을 쫓지 않고 유리한 극단에 대기하는 LP**가 전제.

**확정 구조 — 캘리브레이션(배치)과 호가(실시간)의 2층 분리:**

**4차 정정 (2026-08-21, 사용자 지적)**: 3차의 `F_fair = 전일종가×(1+β·선물등락)` 앵커 + s 분위수는 **오류** — 섹터 ETF의 NAV는 지수와 무관한 섹터 고유 요인으로 일중 ±100~200bp 움직이고(= 헤지 후 잔차 리스크), 그것이 전부 s에 잡혀 제안 호가가 NAV 대비 200~300bp 밖에 섰다. LP 호가는 NAV 주변이어야 하며, 섹터-지수 괴리는 호가 위치가 아니라 잔차 리스크·청산 edge의 영역. 실측이 증명: s 분위수 수백 bp vs **g(가격 vs 장중 재구성 NAV) σ 4.9~11.9bp — 사용자의 "+5~15bp" 감각과 일치하는 쪽은 g**.

**4차 보완 (2026-08-21, 사용자 최종 확정 — "NAV 괴리 분포와 선물과의 괴리 분포를 조합해서 2시그마 정도에 호가")**: x는 분위수 선택이 아니라 **두 분포를 결합한 폭**이다. 호가가 걸려 있는 몇 분 동안 나를 때리는 움직임은 두 갈래 — ① 가격이 NAV 주변에서 흔들리는 폭(g) ② 그 사이 ETF가 선물 대비로 밀리는 폭(s의 단기 증분). 서로 다른 축이므로 제곱합으로 합친다. s의 **레벨**은 여전히 호가에서 빠져 있다(위 4차 정정 그대로) — 들어가는 건 증분뿐이다.

**5차 보완 (2026-08-21, 사용자 강한 지적 — √T 환산 폐기)**: σ_r을 30초 증분 σ × √(T/30초)로 만들던 경로는 **랜덤워크 가정이 데이터에서 기각돼** 폐기했다. 305540 실측: 30초 증분 σ 7.84bp → √10 환산 25.0bp인데 **5분 변화를 직접 재면 17.2bp**(분산비 0.47), 2분 12.3bp(VR 0.62), 1분 9.8bp(VR 0.77). s는 되돌리는 성질이 있고 30초 증분엔 호가 바운스 잡음이 섞여 있어 √T가 지평이 길수록 σ_r을 부풀린다 — **제안 호가가 30~70bp씩 벌어진 주범이 이것**이었다. 이제 **지평별로 직접 측정**하고(1/2/5분), 지평 T 자체가 튜너 노브가 된다(기본 **1분**).

**호가 층 (실시간, 프론트):**
```
매도 제안 = tick올림( iNAV × (1 + x_ask) )   /   매수 제안 = tick내림( iNAV × (1 + x_bid) )
x_ask = μ_g + z·σ_comb        x_bid = μ_g − z·σ_comb          z 기본 1.5 (헤더 프리셋 1.0/1.25/1.5/2.0σ)
σ_comb = √(σ_g² + σ_r²)
  σ_g = g의 pooled **레벨** σ (일중 demean 아님 — 날짜 간 레벨 이동 포함)
  σ_r = `s_diff_sigma_bp[T]` — 지평 T에서 **직접 측정**한 s 변화의 pooled σ (T = 1/2/5분 선택, 기본 1분)
```
- 호가 노브는 **z와 지평 T** 둘. T는 "호가를 걸어 두는 시간"이고, 프론트는 서버가 잰 σ를 고르기만 한다 — **환산하지 않는다**(5차 보완). z는 자유 입력이 아니라 **헤더 세그먼트 프리셋**(1.0/1.25/1.5/2.0σ)이고 **기본 1.5σ** — 2σ는 실측 8거래일 중 매도측 도달 0일로 사실상 체결 불가, 1.5σ가 "가끔·유리한 순간만"의 빈도였다 (2026-08-21 사용자 확정).
- 앵커 = iNAV (실시간 공식 NAV 프록시), 중심 = μ_g. 선물은 **폭의 σ_r로만** 들어간다 — 레벨·앵커에는 관여하지 않는다.
- σ_r이 null(선물 30초봉 없음 — 내부망)이면 **차단이 아니라 degrade**: σ_comb = σ_g로 좁혀 호가를 내되 x 셀을 경고 톤 + 사유 표기. 호가가 선물 적재 상태에 인질로 잡히면 안 된다.
- 체결 임박 강조 = 실시간 괴리(가격 vs iNAV)가 x에 접근할 때 (선물 없이 판정 — 내부망에서도 호가·임박 동작).
- ⚠️ 재구성 NAV와 공식 NAV의 상수 편차(보수·배당 계상, 10~20bp급 가능)가 μ_g에 실릴 수 있음 — t1903 공식 NAV 적재(FD 후속)로 해소 전까지 실시간 괴리 컬럼과 대조하며 운용.

**캘리브레이션 층 (백엔드 배치 — 기동 시 + 장중 1시간 주기, x는 실시간 불변이 사용자 요구):**
- 최근 10거래일 **30초봉**: ETF·구성종목 `ohlcv_intraday`(2026-08-03~), 지수선물 `futures_ohlcv_intraday`(A01/A06 근월물, 일자별 NEAR 해석).
- `g_t = (P_t − NAVʳ_t)/NAVʳ_t` — 현재가 vs **장중 재구성 NAV**(당일 PDF × 구성종목 30초봉 + 현금, /CU). **호가 중심·폭의 절반**: `g_mean_bp`(μ_g) + `g_sigma_level_bp`(σ_g). 선물 불필요 → 표본 09:10~15:20 하루 전체, 내부망에서도 산출 가능.
- `s_t = (P_t/P_전일종가 −1) − β_K×(F_K,t/F_K,전일 −1) − β_Q×(F_Q,t/F_Q,전일 −1)` — 선물 대비 스큐 경로. 호가가 쓰는 건 **지평별 s 변화의 pooled σ**(`s_diff_sigma_bp = {60,120,300}`)뿐 — 일별 배열 안에서 봉 간격이 정확히 k×30초인 **비중첩** 차분만, 일 경계·결측봉 구간은 제외. 지평당 유효 쌍 300개 미만이면 그 지평만 null. `s_inc_sigma_bp`(30초 증분 σ)는 √T 부풀림 대비용 **참고 표시**로만 유지. 레벨(분위수·경로)은 잔차 리스크 감각·"선물대비(오늘)" 컬럼·상세 표시용으로만 유지 (표본 11:26~15:20, 선물 30초봉 제약).
- 분위수·도달 일수는 **표시·참고용**으로 유지. x는 분위수가 아니므로 서버가 도달 일수를 미리 못 센다 → 일별 g 극값(`g_day_max`/`g_day_min`)을 실어 보내 프론트가 그 x 레벨에서 같은 정의로 센다.
- 단일가 구간 제외 (개장 직후·마감 동시호가 — 통계차익 인트라데이 관행 준용). 표본 부족 ETF는 μ_g·σ_g null → 호가 제안 없음 + 경고 표시 (구간 데이터가 8/3부터라 초기 며칠 짧음).

운영 사이클: 이 호가로 대기 → 스큐 열린 체결만 수집 → **포지션이 선물을 이기는 순간(§14.6 edge)에 정리**. 여러 날 걸쳐도 됨.

### 14.6 체결·포지션 (SQLite lens.db)

- `lp_desk_fills`: id, ts, etf_code, qty(±), price, entry_inav(입력 시점 iNAV, 프론트가 첨부), note.
- `lp_desk_hedge_fills`: id, ts, contract('MK200'|'KQ150F'), qty(±), price.
- fills에 진입 시점 스냅샷 저장: `entry_inav` + **`entry_k200`·`entry_kq150`(지수선물가, 2026-08-20 추가)** — 프론트가 POST 시 실시간 값 첨부, 없으면 null.
- 포지션 = fills를 시간순으로 접는 **평균원가법** (증가=|수량| 가중, 감소=평단·진입치 불변, 관통=리셋 — 부호합 가중은 부분 왕복 시 발산해 폐기, 2026-08-20). entry_k200/entry_kq150도 같은 규약으로 가중.
- **청산 신호 = 헤지 상대성과 (2026-08-20 재설계, 사용자 핵심 요구)**: "포지션 ETF가 선물을 이기는 순간"을 잰다.
  `edge_bp = sign(qty) × [ (P/P₀−1) − β_k×(F_k/F_k₀−1) − β_q×(F_q/F_q₀−1) ] × 1e4`
  (P₀=평단, F₀=가중 진입 선물가, F=실시간 선물가 — 프론트 계산). edge ≥ X bp(기본 15, 튜너블) 배지.
- 행 PnL = edge × |평가액| (**헤지 후 PnL** — ETF 단독이 아니라 선물 상대). 진입→현재 괴리는 보조 컬럼으로 유지. 선물 계좌 PnL은 헤더 총액.

### 14.7 출구 바스켓 (정리 미리보기)

- 현 ETF 포지션 전체 → 최신 `etf_portfolio_daily` PDF 분해: 종목수량 = Σ_ETF (qty / creation_unit × shares). is_cash 제외, `stocks.market`으로 KOSPI/KOSDAQ 분류 (미분류는 표기).
- 산출: 넷팅 주식 바스켓 (종목/시장/±수량/평가액, 전량) + 청산할 선물 레그 + CSV/클립보드 복사.
- 헤더 버튼 → 테이블 위 전폭 확장 영역. 상시 패널 아님.

### 14.8 화면 (컴포넌트)

- **sticky 헤더(계기판)**: K200F·KQ150F 시세 / **총 미헤지 델타(₩)** 신호등 / 버킷 2줄(노출→계약수 액션, 보유/목표) / 잔차·한도 / 체결 원라인 입력(`코드 ±수량 @가격` 엔터) / 정리 미리보기 버튼 / 튜너(**호가 z**·청산 X·잔차 한도 — 4차 보완으로 호가 노브는 z 하나).
- **테이블(유일한 본문)**: 행=36 ETF. 컬럼 그룹 ① 시세·호가(iNAV/제안bid·ask/시장최우선호가/현재가) ② 통계 근거(괴리 μ·σ/β_K/β_Q/R²) ③ 포지션(수량/진입→현재괴리/**헤지 상대성과 edge bp**/헤지 PnL/신호). 필터·정렬 최소 (36행 = 한 화면).
- **행 펼침**: **괴리 분포 히스토그램(현 호가 밴드 음영) + 괴리 시계열** / rolling β 차트 / 잔차 z / PDF 상위 10 (종목차익 EtfHoldersTable 패턴 재사용).
- 실시간: ETF 현재가·호가·iNAV = 기존 usePage* 구독 훅. 지수선물 = 기존 선물 구독 경로 (futures 탭과 동일).
- 상승/하락 색상 토큰은 종목차익 화면과 동일하게 (사용자 요구 2026-08-20).

### 14.9 API 계약 (`routers/lp_desk.py`, prefix `/api/lp-desk`)

- `GET /master` → `{stats_date, params:{window}, calib_params:{...,g_window,s_window,**s_diff_horizons**:[60,120,300]}, items:[{etf_code,name,beta_k200,beta_kq150,r2,resid_vol_bp,resid_z,creation_unit, prev_close,prev_close_date,prev_close_stale, gap_mean_bp,gap_sigma_bp,gap_obs, calib:{**g_mean_bp**, **g_sigma_level_bp**, **s_diff_sigma_bp**:{"60","120","300"}, s_inc_sigma_bp, **g_day_max**[], **g_day_min**[], g_quantiles:{p05..p95}, g_touch_days, g_days, g_bars, s_quantiles, touch_days, g_sigma_bp, days, bars} }]}` (gap_*·calib null 가능)
  - **호가 x = `g_mean_bp` ± z·√(`g_sigma_level_bp`² + `s_diff_sigma_bp[T]`²)** (5차 보완, T = 프론트 선택 지평 초). 프론트는 √T 환산을 하지 않는다 — 각 지평의 σ가 이미 직접 측정값이다. 분위수(`*_quantiles`·`*_touch_days`)는 표시·참고용으로 유지. `g_day_max`/`g_day_min`은 길이 = `g_days`인 일별 극값 — 분위수가 아닌 임의 x 레벨의 도달 일수를 프론트가 직접 세는 재료다.
  - `g_sigma_bp`(일별 demean 후 = 하루 안의 흔들림)와 `g_sigma_level_bp`(레벨 σ)는 **다른 값**이다. 호가 폭에 들어가는 건 후자.
  - 두 축은 표본 창이 달라 일수/봉수가 따로다(`g_days`/`g_bars` vs `days`/`bars`). 한쪽만 표본 부족이면 그 블록만 null, 둘 다 부족해야 `calib: null`. 선택한 지평의 `s_diff_sigma_bp[T]`가 null이면 호가는 σ_g만으로 degrade.
- `GET /detail/{etf_code}` → `{rolling_beta:[{date,bk,bq}], resid:[{date,bp}], s_hist:{bins,counts}, s_recent:[{t,bp}] (최근 수일 30초 경로), g_hist:{bins,counts}, gap:[{date,bp}], pdf_top:[{code,name,weight_pct,market}]}`
- `GET/POST /fills`, `DELETE /fills/{id}` / 동일하게 `/hedge-fills`
- `GET /positions` → per-ETF 합산 + 헤지 계약 합산
- `GET /exit-basket` → `{pdf_date, rows:[{code,name,market,qty,est_value}], futures_legs, cash_omitted}`

### 14.10 v1에서 의도적으로 뺀 것

5단 캐스케이드 표시 / m×n 매트릭스 / P&L 5분해·markout / 헤지 정합 보드 / 선물내재 iNAV 보정 / 자동 주문 / 여러 날 베이시스 운용 UI (구조만 대비). 깊은 분석은 lp-matrix로 — 단 화면 간 링크도 걸지 않는다 (독립).

### 14.11 §14.5 2층 구조 구현 기록 (2026-08-20)

- **캘리브 층** = `backend/services/lp_desk_calib.py` (신규). 기동 시 백그라운드 1회 + **1시간 주기 버전 프로브**. 버전 키 = (유니버스 30초봉 최신 봉 시각, `lp_desk_stats` 패널 버전) — 인트라데이는 야간 배치라 장중 프로브는 대부분 스킵되고, 값이 바뀌었을 때만 재계산한다(무의미한 매시간 재계산 회피). 강제 실행은 `POST /api/lp-desk/calib/refresh`.
- **소요 11~12초/36종** (PG 4쿼리 + numpy). 지배 항목은 장중 재구성 NAV(구성종목 381종 × 10일 30초봉을 (ETF,bar) SUM으로 DB에서 집계 — 10.5초). s 쪽은 0.5초.
- 근월물 해석은 **뷰 `futures_daily_with_class`가 아니라 기반 테이블 `futures_ohlcv_daily`**(class NEAR/NEXT 동시 수신 → contract_code로 전일 종가 직접 조회). 그 뷰의 NEXT 갈래가 30초봉 hypertable 전체에 dense_rank를 도는 UNION이라 **단독 실측 56초**였다. 전일 앵커는 `settle_price`가 0으로 적재돼 있어 `close` 사용.
- ⚠️ **선물 30초봉은 11:26~15:45만 존재**(LS 500봉/일 상한). 그래서 s 표본은 실질 **11:26~15:20 = 469봉/일**이고 오전장 스큐는 아직 관측 불가. g(=NAV 괴리)는 선물이 필요 없어 09:10~15:20 전체(673봉/일)를 쓴다. FD가 오전분을 적재하면 코드 수정 없이 자동 확장.
- **x의 스케일은 잔차변동성이 결정한다.** 2026-08-19 기준 실측 p90은 +47~+590bp인데, 이는 현재 FD 데이터의 일간 잔차변동성이 176~296bp(K200 일간 ±4~6%)이기 때문 — s의 폭은 정의상 "당일 누적 잔차"라 잔차vol에 비례한다. 정상 시장(잔차vol 40~60bp)이면 p90은 수십 bp 대로 내려온다. 분위수 선택(p75/p90/p95)이 이 스케일을 조절하는 유일한 노브다.
- 호가 층은 프론트 `lib/lp-desk.ts::suggestQuote` 1함수. 튜너 localStorage 키 `lpDesk.tuner.v4` (v1~v3는 로드 시 삭제 — 폐기 공식). 검산: 396500 전일종가 33,140 · β(1.0927, 0.2078) · K200F +1.00% / KQ150F −0.50% → F_fair 33,467.68 → x매수 −172.94bp/x매도 +155.6bp → **매수 32,885 / 매도 33,990**.

#### 3차 구조 검증 후속 수정 (2026-08-20)

첫 구현 검증에서 나온 결함 10건 정리. 표시가 사실과 어긋나던 것(①②④)과 산출이 조용히 틀리던 것(③⑥⑦)이 섞여 있었다.

1. **전일종가 이원화 통일** — 등락률·오늘 s는 *틱 전용*, F_fair는 *틱 → 서버 폴백*이라 같은 행에서 서로 다른 기준가를 쓰고 있었다(장 초반·틱 미수신 종목에서 "s는 없는데 호가는 있다"). 이제 행 계산 초입에서 `prevClose = 틱 prev_close(etf→stock) || 서버 prev_close || null`을 **한 번만** 해석하고 등락률·s·호가가 그 하나를 공유한다. null이면 셋 다 사유 있는 "—".
2. **"+0.00%" 폐기** — 등락률 `?? 0`이 미수신을 보합으로 위장했다. `changePct: number | null`로 내리고 `PriceCell`이 null을 "—"로 렌더한다.
3. **전일종가 신선도** — `/master`에 `prev_close_date` + `prev_close_stale`. stale 판정 기준은 **응답 시점의 오늘 기준 직전 거래일**(`krx_holidays` + 주말 제외, 캘리브 스냅샷이 들고 있는 휴장일 집합으로 계산). 프론트는 **서버 종가로 폴백한 행에서만** stale을 적용해 호가를 억제하고 사유 `전일종가 미갱신(YYYY-MM-DD)`을 표시한다 — 실시간 틱의 prev_close가 있으면 그게 거래소 기준가라 FD 적재 지연과 무관하다. 등락률·오늘 s는 계산은 되므로(2거래일 이상 수익률이 된다) 현재가 셀 등락률을 경고 톤 + 툴팁으로 표시한다.
4. **도달 지표 교체: 클러스터 수/일 → 도달 일수** — 구 지표는 **비단조**였다(실측 p90 0.1회 < p95 1.9회). 레벨을 넘나든 *횟수*라 꼬리로 갈수록 크로싱이 줄어 값이 되살아나서, 체결 가능성으로 읽으면 정확히 거꾸로 읽힌다. 이제 `touch_days` = 창 N일 중 **일중 max(s) ≥ level(상방) / min(s) ≤ level(하방)인 날 수** — 정의상 단조. 화면 문구는 "10일 중 N일 도달". 36종 전수 단조 확인(2026-08-20). 실측: 396500 p75/p90/p95 = 4/1/1일, 364980 3/1/1일 — p90 이상은 10일 중 1일만 열린다(= s 분포가 소수의 큰 날에 지배됨을 그대로 보여준다).
5. **캘리브 표본 창 표시** — `calib_params.s_window`에 **실측** 시각 범위(현재 `11:26~15:20`)를 담아 헤더에 `· s 표본 11:26~15:20`으로 노출. 선물 30초봉 적재 구간(LS 500봉/일 상한) 제약이라 오전장 x는 참고치임을 화면만 봐도 알 수 있게 했다.
6. **분위수 편측 null** — `suggestQuote`가 all-or-nothing(한쪽 분위수만 없어도 양쪽 "—")이었다. 사유를 `askReason`/`bidReason`으로 쪼개 한쪽만 "—"가 되게 했다. F_fair 자체를 못 만드는 사유(β·전일종가·stale·선물)는 여전히 양쪽 차단.
7. **nearSide 부호 반전** — "x_ask > 0일 때만" 판정해서 **x_ask가 음수인 종목은 영원히 강조되지 않았다**(p75 선택 시 494670·365000·228810 3종 실측). 체결 조건 자체가 방향이므로 부호를 빼고 `s ≥ x_ask − 0.2|x_ask|`(매도) / `s ≤ x_bid + 0.2|x_bid|`(매수)로 일반화.
8. **MIN_BARS 200 → 1400** (≈3거래일치, 469봉/일 기준). 하루치 표본으로 p90/p95를 확정하면 그날 스파이크가 곧 호가 레벨이 된다. 상향 후에도 36/36종 캘리브 유지 확인.
9. **배당락 주석 정정** — "s 앵커(lag close)와 실시간 호가 층이 같은 정의"는 **거짓**이었다. 거래소·LS 틱의 prev_close는 배당락 **조정 기준가**인데 캘리브 앵커는 조정 전 raw lag close라, 배당락일 하루치 s가 배당락률만큼 통째로 밀린다(분기 배당이면 창 10일 중 1일 오염 → 분위수가 그쪽으로 끌림). 코드는 그대로 두고 **알려진 한계**로 명시.
10. **시장 호가와의 거리 표시** — 제안 호가 셀 보조줄(회색)에 `x bp · ±N틱`. 틱 = (매도: 제안−시장최우선매도 / 매수: 시장최우선매수−제안)/5원, **양수 = 시장 밖에서 대기**. "내 호가가 시장에서 얼마나 밖인지"가 대기/체결 감각의 핵심이라 툴팁이 아니라 셀에 뒀다. 시장 호가 미수신이면 생략.

#### 4차 정정 구현 기록 (2026-08-21) — 앵커 iNAV + x = g 분위수

3차 구조가 틀렸던 지점은 하나다: **호가 위치와 잔차 리스크를 같은 자로 쟀다.** s는 "지수선물로
안 덮이는 섹터 고유 움직임"이라 정의상 잔차변동성 스케일(일간 176~296bp 레짐에서 p90 +47~+590bp)이고,
그걸 호가 폭으로 쓰면 제안 호가가 NAV에서 수백 bp 밖에 선다. 호가는 NAV 주변이어야 한다.

- **백엔드** (`services/lp_desk_calib.py`): g 파이프라인에 s와 같은 분위수·도달일수 산출을 붙였다
  (`_quantile_block()` 공용 커널 — 일별 극값 한 벌로 6레벨 도달일수를 한 번에). g는 **raw 레벨**
  (demean 아님 — iNAV에 직접 곱하는 값이라 ETF별 상수 프리미엄/디스카운트도 실려야 한다).
  `g_sigma_bp`는 종전대로 일별 demean 후 산포(= 하루 안의 흔들림)로 남긴다 — **레벨은 분위수,
  흔들림은 σ**로 역할이 갈린다.
- **g 계산을 선물 의존에서 떼어냈다.** 종전엔 g 누적이 s 루프의 `continue` 가드(선물 앵커·봉) 뒤에
  있어 **선물 봉이 없는 날은 g도 조용히 버려졌다**. 이제 g를 먼저·독립으로 판정한다. 호가의 원천이
  선물 적재 상태에 인질로 잡히면 안 된다.
- **하한 이원화**: `MIN_BARS 1400`(s, 469봉/일) / **`MIN_G_BARS 2200`**(g, 실측 740봉/일 — 둘 다 ≈3거래일).
  `calib`은 g·s 중 **하나라도** 있으면 살아 있고, 없는 쪽 블록만 null이다 (종전엔 s 부족 = calib 통째 null
  → 호가까지 죽었다).
- **`calib_params.g_window`** 추가. 실측 `09:10~15:20`(선물 불필요 = 하루 전체) vs `s_window` `11:26~15:20`.
  헤더에 둘 다 표기해 "어느 표본이 호가를 만드는가"를 화면만 봐도 알게 했다.
- **프론트**: `suggestQuote(inav, calib, askKey, bidKey)` — 인자에서 전일종가·β·선물등락이 전부 빠졌다.
  `매도 = tick↑(iNAV×(1+x_ask))` / `매수 = tick↓(iNAV×(1+x_bid))`, x = `g_quantiles`. null 사유는
  `캘리브 없음` / `iNAV 미수신` / `g pXX 없음` 3종(편측 유지). **prev_close_stale 게이트는 호가에서 제거** —
  앵커가 iNAV라 무관하고, 등락률·오늘 s의 경고로만 남는다.
- **체결 임박(`nearSide`) 입력을 s → 실시간 g로 교체**하고, 강조도 s 셀이 아니라 **괴리bp 셀**로 옮겼다.
  판정되는 값과 강조되는 값이 다르면 화면이 거짓말을 한다. `선물대비` 컬럼은 잔차 감각 컬럼으로 유지
  (툴팁에 "호가와 무관" 명시).
- **행 펼침 재배치**: `LevelHistogram`(구 SHistogram 일반화 — 라벨을 인자로) 한 컴포넌트를 g·s 두 곳에서
  쓴다. 맨 앞이 **g 분포(호가 근거, x 마커·도달일수·지금 g)**, s 분포·경로는 "잔차 리스크" 섹션으로
  강등하고 그 수평선은 **x가 아니라 s 분위수**로 바꿨다(자가 다른 선을 겹치면 "선물 대비 이만큼
  벌어져야 체결"이라는 거짓 신호가 된다). 구 `GHistogram`(마커 없는 보조 차트)은 삭제.
- 튜너 `lpDesk.tuner.v5` (v1~v4 로드 시 삭제). 키 구조는 같지만 분위수가 가리키는 분포가 s→g로
  바뀌어 스케일이 수백 bp → 수십 bp다 — 이월하지 않고 기본값(p90/p10)에서 다시 시작한다.
- **실측 (2026-08-21, 창 10일 중 g 유효 8일 × 740봉 = 5,920봉, 36/36종 산출)**: p90 **−2.8 ~ +13.6bp**
  (중앙값 +2.2), p10 −34.6 ~ −15.7bp (중앙값 −21.8). 같은 종목 s p90이 +171~+242bp인 것과 대비된다.
  손계산 — 396500(x −15.70/−0.83bp) iNAV 33,140 → **매수 33,085 / 매도 33,140** (스프레드 55원·16.6bp).
  3차 구조의 같은 종목 예시가 32,885/33,990(1,105원·334bp)이었다.
- ⚠️ **g 레벨이 전 종목 음수 쪽으로 치우쳐 있다** (p25~p75 중앙 ≈ −9bp). 같은 8일의 일봉 재구성 gap도
  −20~−49bp라 인트라데이 아티팩트는 아니지만, **재구성 NAV와 공식 iNAV의 상수 편차**(보수·배당 계상)가
  섞여 있으면 그만큼 양측 호가가 통째로 밀린다(특히 매도측이 타이트해진다). §14.5 경고대로 운용 중
  실시간 괴리 컬럼과 대조할 것 — 해소는 FD 야간배치 t1903 공식 NAV 적재 후.
- 📌 **부수 효과 — 내부망 선결 과제가 호가에 대해서는 해소**: 호가·체결 임박이 iNAV만으로 서므로
  지수선물 wire 없이도 동작한다. 아래 ⚠️는 이제 **버킷 계약수 환산·오늘 s·edge**에만 적용된다.
- g 도달 일수는 대부분 8/8일(꼬리 p95만 6~8일)이다 — s(10일 중 1~2일)와 달리 **거의 매일 열리는
  현실적인 레벨**이라는 뜻이고, 반대로 도달 일수의 변별력은 g 쪽에서 약하다(분위수 선택이 노브).

#### 4차 보완 구현 기록 (2026-08-21) — 두 분포 결합 2σ

4차 정정이 "호가는 NAV 주변"까지 바로잡았지만, 폭을 **g 분포 하나로만** 재고 있었다. 그래서 x가
g의 분위수에 갇혀(p90 −2.8~+13.6bp) 매도측이 NAV에 거의 붙었다 — 호가가 걸려 있는 몇 분 사이
ETF가 **선물 대비로 밀리는 폭**은 어디에도 반영되지 않았다. 사용자 최종 확정: 두 괴리 분포를
결합해 2σ에 세운다. 델타는 **x 산출 교체 하나**이고 앵커(iNAV)·임박 판정·틱 규칙은 4차 그대로다.

- **백엔드** (`services/lp_desk_calib.py`): calib 블록에 4종 추가.
  `g_mean_bp`(pooled raw 평균 = μ_g) / `g_sigma_level_bp`(pooled raw σ = σ_g, **demean 아님**) /
  `s_inc_sigma_bp`(연속 30초봉 Δs의 pooled σ) / `g_day_max`·`g_day_min`(일별 극값 배열, len = `g_days`).
  기존 `g_sigma_bp`(일중 demean σ)는 **역할이 다른 값**으로 그대로 유지 — 상세 패널이 "일중/레벨"을
  나란히 보여준다.
- **Δs 위생**: 일 경계 증분(종가→익일 시가 — 앵커도 바뀐다)과 **결측봉을 건너뛴 증분**(timestamp 차가
  30초가 아닌 쌍)을 뺀다. 후자를 남기면 갭 크기만큼 σ_r이 부풀어 호가가 통째로 넓어진다.
  하한은 s 분위수와 같은 `MIN_BARS`(≈3거래일) — 호가 폭에 직접 들어가는 값이라 같은 문턱.
- `_quantile_block()`이 NamedTuple `_Block`(분위수·도달일수·μ·σ·일별 극값)을 돌려주게 바꿨다. 일별
  극값을 **한 벌** 만들어 분위수 도달일수 판정과 응답 페이로드가 같이 쓴다(중복 순회 없음).
- **프론트**: `suggestQuote(inav, calib, z)` — 분위수 인자 제거. σ_r = `s_inc_sigma_bp × √(300/30)`
  (지평 T=5분은 `QUOTE_HORIZON_SECONDS` 상수, 튜너 아님). 반환에 μ/σ_g/σ_r/σ_comb/degrade를 실어
  x 셀·제안 호가 셀·상세 헤더가 **같은 분해 한 줄**(`μ −8.4 · σ괴리 5.8 · σ선물(5분) 12.6 → ±2σ 27.7bp`)을
  쓴다. 도달 일수는 `touchDays(g_day_max|min, x, side)`로 프론트가 실계산 — 서버 분위수 도달일수와
  같은 정의임을 36종×6레벨 재계산으로 대조 검증(불일치 0).
- 튜너 `lpDesk.tuner.v6`, 노브는 **z 하나**(기본 2.0, 0.5~4, 스텝 0.25). v1~v5 로드 시 삭제.
  분위수 선택 UI(`QuantileSelect`)는 제거했고, s 분포 참고 표시는 고정 p10/p90(`S_REF_BID/ASK`)으로 뗐다 —
  호가 z와 s 분위수는 자가 달라 같은 노브를 공유하면 안 된다.
- **실측 (2026-08-21 10:11 캘리브, z=2, 36/36종)**: σ_g 5.8~21.0 / σ_r 12.6~35.3 / σ_comb 13.8~41.1bp.
  **x_ask +19.3 ~ +67.5bp(중앙 +43.2) · x_bid −36.1 ~ −96.7bp(중앙 −63.7)** — 폭은 σ_r이 지배한다
  (선물 대비 드리프트가 NAV 흔들림보다 크다는 뜻이고, 실제로 헤지 잔차가 큰 종목일수록 호가가 넓어진다).
  라이브 손계산: 396500 iNAV 36,330.41 · μ −8.4 · σ_g 5.8 · σ_r 12.6 → σ_comb 13.8 → x −36.1/+19.3bp →
  **매수 36,195 / 매도 36,405** (스프레드 210원·58bp). 4차 정정판의 같은 종목이 55원·16.6bp였다.
- ⚠️ **도달 일수가 대부분 0/8일**이다(150460 3/7, 261060 3/2 등 잔차 큰 종목만 열림). 지표가 고장난 게
  아니라 **자가 다른 것**이다: x는 σ_r(선물 대비 드리프트)까지 얹은 폭인데 도달 일수는 g만 보고 센다.
  "최근 8일 중 가격이 NAV에서 이만큼 벌어진 적이 몇 번이나 있나"로 읽어야 하고, 0이면 **그 레벨은
  NAV 괴리만으로는 안 열린다 = 선물이 밀어줘야 체결된다**는 뜻이다. z를 낮추면 도달 일수가 는다.
- 앵커·임박 판정·틱·편측 사유 구조는 4차 정정 그대로. 다만 x 양쪽이 같은 μ·σ에서 나오므로 **편측
  null은 실질적으로 사라졌다**(필드는 유지). 새 사유는 `g 표본 부족 — μ·σ 없음`.

#### 5차 보완 구현 기록 (2026-08-21) — σ_r √T 환산 폐기, 지평 직접 측정

4차 보완의 x는 여전히 30~70bp로 넓었다. 원인은 σ_r의 **√T 환산**이었다 — 30초 증분 σ에 √(T/30초)를
곱하는 건 s가 랜덤워크라는 가정인데, **실측이 그걸 기각한다**. 305540(창 10일, 4,690봉):

| 지평 | 직접 측정 σ | 30초 σ 7.84 × √T 환산 | 분산비(VR) |
|---|---|---|---|
| 1분 | **9.83bp** | 11.09 | 0.79 |
| 2분 | **12.35bp** | 15.68 | 0.62 |
| 5분 | **17.19bp** | 24.79 | **0.48** |

VR이 1에서 멀어지는 이유는 둘이다: ① s는 되돌리는 성질이 있다(선물 대비 괴리는 평균회귀한다)
② 30초 증분에는 호가 바운스(bid-ask bounce) 잡음이 섞여 있어 **분자가 부풀어 있다**. 즉 √T는
지평이 길수록 σ_r을 과대평가하고, 그 부풀림이 그대로 호가 폭이 됐다.

- **백엔드** (`services/lp_desk_calib.py`): `_s_inc_sigma` → **`_s_sigmas`**(30초 증분 σ, 지평별 σ 동시 반환).
  하루치 s를 **연속 구간**(봉 간격이 정확히 30초)으로 먼저 쪼개고, 구간 안에서 `s[i+k] − s[i]`의
  **비중첩** 차분을 취한다(k = T/30초 = 2/4/10). 구간 안에서는 인덱스 거리 = 시간 거리라 지평별
  차분에 timestamp 재검사가 필요 없다(한 번의 세그먼트 분할로 3지평 + 증분을 모두 산출).
  일 경계·결측봉은 정의상 배제된다. 신규 상수 `S_DIFF_HORIZONS=(60,120,300)`·`MIN_DIFF_PAIRS=300`
  (비중첩이라 5분은 46쌍/일 → 10일 ≈ 470쌍. 300 미만이면 그 지평만 null).
  `s_inc_sigma_bp`는 **참고 표시용**으로 유지 — 툴팁에서 "30초 증분 σ"를 나란히 보여줘 √T 부풀림의
  대비가 화면에 남게 했다. `calib_params.s_diff_horizons`로 지평 목록을 내려준다.
- **프론트**: `horizonScale()`·`CALIB_BAR_SECONDS_FALLBACK` **삭제**(환산 경로 자체를 없앴다).
  `suggestQuote({inav, calib, z, horizonSeconds})`가 `calib.s_diff_sigma_bp[String(T)]`를 **그대로**
  σ_r로 쓴다. `QUOTE_HORIZON_SECONDS` 기본값 300 → **60**, 선택지 `QUOTE_HORIZON_OPTIONS=[60,120,300]`.
  반환에 `horizonSeconds`를 실어 라벨(`σ선물(1분) 9.8`)이 산출에 쓰인 값과 절대 어긋나지 않게 했다.
  튜너에 지평 토글(1분/2분/5분) 추가 — 노브가 z와 T 둘이 됐다. `lpDesk.tuner.v7`(v1~v6 로드 시 삭제 —
  같은 z라도 σ_r 정의가 달라 이월하면 안 된다).
- **실측 (2026-08-21 13:15 캘리브, z=2, 36/36종, 창 10일)**: σ_r **1분 4.7~15.3 / 2분 5.9~19.4 /
  5분 8.2~26.2bp**. T=1분·z=2에서 **x_ask +6.6 ~ +37.4(중앙 +19.4) · x_bid −23.4 ~ −66.5(중앙 −37.7)bp**
  — 4차 보완판(+19.3~+67.5 / −36.1~−96.7)에서 폭이 절반 가까이 줄었다. 종목 예: 305540
  μ −8.8 · σ_g 8.2 · σ_r(1분) 9.8 → σ_comb 12.8 → **x +16.9 / −34.4bp**. 최타이트는 396500
  (+6.6 / −23.4bp), 최광폭은 261060(+37.4 / −66.5 — σ_g 21.0으로 NAV 괴리 자체가 큰 종목).
- 지평을 5분으로 올리면 폭이 늘지만(중앙 +29.4/−47.9) **√T가 만들던 만큼은 아니다**. T는 이제
  "호가를 얼마나 오래 걸어 둘 것인가"라는 운영 선택이고, 그 대가가 실측 σ로 정직하게 매겨진다.
- **z 기본 1.5σ + 프리셋 토글 (2026-08-21 사용자 확정)**: z=2는 8거래일 실측에서 매도측 도달 0일 —
  체결이 아예 안 걸리는 폭이었다. 기본을 **1.5σ**로 내리고, z 노브를 숫자 입력에서 헤더 **세그먼트
  프리셋(1.0/1.25/1.5/2.0σ)**으로 바꿔 지평 토글 옆에 나란히 뒀다(중복 노브 제거 — 자유 입력 폐지).
  `lpDesk.tuner.v8`(v1~v7 로드 시 삭제 — 저장된 `z:2`가 그대로 복원되면 기본값 변경이 화면에 안 먹는다).
- **자유 입력 복원 (2026-08-28 사용자 요구)**: 프리셋 4종은 상용 레벨로 남기되, 그 밖의 값(1.35σ 등)을
  못 쓰는 게 불편하다는 요구로 **세그먼트 오른쪽에 숫자 입력칸**을 붙였다(step 0.05, blur/Enter 커밋).
  `snapZ()`(최근접 프리셋 스냅)는 폐기하고 **클램프+2자리 반올림(`clampZ`, `Z_MIN` 0.25 ~ `Z_MAX` 4)**만
  남겼다 — 프리셋 범위(1~2)로 좁혀 뒀던 클램프를 되넓힌 것. z가 프리셋과 정확히 일치할 때만 해당 버튼이
  켜지고, 수동 값이면 프리셋은 모두 꺼지고 입력칸이 켜진다. 저장 키는 **v8 그대로**(스키마 동일, v8에
  저장된 z는 스냅 때문에 프리셋 값뿐이라 클램프만으로 무손실 복원). 백엔드 `/export.xlsx`의 z 검증
  범위도 `ge=0.25`로 맞췄다(엑셀이 화면과 같은 x를 채워야 하므로 프론트 범위와 항상 동일해야 한다).

⚠️ **내부망 선결 과제 (버킷 계약수·s·edge 한정)**: `realtime/src/feed/internal.rs`에 **지수선물 wire가 없다** — `ex == "XKRF"` 분기가 전부 `FuturesTick`(주식선물 상당)으로 나가고 `IndexFuturesTick`은 만들지 않는다(같은 파일 `TODO(PR-A 지수선물)`: 내부망 실측 없이 코드 포맷·이론가 필드를 추측할 수 없어 보류된 **기존 후속 트랙**). 내부망 모드에서는 `marketStore.indexFuturesTicks`가 비므로 **오늘 s·버킷 계약수 환산·edge가 산출 불가**다. (4차 정정 전에는 제안 호가까지 죽어 화면 자체가 못 쓸 상태였다 — 이제 호가·체결 임박은 iNAV만으로 서므로 내부망에서도 주기능은 동작한다.) 내부망 접속 환경에서 payload 실측 후 착수한다 (추측 구현 금지).

#### 엑셀 내보내기 (2026-08-26) — 내부망 반입 경로

바로 위 선결 과제의 **우회로**다. 실집행은 LENS가 없는 내부망에서 하고, 거기엔 지수선물 wire도
없어 화면상 계약수 환산이 애초에 안 나온다. 그래서 **역할을 쪼갠다**: 외부망 LENS는 매 초 변하지
않는 것(β·호가 밴드·전일종가·CU)만 스냅샷으로 넘기고, 매 초 변하는 것(체결 수량·현재가·선물가)은
내부망 엑셀이 **DDE로 직접 받아** 워크북 수식이 헤지 계약수까지 계산한다.

```
LENS(외부망)  ──/api/lp-desk/export.xlsx──▶  파라미터 xlsx  ──반입──▶  내부망 엑셀 + DDE 시세
   β·x·전일종가·CU (값)                                        체결·현재가·선물가 (실시간)
                                                              → K200/KQ 노출 → 목표 계약수 → 집행할 계약
```

- **`GET /api/lp-desk/export.xlsx?z=&horizon=`** (`routers/lp_desk.py` → `services/lp_desk_export.py` 신규).
  StreamingResponse(openxml), 파일명 `lp_desk_params_YYYYMMDD.xlsx`. PG 불가·**캘리브 없음이면 503** —
  x가 전부 빈칸인 반쪽 파일을 조용히 내보내지 않는다. `horizon`은 서버가 실제로 측정한 지평
  (`S_DIFF_HORIZONS`) 밖이면 400. z·지평 기본값은 화면과 같은 **1.5σ·60초**이고, 프론트 버튼이 현재
  튜너 값을 실어 보내 **파일의 x가 지금 보고 있는 호가 밴드와 어긋나지 않게** 한다.
- **매크로 없음, 순수 수식만** (내부망 보안 — VBA 붙은 파일은 반입 자체가 막힌다). 계산은 전부
  워크시트 수식(VLOOKUP/SUM/ROUND/IF/N)이고 파이썬은 값·수식 문자열만 쓴다. openpyxl은 이미 있는
  의존성(`requirements*.txt`)이라 추가 없음.
- 시트 4장:
  | 시트 | 내용 |
  |---|---|
  | `베타` | 36행 스냅샷 — 코드·종목명·β_K200·β_KQ150·R²·잔차vol·μ괴리·σ괴리·σ선물(지평)·x매도·x매수·전일종가·CU. `/master` 캐시 그대로 |
  | `체결` | 입력/DDE 200행. A 코드·C 수량·D 현재가만 입력, B 종목명·F/G β는 VLOOKUP, E 평가액·H K200노출·I KQ노출은 수식 |
  | `헤지` | `SUM(체결!H:H)`·`SUM(체결!I:I)` → 목표 계약수 `ROUND(−노출/(선물가×승수),0)` → **집행할 계약 = 목표−보유**(굵게). 승수는 PARAMS 참조 |
  | `PARAMS` | 생성시각·stats_date·calib as_of·z·지평·승수 2종·표본 구간 + 사용법. 승수 셀이 헤지 시트의 단일 진실원 |
- **코드는 텍스트 서식(`@`)** — 유니버스에 `0117V0`·`0052D0`·`0091P0`·`0148J0` 같은 영숫자 코드가 있고,
  숫자로 굳으면 VLOOKUP 키가 어긋난다. 반대 방향도 막아야 한다: DDE·수기 입력이 `396500`을 **숫자**로
  넣으면 텍스트 표와 안 맞으므로 조회 키를 **`$A2&""`**(빈 문자열 결합 = 무조건 텍스트화)로 쓴다.
  ⚠️ `TEXT($A2,"@")`도 같은 의도지만 **엔진에 따라 숫자에서 어긋난다** — 실측(`formulas` 1.3.4)에서
  `TEXT(396500,"@")`가 리터럴 `"@"`를 뱉어 396500·305540 행의 β가 통째로 0이 됐다. `&""`로 교체 후 통과.
- **빈 행에서 에러가 없어야 한다** (200행을 미리 깔아 두므로). 이름·β는 `IFERROR`, 금액 3열은 입력이
  비면 `""`. `SUM`은 텍스트를 무시하므로 합계에 영향 없다. 헤지 쪽 0으로 나누기는 **`N()` 가드**로
  막는다(`IF(N(B6)=0,"",…)`) — 공백·문자·0을 한 번에 걸러 `#DIV/0!`가 아니라 빈칸이 된다.
- VLOOKUP 범위는 열 전체가 아니라 **`베타!$A$2:$D$37`**(데이터 행 한정) — 200행 × 3 VLOOKUP이 100만 행을
  훑지 않고 헤더행 오매칭도 원천 차단된다. 파일은 매번 서버가 다시 만드므로 범위는 자동 갱신된다.
- **검증 (2026-08-26)**: `formulas` 엔진으로 워크북 전체 재계산 + 손검산.
  샘플 3건(396500 +10,000 @35,105 / **숫자코드** 305540 −5,000 @40,000 / **영숫자코드** 0117V0 +3,000 @17,770),
  미니K200 420.15·KQ150F 1,550·보유 −5/0 계약 →
  K200 노출 **398,006,752** (351,050,000×1.1044 − 200,000,000×0.0650 + 53,310,000×0.4372) ·
  KQ 노출 **−45,380,053** · 목표 **−19 / +3계약** (398,006,752 ÷ 21,007,500 = 18.95) ·
  **집행할 계약 −14 / +3** · 헤지 후 잔여 노출 292,969,252 — 전부 손계산과 일치. 선물가 미입력/0에서
  목표·집행 칸이 `#DIV/0!` 없이 빈칸 유지 확인. 빈 행(체결!B10·E10·H10)도 `#N/A` 없이 빈칸.
- 프론트는 계기판 헤더 `엑셀 내보내기` 버튼 1개(`정리 미리보기` 왼쪽). `window.open`이 아니라
  **fetch→blob→a[download]** 인 이유: 503일 때 링크 이동이면 데스크 화면이 JSON 오류 페이지로 통째로
  날아간다. 실패는 기존 체결 피드백 배지에 사유(`detail`)로만 띄운다.

#### 파생 내장 ETF 재구성 (2026-08-26) — 가격 없는 레그 제외

방침·한계는 **§14.3**이 정본. 여기는 구현 메모만 남긴다.

- **SQL 2곳, 같은 규칙**: `lp_desk_stats._GAP_SQL`(일봉 gap) / `lp_desk_calib._SQL_NAVR`(장중 g).
  둘 다 `pdf_all` → **`priced`**(창 안에 가격이 하나라도 있는 비현금 구성만 `EXISTS`로 추림) → `pdf`
  (= 유효 바스켓) 3단으로 쪼갰다. `have = n_comp` 비교의 분모(`n_comp`)가 유효 바스켓 기준으로 줄어
  들어야 파생 레그가 매 봉을 죽이지 못한다. 창 밖 판정이 아니라 **창 안 존재 여부**라 롤로 코드가
  바뀌는 옵션에도 자동으로 맞는다.
- **비용은 사실상 0**: `priced`는 구성종목당 인덱스 존재 확인 1회(`ohlcv_intraday(stock_code, time)`)라
  캘리브 **13.4 → 13.6초**, 일봉 gap **0.88 → 1.01초**. `priced`가 3회 참조돼 PG가 자동 materialize
  하므로 EXISTS는 종목당 한 번만 돈다.
- **`excluded_legs`** = 창 내 **최대** 제외 레그 수(옵션 만기 롤로 날마다 1~2개 흔들려서 최대값).
  `/master`의 `calib` 블록에 실리고, 프론트는 `types/lp-desk.ts`에 필드 추가 + x·제안 호가 툴팁
  마지막 줄(`excludedLegsNote()`, 0이면 아예 미표기)로만 쓴다 — 컬럼·배지는 만들지 않았다.
- **회귀 확인 (2026-08-26)**: 전 37종의 `g_mean_bp`·`g_sigma_level_bp`·`g_days`·`g_bars`·`gap_mean_bp`·
  `gap_sigma_bp`·`gap_obs` **전수 불변**(제외 레그 0개 → 바스켓 동일). 유니버스 38종 중 제외 레그가
  있는 건 472150 하나(4개).
