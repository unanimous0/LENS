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

import json
import os
import re
from pathlib import Path

import httpx

from services import flow_metrics as fm

_ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
_MODEL = "claude-sonnet-5"
_MAX_TOKENS = 3500  # 6섹션 깊은 분석(핵심판단·강세·약세·종합·실전·쉬운정리) — 한국어 토큰 밀도

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
    "너는 한국 주식 수급(투자자별 순매수)을 트레이더에게 해석해주는 애널리스트다. "
    "아래 제공된 사실만으로 '사람 애널리스트 수준의 깊이 있는 종합 분석'을 작성한다. "
    "단순 나열은 금물 — 지표를 엮어 '그래서 무슨 의미인지'까지 풀어야 한다.\n"
    "\n"
    "[숫자·표기 규칙]\n"
    "- 제공된 숫자만 사용. 새 숫자 계산·추정·창작 금지. 영문 필드명/JSON 키 금지(값만 한국어).\n"
    "- 수급강도는 bp가 아니라 %로. **모든 %는 무엇 대비인지 기준점을 반드시 병기**: "
    "매집률=유통시총 대비, 흡수율=거래대금 대비, 주가수익률=20일 전 대비, 검증 초과수익=유니버스 평균 대비.\n"
    "\n"
    "[해석 원칙 — 해당되면 반드시 녹여라]\n"
    "- 외국인 평단 대비 현재가(이익/손실 구간)와 함의: 이익 구간이면 손절 압력이 낮아 하방이 견고, "
    "손실 구간이면 물려 있어 추가 매집이 방어적일 수 있음.\n"
    "- 외국인 vs 기관 중 누가 매집을 더 주도하는지 (매집률 수치로 비교).\n"
    "- backtest_assessment(검증된 패턴별 초과수익)를 판단의 핵심 근거로 인용.\n"
    "- 진입권 미충족이면: '동반 매수하나 지속성 임계엔 못 미쳐 강하게 밀어붙이는 매수는 아님'.\n"
    "- 골든/데드크로스 = 누적 순매수(매집) 모멘텀의 전환 (데드크로스=매집 모멘텀 둔화).\n"
    "- 반드시 강세·약세 양면 제시, 상충 신호는 명시. 검증 초과수익은 독립 측정치라 합산 금지.\n"
    "\n"
    "[금지]\n"
    "- '매수'·'매도'·'매수세'·'매도세'·'목표가'·'추천'·'사라'·'팔라' 등 직접적 매매 지시/권유 금지 (관찰·해석 어조만).\n"
    "- 제공되지 않은 뉴스·전망·인과 창작 금지.\n"
    "\n"
    "[출력 형식 — 아래 구조를 반드시 지켜라. 섹션 헤더는 대괄호로 한 줄, 섹션 사이 빈 줄 1개. "
    "마크다운 별표(**)나 번호(①) 쓰지 말 것.]\n"
    "[핵심 판단]\n"
    "이 종목이 지금 어떤 자리인지 한두 문장으로 규정 (예: 강한 매수신호 / 약한 우호 / 관찰 / 경계 등 성격 규정).\n"
    "\n"
    "[강세 요인]\n"
    "- 각 요인마다 '숫자 → 그래서 무슨 의미' 형태로 한두 문장 해석. (2~4개)\n"
    "\n"
    "[약세 요인]\n"
    "- 위와 동일하게 해석 포함. (2~4개)\n"
    "\n"
    "[종합]\n"
    "강세와 약세를 저울질해 어느 쪽이 우세한지, 어떤 성격의 자리인지 한 단락으로 판정.\n"
    "\n"
    "[실전 관점]\n"
    "무엇을 지켜봐야 하는지 — 무엇이 확인되면 강세가 굳어지고 무엇이 나오면 약세로 기우는지.\n"
    "\n"
    "[쉽게 정리]\n"
    "- 전문용어 최소화한 plain-language 핵심 2~3개. 초보도 바로 이해되게.\n"
    "\n"
    "[주의]\n"
    "맥락 한계 한 줄 (검증치는 패턴 평균이라 개별 종목 보장 아님 등)."
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


