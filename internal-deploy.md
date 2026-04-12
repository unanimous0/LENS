# 내부망 배포 가이드

회사 내부망(Windows)으로 LENS를 보내고 실행하기 위한 가이드.

## 폴더 구조

```
LENS/
├── internal_sending/          # 내부망 전송용 (gitignore 대상)
│   ├── 실행방법.txt           # 회사에서 따라할 가이드
│   ├── installers/            # 최초 1회만 필요
│   │   ├── node-v20.18.3-x64.msi
│   │   └── python-3.12.9-amd64.exe
│   └── pip_packages/          # 오프라인 pip 설치용 .whl 파일들
└── ... (나머지 LENS 코드)
```

## 압축해서 보내기

### 최초 전송 (전체 포함)

```bash
cd /home/una0/projects
tar -czf LENS_full.tar.gz \
    --exclude='LENS/.git' \
    --exclude='LENS/.env' \
    LENS/
```

- `node_modules/` 포함 (npm install 불필요)
- `internal_sending/` 포함 (설치파일 + pip 패키지)
- **압축 크기**: ~180MB

### 코드 업데이트 전송 (2회차부터)

```bash
cd /home/una0/projects
tar -czf LENS_update.tar.gz \
    --exclude='LENS/.git' \
    --exclude='LENS/.env' \
    --exclude='LENS/internal_sending/installers' \
    --exclude='LENS/internal_sending/pip_packages' \
    LENS/
```

- 설치파일, pip 패키지 제외 → **압축 크기: ~70MB**
- 회사에서 덮어쓰고 바로 실행하면 됨 (1, 2단계 불필요)

## pip 패키지 갱신 (requirements.txt 변경 시에만)

```bash
rm -rf /home/una0/projects/LENS/internal_sending/pip_packages
mkdir -p /home/una0/projects/LENS/internal_sending/pip_packages
pip download -r /home/una0/projects/LENS/backend/requirements.txt \
    -d /home/una0/projects/LENS/internal_sending/pip_packages/
```

## 회사에서 실행

`internal_sending/실행방법.txt` 참고.

요약:
1. 최초: 설치파일 실행 → pip 오프라인 설치
2. 매번: PowerShell 2개 열고 백엔드(8100) + 프론트엔드(3100) 실행
3. 브라우저: http://localhost:3100
