"""The step catalogue and the request parser (ADR-0012 §3, spec "Request format").

A request names backlog items by id. Each id is resolved against `catalog.md`, the copy of
`docs/runbooks/physical-test-backlog.md` that was bundled when this build was made, so what runs is
decided by the release under test and not by the issue text. The issue can only pick items (and,
from an allowlisted login, add inline operator steps). Nothing in a request is ever executed,
opened or fetched: text goes to the operator's screen and into the report, nowhere else.

Phase 1 knows two step kinds, `ask` and `note`. Any `do:` action is refused until phase 2.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Any, Literal

import yaml
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    ValidationError,
    field_validator,
)

ASK_EST_S = 120
NOTE_EST_S = 30
MAX_TEXT = 1000
MAX_OPTIONS = 6
MAX_STEPS_PER_BLOCK = 50
MAX_STEPS_PER_REQUEST = 200
MAX_ITEMS = 20
MAX_BLOCK_CHARS = 16_000
DEFAULT_OPTIONS = ["Pass", "Fail", "Skip"]
DEFAULT_PASS = ["Pass"]
NOTE_OPTIONS = ["Continue"]
INLINE_ITEM_ID = "inline"

# The backlog is read from here when the bundled copy is missing (a dev checkout, the tests).
BUNDLED_CATALOG = Path(__file__).with_name("catalog.md")
REPO_BACKLOG = (
    Path(__file__).resolve().parents[5] / "docs" / "runbooks" / "physical-test-backlog.md"
)


class RigRequestError(ValueError):
    """The request (or a catalogue block it points at) cannot be run. The message is safe to post."""


# ---- YAML ------------------------------------------------------------------------------------


class _Loader(yaml.SafeLoader):
    """SafeLoader without aliases (a few lines of anchors can expand to gigabytes) and with
    YAML 1.2 booleans: an unquoted `Yes` / `No` option stays text instead of becoming True/False."""

    def compose_node(self, parent, index):
        if self.check_event(yaml.events.AliasEvent):
            raise yaml.YAMLError("aliases are not allowed")
        return super().compose_node(parent, index)


_BOOL_TAG = "tag:yaml.org,2002:bool"
_Loader.yaml_implicit_resolvers = {
    ch: [(tag, rx) for tag, rx in resolvers if tag != _BOOL_TAG]
    for ch, resolvers in yaml.SafeLoader.yaml_implicit_resolvers.items()
}
_Loader.add_implicit_resolver(
    _BOOL_TAG, re.compile(r"^(?:true|True|TRUE|false|False|FALSE)$"), list("tTfF")
)


def _load_yaml(text: str, what: str) -> Any:
    if len(text) > MAX_BLOCK_CHARS:
        raise RigRequestError(f"{what} is longer than {MAX_BLOCK_CHARS} characters")
    try:
        return yaml.load(text, Loader=_Loader)  # noqa: S506 - restricted SafeLoader subclass
    except yaml.YAMLError as e:
        mark = getattr(e, "problem_mark", None)
        where = f" (line {mark.line + 1})" if mark else ""
        raise RigRequestError(f"{what} is not valid YAML{where}") from None


# ---- models ----------------------------------------------------------------------------------

_Text = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_TEXT)]
_Option = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]


def _stringify(v: Any) -> Any:
    if isinstance(v, list):
        return [str(x) if isinstance(x, int | float) and not isinstance(x, bool) else x for x in v]
    return v


class StepSpec(BaseModel):
    """One step as written in a block."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    ask: _Text | None = None
    note: _Text | None = None
    options: list[_Option] | None = Field(None, min_length=1, max_length=MAX_OPTIONS)
    pass_: list[_Option] | None = Field(None, alias="pass", min_length=1, max_length=MAX_OPTIONS)
    est: int | str | None = None
    after: int | None = Field(None, ge=1)

    _strs = field_validator("options", "pass_", mode="before")(_stringify)

    @field_validator("est")
    @classmethod
    def _est(cls, v: int | str | None) -> int | None:
        if v is None:
            return None
        if isinstance(v, str):
            m = re.fullmatch(r"\s*(\d+)\s*([sm])\s*", v)
            if not m:
                raise ValueError("est must look like 90s or 2m")
            v = int(m.group(1)) * (60 if m.group(2) == "m" else 1)
        if not 1 <= v <= 1800:
            raise ValueError("est must be between 1 s and 30 min")
        return v


class Step(BaseModel):
    """A resolved step. `index` is the 0-based position in the whole request, and `after` is the
    `index` of the step this one depends on."""

    model_config = ConfigDict(populate_by_name=True)

    index: int
    item_id: str
    kind: Literal["ask", "note"]
    text: str
    options: list[str] | None = None
    pass_: list[str] | None = Field(None, alias="pass")
    est_s: int
    after: int | None = None


class Item(BaseModel):
    id: str
    title: str
    steps: list[Step]