# 백테스트 검증 결과 — 패턴별 보유 60일 평균 초과수익. LLM 판단 근거로 주입(측정된 결정론적 값).
# 주기 갱신: scripts/flow_tag_backtest.py --save가 data/flow_backtest.json 생성 → 아래 기본값 대체.
# 기본값은 JSON 없을 때(첫 배포)의 폴백. 유의성(|t|≥2)인 패턴만 (하락추세 매집은 런타임 조건상 미달로 제외).
_BACKTEST_PATH = _ROOT_ENV.parent / "data" / "flow_backtest.json"
_BACKTEST_DEFAULT = {  # 룩백 2년 canonical 기준(2026-07-04). JSON 없을 때만 쓰는 폴백.
    "정석(동시+진입권)": {"edge": 3.53, "t": 5.07, "direction": "강세"},
    "진입권": {"edge": 2.95, "t": 6.11, "direction": "강세"},
    "매집주 눌림": {"edge": 2.32, "t": 3.91, "direction": "강세"},
    "추세순항": {"edge": 2.09, "t": 4.59, "direction": "강세"},
    "동시": {"edge": 1.20, "t": 3.22, "direction": "강세"},
    "동반순매도": {"edge": -3.28, "t": -8.32, "direction": "약세"},
    "분배": {"edge": -2.25, "t": -3.72, "direction": "약세"},
    # 단기반등: 2년 기준 -0.87%(t-1.69) 유의성 미달 → 폴백에서도 제외.
}
_edges_cache: dict = {"mtime": None, "edges": None, "as_of": None}


def _load_edges() -> tuple[dict, str | None]:
    """data/flow_backtest.json(주기 갱신본)을 읽어 패턴 edge 반환. 없으면 하드코딩 기본값.
    반환: ({name: {edge, t, direction}}, 검증기준일 or None). mtime 캐시."""
    try:
        if _BACKTEST_PATH.exists():
            mt = _BACKTEST_PATH.stat().st_mtime
            if _edges_cache["mtime"] != mt:
                data = json.loads(_BACKTEST_PATH.read_text(encoding="utf-8"))
                edges = {
                    name: {"edge": v["h60_excess_pct"], "t": v["t"], "direction": v["direction"]}
                    for name, v in (data.get("patterns") or {}).items()
                }
                _edges_cache.update(mtime=mt, edges=edges, as_of=data.get("generated_at"))
            return _edges_cache["edges"], _edges_cache["as_of"]
    except Exception:  # noqa: BLE001 — 손상/부재 시 기본값으로 degrade
        pass
    return _BACKTEST_DEFAULT, None


def _assess(row: dict) -> dict:
    """랭킹 지표 → 백테스트 검증된 패턴 판정. 매수 아키타입 1개 + 경고 신호(중복 가능)."""
    both = bool(row.get("both_20d"))
    entry = bool(row.get("entry_ok"))
    f20 = row.get("f_20d_bp") or 0
    f120 = row.get("f_120d_bp") or 0
    i20 = row.get("i_20d_bp") or 0
    ret20 = row.get("ret_20d_pct")
    edges, as_of = _load_edges()
    sig: list[dict] = []

    def add(name: str) -> None:
        e = edges.get(name)
        if not e or abs(e["t"]) < 2.0:  # 미검증·유의성 미달 패턴은 주입 안 함(노이즈 방지)
            return
        sig.append({"패턴": name, "검증_60일_평균초과수익_pct": e["edge"], "방향": e["direction"]})

    # 매수 아키타입 — 가장 잘 맞는 것 하나 (중복 표시 방지)
    if entry and both:
        add("정석(동시+진입권)")
    elif entry:
        add("진입권")
    elif both and ret20 is not None and ret20 > 0:
        add("추세순항")
    elif both:
        add("동시")
    # 장기매집 후 최근 외인 이탈 — 검증상 강세(눌림). f20<0라 위 매수 아키타입과 배타적.
    if f120 > 0 and f20 < 0:
        add("매집주 눌림")
    # 경고 신호 — 여러 개 동시 가능 (매수 아키타입과 상충 가능)
    if f20 > 0 and f120 > 0 and ret20 is not None and ret20 < 0:
        add("하락추세 매집")  # 런타임 조건상 대개 유의성 미달 → add()가 걸러냄
    if f20 < 0 and i20 < 0 and f120 <= 0:  # 장기매집 없는 순수 동반 이탈
        add("동반순매도")
    if row.get("is_distribution"):
        add("분배")
    if row.get("short_bounce"):
        add("단기반등")
    note = (
        "각 패턴의 검증 초과수익은 독립 측정치(보유 60일, 유니버스 평균 대비, look-ahead 차단)이며 "
        "합산 불가·상충 가능. 정렬축(외인 20D 매집)은 Rank IC 유의(+). 개별 종목이 아닌 패턴 평균."
    )
    if as_of:
        note += f" 검증 기준일 {as_of}."
    return {"applicable_signals": sig, "note": note}


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
        # 백테스트 검증 판정 — 판단의 핵심 근거 (검증된 패턴별 평균 초과수익)
        "backtest_assessment": _assess(row),
    }


