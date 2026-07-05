"""수급 태그 판정 정본 — 행(row) → 적용 패턴 선택 로직의 단일 진입점.

`flow_ai._assess`가 쓰던 "행 → 적용 패턴 목록" 선택 규칙을 여기로 추출했다.
공식 2벌 방지: _assess도, /ranking API도 모두 이 함수를 호출해 판정을 만든다.

- `applicable_patterns(row)` — 순수 멤버십 판정. 행의 기존 계산 필드만 읽어
  canonical 패턴명 목록을 반환한다 (edge/유의성 필터 없음).
- `verdict(row, edges)` — 멤버십 중 |t|≥2 통과분에 edge를 붙여 대표 패턴을 고른다.

새 파라미터·가중치 없음: 판정 = 백테스트가 측정한 값의 조회.
"""
from __future__ import annotations

# canonical 패턴명 — flow_backtest.json 키 / _load_edges 키와 정확히 일치해야 함.
# (정렬·표시용이 아니라 조회 키라 문자열 하나라도 어긋나면 edge가 안 붙는다.)


def applicable_patterns(row: dict) -> list[str]:
    """행의 기존 계산 필드로 적용 가능한 canonical 패턴명 목록을 반환.

    `_assess`의 조건·배타 규칙과 **정확히 동일**하다. 매수 아키타입은 배타적으로
    1개만(정석 > 진입권 > 추세순항 > 동시), 그 뒤 경고/맥락 패턴은 중복 가능.
    edge·유의성(|t|) 필터는 여기서 하지 않는다 — 순수 멤버십만.
    """
    both = bool(row.get("both_20d"))
    entry = bool(row.get("entry_ok"))
    f20 = row.get("f_20d_bp") or 0
    f120 = row.get("f_120d_bp") or 0
    i20 = row.get("i_20d_bp") or 0
    ret20 = row.get("ret_20d_pct")

    names: list[str] = []

    # 매수 아키타입 — 가장 잘 맞는 것 하나 (중복 표시 방지)
    if entry and both:
        names.append("정석(동시+진입권)")
    elif entry:
        names.append("진입권")
    elif both and ret20 is not None and ret20 > 0:
        names.append("추세순항")
    elif both:
        names.append("동시")

    # 장기매집 후 최근 외인 이탈 — 검증상 강세(눌림). f20<0라 위 매수 아키타입과 배타적.
    if f120 > 0 and f20 < 0:
        names.append("매집주 눌림")

    # 경고 신호 — 여러 개 동시 가능 (매수 아키타입과 상충 가능)
    if f20 > 0 and f120 > 0 and ret20 is not None and ret20 < 0:
        names.append("하락추세 매집")  # 런타임 조건상 대개 유의성 미달 → verdict가 걸러냄
    if f20 < 0 and i20 < 0 and f120 <= 0:  # 장기매집 없는 순수 동반 이탈
        names.append("동반순매도")
    if row.get("is_distribution"):
        names.append("분배")
    if row.get("short_bounce"):
        names.append("단기반등")

    return names


def verdict(row: dict, edges: dict) -> dict | None:
    """적용 패턴 중 |t|≥2 통과분에 edge를 붙여 대표 판정을 반환.

    대표(pattern/edge)는 |edge| 최대 패턴. 없으면 None.
    반환: {"pattern", "edge", "t", "direction", "others": [{동일 키}...]}.
    """
    applied: list[dict] = []
    for name in applicable_patterns(row):
        e = edges.get(name)
        if not e or abs(e["t"]) < 2.0:  # 미검증·유의성 미달 패턴은 판정에서 제외(노이즈 방지)
            continue
        applied.append(
            {"pattern": name, "edge": e["edge"], "t": e["t"], "direction": e["direction"]}
        )
    if not applied:
        return None
    applied.sort(key=lambda x: abs(x["edge"]), reverse=True)
    rep = applied[0]
    return {
        "pattern": rep["pattern"],
        "edge": rep["edge"],
        "t": rep["t"],
        "direction": rep["direction"],
        "others": applied[1:],
    }
