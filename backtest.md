# 백테스팅 탭 (범용 전략 백테스트 엔진) — 설계 (PR-C)

> **단일 진실원.** 상위 탭 `/backtest`(현재 StubPage)에 들어갈 사용자 전략 백테스트 도구의 설계.
> 수급 전용이 아니다 — 수급·가격·재무(PER/PBR)·외인보유율 등 여러 네임스페이스의 데이터를
> 조합한 전략을 백테스트하는 **LENS 전반의 범용 도구**. 배경 논의는 memory `project_supply_demand`
> (PR-C 항목), 부검 원칙은 `reference_lpmm_supply_postmortem`.

## 1. 포지셔닝 — 열람실 vs 실험실

| | 열람실 (수급 탭 PR-A/B) | **실험실 (백테스팅 탭, 이 문서)** |
|---|---|---|
| 사용자 입력 | 없음 (측정 결과 열람만) | **전략 = 사용자 조합** (조건·청산·비용) |
| 공식 | 사전 등록 상수 (`flow_verdict` 정본) | 자유 조합 — 대신 **방법론 가드레일 고정** |
| 산출 | 검증된 태그의 edge | 전략의 상세 성과 리포트 |
| 역할 | 확정된 지식 소비 | 새 가설 실험 → 입증되면 열람실 상수로 승격 |

부검의 "파라미터는 상수" 원칙은 **화면(랭킹)에 싣는 지표**에 대한 규율이고, 실험실은 그 상수를
만들어내는 공장이다. 대신 실험실에서는 **방법론(체결 시점·수정주가·point-in-time·벤치마크)이
사용자가 깰 수 없는 고정 레일**이다 — 노브는 전략이고, 레일은 엔진이다.

기존 `flow_tag_backtest.py`/`flow_exit_backtest.py`(사전 등록 측정 게이트)는 **그대로 유지** —
JSON 자동갱신·수급 화면 edge의 정본. PR-C 엔진과 수치가 다를 수 있다(게이트는 주간 리밸런스
날짜-스프레드 t검정, 엔진은 에피소드 시뮬레이션) — 각자 목적이 다르며 서로 대체하지 않는다.

## 2. 아키텍처

```
Finance_Data PG (read-only)
   └─ DataAdapter들 (namespace별) ──→ 일별 패널 (parquet 캐시 + 프로세스 메모리)
                                          └─→ Engine (벡터화 시그널 → 에피소드/포트폴리오 시뮬)
FastAPI (8100)                                   ↑
   routers/backtest.py ── job 제출/폴링 ──────────┘
   lens.db (SQLite) ── 전략 저장 + 실행 이력
React /backtest ── 전략 빌더 + 결과 뷰
```

- **위치: FastAPI(8100) 내 `backend/services/backtest/` 독립 패키지.** 별도 서비스(포트) 불필요 —
  일봉 배치 연산이고 실시간 아님. Rust로 갈 이유 없음(pandas/numpy 벡터화로 충분, §7 성능).
- **flow_* 모듈에 종속 금지.** 수급은 여러 어댑터 중 하나. 단 조건 정의는 재사용(공식 1벌, §3).
- 무거운 연산은 `asyncio.to_thread`(단일 사용자 데스크 도구 — 프로세스 풀 불요). job 레지스트리는
  프로세스 메모리(재시작 시 실행 중 job 소실 허용 — 결과는 lens.db에 남음).

### 패키지 구성

```
backend/services/backtest/
  schema.py     # 전략 JSON 스키마 (pydantic) + 검증
  adapters.py   # DataAdapter 프로토콜 + price/flow/... 구현
  panel.py      # 패널 빌드·parquet 캐시·버전 관리
  engine.py     # 시그널 평가 + 에피소드/포트폴리오 시뮬레이션
  jobs.py       # job 제출/상태/취소 (메모리 레지스트리)
  store.py      # lens.db 전략 CRUD + 실행 이력
backend/routers/backtest.py
frontend/src/pages/backtest.tsx (+ components/backtest/)
```

## 3. 데이터 레이어 — 네임스페이스 어댑터

전략 조건은 `네임스페이스.지표` 참조로만 데이터에 접근한다. 어댑터는 **(time, stock) 일별
패널 컬럼 + 지표 카탈로그(이름·한글 라벨·단위·설명·가용 기간)** 를 제공한다. 카탈로그는
`GET /api/backtest/catalog`로 프론트에 내려가 조건 빌더의 드롭다운이 된다 — **새 데이터
소스 추가 = 어댑터 1개 추가**, 엔진·스키마·UI는 불변.

