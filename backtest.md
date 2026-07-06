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
| `fin` | financial_metrics_quarterly | PER·PBR(일별 재계산)·EPS_ttm·BPS·ROE·ROA·영업이익률·영업이익/매출 YoY | **C3 ✅** (§3.1) |
| `own` | foreign_ownership | 외인 보유율, 보유율 5d/20d 변화(pp), 한도소진율 | **C3 ✅** |
| `index` | index_ohlcv_daily | (벤치마크 전용 — 조건 참조는 v2) | C2 |
| `etf` | etf_master_daily (+ohlcv/market_cap_daily) | 괴리율(disparity)·주당NAV·총보수. 가격/거래대금/시총은 price 공용(ETF도 커버) | **C4 ✅** |
| (보류) `statarb` | 페어 z-score | 페어 축이라 종목 축 패널과 구조 미스매치 — 결정 로그 참조 | — |

### 3.1 재무(fin) 어댑터의 point-in-time 문제 ⚠️

`financial_metrics_quarterly`는 **공시일 컬럼이 없다** (`collected_at`은 2026-05~06 수집
스냅샷 시각일 뿐). 그대로 period_end에 매핑하면 실적 발표 전에 아는 것이 되어 look-ahead.

- **규칙: `available_from = period_end + 공시 지연 상수`** (분기보고서 45일, 사업보고서(Q4) 90일 —
  자본시장법 제출기한, 보수적 고정). as-of 조인은 available_from 기준.
- **`data_type='actual'`만 사용.** preliminary/estimate는 "언제 그 추정치가 존재했나"를 알 수 없어
  (스냅샷 1회분) 백테스트 사용 자체가 look-ahead — 어댑터가 원천 차단.
- 커버리지(2026-07 실측): actual 2,611종목이나 **광범위(>1000종목) 첫 분기는 2024-12-31**
  (그 이전 actual은 각 분기 2~6행뿐). → as-of 레벨 지표(pbr/bps/roe…)는 **2025-03-31~**,
  TTM(per/eps_ttm)은 4분기창 완성 후 **2025-11-14~**, 전년동기(YoY)는 **2026-03-31~**.
  `fin` 조건 사용 시 실질 커버리지 시작을 리포트 warnings에 자동 표기(구현: C3 노트).

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
- holdout(기간 분할 잠금·1회 개봉)은 **C4에서 구현**(아래).

### holdout 잠금 (C4 — 부검 "train/holdout 1회 개봉" 계승)

반복 튜닝으로 얻은 edge가 신규 데이터에서도 유지되는지 **한 번만** 검증하는 레일. 사용자 노브가
아니라 **엔진이 강제하는 레일** — 스키마에 옵션 없음.

- **분할점**: `holdout_start` = 실효 커버리지(첫 유효 adj_open ~ 패널 끝)의 **75% 지점**(달력일).
  현 패널(adj_open 2024-04-23~2026-07-03) → **2025-12-15**. 패널 속성이라 spec·유니버스 무관·결정적.
