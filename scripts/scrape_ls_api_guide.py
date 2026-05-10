"""LS증권 OpenAPI 가이드 전체 추출 → Markdown 단일 파일.

전략:
1. Playwright로 /apiservice 한 번 접속, 모든 카테고리 dropdown 펼쳐 사이드바 HTML 확보
2. onclick="goLeftMenuUrl('GROUP_ID', 'API_ID')" 패턴 정규식으로 모든 (category, group, api, name) 추출
3. requests로 두 JSON endpoint 호출:
   - GET /api/apis/public/{api_id}      (메타: TR 코드, 이름, 설명, URL, TPS, body)
   - GET /api/apis/guide/tr/{api_id}    (가이드: 요청 헤더/Body, 응답 필드, 예시)
4. JSON → Markdown 변환, 단일 파일에 누적 저장

산출: docs/ls_api_guide/ls_api_full.md
"""
import re
import json
import time
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright
import requests

BASE_URL = "https://openapi.ls-sec.co.kr"
START_URL = f"{BASE_URL}/apiservice"
OUT_DIR = Path(__file__).parent.parent / "docs" / "ls_api_guide"
OUT_FILE = OUT_DIR / "ls_api_full.md"
OUT_RAW_DIR = OUT_DIR / "_raw"  # 디버그용 — 원본 JSON 보존
OUT_RAW_DIR.mkdir(parents=True, exist_ok=True)

# UA — 봇 차단 방지 (LS 가이드는 공개라 보통 무관)
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"


def harvest_sidebar() -> list[dict]:
    """Playwright로 사이드바 펼치고 모든 (group_id, api_id, name, category) 수집."""
    items: list[dict] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(user_agent=UA)
        page = context.new_page()
        page.goto(START_URL, wait_until="networkidle", timeout=60000)
        page.wait_for_timeout(2000)

        # 모든 second-depth 카테고리(주식, 선물/옵션 등) 펼치기
        # 'a'로 감싸있는 카테고리 헤더 클릭하면 third-depth 펼침. 단 'on' class면 이미 펼쳐진 상태.
        # 안전하게: 'second-depth > li > a' 모두 click 시도.
        category_count = page.locator("ul.second-depth > li > a").count()
        print(f"  카테고리 헤더 {category_count}개 발견")
        for i in range(category_count):
            try:
                page.locator("ul.second-depth > li > a").nth(i).click(timeout=3000)
                page.wait_for_timeout(150)
            except Exception:
                pass

        # 모든 onclick 수집
        html = page.content()
        browser.close()

    # 패턴: onclick="goLeftMenuUrl('GROUP', 'API')" 또는 &quot; 형식
    # 텍스트는 같은 a 태그 내부. 카테고리는 second-depth 부모 a의 텍스트.
    # 단순 파싱: 정규식 + DOM 보강을 위해 BeautifulSoup
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(html, "html.parser")

    # 각 second-depth li (카테고리) 순회
    for cat_li in soup.select("ul.second-depth > li"):
        cat_name_tag = cat_li.find("a", recursive=False)
        category = cat_name_tag.get_text(strip=True) if cat_name_tag else "?"
        # third-depth 안의 모든 li (sub-카테고리)
        for sub_li in cat_li.select("ul.third-depth > li"):
            sub_a = sub_li.find("a", recursive=False)
            sub_name = sub_a.get_text(strip=True) if sub_a else "?"
            # fourth-depth 안의 a들 = 실제 TR 항목
            for tr_a in sub_li.select("ul.fourth-depth a"):
                onclick = tr_a.get("onclick") or ""
                m = re.search(r"goLeftMenuUrl\(['\"]([\w-]+)['\"]\s*,\s*['\"]([\w-]+)['\"]", onclick)
                if not m:
                    continue
                items.append({
                    "category": category,
                    "subcategory": sub_name,
                    "name": tr_a.get_text(strip=True),
                    "group_id": m.group(1),
                    "api_id": m.group(2),
                })
            # 또는 third-depth에 직접 onclick이 박힌 경우 (서브 카테고리 없이 바로 TR)
            sub_onclick = sub_a.get("onclick") if sub_a else ""
            m = re.search(r"goLeftMenuUrl\(['\"]([\w-]+)['\"]\s*,\s*['\"]([\w-]+)['\"]", sub_onclick or "")
            if m:
                items.append({
                    "category": category,
                    "subcategory": "",
                    "name": sub_name,
                    "group_id": m.group(1),
                    "api_id": m.group(2),
                })

    # 중복 제거 (api_id 기준)
    seen = set()
    uniq = []
    for it in items:
        if it["api_id"] in seen:
            continue
        seen.add(it["api_id"])
        uniq.append(it)
    return uniq


