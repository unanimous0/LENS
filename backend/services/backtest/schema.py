"""전략 JSON 스키마 (pydantic v2) + 검증 — backtest.md §4.

C1 범위:
  - entry: 조건 트리 (all/any, 1-depth 중첩까지). 리프 = Condition.
  - 연산자: > >= < <= == is_true is_false. 값 비교 + 지표 간 비교(ref + mult).
  - execution: entry_fill/exit_fill (next_open|next_close|same_close), cost_bps(기본 25).
  - exit: rules (fixed_holding / condition / stop_loss_pct / take_profit_pct) — whichever-first.
  - universe: markets / min_adv_eok / min_mcap_eok.
  - portfolio.mode: "event_study"만 허용 (그 외 값은 pydantic이 422).
  - benchmark: universe_avg | none (kospi/kosdaq은 C2 — 여기선 거부).
  - period: start/end (null = 최대 가용).

검증 실패는 pydantic ValidationError → 라우터가 422 + 필드 단위 메시지로 변환.
지표 존재 여부(카탈로그 대조)는 어댑터가 필요해 engine/router 레벨에서 별도 검사.
"""
from __future__ import annotations

from datetime import date
from typing import Annotated, Literal, Union

from pydantic import BaseModel, Field, model_validator

# 비교 연산자 (값·지표 비교) + 불리언 태그 연산자
CompareOp = Literal[">", ">=", "<", "<=", "=="]
BoolOp = Literal["is_true", "is_false"]
Op = Literal[">", ">=", "<", "<=", "==", "is_true", "is_false"]


class Condition(BaseModel):
    """리프 조건. `field OP value` 또는 `field OP (ref × mult)` 또는 `field is_true/is_false`."""

    model_config = {"extra": "forbid"}

    field: str
    op: Op
    value: float | None = None
    ref: str | None = None
    mult: float = 1.0

    @model_validator(mode="after")
    def _check(self) -> "Condition":
        if self.op in ("is_true", "is_false"):
            if self.value is not None or self.ref is not None:
                raise ValueError(f"'{self.op}'는 value/ref를 받지 않는다")
        else:
            if (self.value is None) == (self.ref is None):
                raise ValueError(f"'{self.op}'는 value 또는 ref 중 정확히 하나가 필요하다")
        return self


class Group(BaseModel):
    """조건 그룹 — all(AND) 또는 any(OR) 중 정확히 하나. 원소는 Condition 또는 (1-depth) 하위 그룹."""

    model_config = {"extra": "forbid"}

    all: list[Union["Group", Condition]] | None = None
    any: list[Union["Group", Condition]] | None = None

    @model_validator(mode="after")
    def _check(self) -> "Group":
        has_all = self.all is not None
        has_any = self.any is not None
        if has_all == has_any:
            raise ValueError("그룹은 'all' 또는 'any' 중 정확히 하나여야 한다")
        items = self.all if has_all else self.any
        if not items:
            raise ValueError("그룹은 최소 1개 조건이 필요하다")
        # 1-depth 제한: 하위 그룹은 리프(Condition)만 가질 수 있다 (그룹 안의 그룹의 그룹 금지)
        for it in items:
            if isinstance(it, Group):
                sub = it.all if it.all is not None else it.any
                if any(isinstance(s, Group) for s in (sub or [])):
                    raise ValueError("조건 중첩은 1-depth까지만 허용된다")
        return self


class Execution(BaseModel):
    model_config = {"extra": "forbid"}

    entry_fill: Literal["next_open", "next_close", "same_close"] = "next_open"
    exit_fill: Literal["next_open", "next_close", "same_close"] = "next_open"
    cost_bps: float = Field(default=25, ge=0)