class ResolvedRequest(BaseModel):
    rig: str | None = None
    items: list[Item]

    @property
    def steps(self) -> list[Step]:
        return [s for item in self.items for s in item.steps]

    @property
    def estimate_s(self) -> dict[str, int]:
        # Phase 1 has no automated steps: everything needs the operator.
        return {"full": sum(s.est_s for s in self.steps), "automated": 0}

    @property
    def needs_operator_steps(self) -> int:
        return len(self.steps)

    def as_request(self, number: int, issue: dict) -> dict:
        """The REST contract's `Request` for issue `number`, with the issue's own fields bounded."""
        return {
            "number": number,
            "title": str(issue.get("title") or "")[:200],
            "url": str(issue.get("url") or ""),
            "requested_by": str(issue.get("requested_by") or "")[:80],
            "created_at": str(issue.get("created_at") or ""),
            "items": [i.model_dump(by_alias=True, exclude_none=True) for i in self.items],
            "estimate_s": self.estimate_s,
            "needs_operator_steps": self.needs_operator_steps,
        }


class RequestBlock(BaseModel):
    """The issue body's ```rig-test block."""

    model_config = ConfigDict(extra="forbid")

    rig: str | None = Field(None, max_length=64)
    budget: int | str | None = None  # live runs (phase 3); accepted, unused
    items: list[
        Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=40)]
    ] = Field(default_factory=list, max_length=MAX_ITEMS)
    steps: list[dict] = Field(default_factory=list, max_length=MAX_STEPS_PER_BLOCK)


def _first_error(e: ValidationError) -> str:
    err = e.errors()[0]
    loc = ".".join(str(p) for p in err["loc"] if p != "pass_")
    return f"{loc}: {err['msg']}" if loc else str(err["msg"])


# ---- steps -----------------------------------------------------------------------------------


def _build_steps(raw_steps: list, item_id: str, base: int) -> list[Step]:
    """Validate a block's steps and number them from `base`."""
    if not isinstance(raw_steps, list) or not raw_steps:
        raise RigRequestError(f"{item_id}: steps must be a non-empty list")
    if len(raw_steps) > MAX_STEPS_PER_BLOCK:
        raise RigRequestError(f"{item_id}: more than {MAX_STEPS_PER_BLOCK} steps")
    steps: list[Step] = []
    for n, raw in enumerate(raw_steps, start=1):
        where = f"{item_id} step {n}"
        if not isinstance(raw, dict):
            raise RigRequestError(f"{where}: a step must be a mapping")
        if "do" in raw:
            action = re.sub(r"[^A-Za-z0-9_.-]", "", str(raw["do"]))[:40]
            raise RigRequestError(f"{where}: action {action or '?'} arrives in phase 2")
        try:
            spec = StepSpec.model_validate(raw)
        except ValidationError as e:
            raise RigRequestError(f"{where}: {_first_error(e)}") from None
        if (spec.ask is None) == (spec.note is None):
            raise RigRequestError(f"{where}: needs exactly one of ask, note")
        after = None
        if spec.after is not None:
            if spec.after >= n:
                raise RigRequestError(f"{where}: after must name an earlier step")
            after = base + spec.after - 1
        if spec.note is not None:
            if spec.options or spec.pass_:
                raise RigRequestError(f"{where}: a note takes no options")
            kind, text, options, passing = "note", spec.note, None, None
        else:
            kind, text = "ask", spec.ask
            options = spec.options or list(DEFAULT_OPTIONS)
            passing = spec.pass_
            if passing is None:
                if spec.options is None:
                    passing = list(DEFAULT_PASS)
                elif len(options) == 1:
                    passing = list(options)
                else:
                    raise RigRequestError(
                        f"{where}: pass is required when there are several options"
                    )
            if not set(passing) <= set(options):
                raise RigRequestError(f"{where}: pass must be among the options")
        est = spec.est or (NOTE_EST_S if kind == "note" else ASK_EST_S)
        steps.append(
            Step(
                index=base + n - 1,
                item_id=item_id,
                kind=kind,
                text=text,
                options=options,
                pass_=passing,
                est_s=est,
                after=after,
            )
        )
    return steps


def _prose_step(item: CatalogItem, index: int) -> Step:
    text = item.prose if len(item.prose) <= MAX_TEXT else item.prose[: MAX_TEXT - 1].rstrip() + "…"
    return Step(
        index=index,
        item_id=item.id or "",
        kind="ask",
        text=text or item.title,
        options=list(DEFAULT_OPTIONS),
        pass_=list(DEFAULT_PASS),
        est_s=ASK_EST_S,
    )


# ---- the catalogue ---------------------------------------------------------------------------


@dataclass
class CatalogItem:
    id: str | None
    title: str
    prose: str
    block: dict | None = None
    block_error: str | None = None


_ITEM_RE = re.compile(r"^(\s*)- \[[ xX]\] (.*)$")
_LEAD_RE = re.compile(r"^\*\*(.+?)\*\*")
_ID_RE = re.compile(r"(#\d+|[A-Z]{1,2}\d+)(?![A-Za-z0-9])")
_FENCE_RE = re.compile(r"^[ \t]*```rig-test[ \t]*\n(.*?)^[ \t]*```[ \t]*$", re.M | re.S)


