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

## 구현 노트 (C1 백엔드)

> 2026-07-06 구현·검증 완료. **백엔드만** (프론트는 다음 단계). 아래가 실제 산출물 기준.

### 패키지 구조 (실제)

```
backend/services/backtest/
  __init__.py   # 패키지 개요
  schema.py     # 전략 JSON pydantic v2 (Strategy/Group/Condition/ExitRule/…) + 1-depth 검증
  adapters.py   # DataAdapter 프로토콜 + PriceAdapter/FlowAdapter (카탈로그 + build)
  panel.py      # RawFetcher(연도청크·테이블별 세션) + 빌드·join·버전·캐시(lazy)
  engine.py     # run_event_study (조건→onset→에피소드 시뮬→요약/경고)
  jobs.py       # 메모리 job 레지스트리 + run 오케스트레이션 (동시 1개, asyncio.to_thread)
backend/routers/backtest.py   # GET /catalog · POST /run · GET /jobs/{id}  (/api prefix)
```
- `store.py`(lens.db 전략 CRUD·실행 이력)는 **C2**라 미구현. `/run`은 job_id만 반환, 결과는 job 폴링.
- main.py 라우터 목록에 `"backtest"` 추가 (기존 try/except import 관례). startup 부작용 없음(lazy).

### 카탈로그 (42개 지표)

- **price (20)**: `close` `mcap`(억) `adv_20d`(억) `ret_5d/20d/60d/120d`(%) `ma_20/60/120/200`(원)
  `ma20/60/120/200_disp`(%, 종가/MA−1) `high_52w_disp`(%). MA·이격도는 완전창(min_periods=n)만 —
  flow-detail의 NaN 오염 교훈.
- **flow (22)**: 수치 16 (`f_5d/20d/60d/120d_bp` `i_20d/120d_bp` `f_5d/20d/60d/120d_eok`
  `i_5d/20d/120d_eok` `r_5d_eok` `f_streak` `absorb_5d_pct`) + **태그 bool 10**
  (`flow.tag.장기동시` 등, 내부 컬럼 `tag_*`). 태그·bp는 `flow_metrics._row_to_metrics` +
  `flow_verdict.applicable_patterns` **정본 재호출** (flow_episodes와 동일 — 근사 프록시 미사용).
- 조건 필드 키 형식: `price.ret_20d` / `flow.f_20d_bp` / `flow.tag.장기동시`. `ref`는 동일 키 공간.

### 검증 결과 (backtest.md §10 C1 기준)

1. **게이트 재현** — `{장기동시 is_true, fixed_holding 120, next_open, cost 0, universe default,
   benchmark universe_avg}` 직접 실행: **평균 초과 +1.58%, t=2.37, n=7164** (전 구간 2022~2026).
   flow_exit_backtest 장기동시 **E2(고정120) = +4.05%, t=3.06** (2년) 대비 **부호 일치·같은 한자릿수%
   ·둘 다 유의** → 정합. 크기 차이는 방법론 차이(아래): 엔진은 canonical(부분창 min_periods=1,
   유통시총 분모)라 flow_exit 프록시(완전창 min_periods=n, 시총 분모)보다 marginal onset이 많아
   edge가 희석됨. 2년·완료건만으로 좁히면 ~0%로 더 벌어지나(2024 약세 레짐 비중↑), 기본 전 구간
   헤드라인은 양수·유의.
2. **look-ahead 스모크** — 같은 전략 onset을 하루 미래로 shift(−1): **+1.58%→+3.81%, t 2.37→5.61**로
   유의하게 커짐 → 엔진이 미래 정보를 안 쓴다는 방증(정상).
3. **조건 트리** — `동시 AND (flow.f_5d_eok ≥ price.adv_20d×0.3 OR flow.f_20d_bp ≥ 15)` (ref/mult +
   any/all 중첩) 정상 실행 (n=6001). `ref×mult` 지표 간 비교·1-depth 중첩 동작 확인.
4. **whichever-first + 청산 분해** — fixed120/stop−15%/take+30%/condition(동반순매도) 4규칙:
   분해 `{stop 3254, take 1850, condition 1518, fixed 357, ongoing 185}` **합계 7164 == 에피소드 수**.
   평균 보유 32.8일(고정만일 때 102일보다 짧음 — 조기 청산 정상).
5. **라이브 uvicorn(8100)** — catalog→run→jobs 폴링 E2E 성공. pickle 캐시 히트로 job <3초 완료,
   결과 파이썬 직접 실행과 동일(n=7164, +1.58%, t=2.37). 422 검증: portfolio.mode 오값·미지 지표
   모두 필드 단위 메시지 반환.
6. `python3 -c "import main"` (cd backend) 통과.

### 성능 (실측)

- **콜드 패널 빌드**: 벽시계 ~100초 (조회 ~40s + compute ~62s). 2,727,876 rows × 2,719 종목,
  전 구간 2022-01-03~2026-07-03. 캐시 pickle **458 MB**(float32).
- **웜 ensure**(메모리 히트): ~0.17초. pickle 로드(콜드 프로세스): ~3초.
- **전략 1회 실행**(패널 캐시 히트): 이벤트 스터디 **~1.8초** (목표 <3초 충족).