def fetch_api_meta(api_id: str) -> dict | None:
    url = f"{BASE_URL}/api/apis/public/{api_id}"
    try:
        r = requests.get(url, headers={"User-Agent": UA}, timeout=15)
        r.raise_for_status()
        return r.json()
    except Exception as e:
        print(f"  meta fetch fail {api_id}: {e}")
        return None


def fetch_api_guide(api_id: str) -> dict | None:
    url = f"{BASE_URL}/api/apis/guide/tr/{api_id}"
    try:
        r = requests.get(url, headers={"User-Agent": UA}, timeout=15)
        r.raise_for_status()
        return r.json()
    except Exception as e:
        print(f"  guide fetch fail {api_id}: {e}")
        return None


def render_tr(tr: dict) -> str:
    """단일 TR (guide list의 한 element) → Markdown."""
    md = []
    code = tr.get("trCode", "?")
    name = tr.get("trName", "?")
    tps = tr.get("transactionPerSec", "?")
    md.append(f"### {code} — {name}")
    md.append(f"- TPS: {tps}")
    req = tr.get("reqExample", "")
    res = tr.get("resExample", "")
    if req:
        md.append("\n**Request 예시**")
        md.append(f"```json\n{req.strip()}\n```")
    if res:
        md.append("\n**Response 예시**")
        md.append(f"```json\n{res.strip()}\n```")
    md.append("")
    return "\n".join(md)


def render_group_markdown(item: dict, meta: dict | None, guide: list | None) -> str:
    md = []
    title = item["name"] or "?"
    md.append(f"## {title}\n")

    # group 메타
    if meta:
        for k, label in [("name", "그룹명"), ("description", "설명"),
                         ("accessUrl", "URL path"), ("httpMethod", "Method"),
                         ("reqFormat", "Format"), ("contentType", "Content-Type"),
                         ("domain", "Domain")]:
            if meta.get(k):
                md.append(f"- **{label}**: {meta[k]}")
        # extraParam에서 TR별 TPS 정책 파싱
        ep = meta.get("extraParam") or ""
        if ep and "ThroughputQuotaRule" in ep:
            try:
                ep_json = json.loads(ep)
                rules = ep_json.get("ThroughputQuotaRule", [])
                if rules:
                    md.append(f"- **TR별 TPS (개인)**: " +
                              ", ".join(f"{r.get('tr_cd')}={r.get('requestLimit')}" for r in rules))
            except Exception:
                pass
        md.append("")

    md.append(f"- **api_id**: `{item['api_id']}` / **group_id**: `{item['group_id']}`")
    md.append("")

    # guide list — 그 그룹 안의 모든 TR
    if guide and isinstance(guide, list):
        md.append(f"**소속 TR {len(guide)}개**\n")
        for tr in guide:
            md.append(render_tr(tr))
    elif guide:
        md.append(f"```json\n{json.dumps(guide, ensure_ascii=False, indent=2)[:3000]}\n```\n")

    md.append("\n---\n")
    return "\n".join(md)


