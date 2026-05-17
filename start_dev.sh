#!/bin/bash

# LENS 개발 서버 실행 스크립트
# 사용법: ./start_dev.sh
# 접속: ssh -L 3100:localhost:3100 -L 8100:localhost:8100 -L 8200:localhost:8200 -L 8300:localhost:8300 una0@100.64.229.73
#       브라우저에서 http://localhost:3100

cd "$(dirname "$0")"

# 각 백그라운드 작업을 별도 프로세스 그룹으로 — 종료 시 손자까지 모두 정리
set -m

# 로그 디렉토리 + 자동 만료 (14일).
# tee로 stdout/stderr를 터미널과 파일에 동시 기록.
# 같은 날 여러 번 재시작하면 같은 파일에 append됨.
mkdir -p logs
LOG_DAY=$(date +%Y%m%d)
find logs/ -name "*.log*" -mtime +14 -delete 2>/dev/null
echo "[로그] logs/{backend,realtime,statarb}.log.${LOG_DAY} 에 기록 (14일 후 자동 삭제)"

# Node.js 버전 설정
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use --delete-prefix v20.20.2

# Rust 환경
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"

# FEED_MODE 자동 감지 (환경변수로 명시하면 그대로 사용)
#   1. 내부망 WS 서버(10.21.1.208:41001) TCP 도달 가능 → internal
#   2. .env에 LS_APP_KEY 존재 → ls_api (외부망)
#   3. 그 외 → mock
INTERNAL_HOST="${INTERNAL_WS_HOST:-10.21.1.208}"
INTERNAL_PORT="${INTERNAL_WS_PORT:-41001}"
if [ -z "$FEED_MODE" ]; then
    if timeout 1 bash -c "</dev/tcp/${INTERNAL_HOST}/${INTERNAL_PORT}" 2>/dev/null; then
        export FEED_MODE=internal
        echo "[자동감지] 내부망 접근 가능 (${INTERNAL_HOST}:${INTERNAL_PORT}) → FEED_MODE=internal"
    elif grep -q '^LS_APP_KEY=.\+' .env 2>/dev/null; then
        export FEED_MODE=ls_api
        echo "[자동감지] 외부망 키 존재 (.env) → FEED_MODE=ls_api"
    else
        export FEED_MODE=mock
        echo "[자동감지] 모드 미특정 → FEED_MODE=mock"
    fi
else
    echo "[수동지정] FEED_MODE=$FEED_MODE"
fi

# 백엔드 실행 (subshell로 감싸서 프로세스 그룹 리더 확보)
echo "[백엔드] 시작 (포트 8100)..."
(cd backend && uvicorn main:app --host 0.0.0.0 --port 8100 --reload 2>&1 | tee -a "../logs/backend.log.${LOG_DAY}") &
BACKEND_PID=$!

# Rust 실시간 서비스: 먼저 blocking으로 빌드 후 바이너리 실행
# 빌드 출력 (warning 다수)은 별도 로그로 — 화면엔 progress만. 실패 시만 마지막 줄 표시.
echo "[실시간] Rust 서비스 빌드... (warning은 logs/realtime-build.log)"
if ! (cd realtime && cargo build --release > "../logs/realtime-build.log.${LOG_DAY}" 2>&1); then
    echo "[실시간] ❌ 빌드 실패 — 마지막 줄:"
    tail -20 "logs/realtime-build.log.${LOG_DAY}"
    exit 1
fi

# backend(8100) 준비 대기 — realtime startup의 fetch
#   (LP matrix-config / risk-params / ETF PDF 구독 union: load_etf_pdf_extra_codes /
#    positions active-leg-codes polling) 가 backend 미가동 시 0으로 떨어지는 것 방지.
# cargo build 캐시되면 realtime이 uvicorn startup보다 빨라 이 가드 없으면 LP 매트릭스가
# 빈 상태로 뜨고 Tier 1 permanent sub 회복도 누락. (최대 30초)
echo "[실시간] backend(8100) 준비 대기..."
for i in $(seq 1 60); do
    if curl -sf http://localhost:8100/api/health >/dev/null 2>&1; then
        echo "[실시간] backend 준비됨"
        break
    fi
    sleep 0.5
