# LENS 남은 작업

세션 마칠 때 갱신. 끝난 항목은 체크박스 지우거나 줄 자체를 제거.

## 🟢 외부 의존 — 대기 중

- [ ] **Finance_Data 배당 ETL 완성** — 그쪽이 `data/dividends.json` 떨어뜨리면 LENS는 자동 swap (코드 변경 0). `backend/routers/dividends.py:14-16`이 export 파일 우선순위로 자동 인식
- [ ] **LS API 정상 복구 확인** — 2026-04-27 abuse 의심으로 데이터 0건이었음. 다음 거래일에 `/debug/stats.feed_state == fresh`, `ticks_per_sec` 정상치(100+) 들어오는지

## 🟡 소규모 마무리

- [ ] **`stock-arbitrage.md` Phase C 체크리스트 갱신** — 호가창/스프레드 호가창/캘린더 스프레드 컬럼은 이미 구현됐는데 체크 안 됨 (5분)
- [ ] **만기 임박 행 강조** — 잔존 ≤7일 노란 배경, ≤3일 빨강 배경 (~30분)
- [ ] **logrotate 도입** — 현재 14일 만료는 `find -mtime`로 동작하나, 정식 logrotate가 더 robust (선택)

## 🔴 미구현 페이지 (탑 네비에 stub만 있음)

- [ ] **대시보드 (`/dashboard`)** — 전체 시장 요약, KOSPI/KOSDAQ NAV, 주요 지수, 포지션 PnL. 첫 화면이라 ROI 높음
- [ ] **시그널 (`/signals`)** — 베이시스갭 임계 초과 / 거래량 이상 자동 감지
- [ ] **포지션 (`/position`)** — 보유 PnL (KBM 내부망 의존)
- [ ] **수급 (`/supply-demand`)** — 외국인/기관 매매 (Finance_Data 활용 가능)
- [ ] **백테스팅 (`/backtest`)** — 가장 큰 작업

## ⚙️ 인프라/품질

- [ ] **테스트 프레임워크** — Vitest(프론트) + pytest(백엔드) 도입. 현재 0개
- [ ] **내부망 패키지 빌드 자동화** — Finance_Data export 자동 포함하는 zip 빌드 스크립트
- [ ] **이론가 계산 Rust로 이전** — 현재 frontend `stock-arbitrage.tsx`에서 계산. 다른 화면(대시보드 등)에서도 쓰려면 백엔드/Rust로 이동
- [ ] **종목차익 페이지 NetworkToggle 셀렉터 패턴** — 현재 `useMarketStore()` 통째 구독 → 매 tick 재렌더 (rAF 60Hz cap이 있어 실제론 무관하지만 코드 위생)

## 🔍 검증/관찰 (코드 작업 X)

- [ ] **다음 거래일 idle timeout 동작 관찰** — `reconnect_count`가 시간당 ~10 미만 (50+면 timeout 60s로 완화 검토), `feed_state` 정상 fresh 유지하는지
- [ ] **silent 백오프 escalation 동작 관찰** — 진짜 LS 침묵 시 5분 backoff로 전환 로그 (`silent N cycles — LS likely blocking`) 뜨는지
- [ ] **토큰 캐시 검증** — 로그에 `token cache: refreshed` 시작 시 1번만 뜨는지 (재연결 시 재발급 안 함을 확인)
- [ ] **모드 전환 쿨다운 race fix 검증** — 동시 요청 보내봐서 한쪽만 통과하는지

## 📋 사전 존재 perf 최적화 (현 부하에선 불필요, 5-10× 늘면 검토)

- [ ] **per-tick chrono allocation 제거** — `Utc::now().format(...).to_string()` 매 tick 호출. `i64 micros`로 보내고 프론트에서 포맷 (CPU ~1.5ms/sec 절감)
- [ ] **serde_json `Value` 파싱 → struct deserialize** — `tr_cd`별 typed deserialize로 ~5ms/sec CPU 절감
- [ ] **`String clone` → `Arc<str>`** — handle_tick 매 tick alloc. blast radius 큼 (message.rs 3개 struct 변경 필요)

## 추천 흐름

1. **며칠 관찰 모드** — 코드 손 대지 말고 LENS 사용하면서 답답한 점 찾기
2. **다음 거래일 검증** (위 "검증/관찰") 5분
3. 발견된 답답함 + 위 미구현 페이지 중 ROI 높은 것 1개 → 진행

---

세션마다 끝에 이 파일 검토. 필요한 변경/추가는 직접 편집하거나 Claude에게 부탁.
