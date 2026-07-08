"""회사 원장 엑셀 (5264 / 3454 / 2514) → LP 원장 반영 파서.

도메인 정본: `docs/원장 엑셀 파일 설명.txt`. 확정된 규칙(사용자 합의):

- **경제적 순 노출** = LP펀드(계정 031) 장부수량(롱) − 차입펀드(계정 052) 장부수량(숏)
  + 선물펀드 수량. 가입고(매매가능수량 − 장부수량)는 가상 수량이라 제외 — 장부수량만.
- **이월** = 3454 "전일 장부" 수량, **체결** = 3454 "당일 매수 / 당일 매도".
  LP는 그대로, **차입은 매수↔매도 의미 반전** (설명 §4-B: 같은 화면에 두 펀드를
  얹느라 당일 매수 컬럼이 차입에선 매도, 당일 매도 컬럼이 매수).
- **정합 검증**: 전일 장부수량 ± 당일 매매 = 당일 장부수량. 불일치 종목은 warning.
  반영 net 은 **당일 장부수량(col20) 기준** → carryover_signed 를
  `경제적_당일장부 − Σ부호체결` 로 잡아 net 이 항상 당일 장부수량과 일치하게 하되,
  정합이 맞으면 이 값은 자연히 −(전일장부) / +(전일장부) 로 떨어진다.
- **2514 수량 = 계약수 기본** (futures_unit='contracts'|'shares'). LENS 기장 단위:
  주식선물 = 주수(계약 × 10), 지수선물 = 계약수 그대로. 옵션·미인식 코드는 excluded.
- **5264** 는 포지션 소스로 쓰지 않고 담보가능수량 < 0 종목 경고만 추출.

3454 는 중복 컬럼명(수량/단가/금액 ×2, 매매가능수량/장부수량 ×2)이라 **위치 기반**
인덱싱 (기본정보 10 + 전일 3 + 당일매수 3 + 당일매도 3 + 당일장부 4 + 관리 2 = 25열).
계정코드(col3)로 LP/차입 판별 — 파일명 의존 금지.

instrument 분류는 호출측(routers/lp.py `_classify_sync`)이 주입한 `classify` 콜러블에
위임 — 순환 import 회피 + 단위테스트 시 가짜 분류기 주입 가능.
"""
from __future__ import annotations

import hashlib
import unicodedata
from typing import Callable, Optional

from services.excel_reader import read_excel

# 주식선물 거래승수 (계약 → 주수). KRX 표준(2017~) = 10.
STOCK_FUT_MULT = 10

ACCOUNT_LP = "031"       # LP펀드(매수펀드) — 장부수량 = 롱
ACCOUNT_BORROW = "052"   # 차입펀드(매도펀드) — 장부수량 = 숏

# (code, instrument) 반환. 코드 정규화 실패 시 ValueError.
ClassifyFn = Callable[[str], tuple[str, str]]


# ---------------------------------------------------------------------------
# 헤더/숫자 정규화
# ---------------------------------------------------------------------------

def _norm_header(x) -> str:
    """헤더 셀 정규화 — 개행(`\\n`/`\\r`)·`_x000D_`·이중 공백 제거.

    실측 변형: `BOOK\\n코드`, `계정\\r\\n코드`, `계정_x000D_\\n코드`, `계정  코드`.
    """
    if x is None:
        return ""
    s = str(x).replace("_x000D_", "").replace("\r", "").replace("\n", "")
    return " ".join(s.split()).strip()


def _num(x) -> float:
    """안전 수치 변환 — NaN/None/빈칸/`-` → 0.0. 콤마 제거."""
    if x is None:
        return 0.0
    if isinstance(x, bool):
        return 0.0
    if isinstance(x, (int, float)):
        return 0.0 if x != x else float(x)  # NaN guard
    s = str(x).strip().replace(",", "")
    if not s or s == "-":
        return 0.0
    try:
        return float(s)
    except ValueError:
        return 0.0


