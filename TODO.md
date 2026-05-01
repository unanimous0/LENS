# LENS 남은 작업

도메인이 분명한 항목은 각 도메인 MD에 있음 (`realtime-service.md`, `stock-arbitrage.md`, `internal-deploy.md`, ...). 이 파일은 **홈이 없는 횡단 항목** + **다음 세션 진입점** 역할.

## 🔴 미구현 페이지 (탑 네비에 stub만)

- [ ] **대시보드 (`/dashboard`)** — 전체 시장 요약, KOSPI/KOSDAQ NAV, 주요 지수, 포지션 PnL. 첫 화면이라 ROI 높음
- [ ] **시그널 (`/signals`)** — 베이시스갭 임계 초과 / 거래량 이상 자동 감지
- [ ] **포지션 (`/position`)** — 보유 PnL (KBM 내부망 의존)
- [ ] **수급 (`/supply-demand`)** — 외국인/기관 매매 (Finance_Data 활용 가능)
- [ ] **백테스팅 (`/backtest`)** — 가장 큰 작업

## ⚙️ 인프라/품질 (홈 없는 글로벌 항목)

- [ ] **테스트 프레임워크 도입** — Vitest(프론트) + pytest(백엔드). 현재 0개
- [ ] **logrotate 도입** — 현재 14일 만료는 `find -mtime`로 동작하나, 정식 logrotate가 더 robust (선택)
- [ ] **NetworkToggle 셀렉터 패턴** — 현재 `useMarketStore()` 통째 구독 → 매 tick 재렌더 (rAF 60Hz cap이 있어 실제 영향 미미하지만 코드 위생)

## 📂 도메인 MD에서 관리 (포인터만)

- 종목차익 페이지 작업 → [`stock-arbitrage.md`](stock-arbitrage.md) Phase B/C/D/E
- 실시간 서비스 최적화 / Phase 4+ → [`realtime-service.md`](realtime-service.md)
- 내부망 배포 빌드 자동화 → [`internal-deploy.md`](internal-deploy.md) "빌드 자동화 스크립트" 섹션
- 배당 페이지 → [`features.md`](features.md) 배당 섹션 (재구성 완료, 추정 레이어 + 우측 패널 + 가상화)

## 💤 향후 처리 (deferred)

- **추정 로직 이상치 처리** — 특별배당 (이지홀딩스 23.8% 등) 자동 감지해 추정 제외. 종목별 (code, period) 중앙값 대비 N배 이상이면 skip. 사용 중 이상 발견되면 재평가

---

## 추천 흐름

1. **며칠 관찰 모드** — 코드 손 안 대고 LENS 사용하면서 답답한 점 찾기
2. 발견된 답답함 + 위 미구현 페이지 중 ROI 높은 것 1개 → 진행

세션마다 끝에 이 파일 검토. 항목 끝나면 줄 자체를 삭제.
