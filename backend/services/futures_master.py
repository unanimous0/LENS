"""
주식선물 마스터 데이터 관리.
- 외부망: LS API t8401(목록) + t8402(상세) 호출 → JSON 저장
- 내부망: 외부망에서 만든 JSON 파일 사용 (압축에 포함)
- 자동 갱신: 서버 시작 시 근월물 만기일 체크 → 지났으면 자동 호출
"""
import json
import os
import re
import time
from datetime import date, datetime
from pathlib import Path

import httpx

DATA_DIR = Path(__file__).parent.parent.parent / "data"
MASTER_FILE = DATA_DIR / "futures_master.json"

TOKEN_URL = "https://openapi.ls-sec.co.kr:8080/oauth2/token"
API_BASE = "https://openapi.ls-sec.co.kr:8080"


async def _get_token(app_key: str, app_secret: str) -> str:
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            TOKEN_URL,
            data={
                "grant_type": "client_credentials",
                "appkey": app_key,
                "appsecretkey": app_secret,
                "scope": "oob",
            },
        )
        resp.raise_for_status()
        return resp.json()["access_token"]


async def _call_tr(token: str, tr_cd: str, path: str, body: dict) -> dict:
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"{API_BASE}/{path}",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {token}",
                "tr_cd": tr_cd,
                "tr_cont": "N",
            },
            json=body,
        )
        resp.raise_for_status()
        return resp.json()


def _extract_expiry_month(hname: str) -> str:
    """종목명에서 만기월 추출: '삼성전자 F 202605' → '202605'"""
    m = re.search(r"(\d{6})", hname)
    return m.group(1) if m else ""


def _determine_front_back(today: date) -> tuple[str, str]:
    """현재 날짜 기준 근월/원월 판별.
    주식선물 만기: 매월 둘째 주 목요일.
    간단하게: 이번 달 15일 이전이면 이번 달이 근월, 아니면 다음 달이 근월."""
    y, m = today.year, today.month
    if today.day <= 15:
        front = f"{y}{m:02d}"
        nm = m + 1 if m < 12 else 1
        ny = y if m < 12 else y + 1
        back = f"{ny}{nm:02d}"
    else:
        nm = m + 1 if m < 12 else 1
        ny = y if m < 12 else y + 1
        front = f"{ny}{nm:02d}"
        nm2 = nm + 1 if nm < 12 else 1
        ny2 = ny if nm < 12 else ny + 1
        back = f"{ny2}{nm2:02d}"
    return front, back


async def fetch_and_save_master() -> dict:
    """LS API에서 주식선물 마스터 데이터를 가져와 JSON으로 저장."""
    app_key = os.environ.get("LS_APP_KEY", "")
    app_secret = os.environ.get("LS_APP_SECRET", "")
    if not app_key or not app_secret:
        raise RuntimeError("LS_APP_KEY / LS_APP_SECRET 환경변수 필요")

    token = await _get_token(app_key, app_secret)

    # 1. t8401: 전체 주식선물 목록
    data = await _call_tr(token, "t8401", "futureoption/market-data", {
        "t8401InBlock": {"dummy": ""},
    })
    all_futures = data.get("t8401OutBlock", [])

    # 기초자산별 그룹핑
    from collections import defaultdict
    by_base: dict[str, list[dict]] = defaultdict(list)
    for item in all_futures:
        expiry = _extract_expiry_month(item.get("hname", ""))
        if expiry:
            item["expiry"] = expiry
            by_base[item["basecode"]].append(item)

    today = date.today()
    front_month, back_month = _determine_front_back(today)

    # 2. 근월/원월 필터 → t8402로 상세 조회
    items = []
    for base_code, futures_list in sorted(by_base.items()):
        futures_list.sort(key=lambda x: x["expiry"])
        front = next((f for f in futures_list if f["expiry"] == front_month), None)
        back = next((f for f in futures_list if f["expiry"] == back_month), None)

        if not front:
            continue

        # t8402 호출 (근월물) — 장 외 시간에는 실패할 수 있음
        front_detail = await _fetch_detail_safe(token, front["shcode"])
        base_name = front_detail.get("basehname", front["hname"].strip().split("F")[0].strip())
        # base_code에서 A 접두사 제거 (A005930 → 005930)
        clean_base = base_code[1:] if base_code.startswith("A") and len(base_code) == 7 else base_code

        entry = {
            "base_code": clean_base,
            "base_name": base_name,
            "front": {
                "code": front["shcode"],
                "name": front["hname"].strip(),
                "expiry": front_detail.get("lastmonth", front["expiry"]),
                "days_left": int(front_detail.get("jandatecnt", 0)),
                "multiplier": _parse_multiplier(front_detail.get("mulcnt", "10")),
            },
        }

        # t8402 호출 (원월물, 있으면)
        if back:
            back_detail = await _fetch_detail_safe(token, back["shcode"])
            entry["back"] = {
                "code": back["shcode"],
                "name": back["hname"].strip(),
                "expiry": back_detail.get("lastmonth", back["expiry"]),
                "days_left": int(back_detail.get("jandatecnt", 0)),
                "multiplier": _parse_multiplier(back_detail.get("mulcnt", "10")),
            }

        items.append(entry)

        # t8402 TPS = 10, 안전하게 0.12초 간격
        await _sleep(0.12)

    master = {
        "updated": today.isoformat(),
        "front_month": front_month,
        "back_month": back_month,
        "count": len(items),
        "items": items,
    }

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    MASTER_FILE.write_text(json.dumps(master, ensure_ascii=False, indent=2), encoding="utf-8")
    return master


async def _fetch_detail(token: str, shcode: str) -> dict:
    """t8402: 주식선물 현재가 상세 조회."""
    data = await _call_tr(token, "t8402", "futureoption/market-data", {
        "t8402InBlock": {"focode": shcode},
    })
    return data.get("t8402OutBlock", {})


async def _fetch_detail_safe(token: str, shcode: str) -> dict:
    """t8402 호출. 실패 시 (장 외 등) 빈 dict 반환."""
    try:
        return await _fetch_detail(token, shcode)
    except Exception:
        return {}


def _parse_multiplier(val: str) -> float:
    try:
        return float(val)
    except (ValueError, TypeError):
        return 10.0


async def _sleep(seconds: float):
    import asyncio
    await asyncio.sleep(seconds)


def load_master() -> dict | None:
    """저장된 JSON 파일 로드. 없으면 None."""
    if not MASTER_FILE.exists():
        return None
    try:
        return json.loads(MASTER_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def is_master_expired(master: dict) -> bool:
    """근월물 만기일이 오늘이거나 지났으면 True."""
    items = master.get("items", [])
    if not items:
        return True

    front = items[0].get("front", {})
    expiry_str = front.get("expiry", "")
    if not expiry_str or len(expiry_str) != 8:
        return True

    try:
        expiry_date = datetime.strptime(expiry_str, "%Y%m%d").date()
        return date.today() >= expiry_date
    except ValueError:
        return True


async def ensure_master() -> dict:
    """마스터 데이터가 유효하면 로드, 만기 지났으면 갱신 시도."""
    master = load_master()

    if master and not is_master_expired(master):
        return master

    # 만기 지났거나 파일 없음 → LS API 호출 시도
    try:
        master = await fetch_and_save_master()
        return master
    except Exception as e:
        # LS API 호출 실패 (내부망 등) → 기존 파일이라도 반환
        if master:
            return master
        raise RuntimeError(f"마스터 데이터 없음, LS API 호출 실패: {e}")