done
echo "[실시간] Rust 서비스 시작 (포트 8200)..."
(cd realtime && ./target/release/lens-realtime 2>&1 | tee -a "../logs/realtime.log.${LOG_DAY}") &
REALTIME_PID=$!

# Rust /health 응답 대기 (최대 10초) — 프론트 첫 fetch 실패 방지
for i in $(seq 1 20); do
    if curl -sf http://localhost:8200/health >/dev/null 2>&1; then
        echo "[실시간] 준비됨"
        break
    fi
    sleep 0.5
done

# 통계 차익 엔진: 빌드 후 실행 (선택 — 디렉토리 없으면 스킵)
if [ -d stat-arb-engine ]; then
    echo "[stat-arb] 통계 엔진 빌드... (warning은 logs/statarb-build.log)"
    if ! (cd stat-arb-engine && cargo build --release > "../logs/statarb-build.log.${LOG_DAY}" 2>&1); then
        echo "[stat-arb] ❌ 빌드 실패 — 마지막 줄:"
        tail -20 "logs/statarb-build.log.${LOG_DAY}"
        exit 1
    fi
    echo "[stat-arb] 시작 (포트 8300, 워밍업 약 3분)..."
    (cd stat-arb-engine && ./target/release/stat-arb-engine 2>&1 | tee -a "../logs/statarb.log.${LOG_DAY}") &
    STATARB_PID=$!
    for i in $(seq 1 20); do
        if curl -sf http://localhost:8300/health >/dev/null 2>&1; then
            echo "[stat-arb] 준비됨 (워밍업은 백그라운드 계속)"
            break
        fi
        sleep 0.5
    done
fi

# 프론트엔드 dev 모드 실행 — clearScreen=false 로 vite가 터미널을 비워 status가 가려지지 않게 함
echo "[프론트엔드] dev 모드 시작 (포트 3100)..."
(cd frontend && npx vite --host 0.0.0.0 --port 3100 --clearScreen false) &
FRONTEND_PID=$!

echo ""
echo "LENS 개발 서버 실행 완료"
echo "   프론트엔드: http://localhost:3100"
echo "   백엔드 API: http://localhost:8100"
echo "   실시간 WS:  http://localhost:8200"
[ -n "$STATARB_PID" ] && echo "   stat-arb:   http://localhost:8300"