def _int(x) -> int:
    return int(round(_num(x)))


def _cell(x) -> str:
    """문자열 셀 정규화 (코드/이름/계정) — NaN → 빈 문자열."""
    if x is None:
        return ""
    try:
        if isinstance(x, float) and x != x:
            return ""
    except (TypeError, ValueError):
        pass
    return str(x).strip()


# ---------------------------------------------------------------------------
# 화면 판별
# ---------------------------------------------------------------------------

def detect_screen(df) -> str:
    """헤더 행(row 0) 시그니처 + 열 수로 5264/3454/2514 판별. 미상은 'unknown'."""
    if df is None or df.shape[0] < 1:
        return "unknown"
    ncols = df.shape[1]
    hdr = [_norm_header(c) for c in df.iloc[0].tolist()]
    hset = set(hdr)
    if ncols == 5 and {"종목코드", "수량", "가격"} <= hset:
        return "2514"
    if ncols == 14 and "담보가능수량" in hset:
        return "5264"
    if ncols == 25 and hdr.count("장부수량") >= 1 and hdr.count("매매가능수량") >= 1:
        return "3454"
    # 열 수 폴백 (헤더 변형이 심해 시그니처가 어긋난 경우)
    if ncols == 5:
        return "2514"
    if ncols == 14:
        return "5264"
    if ncols == 25:
        return "3454"
    return "unknown"


# ---------------------------------------------------------------------------
# 파서 (화면별)
# ---------------------------------------------------------------------------

