# stat-arb-engine

LENS 통계 차익거래 엔진. 설계 상세는 [../stat-arb-engine.md](../stat-arb-engine.md).

## 개요

- **포트**: 8300
- **언어**: Rust + axum
- **역할**: 과거 데이터(일/30s/1m봉) 기반 페어 발굴, 통계량 갱신, REST/WS 노출
- **분리 이유**: realtime(8200)은 안정 유지, 통계 엔진은 활발 튜닝 — 자원/장애/배포 격리

## 실행

```bash
# 빌드 + 실행
cargo run --release

# 또는 start_dev.sh로 전체 LENS 스택 같이 기동
../start_dev.sh
```

## 환경변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `STATARB_DATABASE_URL` | `postgres://una0@/korea_stock_data?host=/var/run/postgresql` | Finance_Data PG DSN. peer auth. |
| `RUST_LOG` | `info` | 로그 레벨 |

## 디렉토리

```
src/
├── main.rs            axum 서버, AppState, /health, /debug/stats
├── data/
│   ├── mod.rs
│   └── pg_loader.rs   Finance_Data PG sqlx 연결 + ping
├── phase.rs           장 phase 판단 (Sleep/WarmUp/Live/WindDown)
└── holidays.rs        KRX 휴장일 (../data/krx_holidays.json 로드)
```

`phase.rs` / `holidays.rs` 는 `realtime/`과 동일 로직 임시 중복.
`lens-worktree1` 머지 후 `lens-common` workspace crate로 추출 예정.

## 헬스체크

```bash
curl http://localhost:8300/health
# {"status":"ok","port":8300,"phase":"live","pg_connected":true,"uptime_secs":12}

curl http://localhost:8300/debug/stats
```

## 다음 Phase

Phase 1: skeleton (현재) → Phase 2: PG 로딩 + 1:1 페어 발굴 → Phase 3: 화면 → ...

상세 PR 분해는 [../stat-arb-engine.md §10](../stat-arb-engine.md) 참조.
