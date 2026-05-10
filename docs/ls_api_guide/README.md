# ls_api_guide

LS증권 OpenAPI 가이드 자동 추출 결과물 보관 폴더.

## 📄 파일

| 파일 | 내용 |
|---|---|
| **`ls_api_full.md`** | LS API 가이드 페이지에 노출된 **모든 TR (365개)** 추출본. trCode/trName/TPS/Request 예시/Response 예시 포함. 작업 시 가장 먼저 grep할 곳 |
| `LS증권 OPEN API - {TR}.pdf` | LS 포털에서 사용자가 별도 다운로드한 공식 PDF (필드 표 포함). 가이드 누락 TR 또는 정확한 InBlock/OutBlock 표가 필요할 때 받음 |
| `_raw/` | 원본 JSON dump (디버그용). `_index.json` = 그룹 list, `meta_*.json` = 그룹 메타, `guide_*.json` = 그룹별 TR list |

## 🛠 사용법 — 작업 전 반드시 grep 우선

```bash
# TR 코드로 호출법 확인
grep -A 50 "^### t1302 " docs/ls_api_guide/ls_api_full.md

# 키워드로 후보 찾기 (예: 분봉 관련)
grep -i "분봉\|분별주가\|N분" docs/ls_api_guide/ls_api_full.md | head -20

# 특정 그룹 전체 보기
awk '/^## \[주식\] 차트/,/^---$/' docs/ls_api_guide/ls_api_full.md
```

## ⚠️ 누락 TR

`ls_api_full.md` 상단 섹션 참조. 25개 TR이 가이드 페이지에 자료 미작성. **다만 거의 전부 deprecated 구 TR이고 신 TR이 같은 그룹에 가이드 노출됨**:

| 누락 (구) | 대체 (신) | 위치 |
|---|---|---|
| t8414 / **t8415** / t8416 (선물 차트) | **t8464 / t8465 / t8466** | `[선물/옵션] 차트` 그룹 |
| t8410 / t8411 / t8412 (주식 차트) — 가이드엔 노출됨 | t8451 / t8452 / t8453 (통합 API용) | `[주식] 차트` 그룹 |
| t2101 / t2105 / t2201 / t2203 등 (선물 시세 구) | t2111 / t2112 / t2212 / t2214 등 (신) | `[선물/옵션] 시세` 그룹 |
| ELW WebSocket / FC0 / FH0 / FX0 / YFC 일부 | (대체 못 찾으면) PDF 별도 | — |

→ **신 TR로 대체 가능한 경우는 PDF 다운로드 불필요**. `ls_api_full.md` grep으로 신 TR의 reqExample/resExample 확인 후 사용.

진짜 가이드에서도 못 찾는 TR만:
1. LS 개발자 포털 (https://openapi.ls-sec.co.kr) 로그인
2. API 가이드에서 해당 TR 페이지 방문
3. PDF 다운로드해서 이 폴더에 `LS증권 OPEN API - {TR}.pdf` 형식으로 저장

## 🔄 정기 갱신

`ls_api_full.md`는 LS 측이 신규 TR 추가하거나 기존 TR 변경하면 stale해짐. 갱신 방법:

```bash
cd /home/una0/projects/LENS
source .venv-scraper/bin/activate
python3 scripts/scrape_ls_api_guide.py
```

소요 시간: **약 2~3분**. 결과는 같은 위치(`ls_api_full.md`)에 덮어쓰기.

권장 갱신 주기:
- **월 1회 수동 실행** (개발 시작 전 최신화)
- 또는 LS API 활용 작업 직전 1회
- LS 측 변경 빈도 낮음 — 자동 cron까진 불필요

## 📦 환경 — Playwright venv

이 폴더만 위해 만든 Python venv (`.venv-scraper`)에 playwright + beautifulsoup4 + requests 설치됨. 다른 프로젝트와 무관.

```bash
ls -la /home/una0/projects/LENS/.venv-scraper/  # 확인
```

재설치 필요 시:
```bash
python3 -m venv .venv-scraper
source .venv-scraper/bin/activate
pip install playwright beautifulsoup4 requests
playwright install chromium
```
