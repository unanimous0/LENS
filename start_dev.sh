#!/bin/bash

# LENS 개발 서버 실행 스크립트
# 사용법: ./start_dev.sh
# 접속: ssh -L 3100:localhost:3100 -L 8100:localhost:8100 una0@100.64.229.73
#       브라우저에서 http://localhost:3100

cd "$(dirname "$0")"

# Node.js 버전 설정
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use --delete-prefix v20.20.2

# 백엔드 실행 (백그라운드)
echo "[백엔드] 시작 (포트 8100)..."
cd backend
uvicorn main:app --host 0.0.0.0 --port 8100 --reload &
BACKEND_PID=$!
cd ..

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
echo ""
echo "종료: Ctrl+C"

trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit" INT TERM
wait
