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


def _second_thursday(year: int, month: int) -> date:
    """해당 월의 둘째 목요일 날짜를 반환."""
    # 1일의 요일 (0=월 ... 3=목 ... 6=일)
    first = date(year, month, 1)
    thu = 3  # Thursday
    # 첫째 목요일: 1일이 목요일이면 1일, 아니면 다음 목요일
    days_until_thu = (thu - first.weekday()) % 7
    first_thu = 1 + days_until_thu
    second_thu = first_thu + 7
    return date(year, month, second_thu)


def _next_month(year: int, month: int) -> tuple[int, int]:
    return (year + 1, 1) if month == 12 else (year, month + 1)


def _determine_front_back(today: date) -> tuple[str, str]:
    """현재 날짜 기준 근월/원월 판별.
    주식선물 만기: 매월 둘째 목요일.
    만기일 당일까지는 해당 월이 근월, 만기일 다음날부터 다음 달이 근월."""
    y, m = today.year, today.month
    expiry = _second_thursday(y, m)
    if today <= expiry:
        front_y, front_m = y, m
    else:
        front_y, front_m = _next_month(y, m)
    back_y, back_m = _next_month(front_y, front_m)
    return f"{front_y}{front_m:02d}", f"{back_y}{back_m:02d}"


async def fetch_and_save_master() -> dict:
    """LS API에서 주식선물 마스터 데이터를 가져와 JSON으로 저장."""
    from dotenv import load_dotenv
    load_dotenv()
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

    # t8436: 코스닥 종목 목록 (코스피/코스닥 구분용)
    kosdaq_data = await _call_tr(token, "t8436", "stock/etc", {
        "t8436InBlock": {"gubun": "2"},
    })
    kosdaq_codes = {}
    for item in kosdaq_data.get("t8436OutBlock", []):
        kosdaq_codes[item["shcode"]] = "KOSDAQ"

    # 스프레드 종목 매핑 (D코드, basecode → 스프레드 shcode)
    # 근월-차월 스프레드만 (코드에 근월2자리+차월2자리 패턴)
    spread_by_base: dict[str, str] = {}
    for item in all_futures:
        shcode = item.get("shcode", "")
        if shcode.startswith("D") and shcode.endswith("S"):
            base = item.get("basecode", "")
            hname = item.get("hname", "")
            # "SP 2605-2" 형태 → 근월-차월 스프레드 (가장 가까운 원월)
            # 근월-차월(06)만 = 코드에 front_month[2:]+back_month[2: 포함
            if base and base not in spread_by_base:
                spread_by_base[base] = shcode

    today = date.today()
    front_month, back_month = _determine_front_back(today)

    # 근월-차월 스프레드 필터링 (front_month+back_month 패턴)
    fm_suffix = front_month[2:]  # "202605" → "0605" → 뒤 2자리 "05" → 코드에서는 "65"
    # 선물코드에서 월 인코딩: 05→65, 06→66, 07→67, 09→69, 12→6C
    month_to_code = {"01": "61", "02": "62", "03": "63", "04": "64", "05": "65",
                     "06": "66", "07": "67", "08": "68", "09": "69", "10": "6A",
                     "11": "6B", "12": "6C"}
    front_code_suffix = month_to_code.get(front_month[4:], "65")
    back_code_suffix = month_to_code.get(back_month[4:], "66")
    spread_pattern = front_code_suffix + back_code_suffix  # "6566" for 05→06

    # 정확한 근월-차월 스프레드만 선별
    spread_by_base_filtered: dict[str, str] = {}
    for item in all_futures:
        shcode = item.get("shcode", "")
        if shcode.startswith("D") and shcode.endswith("S") and spread_pattern in shcode:
            base = item.get("basecode", "")
            if base:
                spread_by_base_filtered[base] = shcode

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
        await _sleep(0.15)
        base_name = front_detail.get("basehname", front["hname"].strip().split("F")[0].strip())
        # base_code에서 A 접두사 제거 (A005930 → 005930)
        clean_base = base_code[1:] if base_code.startswith("A") and len(base_code) == 7 else base_code

        spot_price = _parse_price(front_detail.get("baseprice", "0"))
        spot_volume = int(_parse_price(front_detail.get("basevol", "0")))
        entry = {
            "base_code": clean_base,
            "base_name": base_name,
            "market": kosdaq_codes.get(clean_base, "KOSPI"),
            "spot_price": spot_price,
            "spot_value": int(spot_price * spot_volume) if spot_price > 0 and spot_volume > 0 else 0,
            "front": _build_month_entry(front, front_detail),
        }

        # t8402 호출 (원월물, 있으면)
        if back:
            back_detail = await _fetch_detail_safe(token, back["shcode"])
            await _sleep(0.15)
            entry["back"] = _build_month_entry(back, back_detail)

        # 스프레드 코드 (근월-차월)
        spread_code = spread_by_base_filtered.get(base_code, "")
        if spread_code:
            entry["spread_code"] = spread_code

        items.append(entry)

    # 가격 누락된 항목 재시도 (TPS 제한으로 실패했을 수 있음)
    await _sleep(2.0)
    for entry in items:
        if entry.get("spot_price", 0) == 0:
            front_code = entry["front"]["code"]
            detail = await _fetch_detail_safe(token, front_code)
            if detail:
                entry["spot_price"] = _parse_price(detail.get("baseprice", "0"))
                entry["front"] = _build_month_entry(
                    {"shcode": front_code, "hname": entry["front"]["name"]}, detail
                )
                if not entry.get("base_name") or entry["base_name"] == front_code:
                    entry["base_name"] = detail.get("basehname", entry["base_name"])
            await _sleep(0.3)
            if "back" in entry and entry["back"].get("price", 0) == 0:
                back_code = entry["back"]["code"]
                bdetail = await _fetch_detail_safe(token, back_code)
                if bdetail:
                    entry["back"] = _build_month_entry(
                        {"shcode": back_code, "hname": entry["back"]["name"]}, bdetail
                    )
                await _sleep(0.3)

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