class ExitRule(BaseModel):
    """청산 규칙. type별 필요한 필드가 다르다 (whichever-first로 결합)."""

    model_config = {"extra": "forbid"}

    type: Literal["fixed_holding", "condition", "stop_loss_pct", "take_profit_pct"]
    days: int | None = None            # fixed_holding
    value: float | None = None         # stop_loss_pct(음수) / take_profit_pct(양수)
    all: list[Condition] | None = None  # condition
    any: list[Condition] | None = None  # condition

    @model_validator(mode="after")
    def _check(self) -> "ExitRule":
        if self.type == "fixed_holding":
            if self.days is None or self.days < 1:
                raise ValueError("fixed_holding은 days>=1 이 필요하다")
        elif self.type == "condition":
            has_all = self.all is not None
            has_any = self.any is not None
            if has_all == has_any:
                raise ValueError("condition 규칙은 'all' 또는 'any' 중 하나여야 한다")
            if not (self.all or self.any):
                raise ValueError("condition 규칙은 최소 1개 조건이 필요하다")
        elif self.type == "stop_loss_pct":
            if self.value is None or self.value >= 0:
                raise ValueError("stop_loss_pct는 음수 value(%)가 필요하다 (예: -15)")
        elif self.type == "take_profit_pct":
            if self.value is None or self.value <= 0:
                raise ValueError("take_profit_pct는 양수 value(%)가 필요하다 (예: 50)")
        return self


class Exit(BaseModel):
    model_config = {"extra": "forbid"}

    rules: list[ExitRule] = Field(min_length=1)


class Universe(BaseModel):
    model_config = {"extra": "forbid"}

    markets: list[Literal["KOSPI", "KOSDAQ"]] = ["KOSPI", "KOSDAQ"]
    min_adv_eok: float = Field(default=10, ge=0)     # 일평균 거래대금 하한 (억)
    min_mcap_eok: float = Field(default=500, ge=0)   # 시가총액 하한 (억)

    @model_validator(mode="after")
    def _check(self) -> "Universe":
        if not self.markets:
            raise ValueError("markets는 최소 1개가 필요하다")
        return self


class Portfolio(BaseModel):
    model_config = {"extra": "forbid"}

    # C1은 event_study만. 다른 값은 pydantic이 422 (portfolio는 C2).
    mode: Literal["event_study"] = "event_study"
    max_positions: int | None = None
    weighting: str | None = None


class Period(BaseModel):
    model_config = {"extra": "forbid"}

    start: date | None = None
    end: date | None = None


class Strategy(BaseModel):
    model_config = {"extra": "forbid"}

    name: str = "untitled"
    universe: Universe = Field(default_factory=Universe)
    entry: Group
    execution: Execution = Field(default_factory=Execution)
    exit: Exit
    portfolio: Portfolio = Field(default_factory=Portfolio)
    # C1: universe_avg(기본) | none. kospi/kosdaq은 C2 → 여기선 값 거부(422).
    benchmark: Literal["universe_avg", "none"] = "universe_avg"
    period: Period = Field(default_factory=Period)


# ── 필드 수집 (카탈로그 대조용) ────────────────────────────────────────────
def iter_condition_fields(strategy: Strategy):
    """전략이 참조하는 (경로, field_key) 목록 — entry 트리 + condition 청산 규칙 전체."""
    def walk_group(g: Group, path: str):
        items = g.all if g.all is not None else g.any
        kind = "all" if g.all is not None else "any"
        for idx, it in enumerate(items or []):
            p = f"{path}.{kind}[{idx}]"
            if isinstance(it, Group):
                yield from walk_group(it, p)
            else:
                yield p, it.field
                if it.ref is not None:
                    yield f"{p}.ref", it.ref

    yield from walk_group(strategy.entry, "entry")
    for ri, rule in enumerate(strategy.exit.rules):
        if rule.type == "condition":
            conds = rule.all if rule.all is not None else rule.any
            kind = "all" if rule.all is not None else "any"
            for ci, c in enumerate(conds or []):
                p = f"exit.rules[{ri}].{kind}[{ci}]"
                yield p, c.field
                if c.ref is not None:
                    yield f"{p}.ref", c.ref


Group.model_rebuild()
