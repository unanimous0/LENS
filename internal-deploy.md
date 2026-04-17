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

## 회사에서 실행

`internal_sending/실행방법.txt` 참고.

요약:
1. 최초: 설치파일 실행 → pip 오프라인 설치
2. 매번: PowerShell 2개 열고 백엔드(8100) + 프론트엔드(3100) 실행
3. 브라우저: http://localhost:3100
