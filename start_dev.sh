#!/bin/bash

# LENS 개발 서버 실행 스크립트
# 사용법: ./start_dev.sh
# 접속: ssh -L 3100:localhost:3100 -L 8100:localhost:8100 -L 8200:localhost:8200 una0@100.64.229.73
#       브라우저에서 http://localhost:3100

cd "$(dirname "$0")"

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

# 백엔드 실행 (백그라운드)
echo "[백엔드] 시작 (포트 8100)..."
cd backend
uvicorn main:app --host 0.0.0.0 --port 8100 --reload &
BACKEND_PID=$!
cd ..

# Rust 실시간 서비스: 먼저 blocking으로 빌드 후 바이너리 실행
echo "[실시간] Rust 서비스 빌드..."
cd realtime
cargo build --release --quiet
echo "[실시간] Rust 서비스 시작 (포트 8200)..."
./target/release/lens-realtime &
REALTIME_PID=$!
cd ..

# Rust /health 응답 대기 (최대 10초) — 프론트 첫 fetch 실패 방지
for i in $(seq 1 20); do
    if curl -sf http://localhost:8200/health >/dev/null 2>&1; then
        echo "[실시간] 준비됨"
        break
    fi
    sleep 0.5
done

# 프론트엔드 dev 모드 실행
echo "[프론트엔드] dev 모드 시작 (포트 3100)..."
cd frontend
npx vite --host 0.0.0.0 --port 3100 &
FRONTEND_PID=$!
cd ..

echo ""
echo "LENS 개발 서버 실행 완료"
echo "   프론트엔드: http://localhost:3100"
echo "   백엔드 API: http://localhost:8100"
echo "   실시간 WS:  http://localhost:8200"
echo ""
echo "종료: Ctrl+C"

trap "kill $BACKEND_PID $REALTIME_PID $FRONTEND_PID 2>/dev/null; exit" INT TERM
wait
