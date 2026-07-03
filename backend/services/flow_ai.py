"""AI 수급 요약 (프로토타입) — 외부망 전용.

리스크 가드레일이 핵심:
  1. 사실(facts)은 전부 파이썬이 계산 (flow_metrics 정본 소비). LLM은 새 숫자를 만들면 안 됨.
  2. system 프롬프트로 매매 지시/권유 표현 금지 + 근거 숫자 인용 강제.
  3. 반환 전 금지어 후처리 필터 (안전망).
  4. 데이터버전 캐시 재사용 — 같은 버전 재요청은 LLM 재호출 없이 캐시 히트.

키(ANTHROPIC_API_KEY)가 없으면(=내부망/오프라인) 에러가 아니라
{available: false, ...} 로 graceful degrade.
"""
from __future__ import annotations

import os
import re
from pathlib import Path

import httpx

from services import flow_metrics as fm

_ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
_MODEL = "claude-sonnet-5"
_MAX_TOKENS = 1200  # 한국어는 토큰 밀도가 높아 700은 5~8문장에서 잘림 → 여유

# 레포 루트 .env (backend/services/flow_ai.py → parents[2] = 레포 루트).
# config는 env_file="backend/.env"를 보는데 실제 .env는 루트에 있어 os.getenv가 못 봄 →
# 여기서 루트 .env를 직접 폴백 조회 (export/os.environ 우선, 그다음 루트 .env).
_ROOT_ENV = Path(__file__).resolve().parents[2] / ".env"


def _read_api_key() -> str | None:
    k = os.getenv("ANTHROPIC_API_KEY")
    if k:
        return k.strip()
    if _ROOT_ENV.exists():
        for line in _ROOT_ENV.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("ANTHROPIC_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'") or None
    return None

# 매매 지시/권유 금지어. '순매수/순매도'는 데이터 용어라 살려야 하므로
# 매수/매도는 앞에 '순'이 없을 때만(=동사형 지시) 매칭.
_BANNED_PATTERNS = [
    re.compile(r"(?<!순)매수"),
    re.compile(r"(?<!순)매도"),
    re.compile(r"목표가"),
    re.compile(r"추천"),
    re.compile(r"사라(?!지|질|졌|져)"),  # '사라져/사라진' 같은 '사라지다'는 제외
    re.compile(r"팔라"),
]

_SYSTEM_PROMPT = (
    "너는 한국 주식 수급(투자자별 순매수) 데이터 해석 보조다. 다음 규칙을 반드시 지켜라.\n"
    "(1) 아래 user 메시지에 제공된 숫자만 사용하고, 새로운 숫자를 계산·추정·창작하지 마라.\n"
    "(2) 각 해석 문장에는 근거가 되는 숫자(값)를 자연스러운 한국어로 인용하라. "
    "단 영문 필드명/JSON 키(foreign_20d_bp, entry_zone, is_distribution 등)는 절대 쓰지 말고 값만 써라. "
    "괄호 안에도 영문을 넣지 마라. 예: '(foreign_20d_bp)'가 아니라 '외국인 20일 수급강도 295.9bp'. "
    "불리언(true/false)도 필드명 없이 자연어로: '진입권 조건 충족', '분산 신호 없음', '장기추세 상승'처럼.\n"
    "(3) '매수'·'매도'·'목표가'·'추천'·'사라'·'팔라' 등 매매 지시/권유 표현을 절대 쓰지 마라. "
    "'매수세'·'매도세'도 쓰지 말고 '순매수'·'순매도' 데이터 용어로만 서술한다. "
    "사실 해석과 관찰만 서술한다.\n"
    "(4) 제공되지 않은 인과·뉴스·전망을 지어내지 마라.\n"
    "(5) 한국어로, 5~8문장. 마지막에 '주의:' 로 시작하는 한 줄로 맥락 한계를 덧붙여라."
)


# ── 사실(facts) 계산 — flow_metrics 정본 소비, 전부 파이썬 계산 ──────────────
def _estimate_avg_price(rows: list[dict]) -> float | None:
    """외인 평단 추정 — frontend estimateAvgPrice 이식.

    누적 외인 순매수(cum_f) 최저점 이후 구간에서
    Σ(순매수금액>0인 날 f_eok) ÷ Σ(그 금액 / adj_close). 단위 정합은 비율이라 상쇄.
    """
    if not rows:
        return None
    min_idx = 0
    for i in range(1, len(rows)):
        if rows[i]["cum_f_eok"] < rows[min_idx]["cum_f_eok"]:
            min_idx = i
    amount = 0.0
    shares = 0.0
    for r in rows[min_idx:]:
        adj = r.get("adj_close")
        if r["f_eok"] > 0 and adj and adj > 0:
            amount += r["f_eok"]
            shares += r["f_eok"] / adj
    return round(amount / shares, 0) if shares > 0 else None


def _sma(vals: list[float], n: int) -> list[float | None]:
    out: list[float | None] = []
    s = 0.0
    for i, v in enumerate(vals):
        s += v
        if i >= n:
            s -= vals[i - n]
        out.append(s / n if i >= n - 1 else None)
    return out