| 네임스페이스 | 원천 (Finance_Data) | 대표 지표 | 단계 |
|---|---|---|---|
| `price` | ohlcv_daily, market_cap_daily | adj open/close, ret_5/20/60/120d, adv_20d, mcap, 52주 고저 대비, MA20/60/120/200 및 이격도 | **C1** |
| `flow` | investor_trading (+유통시총 분모) | f/i 5·20·60·120d (억·bp), streak, absorb_5d, **태그**(장기동시·진입권·분배 등 — `flow_verdict` 정본 재호출, PR-B 방식) | **C1** |
| `fin` | financial_metrics_quarterly | PER, PBR, ROE, ROA, EPS/BPS 증감, 영업이익률 | C3 (§3.1 주의) |
| `own` | foreign_ownership | 외인 보유율, 보유율 20d 변화 | C3 |
| `index` | index_ohlcv_daily | (벤치마크 전용 — 조건 참조는 v2) | C2 |
| (미래) `etf`/`statarb` | ETF 괴리·베이시스·페어 z-score | — | C3+ |

### 3.1 재무(fin) 어댑터의 point-in-time 문제 ⚠️

`financial_metrics_quarterly`는 **공시일 컬럼이 없다** (`collected_at`은 2026-05~06 수집
스냅샷 시각일 뿐). 그대로 period_end에 매핑하면 실적 발표 전에 아는 것이 되어 look-ahead.

- **규칙: `available_from = period_end + 공시 지연 상수`** (분기보고서 45일, 사업보고서(Q4) 90일 —
  자본시장법 제출기한, 보수적 고정). as-of 조인은 available_from 기준.
- **`data_type='actual'`만 사용.** preliminary/estimate는 "언제 그 추정치가 존재했나"를 알 수 없어
  (스냅샷 1회분) 백테스트 사용 자체가 look-ahead — 어댑터가 원천 차단.
- 커버리지: 2,611종목 · period_end 2023-12-31~ → **fin 조건을 쓰면 실질 시작이 2024-05경으로 단축**
  됨을 리포트에 자동 표기.

### 3.2 패널 빌드·캐시

- 어댑터별 컬럼을 (time, stock) 축으로 join한 단일 패널. 기간 = **최대 가용(2022~, 수급·재무는
  각자 가용 시점부터)**, KRX 거래일 축(krx_holidays).
- 캐시 2단: **parquet 파일**(`data/backtest_panel/{namespace}.parquet`, gitignore) + **프로세스
  메모리**. 버전 키 = 어댑터별 data_version 프로브(수급은 `flow_metrics.data_version` 재사용
  패턴). stale이면 백그라운드 재빌드, 빌드 중엔 이전 버전으로 서빙.
- 규모 감: 일별 ~650일(2.5년)×~2,600종목 ≈ 170만 rows × 수십 컬럼 — 메모리 수백 MB, parquet
  수십 MB, 전략 1회 실행은 벡터화 마스크라 초 단위. pandas로 시작, 병목 실측 후에만 polars 검토.

## 4. 전략 스키마 (JSON, pydantic)

```jsonc
{
  "name": "장기동시 + 저PBR",
  "universe": {                       // 체결 가능성 필터 (하한 프리셋, flow PRESETS와 동일 철학)
    "markets": ["KOSPI", "KOSDAQ"],
    "min_adv_eok": 10, "min_mcap_eok": 500
  },
  "entry": {                          // 조건 트리: all(AND) / any(OR), 1-depth 중첩 허용
    "all": [
      {"field": "flow.tag.장기동시", "op": "is_true"},
      {"field": "fin.pbr", "op": "<=", "value": 1.0},
      {"field": "flow.f_5d", "op": ">=", "ref": "price.adv_20d", "mult": 0.3}   // 지표 간 비교
    ]
  },
  "execution": {
    "entry_fill": "next_open",        // next_open(기본) | next_close | same_close(⚠경고)
    "exit_fill": "next_open",
    "cost_bps": 25                    // 편도 수수료+슬리피지 합산 (왕복 2회 차감)
  },
  "exit": {                           // 여러 규칙 = 먼저 발동하는 것 (whichever-first)
    "rules": [
      {"type": "fixed_holding", "days": 120},
      {"type": "condition", "any": [{"field": "flow.tag.동반순매도", "op": "is_true"}]},
      {"type": "stop_loss_pct", "value": -15},
      {"type": "take_profit_pct", "value": 50}
    ]
  },
  "portfolio": {
    "mode": "event_study",            // event_study(C1) | portfolio(C2)
    "max_positions": 20, "weighting": "equal"   // portfolio 모드 전용
  },
  "benchmark": "universe_avg",        // universe_avg(기하, 기본) | kospi | kosdaq | none
  "period": {"start": null, "end": null}   // null = 최대 가용
}
```