def audit_missing_trs(items: list[dict], enriched: list[tuple]) -> list[tuple[str, list[str]]]:
    """meta extraParam의 정책 정의 TR list와 guide list 비교 → 차이(누락) 식별.
    LS 가이드 페이지 자체가 자료 안 채워둔 TR들. PDF로만 받을 수 있음.
    """
    missing_by_group: list[tuple[str, list[str]]] = []
    for it, meta, guide in enriched:
        if not meta:
            continue
        ep = meta.get("extraParam") or ""
        try:
            ep_json = json.loads(ep) if ep else {}
            tr_cd = ep_json.get("tr_cd") or ""
            policy_trs = [t.strip() for t in tr_cd.split("|") if t.strip()]
        except Exception:
            policy_trs = []
        guide_trs: list[str] = []
        if isinstance(guide, list):
            guide_trs = [t.get("trCode") for t in guide if t.get("trCode")]
        missing = sorted(set(policy_trs) - set(guide_trs))
        if missing:
            missing_by_group.append((it["name"], missing))
    return missing_by_group


def main():
    print("=== Step 1: 사이드바에서 TR 목록 수집 ===")
    items = harvest_sidebar()
    print(f"  총 {len(items)}개 TR 수집")
    if not items:
        print("  ❌ 빈 결과 — 사이드바 selector 재점검 필요")
        sys.exit(1)

    # 카테고리별 카운트
    from collections import Counter
    cats = Counter(it["category"] for it in items)
    print(f"  카테고리 분포: {dict(cats)}")

    # 디버그용 list 저장
    (OUT_RAW_DIR / "_index.json").write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\n=== Step 2: 각 TR JSON 두 개씩 fetch (총 {2*len(items)}회) ===")
    enriched = []
    for i, it in enumerate(items, 1):
        meta = fetch_api_meta(it["api_id"])
        guide = fetch_api_guide(it["api_id"])
        # 원본 JSON 보존
        if meta:
            (OUT_RAW_DIR / f"meta_{it['api_id']}.json").write_text(
                json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
            )
        if guide:
            (OUT_RAW_DIR / f"guide_{it['api_id']}.json").write_text(
                json.dumps(guide, ensure_ascii=False, indent=2), encoding="utf-8"
            )
        enriched.append((it, meta, guide))
        if i % 20 == 0 or i == len(items):
            print(f"  [{i}/{len(items)}] {it['category']} > {it['name']}")
        time.sleep(0.05)  # 부드럽게

    print(f"\n=== Step 3: Markdown 생성 ===")

    # 누락 TR 식별 — LS 가이드 페이지 자체에 자료 없음. PDF로만 받기 가능.
    missing_groups = audit_missing_trs(items, enriched)
    total_in_guide = sum(len(g) if isinstance(g, list) else 0 for _, _, g in enriched)
    total_missing = sum(len(m) for _, m in missing_groups)

    md_chunks = [
        f"# LS증권 OpenAPI 가이드 (자동 추출)\n",
        f"- 추출 시각: {time.strftime('%Y-%m-%d %H:%M:%S')}",
        f"- 사이드바 그룹: {len(items)}개",
        f"- **수집된 TR**: **{total_in_guide}개** (가이드 페이지에 자료가 채워진 TR 전부)",
        f"- 누락 TR: {total_missing}개 (대부분 deprecated 구 TR — 같은 그룹의 신 TR로 대체)",
        f"- Source: {START_URL}",
        "",
        "## ⚠️ 누락 TR 목록\n",
        "**중요**: 누락 TR 거의 전부가 deprecated 구 TR. LS가 가이드 페이지에서 신 TR만 노출 → 신 TR로 대체.",
        "신 TR이 같은 그룹에 자료 노출되어 있으므로 PDF 별도 다운로드 거의 불필요.",
        "",
        "### 🚨 LS 공식 공지 — 2026-05-28 선물옵션 TR deprecate",
        "",
        "LS 측 2026-04-24 ~ 2026-05-28 신/구 TR 병행. **5/28 이후 구 TR 데이터 제공 중단**. 가격 필드 자릿수 확대가 변경 사유 (InBlock/타 필드 동일).",
        "",
        "| 구 TR | 신 TR | TR명 |",
        "|---|---|---|",
        "| t2101 | **t2111** | 선물/옵션 현재가(시세) |",
        "| t2105 | **t2112** | 선물/옵션 호가조회 |",
        "| t2201 | **t2212** | 선물/옵션 시간대별 체결 |",
        "| t2203 | **t2214** | 선물/옵션 기간별 주가 |",
        "| t2209 | **t2216** | 선물/옵션 틱분별 체결차트 |",
        "| t2405 | **t2407** | 선물/옵션 호가잔량 비율 |",
        "| t2421 | **t2424** | 선물/옵션 미결제약정 추이 |",
        "| t8414 | **t8464** | 선물옵션차트(틱/n틱) |",
        "| t8415 | **t8465** | 선물/옵션챠트(N분) |",
        "| t8416 | **t8466** | 선물/옵션챠트(일주월) |",
        "| t8432 | **t8467** | 지수선물마스터조회API용 |",
        "| FC0 | **FC9** | KOSPI200선물체결 (Real) |",
        "| FH0 | **FH9** | KOSPI200선물호가 (Real) |",
        "| FX0 | **FX9** | KOSPI200선물가격제한폭확대 (Real) |",
        "| YFC | **YF9** | 지수선물예상체결 (Real) |",
        "",
        "신규 추가: **t2522** (주식선물기초자산조회). 별도: t1901~t1904는 2026-05-19부터 nav 필드 자릿수만 12.2로 확대 (TR 코드 그대로).",
        "",
        "### 그 외 신/구 매핑 (공지 외, 가이드 페이지 변경)",
        "",
        "- t8410 / t8411 / t8412 (주식 차트, 일부 가이드 노출) → t8451 / t8452 / t8453 (`[주식] 차트` 그룹 통합 API용)",
        "- **t4201 / t8413 (주식 차트, 가이드 미노출)** → t8451 / t8452 / t8453 (통합 API용)로 흡수 추정",
        "",
        "WebSocket TR ELW 일부(Ys3_4ELW 등) 같이 신 TR 매핑 못 찾는 경우만 LS 포털에서 PDF 별도.",
        "",
        "> ⚠️ **판단 기준은 가이드 페이지 노출 여부** (이 추출본의 `### tXXXX` 헤더). `_raw/meta_*.json`의 `extraParam`(게이트웨이 TPS 정책 목록)에 TR 코드가 있어도 deprecated 처리 후 남아있는 경우가 많아 ACTIVE 판단 근거로 못 씀. 누락 TR 정체 의심 시 이 표를 먼저 보고 메타파일은 참고만.",
        "",
    ]
    if missing_groups:
        md_chunks.append("| 그룹 | 누락 TR |")
        md_chunks.append("|---|---|")
        for name, misses in missing_groups:
            md_chunks.append(f"| {name} | {' / '.join(misses)} |")
    else:
        md_chunks.append("_(누락 없음)_")
    md_chunks.append("\n---\n")
    # 카테고리별 그룹
    by_cat: dict[str, list] = {}
    for it, meta, guide in enriched:
        by_cat.setdefault(it["category"], []).append((it, meta, guide))
    # 카테고리 순서 — 사용자 친화 (주식 우선, 그 다음 선물)
    cat_order = ["OAuth 인증", "업종", "주식", "선물/옵션", "해외선물", "해외주식",
                 "기타", "실시간 시세 투자정보"]
    cats = sorted(by_cat.keys(), key=lambda c: (cat_order.index(c) if c in cat_order else 99, c))
    for cat in cats:
        md_chunks.append(f"\n# 📂 {cat}\n")
        for it, meta, guide in by_cat[cat]:
            md_chunks.append(render_group_markdown(it, meta, guide))

    OUT_FILE.write_text("\n".join(md_chunks), encoding="utf-8")
    sz = OUT_FILE.stat().st_size
    print(f"  완료: {OUT_FILE} ({sz/1024:.1f} KB)")


if __name__ == "__main__":
    main()