def _last_cross(rows: list[dict]) -> dict | None:
    """누적 외인 순매수의 MA20×MA100 골든/데드크로스 — 마지막 발생만 반환."""
    cum = [r["cum_f_eok"] for r in rows]
    if len(cum) < 100:
        return None
    ma20 = _sma(cum, 20)
    ma100 = _sma(cum, 100)
    last: dict | None = None
    for i in range(1, len(rows)):
        a0, a1, b0, b1 = ma20[i - 1], ma20[i], ma100[i - 1], ma100[i]
        if a0 is None or a1 is None or b0 is None or b1 is None:
            continue
        prev, cur = a0 - b0, a1 - b1
        if prev <= 0 < cur:
            last = {"kind": "골든크로스", "date": rows[i]["d"]}
        elif prev >= 0 > cur:
            last = {"kind": "데드크로스", "date": rows[i]["d"]}
    return last


async def _collect_facts(code: str, as_of: str) -> dict | None:
    """랭킹 지표 + 시계열 파생값을 structured dict로. 종목 없으면 None."""
    rows = await fm.ranking(as_of)
    row = next((r for r in rows if r["code"] == code), None)
    if row is None:
        return None

    series = await fm.series(code, as_of, 365)
    current_price = None
    for r in reversed(series):
        if r.get("adj_close"):
            current_price = round(r["adj_close"], 0)
            break
    foreign_cum_net_eok = series[-1]["cum_f_eok"] if series else None
    cross = _last_cross(series)

    return {
        "code": code,
        "name": row.get("name"),
        "sector": row.get("sector"),
        "float_mcap_eok": row.get("float_mcap_eok"),
        "current_price_won": current_price,
        "foreign_avg_price_est_won": _estimate_avg_price(series),
        "foreign_cum_net_eok": foreign_cum_net_eok,
        "foreign_streak_days": row.get("f_streak"),
        "foreign_5d_eok": row.get("f_5d_eok"),
        "foreign_20d_bp": row.get("f_20d_bp"),
        "foreign_120d_bp": row.get("f_120d_bp"),
        "institution_20d_bp": row.get("i_20d_bp"),
        "absorb_5d_pct": row.get("absorb_5d_pct"),
        "ret_20d_pct": row.get("ret_20d_pct"),
        "yesterday_foreign_eok": row.get("y_f_eok"),
        "yesterday_institution_eok": row.get("y_i_eok"),
        "both_foreign_inst_positive_20d": row.get("both_20d"),
        "entry_zone": row.get("entry_ok"),
        "exit_zone": row.get("exit_ok"),
        "is_distribution": row.get("is_distribution"),
        "short_bounce": row.get("short_bounce"),
        "long_term_up": row.get("long_up"),
        "last_cross": cross,
    }


# ── 금지어 후처리 필터 ────────────────────────────────────────────────────
def _sanitize(summary: str) -> tuple[str, bool]:
    """금지어 포함 문장을 제거. (정제된 텍스트, 필터링 발생 여부)."""
    # 문장 경계(., !, ?, 개행) 유지하며 분리
    parts = re.split(r"(?<=[.!?])\s+|\n+", summary)
    kept, flagged = [], False
    for p in parts:
        if not p.strip():
            continue
        if any(pat.search(p) for pat in _BANNED_PATTERNS):
            flagged = True
            continue
        kept.append(p.strip())
    return "\n".join(kept), flagged


# ── 메인 엔트리 ───────────────────────────────────────────────────────────
async def summarize(code: str) -> dict:
    key = _read_api_key()
    if not key:
        return {
            "available": False,
            "reason": "AI 요약은 외부망 + ANTHROPIC_API_KEY 필요",
        }

    info = await fm.resolve_as_of()
    version = await fm.data_version()  # 캐시 키 + 오래된 버전 정리 트리거
    cache_key = (version, "ai_summary", code)
    cached = fm._result_cache.get(cache_key)
    if cached is not None:
        return cached  # type: ignore[return-value]

    facts = await _collect_facts(code, info.as_of)
    if facts is None:
        return {"available": False, "reason": f"{code} 수급 데이터 없음"}

    import json

    user_msg = (
        "다음은 코드가 계산한 이 종목의 수급 사실(JSON)이다. "
        "이 종목의 수급 상황을 위 규칙대로 요약하라.\n\n"
        + json.dumps(facts, ensure_ascii=False, indent=2)
    )

    try:
        async with httpx.AsyncClient(timeout=40.0) as client:
            resp = await client.post(
                _ANTHROPIC_URL,
                headers={
                    "x-api-key": key,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                json={
                    "model": _MODEL,
                    "max_tokens": _MAX_TOKENS,
                    "system": _SYSTEM_PROMPT,
                    "messages": [{"role": "user", "content": user_msg}],
                },
            )
    except Exception as e:  # noqa: BLE001 — 네트워크 실패는 graceful degrade
        return {"available": False, "reason": f"AI 요약 호출 실패: {e}"}

    if resp.status_code != 200:
        return {
            "available": False,
            "reason": f"AI 요약 생성 실패 (HTTP {resp.status_code})",
        }

    data = resp.json()
    text = next(
        (b.get("text", "") for b in data.get("content", []) if b.get("type") == "text"),
        "",
    )
    summary, flagged = _sanitize(text)

    # facts 중 UI 표시용 핵심 숫자만 추림
    core = {
        k: facts[k]
        for k in (
            "current_price_won",
            "foreign_avg_price_est_won",
            "foreign_cum_net_eok",
            "foreign_20d_bp",
            "foreign_streak_days",
            "absorb_5d_pct",
            "ret_20d_pct",
        )
    }
    result = {
        "available": True,
        "code": code,
        "as_of": info.as_of,
        "summary": summary,
        "facts": core,
        "filtered": flagged,
    }
    fm._result_cache[cache_key] = result
    return result
