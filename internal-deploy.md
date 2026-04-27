# 내부망 배포 가이드

회사 내부망(Windows)으로 LENS를 보내고 실행하기 위한 가이드.

## 폴더 구조

```
LENS/
├── internal_sending/          # 내부망 전송용 (gitignore 대상)
│   ├── 실행방법.txt           # 회사에서 따라할 가이드
│   ├── installers/            # 최초 1회만 필요
│   │   ├── node-v20.20.2-x64.msi
│   │   ├── python-3.12.9-amd64.exe
│   │   └── rust-1.94.1-x86_64-pc-windows-msvc.msi
│   └── pip_packages/          # Windows Python 3.13용 오프라인 pip 패키지
├── realtime/vendor/           # Rust 오프라인 의존성 (cargo vendor)
├── realtime/.cargo/config.toml  # vendor 디렉토리 참조 설정
├── frontend/public/fonts/     # 로컬 폰트 (Pretendard, JetBrains Mono)
├── backend/requirements-win.txt  # Windows용 requirements (uvloop 제외)
└── ...
```

## 압축해서 보내기

### 최초 전송 (전체 포함, 50MB 분할)

```bash
cd /home/una0/projects
zip -r -s 50m LENS_full.zip LENS/ -x "LENS/.git/*" "LENS/.env" "LENS/data/상환대여가능확인 파일모음/*"
```

- `node_modules/` 포함 (npm install 불필요)
- `internal_sending/` 포함 (설치파일 + pip 패키지)
- `frontend/public/fonts/` 포함 (오프라인 폰트)
- 회사에서 반디집으로 `LENS_full.zip` 열면 자동 합쳐져서 풀림

### 코드 업데이트 전송 (2회차부터)

```bash
cd /home/una0/projects
zip -r -s 50m LENS_update.zip LENS/ -x "LENS/.git/*" "LENS/.env" "LENS/internal_sending/installers/*" "LENS/internal_sending/pip_packages/*" "LENS/frontend/node_modules/*" "LENS/realtime/target/*" "LENS/data/상환대여가능확인 파일모음/*"
```

- 설치파일, pip 패키지, node_modules, Rust 빌드 캐시 제외 → 더 가벼움
- `realtime/vendor/`는 **포함** (오프라인 Rust 의존성, Cargo.toml 변경 시 재벤더링 필요)
- **주의**: 회사의 node_modules는 Windows용이므로 덮어쓰면 안 됨
- 회사에서 LENS 폴더에 덮어쓰고 3단계(실행)부터 하면 됨

### 이전 압축 파일 정리

```bash
rm -f /home/una0/projects/LENS_full.z* /home/una0/projects/LENS_full.zip
rm -f /home/una0/projects/LENS_update.z* /home/una0/projects/LENS_update.zip
```

### TODO: 빌드 자동화 스크립트

현재는 매번 수동 zip 명령. 다음 개선 가능:
- [ ] `scripts/build_internal_package.sh` — `LENS_update.zip` 자동 생성 (제외 패턴 한 곳에 정의)
- [ ] Finance_Data 측 `dividends.json` export 자동 포함 (외부망에서 빌드 시점 기준 최신본 복사)
- [ ] 빌드 결과에 자동 버전 stamp (git rev + 빌드 일시)

## pip 패키지 갱신 (requirements-win.txt 변경 시에만)

```bash
rm -rf /home/una0/projects/LENS/internal_sending/pip_packages
mkdir -p /home/una0/projects/LENS/internal_sending/pip_packages
pip download -r /home/una0/projects/LENS/backend/requirements-win.txt \
    -d /home/una0/projects/LENS/internal_sending/pip_packages/ \
    --platform win_amd64 --python-version 3.13 --only-binary=:all:
```

## Rust 의존성 갱신 (Cargo.toml 변경 시에만)

```bash
cd /home/una0/projects/LENS/realtime
cargo vendor
```

`realtime/vendor/` 디렉토리가 갱신됨. `realtime/.cargo/config.toml`이 이미 vendor를 참조하도록 설정되어 있으므로 별도 작업 불필요.

## VS Code 확장 설치 (선택, 최초 1회)

Rust 개발 시 유용한 VS Code 확장. `internal_sending/vscode_extensions/`에 `.vsix` 파일로 포함.

| 파일 | 확장 | 용도 |
|------|------|------|
| `rust-analyzer.vsix` | rust-analyzer | 자동완성, 타입추론, 인라인 에러 표시 (필수) |
| `even-better-toml.vsix` | Even Better TOML | Cargo.toml 문법 하이라이팅 |

파일 위치: `internal_sending/installers/vscode_extensions/`

설치 방법:
1. VS Code → `Ctrl+Shift+X` (Extensions 패널)
2. 패널 상단 `...` → **Install from VSIX...**
3. `.vsix` 파일 선택 → 설치 → VS Code 재시작

## 회사에서 실행

`internal_sending/실행방법.txt` 참고.

요약:
1. 최초: 설치파일 실행 (Node.js, Python, Rust) → pip 오프라인 설치 → VS Code 확장 설치
2. 매번: PowerShell 3개 열고 Rust 실시간(8200) + 백엔드(8100) + 프론트엔드(3100) 실행
3. 브라우저: http://localhost:3100

### Rust 실시간 서비스 실행

```powershell
cd "C:\...\LENS\realtime"
$env:FEED_MODE="internal"
$env:INTERNAL_SUBSCRIPTIONS="A005930,A069500,KA1165000"
cargo run --release
```

- 첫 빌드 시 컴파일에 수 분 소요 (vendor에서 읽으므로 인터넷 불필요), 2회차부터는 빠름
- `"Internal server connected"` + `"Internal subscribed"` 로그 뜨면 정상
- 장중(09:00~15:30)에만 틱 데이터 수신됨

디버그 로그로 틱 데이터 확인:
```powershell
$env:RUST_LOG="lens_realtime=debug"
cargo run --release
```