def parse_3454(df, filename: str, classify: ClassifyFn) -> dict:
    """3454 위치 기반 파서. per-row 레코드 리스트 + excluded + warnings 반환.

    각 레코드: {code, name, instrument, account, fund_code, filename,
                carryover_signed, avg_price, fills:[{side,qty,price,source}],
                fills_signed, econ_today, prev_book_signed, reconciled, recon_detail}
    """
    records: list[dict] = []
    excluded: list[dict] = []
    warnings: list[dict] = []
    fund_types: set[str] = set()
    parsed_rows = 0

    for i in range(1, df.shape[0]):
        row = df.iloc[i]
        code_raw = _cell(row.iloc[8])
        account = _cell(row.iloc[3])
        # 합계/빈 행 스킵 — 종목번호 없음.
        if not code_raw:
            continue
        name = _cell(row.iloc[9])

        prev_book = _int(row.iloc[11])   # 전일 장부수량
        buy_qty = _int(row.iloc[13])     # 당일 매수 정보 · 수량 (첫 번째 "수량")
        buy_px = _num(row.iloc[14])
        sell_qty = _int(row.iloc[16])    # 당일 매도 정보 · 수량 (두 번째 "수량")
        sell_px = _num(row.iloc[17])
        today_book = _int(row.iloc[20])  # 당일 장부수량 (정본)
        today_px = _num(row.iloc[21])    # 당일 장부 단가 = 평단

        # 완전 무 포지션·무 체결 행 스킵 (가입고만 있는 행 포함 — 가입고는 제외 대상).
        if prev_book == 0 and buy_qty == 0 and sell_qty == 0 and today_book == 0:
            continue

        if account not in (ACCOUNT_LP, ACCOUNT_BORROW):
            excluded.append({
                "code": code_raw, "name": name, "source": filename,
                "reason": f"미인식 계정코드 {account or '(빈값)'} (031 LP / 052 차입만 지원)",
            })
            continue

        try:
            code, instrument = classify(code_raw)
        except Exception as e:  # noqa: BLE001  (classify: ValueError; 방어적으로 전부 흡수 → excluded)
            excluded.append({
                "code": code_raw, "name": name, "source": filename,
                "reason": f"코드 정규화 실패: {e}",
            })
            continue

        fund_types.add("LP" if account == ACCOUNT_LP else "차입")
        fund_code = _cell(row.iloc[1])

        # 정합: prev ± 당일매매 = today (부호 무관, 크기 기준).
        expected = prev_book + buy_qty - sell_qty
        reconciled = expected == today_book
        recon_detail: Optional[str] = None
        if not reconciled:
            recon_detail = (
                f"전일 {prev_book} + 매수 {buy_qty} − 매도 {sell_qty} = {expected} "
                f"≠ 당일 장부 {today_book}"
            )
            warnings.append({
                "type": "reconcile", "code": code, "name": name, "source": filename,
                "detail": recon_detail,
            })

        fills: list[dict] = []
        if account == ACCOUNT_LP:
            econ_today = today_book              # 롱
            if buy_qty > 0:
                fills.append({"side": "buy", "qty": buy_qty, "price": buy_px or None,
                              "source": filename})
            if sell_qty > 0:
                fills.append({"side": "sell", "qty": sell_qty, "price": sell_px or None,
                              "source": filename})
        else:  # ACCOUNT_BORROW — 매수↔매도 반전
            econ_today = -today_book             # 숏
            # 당일 "매수" 컬럼 = 차입 매도 → 숏 증가.
            if buy_qty > 0:
                fills.append({"side": "sell", "qty": buy_qty, "price": buy_px or None,
                              "source": filename})
            # 당일 "매도" 컬럼 = 차입 매수 → 숏 감소.
            if sell_qty > 0:
                fills.append({"side": "buy", "qty": sell_qty, "price": sell_px or None,
                              "source": filename})

        fills_signed = sum(f["qty"] if f["side"] == "buy" else -f["qty"] for f in fills)
        # net 이 항상 당일 장부(경제) 기준이 되도록 carryover 를 역산.
        # 정합이 맞으면 = +전일장부(LP) / −전일장부(차입).
        carryover_signed = econ_today - fills_signed
        prev_book_signed = prev_book if account == ACCOUNT_LP else -prev_book

        records.append({
            "code": code, "name": name, "instrument": instrument,
            "account": account, "fund_code": fund_code, "filename": filename,
            "carryover_signed": carryover_signed,
            "avg_price": today_px or None,
            "fills": fills,
            "fills_signed": fills_signed,
            "econ_today": econ_today,
            "prev_book_signed": prev_book_signed,
            "reconciled": reconciled,
            "recon_detail": recon_detail,
        })
        parsed_rows += 1

    return {
        "records": records, "excluded": excluded, "warnings": warnings,
        "fund_types": sorted(fund_types), "parsed_rows": parsed_rows,
    }


def parse_2514(df, filename: str, classify: ClassifyFn, futures_unit: str) -> dict:
    """2514 파생상품 파서 (5열). 수량 부호 그대로. 계약↔주수 환산 명세 포함."""
    records: list[dict] = []
    excluded: list[dict] = []
    warnings: list[dict] = []
    parsed_rows = 0
    # 2514 는 파일 내부에 펀드코드 컬럼이 없음 — 파일명 prefix('028875_2514.xlsx' → '028875')
    # 가 6자리 숫자면 펀드코드로 채택 (세트 혼합 정보 경고용. 아니면 None).
    prefix = filename.split("_", 1)[0]
    file_fund_code = prefix if len(prefix) == 6 and prefix.isdigit() else None

    for i in range(1, df.shape[0]):
        row = df.iloc[i]
        code_raw = _cell(row.iloc[0])
        if not code_raw:
            continue
        name = _cell(row.iloc[1])
        qty_raw = _int(row.iloc[2])   # 계약수(기본) — 부호 그대로
        price = _num(row.iloc[3]) or None
        if qty_raw == 0:
            continue

        try:
            code, instrument = classify(code_raw)
        except Exception as e:  # noqa: BLE001  (classify: ValueError; 방어적으로 전부 흡수 → excluded)
            excluded.append({"code": code_raw, "name": name, "source": filename,
                             "reason": f"코드 정규화 실패: {e}"})
            continue

        if instrument not in ("stock_fut", "index_fut"):
            excluded.append({"code": code_raw, "name": name, "source": filename,
                             "reason": f"선물 외 코드(옵션·미인식) — 분류 {instrument}"})
            continue

        conversion_note: Optional[str] = None
        if instrument == "stock_fut" and futures_unit == "contracts":
            signed = qty_raw * STOCK_FUT_MULT
            conversion_note = (
                f"{code_raw}: {qty_raw:,}계약 → {signed:,}주 (×{STOCK_FUT_MULT})"
            )
        else:
            # 주식선물 unit='shares' → 이미 주수. 지수선물 → 항상 계약수 그대로.
            signed = qty_raw

        records.append({
            "code": code, "name": name, "instrument": instrument,
            "account": "선물", "fund_code": file_fund_code, "filename": filename,
            "carryover_signed": signed,
            "avg_price": price,
            "fills": [],
            "fills_signed": 0,
            "econ_today": signed,
            "prev_book_signed": signed,
            "reconciled": True,
            "recon_detail": None,
            "conversion_note": conversion_note,
        })
        parsed_rows += 1

    return {"records": records, "excluded": excluded, "warnings": warnings,
            "fund_types": ["선물"], "parsed_rows": parsed_rows}