- **연산자**: `> >= < <= == is_true is_false`, 값 비교 + **지표 간 비교**(`ref` + `mult` —
  "5D 순매수 ≥ ADV20의 30%" 같은 조건). 상위N/백분위(`rank_pct`)는 C2 (횡단면 연산이라 별도 구현).
- **엔진이 고정하는 레일 (사용자 선택 불가)**: 신호는 D 종가 데이터로만 계산(trailing) ·
  가격은 수정주가 · 분모는 point-in-time · 손절/익절 판정은 **종가 기준 후 다음날 체결**
  (장중 low 터치 손절 금지 — LP_MM 부검) · 벤치마크는 로그수익 평균 기하 누적(Blume-Stambaugh).
- `same_close` 체결은 "D일 데이터를 보고 D일 종가에 산다"는 낙관 가정(수급 잠정치 전제)이라
  **선택 시 경고 + 결과 리포트에 영구 배지** ("실현 불가능할 수 있는 가정" — look-ahead 명시).

## 5. 엔진 — 두 가지 결과 모드

### C1: 이벤트 스터디 (event_study)

flow_exit_backtest의 onset 에피소드 방식 일반화. **진입 조건 onset**(전일 불충족→당일 충족)마다
에피소드 생성 → exit 규칙 중 먼저 발동하는 시점에 청산 → 에피소드별 수익/초과수익.

- 자본 제약 없음(신호가 뜨면 전부 잡는다) — **"이 조건에 edge가 있나"** 를 순수하게 측정.
- 산출: 에피소드 테이블(진입·청산일, 사유, 보유일, 수익, 초과수익), 평균/중앙 초과수익, 승률,
  t값(에피소드 중첩 감안 보수 해석 주석), 보유일 분포, 청산 사유 분해(고정만기/조건/손절/익절 비중),
  월별·연도별 평균, 표본수 경고(에피소드 < 30이면 "표본 부족" 배지).

### C2: 포트폴리오 시뮬레이션 (portfolio)

이벤트 스터디에 자본 제약을 얹는다: max_positions 한도, 동일가중, 신호 초과 시 우선순위
(진입 조건의 대표 지표 내림차순 — 스키마에 `rank_by` 추가), 비용 차감, 일별 에쿼티.

- 산출 추가: 에쿼티 커브(vs 벤치마크), CAGR, MDD, 샤프(일별 초과수익 기준), 회전율,
  평균 보유 종목수, 연도별 수익 테이블.
- 체결 가능량 캡(포지션 ≤ ADV의 x%)은 C2 후반 후보 — LP 실무에서 소형주 신호의 실현가능성 체크.

## 6. API + 저장 (lens.db)

```
GET  /api/backtest/catalog                  # 네임스페이스·지표 카탈로그 (+가용 기간)
POST /api/backtest/run                      # 전략 JSON → job_id (검증 실패 시 422 + 필드 에러)
GET  /api/backtest/jobs/{id}                # status: queued|running(진행 %)|done|error, done이면 결과
POST /api/backtest/strategies               # 전략 저장 (이름 중복 시 새 버전)
GET  /api/backtest/strategies[/{id}]        # 목록/단건 (+최근 실행 요약)
DELETE /api/backtest/strategies/{id}
GET  /api/backtest/runs?strategy_id=        # 실행 이력
```

SQLite 테이블 (LENS 자체 DB 규약 — Finance_Data에 쓰기 금지):
- `backtest_strategies(id, name, spec_json, created_at, updated_at)`
- `backtest_runs(id, strategy_id, spec_json, spec_hash, result_json, panel_version, started_at, finished_at, status)`
  — **spec은 실행 시점 사본을 함께 저장** (전략을 나중에 고쳐도 과거 실행의 조건 보존).

### 다중검정 가드 (부검 계승 — "튜닝 100번 중 1번 반짝"을 그대로 믿지 않기)

- 실행 이력은 자동 축적된다. 결과 리포트 상단에 **"이 전략(및 파생 spec_hash 계열) 시도 N회"**
  를 항상 표기 — 반복 튜닝으로 얻은 결과임을 사용자가 잊지 않게.