# 초기 fetch (t1102/t8402)는 ~10초 소요. 잠시 기다린 뒤 상태 요약 출력.
print_status() {
    local LOG_DAY=$(date +%Y%m%d)
    local RT_LOG="logs/realtime.log.$LOG_DAY"
    local BE_LOG="logs/backend.log.$LOG_DAY"
    local G="\033[32m" R="\033[31m" Y="\033[33m" B="\033[36m" D="\033[2m" N="\033[0m"

    chk() { ss -tlnp 2>/dev/null | grep -q ":$1 " && echo -e "${G}UP${N}" || echo -e "${R}DOWN${N}"; }

    echo
    echo "------ LENS 상태 요약 -----------------------------"
    printf "  %-22s %b\n" "Frontend  (3100)" "$(chk 3100)"
    printf "  %-22s %b\n" "Backend   (8100)" "$(chk 8100)"
    printf "  %-22s %b\n" "Realtime  (8200)" "$(chk 8200)"
    if [ -d stat-arb-engine ]; then
        printf "  %-22s %b\n" "Stat-arb  (8300)" "$(chk 8300)"
    fi
    echo

    local mode="unknown"
    [ -f "$RT_LOG" ] && mode=$(grep "Initial feed mode" "$RT_LOG" 2>/dev/null | tail -1 | grep -oE "(ls_api|mock|internal)")
    local mode_s
    case "$mode" in
        ls_api)   mode_s="${B}ls_api${N} (외부망 LS증권 API)" ;;
        internal) mode_s="${B}internal${N} (내부망 사내 서버)" ;;
        mock)     mode_s="${Y}mock${N} (가짜 데이터, 시장 시간 무관)" ;;
        *)        mode_s="${D}$mode${N}" ;;
    esac
    printf "  %-22s %b\n" "피드 모드:" "$mode_s"

    if [ -f "$RT_LOG" ]; then
        local fetch_line=$(grep "Initial price fetch done" "$RT_LOG" 2>/dev/null | tail -1)
        if [ -n "$fetch_line" ]; then
            local result=$(echo "$fetch_line" | grep -oE "[0-9]+ futures \+ [0-9]+ stocks")
            printf "  %-22s %s\n" "초기 가격 fetch:" "$result 수신"
        else
            printf "  %-22s %b\n" "초기 가격 fetch:" "${Y}진행 중...${N}"
        fi
        local t1102=$(grep "t1102 failures" "$RT_LOG" 2>/dev/null | tail -1 | sed -E 's/.*t1102 failures: //')
        [ -n "$t1102" ] && printf "  %-22s %s\n" "최근 t1102:" "$t1102"
        local t8402=$(grep "t8402 failures" "$RT_LOG" 2>/dev/null | tail -1 | sed -E 's/.*t8402 failures: //')
        [ -n "$t8402" ] && printf "  %-22s %s\n" "최근 t8402:" "$t8402"
        local conn_n=$(grep -c "WebSocket client connected" "$RT_LOG" 2>/dev/null)
        local disc_n=$(grep -c "WebSocket client disconnected" "$RT_LOG" 2>/dev/null)
        local active=$((conn_n - disc_n)); [ $active -lt 0 ] && active=0
        printf "  %-22s %s\n" "WS 클라이언트:" "$active 활성 (누적 접속 $conn_n)"
    fi

    [ -f "$BE_LOG" ] && printf "  %-22s %s\n" "Backend API 호출:" "$(grep -cE 'GET /api/' "$BE_LOG" 2>/dev/null)"

    local hour=$(date +%H | sed 's/^0//'); [ -z "$hour" ] && hour=0
    local mins=$(date +%M | sed 's/^0//'); [ -z "$mins" ] && mins=0
    local total_min=$((hour * 60 + mins))
    local dow=$(date +%u)
    local market
    if [ "$dow" -ge 6 ]; then
        market="${D}주말 (시장 휴무)${N}"
    elif [ $total_min -lt 540 ]; then
        market="${Y}개장 전 ($((540 - total_min))분 후 09:00 개장)${N}"
    elif [ $total_min -gt 930 ]; then
        market="${D}장 마감 (15:30 종료)${N}"
    else
        market="${G}개장 중${N}"
    fi
    printf "  %-22s %b\n" "KRX 시장:" "$market"

    if [ "$mode" = "ls_api" ] && [ "$dow" -lt 6 ] && [ $total_min -lt 540 ]; then
        echo
        echo -e "  ${D}* 장 외엔 LS API가 종목 대다수에 no_data — FEED_MODE=mock 으로 재기동시 미리 보기 가능.${N}"
    fi
    echo "---------------------------------------------------"
    echo "  종료: Ctrl+C"
    echo
}

# 12초 후 요약 출력. 화면 + /tmp/lens-status.log 둘 다 기록 (vite 출력에 가려도 cat으로 재확인 가능).
( sleep 12; print_status | tee /tmp/lens-status.log ) &

cleanup() {
    echo ""
    echo "[종료] 모든 프로세스 정리 중..."
    # 프로세스 그룹 단위 SIGTERM — subshell + set -m 덕에 각 &는 별도 PGID
    for pid in "$BACKEND_PID" "$REALTIME_PID" "$STATARB_PID" "$FRONTEND_PID"; do
        [ -n "$pid" ] && kill -TERM -- "-$pid" 2>/dev/null
    done
    sleep 1
    # 잔존 프로세스 백업 정리 (포트 기반)
    fuser -k 3100/tcp 8100/tcp 8200/tcp 8300/tcp 2>/dev/null
    exit 0
}
trap cleanup INT TERM
wait