def parse_5264(df, filename: str) -> dict:
    """5264 수량관리 화면 — 포지션 소스로 쓰지 않고 담보가능수량 < 0 경고만 추출."""
    warnings: list[dict] = []
    parsed_rows = 0
    for i in range(1, df.shape[0]):
        row = df.iloc[i]
        code_raw = _cell(row.iloc[4])
        if not code_raw:
            continue
        parsed_rows += 1
        account = _cell(row.iloc[3])
        name = _cell(row.iloc[5])
        collateral_avail = _int(row.iloc[11])   # 담보가능수량
        if collateral_avail < 0:
            fund = "LP" if account == ACCOUNT_LP else ("차입" if account == ACCOUNT_BORROW else account)
            warnings.append({
                "type": "collateral_negative", "code": code_raw, "name": name,
                "source": filename,
                "detail": f"[{fund}] 담보가능수량 {collateral_avail:,} < 0 (매도 초과·언더커버)",
            })
    return {"warnings": warnings, "parsed_rows": parsed_rows}


# ---------------------------------------------------------------------------
# 상위 오케스트레이션 (다중 파일 → 종목별 병합)
# ---------------------------------------------------------------------------

def _read_df(file_bytes: bytes):
    """헤더 없이(첫 행이 헤더) 원본 그대로 읽어 위치 인덱싱을 안정화."""
    return read_excel(file_bytes, header=None, dtype=object)


