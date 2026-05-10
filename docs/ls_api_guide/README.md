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

`ls_api_full.md` 상단 섹션 참조. 25개 TR이 가이드 페이지에 자료 미작성. **다만 거의 전부 deprecated 구 TR이고 신 TR이 같은 그룹에 가이드 노출됨**.

### 🚨 LS 공식 공지 — 2026-05-28 선물옵션 TR deprecate

LS 측 2026-04-24 ~ 2026-05-28 신/구 TR 병행. **5/28 이후 구 TR 데이터 제공 중단**. 가격 필드 자릿수 확대가 변경 사유 (InBlock/타 필드 동일).

| 구 TR | 신 TR | TR명 |
|---|---|---|
| t2101 | **t2111** | 선물/옵션 현재가(시세) |
| t2105 | **t2112** | 선물/옵션 호가조회 |
| t2201 | **t2212** | 선물/옵션 시간대별 체결 |
| t2203 | **t2214** | 선물/옵션 기간별 주가 |
| t2209 | **t2216** | 선물/옵션 틱분별 체결차트 |
| t2405 | **t2407** | 선물/옵션 호가잔량 비율 |
| t2421 | **t2424** | 선물/옵션 미결제약정 추이 |
| t8414 | **t8464** | 선물옵션차트(틱/n틱) |
| t8415 | **t8465** | 선물/옵션챠트(N분) |
| t8416 | **t8466** | 선물/옵션챠트(일주월) |
| t8432 | **t8467** | 지수선물마스터조회API용 |
| FC0 | **FC9** | KOSPI200선물체결 (Real) |
| FH0 | **FH9** | KOSPI200선물호가 (Real) |
| FX0 | **FX9** | KOSPI200선물가격제한폭확대 (Real) |
| YFC | **YF9** | 지수선물예상체결 (Real) |

신규 추가: **t2522** (주식선물기초자산조회). 별도: t1901~t1904는 2026-05-19부터 nav 필드 자릿수만 12.2로 확대 (TR 코드 그대로).

### 그 외 신/구 매핑 (공지 외, 가이드 페이지 변경)

| 누락 (구) | 대체 (신) | 위치 |
|---|---|---|
| t8410 / t8411 / t8412 (주식 차트) — 가이드엔 노출됨 | t8451 / t8452 / t8453 (통합 API용) | `[주식] 차트` 그룹 |
| **t4201 / t8413** (주식 차트) — 가이드 페이지 미노출 | t8451 / t8452 / t8453 (통합 API용)로 흡수 추정 | `[주식] 차트` 그룹 |
| ELW WebSocket TR 일부 (Ys3_4ELW 등) | (대체 못 찾으면) PDF 별도 | `[주식] 실시간 시세` 그룹 |

→ **신 TR로 대체 가능한 경우는 PDF 다운로드 불필요**. `ls_api_full.md` grep으로 신 TR의 reqExample/resExample 확인 후 사용.

> ⚠️ **판단 기준은 "가이드 페이지 노출 여부"** (`_raw/guide_*.json`에 TR 항목 존재). `_raw/meta_*.json`의 `extraParam`(게이트웨이 TPS 정책)에 등록되어 있다고 ACTIVE TR로 착각하지 말 것. extraParam은 deprecated 처리 후에도 한참 남아있다.

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
