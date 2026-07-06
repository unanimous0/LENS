"""범용 전략 백테스트 엔진 (PR-C1, 이벤트 스터디).

설계 단일 진실원: 루트 backtest.md. 이 패키지는 FastAPI(8100) 내부 배치 연산으로,
Finance_Data PG(read-only)에서 (time, stock) 일별 패널을 빌드(parquet/pickle 캐시)한 뒤
사용자 전략 JSON을 벡터화 시그널 → 에피소드 시뮬레이션으로 평가한다.

- schema:   전략 JSON pydantic 스키마 + 검증
- adapters: DataAdapter 프로토콜 + price/flow 어댑터 (지표 카탈로그 + 패널 컬럼)
- panel:    어댑터 패널 빌드·join·버전 캐시 (lazy — import/startup 부작용 없음)
- engine:   이벤트 스터디 (onset 에피소드 시뮬 + 초과수익/요약/경고)
- jobs:     메모리 job 레지스트리 (제출/진행/결과, 단일 동시 실행)

수급 태그는 공식 1벌: flow_metrics._row_to_metrics + flow_verdict.applicable_patterns
정본을 재호출한다 (flow_episodes와 동일 방식 — 근사 프록시 금지).
"""