- holdout(기간 분할 잠금·1회 개봉)은 C2+ 후보. v1은 카운터+경고 문구까지.

## 7. 성능 목표

- 패널 빌드(전 네임스페이스, 콜드): 수 분 — 백그라운드, 서버 기동 비차단.
- 전략 1회 실행(패널 캐시 히트): **이벤트 스터디 < 3초, 포트폴리오 < 10초** (170만 rows 벡터화).
- 목표 미달 시에만 polars/청크 최적화 — 조기 최적화 금지.

## 8. UI (`/backtest`)

- **좌: 전략 빌더 패널** — 이름 / 유니버스 / 조건 행 리스트(`[네임스페이스▾][지표▾][연산▾][값|지표참조]`,
  행 추가·삭제, AND/OR 그룹) / 체결·비용 / 청산 규칙 / 모드·벤치마크 / [실행] [저장].
  지표 셀렉트는 catalog 기반(한글 라벨+설명 Tip), 지표별 가용 기간을 옆에 작게 표기.
- **우: 결과 뷰** — 요약 스탯 스트립 → 에쿼티/초과수익 커브 → 청산 사유 분해 → 에피소드 테이블
  (정렬·클릭 시 종목 상세로) → 각주(방법론 레일 + same_close 경고 배지 + 시도 횟수).
- **상단: 저장 전략 바** — 전략 선택 시 빌더에 로드 + 최근 실행 결과 즉시 표시.
- 디자인: 기존 가이드 그대로 (고밀도·색 절제·tabular-nums·패널 배경 분리). 차트는 결과 커브
  = 시계열이므로 lightweight-charts, 분포·분해는 인라인 SVG(PR-A 방식).

## 9. 한계·리스크 (리포트에도 상시 노출)

1. **생존편향**: `stocks`에 비활성 46종목뿐 — 상폐 이력이 사실상 없다. 백테스트 유니버스가
   "지금 살아있는 종목"으로 구성되어 **수익률이 낙관 편향**. 리포트 각주 고정 + Finance_Data 측에
   상폐 종목 보존 요청 (개선 전까지는 구조적 한계).
2. **재무 point-in-time 근사** (§3.1): 공시 지연 상수는 보수적 근사일 뿐 실제 공시일이 아님.
3. **단일 레짐**: 데이터 2022~ (실질 2.5~4.5년) — 하락장 표본 부족. 절대치보다 상대 비교용.
4. **에피소드 중첩**: 같은 종목 연속 onset·동시 다종목으로 t값 팽창 — 보수 해석 주석 고정.
5. 수급 데이터는 **주식 전용** (ETF 없음) — ETF 전략은 etf 네임스페이스 추가(C3+) 전까지 불가.

## 10. 로드맵

- **C1 (엔진 코어)**: schema/adapters(price+flow)/panel/engine(이벤트 스터디)/jobs + run·jobs API
  + 최소 UI(빌더+결과 v1). 검증: 기존 게이트 결과와 방향 재현(예: "장기동시 진입·120일 고정보유"가
  flow_exit_backtest 결론과 부호·크기 정합) + look-ahead 스모크(시그널 시프트 테스트).
- **C2 (포트폴리오·운영)**: portfolio 모드, 비용 모델 정밀화, rank_pct/rank_by, 전략 저장·이력,
  다중검정 카운터, 벤치마크 kospi/kosdaq.
- **C3 (네임스페이스 확장)**: fin(공시 lag 규칙)·own 어댑터, etf/statarb 검토.

## 결정 로그

- **별도 서비스가 아니라 FastAPI 내 패키지** (2026-07-06): 일봉 배치 연산·단일 사용자 — 4번째
  서비스 포트를 늘릴 근거 없음. stat-arb-engine(8300)은 주기 cron+sqlx 특성 때문이지 선례 아님.
- **이벤트 스터디를 C1, 포트폴리오를 C2로** (2026-07-06): "조건에 edge가 있나"가 먼저고,
  자본 제약·비용은 그 위의 레이어. 검증 게이트(수급)와의 정합 확인도 이벤트 스터디가 직접 비교 가능.
- **재무 estimate/preliminary 백테스트 사용 금지** (2026-07-06): 추정치의 존재 시점을 알 수 없는
  스냅샷 1회분 — look-ahead 원천 차단. actual + 공시 지연 상수만.
- **손절/익절은 종가 판정 후 익일 체결** (2026-07-06): 장중 low 터치 손절은 LP_MM 부검의
  look-ahead 실패 지점 — 일봉 데이터로 장중 체결가를 아는 척하지 않는다.