- **레일(기본)**: 모든 실행은 **train-only** — 엔진이 실행 창 상한을 `holdout_start` 직전으로 캡
  (`_resolve_end`). 결과 `meta.holdout = {start, locked:true}` + 경고("최근 구간은 holdout으로 잠김 —
  저장 전략의 1회 개봉으로만 측정 가능"). period.end가 이미 train 안이면 캡 무영향.
- **개봉(전략별 1회)**: `POST /api/backtest/strategies/{id}/unlock-holdout` → `backtest_strategies`에
  `holdout_unlocked_at`(ms) + **개봉 시점 `holdout_spec_hash`** 기록. 재호출 = **409**.
- **개봉 후 전체 기간 실행 조건**: run 요청 `strategy_id`가 개봉된 전략 **AND** 실행 spec_hash가
  개봉 시점 hash와 **일치**할 때만. (개봉 후 조건을 바꿔 다시 전 기간을 보는 우회를 차단 — hash 불일치면
  train 캡으로 되돌아감.) 일치 시 전체 기간 + **train/holdout 분리 스탯**(이벤트: 각 구간 n·평균초과·t /
  포트폴리오: 구간별 수익) + `holdout.locked:false` + "개봉됨(1회성)" 경고 배지.
- **ad-hoc(strategy_id 없음)·미개봉·hash 불일치 → 항상 train 캡.** 판정은 `jobs._run_backtest`가
  store 조회로 수행 → 러너에 `holdout_unlocked` 전달.

### ADV 체결 가능량 캡 (C4 — portfolio 전용, LP 실무)

소형주 신호의 실현가능성 체크: 자본 대비 포지션이 종목 유동성(ADV20)의 x%를 못 넘게.

- 스키마 `portfolio.capital_eok`(원화 자본, 억)·`adv_cap_pct`(기본 null=비활성, 예 10 = ADV20의 10%).
  **둘 다 있어야 활성**(한쪽만 → 422). 비활성(기본) 경로는 기존과 **완전 동일**(scale=1·idle=0).
- 시뮬(engine_portfolio): 슬리브 목표 notional(억) = 가용현금×capital → max_notional = 진입일
  ADV20×cap% → `scale = min(1, max/목표)`로 **부분 체결**. 축소분(idle)은 슬리브 현금으로 잔류
  (수익 기여 없음·청산 시 회수). 결과 `portfolio.adv_cap = {capital_eok, adv_cap_pct, capped_entries,
  avg_fill_ratio}`. 평균 체결률 <50%면 유동성 부족 경고.

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
- **statarb 네임스페이스 보류** (2026-07-06, C4): 페어 z-score는 **종목 쌍(pair) 속성**이라
  (time, stock) 종목 축 패널과 구조가 미스매치 — 조건 트리·onset·에피소드 모델이 단일 종목 기준이라
  페어 축을 억지로 얹으면 엔진 레일이 깨진다. 게다가 통계차익은 이미 자체 화면(stat-arb-engine 8300)이
  인트라데이 디테일·포지션 추적을 보유(`stat-arb-engine.md`)해 백테스트 실험실과 목적·데이터 경로가
  다르다. → etf만 C4에 추가하고 statarb는 미구현. 필요 시 별도 pair-축 엔진으로 분리 검토.

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

## 구현 노트 (C2 백엔드)

> 2026-07-06 구현·검증 완료. **백엔드만** (프론트는 다음 단계). portfolio 모드 + rank_pct +
> kospi/kosdaq 벤치마크 + 전략 저장·실행 이력(lens.db) + 다중검정 카운터.

### 패키지 추가/변경 (실제)

```
backend/services/backtest/
  engine.py            # 리팩터: _prepare/_run_episodes 추출(포트폴리오와 공유),
                       #   rank_pct 평가(_eval_rank_pct), 벤치마크 일반화(_build_bmap)
  engine_portfolio.py  # NEW — run_portfolio: 이벤트 스터디 산출 + 자본 제약 시뮬(N 슬리브)
  store.py             # NEW — lens.db 전략 CRUD + 실행 이력 + spec_hash + attempts (positions.py 관례)
  panel.py             # +_fetch_indices(KGG01P/QGG01P) → panel["indices"]; 캐시에 indices 포함
  schema.py            # portfolio.mode=portfolio·max_positions(20)·weighting·rank_by;
                       #   Condition op rank_pct_top/bottom(value 0~100); benchmark kospi/kosdaq; iter_conditions
  jobs.py              # submit(spec, strategy_id); 모드별 runner; 완료 시 store.record_run + attempts 주입
backend/routers/backtest.py  # +/strategies(POST/GET/DELETE)·/runs; run에 strategy_id·rank_pct bool 금지 검증
backend/main.py        # startup에서 backtest store.ensure_schema()
```

### portfolio 모드 (engine_portfolio.py)

- **자본 모델 = N 슬리브(sub-account).** 각 슬리브 1/N 시작, 비면 당일 진입 후보를 담아 슬리브
  전액 투자, 청산 실현액이 그 슬리브 현금이 되어 재사용(리밸런스 없음=슬리브 독립).
  일별 에쿼티 = Σ현금슬리브 + Σ투자슬리브 시가평가(adj_close). 비용은 진입·청산 각 (1−cost_bps/1e4)
  곱(왕복 ≈ C1의 2×cost_bps 가법과 2차항 차이).
- **에피소드 후보 = C1 `_run_episodes` 결과 그대로** (청산은 자본과 무관 — 규칙만으로 결정). 포트폴리오는
  "어느 onset을 잡을지"만 자본으로 제약. 그래서 result에 **이벤트 스터디 산출(자본 무제약)도 함께** 담아
  방향/edge를 별도 측정(§검증1 부호 정합).
- 일별 루프: (1) 당일 exit 슬리브 회수→슬롯 반환 (2) 빈 슬롯에 당일 진입후보를 rank_by 내림차순
  (None이면 코드순) 채움, 동일 종목 중복 보유 금지 (3) 시가평가로 에쿼티 1점. `entered+missed+dup
  == n_candidate` 항등(회계 무결성).
- **종가 실현 현금의 당일 재사용 금지** (혼합 체결 look-ahead 가드): 청산이 종가 체결(next_close·
  same_close·ongoing 마감)인 슬리브는 실현 현금을 **다음 di부터** 진입에 사용(`sleeve_lock_di`) —
  시가 진입이 당일 종가 매도 대금을 쓰는 look-ahead 차단. 시가 청산 대금은 동시 체결이라 당일 재사용
  유지 → 기본 next_open/next_open 결과 불변(final 1.361951), next_open/next_close는 1.3495→**1.3212**
  (낙관 제거 방향).
- **실효 커버리지 표기**: meta에 `effective_start`(첫 유효 adj_open 날짜) 추가, period.start보다 늦으면
  warnings에 "가격 데이터(수정시가) 가용 시작 YYYY-MM-DD — 그 이전 신호는 측정 불가" 자동 추가
  (이벤트 스터디·포트폴리오 공통, `_summarize`). 현 패널 effective_start=2024-04-23.
- **에쿼티 커브 시작 t0 = 첫 진입일**(자본 배치 시작, 워밍업 flat-cash prefix 제거). 벤치마크도 t0에서
  1.0 정규화 → 동일 창 비교. 커브 = `[{date, equity, benchmark?}]` (lightweight-charts용).
- **정의**: CAGR = final_eq^(365.25/일수)−1. MDD = 커브 running-max 대비 최저(peak/trough 날짜 포함).
  Sharpe = 일별 초과수익(전략−벤치, 벤치 없으면 절대) 평균/표준편차 × √252. **회전율(연간)** =
  Σ진입 notional / 평균에쿼티 / 연수(편도 배치 비율). 연도표 = 커브 연말/직전연말(첫해 1.0) 대비 전략·벤치·초과.

### rank_pct (횡단면 순위) + 벤치마크

- `rank_pct_top/bottom value` = 그날 **유니버스 내**(uni & non-NaN) 지표 percentile 상·하위 value%.
  `groupby(time).rank(pct=True, method='min')` 벡터화. bool(태그) 지표엔 라우터가 422.
  `rank_by`도 동일 카탈로그 키 공간(포트폴리오 우선순위).
- 벤치마크 kospi=`KGG01P`, kosdaq=`QGG01P`(index_ohlcv_daily, 코스피/코스닥 **종합**지수 — 분할 없어 raw
  close). panel 빌드 시 2 시계열(각 ~1,100행) 함께 캐시(`panel["indices"]`, 무시 가능 크기). excess는
  지수 비율로 차감. **C2 이전 캐시엔 indices 부재 → `_load_cache`가 재빌드 유도**(1회 100s).

### store.py / lens.db (positions.py 관례)

- 테이블 `backtest_strategies(id,name UNIQUE,spec_json,created_at,updated_at)` /
  `backtest_runs(id,strategy_id nullable,spec_json,spec_hash,summary_json,panel_version,started_at,finished_at,status)`.
  **summary(스탯·경고·메타)만 저장** — 에쿼티·에피소드 배열 제외(재실행 재현 가능, spec 사본 보존).
- **spec_hash** = `model_dump(json)`에서 **name 제외** → `json.dumps(sort_keys)` → sha256. 같은 조건이면
  이름 달라도 같은 계열. **attempts** = {same_spec(동일 hash run 수), total_runs}. jobs 완료 시(성공/실패
  모두) record_run → result에 `attempts` 주입(status=done 승격 **전에** 주입해 poll 경합 방지).
- 이름 중복 = 새 버전 아님(단순 upsert, updated_at 갱신). API: POST/GET/DELETE `/strategies[/{id}]`,
  GET `/runs?strategy_id=&limit=`, POST `/run` body에 optional `strategy_id`.

### 검증 결과 (§10 C2 기준)

1. **portfolio**(장기동시·fixed120·max20, universe_avg): 실행 **2.6초**(<10s). event-study avg_excess
   **+1.58%**(동일)와 부호 정합. final_eq **1.362**·CAGR **15.13%**·MDD **−35.94%**(2026-05-08→06-26)·
   Sharpe 0.18·회전율 2.31·avg_pos 19.9. entered 100 / **missed 6803** / dup 261 (합 7164=후보수 — fixed120
   장기보유라 20슬롯이 반년씩 점유 → 대부분 미체결, 용량 제약 가시화).
2. **자본 보존**(cost0·bench none): 순수 보유일 3개에서 `equity 증분 == Σ value_prev×일별수익`이 **1e-16
   일치**. 가중평균 vs 등가중 차 ~1e-3(슬리브 값 발산 — 진입 시점 등가중, 이후 drift; 설계대로).
3. **rank_pct** `price.ret_20d rank_pct_top 10`: 날짜별 선택/유니버스 비율 **mean 0.100·median 0.100**(≈10%).
4. **kospi 벤치마크**: avg_excess universe_avg +1.58 / **kospi −29.96** / kosdaq +4.02 — 명확히 상이.
   지수값 정렬 확인(KGG01P 2022-01-03=2988.77 … 2026-07-03=8088.34, 합성 데이터라 대폭 상승 → 큰 음의 초과).
5. **store E2E**(라이브 8100): 저장→목록→run 연결→runs 이력→**attempts same_spec 1→2·total 1→2**·동일
   spec_hash. rank_pct-of-bool 422. lens.db 스키마 전후 불변(positions·loan_rates rows 보존).
6. **C1 회귀**: event_study(장기동시 fixed120 전 구간) **n=7164·+1.58%·t2.37 불변**(직접·풀스택 양쪽).
7. `python3 -c "import main"` 통과.

### 설계와 달라진 점

- **에쿼티 커브 시작 = 첫 진입일**(period start 아님): 지표 워밍업으로 첫 onset이 수개월 뒤라, period
  start부터 시작하면 flat-cash prefix가 CAGR·MDD를 왜곡. 자본 배치 시작점부터 벤치마크와 동일 창 비교.
- **max_positions 기본 20을 항상 부여**(event_study는 무시): C1의 `max_positions: None`을 20으로. 스키마
  단순화 — 모드 무관 유효값.
- **portfolio 결과에 이벤트 스터디 블록 동봉**: "이벤트 스터디 산출에 추가"를 결과 dict 병합으로 구현
  (result = C1 summary/episodes/warnings/meta + `portfolio` 블록 + `mode`). 방향 정합 검증이 직접 가능.
- **회전율 정의 = 편도 진입 notional / 평균에쿼티 / 연수**: 왕복이 아닌 편도 배치 비율(진입=청산이라 편도로
  충분). 짧은 보유(20d)일수록 커짐(검증 rank_by run 15.7 vs fixed120 2.31)로 직관 부합.

## 구현 노트 (C2 프론트엔드)

> 2026-07-06 구현·검증(tsc/lint 0, 라이브 E2E). C1 프론트 구조 확장 — 회귀 없음(이벤트 스터디 모드 결과 불변).

### 컴포넌트 구조 (추가/변경)

```
frontend/src/components/backtest/
  types.ts          # +Op(rank_pct_top/bottom)·Benchmark·PortfolioMode; Strategy.portfolio 확장·benchmark 확장;
                    #   +Attempts·EquityPoint·PortfolioYear·PortfolioResult; BacktestResult에 mode/attempts/portfolio;
                    #   +StrategyRecord(/strategies)·RunRecord+RunSummaryHead(/runs)
  catalog.ts        # +isRankOp; toCondition에 rank_pct 분기(value 0<v<=100, ref 금지)
  condition-row.tsx # NUMERIC_OPS=COMPARE+RANK, OP_LABEL(상위/하위 N%); rank op일 때 % 값 입력·ref토글 숨김; ns/field 전환 keep-op를 NUMERIC_OPS로
  builder-state.ts  # BuilderState +mode/maxPositions/rankBy; serialize가 portfolio 블록 생성(+max_positions 검증);
                    #   NEW stateFromStrategy(spec→BuilderState) 역변환(저장 전략 로드)
  strategy-builder.tsx # NEW "모드" 섹션(칩 이벤트/포트폴리오 + max_positions·rank_by 셀렉트 Tip); 벤치마크 kospi/kosdaq 추가
  equity-curve.tsx  # NEW — lightweight-charts v4 autoSize(flow-detail 관례). 전략 accent/벤치 회색 2라인(t0=1.0), 자체 크로스헤어 툴팁(누적수익%)
  portfolio-view.tsx # NEW — 포트폴리오 스탯 스트립(누적/CAGR/MDD(구간 Tip)/샤프/회전율/평균보유/미체결(entered·missed·dup Tip)) + 에쿼티 커브 + 연도별표(전략/벤치/초과)
  strategy-bar.tsx  # NEW — 상단 저장 전략 바: GET /strategies 셀렉트·로드, [저장](이름 입력 upsert)·[삭제], 선택 전략 최근 실행 요약(GET /runs?strategy_id=)
  run-history.tsx   # NEW — 실행 이력 접이식 패널(GET /runs?limit=30): 시각·모드·해시8·n·초과·CAGR·MDD·상태
  result-view.tsx   # +AttemptsBanner(N>1 주황); portfolio 모드면 PortfolioView 먼저 + "용량 제약 없는 이벤트 스터디 관점" 제목; 벤치 라벨 4종
frontend/src/pages/backtest.tsx  # StrategyBar(헤더 하단)·RunHistory(결과 하단) 배선; selectedStrategyId(run body에 strategy_id 주입)·refreshToken(실행 완료 시 bump→바/이력 갱신); currentSpec=serialize 결과(저장용); loadStrategy/reset이 선택 해제
```

### 설계 결정

- **strategy_id는 Strategy 스키마 밖 키**: 라우터가 검증 전 pop → run body에 `{...strategy, strategy_id}`로 주입(선택 전략 있을 때만).
- **rank_pct UI 가드**: bool(태그) 지표엔 연산 셀렉트에 rank op 미노출(백엔드 422와 정합) — opOptions가 bool이면 BOOL_OPS만.
- **stateFromStrategy round-trip**: serialize 산출물(`{all}`/`{all,{any}}`/`{any}`) 역변환 불변(esbuild 런타임 왕복 테스트로 확인). 손으로 쓴 중첩 `{all:[…,{all:[…]}]}`은 최상위 AND 리스트로 **평탄화**(AND 결합법칙상 의미 동일 — OR로 로드하면 재저장 시 AND→OR 의미 변형), `{any}` 하위그룹만 OR 그룹으로. 청산 규칙은 전부 off 후 규칙별 on, 손절/익절은 abs로 복원.
- **에쿼티 커브 = lightweight-charts**(시계열), 스탯·연도표는 인라인. 벤치 none이면 1라인. 색 절제(전략 accent·벤치 회색).
- **재계산 금지 준수**: 포트폴리오 스탯·커브·연도표 모두 백엔드 `portfolio` 블록 값 그대로 표시(프론트 집계는 히스토그램·사유별 평균처럼 표시용만).

### 검증

- `npx tsc --noEmit` 0, `eslint src/pages/backtest.tsx src/components/backtest/` 0(기존 타 파일 에러는 무관).
- 라이브 E2E: portfolio(장기동시·kospi) run — mode=portfolio·CAGR·MDD·equity_curve(bench 포함)·attempts{same_spec,total_runs} 수신. rank_pct_top+portfolio+rank_by(flow.f_20d_bp)+kosdaq run 정상(entered 135·curve 512·bench 동봉). strategies POST/GET/DELETE·runs 이력 응답 확인.
- 백엔드 추가 수정 **없음**(C2 백엔드 계약 그대로 소비).

## 구현 노트 (C3 백엔드 — fin·own 네임스페이스)

> 2026-07-06 구현·검증 완료. **백엔드만**. 프론트 수정 불요(카탈로그가 네임스페이스를
> 동적 생성 — `idx.namespaces.map`. fin/own 드롭다운 자동 노출·조건 선택 확인). C1/C2 회귀 없음.

### DB 실측 결과 (구현 근거 — Finance_Data read-only)

- **`financial_metrics_quarterly`**
  - **순분기(누적 아님)**: 005930 CFS revenue Q1'25 79.1T > Q2'25 74.6T — 누적이면 불가능 →
    단일분기 확정. ∴ EPS_ttm = 순분기 EPS 4개 **단순 합**(차분 불필요).
  - **정본 fs_type = CFS(연결) 우선, 결측만 OFS 폴백**(per-field `combine_first`). actual에서
    CFS revenue non-null 77.5% vs OFS 93.9%; **CFS eps NULL·OFS 존재가 2,000 (종목,분기)** →
    OFS 폴백이 실질적으로 구제. 모든 종목이 CFS·OFS 두 행을 다 가짐(OFS-only 0).
  - **저장 `per` 100% NULL**, `pbr`은 collected_at(2026-05~06) 시점 가격 기반(point-in-time 아님)
    → per·pbr **저장값 폐기, raw종가(close_price) 일별 재계산**. 음수/0 EPS·BPS → NaN(관례).
  - `data_type`: actual 30,014 / estimate 15,594 / preliminary 72. **actual만** 원천 SQL 차단.
  - actual **광범위(>1000종목) 커버리지 첫 분기 = 2024-12-31**(2,056종목); 이전 actual은 각 2~6행.
    5개 광범위 분기(2025-03/06/09/12, 2026-03).
- **`foreign_ownership`**(하이퍼테이블 236청크): 일별 전종목 **2022-01-03~ 완전 커버리지**(2,657종목,
  ratio/limit/vol 전부 non-null). `frn_limit_ratio` 대다수 100(무제한)이나 은행·통신·유틸은
  49/49.99/30/40(유효). limit=0 (1,830행) → 소진율 NaN 가드.

### FinAdapter (`fin`, adapters.py) — 9 지표

- 지표: `per`·`pbr`(일별 재계산) / `eps_ttm`·`bps`·`roe`·`roa`·`operating_margin`(as-of) /
  `op_yoy`·`revenue_yoy`(전년동기, 직전 흑자 기준·적자→NaN).
- **available_from = period_end + 45일**(분기·반기), **12월 결산(FY말=Q4) 90일**(자본시장법 제출기한).
  비12월 결산 소수 종목(각 ~4행) 사업보고서는 +45로 근사(§3.1). period_end 단조↑ → available_from
  단조↑ → **as-of backward merge**가 point-in-time 보장. EPS_ttm/YoY는 분기 레벨에서 4Q rolling
  합·shift(4)로 선계산 후 as-of 조인(available_from 기준이라 무결).
- **required_sources = {ohlcv, fin}**(ohlcv는 per/pbr용 raw종가). 카탈로그 available_from:
  pbr/bps/roe/roa/op_margin=2025-03-31, per/eps_ttm=2025-11-14, op_yoy/rev_yoy=2026-03-31.

### OwnAdapter (`own`) — 4 지표

- `frn_ratio`(%) / `frn_ratio_5d_chg`·`frn_ratio_20d_chg`(pp, 종목내 shift) / `frn_limit_util`
  (한도소진율 = 보유율÷한도×100, limit>0 가드). foreign_ownership은 이미 일별이라 스파인에 직접
  left-join. required_sources = {foreign}(RawFetcher `_foreign`, 연도 청크).

### panel/engine 배선

- panel `adapter_versions()`에 **fin**(=max(collected_at):actual행수)·**own**(=max(time):당일행수)
  프로브 추가 → 캐시 버전 키 4벌. **구 pickle(2벌 키)은 버전 불일치로 자동 재빌드**(C2 indices 방식).
- `_compute`: price 스파인에 flow에 이어 fin/own을 left-join(각 (time,stock) 유일 → 행 증식 없음,
  없는 날 NaN). 기존 price/flow 컬럼·행 불변.
- engine `_summarize`: 전략이 `fin.*`/`own.*` 필드를 참조할 때만 warnings에 실질 커버리지 자동 표기
  ("재무 조건 사용 — 공시 지연 근사(45/90일)·actual만, 실질 커버리지 YYYY-MM-DD~" / "외인보유율
  조건 사용 — 실질 커버리지 YYYY-MM-DD~"). effective_start 경고와 동일 방식.

### 검증 결과

1. **look-ahead 실측(005930)**: eps_ttm 첫 non-NaN = **2025-11-14**(2025-09-30 Q3+45). 직전
   거래일(2025-11-06) NaN → onset(11-14)부터 값 **4817**(=1115+1186+733+1783, CFS 4Q 합)이며
   다음 공시 전까지 상수 유지. bps(as-of)는 2025-03-31부터. → 공시 지연 이전 미래정보 미사용 확인.
2. **PER 재계산 새니티(005930 2026-07-03)**: per=**25.01**(raw종가 309,500 ÷ eps_ttm 12,373)로
   내부 정합. 재계산 pbr 4.28 vs 저장 pbr 2.31 — collected_at 시점 가격 차이(point-in-time이 맞음).
   ※ 본 DB는 합성/미래일자 데이터(지수·주가 스케일 확대)라 실 HTS 배수와 직접 비교는 무의미.
3. **E2E(라이브 8100)**: `fin.pbr<=1.0 AND flow.tag.장기동시` fixed120 — **n=1571·avg_excess
   +1.17%·t 0.99**, warnings에 재무 경고(실질 커버리지 2024-11-14~) 등장. `own.frn_ratio_20d_chg>=1`
   스모크 n=7298·own 경고(2022-01-03~) 등장. catalog에 fin(9)·own(4) 노출·가용일 정확.
4. **회귀**: C1 장기동시 fixed120 = **n=7164·+1.58%·t2.37 불변**. C2 포트폴리오(cost0) final
   = **1.361951 불변**(entered100/missed6803/dup261 동일), 결정적. → fin/own 추가가 price/flow
   경로 무영향 확인.
5. **콜드 재빌드**: 벽시계 **112초**(기존 ~100초), pickle **600MB**(기존 458MB, fin/own 컬럼
   +142MB). rows 2,727,876·2,719종목 불변.
6. `python3 -c "import main"` 통과. 프론트 무수정(tsc 불요).

### C3.1 보정 (독립 검증 지적 반영, 2026-07-06)

1. **[Medium] per/pbr 분할·병합 basis 브리지** — 저장 eps/bps는 **collected_at 스냅샷 주식수
   기준으로 이력 전체 소급 재표시**됨을 실측(042510 5:1 병합·117670 12.1× 전후
   shares_outstanding 불변). raw종가(t)와 기준 불일치 → (t, collected일] 사이 이벤트 시 factor배
   왜곡. **corporate_actions는 브리지 불가 판정**: share_factor/ratio/cash 100% NULL, 전 행이
   가격 gap 자동감지(`UNKNOWN_FROM_FACTOR`) price_factor뿐 — 대신 그 price_factor와 동일 정보인
   **adjfac(t)=adj_close/close_price**(분할·병합 전용 누적 factor — 배당주 005930 전구간 1.0000,
   042510 5.0026 실측)로 `value_basis(t) = value × adjfac(collected일)/adjfac(t)` 환산 후 나눈다.
   collected_at **이후** 이벤트(예: 011330 10:1 2026-06-30)도 같은 식으로 보정. eps_ttm/bps 패널
   컬럼도 basis(t) 값으로 노출. 검증: **042510 pbr 이벤트 전후 연속**(05-02 1.951 → 05-07 2.012,
   보정 전 0.39로 5× 왜곡) / **011330** bps 1,412→14,120 전환·pbr 연속(0.280→0.273) /
   **005930(CA 없음) 소수점까지 불변**(per 25.0141·pbr 4.2799).
2. **[Low] TTM/YoY 분기 연속성 게이트** — rolling(4)/shift(4)의 행 연속 가정 제거: 4분기창 스팬
   (pe−pe.shift(3)) 250~290일·전년동기 스팬(pe−pe.shift(4)) 350~380일 벗어나면 NaN
   (실측 488900 gap 184일 케이스 차단).
3. **[Info] 네임스페이스 경고가 portfolio.rank_by 커버** — rank_by만 fin 지표여도 재무 경고 주입
   (검증: rank_by=fin.pbr 단독 실행에 경고 등장).
- **panel `PANEL_SCHEMA_VERSION`(=2) 도입**: DB 프로브는 어댑터 산식 변경을 감지 못함 →
  공식 버전을 버전 키에 포함해 구 pickle 자동 무효화 (수동 삭제 불요).
- 회귀: C1 n=7164·+1.58·t2.37 / C2 final 1.361951 **불변**. fin E2E 헤드라인은 왜곡 제거로 변동
  (n=1571→1563·avg +1.17→+1.69·t 0.99→1.43). 재빌드 112.6초·pickle 600MB 동일.

## 구현 노트 (C4 백엔드 — etf 네임스페이스 + holdout 잠금 + ADV 체결 캡)

> 2026-07-07 구현·검증 완료. **백엔드만**. 프론트 수정 불요(카탈로그가 네임스페이스 동적 생성 —
> etf 드롭다운 자동 노출). C1/C2/C3 레퍼런스는 **개봉 전략(전체 기간)** 으로 재현·불변 확인.

### A. etf 네임스페이스 + 유니버스 확장

- **EtfAdapter**(`etf`, adapters.py) 3 지표: `disparity`(괴리율 % = raw종가 ÷ 주당NAV − 1,
  주당NAV = net_asset/listed_shares)·`nav_per_share`·`total_fee`. 원천 = etf_master_daily
  (as-of backward 조인, 스냅샷 없는 날 forward-fill). 커버리지 **2026-01-02~** — 사용 시 실질
  커버리지 경고 자동(fin/own과 동일 메커니즘, engine `_summarize` used_ns 분기). 비ETF 종목 = NaN.
- **유니버스에 ETF 추가**: `_resolve_universe`가 `market IN (KOSPI,KOSDAQ,ETF)` — 패널 1벌에
  담고 엔진이 spec.universe.markets로 슬라이스. 스키마 `Universe.markets`에 "ETF" 허용. **기본값
  markets는 KOSPI/KOSDAQ 유지** — ETF는 명시 선택 시에만. flow/fin/own은 ETF에 자연 NaN(조건에
  쓰면 탈락 = 정상 시맨틱). price 지표(수익률·거래대금·시총·MA)는 ohlcv/market_cap_daily로 그대로 동작.
- **ETF mcap 폴백**: market_cap_daily 실측 커버리지 **1142/1143**(거의 완전)이라 대부분 그대로
  동작. 결측 시만 etf 어댑터의 `_etf_mcap_eok`(net_asset÷1억, 카탈로그 밖 헬퍼)로 `_compute`가
  fillna 후 즉시 drop → universe min_mcap 필터가 ETF에도 동작.
- **패널 규모 증가**(콜드): rows 2,727,876 → **3,573,208**(ETF ~845k행), 종목 2,719 → **3,862**,
  pickle **600MB → 829MB**(+229MB), 콜드 재빌드 **112 → 127초**. `PANEL_SCHEMA_VERSION 2→3`
  (구 pickle 자동 무효화·재빌드).
- etf_master_daily는 **`etf_code`** 컬럼(stock_code 아님)·하이퍼테이블 아님(단일 SELECT).

### B. statarb — 미구현 (결정 로그 "보류" 참조)

### C. holdout 잠금 (§6 holdout 섹션 = 스펙)

- engine `compute_holdout_start`(패널 75% 지점) + `_resolve_end`(train 캡 or 전체) + `_prepare(end_cap)`
  + `_attach_holdout`(meta.holdout 블록·경고·구간 분리 스탯). run_event_study/run_portfolio에
  `holdout_unlocked` 인자. jobs가 store 조회로 판정(strategy_id 개봉 + spec_hash 일치).
- store: `backtest_strategies`에 `holdout_unlocked_at`·`holdout_spec_hash` **ALTER TABLE
  ADD COLUMN**(PRAGMA table_info 체크 — 기존 배포 호환). `unlock_holdout`(재호출 시 already 반환→409).
  라우터 `POST /strategies/{id}/unlock-holdout`.
- **라우터 422 직렬화 수정**: 커스텀 model_validator의 ValueError 객체(ctx.error)가 JSON 직렬화
  불가 → `e.errors(include_url=False, include_context=False)`. (기존 Condition/Universe 검증에도
  잠재했던 버그를 ADV 캡 both-or-neither 검증이 표면화.)

### D. ADV 체결 가능량 캡 (§6 ADV 캡 섹션 = 스펙)

- schema `Portfolio.capital_eok`·`adv_cap_pct` + both-or-neither model_validator(422). engine_portfolio
  `_simulate`가 슬리브 진입 시 scale 계산·부분 체결(committed/idle 분리) — **비활성 경로는 scale=1·
  idle=0으로 기존과 바이트 동일**. 결과 `portfolio.adv_cap` 블록 + 저체결 경고.

### 검증 결과 (전부 수치)

1. **레퍼런스 불변(개봉=전체 기간)**: 이벤트(장기동시 fixed120, cost0, universe default) 전체 기간
   **n=7164·avg +1.58%·t 2.37 불변**. 포트폴리오(cost0) 전체 기간 **final 1.361951 불변**
   (entered 100·missed 6803·dup 261 동일). → **train-only 새 레퍼런스**: 이벤트 **n=4668·−3.33%·
   t −5.32**(period.end 2025-12-14, holdout locked), 포트폴리오 **final 1.242168·CAGR 14.16%**.
   (train 캡으로 fixed120 경계 에피소드가 잘려 음수 — holdout 개봉 시 train/holdout 분리로 확인.)
2. **holdout E2E(라이브 8109)**: ad-hoc → train 캡(locked·period.end 2025-12-14) ✓ / 저장 → run
   pre-unlock 여전히 train 캡 ✓ / unlock 200 ✓ / 동일 spec run → **locked:false·n=7164 + 분리 스탯**
   {train n=4697·−0.69%·t −0.79 / **holdout n=2467·+5.89%·t 5.97**} + 개봉 배지 ✓ / spec 수정
   (days 100) run → **다시 train 캡**(hash 불일치 우회 차단) ✓ / unlock 재호출 → **409** ✓.
   포트폴리오 분리: train +24.44%(399일) / holdout +9.64%(134일).
3. **ETF**: markets=["ETF"] `price.ret_20d rank_pct_top 10`(개봉) **n=2700·avg +2.04%·유니버스
   637종목** / `etf.disparity<=-0.3` **n=2088·+0.72%** + ETF 커버리지 경고(2026-01-02~) ✓. KOSPI/KOSDAQ
   기본 실행 유니버스 2444종목, **에피소드에 ETF 코드 0개**(ETF 미포함 확인) ✓. (ad-hoc train 캡 시
   etf.disparity는 데이터가 holdout 구간(2026-01-02~)에만 있어 n=0 — 정상.)
4. **ADV 캡**(capital 100억·adv_cap 10%, 전체 기간): **capped_entries 47·avg_fill_ratio 72.1%**,
   final **1.306937** vs 비활성 **1.361951**(diff −0.055 — 부분 체결로 현금 드래그). 비활성 경로
   final **1.361951 불변**. both-or-neither 422 확인.
5. **콜드 재빌드**: 127초·pickle 829MB(§A).
6. `python3 -c "import main"` 통과.

## 구현 노트 (C4 프론트엔드 — ETF 유니버스 · holdout UI · ADV 캡)

> 2026-07-07 구현·검증(tsc/lint 0, 라이브 UI E2E). C1~C3 프론트 구조 확장 — 회귀 없음. 백엔드
> 무수정(C4 백엔드 계약 그대로 소비).

### 컴포넌트 변경 (추가 없음 — 기존 파일 확장)

```
frontend/src/components/backtest/
  types.ts          # Market('ETF' 추가)·Strategy.universe.markets=Market[]; Strategy.portfolio에 capital_eok/adv_cap_pct;
                    #   +Holdout(locked true | false+event_study{train,holdout}+portfolio?)·HoldoutEventStat·HoldoutPortfolioSeg;
                    #   ResultMeta.holdout; PortfolioResult.adv_cap(AdvCap); StrategyRecord에 holdout_unlocked_at/holdout_spec_hash
  builder-state.ts  # BuilderState.markets에 ETF·+capitalEok/advCapPct(''=비활성);
                    #   serialize: markets ETF 포함·ADV캡 both-or-neither 클라검증(한쪽만→에러, 백엔드 422 정합)·
                    #   둘 다 유효할 때만 portfolio에 capital_eok/adv_cap_pct 주입(비활성=필드 미포함=기존 경로 불변);
                    #   stateFromStrategy 역변환에 ETF·ADV캡 복원
  strategy-builder.tsx # 유니버스에 ETF 체크박스(기본 OFF)+Tip(수급/재무/외인 없음→자동 제외·괴리율 2026-01~);
                    #   portfolio 섹션에 "ADV 체결 캡(선택)" 자본(억)·캡% 입력+Tip(LP 실무 체결가능량 ≤ADV20의 N%)·한쪽만 경고
  strategy-bar.tsx  # 미개봉 저장전략 선택 시 [holdout 개봉] 버튼→인라인 confirm(1회성·불가역·조건수정 시 재잠금 명시)→
                    #   POST /strategies/{id}/unlock-holdout(200/409/404 처리)·reloadList 동기화; 개봉된 전략은 "개봉됨(1회성) YYYY-MM-DD" 뱃지
  result-view.tsx   # meta.holdout 전용 HoldoutPanel: locked=정보성 파랑 배지+Tip(과적합 방지 레일 설명),
                    #   개봉=주황 "개봉됨(1회성)" 배지 + train/holdout 분리 스탯 블록(이벤트 n·평균초과·t / 포트 수익·기간);
                    #   백엔드 holdout 경고 문구는 배지와 중복이라 warnings에서 필터; PortfolioView에 holdoutStart 전달
  portfolio-view.tsx # ADV 캡 활성 시 스탯 라인(자본·캡%·축소 진입·평균 체결률<50%면 주황); holdoutStart를 EquityCurve로 전달·범례
  equity-curve.tsx  # holdoutStart 있으면 경계 데이터점에 주황 마커(v4 세로선 시리즈 없음 → aboveBar arrowDown 'holdout' 마커로 대체)
```

### 설계 결정 / 설계와 달라진 점

- **holdout 경고 문구 중복 제거**: 백엔드가 `warnings[0]`에 넣는 "최근 구간은 holdout으로 잠김…"/
  "holdout 개봉됨…"을 전용 HoldoutPanel 배지로 렌더하므로 warnings 리스트에서 prefix 매칭 필터 —
  같은 내용이 두 번 뜨지 않게.
- **에쿼티 세로 구분선 = 마커로 대체**: lightweight-charts v4에 세로선 시리즈가 없어(가격선은 수평만),
  설계의 "가능하면 세로 구분선"을 **경계 데이터점 마커(arrowDown 'holdout', 주황)** + 범례 라벨로 구현.
  locked 결과는 커브가 holdout 직전에서 끝나 마커 불필요 → 개봉(전체 기간) 시에만 전달.
- **ADV 캡 필드 조건부 주입**: 둘 다 유효할 때만 spec.portfolio에 capital_eok/adv_cap_pct를 넣음
  (비활성이면 키 자체를 생략 → spec_hash·백엔드 경로가 기존과 바이트 동일). 한쪽만 입력은 serialize가
  클라 검증 에러로 막아 백엔드 422 도달 전에 차단(422와 메시지 정합).
- **stateFromStrategy 왕복**: ETF 마켓·ADV 캡 필드를 대칭 복원. unlock hash 매칭이 라이브에서 성립
  (저장 spec_hash == 실행 serialize hash)해 round-trip 안정성 확인.

### 검증 (라이브 UI E2E, 패널 웜)

1. **잠김(기본)**: 장기동시·fixed120 실행 → 정보성 파랑 배지 "최근 구간(2025-12-15~)은 holdout으로
   잠김"·period 2022-01-03~**2025-12-14**·n **4,668**(train 캡). 중복 경고 없음.
2. **개봉 플로우**: 포트폴리오+ADV캡(100억·10%) 전략 저장 → [holdout 개봉]→confirm→개봉 → "개봉됨(1회성)"
   뱃지. 동일 spec 실행 → 전체 기간 n **7,164** + 분리 스탯 {train n 4,697·−1.19%·t −1.36·포트 +10.90%(399일) /
   **holdout n 2,467·+5.39%·t 5.46·포트 +15.95%(134일)**} + 에쿼티 커브 holdout 마커(2025-12-15). (cost 25라
   백엔드 cost0 레퍼런스와 소수 차 — 방향·n 정합.)
3. **ADV 캡 표시**: 자본 100억·ADV20의 10%·**축소 진입 47건·평균 체결률 72.3%** 스탯 라인 노출.
4. **ETF 체크박스**: 유니버스에 ETF(기본 OFF)+Tip 렌더. serialize/round-trip에 ETF 포함.
5. **정리**: 테스트 전략(curl·UI 각 1)만 생성 후 삭제 — 사용자 전략 '장기동시 포트 120D'는 unlock 미호출·
   locked 유지(불변 확인). `npx tsc --noEmit` 0, `eslint src/pages/backtest.tsx src/components/backtest/` 0.