async def _fetch_detail_safe(token: str, shcode: str, retries: int = 3) -> dict:
    """t8402 호출. 실패 시 재시도, 최종 실패 시 빈 dict 반환."""
    for attempt in range(retries + 1):
        try:
            return await _fetch_detail(token, shcode)
        except Exception:
            if attempt < retries:
                await _sleep(1.0)
    return {}


def _build_month_entry(item: dict, detail: dict) -> dict:
    return {
        "code": item["shcode"],
        "name": item["hname"].strip(),
        "expiry": detail.get("lastmonth", item.get("expiry", "")),
        "days_left": int(detail.get("jandatecnt", 0)),
        "multiplier": _parse_multiplier(detail.get("mulcnt", "10")),
        "price": _parse_price(detail.get("price", "0")),
        "volume": int(_parse_price(detail.get("volume", "0"))),
    }


def _parse_price(val: str) -> float:
    try:
        return float(val)
    except (ValueError, TypeError):
        return 0.0


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


def _is_stale(master: dict) -> bool:
    """오늘 갱신되지 않았거나 만기 지났으면 True."""
    updated = master.get("updated", "")
    try:
        updated_date = datetime.strptime(updated, "%Y-%m-%d").date()
        if updated_date < date.today():
            return True
    except ValueError:
        return True
    return is_master_expired(master)


async def ensure_master() -> dict:
    """마스터 데이터가 유효하면 로드, stale이면 기존 반환 + 백그라운드 갱신."""
    import asyncio

    master = load_master()

    if master and not _is_stale(master):
        return master

    # stale이지만 기존 파일이 있으면 → 일단 반환, 백그라운드에서 갱신
    if master:
        asyncio.create_task(_background_refresh())
        return master

    # 파일 자체가 없으면 → 동기 갱신 (최초 실행)
    try:
        master = await fetch_and_save_master()
        return master
    except Exception as e:
        raise RuntimeError(f"마스터 데이터 없음, LS API 호출 실패: {e}")


async def _background_refresh():
    """백그라운드에서 마스터 갱신. 실패해도 무시."""
    try:
        await fetch_and_save_master()
    except Exception:
        pass