def _item_from_lines(lines: list[str]) -> CatalogItem:
    first = _ITEM_RE.match(lines[0]).group(2)  # type: ignore[union-attr]
    text = "\n".join([first, *lines[1:]])
    blocks = _FENCE_RE.findall(text + "\n")
    text = _FENCE_RE.sub("", text + "\n")
    block, block_error = None, None
    if len(blocks) > 1:
        block_error = "more than one rig-test block"
    elif blocks:
        try:
            data = _load_yaml(blocks[0], "item block")
            if not isinstance(data, dict):
                raise RigRequestError("item block must be a mapping")
            block = data
        except RigRequestError as e:
            block_error = str(e)
    lead = _LEAD_RE.match(first)
    title = (lead.group(1) if lead else "").strip().rstrip(".:")
    m = _ID_RE.match(title)
    item_id = m.group(1) if m else None
    if isinstance(block, dict) and block.get("id") is not None:
        item_id = str(block["id"]).strip() or item_id
    prose = re.sub(r"\s+", " ", text.replace("**", "")).strip()
    return CatalogItem(item_id, title, prose, block, block_error)


def parse_items(markdown: str) -> list[CatalogItem]:
    """Every `- [ ] **<id> …**` item in the backlog, in file order. An item runs to the next
    checkbox, heading, or unindented line. Items with no recognisable id come back with `id=None`
    (they cannot be requested)."""
    items: list[CatalogItem] = []
    cur: list[str] = []

    def flush() -> None:
        if cur:
            items.append(_item_from_lines(cur))
            cur.clear()

    for line in markdown.splitlines():
        if _ITEM_RE.match(line):
            flush()
            cur.append(line)
        elif cur and (not line.strip() or line[:1] in " \t"):
            cur.append(line)
        else:
            flush()
    flush()
    return items


@lru_cache(maxsize=2)
def _index(markdown: str) -> dict[str, CatalogItem]:
    index: dict[str, CatalogItem] = {}
    for item in parse_items(markdown):
        if item.id and item.id not in index:  # the first occurrence wins
            index[item.id] = item
    return index


def load_catalog_text() -> str:
    for path in (BUNDLED_CATALOG, REPO_BACKLOG):
        try:
            return path.read_text(encoding="utf-8")
        except OSError:
            continue
    return ""


def catalog_index() -> dict[str, CatalogItem]:
    return _index(load_catalog_text())


# ---- requests --------------------------------------------------------------------------------


def extract_block(body: str) -> str:
    blocks = _FENCE_RE.findall(body.replace("\r\n", "\n").replace("\r", "\n") + "\n")
    if not blocks:
        raise RigRequestError("no ```rig-test block in the issue body")
    if len(blocks) > 1:
        raise RigRequestError("more than one ```rig-test block in the issue body")
    return blocks[0]


def peek_rig(body: str) -> str | None:
    """The `rig:` a request names, or None (also for a body that does not parse: the caller reports
    that separately). Lets a rig ignore requests meant for another one before judging them."""
    try:
        data = _load_yaml(extract_block(body), "rig-test block")
    except RigRequestError:
        return None
    rig = data.get("rig") if isinstance(data, dict) else None
    return str(rig).strip() or None if rig is not None else None


def _resolve_item(item: CatalogItem, base: int) -> Item:
    if item.block_error:
        raise RigRequestError(f"{item.id}: {item.block_error}")
    if item.block is None:
        return Item(id=item.id or "", title=item.title, steps=[_prose_step(item, base)])
    return Item(
        id=item.id or "",
        title=item.title,
        steps=_build_steps(item.block.get("steps"), item.id or "", base),
    )


def parse_request(body: str, catalog: dict[str, CatalogItem] | None = None) -> ResolvedRequest:
    """Resolve an issue body into runnable items, or raise RigRequestError with a postable reason."""
    catalog = catalog_index() if catalog is None else catalog
    data = _load_yaml(extract_block(body), "rig-test block")
    if not isinstance(data, dict):
        raise RigRequestError("rig-test block must be a mapping")
    try:
        block = RequestBlock.model_validate(data)
    except ValidationError as e:
        raise RigRequestError(_first_error(e)) from None
    if not block.items and not block.steps:
        raise RigRequestError("the request names no items and has no steps")
    items: list[Item] = []
    base = 0
    for item_id in dict.fromkeys(block.items):  # de-duplicated, order kept
        found = catalog.get(item_id)
        if found is None:
            raise RigRequestError(f"unknown item {item_id!r} (not in this app version)")
        resolved = _resolve_item(found, base)
        items.append(resolved)
        base += len(resolved.steps)
    if block.steps:
        items.append(
            Item(
                id=INLINE_ITEM_ID,
                title="Inline steps",
                steps=_build_steps(block.steps, INLINE_ITEM_ID, base),
            )
        )
    if sum(len(i.steps) for i in items) > MAX_STEPS_PER_REQUEST:
        raise RigRequestError(f"more than {MAX_STEPS_PER_REQUEST} steps in total")
    return ResolvedRequest(rig=block.rig, items=items)