### 설계와 달라진 점

- **캐시 포맷 = pickle** (parquet 아님): 환경에 pyarrow/fastparquet **미설치** (requirements에도 없음,
  내부망 오프라인 배포 고려해 신규 무거운 의존성 추가 지양). `data/backtest_panel/panel.pkl` 단일
  파일 + 버전 메타 임베드. 버전 불일치 시 재빌드. (parquet 엔진 도입 시 손쉽게 교체 가능.)
- **네임스페이스 분리 parquet(price/flow 각각) → 단일 panel.pkl**: join 결과를 한 벌로 캐시
  (버전 키에 두 어댑터 버전 모두 포함). 부분 stale 재활용 이득보다 단순성 우선.
- **float32 다운캐스트**: 지표·가격 컬럼 float64→float32 (메모리·디스크 절반, 829→458 MB). 수익률은
  비율이라 정밀도 충분. 벤치마크 로그 누적만 engine에서 float64로 승격. 게이트 수치 불변 확인.
- **flow 롤링 min_periods=1**: 정본(runtime `/ranking`·flow_episodes)과 바이트 일치를 위해 부분창 허용.
  게이트 스크립트(flow_tag/flow_exit)의 완전창(min_periods=n)과 다르며, 위 §검증1의 크기 차 원인.
  정본 재사용이 규약이므로 게이트에 맞추지 않았다.
- **store.py/lens.db·strategies·runs API 미포함**: C2 범위(§6). C1은 catalog/run/jobs만.
- **RawFetcher 연도 청크**: investor_trading/ohlcv/market_cap이 TimescaleDB 하이퍼테이블(236 주간 청크)
  이라 전 구간 단일 트랜잭션 조회 시 out of shared memory. 연도별 별도 세션으로 청크 락을 사이사이
  해제(flow_episodes 주석 계승).

## 구현 노트 (C1 프론트엔드)

> 2026-07-06 구현·검증(tsc/lint 0, 라이브 E2E). `/backtest` StubPage → 실제 페이지 교체.

### 컴포넌트 구조

```
frontend/src/pages/backtest.tsx        # 페이지: catalog fetch → 좌 빌더/우 결과 2-분할.
                                        #   run→job 폴링(1초·progress·%바), 422 필드에러/클라 검증 분리.
frontend/src/components/backtest/
  types.ts          # API 계약 타입 (Catalog/Strategy/BacktestResult/JobStatus/FieldError) + REASON_LABEL
  format.ts         # signCls/fmtPct/fmtSigned/fmtEok (컴포넌트 아님 — fast-refresh 격리)
  ui.tsx            # Tip(hover 툴팁)·Select·NumberInput·Field·SectionTitle
  catalog.ts        # CatalogIndex(byNs/byKey/numeric) + EditCond ↔ Condition 변환(toCondition/fromCondition)
  condition-row.tsx # ConditionRow([ns▾][지표▾][연산▾][값|ref×mult] Tip) + ConditionList(추가/삭제)
  builder-state.ts  # BuilderState + defaultState/serialize(클라 검증) + PRESETS
  strategy-builder.tsx # 좌 패널: 유니버스/진입(AND+OR 토글)/체결·비용(same_close 주황경고)/청산(체크박스)/기간·벤치마크/[실행][초기화]
  histogram.tsx     # 초과수익 분포 인라인 SVG (31 bin·1·99분위 클립·0 기준선·양초록/음빨강)
  result-view.tsx   # 우 패널: 메타줄/경고배지/스탯스트립/히스토그램/청산사유분해/연·월테이블/에피소드테이블(정렬·더보기)/방법론각주
```

### 설계 결정

- **진입 트리 = 기본 AND 리스트 + OR 그룹 1개 토글**(스키마 1-depth 중첩 대응). serialize:
  `andLeaves`만 → `{all:[...]}`, OR도 있으면 `{all:[...and, {any:[...or]}]}`, and 없이 or만 → `{any:[...]}`.
- **손절/익절 입력은 양수 크기**, 전송 시 stop=`-abs`, take=`+abs`(스키마 부호 규칙). 고정보유일 기본 ON·120.
- **`ref×mult` 지표 간 비교**는 행의 [값/지표] 토글 버튼으로. bool 지표(tag)는 is_true/is_false만·값 숨김.
- **프리셋 2개**(검증 조합만): "장기동시·120일 보유"(게이트 재현 헤드라인), "정석·손절15·익절30". 빈 결과 화면에서 클릭 시 빌더 채움.
- **재계산 금지 준수**: 히스토그램 binning·사유별 평균초과는 반환된 에피소드 배열의 **표시용 집계**일 뿐 지표를 다시 계산하지 않음(edge/t/수익은 백엔드 값 그대로).

### 백엔드 소규모 추가

- `panel.fetch_stock_names(codes)` + `jobs._run_backtest`가 **에피소드 등장 코드만** 종목명 조인 →
  `result.meta.stock_names`(code→name). 패널 pickle(458MB) 불변·경량 단일 SELECT. 에피소드 테이블
  종목명 표시용(없으면 코드만). 라이브 확인: 정석 전략 n=7817, stock_names 1566개, 000050→경방.