# ── 금지어 후처리 필터 ────────────────────────────────────────────────────
def _sanitize(summary: str) -> tuple[str, bool]:
    """금지어 포함 줄을 제거. 줄 단위라 [섹션]·불릿 구조 보존. (정제 텍스트, 필터 발생 여부)."""
    kept, flagged = [], False
    for ln in summary.split("\n"):
        if ln.strip() and any(pat.search(ln) for pat in _BANNED_PATTERNS):
            flagged = True
            continue
        kept.append(ln)
    return "\n".join(kept), flagged


def _render_facts_korean(f: dict) -> str:
    """LLM 입력을 한국어 라벨 텍스트로 렌더 — 영문 필드명이 아예 없어 모델이 못 베낌."""
    def won(v):
        return f"{int(v):,}원" if v is not None else "-"

    def eok(v):
        return f"{v:+,.1f}억" if v is not None else "-"

    def mcpct(v):  # 매집률 = 순매수 ÷ 유통시총. bp→% (÷100). 화면 "매집%"와 동일.
        return f"{v / 100:+.2f}%" if v is not None else "-"

    def pct(v):
        return f"{v:+.1f}%" if v is not None else "-"

    def yn(v):
        return "예" if v else "아니오"

    fm_eok = f.get("float_mcap_eok")
    absorb = f.get("absorb_5d_pct")
    # 외국인 평단 대비 현재가 (이익/손실 구간) — 손절 압력 판단의 핵심. 코드가 계산해 사실로 제공.
    avg, cur = f.get("foreign_avg_price_est_won"), f.get("current_price_won")
    zone = None
    if avg and cur and avg > 0:
        gap = (cur / avg - 1) * 100
        zone = (
            f"외국인 평단 대비 현재가: {gap:+.0f}% "
            + ("(외국인 누적 이익 구간 — 손절 압력 낮음)" if gap >= 0 else "(외국인 누적 손실 구간 — 물린 상태)")
        )
    lines = [
        f"종목: {f.get('name')} ({f.get('code')}, {f.get('sector') or '-'})",
        f"유통시총: {fm_eok:,}억" if fm_eok is not None else "유통시총: -",
        f"현재가: {won(f.get('current_price_won'))} / 외국인 추정 평단: {won(f.get('foreign_avg_price_est_won'))}",
        f"외국인 매집률(20일·120일 누적순매수 ÷ 유통시총): 20일 {mcpct(f.get('foreign_20d_bp'))}, 120일 {mcpct(f.get('foreign_120d_bp'))}",
        f"기관 매집률(20일 순매수 ÷ 유통시총): 20일 {mcpct(f.get('institution_20d_bp'))}",
        f"외국인 누적순매수: {eok(f.get('foreign_cum_net_eok'))} · 5일 순매수 {eok(f.get('foreign_5d_eok'))} · 연속 순매수 {f.get('foreign_streak_days')}일",
        f"전일 순매수: 외국인 {eok(f.get('yesterday_foreign_eok'))}, 기관 {eok(f.get('yesterday_institution_eok'))}",
        f"20일 주가수익률(20일 전 대비): {pct(f.get('ret_20d_pct'))} · 5일 흡수율(외+기 순매수 ÷ 거래대금): {absorb if absorb is not None else '-'}%",
        f"신호: 진입권 {yn(f.get('entry_zone'))}, 이탈권 {yn(f.get('exit_zone'))}, "
        f"분배의심 {yn(f.get('is_distribution'))}, 단기반등 {yn(f.get('short_bounce'))}, "
        f"장기추세상승 {yn(f.get('long_term_up'))}",
    ]
    if zone:
        lines.insert(3, zone)  # 현재가 줄 바로 뒤
    cross = f.get("last_cross")
    if cross:
        lines.append(f"최근 크로스: {cross.get('kind')} {cross.get('date')}")
    ba = f.get("backtest_assessment") or {}
    sigs = ba.get("applicable_signals") or []
    if sigs:
        lines.append("[검증 판정] 백테스트 보유 60일 평균 초과수익(유니버스 평균 대비):")
        for s in sigs:
            lines.append(f"  - {s['패턴']}: {s['검증_60일_평균초과수익_pct']:+.2f}% ({s['방향']})")
        if ba.get("note"):
            lines.append(f"  ※ {ba['note']}")
    return "\n".join(lines)


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

    user_msg = (
        "다음은 코드가 계산한 이 종목의 수급 사실이다. "
        "위 [출력 형식]과 규칙대로, 사람 애널리스트 수준으로 깊이 있게 분석하라.\n\n"
        + _render_facts_korean(facts)
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