def parse_ledger_files(
    files: list[tuple[str, bytes]],
    classify: ClassifyFn,
    futures_unit: str = "contracts",
) -> dict:
    """여러 원장 엑셀을 파싱해 종목별 포지션으로 병합.

    files: [(filename, bytes)]. filename 은 표시용(NFC 정규화 권장).
    classify: (raw_code) → (normalized_code, instrument). 실패 시 ValueError.

    반환:
        {
          files: [{filename, screen, fund_types, parsed_rows, error?}],
          positions: [{code, name, instrument, carryover_qty(부호), avg_price,
                       fills:[{side,qty,price,source}], fills_qty_today(부호),
                       net_qty, sources, reconciled, recon_detail, conversion_note,
                       prev_book_signed}],
          excluded: [...], warnings: [...],
          summary: {...},
        }
    """
    file_infos: list[dict] = []
    all_records: list[dict] = []
    excluded: list[dict] = []
    warnings: list[dict] = []

    # 같은 파일 중복 첨부 → 이중 계상 방지. 내용 SHA-256 으로 dedup (파일명 무관).
    seen_hashes: dict[str, str] = {}

    for filename, blob in files:
        fname = unicodedata.normalize("NFC", filename)
        digest = hashlib.sha256(blob).hexdigest()
        first = seen_hashes.get(digest)
        if first is not None:
            file_infos.append({"filename": fname, "screen": "duplicate",
                               "fund_types": [], "parsed_rows": 0,
                               "note": f"중복 — 무시됨 (내용이 {first} 와 동일)"})
            warnings.append({
                "type": "duplicate_file", "code": "", "name": None, "source": fname,
                "detail": f"중복 파일 무시: {fname} (내용이 {first} 와 동일 — 1회만 계상)",
            })
            continue
        seen_hashes[digest] = fname
        try:
            df = _read_df(blob)
            screen = detect_screen(df)
            if screen == "3454":
                res = parse_3454(df, fname, classify)
                all_records.extend(res["records"])
                excluded.extend(res["excluded"])
                warnings.extend(res["warnings"])
                file_infos.append({"filename": fname, "screen": screen,
                                   "fund_types": res["fund_types"],
                                   "parsed_rows": res["parsed_rows"]})
            elif screen == "2514":
                res = parse_2514(df, fname, classify, futures_unit)
                all_records.extend(res["records"])
                excluded.extend(res["excluded"])
                warnings.extend(res["warnings"])
                file_infos.append({"filename": fname, "screen": screen,
                                   "fund_types": res["fund_types"],
                                   "parsed_rows": res["parsed_rows"]})
            elif screen == "5264":
                res = parse_5264(df, fname)
                warnings.extend(res["warnings"])
                file_infos.append({"filename": fname, "screen": screen,
                                   "fund_types": ["수량관리(5264)"],
                                   "parsed_rows": res["parsed_rows"]})
            else:
                file_infos.append({"filename": fname, "screen": "unknown",
                                   "fund_types": [], "parsed_rows": 0,
                                   "error": f"화면 판별 실패 (열 수 {df.shape[1]})"})
        except Exception as e:  # noqa: BLE001
            file_infos.append({"filename": fname, "screen": "error",
                               "fund_types": [], "parsed_rows": 0,
                               "error": f"{type(e).__name__}: {e}"})

    positions = _merge_records(all_records)

    # 펀드 세트 혼합 정보 경고 (세트 DB 도입 전 허용) — 펀드코드 뒤 3자리로 세트 식별
    # (019875/018875/028875 → '875'). 서로 다른 세트가 섞이면 합산 사실을 알림.
    set_ids = sorted({fc[-3:] for r in all_records if (fc := r.get("fund_code"))})
    if len(set_ids) > 1:
        warnings.append({
            "type": "set_mix", "code": "", "name": None, "source": "",
            "detail": f"서로 다른 펀드 세트 파일이 합산됨: {', '.join(set_ids)}",
        })

    n_conv = sum(1 for p in positions if p.get("conversion_note"))
    summary = {
        "n_positions": len(positions),
        "n_fills": sum(len(p["fills"]) for p in positions),
        "n_excluded": len(excluded),
        "n_warnings": len(warnings),
        "n_reconcile_warnings": sum(1 for w in warnings if w["type"] == "reconcile"),
        "n_collateral_warnings": sum(1 for w in warnings if w["type"] == "collateral_negative"),
        "n_conversions": n_conv,
        "n_files_ok": sum(1 for f in file_infos if not f.get("error") and f["screen"] != "duplicate"),
        "n_files_error": sum(1 for f in file_infos if f.get("error")),
        "n_files_duplicate": sum(1 for f in file_infos if f["screen"] == "duplicate"),
    }

    return {"files": file_infos, "positions": positions,
            "excluded": excluded, "warnings": warnings, "summary": summary}


def _merge_records(records: list[dict]) -> list[dict]:
    """종목(정규화 코드)별 병합.

    - carryover_signed: 합산 (LP + / 차입 − 자연 네팅).
    - fills: 각 레코드 것을 그대로 이어붙임 (source 유지).
    - carryover_avg_price: 레코드별 당일 장부 단가의 |carryover_signed| 가중 평균 —
      DB carryover 행에 기록될 평단.
    - avg_price(표시용): **반영 후 원장 보드가 보여줄 값과 동일한 blended VWAP** —
      lp_ledger._aggregate_sync 산식(가격 있는 모든 엔트리 qty 가중)을 기록될 행
      (carryover 1행: qty=|carryover 합|·price=carryover_avg_price + fill 행들) 위에서
      그대로 시뮬레이션. 미리보기 평단 ≠ 반영 후 평단 불일치 방지.
    - net_qty = carryover_signed 합 + 부호 체결 합 = 경제적 당일 장부 합.
    - reconciled: 모든 기여 레코드가 정합일 때만 True.
    """
    merged: dict[str, dict] = {}
    for r in records:
        code = r["code"]
        m = merged.get(code)
        if m is None:
            m = {
                "code": code, "name": r["name"], "instrument": r["instrument"],
                "carryover_signed": 0, "fills": [], "fills_signed": 0,
                "sources": [], "reconciled": True, "recon_details": [],
                "conversion_notes": [], "prev_book_signed": 0,
                "_px_num": 0.0, "_px_den": 0,
            }
            merged[code] = m
        if not m["name"] and r["name"]:
            m["name"] = r["name"]
        m["carryover_signed"] += r["carryover_signed"]
        m["prev_book_signed"] += r.get("prev_book_signed", 0)
        m["fills_signed"] += r["fills_signed"]
        m["fills"].extend(r["fills"])
        if r["filename"] not in m["sources"]:
            m["sources"].append(r["filename"])
        if not r["reconciled"]:
            m["reconciled"] = False
            if r.get("recon_detail"):
                m["recon_details"].append(r["recon_detail"])
        if r.get("conversion_note"):
            m["conversion_notes"].append(r["conversion_note"])
        px = r.get("avg_price")
        w = abs(r["carryover_signed"])
        if px is not None and w > 0:
            m["_px_num"] += px * w
            m["_px_den"] += w

    out: list[dict] = []
    for m in merged.values():
        carryover_avg = (m["_px_num"] / m["_px_den"]) if m["_px_den"] > 0 else None
        # 반영 후 원장 보드 평단 시뮬레이션 (_aggregate_sync 와 동일 가중):
        # carryover 1행 (qty=|carryover 합|, price=carryover_avg) + 가격 있는 fill 행들.
        num = 0.0
        den = 0
        if carryover_avg is not None and m["carryover_signed"] != 0:
            w = abs(m["carryover_signed"])
            num += carryover_avg * w
            den += w
        for f in m["fills"]:
            fp = f.get("price")
            if fp is not None:
                num += fp * f["qty"]
                den += f["qty"]
        avg_price = (num / den) if den > 0 else None
        net_qty = m["carryover_signed"] + m["fills_signed"]
        out.append({
            "code": m["code"], "name": m["name"], "instrument": m["instrument"],
            "carryover_qty": m["carryover_signed"],
            "prev_book_signed": m["prev_book_signed"],
            "avg_price": avg_price,
            "carryover_avg_price": carryover_avg,
            "fills": m["fills"],
            "fills_qty_today": m["fills_signed"],
            "net_qty": net_qty,
            "sources": m["sources"],
            "reconciled": m["reconciled"],
            "recon_detail": "; ".join(m["recon_details"]) if m["recon_details"] else None,
            "conversion_note": "; ".join(m["conversion_notes"]) if m["conversion_notes"] else None,
        })
    # 표시 순서: 자산유형 → 코드.
    inst_order = {"etf": 0, "index_fut": 1, "stock_fut": 2, "stock": 3}
    out.sort(key=lambda p: (inst_order.get(p["instrument"], 9), p["code"]))
    return out
